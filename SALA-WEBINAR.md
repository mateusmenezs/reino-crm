# Sala própria de webinar ("WebinarJam do Mateus")

Documento de passagem de bastão. Leia inteiro antes de mexer na sala.

## Objetivo

Sala ao vivo própria para eventos/webinars da Reino, que mede:

- quantos **entraram** (pessoas únicas, por WhatsApp)
- quantos estavam **ao vivo** (minuto a minuto)
- quantos estavam **ao vivo no pitch**
- quantos **clicaram** na agenda e quantos **agendaram**
- **faturamento** declarado na enquete → quem é **qualificado**

E transforma isso num "CRMzinho": listas por momento (saiu antes do pitch, viu o pitch e não clicou, clicou e não agendou, agendou) com mensagem de WhatsApp personalizada para cada grupo.

## Onde está

| O quê | Onde |
|---|---|
| Página do participante | `publicar/sala/index.html` → https://reino-crm.pages.dev/sala/?w=SLUG |
| Painel admin | `publicar/sala/admin.html` → https://reino-crm.pages.dev/sala/admin |
| Banco | Supabase `lcbymyvzhnwcmpdukyqr` (o mesmo do Reino CRM), tabelas `sala_*` |
| Deploy | push na `main` → Cloudflare Pages publica sozinho (output dir = `publicar`) |

As duas páginas são HTML single-file, sem build, com `@supabase/supabase-js@2` via CDN e a chave **publishable** (`sb_publishable_...`). Ambas têm `noindex`.

## Banco (migrations `sala_webinar_v1` e `sala_entrar_nono_digito`)

- **`sala_webinars`**: um por evento. `slug` (vai no link), `titulo`, `youtube_id`, `agenda_url`, `cta_texto`, `status` (`aguardando` | `ao_vivo` | `encerrado`), `enquete_aberta`, `enquete_pergunta`, `enquete_opcoes` (jsonb, da menor para a maior faixa), `qualifica_a_partir` (índice 0-based da opção), `cta_visivel`, `pitch_em`, `iniciado_em`, `encerrado_em`.
  - RLS: `anon` lê (a página pública escuta esta linha); só `is_team_member()` escreve.
  - Está na publicação `supabase_realtime`: a sala reage na hora quando o painel muda status, enquete ou CTA (com polling de 20s como reserva).
- **`sala_presencas`**: uma linha por pessoa por webinar. `telefone` normalizado (`55DDDNUMERO`), `telefone_l8`, `token`, `enquete_resposta`, `clicou_cta_em`, `agendou_em`. RLS: só time.
  - A mesma pessoa com ou sem o nono dígito = mesmo DDD + últimos 8 dígitos → não duplica.
- **`sala_minutos`**: `(presenca_id, minuto)`. O ping a cada 30s grava o minuto. É a base da curva de retenção e de "viu o pitch".
- **View `sala_presencas_status`** (security_invoker): `minutos`, `ultimo_minuto`, `viu_pitch`, `qualificado`, `online` (ping < 75s).
- **RPCs públicas (anon)**, todas `security definer` e validando `id + token`: `sala_entrar(slug, nome, telefone, ua)`, `sala_ping(id, token)`, `sala_responder(id, token, resposta)`, `sala_clicou(id, token)`.
- **`sala_agendou(telefone, slug?)`**: só `service_role` (para o n8n). Sem slug, marca os webinars dos últimos 7 dias.
- **`sala_curva(webinar_id)`**: pessoas por minuto (painel).

Existe um webinar de teste com slug `teste`.

## Como funciona a sala (index.html)

1. Entrada pede **nome + WhatsApp** (o link é mandado no grupo, então não dá para usar link personalizado). Guarda `{id, token}` no `localStorage` por slug: quem volta entra direto.
2. Layout **estilo Zoom**: barra branca em cima (logo R vinho, título, badge Ao vivo), vídeo ocupando o palco, barra embaixo com avatar e nome.
3. **Enquete e agenda aparecem como pop-ups** (canto inferior direito no desktop, bottom sheet no celular), com um "plim" sonoro. Um pop-up por vez (a agenda espera a enquete). O × minimiza para um botão na barra de baixo.
4. Link da agenda recebe `name`, `phone`, `utm_source=sala` e `utm_campaign=SLUG`.

