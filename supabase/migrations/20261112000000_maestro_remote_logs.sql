-- Maestro remote logs: where the desktop app sends its conductor logs for later review.
--
-- One table per log type, all the same shape. The app holds only the project's anon key, and
-- that key may insert and nothing else: row level security is on, the only policy is an insert
-- policy, and select, update and delete are revoked. Rows are read in the Supabase dashboard or
-- with the service-role key, which is never put in the app or in this repository.
--
-- Nothing is deleted automatically: rows stay until someone removes them by hand.
--
-- Safe to run more than once.

do $$
declare
  log_table text;
begin
  foreach log_table in array array[
    'maestro_voice_turns',            -- conductor-log.jsonl: the voice conductor's turns
    'maestro_interaction_trace',      -- interaction-trace.jsonl: capture, routing and tool events
    'maestro_chat_conductor_calls',   -- chat-conductor-log.jsonl: every chat and task conductor model call
    'maestro_conductor_threads'       -- task-conductors/*.json and chat-conductors/*.json, entry by entry
  ]
  loop
    execute format($table$
      create table if not exists public.%I (
        id uuid primary key default gen_random_uuid(),
        received_at timestamptz not null default now(),
        install_id text not null,
        app_version text,
        source text not null,
        recorded_at timestamptz,
        record_hash text not null,
        record jsonb not null
      )
    $table$, log_table);

    execute format(
      'create index if not exists %I on public.%I (install_id, recorded_at)',
      log_table || '_install_time_idx', log_table
    );
    execute format(
      'create index if not exists %I on public.%I (record_hash)',
      log_table || '_hash_idx', log_table
    );

    execute format('alter table public.%I enable row level security', log_table);
    execute format('alter table public.%I force row level security', log_table);

    -- Insert only, for the anon key the app carries (and a signed-in user, should one be used).
    execute format('revoke all on public.%I from anon, authenticated', log_table);
    execute format('grant insert on public.%I to anon, authenticated', log_table);

    execute format('drop policy if exists %I on public.%I', log_table || '_insert_only', log_table);
    execute format(
      'create policy %I on public.%I for insert to anon, authenticated with check (true)',
      log_table || '_insert_only', log_table
    );
    -- No select, update or delete policy exists, so those are refused for every key but the
    -- service role, which bypasses row level security.
  end loop;
end
$$;
