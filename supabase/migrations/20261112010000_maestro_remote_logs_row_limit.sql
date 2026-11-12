-- Maestro remote logs: a size limit on each row.
--
-- The app's key is built into every installer, so anyone who pulls it out can insert rows. They
-- still cannot read, change or delete any, and this limit keeps one row from being large enough
-- to fill the project's free storage. 256 KiB is far above any real record (the largest so far
-- is under 10 KB); the app itself sends a marked stub for any record over 200 KB, so a real
-- record is never refused here.
--
-- Safe to run more than once.

do $$
declare
  log_table text;
begin
  foreach log_table in array array[
    'maestro_voice_turns',
    'maestro_interaction_trace',
    'maestro_chat_conductor_calls',
    'maestro_conductor_threads'
  ]
  loop
    execute format(
      'alter table public.%I drop constraint if exists %I',
      log_table, log_table || '_record_size'
    );
    execute format(
      'alter table public.%I add constraint %I check (octet_length(record::text) <= 262144)',
      log_table, log_table || '_record_size'
    );
    -- The other text columns are short by nature; cap them too, so a row cannot hide its bulk there.
    execute format(
      'alter table public.%I drop constraint if exists %I',
      log_table, log_table || '_field_size'
    );
    execute format(
      'alter table public.%I add constraint %I check (octet_length(install_id) <= 64 and octet_length(coalesce(app_version, '''')) <= 64 and octet_length(source) <= 512 and octet_length(record_hash) <= 64)',
      log_table, log_table || '_field_size'
    );
  end loop;
end
$$;
