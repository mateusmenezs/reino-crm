-- ============================================================
-- REINO CRM v5 — Migrations JÁ APLICADAS no projeto Supabase
-- "REINO CRM" (lcbymyvzhnwcmpdukyqr). Mantido aqui só como registro.
--
-- IMPORTANTE: o banco JÁ tinha as tabelas certas (instagram_accounts,
-- contacts, conversations, messages, kanban_stages, team_members,
-- wa_messages...). NÃO criamos tabelas novas — só corrigimos o acesso.
-- ============================================================

-- 1) Login vira team_member automaticamente
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.team_members (id, email, full_name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          'admin')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- 2) Correção de RLS (as policies originais tinham recursão e travavam tudo)
create or replace function public.is_team_member()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.team_members where id = auth.uid());
$$;

drop policy if exists "team can read team_members" on public.team_members;
create policy "auth read team_members" on public.team_members for select to authenticated using (true);

drop policy if exists "team can manage kanban_stages" on public.kanban_stages;
create policy "team kanban_stages" on public.kanban_stages for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

drop policy if exists "team can manage conversations" on public.conversations;
create policy "team conversations" on public.conversations for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

drop policy if exists "team can manage messages" on public.messages;
create policy "team messages" on public.messages for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

drop policy if exists "team can manage contacts" on public.contacts;
create policy "team contacts" on public.contacts for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

drop policy if exists "team can read instagram_accounts" on public.instagram_accounts;
create policy "team read instagram_accounts" on public.instagram_accounts for select to authenticated using (public.is_team_member());

drop policy if exists "team can view wa_messages" on public.wa_messages;
create policy "team read wa_messages" on public.wa_messages for select to authenticated using (public.is_team_member());

drop policy if exists "team can manage activities" on public.activities;
create policy "team activities" on public.activities for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

-- 3) Contas de acesso criadas: mateus@reinocrm.com e cris@reinocrm.com (senha Reino@2026)
--    (criadas via auth; troque a senha no primeiro acesso recomendado)

-- 4) PENDÊNCIA DE SEGURANÇA (não aplicada — decida você):
--    A tabela public.activity_log está com RLS DESABILITADO (exposta à chave anônima).
--    Se não usa essa tabela publicamente, rode:
--    alter table public.activity_log enable row level security;
--    (e crie policies conforme necessário, senão bloqueia todo acesso)
