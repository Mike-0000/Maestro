# Remote conductor logs

Maestro can send the conductor's logs from this computer to the developer's own Supabase project,
so they can be reviewed later from anywhere. The uploader is
`apps/emdash-desktop/src/core/features/conductor/node/remote-log-uploader.ts`; the database schema
is `supabase/migrations/20261112000000_maestro_remote_logs.sql`.

## What is sent

Everything below is sent in full. The only thing removed first is secrets and tokens (API keys,
bearer tokens, passwords, private keys, JWTs), by `redactSecrets` from `@emdash/shared/logger`.

| Local file (in the Maestro data folder) | Table | What it holds |
|---|---|---|
| `conductor-log.jsonl` | `maestro_voice_turns` | The voice conductor's turns: what was said, the reply, the actions with their inputs and outcomes. |
| `interaction-trace.jsonl` | `maestro_interaction_trace` | Capture, routing, tool and reply events of each voice interaction. |
| `chat-conductor-log.jsonl` | `maestro_chat_conductor_calls` | Every task conductor model call: its input (the developer's words or the chat event with agent output), tool results, tool calls with their inputs, and the reply. |
| `task-conductors/*.json`, `chat-conductors/*.json` | `maestro_conductor_threads` | The conductor threads entry by entry (developer messages, conductor messages, actions, events, reports), and each new version of the notes and status. |

The three JSONL files are written only while **Keep a voice history** is on. The threads are
always on disk. Local files keep their own limits (`diagnosticDays`, up to 30 days, and a size cap
per file). The uploader runs every minute, so records go up long before they age out locally.

Every row carries `install_id` (a random id for this install), `app_version`, `source` (the file it
came from), `recorded_at`, `record_hash` and `record` (the record as JSON).

## Retention

None. Rows are never deleted automatically, and turning the setting off does not delete them.
Delete them by hand in the Supabase dashboard when they are no longer wanted.

## Keys and access

- The app holds only the project's **anon** or **publishable** key. It is built into each
  installer by the push script from `%LOCALAPPDATA%\Chorus\ReleaseConfig\remote-logs.json` on the
  release machine (as `MAIN_VITE_REMOTE_LOGS_URL` and `MAIN_VITE_REMOTE_LOGS_KEY`, main process
  only). Neither value is ever in the repository.
- A `remote-logs.json` in a computer's data folder (`%APPDATA%\chorus\chorus\`) overrides the
  built-in project on that computer; a placeholder or broken file is ignored.
- Row level security is on for every table, with one policy: insert. Select, update and delete are
  revoked from `anon` and `authenticated`, so the app's key can add rows and can never read them.
- Anyone who pulls the key out of an installer can add rows, but nothing more. Each row is limited
  to 256 KiB of record and short identifying fields
  (`supabase/migrations/20261112010000_maestro_remote_logs_row_limit.sql`); the app sends a record
  over 200 KB as a marked stub with its start, so a real record is never refused. If the key is
  ever abused, rotate it in Supabase, update the release file, and push.
- The app and the push script both refuse a `sb_secret_…` key or a JWT whose role is not `anon`:
  the service-role key never goes in the app.
- Read the rows in the Supabase dashboard (Table Editor or SQL Editor), or with the service-role
  key from a script on your own machine. Keep that key out of this repository.

## Setting it up

1. Create a free project at <https://supabase.com/dashboard>.
2. In that project, open **SQL Editor** and run, in order, the files in `supabase/migrations/`.
   They are safe to run again.
3. In **Project Settings → API**, copy the **Project URL** and the **anon public** (or
   **publishable**) key.
4. On the machine that runs `/push`, save them as
   `%LOCALAPPDATA%\Chorus\ReleaseConfig\remote-logs.json`:

   ```json
   {
     "url": "https://YOUR-PROJECT-REF.supabase.co",
     "anonKey": "YOUR-ANON-OR-PUBLISHABLE-KEY"
   }
   ```

Every installer pushed after that sends logs with no step on the computer that runs it. To point
one computer elsewhere, put the same kind of file at `%APPDATA%\chorus\chorus\remote-logs.json`;
Maestro reads it on its next pass, within a minute. **Settings → Voice & Conductor →
Troubleshooting** shows where the logs go (and whether the project is built in), the last upload,
and any error.

## How the upload works

- The local logs are rewritten on every append (old records are dropped), so a byte offset would
  not stay valid. Instead each record's content hash is kept in `remote-logs-state.json` once it is
  sent, for as long as the record is still in its file. A record is sent again only if Maestro
  stops between a successful upload and saving that state; `record_hash` tells such duplicates
  apart.
- Rows go in batches of up to 200 rows or about 1 MB per request. State is saved after every batch.
- A failure (network, timeout, HTTP error) is logged, shown in Settings, and retried after 1, 2, 4,
  … minutes, up to 30. Nothing waits on it: it runs on an unreferenced timer in the main process,
  and a file that has not changed since all of it was sent is not read again.
