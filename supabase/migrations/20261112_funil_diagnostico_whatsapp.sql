-- Funil "funil-diagnostico-whatsapp" no WhatsApp Oficial (campanha → IA SPIN/BANT → agenda → follow-ups)
-- Fases no kanban (classificação automática pela edge wa-oficial):
--   Novo Lead · FUP1 nunca respondeu · FUP2 respondeu · FUP3 quase agendou · Agendado · FUP4 no show · FUP5 nutrição

-- estado da IA / follow-up por conversa
alter table public.conversations add column if not exists ia_fase text;            -- novo | respondeu | horarios | agendado | desqualificado | encerrado
alter table public.conversations add column if not exists fup_n int not null default 0;     -- quantos follow-ups já foram
alter table public.conversations add column if not exists fup_proximo_em timestamptz;       -- quando sai o próximo
alter table public.conversations add column if not exists anuncio jsonb;            -- referral do anúncio (click-to-WhatsApp)
create index if not exists idx_conv_fup_proximo on public.conversations (fup_proximo_em) where fup_proximo_em is not null;

-- config editável
insert into public.crm_config (chave, valor, atualizado_em) values
  ('oficial_funil', 'funil-diagnostico-whatsapp', now()),
  ('oficial_fup_ativo', 'true', now()),
  ('oficial_fup_minutos', '10,60,360,1380', now()),   -- 10 min, 1 h, 6 h, 23 h (o último ainda dentro da janela de 24 h)
  ('oficial_fup_janela', '09,24', now()),              -- só manda entre 09h e 00h (Brasília)
  ('oficial_corte_faturamento', '5000', now())
on conflict (chave) do nothing;

-- no-show marcado pelo closer → FUP4 (só neste funil)
create or replace function public.funil_diag_noshow()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fup4 uuid;
begin
  if new.call_status = 'no_show' and old.call_status is distinct from 'no_show'
     and new.funil = 'funil-diagnostico-whatsapp' then
    select id into v_fup4 from kanban_stages where name = 'FUP4' limit 1;
    if v_fup4 is not null then new.stage_id := v_fup4; end if;
    new.ia_fase := 'noshow';
  end if;
  return new;
end $$;

create or replace trigger trg_funil_diag_noshow before update of call_status on public.conversations
for each row execute function public.funil_diag_noshow();

-- motor de follow-up: a cada minuto, só chama a função se houver follow-up vencido
select cron.schedule('wa-oficial-fup', '* * * * *', $cron$
  select net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial',
    headers := jsonb_build_object('Content-Type','application/json','x-reino-secret',
                 (select value from public.app_secrets where key = 'wa_oficial_internal')),
    body := '{"acao":"fup"}'::jsonb)
  where exists (select 1 from public.conversations where fup_proximo_em <= now() and channel = 'oficial');
$cron$);

-- conversa antiga que entra no funil: a IA só lê o histórico a partir daqui (não herda assunto de evento antigo)
alter table public.conversations add column if not exists ia_contexto_desde timestamptz;
