-- 16/11/2026 · Abordagem ativa pelo WhatsApp Oficial (lead de página que aplicou e não agendou).
-- O n8n chama rpc/oficial_chamar com o corpo pra edge wa-oficial ({acao:"abordar", ...}); o segredo interno
-- fica só no banco. Também serve pra criar/consultar modelo (template_criar / template_status).
create or replace function public.oficial_chamar(payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_id bigint;
begin
  if coalesce(payload->>'acao', '') not in ('abordar', 'template_criar', 'template_status') then
    raise exception 'acao não permitida';
  end if;
  select value into v_secret from app_secrets where key = 'wa_oficial_internal';
  select net.http_post(
    url := 'https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-reino-secret', v_secret),
    body := payload,
    timeout_milliseconds := 30000
  ) into v_id;
  return v_id;
end;
$$;

revoke all on function public.oficial_chamar(jsonb) from public, anon, authenticated;
grant execute on function public.oficial_chamar(jsonb) to service_role;
