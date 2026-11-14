-- =====================================================================
-- Recordatorio por Telegram de las lecturas de temperatura no registradas.
-- · 30 minutos después de cada hora de toma (Temperatura → Recordatorios), si la lectura de esa
--   hora todavía no está registrada en la sede, se avisa al grupo de Telegram de la sección
--   "temperatura" de la sede (o a los grupos sin sede).
-- · Lo envía la edge function "recordatorio-temperatura", que pg_cron llama cada 5 minutos.
--   Así funciona aunque el backend (Express) no esté encendido.
-- · temperature_reminders_sent evita repetir el mismo aviso (una vez por sede, día y lectura).
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.temperature_reminders_sent (
  id bigint generated always as identity primary key,
  org_id bigint not null,
  site_id bigint not null,
  record_date date not null,
  shift text not null,
  slot int not null,
  created_at timestamptz not null default now(),
  unique (org_id, site_id, record_date, shift, slot)
);
alter table public.temperature_reminders_sent enable row level security;
revoke all on public.temperature_reminders_sent from anon, authenticated;

-- Clave compartida entre pg_cron y la edge function (guardada en Vault).
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'temp_reminder_cron_secret', 'Clave de pg_cron para recordatorio-temperatura')
where not exists (select 1 from vault.secrets where name = 'temp_reminder_cron_secret');

create or replace function public.temp_reminder_secret_ok(p_secret text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'temp_reminder_cron_secret' and decrypted_secret = p_secret)
$$;
revoke all on function public.temp_reminder_secret_ok(text) from public, anon, authenticated;
grant execute on function public.temp_reminder_secret_ok(text) to service_role;

-- Cada 5 minutos.
select cron.unschedule('recordatorio-temperatura') where exists (select 1 from cron.job where jobname = 'recordatorio-temperatura');
select cron.schedule('recordatorio-temperatura', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://jyiblnjcnnhxjavrhtas.supabase.co/functions/v1/recordatorio-temperatura',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'temp_reminder_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
$$);
