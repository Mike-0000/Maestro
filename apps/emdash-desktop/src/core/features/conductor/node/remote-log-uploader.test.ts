import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  builtInRemoteLogConfig,
  capRecord,
  REMOTE_LOG_CONFIG_FILE,
  REMOTE_LOG_MAX_RECORD_BYTES,
  REMOTE_LOG_PLACEHOLDER,
  REMOTE_LOG_STATE_FILE,
  redactRecord,
  RemoteLogUploader,
  usableRemoteLogConfig,
  type RemoteLogConfig,
} from './remote-log-uploader';

const PUBLISHABLE = `sb_publishable_${'k'.repeat(30)}`;
const URL = 'https://abcdefghij.supabase.co';

function jwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.${'s'.repeat(43)}`;
}

let dir: string;
let calls: { url: string; headers: Record<string, string>; rows: Record<string, unknown>[] }[];
let respond: () => Response;
let clock: number;
let enabled: boolean;

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({
    url,
    headers: init.headers as Record<string, string>,
    rows: JSON.parse(String(init.body)) as Record<string, unknown>[],
  });
  return respond();
}) as unknown as typeof fetch;

function uploader(builtIn: RemoteLogConfig | null = null): RemoteLogUploader {
  return new RemoteLogUploader({
    dataDir: dir,
    logger,
    enabled: async () => enabled,
    fetch: fakeFetch,
    appVersion: '1.2.6-test',
    builtIn,
    now: () => clock,
  });
}

function configure(config: object = { url: URL, anonKey: PUBLISHABLE }): void {
  writeFileSync(join(dir, REMOTE_LOG_CONFIG_FILE), JSON.stringify(config));
}

function jsonl(file: string, records: object[]): void {
  writeFileSync(join(dir, file), records.map((record) => JSON.stringify(record) + '\n').join(''));
}

function rowsFor(table: string): Record<string, unknown>[] {
  return calls.filter((call) => call.url.endsWith(`/rest/v1/${table}`)).flatMap((c) => c.rows);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chorus-remote-logs-'));
  calls = [];
  respond = () => new Response(null, { status: 201 });
  clock = Date.parse('2026-11-12T12:00:00.000Z');
  enabled = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('usableRemoteLogConfig', () => {
  it('takes a project URL with an anon or publishable key', () => {
    expect(usableRemoteLogConfig({ url: `${URL}/`, anonKey: PUBLISHABLE })).toEqual({
      url: URL,
      anonKey: PUBLISHABLE,
    });
    const anon = jwt({ role: 'anon', ref: 'abcdefghij' });
    expect(usableRemoteLogConfig({ url: URL, anonKey: anon })?.anonKey).toBe(anon);
  });

  it('refuses placeholders, plain http, and every key that can do more than insert', () => {
    expect(usableRemoteLogConfig(REMOTE_LOG_PLACEHOLDER)).toBeNull();
    expect(usableRemoteLogConfig({ url: 'http://abc.supabase.co', anonKey: PUBLISHABLE })).toBe(
      null
    );
    expect(usableRemoteLogConfig({ url: URL, anonKey: `sb_secret_${'k'.repeat(30)}` })).toBe(null);
    expect(usableRemoteLogConfig({ url: URL, anonKey: jwt({ role: 'service_role' }) })).toBe(null);
    expect(usableRemoteLogConfig({ url: URL })).toBeNull();
    expect(usableRemoteLogConfig(null)).toBeNull();
  });
});

describe('redactRecord', () => {
  it('removes secrets named by their key and found by their shape', () => {
    const key = `sk-ant-api03-${'a'.repeat(40)}`;
    const { value, text } = redactRecord({ apiKey: 'hunter2hunter2', note: `use ${key}` });
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(key);
    expect(value).toEqual(JSON.parse(text));
  });

  it('still gives valid JSON when a secret sits right before an escaped quote', () => {
    // As text, the pattern would take the backslash of \" and break the JSON.
    const record = { text: 'export token=abc123"; echo done' };
    const { value, text } = redactRecord(record);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(JSON.stringify(value)).not.toContain('abc123');
    expect(JSON.stringify(value)).toContain('echo done');
  });
});

describe('RemoteLogUploader', () => {
  it('sends nothing until a project is configured and the setting is on', async () => {
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    const up = uploader();
    await up.runOnce();
    expect(calls).toHaveLength(0);
    expect(up.getStatus().configured).toBe(false);

    configure(REMOTE_LOG_PLACEHOLDER);
    await up.runOnce();
    expect(calls).toHaveLength(0);

    configure();
    enabled = false;
    await up.runOnce();
    expect(calls).toHaveLength(0);
    expect(up.getStatus()).toMatchObject({ configured: true, project: 'abcdefghij.supabase.co' });

    enabled = true;
    await up.runOnce();
    expect(calls).toHaveLength(1);
  });

  it('sends every log record and thread entry to its table, in full with secrets removed', async () => {
    configure();
    const key = `sk-ant-api03-${'a'.repeat(40)}`;
    jsonl('conductor-log.jsonl', [
      { at: '2026-11-12T10:00:00.000Z', utterance: `Use the key ${key} and mail ops@example.com` },
    ]);
    jsonl('interaction-trace.jsonl', [
      { interactionId: 'i1', at: '2026-11-12T10:00:01.000Z', kind: 'capture', text: 'hello' },
      { interactionId: 'i1', at: '2026-11-12T10:00:02.000Z', kind: 'reply', text: 'hi' },
    ]);
    jsonl('chat-conductor-log.jsonl', [
      { at: '2026-11-12T10:00:03.000Z', input: 'x'.repeat(50_000), reply: 'Done.' },
    ]);
    mkdirSync(join(dir, 'task-conductors'));
    writeFileSync(
      join(dir, 'task-conductors', 'task-1.json'),
      JSON.stringify({
        version: 2,
        taskId: 'task-1',
        entries: [
          { kind: 'developer', id: 'e1', at: '2026-11-12T10:01:00.000Z', text: 'Fix the login.' },
          { kind: 'conductor', id: 'e2', at: '2026-11-12T10:02:00.000Z', text: 'On it.' },
        ],
        messages: [],
        notes: 'Goal: login works.',
        status: { state: 'working', headline: 'Fixing login' },
        autonomy: true,
        updatedAt: '2026-11-12T10:02:00.000Z',
      })
    );

    const up = uploader();
    await up.runOnce();

    const voice = rowsFor('maestro_voice_turns');
    expect(voice).toHaveLength(1);
    const text = JSON.stringify(voice[0]);
    expect(text).not.toContain(key);
    expect(text).toContain('[REDACTED_ANTHROPIC_KEY]');
    // Only secrets and tokens are removed: the rest of the text is what a review needs.
    expect(text).toContain('ops@example.com');
    expect(voice[0]).toMatchObject({
      app_version: '1.2.6-test',
      source: 'conductor-log.jsonl',
      recorded_at: '2026-11-12T10:00:00.000Z',
    });
    expect(String(voice[0]?.install_id)).toMatch(/^[0-9a-f-]{36}$/);

    expect(rowsFor('maestro_interaction_trace')).toHaveLength(2);
    const [call] = rowsFor('maestro_chat_conductor_calls');
    expect(call).toBeDefined();
    expect((call!.record as { input: string }).input).toHaveLength(50_000);

    const threads = rowsFor('maestro_conductor_threads');
    expect(threads).toHaveLength(3);
    expect(threads.map((row) => row.record)).toEqual([
      {
        threadKind: 'task',
        threadId: 'task-1',
        entry: expect.objectContaining({ text: 'Fix the login.' }),
      },
      {
        threadKind: 'task',
        threadId: 'task-1',
        entry: expect.objectContaining({ text: 'On it.' }),
      },
      {
        threadKind: 'task',
        threadId: 'task-1',
        notes: 'Goal: login works.',
        status: { state: 'working', headline: 'Fixing login' },
        autonomy: true,
      },
    ]);

    // Insert only: a publishable key goes as apikey alone, and no rows are asked back.
    expect(calls[0]?.headers).toMatchObject({ apikey: PUBLISHABLE, Prefer: 'return=minimal' });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(up.getStatus()).toMatchObject({ uploaded: 7, lastError: null });
  });

  it('sends a legacy anon key as the bearer too', async () => {
    const anon = jwt({ role: 'anon' });
    configure({ url: URL, anonKey: anon });
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    await uploader().runOnce();
    expect(calls[0]?.headers).toMatchObject({ apikey: anon, Authorization: `Bearer ${anon}` });
  });

  it('never sends a record twice, across passes and restarts', async () => {
    configure();
    const first = { at: '2026-11-12T10:00:00.000Z', utterance: 'one' };
    jsonl('conductor-log.jsonl', [first]);
    const up = uploader();
    await up.runOnce();
    await up.runOnce();
    expect(rowsFor('maestro_voice_turns')).toHaveLength(1);

    // The local log is rewritten with a new record: only that one goes.
    const second = { at: '2026-11-12T10:05:00.000Z', utterance: 'two' };
    jsonl('conductor-log.jsonl', [first, second]);
    await up.runOnce();
    expect(rowsFor('maestro_voice_turns').map((row) => row.record)).toEqual([first, second]);

    // A new app run reads what was sent from disk.
    const installId = rowsFor('maestro_voice_turns')[0]?.install_id;
    calls = [];
    await uploader().runOnce();
    expect(calls).toHaveLength(0);
    const third = { at: '2026-11-12T10:10:00.000Z', utterance: 'three' };
    jsonl('conductor-log.jsonl', [first, second, third]);
    await uploader().runOnce();
    expect(rowsFor('maestro_voice_turns')).toEqual([
      expect.objectContaining({ install_id: installId, record: third }),
    ]);
  });

  it('forgets records once they leave the local file, so its state stays small', async () => {
    configure();
    const old = { at: '2026-11-01T10:00:00.000Z', utterance: 'old' };
    const kept = { at: '2026-11-12T10:00:00.000Z', utterance: 'kept' };
    jsonl('conductor-log.jsonl', [old, kept]);
    await uploader().runOnce();
    const state = () =>
      JSON.parse(readFileSync(join(dir, REMOTE_LOG_STATE_FILE), 'utf8')) as {
        sent: Record<string, string[]>;
      };
    expect(state().sent['conductor-log.jsonl']).toHaveLength(2);

    jsonl('conductor-log.jsonl', [kept]);
    await uploader().runOnce();
    expect(state().sent['conductor-log.jsonl']).toHaveLength(1);
    rmSync(join(dir, 'conductor-log.jsonl'));
    await uploader().runOnce();
    expect(state().sent['conductor-log.jsonl']).toBeUndefined();
  });

  it('retries a failed upload later with a growing wait, and never throws', async () => {
    configure();
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    respond = () => new Response('{"message":"permission denied"}', { status: 401 });
    const up = uploader();
    await expect(up.runOnce()).resolves.toBeUndefined();
    expect(up.getStatus().lastError).toContain('HTTP 401');
    expect(calls).toHaveLength(1);

    // Within the wait, nothing is tried.
    await up.runOnce();
    expect(calls).toHaveLength(1);

    clock += 61_000;
    await up.runOnce();
    expect(calls).toHaveLength(2);
    // The second failure waits twice as long.
    clock += 61_000;
    await up.runOnce();
    expect(calls).toHaveLength(2);

    respond = () => new Response(null, { status: 201 });
    clock += 70_000;
    await up.runOnce();
    expect(calls).toHaveLength(3);
    expect(up.getStatus()).toMatchObject({ lastError: null, uploaded: 1 });
    // What failed was never marked sent, so it went once it worked, and only once.
    await up.runOnce();
    expect(calls).toHaveLength(3);
  });

  it('uploads on a fresh install with no config file, to the project built into the app', async () => {
    const builtIn = { url: 'https://builtinproject.supabase.co', anonKey: PUBLISHABLE };
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    const up = uploader(builtIn);
    await up.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://builtinproject.supabase.co/rest/v1/maestro_voice_turns');
    expect(calls[0]?.headers.apikey).toBe(PUBLISHABLE);
    expect(up.getStatus()).toMatchObject({
      configured: true,
      source: 'built-in',
      project: 'builtinproject.supabase.co',
    });
  });

  it('lets remote-logs.json override the built-in project, and falls back when it is a placeholder', async () => {
    const builtIn = { url: 'https://builtinproject.supabase.co', anonKey: PUBLISHABLE };
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    configure();
    const up = uploader(builtIn);
    await up.runOnce();
    expect(calls[0]?.url).toBe(`${URL}/rest/v1/maestro_voice_turns`);
    expect(up.getStatus()).toMatchObject({ source: 'file', project: 'abcdefghij.supabase.co' });

    configure(REMOTE_LOG_PLACEHOLDER);
    expect(await up.currentStatus()).toMatchObject({
      source: 'built-in',
      project: 'builtinproject.supabase.co',
    });
  });

  it('reads a config file saved with a byte-order mark', async () => {
    writeFileSync(
      join(dir, REMOTE_LOG_CONFIG_FILE),
      `\uFEFF${JSON.stringify({ url: URL, anonKey: PUBLISHABLE })}`
    );
    expect(await uploader().currentStatus()).toMatchObject({ configured: true, source: 'file' });
  });

  it('has no built-in project in a build the push script did not configure', () => {
    expect(builtInRemoteLogConfig()).toBeNull();
  });

  it('sends a record too large for one row as a marked start, once', async () => {
    configure();
    const huge = { at: '2026-11-12T10:00:00.000Z', input: 'x'.repeat(300_000) };
    jsonl('chat-conductor-log.jsonl', [huge, { at: '2026-11-12T10:01:00.000Z', input: 'small' }]);
    const up = uploader();
    await up.runOnce();
    const rows = rowsFor('maestro_chat_conductor_calls');
    expect(rows).toHaveLength(2);
    const stub = rows[0]?.record as { oversized: boolean; bytes: number; head: string };
    expect(stub.oversized).toBe(true);
    expect(stub.bytes).toBeGreaterThan(300_000);
    expect(stub.head.startsWith('{"at":"2026-11-12T10:00:00.000Z"')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rows[0]?.record))).toBeLessThanOrEqual(
      REMOTE_LOG_MAX_RECORD_BYTES
    );
    expect(rows[1]?.record).toEqual({ at: '2026-11-12T10:01:00.000Z', input: 'small' });
    await up.runOnce();
    expect(rowsFor('maestro_chat_conductor_calls')).toHaveLength(2);
  });

  it('keeps a stub under the cap even when its start is all quotes and multi-byte text', () => {
    for (const filler of ['"'.repeat(400_000), '\u00e9\u4e2d'.repeat(150_000)]) {
      const capped = capRecord(redactRecord({ text: filler }));
      expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(REMOTE_LOG_MAX_RECORD_BYTES);
      expect(capped.value).toMatchObject({ oversized: true });
    }
    const small = redactRecord({ text: 'fine' });
    expect(capRecord(small)).toBe(small);
  });

  it('survives a network error and a timeout', async () => {
    configure();
    jsonl('conductor-log.jsonl', [{ at: '2026-11-12T10:00:00.000Z', utterance: 'go' }]);
    const up = new RemoteLogUploader({
      dataDir: dir,
      logger,
      enabled: async () => true,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      appVersion: null,
      now: () => clock,
    });
    await expect(up.runOnce()).resolves.toBeUndefined();
    expect(up.getStatus().lastError).toBe('fetch failed');
  });

  it('sends a large backlog in batches', async () => {
    configure();
    jsonl(
      'interaction-trace.jsonl',
      Array.from({ length: 450 }, (_, index) => ({
        interactionId: `i${index}`,
        at: '2026-11-12T10:00:00.000Z',
        kind: 'capture',
      }))
    );
    await uploader().runOnce();
    expect(calls.map((call) => call.rows.length)).toEqual([200, 200, 50]);
  });

  it('starts on a timer that does not keep the app open, and stops cleanly', () => {
    vi.useFakeTimers();
    try {
      const up = uploader();
      const run = vi.spyOn(up, 'runOnce');
      up.start();
      vi.advanceTimersByTime(10_000);
      expect(run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(run).toHaveBeenCalledTimes(2);
      up.dispose();
      vi.advanceTimersByTime(120_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
