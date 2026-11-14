-- Rastreio de anúncio (click-to-WhatsApp) + eventos de conversão pra Meta (CAPI business_messaging)
-- WhatsApp Oficial (+55 11 93623-4418 · WABA 1707945417028823).
--   1) cada conversa guarda de qual anúncio veio (ad_id, ctwa_clid, título, nomes do anúncio/conjunto/campanha, 1ª msg)
--      sem referral = origem 'organico'
--   2) capi_eventos = log de cada evento mandado pra Meta (1 por conversa+evento) com a resposta dela
--        LeadSubmitted  -> a IA marca que o lead aceitou o preço
--        QualifiedLead  -> o lead reservou na Agenda Reino (trigger abaixo)
--   3) vw_whatsapp_anuncio_leads (1 linha por conversa) e vw_anuncios_whatsapp (1 linha por anúncio) pro relatório

alter table public.conversations
  add column if not exists ad_id text,
  add column if not exists ctwa_clid text,
  add column if not exists anuncio_headline text,
  add column if not exists anuncio_nome text,
  add column if not exists conjunto_nome text,
  add column if not exists campanha_nome text,
  add column if not exists primeira_msg_em timestamptz,
  add column if not exists preco_aceito_em timestamptz;

create index if not exists conversations_ad_id_idx on public.conversations (ad_id) where ad_id is not null;

-- backfill: só preenche o que está vazio (nada é sobrescrito)
update public.conversations c set
  ad_id            = coalesce(c.ad_id, case when c.anuncio->>'source_type' = 'ad' then c.anuncio->>'source_id' end),
  ctwa_clid        = coalesce(c.ctwa_clid, c.anuncio->>'ctwa_clid'),
  anuncio_headline = coalesce(c.anuncio_headline, c.anuncio->>'headline')
where c.channel = 'oficial' and c.anuncio is not null
  and (c.ad_id is null or c.ctwa_clid is null or c.anuncio_headline is null);

update public.conversations c set primeira_msg_em = m.primeira
from (select conversation_id, min(created_at) primeira from public.messages where direction = 'inbound' group by 1) m
where m.conversation_id = c.id and c.channel = 'oficial' and c.primeira_msg_em is null;

update public.conversations set origem = 'organico'
where channel = 'oficial' and origem is null and anuncio is null;

-- log dos eventos mandados pra Meta
create table if not exists public.capi_eventos (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  event_name text not null,
  ctwa_clid text,
  dataset_id text,
  status text not null default 'pendente', -- pendente | enviado | erro | sem_clid
  teste boolean not null default false,     -- true = mandado com test_event_code (não conta)
  resposta jsonb,
  enviado_em timestamptz,
  criado_em timestamptz not null default now()
);
-- 1 evento real por conversa (o de teste pode repetir)
create unique index if not exists capi_eventos_unico on public.capi_eventos (conversation_id, event_name) where not teste;
alter table public.capi_eventos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'capi_eventos' and policyname = 'capi_eventos_leitura') then
    create policy capi_eventos_leitura on public.capi_eventos for select to authenticated using (true);
  end if;
end $$;

-- reserva na Agenda Reino ligada a uma conversa do Oficial -> QualifiedLead (a edge confere ctwa_clid e não repete)
-- a edge `agenda` grava a reserva e só depois preenche conversation_id, por isso escuta o update também
create or replace function public.capi_reserva_agendada()
 returns trigger
 language plpgsql
as $function$
declare v_secret text;
begin
  if new.conversation_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.conversation_id is not distinct from new.conversation_id then return new; end if;
  if coalesce(new.status, '') = 'erro' then return new; end if;
  if not exists (select 1 from public.conversations c where c.id::text = new.conversation_id::text and c.channel = 'oficial') then return new; end if;
  select value into v_secret from public.app_secrets where key = 'wa_oficial_internal';
  perform net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial',
    headers := jsonb_build_object('Content-Type','application/json','x-reino-secret', v_secret),
    body := jsonb_build_object('acao','capi','conversation_id', new.conversation_id::text, 'event_name','QualifiedLead')
  );
  return new;
exception when others then return new;
end $function$;

drop trigger if exists trg_capi_reserva_agendada on public.agenda_reservas;
create trigger trg_capi_reserva_agendada
  after insert or update of conversation_id on public.agenda_reservas
  for each row execute function public.capi_reserva_agendada();

-- relatório: 1 linha por conversa do Oficial
create or replace view public.vw_whatsapp_anuncio_leads with (security_invoker = on) as
select
  c.id as conversation_id,
  coalesce(ct.full_name, ct.phone) as lead,
  ct.phone,
  coalesce(c.primeira_msg_em, c.created_at) as primeira_msg_em,
  case when c.ad_id is not null then 'anuncio' when c.anuncio is not null then 'anuncio_sem_id' else 'organico' end as origem,
  c.ad_id, c.anuncio_nome, c.conjunto_nome, c.campanha_nome, c.anuncio_headline,
  c.ctwa_clid is not null as tem_clid,
  c.ia_fase,
  c.preco_aceito_em,
  r.reservou_em,
  (select e.status from public.capi_eventos e where e.conversation_id = c.id and e.event_name = 'LeadSubmitted' and not e.teste) as capi_lead,
  (select e.status from public.capi_eventos e where e.conversation_id = c.id and e.event_name = 'QualifiedLead' and not e.teste) as capi_agendou
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join lateral (
  select min(ar.criado_em) as reservou_em from public.agenda_reservas ar
  where ar.conversation_id::text = c.id::text and coalesce(ar.status, '') <> 'erro'
) r on true
where c.channel = 'oficial';

-- relatório: 1 linha por anúncio (orgânico vira uma linha só)
create or replace view public.vw_anuncios_whatsapp with (security_invoker = on) as
select
  coalesce(ad_id, origem) as ad_id,
  max(anuncio_nome) as anuncio, max(conjunto_nome) as conjunto, max(campanha_nome) as campanha, max(anuncio_headline) as headline,
  count(*) as conversas,
  count(preco_aceito_em) as aceitaram_preco,
  count(reservou_em) as agendaram,
  round(100.0 * count(reservou_em) / nullif(count(*), 0), 1) as taxa_agendamento,
  count(*) filter (where capi_agendou = 'enviado') as eventos_enviados,
  min(primeira_msg_em) as primeira, max(primeira_msg_em) as ultima
from public.vw_whatsapp_anuncio_leads
group by 1;
