# Handoff — Atendimento do WhatsApp Oficial no Reino CRM

Atualizado em 09/11/2026. Leia tudo antes de mexer.

## Objetivo
Tirar o número oficial do WhatsApp (Cloud API) do Chatwoot e atender pelo app próprio dentro do Reino CRM,
com uma IA (Claude) respondendo primeiro e passando para o time quando precisa. A troca precisa ser
instantânea: no momento em que o webhook mudar, o atendimento já tem que funcionar no app novo.

## O que já está pronto e no ar

### Supabase (projeto `lcbymyvzhnwcmpdukyqr`)
- **Edge Function `wa-oficial`** (verify_jwt = false), código em `supabase/functions/wa-oficial/index.ts`.
  URL: `https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial`
  - `GET` com `hub.verify_token` → verificação do webhook da Meta. Token em `app_secrets.wa_oficial_verify_token`
    (valor atual: `98250df9e673758352c63352747b57285024`). Testado: devolve o challenge.
  - `POST` da Meta → grava contato/conversa/mensagem com `channel = 'oficial'`, marca a mensagem como lida,
    atualiza `wa_disparos` (entregue/lido/falha/respondeu) igual ao fluxo n8n "MR78 — WhatsApp Status/Respostas"
    (`nZF8nChDJkUdm0jG`, path `wa-status`), e roda a IA. Responde 200 na hora (`EdgeRuntime.waitUntil`).
  - `POST {acao:"enviar", message_id}` com header `x-reino-secret` (= `app_secrets.wa_oficial_internal`)
    → envia pela Cloud API a mensagem que o time escreveu no CRM.
  - Valida `X-Hub-Signature-256` só se o secret `META_APP_SECRET` existir.
  - Graph API `v21.0`, Phone Number ID padrão `1095430970325134` (sobrescrevível por `WA_PHONE_NUMBER_ID`).
- **IA:** espera 7 s (debounce; só a última mensagem do lead dispara), lê as últimas 40 mensagens, chama a
  Anthropic com tool `responder` forçada `{resposta, transferir_humano, motivo}`. `ANTHROPIC_API_KEY` já existe
  nos secrets do projeto (testado: a IA respondeu). Ao transferir: `conversations.ia_ativa=false` e
  `next_action = "🤖 IA passou pro time: <motivo>"`. Quando o time envia, `ia_pausada_ate = now()+12h`.
- **Config editável** em `crm_config`: `oficial_ia_ativa` ('true'/'false'), `oficial_ia_modelo`
  (padrão `claude-sonnet-5`), `oficial_ia_prompt` (texto da IA — ainda com o trecho `[EDITE AQUI]`).
- **Gatilho** `trg_wa_oficial_envio` em `messages` (AFTER INSERT): mensagem `outbound` com `sent_by` preenchido,
  sem `ig_message_id`, em conversa `channel='oficial'` → `net.http_post` para a função (acao=enviar).
- **`conversation_herda_etapa()`** passou a incluir o canal `'oficial'` (herda etapa do mesmo lead em outros canais).
- Registro do SQL aplicado: `supabase/migrations/20261109_wa_oficial_atendimento.sql`.
- Regras importantes do schema: `messages.attachment_type` só aceita
  `image|video|audio|file|share|story_reply|story_mention|reel`; `messages.ig_message_id` é UNIQUE (guardamos o wamid
  aí, serve de deduplicação); `messages.sent_by` é FK para `team_members`; mensagens da IA usam `sender_id='ia'` e
  `sent_by=null` (não disparam o gatilho de envio). Contato do canal: `contacts.channel='oficial'`, `phone` só dígitos,
  `ig_user_id='wa:'+phone`.

### Front (Cloudflare Pages `reino-crm.pages.dev`, pasta `publicar/`, deploy automático no push da `main`)
- `publicar/index.html`: canal `oficial` ("✅ WhatsApp Oficial") em Conversas e no Pipeline; botão IA on / pausada /
  "Time no controle" no chat; aviso de janela de 24h; erro de envio visível (`messages.raw.erro`); botão
  "🤖 IA do Oficial" (componente `IAOficialConfig`); atalho "💬 Tela de atendimento ↗".
- `publicar/atendimento/index.html`: tela própria de atendimento (mesma sessão/login do CRM, ID V7, claro/escuro,
  mobile). Filtros Todas / Precisa do time / IA atendendo / Não lidas, realtime, etapa do pipeline, próxima ação.
- Tudo isso já foi mergeado na `main` e publicado.

### Testes já feitos (via `pg_net`, número falso 5599000000001, conversa arquivada)
- GET de verificação ✅ · POST de mensagem recebida ✅ (contato, conversa, mensagem, IA respondeu) ·
  envio pelo time via gatilho ✅ até a Cloud API. **Os dois envios falharam só porque `WA_TOKEN` ainda não existe.**

