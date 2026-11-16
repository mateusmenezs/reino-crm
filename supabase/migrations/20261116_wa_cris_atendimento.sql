-- WhatsApp da Cris (Evolution, instância "Crisv2", não oficial) na tela de Atendimento — 16/11/2026.
-- Edge Function: supabase/functions/wa-cris · canal conversations.channel = 'cris'
-- Recebe: webhook da Evolution → wa-cris (?k=wa_cris_webhook_key). Envia: wa-cris → n8n "Cris · Enviar do CRM"
-- (a chave da instância fica só na credencial CRIS V3 do n8n). Só o time responde (sem IA).

insert into public.app_secrets(key, value, updated_at)
values ('wa_cris_webhook_key', encode(gen_random_bytes(18),'hex'), now())
on conflict (key) do nothing;

create unique index if not exists conversations_cris_contact_uk
  on public.conversations (contact_id) where channel = 'cris';

create or replace function public.wa_cris_dispara_envio()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_canal text; v_secret text;
begin
  if new.direction <> 'outbound' or new.ig_message_id is not null or new.sent_by is null then return new; end if;
  select channel into v_canal from conversations where id = new.conversation_id;
  if v_canal is distinct from 'cris' then return new; end if;
  select value into v_secret from app_secrets where key = 'wa_oficial_internal';
  perform net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-cris',
    headers := jsonb_build_object('Content-Type','application/json','x-reino-secret', v_secret),
    body := jsonb_build_object('acao','enviar','message_id', new.id)
  );
  return new;
exception when others then
  return new;
end $$;

create or replace trigger trg_wa_cris_envio after insert on public.messages
for each row execute function public.wa_cris_dispara_envio();
