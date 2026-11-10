import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_THREAD_LIMITS,
  emptyChatThread,
  type ChatConductorThread,
} from '../api/chat-conductor/thread';
import { ChatConductorThreads, chatThreadFileName } from './chat-conductor-threads';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const ID = '3f2b8c1e-7a4d-4e1b-9c55-0a1b2c3d4e5f';
const at = '2026-11-10T10:00:00.000Z';
const BAD_IDS = [
  '',
  '.',
  '..',
  '../escape',
  '..\\escape',
  'a/b',
  'a\\b',
  'C:evil',
  'name.json',
  'trailing.',
  ' spaced',
  'nul',
  'COM1',
  'a\0b',
  'x'.repeat(200),
];

let dataDir: string;
let threads: ChatConductorThreads;

function thread(id = ID, overrides: Partial<ChatConductorThread> = {}): ChatConductorThread {
  return {
    ...emptyChatThread(id, true),
    entries: [
      { kind: 'developer', id: '1', at, text: 'get the tests green' },
      {
        kind: 'action',
        id: '2',
        at,
        tool: 'send_to_agent',
        summary: 'Sent a prompt',
        status: 'done',
        detail: 'Run pnpm test.',
      },
    ],
    messages: [
      { role: 'user', content: 'get the tests green' },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ],
    notes: 'Goal: tests green.',
    status: { state: 'working', headline: 'Running tests' },
    lastEventKey: 'evt-1',
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'chorus-chat-threads-'));
  threads = new ChatConductorThreads(dataDir, logger);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('chatThreadFileName', () => {
  it('accepts plain ids and refuses anything that is not plainly a file name', () => {
    expect(chatThreadFileName(ID)).toBe(`${ID}.json`);
    expect(chatThreadFileName('conv_1-A')).toBe('conv_1-A.json');
    for (const id of BAD_IDS) expect(chatThreadFileName(id)).toBeNull();
  });
});

