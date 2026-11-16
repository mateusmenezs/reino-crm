-- Agenda Reino → CAPI "Schedule" (16/11/2026). Ver supabase/functions/agenda.
alter table public.agenda_reservas add column if not exists capi jsonb;
update public.agenda_config
   set config = jsonb_set(config, '{capi_pixels}', '["1275620937717354"]'::jsonb, true)
 where id = 1;