## O que falta (nesta ordem)

1. **`WA_TOKEN` nos secrets das Edge Functions.** O Mateus vai colar o token pelo painel:
   `https://supabase.com/dashboard/project/lcbymyvzhnwcmpdukyqr/functions/secrets` (nome `WA_TOKEN`, valor sem "Bearer").
   Token permanente do usuário do sistema (Business Manager → Usuários do sistema → Gerar token, app do número,
   validade Nunca, `whatsapp_business_messaging` + `whatsapp_business_management`). Opcional: `META_APP_SECRET`.
   Depois de salvo, testar envio real para o celular do Mateus **dentro da janela de 24h** (ele manda "oi" antes).

2. **Descobrir como o número está ligado no Chatwoot hoje** (hoje o atendimento é pelo Chatwoot):
   - Se a caixa do Chatwoot mostra "Webhook URL" + "Verify Token" (configuração manual), o webhook está no **app da
     Meta do próprio Mateus** → a troca é só editar a URL de callback nesse app.
   - Se a caixa foi criada pelo botão de conexão com a Meta (embedded signup / quick setup), o webhook pode estar no
     app do Chatwoot ou com `override_callback_uri` na WABA → conferir com
     `GET /{WABA_ID}/subscribed_apps` e, se for o caso, reinscrever o app do Mateus
     (`POST /{WABA_ID}/subscribed_apps` com `override_callback_uri` + `verify_token`).
   - Anotar a URL/configuração atual para poder voltar.

3. **Troca instantânea, sem buraco.** Recomendado:
   - (a) Antes da troca: `WA_TOKEN` ok, prompt da IA final em `crm_config.oficial_ia_prompt`, time logado em
     `reino-crm.pages.dev/atendimento/`.
   - (b) Opcional e mais seguro: adicionar na `wa-oficial` um repasse (fan-out) do payload bruto da Meta para a URL
     antiga do Chatwoot enquanto durar a transição (secret `FORWARD_URL`; repassar headers `X-Hub-Signature-256`
     e corpo idênticos, sem bloquear a resposta). Assim as duas ferramentas recebem e dá pra comparar.
     Atenção: se repassar, **desligar a IA/bot de um dos lados** para o cliente não receber duas respostas.
   - (c) Trocar a callback para `https://lcbymyvzhnwcmpdukyqr.supabase.co/functions/v1/wa-oficial` com o verify token
     acima → "Verificar e salvar" → campo `messages` assinado. Vale na hora.
   - (d) Desligar o bot/automação do Chatwoot (e os fluxos n8n que ouviam o Chatwoot, ex.:
     `Jpjc3djuU23HoaNr`, `8KQNUTlncCgcUvNq`, `vbzP5vKZ0QhdJ26r` — confirmar com o Mateus antes de desativar).
   - Histórico antigo fica no Chatwoot; conversas novas nascem no CRM na primeira mensagem do cliente.

4. **Prompt da IA.** O Mateus disse que o prompt "já foi configurado" — perguntar onde está (Chatwoot? n8n?
   `wa_ia_config.prompt_ic1`? fluxo JP?) e copiar para `crm_config.oficial_ia_prompt`, mantendo as regras de
   transferência para humano.

5. **Testes de aceitação** (celular de fora do time): IA responde em ~10–15 s; 3 mensagens seguidas → 1 resposta;
   time responde → chega no celular e a IA pausa 12 h; "quero falar com uma pessoa" → "Time no controle" + motivo
   na próxima ação; disparo de campanha continua marcando `respondeu` em `wa_disparos`. Logs:
   Supabase → Edge Functions → `wa-oficial` → Logs.

## Melhorias que ainda não existem (perguntar antes de fazer)
- Mídia: hoje áudio/imagem/documento entram só como texto `[🎤 áudio]` etc. (sem baixar o arquivo). Dá para baixar via
  `GET /{media_id}` e salvar no Storage; transcrever áudio para a IA.
- Envio de template pelo CRM quando a janela de 24h fechou.
- Fila/retentativa se a Graph API falhar; aviso no Slack/push quando a IA passar pro time.

## Segurança (achados, nada foi alterado)
- 12 tabelas com RLS desligado (ex.: `asaas_cobrancas`, `cobranca_envios`, `helo_sdr_leads`, `webinar_leads`).
- Fluxo n8n `nZF8nChDJkUdm0jG` tem a service_role key do Supabase escrita no código do nó.

## Regras de trabalho
- Não apagar dados nem desativar fluxos do n8n sem o Mateus confirmar.
- Mudanças de banco: preferir `create or replace` / `if not exists`; registrar o SQL em `supabase/migrations/`.
- Front: editar `publicar/` (é o que vai pro ar); push na `main` publica sozinho.
