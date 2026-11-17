-- Cadastros dos funis do site via edge lead-site (16/11/2026). 1 linha por funil + WhatsApp.
create table if not exists public.site_leads (
  id uuid primary key default gen_random_uuid(),
  funil text not null,
  whatsapp text not null,
  email text,
  nome text,
  dados jsonb,
  envio jsonb,
  ultimo_reenvio jsonb,
  criado_em timestamptz not null default now(),
  unique (funil, whatsapp)
);
alter table public.site_leads enable row level security;
