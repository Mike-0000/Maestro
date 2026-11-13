import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets, type Logger } from '@emdash/shared/logger';
import { app } from 'electron';
import { z } from 'zod';
import type { RemoteLogStatus } from '../api/contract';

/**
 * Sends the conductor's local logs to the developer's own Supabase project, so they can be
 * reviewed from another computer. It uploads what is already on disk: the voice conductor's turns,
 * the interaction trace, every chat and task conductor model call, and the conductor threads the
 * developer reads. Full text goes up, with secrets and tokens redacted once more on the way out.
 *
 * Nothing leaves the computer unless the setting is on and a project is known: the one named in
 * `remote-logs.json` in the data folder, or else the one built into the app (the push script sets
 * `MAIN_VITE_REMOTE_LOGS_URL` and `MAIN_VITE_REMOTE_LOGS_KEY` from a file outside the repository,
 * so neither is ever committed). Its anon (publishable) key may only insert (see the migrations in
 * `supabase/migrations`), so the app can never read back what it or anyone else sent. A secret or
 * service-role key is refused, wherever it comes from.
 *
 * The local log files are rewritten on every append (old records are dropped by age and size), so
 * a byte offset would point at a different record later. What was sent is tracked per record
 * instead, by a hash of its content, kept for as long as the record is still in its file. A record
 * is sent again only when the app stops between a successful upload and saving that state.
 *
 * It runs on a timer in the background: a file that has not changed since everything in it was
 * sent is not read again, every failure is caught and retried later with a growing delay, and
 * nothing it does is awaited by the rest of the app.
 */

export const REMOTE_LOG_CONFIG_FILE = 'remote-logs.json';
export const REMOTE_LOG_STATE_FILE = 'remote-logs-state.json';

/** What the developer pastes their project's values over. */
export const REMOTE_LOG_PLACEHOLDER = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY',
} as const;

const INTERVAL_MS = 60_000;
const FIRST_RUN_MS = 10_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Rows and bytes one request carries. */
const BATCH_ROWS = 200;
const BATCH_BYTES = 1_000_000;

/** The JSONL logs, each with the table its records go to. */
export const REMOTE_LOG_JSONL_SOURCES = [
  { file: 'conductor-log.jsonl', table: 'maestro_voice_turns' },
  { file: 'interaction-trace.jsonl', table: 'maestro_interaction_trace' },
  { file: 'chat-conductor-log.jsonl', table: 'maestro_chat_conductor_calls' },
] as const;
/** The folders of conductor threads: one JSON file per task, or per chat for the older kind. */
const THREAD_SOURCES = [
  { dir: 'task-conductors', kind: 'task' },
  { dir: 'chat-conductors', kind: 'chat' },
] as const;
export const REMOTE_LOG_THREADS_TABLE = 'maestro_conductor_threads';
/** A thread file larger than this is skipped, as the thread store itself does. */
const MAX_THREAD_BYTES = 4 * 1024 * 1024;
/**
 * The most one row's record may hold as JSON. The tables refuse rows over 256 KiB (see the
 * row-limit migration); this stays well under it, since Postgres prints jsonb with extra spaces.
 * A larger record is sent as its start, marked, rather than refused again on every pass.
 */
export const REMOTE_LOG_MAX_RECORD_BYTES = 200_000;

const configSchema = z.object({ url: z.string(), anonKey: z.string() });
export type RemoteLogConfig = z.infer<typeof configSchema>;

const stateSchema = z.object({
  installId: z.string().min(1),
  /** Per source, the hashes of its records that were sent and are still on disk. */
  sent: z.record(z.string(), z.array(z.string())),
});

type Row = {
  install_id: string;
  app_version: string | null;
  source: string;
  recorded_at: string | null;
  record_hash: string;
  record: unknown;
};

type Pending = { table: string; source: string; hash: string; row: Row; bytes: number };

export type RemoteLogUploaderOptions = {
  dataDir: string;
  logger: Logger;
  /** Whether the developer has the setting on. */
  enabled: () => Promise<boolean>;
  fetch?: typeof fetch;
  /** Overrides reading Electron's app version (tests). */
  appVersion?: string | null;
  /** Overrides the project built into the app (tests). */
  builtIn?: RemoteLogConfig | null;
  now?: () => number;
};

/** The project built into this build of the app, if the push script gave it one. */
export function builtInRemoteLogConfig(): RemoteLogConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  return usableRemoteLogConfig({
    url: env.MAIN_VITE_REMOTE_LOGS_URL ?? '',
    anonKey: env.MAIN_VITE_REMOTE_LOGS_KEY ?? '',
  });
}

