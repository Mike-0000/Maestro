import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InteractionDiagnostics } from './diagnostics';

let dir: string;
let journal: InteractionDiagnostics;
const id = 'c7925759-d231-4138-b1b8-d0c21cd2713a';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chorus-trace-'));
  journal = new InteractionDiagnostics(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('interaction diagnostics', () => {
  it('correlates and retrieves bounded redacted events; deletes them', async () => {
    await journal.append(
      {
        interactionId: id,
        at: new Date().toISOString(),
        kind: 'stt-final',
        text: 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12345678',
      },
      7
    );
    await journal.append(
      { interactionId: id, at: new Date().toISOString(), kind: 'reply', text: 'Done.' },
      7
    );
    const events = await journal.read({ interactionId: id, limit: 1 }, 7);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('reply');
    expect((await journal.read({ interactionId: id, limit: 10 }, 7))[0]?.text).not.toContain(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12345678'
    );
    expect(await readFile(join(dir, 'interaction-trace.jsonl'), 'utf8')).not.toContain(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12345678'
    );
    await journal.delete();
    expect(await journal.read({ limit: 10 }, 7)).toEqual([]);
  });

  it('filters by interaction ID and timestamp without returning unrelated records', async () => {
    const otherId = crypto.randomUUID();
    await journal.append(
      { interactionId: id, at: '2026-01-01T00:00:00.000Z', kind: 'capture' },
      30
    );
    await journal.append(
      { interactionId: otherId, at: new Date().toISOString(), kind: 'reply', text: 'other' },
      30
    );
    await journal.append(
      { interactionId: id, at: new Date().toISOString(), kind: 'reply', text: 'mine' },
      30
    );
    const events = await journal.read(
      { interactionId: id, since: new Date(Date.now() - 60_000).toISOString(), limit: 200 },
      30
    );
    expect(events.map((event) => event.text)).toEqual(['mine']);
    expect(await journal.read({ before: '2026-01-01T00:00:00.000Z', limit: 10 }, 30)).toEqual([]);
  });

  it('expires old events even without an append and skips corrupt lines', async () => {
    await journal.append({ interactionId: id, at: '2020-01-01T00:00:00.000Z', kind: 'capture' }, 1);
    expect(await journal.read({ limit: 10 }, 1)).toEqual([]);
  });
});
