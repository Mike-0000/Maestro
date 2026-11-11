import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { redactSecrets, type Logger } from '@emdash/shared/logger';
import type { z } from 'zod';
import {
  boundThread,
  chatConductorThreadSchema,
  conductorTaskThreadSchema,
  type ChatConductorEntry,
  type ChatConductorThread,
  type ConductorTaskThread,
} from '../api/chat-conductor/thread';

/** Version 1: one thread per conversation, kept only to be adopted by its task's thread. */
const THREADS_DIR = 'chat-conductors';
/** One thread per task. */
const TASK_THREADS_DIR = 'task-conductors';
const EXTENSION = '.json';
/** A thread file larger than this is not read, and a thread that would be is saved without history. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Conversation ids are UUIDs today. Anything that is not plainly a file name is refused instead of
 * escaped: no separators, no dots (so no `..`, no extension tricks, no trailing dot), no drive
 * colon, nothing a shell or Windows treats specially.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Device names Windows resolves whatever the extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/** The file name a conversation's thread is stored under, or null when the id cannot be one. */
export function chatThreadFileName(conversationId: string): string | null {
  if (!SAFE_ID.test(conversationId) || WINDOWS_DEVICE.test(conversationId)) return null;
  return conversationId + EXTENSION;
}

type Message = Anthropic.Beta.BetaMessageParam;

function redactEntry(entry: ChatConductorEntry): ChatConductorEntry {
  if (entry.kind !== 'action') return { ...entry, text: redactSecrets(entry.text) };
  return {
    ...entry,
    summary: redactSecrets(entry.summary),
    ...(entry.detail === undefined ? {} : { detail: redactSecrets(entry.detail) }),
  };
}

/**
 * Redacts the text the model reads back: user text, the conductor's own text, and tool results.
 * Thinking blocks are left as they are (they are signed), and so are tool inputs.
 */
function redactMessage(message: Message): Message {
  if (typeof message.content === 'string') {
    return { ...message, content: redactSecrets(message.content) };
  }
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === 'text') return { ...block, text: redactSecrets(block.text) };
      if (block.type !== 'tool_result' || block.content === undefined) return block;
      if (typeof block.content === 'string') {
        return { ...block, content: redactSecrets(block.content) };
      }
      return {
        ...block,
        content: block.content.map((part) =>
          part.type === 'text' ? { ...part, text: redactSecrets(part.text) } : part
        ),
      };
    }),
  };
}

/** Secrets (keys, tokens) leave the thread before it is written; paths and addresses stay. */
function redactThread<Thread extends ChatConductorThread | ConductorTaskThread>(
  thread: Thread
): Thread {
  return {
    ...thread,
    entries: thread.entries.map(redactEntry),
    messages: thread.messages.map(redactMessage),
    notes: redactSecrets(thread.notes),
    status: thread.status
      ? { ...thread.status, headline: redactSecrets(thread.status.headline) }
      : null,
  };
}

type StoredThread = ChatConductorThread | ConductorTaskThread;

/**
 * Conductor threads on disk: one JSON file per key under a folder of `<dataDir>`. The renderer
 * owns a thread's content and saves the whole of it; this class only keeps it safely: a checked
 * file name, bounded and redacted content, and atomic writes, one at a time per key.
 */
class ThreadFiles<Thread extends StoredThread> {
  private readonly dir: string;
  /** The last write (save or delete) queued per key. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    folder: string,
    private readonly schema: z.ZodType<Thread>,
    private readonly keyOf: (thread: Thread) => string,
    private readonly logger: Logger
  ) {
    this.dir = join(dataDir, folder);
  }

  private pathFor(key: string): string | null {
    const name = chatThreadFileName(key);
    return name ? join(this.dir, name) : null;
  }

  /** Runs after the key's earlier writes, whether they succeeded or not. */
  private enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.then(
      () => {},
      () => {}
    );
    this.writes.set(key, settled);
    void settled.then(() => {
      if (this.writes.get(key) === settled) this.writes.delete(key);
    });
    return next;
  }

  /** The saved thread, or null when there is none, the key is refused, or the file is unreadable. */
  async read(key: string): Promise<Thread | null> {
    const path = this.pathFor(key);
    if (!path) return null;
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) return null;
      const parsed = this.schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success || this.keyOf(parsed.data) !== key) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  /** Saves the whole thread. Rejects when its key cannot be a file name. */
  save(thread: Thread): Promise<void> {
    const key = this.keyOf(thread);
    const path = this.pathFor(key);
    if (!path) return Promise.reject(new Error('That id cannot name a thread file.'));
    return this.enqueue(key, async () => {
      const bounded = redactThread(boundThread(this.schema.parse(thread)));
      let text = JSON.stringify(bounded);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        // What the developer reads and the notes outlive the model history.
        this.logger.warn('chat conductor: thread too large, saved without model history', { key });
        text = JSON.stringify({ ...bounded, messages: [] });
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
      if (process.platform !== 'win32') await chmod(path, 0o600);
    });
  }

  /** Removes a thread. Nothing happens for a refused key or a missing file. */
  delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (!path) return Promise.resolve();
    return this.enqueue(key, async () => {
      await rm(path, { force: true });
      await rm(`${path}.tmp`, { force: true });
    });
  }

  /** The keys that have a saved thread. */
  async list(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.flatMap((name) => {
      if (!name.endsWith(EXTENSION)) return [];
      const id = name.slice(0, -EXTENSION.length);
      return chatThreadFileName(id) === name ? [id] : [];
    });
  }
}

/**
 * The threads from when each conversation had its own conductor, under
 * `<dataDir>/chat-conductors/`: read and deleted as their task's thread adopts them.
 */
export class ChatConductorThreads extends ThreadFiles<ChatConductorThread> {
  constructor(dataDir: string, logger: Logger) {
    super(
      dataDir,
      THREADS_DIR,
      chatConductorThreadSchema,
      (thread) => thread.conversationId,
      logger
    );
  }
}

/** One conductor thread per task, under `<dataDir>/task-conductors/`. */
export class TaskConductorThreads extends ThreadFiles<ConductorTaskThread> {
  constructor(dataDir: string, logger: Logger) {
    super(dataDir, TASK_THREADS_DIR, conductorTaskThreadSchema, (thread) => thread.taskId, logger);
  }
}