function jwtRole(key: string): string | null {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role?: unknown;
    };
    return typeof decoded.role === 'string' ? decoded.role : null;
  } catch {
    return null;
  }
}

/**
 * A usable project address and key, or null. Placeholders, plain http, and any key that can do
 * more than insert (a secret key, the service-role key) are refused: those never belong in the app.
 */
export function usableRemoteLogConfig(raw: unknown): RemoteLogConfig | null {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return null;
  const url = parsed.data.url.trim().replace(/\/+$/, '');
  const anonKey = parsed.data.anonKey.trim();
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url) || /YOUR-PROJECT/i.test(url)) return null;
  if (anonKey.length < 20 || /YOUR-ANON/i.test(anonKey)) return null;
  if (anonKey.startsWith('sb_secret_')) return null;
  if (anonKey.startsWith('eyJ') && jwtRole(anonKey) !== 'anon') return null;
  return { url, anonKey };
}

/** Every string in a value, redacted one by one. */
function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item)])
    );
  }
  return value;
}

/**
 * A record with its secrets and tokens removed, and its JSON text. The whole text is redacted
 * first, so a secret named by its key ("apiKey": …) is caught; when that leaves text that is no
 * longer JSON (a pattern took the backslash of an escaped quote), each string is redacted alone.
 */
export function redactRecord(record: unknown): { value: unknown; text: string } {
  const text = redactSecrets(JSON.stringify(record) ?? 'null');
  try {
    return { value: JSON.parse(text) as unknown, text };
  } catch {
    const value = redactStrings(record);
    return { value, text: JSON.stringify(value) ?? 'null' };
  }
}

/** How much of an oversized record is kept: its JSON escaped again stays under the cap. */
const OVERSIZED_HEAD_BYTES = 90_000;

/**
 * A record whose JSON is over `REMOTE_LOG_MAX_RECORD_BYTES` becomes a marked stub with the start of
 * its JSON, so the row fits the table's limit; any other record is returned as it is.
 */
