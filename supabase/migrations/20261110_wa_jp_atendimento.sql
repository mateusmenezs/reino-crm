-- WhatsApp do JP (Evolution, instância "JP", +55 21 99989-7082) na tela de Atendimento.
-- Edge Function: supabase/functions/wa-jp  ·  canal conversations.channel = 'jp' (já existia, alimentado pelo Hermes SDR até 22/10)
-- Só o time responde por enquanto (sem IA).

-- chave que vai na URL do webhook da Evolution (?k=...)
insert into public.app_secrets(key, value, updated_at)
values ('wa_jp_webhook_key', encode(gen_random_bytes(18),'hex'), now())
on conflict (key) do nothing;

-- 1 conversa jp por contato
create unique index if not exists conversations_jp_contact_uk
  on public.conversations (contact_id) where channel = 'jp';

-- Mensagem do time no canal jp -> Edge Function envia pela Evolution
create or replace function public.wa_jp_dispara_envio()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_canal text; v_secret text;
begin
  if new.direction <> 'outbound' or new.ig_message_id is not null or new.sent_by is null then return new; end if;
  select channel into v_canal from conversations where id = new.conversation_id;
  if v_canal is distinct from 'jp' then return new; end if;
  select value into v_secret from app_secrets where key = 'wa_oficial_internal';
  perform net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-jp',
    headers := jsonb_build_object('Content-Type','application/json','x-reino-secret', v_secret),
    body := jsonb_build_object('acao','enviar','message_id', new.id)
  );
  return new;
exception when others then
  return new;
end $$;

create or replace trigger trg_wa_jp_envio after insert on public.messages
for each row execute function public.wa_jp_dispara_envio();