## Painel (admin.html)

Login com o usuário do Reino CRM (Supabase Auth + `team_members`). Funções: criar/editar webinar, copiar link da sala, botões Aguardando / Ao vivo / Encerrar, abrir/fechar enquete, mostrar/esconder agenda e o botão grande **Começou o pitch** (grava `pitch_em` e liga o CTA). KPIs, curva por minuto com a marca do pitch, abas por segmento com mensagem editável (`{nome}`), botão de WhatsApp, marcar "Agendou" manualmente, copiar telefones e CSV.

## Visual

O Mateus pediu **fundo branco**, inspirado no visual limpo da Hotmart (sem usar a marca dela): fundo `#F5F6F8`/`#EEF0F3`, cartões brancos, borda `#E3E5E9`, cantos arredondados, Manrope. Botão laranja `#D93F00` com texto branco (contraste 4,5:1; o `#FF4D00` da marca não passa com texto branco). Logo: símbolo R oficial em vinho `#3B101D`.

## Decisões sobre a transmissão

- **Hoje:** YouTube Live **não listado** embutido (usar latência **ultrabaixa**, 2–5s).
- Cloudflare Stream e Mux foram avaliados. O Mateus achou o Cloudflare caro. O Mux é a alternativa barata se um dia quiser tirar a marca do YouTube.
- **Próximo passo decidido: Zoom Meeting (não Webinar) embutido na sala** via Zoom Meeting SDK for Web (Component View), porque ele quer que **todo mundo possa abrir a câmera** e ele libere o microfone de quem levantar a mão. Até 100 pessoas → plano **Pro** do Zoom basta.
  - Google Meet foi descartado: não dá para embutir na página, perderia os pop-ups e as métricas exatas.
  - Zoom Webinar foi descartado: participante não abre câmera.

## Pendências (em ordem)

1. **Zoom na sala**
   - Mateus cria um General App com Meeting SDK em marketplace.zoom.us e passa Client ID / Client Secret.
   - Edge function no Supabase que gera a assinatura (JWT) do Meeting SDK. O secret fica em secret da function, nunca na página. Ela valida `id + token` da presença antes de assinar e devolve também número e senha da reunião (a senha não pode ficar em `sala_webinars`, que o `anon` lê).
   - Na `sala_webinars`: campo para o número da reunião (e a senha em lugar não legível pelo `anon`) e um modo `zoom` | `youtube`.
   - Sala: trocar o iframe do YouTube pelo Zoom embutido, com o nome já preenchido; os pop-ups continuam por cima.
   - Métricas extras pelos eventos do SDK: abriu câmera, levantou a mão, falou → nova lista "engajados" no painel.
   - Configuração recomendada da reunião: todos entram mudos, participantes não podem se desmutar, levantar a mão ligado, entrada só pelo SDK (para ninguém fugir da medição).
   - Fallback: relatório de participantes do Zoom ao fim do evento, cruzado por nome.
2. **Agendamento automático**: fluxo n8n que recebe o webhook da agenda (Cal.com ou Calendly — perguntar qual) e chama `sala_agendou(telefone)` com a service role.
3. Chat na sala (se ficar no YouTube; com Zoom já vem).

## Avisos

- **12 tabelas antigas do projeto estão sem RLS** (`asaas_cobrancas`, `cobranca_envios`, `webinar_leads`, `helo_sdr_leads`, `mentoria_leads`, `fin_comissao_regras`, `dom_cobrancas`, `disparo_*`, `reengaja_rj_mr79`, `asaas_webhooks`). Não são da sala; foram só sinalizadas, não alteradas.
- Sempre testar com o webinar `teste` antes de evento real.
