# Reino CRM v5

CRM reconstruído em **1 arquivo só** (`index.html`), com **login**, conectado ao banco
Supabase "REINO CRM". Sem build, sem instalar nada — é só abrir/hospedar o HTML.

## Como abrir
1. Abra `index.html` (duplo-clique) ou hospede na Vercel (igual ao CRM antigo).
2. Faça login:
   - **mateus@reinocrm.com** · senha **Reino@2026** (admin)
   - **cris@reinocrm.com** · senha **Reino@2026** (admin)
   > Recomendo trocar a senha depois (dá pra criar mais usuários no painel do Supabase →
   > Authentication → Add user; ele vira "team_member" automaticamente).

## O que tem (testado e funcionando)
- **Login** (Supabase Auth) — os dados de Instagram são protegidos, só o time acessa.
- **📸 Instagram** — duas visões:
  - **Inbox**: lista de conversas + thread + responder (atualiza em tempo real).
  - **Pipeline**: kanban arrastável (etapas vêm da tabela `kanban_stages`).
- **💬 WhatsApp (Cris)** — kanban de leads (`pipeline = whatsapp_cris`); ao abrir um card
  mostra o histórico do WhatsApp (tabela `wa_messages`, da sua automação Evolution/n8n).
- **🎟️ Vendas/Evento** e **🤝 CS** — os pipelines que já existiam (leads / mentorados).

## Onde mexer
- **Etapas do Instagram**: edite na tabela `kanban_stages` (nome, cor, ordem) — sem tocar no código.
- **Etapas de Vendas/WhatsApp-Cris/CS**: no `index.html`, blocos `LEAD_PIPELINES` e `CS_STAGES`.

## Importante (descoberta)
O banco **já tinha** toda a estrutura profissional de CRM de Instagram (tabelas
`instagram_accounts`, `contacts`, `conversations`, `messages`, `kanban_stages`, `team_members`)
e a de WhatsApp via Evolution (`wa_messages`). **Reaproveitamos tudo** — não criei tabelas
duplicadas. O `schema.sql` aqui é só o registro do que foi ajustado (login + correção de RLS).

---

# Fase 2 — Ligar as DMs do Instagram AO VIVO

A parte de software está pronta: o workflow do n8n **"Instagram DMs - Reino CRM"** já existe
(id `O7BsWPdKY28LtMoP`). Fluxo:

```
DM no Instagram → Webhook (n8n) → grava em contacts/conversations/messages → CRM mostra na Inbox
Você responde no CRM → vira message outbound (ig_message_id vazio) → n8n a cada 1 min envia
   pela Send API do Instagram (usando instagram_accounts.page_access_token) → marca como enviada
```

### O que falta (depende da Cris / Meta — eu não consigo fazer):
1. Conta IG **Profissional** ligada a uma **Página do Facebook**.
2. App em **developers.facebook.com** com **Instagram / Messenger API**, permissão
   `instagram_manage_messages`, e **App Review** aprovado.
3. Cadastrar **1 linha** na tabela `instagram_accounts` com:
   `ig_user_id`, `page_id`, `username`, `page_access_token`, `webhook_verify_token`, `is_active = true`.
4. No n8n, definir as variáveis de ambiente `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` (service_role).
5. No painel da Meta, apontar o **Webhook** (campo *messages*) para a URL de produção do
   workflow, path **/instagram-dm**, usando o mesmo `webhook_verify_token`.

> Atalho sem App Review: usar **ManyChat / 360dialog** como intermediário gravando no mesmo
> Supabase. Liga em horas, com menos controle. Me avise se quiser esse caminho.

### Segurança a decidir
A tabela `activity_log` está com RLS desabilitado (exposta). Veja o item 4 no `schema.sql`.
