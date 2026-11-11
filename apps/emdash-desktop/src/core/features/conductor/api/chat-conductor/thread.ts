import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { boundDigest, chatDigestSchema } from './digest';

/**
 * A conductor's thread: what the developer sees in a chat's Conductor view (their messages, the
 * conductor's, what it did), plus what the conductor needs to carry on (model history, its notes,
 * its status). One thread per task (`ConductorTaskThread`), shared by every chat in it, saved as
 * one JSON file by the main process. Threads from when each chat had its own conductor
 * (`ChatConductorThread`, version 1) are read once more to be adopted into their task's thread.
 */

export const CHAT_THREAD_LIMITS = {
  entries: 400,
  entryChars: 20_000,
  notesChars: 8_000,
  headlineChars: 200,
} as const;

export const chatConductorStateSchema = z.enum(['idle', 'working', 'needs_you', 'done']);
export type ChatConductorState = z.infer<typeof chatConductorStateSchema>;

/** The one line pinned above the thread. */
export const chatConductorStatusSchema = z.object({
  state: chatConductorStateSchema,
  headline: z.string(),
});
export type ChatConductorStatus = z.infer<typeof chatConductorStatusSchema>;

const entryBase = { id: z.string(), at: z.string() };

export const chatConductorEntrySchema = z.discriminatedUnion('kind', [
  /** What the developer wrote to the conductor. */
  z.object({ kind: z.literal('developer'), ...entryBase, text: z.string() }),
  /** The conductor's message, in markdown. */
  z.object({ kind: z.literal('conductor'), ...entryBase, text: z.string() }),
  /** Something the conductor did. `detail` holds the whole of it, such as the prompt it sent. */
  z.object({
    kind: z.literal('action'),
    ...entryBase,
    tool: z.string(),
    summary: z.string(),
    status: z.enum(['done', 'failed', 'refused']),
    detail: z.string().optional(),
  }),
  /** A chat event marker ("The agent finished a turn"). */
  z.object({ kind: z.literal('event'), ...entryBase, text: z.string() }),
  /** A turn that failed: no key, the budget, an API error. */
  z.object({ kind: z.literal('error'), ...entryBase, text: z.string() }),
  /**
   * The conductor's report in a fixed shape, shown as a card. `askedAt` is when the developer last
   * wrote in the thread before it was posted, or null when they never did.
   */
  z.object({
    kind: z.literal('digest'),
    ...entryBase,
    digest: chatDigestSchema,
    askedAt: z.string().nullable(),
  }),
]);
export type ChatConductorEntry = z.infer<typeof chatConductorEntrySchema>;

/**
 * A thread's entries, read one by one: an entry that does not parse (a kind from a later build, a
 * damaged one) is dropped instead of failing the whole thread, which would then read as empty.
 */
const threadEntriesSchema = z.array(z.unknown()).transform((items): ChatConductorEntry[] =>
  items.flatMap((item) => {
    const parsed = chatConductorEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })
);

export const chatConductorThreadSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().min(1),
  entries: threadEntriesSchema,
  /** Model history. */
  messages: z.custom<Anthropic.Beta.BetaMessageParam[]>((value) => Array.isArray(value)),
  /**
   * The conductor's own working notes: the developer's direction, decisions, open items. Survives
   * history cuts.
   */
  notes: z.string(),
  status: chatConductorStatusSchema.nullable(),
  /** Whether the conductor may act on its own when the agent reports back. */
  autonomy: z.boolean(),
  /**
   * Identity of the last agent event a turn ran for, so one is not handled twice (also across
   * restarts).
   */
  lastEventKey: z.string().nullable(),
  /**
   * The starts of the last messages the conductor typed into the agent (without their mark), so
   * it can tell its own prompts from the developer's in what the agent received.
   */
  sentToAgent: z.array(z.string()).optional(),
  /**
   * Where reading the prompts the agent received left off: a time for a terminal agent, a turn
   * number for a chat agent. Null before the first read.
   */
  promptCursor: z.number().nullable().optional(),
  updatedAt: z.string(),
});
export type ChatConductorThread = z.infer<typeof chatConductorThreadSchema>;

/** Most chats a task thread keeps bookkeeping for; the ones dealt with least recently go first. */
export const TASK_THREAD_MAX_CHATS = 60;

/** What a task's conductor keeps per chat, so each chat's events and prompts are told apart. */
export const conductorChatStateSchema = z.object({
  /** Identity of the chat's last event a turn ran for (see `agentEventSignal`). */
  lastEventKey: z.string().nullable(),
  /** The starts of the last messages the conductor typed into this chat's agent, unmarked. */
  sentToAgent: z.array(z.string()),
  /** Where reading the prompts this chat's agent received left off. */
  promptCursor: z.number().nullable(),
});
export type ConductorChatState = z.infer<typeof conductorChatStateSchema>;

