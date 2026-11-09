-- ============================================================
-- Atendimento WhatsApp Oficial (Cloud API) no Reino CRM — JÁ APLICADO em 09/11/2026
-- Canal novo: conversations.channel = 'oficial' (reaproveita contacts/conversations/messages)
-- Edge Function: supabase/functions/wa-oficial
-- ============================================================

-- Segredos internos (app_secrets: só service_role)
--   wa_oficial_verify_token  -> token de verificação do webhook na Meta
--   wa_oficial_internal      -> segredo do gatilho banco -> Edge Function
insert into public.app_secrets(key, value, updated_at)
values ('wa_oficial_verify_token', encode(gen_random_bytes(18),'hex'), now()),
       ('wa_oficial_internal', encode(gen_random_bytes(24),'hex'), now())
on conflict (key) do nothing;

-- Config editável pelo time na tela "🤖 IA do Oficial"
--   oficial_ia_ativa ('true'/'false'), oficial_ia_modelo, oficial_ia_prompt
-- (valores iniciais inseridos com on conflict do nothing)

-- conversation_herda_etapa(): passou a incluir o canal 'oficial' nas duas listas de canais.

-- Mensagem do time no canal oficial -> Edge Function envia pela Cloud API
create or replace function public.wa_oficial_dispara_envio()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_canal text; v_secret text;
begin
  if new.direction <> 'outbound' or new.ig_message_id is not null or new.sent_by is null then return new; end if;
  select channel into v_canal from conversations where id = new.conversation_id;
  if v_canal is distinct from 'oficial' then return new; end if;
  select value into v_secret from app_secrets where key = 'wa_oficial_internal';
  perform net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial',
    headers := jsonb_build_object('Content-Type','application/json','x-reino-secret', v_secret),
    body := jsonb_build_object('acao','enviar','message_id', new.id)
  );
  return new;
exception when others then
  return new;
end $$;

create or replace trigger trg_wa_oficial_envio after insert on public.messages
for each row execute function public.wa_oficial_dispara_envio();

create index if not exists idx_conversations_channel on public.conversations(channel);
create index if not exists idx_contacts_phone on public.contacts(phone);