export function capRecord(redacted: { value: unknown; text: string }): {
  value: unknown;
  text: string;
} {
  const bytes = Buffer.byteLength(redacted.text);
  if (bytes <= REMOTE_LOG_MAX_RECORD_BYTES) return redacted;
  const value = {
    oversized: true,
    bytes,
    head: Buffer.from(redacted.text).subarray(0, OVERSIZED_HEAD_BYTES).toString('utf8'),
  };
  return { value, text: JSON.stringify(value) };
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function timeOf(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function yieldToApp(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The app's version; null outside Electron (node tests stub `app` as undefined). */
function electronAppVersion(): string | null {
  try {
    return (app as typeof app | undefined)?.getVersion?.() ?? null;
  } catch {
    return null;
  }
}

/** What one pass found in one source. */
type SourceScan = { signature: string; hashes: Set<string> };

export class RemoteLogUploader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private notBefore = 0;
  private installId: string | null = null;
  private sent = new Map<string, Set<string>>();
  /** Per source, the signature (size and time) at which everything in it was sent. */
  private clean = new Map<string, string>();
  private version: string | null | undefined;
  private status: RemoteLogStatus;

  constructor(private readonly options: RemoteLogUploaderOptions) {
    this.status = {
      configured: false,
      configPath: join(options.dataDir, REMOTE_LOG_CONFIG_FILE),
      source: null,
      project: null,
      lastUploadAt: null,
      lastError: null,
      uploaded: 0,
    };
    this.version = options.appVersion;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.runOnce();
    this.timer = setInterval(tick, INTERVAL_MS);
    // Never keeps the app alive, and never delays its start.
    this.timer.unref?.();
    this.firstRun = setTimeout(tick, FIRST_RUN_MS);
    this.firstRun.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstRun) clearTimeout(this.firstRun);
    this.timer = null;
    this.firstRun = null;
  }

  getStatus(): RemoteLogStatus {
    return { ...this.status };
  }

  /** The status with the config file read again, so a value just pasted in shows at once. */
  async currentStatus(): Promise<RemoteLogStatus> {
    await this.config();
    return this.getStatus();
  }

  /** Runs a pass now, past any wait after failures (the developer just turned it on). */
  retryNow(): Promise<void> {
    this.notBefore = 0;
    return this.runOnce();
  }

  /** One pass over the logs. Never throws; a pass already running is joined, not doubled. */
  runOnce(): Promise<void> {
    this.running ??= this.pass()
      .catch((error: unknown) => {
        this.failed(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private failed(message: string): void {
    this.failures++;
    this.notBefore = this.now() + Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** (this.failures - 1));
    // The message may quote the server's answer: redacted like any log line.
    this.status = { ...this.status, lastError: redactSecrets(message).slice(0, 300) };
    this.options.logger.warn('conductor: remote log upload failed', {
      error: this.status.lastError,
      failures: this.failures,
    });
  }

  /** The project in `remote-logs.json` when it names a usable one, else the built-in one. */
  private async config(): Promise<RemoteLogConfig | null> {
    let fromFile: RemoteLogConfig | null = null;
    try {
      // A file saved by Windows PowerShell starts with a byte-order mark, which JSON refuses.
      const raw = (await readFile(this.status.configPath, 'utf8')).replace(/^﻿/, '');
      fromFile = usableRemoteLogConfig(JSON.parse(raw) as unknown);
    } catch {
      fromFile = null;
    }
    const builtIn =
      this.options.builtIn === undefined ? builtInRemoteLogConfig() : this.options.builtIn;
    const config = fromFile ?? builtIn;
    this.status = {
      ...this.status,
      configured: config !== null,
      source: fromFile ? 'file' : config ? 'built-in' : null,
      project: config ? new URL(config.url).host : null,
    };
    return config;
  }

  private async loadState(): Promise<string> {
    if (this.installId) return this.installId;
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(this.options.dataDir, REMOTE_LOG_STATE_FILE), 'utf8')
      );
      const state = stateSchema.parse(raw);
      this.sent = new Map(Object.entries(state.sent).map(([key, list]) => [key, new Set(list)]));
      this.installId = state.installId;
    } catch {
      this.sent = new Map();
      this.installId = randomUUID();
    }
    return this.installId;
  }

  private async saveState(): Promise<void> {
    if (!this.installId) return;
    const state = {
      installId: this.installId,
      sent: Object.fromEntries([...this.sent].map(([key, set]) => [key, [...set]])),
    };
    await mkdir(this.options.dataDir, { recursive: true });
    const path = join(this.options.dataDir, REMOTE_LOG_STATE_FILE);
    await writeFile(path + '.tmp', JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(path + '.tmp', path);
  }

  private async pass(): Promise<void> {
    const config = await this.config();
    if (!config || !(await this.options.enabled())) return;
    if (this.now() < this.notBefore) return;
    if (this.version === undefined) this.version = electronAppVersion();

    const installId = await this.loadState();
    const { pending, scanned, existing } = await this.collect(installId);

    // Forget records that left their file, and files that are gone: the state stays bounded.
    let changed = false;
    for (const [source, sent] of this.sent) {
      if (!existing.has(source)) {
        this.sent.delete(source);
        this.clean.delete(source);
        changed = true;
        continue;
      }
      const scan = scanned.get(source);
      if (!scan) continue;
      for (const hash of sent) {
        if (!scan.hashes.has(hash)) {
          sent.delete(hash);
          changed = true;
        }
      }
    }

    const byTable = new Map<string, Pending[]>();
    for (const item of pending) {
      const list = byTable.get(item.table) ?? [];
      list.push(item);
      byTable.set(item.table, list);
    }
    try {
      for (const [table, items] of byTable) {
        for (let start = 0; start < items.length; ) {
          let end = start;
          let bytes = 0;
          while (
            end < items.length &&
            end - start < BATCH_ROWS &&
            (end === start || bytes + (items[end]?.bytes ?? 0) <= BATCH_BYTES)
          ) {
            bytes += items[end]?.bytes ?? 0;
            end++;
          }
          const batch = items.slice(start, end);
          await this.send(config, table, batch);
          for (const item of batch) {
            const sent = this.sent.get(item.source) ?? new Set<string>();
            sent.add(item.hash);
            this.sent.set(item.source, sent);
          }
          // Saved after every batch: a later failure never sends these again.
          await this.saveState();
          changed = false;
          this.status = {
            ...this.status,
            uploaded: this.status.uploaded + batch.length,
            lastUploadAt: new Date(this.now()).toISOString(),
            lastError: null,
          };
          start = end;
          await yieldToApp();
        }
      }
    } finally {
      if (changed) await this.saveState().catch(() => {});
    }
    // Everything read this pass is now sent: skip those files until they change.
    for (const [source, scan] of scanned) this.clean.set(source, scan.signature);
    this.failures = 0;
    this.notBefore = 0;
    this.status = { ...this.status, lastError: null };
  }

  private async send(config: RemoteLogConfig, table: string, batch: Pending[]): Promise<void> {
    const request = this.options.fetch ?? fetch;
    const headers: Record<string, string> = {
      apikey: config.anonKey,
      'Content-Type': 'application/json',
      // The key cannot read rows, so the insert must not ask for them back.
      Prefer: 'return=minimal',
    };
    // A legacy anon key is a JWT and also goes as the bearer; a publishable key goes only as apikey.
    if (config.anonKey.startsWith('eyJ')) headers.Authorization = `Bearer ${config.anonKey}`;
    const response = await request(`${config.url}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch.map((item) => item.row)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${table}: HTTP ${response.status} ${body.slice(0, 200)}`.trim());
    }
  }

  /** The signature of a file now, or null when it is not there. */
  private async signature(path: string): Promise<string | null> {
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? `${info.size}:${info.mtimeMs}` : null;
  }

  /** Every record on disk that was not sent yet, oldest first, and what each source holds now. */
  private async collect(installId: string): Promise<{
    pending: Pending[];
    scanned: Map<string, SourceScan>;
    existing: Set<string>;
  }> {
    const pending: Pending[] = [];
    const scanned = new Map<string, SourceScan>();
    const existing = new Set<string>();

    const add = (
      scan: SourceScan,
      table: string,
      source: string,
      record: unknown,
      recordedAt: string | null
    ) => {
      // Secrets and tokens only: the text itself is what a review needs.
      const { value, text } = capRecord(redactRecord(record));
      const hash = hashOf(text);
      if (scan.hashes.has(hash)) return;
      scan.hashes.add(hash);
      if (this.sent.get(source)?.has(hash)) return;
      pending.push({
        table,
        source,
        hash,
        bytes: text.length + 200,
        row: {
          install_id: installId,
          app_version: this.version ?? null,
          source,
          recorded_at: recordedAt,
          record_hash: hash,
          record: value,
        },
      });
    };

    /** Reads a source unless it is unchanged since all of it was sent. */
    const open = async (source: string, path: string, maxBytes = Infinity) => {
      const signature = await this.signature(path);
      if (signature === null) return null;
      existing.add(source);
      if (this.clean.get(source) === signature) return null;
      const raw = await readFile(path, 'utf8').catch(() => '');
      if (raw.length > maxBytes) return null;
      const scan: SourceScan = { signature, hashes: new Set() };
      scanned.set(source, scan);
      return { raw, scan };
    };

    for (const { file, table } of REMOTE_LOG_JSONL_SOURCES) {
      const opened = await open(file, join(this.options.dataDir, file));
      if (!opened) continue;
      for (const line of opened.raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { at?: unknown };
          add(opened.scan, table, file, record, timeOf(record.at));
        } catch {
          // A torn line is not a record.
        }
      }
      await yieldToApp();
    }

    for (const { dir, kind } of THREAD_SOURCES) {
      const names = await readdir(join(this.options.dataDir, dir)).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const source = `${dir}/${name}`;
        const opened = await open(source, join(this.options.dataDir, dir, name), MAX_THREAD_BYTES);
        if (!opened) continue;
        let thread: {
          entries?: unknown;
          notes?: unknown;
          status?: unknown;
          autonomy?: unknown;
          yolo?: unknown;
          updatedAt?: unknown;
        };
        try {
          thread = JSON.parse(opened.raw) as typeof thread;
        } catch {
          continue;
        }
        const threadId = name.slice(0, -'.json'.length);
        // The thread as the developer read it, entry by entry; its model history is in the
        // chat conductor call log.
        for (const entry of Array.isArray(thread.entries) ? (thread.entries as unknown[]) : []) {
          add(
            opened.scan,
            REMOTE_LOG_THREADS_TABLE,
            source,
            { threadKind: kind, threadId, entry },
            timeOf((entry as { at?: unknown } | null)?.at)
          );
        }
        // Notes and status are rewritten in place: each new version is one more record.
        add(
          opened.scan,
          REMOTE_LOG_THREADS_TABLE,
          source,
          {
            threadKind: kind,
            threadId,
            notes: thread.notes ?? '',
            status: thread.status ?? null,
            autonomy: thread.autonomy ?? null,
            // Only where saved (a task conductor in YOLO mode): other headers stay as sent.
            ...(typeof thread.yolo === 'boolean' ? { yolo: thread.yolo } : {}),
          },
          timeOf(thread.updatedAt)
        );
        await yieldToApp();
      }
    }
    return { pending, scanned, existing };
  }
}