export const conductorTaskThreadSchema = z.object({
  version: z.literal(2),
  taskId: z.string().min(1),
  entries: threadEntriesSchema,
  messages: z.custom<Anthropic.Beta.BetaMessageParam[]>((value) => Array.isArray(value)),
  notes: z.string(),
  status: chatConductorStatusSchema.nullable(),
  autonomy: z.boolean(),
  /** Per chat (conversation id), in the order they were last dealt with, oldest first. */
  chats: z.record(z.string(), conductorChatStateSchema),
  /** The chat the conductor last dealt with: the default for a new chat's provider. */
  lastChatId: z.string().nullable(),
  /** Conversations whose own (version 1) thread was taken into this one. */
  adopted: z.array(z.string()),
  updatedAt: z.string(),
});
export type ConductorTaskThread = z.infer<typeof conductorTaskThreadSchema>;

export function emptyTaskThread(taskId: string, autonomy: boolean): ConductorTaskThread {
  return {
    version: 2,
    taskId,
    entries: [],
    messages: [],
    notes: '',
    status: null,
    autonomy,
    chats: {},
    lastChatId: null,
    adopted: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Takes chats' own threads into their task's thread, once each: what the developer read stays,
 * in time order; each chat's notes are kept under its name; and each chat's bookkeeping carries
 * over, so its old events are not news again. Model history comes from the newest thread when the
 * task thread has none of its own. Threads already adopted are skipped, so this is safe to repeat.
 */
export function adoptChatThreads(
  task: ConductorTaskThread,
  legacy: readonly { readonly thread: ChatConductorThread; readonly name: string }[]
): ConductorTaskThread {
  const fresh = legacy
    .filter(({ thread }) => !task.adopted.includes(thread.conversationId))
    .sort((a, b) => a.thread.updatedAt.localeCompare(b.thread.updatedAt));
  if (fresh.length === 0) return task;
  const newest = fresh.at(-1)!.thread;
  const notes = [
    task.notes.trim(),
    ...fresh
      .filter(({ thread }) => thread.notes.trim())
      .map(({ thread, name }) => `From the chat "${name}":\n${thread.notes.trim()}`),
  ].filter(Boolean);
  const chats = { ...task.chats };
  for (const { thread } of fresh) {
    chats[thread.conversationId] = {
      lastEventKey: thread.lastEventKey,
      sentToAgent: thread.sentToAgent ?? [],
      promptCursor: thread.promptCursor ?? null,
    };
  }
  const empty = task.entries.length === 0 && task.messages.length === 0;
  return {
    ...task,
    entries: [...task.entries, ...fresh.flatMap(({ thread }) => thread.entries)].sort((a, b) =>
      a.at.localeCompare(b.at)
    ),
    messages: task.messages.length > 0 ? task.messages : newest.messages,
    notes: notes.join('\n\n'),
    status: empty ? newest.status : task.status,
    autonomy: empty ? newest.autonomy : task.autonomy,
    chats,
    lastChatId: task.lastChatId ?? newest.conversationId,
    adopted: [...task.adopted, ...fresh.map(({ thread }) => thread.conversationId)],
  };
}

export function emptyChatThread(conversationId: string, autonomy: boolean): ChatConductorThread {
  return {
    version: 1,
    conversationId,
    entries: [],
    messages: [],
    notes: '',
    status: null,
    autonomy,
    lastEventKey: null,
    updatedAt: new Date().toISOString(),
  };
}

const CUT_MARK = '\n[… cut]';

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - CUT_MARK.length) + CUT_MARK;
}

function boundEntry(entry: ChatConductorEntry): ChatConductorEntry {
  const max = CHAT_THREAD_LIMITS.entryChars;
  if (entry.kind === 'digest') return { ...entry, digest: boundDigest(entry.digest) };
  if (entry.kind !== 'action') {
    return entry.text.length <= max ? entry : { ...entry, text: cut(entry.text, max) };
  }
  if (entry.summary.length <= max && (entry.detail?.length ?? 0) <= max) return entry;
  return {
    ...entry,
    summary: cut(entry.summary, max),
    ...(entry.detail === undefined ? {} : { detail: cut(entry.detail, max) }),
  };
}

/**
 * The thread within its limits: the newest entries, each entry's text, the notes and the headline
 * cut to size. Model history is left alone: the renderer already stores it trimmed (see
 * `storeChatHistory`), and cutting it here could split a tool call from its result.
 */
export function boundThread<
  Thread extends Pick<ChatConductorThread, 'entries' | 'notes' | 'status'>,
>(thread: Thread): Thread {
  const { headlineChars, notesChars, entries } = CHAT_THREAD_LIMITS;
  const chats =
    'chats' in thread
      ? {
          chats: Object.fromEntries(
            Object.entries(thread.chats as ConductorTaskThread['chats']).slice(
              -TASK_THREAD_MAX_CHATS
            )
          ),
        }
      : {};
  return {
    ...thread,
    ...chats,
    entries: thread.entries.slice(-entries).map(boundEntry),
    notes: cut(thread.notes, notesChars),
    status:
      thread.status && thread.status.headline.length > headlineChars
        ? { ...thread.status, headline: thread.status.headline.slice(0, headlineChars) }
        : thread.status,
  };
}
