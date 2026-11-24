-- Checklist v2 (24/11): 3 calls (Rafael/Pedro/Thiago), materiais no Drive, Cloudfy num item só, aulas do portal.
create or replace function public.checklist_jornada(p_conv uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c record; m record; chk jsonb; fases jsonb := '[]'::jsonb; it jsonb;
  calls jsonb := '{}'::jsonb; cl record;
  passos jsonb; p_tot int; p_ok int;
  f0 jsonb; f1 jsonb; f2 jsonb; f3 jsonb; f4 jsonb;
  tot int := 0; ok int := 0; fase jsonb; i jsonb; fs jsonb := '[]'::jsonb; ft int; fo int;
begin
  select cv.id, cv.produto, cv.venda_em, cv.contrato_assinado_em, cv.contrato_sign_url,
         cv.grupo_link, cv.drive_folder_url, cv.welcome_comunidade_em, cv.briefing_ok_em,
         ct.full_name
    into c
    from conversations cv left join contacts ct on ct.id = cv.contact_id
   where cv.id = p_conv and cv.produto is not null;
  if not found then return null; end if;

  select mt.is_trafego, mt.trafego_etapa into m
    from mentorados mt where mt.source_conversation_id = p_conv
   order by mt.criado_em desc limit 1;

  select coalesce(jsonb_object_agg(item_key, feito), '{}'::jsonb) into chk
    from checklist_cliente where conversation_id = p_conv;

  -- calls da entrega (ordem 1..4)
  for cl in select ordem, titulo, responsavel, status, inicio, feita_em, calendar_id, meet_link
              from entrega_calls where conversation_id = p_conv order by ordem loop
    calls := calls || jsonb_build_object(cl.ordem::text, jsonb_strip_nulls(jsonb_build_object(
      'key', 'call_' || cl.ordem, 'tipo', 'call', 'ordem', cl.ordem,
      'label', cl.titulo, 'responsavel', cl.responsavel,
      'status', coalesce(cl.status, case when cl.feita_em is not null then 'feita' else 'pendente' end),
      'inicio', cl.inicio, 'meet_link', cl.meet_link,
      'tem_agenda', coalesce(trim(cl.calendar_id), '') <> '',
      'help', case cl.ordem
        when 1 then 'Monta seu plano de ação e já sobe o teste de temas. O resultado do teste é analisado na próxima call.'
        when 2 then 'Analisamos o resultado do teste de temas e construímos seu funil com o tema campeão.'
        when 3 then 'Scripts, proposta e rotina comercial para converter os leads que o funil traz.' end
        || ' Toda call termina com a próxima já agendada.',
      'feito', cl.feita_em is not null or cl.status in ('feita','confirmar'))));
  end loop;

  -- primeiros passos do plano de ação
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', id, 'texto', texto, 'prazo', prazo, 'feito', feito_em is not null)) order by ordem), '[]'::jsonb),
         count(*), count(feito_em)
    into passos, p_tot, p_ok
    from plano_acao_passos where conversation_id = p_conv;

  -- ===== Fase 0 — Boas-vindas =====
  f0 := jsonb_build_array(
    _chk_item('contrato', 'Assinar o contrato', 'auto', c.contrato_assinado_em is not null,
      case when c.contrato_assinado_em is null then 'Assinatura digital pelo ZapSign.' end,
      case when c.contrato_assinado_em is null then c.contrato_sign_url end, 'Assinar contrato'),
    _chk_item('grupo', 'Grupo do seu programa no WhatsApp', 'auto', c.grupo_link is not null,
      case when c.grupo_link is null then 'O time cria o grupo e te adiciona.' else 'Seu canal direto com o time.' end,
      c.grupo_link, 'Abrir grupo'),
    _chk_item('comunidade', 'Entrar na comunidade do programa', 'cliente',
      c.welcome_comunidade_em is not null or coalesce((chk->>'comunidade')::boolean, false),
      'O link chega no seu WhatsApp quando o contrato é assinado.'),
    _chk_item('drive', 'Sua pasta de materiais (Drive)', 'auto', c.drive_folder_url is not null,
      case when c.drive_folder_url is null then 'O time cria a pasta pra você.' end,
      c.drive_folder_url, 'Abrir pasta')
  );

  -- ===== Fase 1 — Setup técnico =====
  f1 := jsonb_build_array(
    _chk_item('materiais', 'Subir seus materiais na pasta do Drive', 'cliente',
      coalesce((chk->>'materiais')::boolean, (chk->>'foto_marca')::boolean, false),
      'Fotos profissionais, logo e cores da marca, depoimentos de clientes, prints de resultados e páginas ou criativos que você já usou. É com isso que montamos suas páginas e criativos.',
      c.drive_folder_url, 'Abrir pasta'),
    _chk_item('hospedagem', 'Domínio e hospedagem', 'cliente', coalesce((chk->>'hospedagem')::boolean, false),
      'Passo a passo na Plataforma Reino.', 'https://portal.reinotreinamentos.com/trilhas/setup/#m1', 'Ver aula'),
    _chk_item('anuncios', 'Business Manager e conta de anúncios', 'cliente', coalesce((chk->>'anuncios')::boolean, false),
      'Passo a passo na Plataforma Reino.', 'https://portal.reinotreinamentos.com/trilhas/setup/#m8', 'Ver aula'),
    _chk_item('cloudfy', 'Cloudfy: n8n, Supabase e Evolution (WhatsApp)', 'cliente',
      coalesce((chk->>'cloudfy')::boolean, false)
        or (coalesce((chk->>'n8n')::boolean,false) and coalesce((chk->>'supabase')::boolean,false) and coalesce((chk->>'evolution')::boolean,false)),
      'As três ferramentas das suas automações são liberadas de uma vez na Cloudfy. Passo a passo na Plataforma Reino.',
      'https://portal.reinotreinamentos.com/trilhas/setup/#m3', 'Ver aula')
  );

  -- ===== Fase 2 — Briefing & plano de ação =====
  f2 := jsonb_build_array(
    _chk_item('briefing', 'Preencher o briefing', 'auto', c.briefing_ok_em is not null,
      case when c.briefing_ok_em is null then 'As informações do seu negócio. A 1ª call (Estratégia) já sai agendada no fim.' end,
      case when c.briefing_ok_em is null then 'https://scarycrocodile-n8n.cloudfy.live/webhook/discovery-impl?c=' || p_conv end,
      'Abrir briefing'));
  if calls ? '1' then f2 := f2 || jsonb_build_array(calls->'1'); end if;
  f2 := f2 || jsonb_build_array(
    _chk_item('passos', 'Fazer os primeiros passos do plano', 'auto', p_tot > 0 and p_ok = p_tot,
      case when p_tot = 0 then 'Definidos com você na call de Estratégia.'
           else p_ok || ' de ' || p_tot || ' feitos' end) || jsonb_build_object('passos', passos));

  -- ===== Fase 3 — Campanha & comercial =====
  f3 := '[]'::jsonb;
  if calls ? '2' then f3 := f3 || jsonb_build_array(calls->'2'); end if;
  f3 := f3 || jsonb_build_array(
    _chk_item('aprovacao_campanha', 'Aprovar página e criativos da campanha', 'cliente',
      coalesce((chk->>'aprovacao_campanha')::boolean, false),
      'Marque quando der o OK no que o time te enviou.'));
  if calls ? '3' then f3 := f3 || jsonb_build_array(calls->'3'); end if;

  fases := jsonb_build_array(
    jsonb_build_object('n', 0, 'titulo', 'Boas-vindas', 'itens', f0),
    jsonb_build_object('n', 1, 'titulo', 'Setup técnico', 'itens', f1),
    jsonb_build_object('n', 2, 'titulo', 'Briefing e plano de ação', 'itens', f2),
    jsonb_build_object('n', 3, 'titulo', 'Funil e comercial', 'itens', f3));

  -- ===== Fase 4 — No ar (só quem tem tráfego com a Reino) =====
  if coalesce(m.is_trafego, false) then
    f4 := jsonb_build_array(
      _chk_item('campanha_no_ar', 'Campanha no ar', 'auto', m.trafego_etapa ilike 'campanha no ar',
        coalesce('Etapa atual: ' || m.trafego_etapa, 'O time te avisa quando subir.')));
    fases := fases || jsonb_build_array(jsonb_build_object('n', 4, 'titulo', 'No ar', 'itens', f4));
  end if;

  -- contagens por fase e total
  for fase in select * from jsonb_array_elements(fases) loop
    ft := 0; fo := 0;
    for i in select * from jsonb_array_elements(fase->'itens') loop
      ft := ft + 1; if (i->>'feito')::boolean then fo := fo + 1; end if;
    end loop;
    tot := tot + ft; ok := ok + fo;
    fs := fs || jsonb_build_array(fase || jsonb_build_object('feitos', fo, 'total', ft));
  end loop;

  return jsonb_build_object(
    'id', c.id, 'nome', coalesce(c.full_name, ''), 'produto', c.produto, 'venda_em', c.venda_em,
    'feitos', ok, 'total', tot, 'fases', fs);
end $$;