describe('ChatConductorThreads', () => {
  it('returns null and an empty list before anything is saved', async () => {
    expect(await threads.read(ID)).toBeNull();
    expect(await threads.list()).toEqual([]);
    await expect(threads.delete(ID)).resolves.toBeUndefined();
  });

  it('round-trips a thread through one file in its own folder', async () => {
    const saved = thread();
    await threads.save(saved);
    expect(readdirSync(join(dataDir, 'chat-conductors'))).toEqual([`${ID}.json`]);
    expect(await threads.read(ID)).toEqual(saved);
    // A second instance (a new app run) reads the same file.
    expect(await new ChatConductorThreads(dataDir, logger).read(ID)).toEqual(saved);
  });

  it('refuses ids that are not file names and writes nothing for them', async () => {
    for (const id of BAD_IDS) {
      expect(await threads.read(id)).toBeNull();
      await expect(threads.delete(id)).resolves.toBeUndefined();
      if (id) await expect(threads.save(thread(id))).rejects.toThrow();
    }
    expect(existsSync(join(dataDir, 'chat-conductors'))).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, '..', 'escape.json'))).toBe(false);
  });

  it('refuses a thread that does not match the schema', async () => {
    await expect(
      threads.save({ ...thread(), version: 2 } as unknown as ChatConductorThread)
    ).rejects.toThrow();
    expect(await threads.read(ID)).toBeNull();
  });

  it('reads a corrupt, mismatched or foreign file as no thread', async () => {
    const dir = join(dataDir, 'chat-conductors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}.json`), '{"version":1,"conversat');
    expect(await threads.read(ID)).toBeNull();
    writeFileSync(join(dir, `${ID}.json`), JSON.stringify({ version: 1, entries: 'nope' }));
    expect(await threads.read(ID)).toBeNull();
    // A file that holds another conversation's thread is not this one's.
    writeFileSync(join(dir, `${ID}.json`), JSON.stringify(thread('other-conversation')));
    expect(await threads.read(ID)).toBeNull();
    // Saving over it recovers.
    await threads.save(thread());
    expect((await threads.read(ID))?.notes).toBe('Goal: tests green.');
  });

  it('bounds what it saves', async () => {
    await threads.save(
      thread(ID, {
        entries: Array.from({ length: CHAT_THREAD_LIMITS.entries + 10 }, (_, index) => ({
          kind: 'event' as const,
          id: String(index),
          at,
          text: `event ${index}`,
        })),
        notes: 'n'.repeat(CHAT_THREAD_LIMITS.notesChars * 2),
      })
    );
    const read = await threads.read(ID);
    expect(read?.entries).toHaveLength(CHAT_THREAD_LIMITS.entries);
    expect(read?.entries.at(-1)?.id).toBe(String(CHAT_THREAD_LIMITS.entries + 9));
    expect(read?.notes).toHaveLength(CHAT_THREAD_LIMITS.notesChars);
  });

  it('redacts secrets and keeps paths, URLs and commands', async () => {
    const key = `sk-ant-${'a1B2'.repeat(8)}`;
    const token = `ghp_${'Z9'.repeat(18)}`;
    await threads.save(
      thread(ID, {
        entries: [
          {
            kind: 'conductor',
            id: '1',
            at,
            text: `Open http://localhost:5173 and edit /home/dev/app/.env (key ${key}).`,
          },
          {
            kind: 'action',
            id: '2',
            at,
            tool: 'send_to_agent',
            summary: `Sent ${token}`,
            status: 'done',
            detail: `export GH=${token}`,
          },
        ],
        messages: [
          { role: 'user', content: `the key is ${key}` },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: `noted ${key}` },
              { type: 'tool_use', id: 't1', name: 'read_chat', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: `output ${token}` },
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: token }] },
            ],
          },
        ],
        notes: `key ${key}`,
        status: { state: 'idle', headline: `token ${token}` },
      })
    );
    const raw = readFileSync(join(dataDir, 'chat-conductors', `${ID}.json`), 'utf8');
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(token);
    expect(raw).toContain('http://localhost:5173');
    expect(raw).toContain('/home/dev/app/.env');
    const read = await threads.read(ID);
    expect(read?.messages).toHaveLength(3);
    expect(JSON.stringify(read?.messages[1])).toContain('"tool_use"');
  });

  it('keeps the last of overlapping saves and leaves no temp file', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => threads.save(thread(ID, { notes: `save ${index}` })))
    );
    expect((await threads.read(ID))?.notes).toBe('save 11');
    expect(readdirSync(join(dataDir, 'chat-conductors'))).toEqual([`${ID}.json`]);
  });

  it('saves without model history when the thread would be too large', async () => {
    const big = 'word '.repeat(200_000);
    await threads.save(
      thread(ID, {
        messages: Array.from({ length: 5 }, () => ({ role: 'user' as const, content: big })),
      })
    );
    const read = await threads.read(ID);
    expect(read?.messages).toEqual([]);
    expect(read?.entries).toHaveLength(2);
    expect(read?.notes).toBe('Goal: tests green.');
  });

  it('lists the conversations with a thread and deletes one', async () => {
    await threads.save(thread('conv-a'));
    await threads.save(thread('conv-b'));
    const dir = join(dataDir, 'chat-conductors');
    writeFileSync(join(dir, 'conv-c.json.tmp'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'bad name.json'), '{}');
    expect((await threads.list()).sort()).toEqual(['conv-a', 'conv-b']);

    await threads.delete('conv-a');
    expect(await threads.read('conv-a')).toBeNull();
    expect(await threads.list()).toEqual(['conv-b']);
    // A save queued before a delete does not come back after it.
    const save = threads.save(thread('conv-b', { notes: 'late' }));
    const removed = threads.delete('conv-b');
    await Promise.all([save, removed]);
    expect(await threads.read('conv-b')).toBeNull();
  });
});
