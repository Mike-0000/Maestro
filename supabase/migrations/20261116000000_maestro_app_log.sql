-- Maestro remote logs: the main process log.
--
-- The warnings and errors of the desktop app's main process and its workers (startup, project
-- attachment, connection, auth, network and update failures), taken from emdash.log. The app
-- reduces each line before sending it: output, prompts, text and secret-named fields are dropped,
-- and secrets, tokens, the upload key, emails, IP addresses and user names are redacted.
--
-- Same shape, access and limits as the other remote log tables: insert-only for the anon key the
-- app carries, rows read only with the service role.
--
-- Safe to run more than once.

create table if not exists public.maestro_app_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  install_id text not null,
  app_version text,
  source text not null,
  recorded_at timestamptz,
  record_hash text not null,
  record jsonb not null
);

create index if not exists maestro_app_log_install_time_idx
  on public.maestro_app_log (install_id, recorded_at);
create index if not exists maestro_app_log_hash_idx on public.maestro_app_log (record_hash);

alter table public.maestro_app_log enable row level security;
alter table public.maestro_app_log force row level security;

revoke all on public.maestro_app_log from anon, authenticated;
grant insert on public.maestro_app_log to anon, authenticated;

drop policy if exists maestro_app_log_insert_only on public.maestro_app_log;
create policy maestro_app_log_insert_only on public.maestro_app_log
  for insert to anon, authenticated with check (true);

alter table public.maestro_app_log drop constraint if exists maestro_app_log_record_size;
alter table public.maestro_app_log
  add constraint maestro_app_log_record_size check (octet_length(record::text) <= 262144);
alter table public.maestro_app_log drop constraint if exists maestro_app_log_field_size;
alter table public.maestro_app_log
  add constraint maestro_app_log_field_size check (
    octet_length(install_id) <= 64
    and octet_length(coalesce(app_version, '')) <= 64
    and octet_length(source) <= 512
    and octet_length(record_hash) <= 64
  );
