-- Aviso no grupo VENDAS quando a IA do WhatsApp Oficial agenda (funil-diagnostico-whatsapp):
-- "🤖 CALL AGENDADA PELA IA" com os dados do lead (e-mail, resumo da conversa, quando começaria, anúncio).
-- Os outros funis continuam com o "🗓️ LEAD AGENDADO!" de sempre. Mesmo envio (n8n aviso-lead-agendado → SDR IA MATEUS).
create or replace function public.notify_lead_agendado()
 returns trigger
 language plpgsql
as $function$
declare v_ag uuid; nome text; fone text; funil text; origem text; closer text; msg text; NL text := chr(10);
  r record; resumo text; comeca text;
begin
  select id into v_ag from public.kanban_stages where name='Agendado' limit 1;
  if new.stage_id = v_ag and (old.stage_id is distinct from new.stage_id) and new.agenda_link is not null then
    select coalesce(c.full_name, c.username, c.phone, 'Lead'), c.phone into nome, fone from public.contacts c where c.id = new.contact_id;
    funil := coalesce(nullif(new.funil,''), case new.channel when 'instagram' then 'Social Selling (Instagram)' when 'whatsapp' then 'WhatsApp (evento/outros)' when 'camilla' then 'Low Ticket (Camilla)' else coalesce(new.channel,'-') end);
    origem := nullif(concat_ws(' / ', new.qualificacao->'utm'->>'utm_source', new.qualificacao->'utm'->>'utm_campaign', new.qualificacao->'utm'->>'utm_content'), '');
    closer := nullif(new.qualificacao->>'closer','');

    if new.funil = 'funil-diagnostico-whatsapp' then
      -- a reserva já tem o meet_link quando o card é movido
      select ar.nome, ar.email, ar.whatsapp, ar.respostas into r
        from public.agenda_reservas ar where ar.meet_link = new.agenda_link order by ar.criado_em desc limit 1;
      resumo := nullif(left(r.respostas->>'Resumo da conversa', 600), '');
      comeca := nullif(left(r.respostas->>'Quando começaria', 200), '');
      fone := coalesce(nullif(r.whatsapp,''), fone);
      msg := '🤖 *CALL AGENDADA PELA IA*' || NL || NL
        || '👤 *Lead:* ' || coalesce(nullif(r.nome,''), nome, '-') || NL
        || coalesce('📱 +' || regexp_replace(fone, '\D', '', 'g') || NL, '')
        || coalesce('✉️ ' || nullif(r.email,'') || NL, '')
        || '📅 *Quando:* ' || coalesce(to_char(new.agenda_inicio at time zone 'America/Sao_Paulo','DD/MM "às" HH24:MI'),'-') || NL
        || coalesce('🤝 *Com:* ' || closer || NL, '')
        || coalesce('📢 *Anúncio:* ' || origem || NL, '')
        || coalesce(NL || '📝 *Resumo:* ' || resumo || NL, '')
        || coalesce('⏱️ *Começaria:* ' || comeca || NL, '')
        || NL || '🔗 ' || new.agenda_link || NL
        || coalesce('💬 https://wa.me/' || regexp_replace(fone, '\D', '', 'g') || NL, '')
        || NL || '@todos';
    else
      msg := '🗓️ *LEAD AGENDADO!*' || NL || NL
        || '👤 *Lead:* ' || coalesce(nome,'-') || NL
        || coalesce('📱 ' || fone || NL, '')
        || '📊 *Funil:* ' || funil || NL
        || coalesce('📢 *Origem:* ' || origem || NL, '')
        || coalesce('🤝 *Com:* ' || closer || NL, '')
        || '📅 *Quando:* ' || coalesce(to_char(new.agenda_inicio at time zone 'America/Sao_Paulo','DD/MM "às" HH24:MI'),'-') || NL
        || '🔗 ' || new.agenda_link || NL || NL || '@todos';
    end if;

    perform net.http_post(url := 'https://scarycrocodile-n8n.cloudfy.live/webhook/aviso-lead-agendado',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object('number','120363406449071564@g.us','text',msg,'mentionsEveryOne',true));
  end if;
  return new;
exception when others then return new;
end $function$;
