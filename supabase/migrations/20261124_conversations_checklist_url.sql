-- Link pessoal e aberto (sem login) do checklist de cada cliente.
-- Gerado a partir do id do card: existe para todo cliente, sem passo manual.
alter table public.conversations
  add column if not exists checklist_url text
  generated always as ('https://reino-crm.pages.dev/checklist-cliente#c=' || id::text) stored;
comment on column public.conversations.checklist_url is
  'Link pessoal do checklist da jornada (5 fases). Aberto: quem tem o link vê e marca. Usar nas mensagens do onboarding/grupo.';
