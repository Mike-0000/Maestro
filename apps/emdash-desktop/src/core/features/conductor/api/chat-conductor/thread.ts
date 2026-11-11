import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * A chat conductor's thread: what the developer sees when they open a chat (their messages, the
 * conductor's, what it did), plus what the conductor needs to carry on (model history, its notes,
 * its status). One thread per conversation, saved as one JSON file by the main process.
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
]);
export type ChatConductorEntry = z.infer<typeof chatConductorEntrySchema>;

export const chatConductorThreadSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().min(1),
  entries: z.array(chatConductorEntrySchema),
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
export function boundThread(thread: ChatConductorThread): ChatConductorThread {
  const { headlineChars, notesChars, entries } = CHAT_THREAD_LIMITS;
  return {
    ...thread,
    entries: thread.entries.slice(-entries).map(boundEntry),
    notes: cut(thread.notes, notesChars),
    status:
      thread.status && thread.status.headline.length > headlineChars
        ? { ...thread.status, headline: thread.status.headline.slice(0, headlineChars) }
        : thread.status,
  };
}
