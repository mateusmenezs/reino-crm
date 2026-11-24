-- Checklist padrão da jornada do cliente: 5 fases, definido UMA vez aqui.
-- Usado pela edge `checklist-cliente` (página pessoal do cliente) e pela
-- tela do time (`checklist-admin.html`, via checklist_jornada_time()).
--
-- tipo = 'auto'    -> o sistema sabe sozinho (cliente só vê)
--        'cliente' -> só o cliente sabe; ele marca (tabela checklist_cliente)
--        'call'    -> reunião da entrega (entrega_calls)
-- Item 'cliente' pode também marcar sozinho quando existe sinal no banco
-- (ex.: comunidade com welcome_comunidade_em).

create or replace function public._chk_item(
  p_key text, p_label text, p_tipo text, p_feito boolean,
  p_help text default null, p_link text default null, p_link_label text default null)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'key', p_key, 'label', p_label, 'tipo', p_tipo, 'feito', coalesce(p_feito,false),
    'help', p_help, 'link', nullif(trim(coalesce(p_link,'')),''), 'link_label', p_link_label));
$$;

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
    _chk_item('foto_marca', 'Enviar foto profissional + logo e cores da marca', 'cliente',
      coalesce((chk->>'foto_marca')::boolean, false),
      'Usamos nos criativos e no teste de temas. Envie na sua pasta do Drive.',
      c.drive_folder_url, 'Enviar na pasta'),
    _chk_item('hospedagem', 'Hospedagem / domínio contratado', 'cliente', coalesce((chk->>'hospedagem')::boolean, false)),
    _chk_item('anuncios', 'Conta de anúncios configurada', 'cliente', coalesce((chk->>'anuncios')::boolean, false)),
    _chk_item('n8n', 'Acesso ao n8n liberado (Cloudfy)', 'cliente', coalesce((chk->>'n8n')::boolean, false)),
    _chk_item('supabase', 'Acesso ao Supabase liberado (Cloudfy)', 'cliente', coalesce((chk->>'supabase')::boolean, false)),
    _chk_item('evolution', 'Acesso ao Evolution / WhatsApp liberado (Cloudfy)', 'cliente', coalesce((chk->>'evolution')::boolean, false))
  );

  -- ===== Fase 2 — Briefing & plano de ação =====
  f2 := jsonb_build_array(
    _chk_item('briefing', 'Preencher o briefing', 'auto', c.briefing_ok_em is not null,
      case when c.briefing_ok_em is null then 'As informações do seu negócio. A call de Estratégia já sai agendada no fim.' end,
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
  if calls ? '3' then f3 := f3 || jsonb_build_array(calls->'3'); end if;
  f3 := f3 || jsonb_build_array(
    _chk_item('aprovacao_campanha', 'Aprovar página e criativos da campanha', 'cliente',
      coalesce((chk->>'aprovacao_campanha')::boolean, false),
      'Marque quando der o OK no que o time te enviou.'));
  if calls ? '4' then f3 := f3 || jsonb_build_array(calls->'4'); end if;

  fases := jsonb_build_array(
    jsonb_build_object('n', 0, 'titulo', 'Boas-vindas', 'itens', f0),
    jsonb_build_object('n', 1, 'titulo', 'Setup técnico', 'itens', f1),
    jsonb_build_object('n', 2, 'titulo', 'Briefing e plano de ação', 'itens', f2),
    jsonb_build_object('n', 3, 'titulo', 'Campanha e comercial', 'itens', f3));

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

revoke all on function public.checklist_jornada(uuid) from public, anon, authenticated;
grant execute on function public.checklist_jornada(uuid) to service_role;

-- Tela do time: resumo de todos os clientes ativos (só membros do time)
create or replace function public.checklist_jornada_time()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb := '[]'::jsonb; cv record; j jsonb;
begin
  if not is_team_member() then raise exception 'acesso negado'; end if;
  for cv in select id from conversations
             where produto is not null and coalesce(is_archived,false) = false
             order by venda_em desc nulls last loop
    j := checklist_jornada(cv.id);
    if j is not null then
      r := r || jsonb_build_array(jsonb_build_object(
        'id', j->'id', 'nome', j->'nome', 'produto', j->'produto', 'venda_em', j->'venda_em',
        'feitos', j->'feitos', 'total', j->'total',
        'fases', (select jsonb_agg(jsonb_build_object('n', f->'n', 'titulo', f->'titulo',
                    'feitos', f->'feitos', 'total', f->'total',
                    'pendentes', (select coalesce(jsonb_agg(x->>'label'), '[]'::jsonb)
                                    from jsonb_array_elements(f->'itens') x where not (x->>'feito')::boolean)))
                  from jsonb_array_elements(j->'fases') f)));
    end if;
  end loop;
  return r;
end $$;

revoke all on function public.checklist_jornada_time() from public, anon;
grant execute on function public.checklist_jornada_time() to authenticated;
