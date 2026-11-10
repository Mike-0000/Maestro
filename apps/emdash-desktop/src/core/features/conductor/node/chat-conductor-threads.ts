import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { redactSecrets, type Logger } from '@emdash/shared/logger';
import {
  boundThread,
  chatConductorThreadSchema,
  type ChatConductorEntry,
  type ChatConductorThread,
} from '../api/chat-conductor/thread';

const THREADS_DIR = 'chat-conductors';
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
function redactThread(thread: ChatConductorThread): ChatConductorThread {
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

/**
 * The chat conductors' threads on disk: one JSON file per conversation under
 * `<dataDir>/chat-conductors/`. The renderer owns a thread's content and saves the whole of it;
 * this class only keeps it safely: a checked file name, bounded and redacted content, and
 * atomic writes, one at a time per conversation.
 */
export class ChatConductorThreads {
  private readonly dir: string;
  /** The last write (save or delete) queued per conversation. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.dir = join(dataDir, THREADS_DIR);
  }

  private pathFor(conversationId: string): string | null {
    const name = chatThreadFileName(conversationId);
    return name ? join(this.dir, name) : null;
  }

  /** Runs after the conversation's earlier writes, whether they succeeded or not. */
  private enqueue(conversationId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(conversationId) ?? Promise.resolve()).then(work, work);
    const settled = next.then(
      () => {},
      () => {}
    );
    this.writes.set(conversationId, settled);
    void settled.then(() => {
      if (this.writes.get(conversationId) === settled) this.writes.delete(conversationId);
    });
    return next;
  }

  /** The saved thread, or null when there is none, the id is refused, or the file is unreadable. */
  async read(conversationId: string): Promise<ChatConductorThread | null> {
    const path = this.pathFor(conversationId);
    if (!path) return null;
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) return null;
      const parsed = chatConductorThreadSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success || parsed.data.conversationId !== conversationId) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  /** Saves the whole thread. Rejects when the conversation id cannot be a file name. */
  save(thread: ChatConductorThread): Promise<void> {
    const path = this.pathFor(thread.conversationId);
    if (!path) return Promise.reject(new Error('That conversation id cannot name a thread file.'));
    return this.enqueue(thread.conversationId, async () => {
      const bounded = redactThread(boundThread(chatConductorThreadSchema.parse(thread)));
      let text = JSON.stringify(bounded);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        // What the developer reads and the notes outlive the model history.
        this.logger.warn('chat conductor: thread too large, saved without model history', {
          conversationId: thread.conversationId,
        });
        text = JSON.stringify({ ...bounded, messages: [] });
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
      if (process.platform !== 'win32') await chmod(path, 0o600);
    });
  }

  /** Removes a conversation's thread. Nothing happens for a refused id or a missing file. */
  delete(conversationId: string): Promise<void> {
    const path = this.pathFor(conversationId);
    if (!path) return Promise.resolve();
    return this.enqueue(conversationId, async () => {
      await rm(path, { force: true });
      await rm(`${path}.tmp`, { force: true });
    });
  }

  /** The ids of the conversations that have a saved thread. */
  async list(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.flatMap((name) => {
      if (!name.endsWith(EXTENSION)) return [];
      const id = name.slice(0, -EXTENSION.length);
      return chatThreadFileName(id) === name ? [id] : [];
    });
  }
}
