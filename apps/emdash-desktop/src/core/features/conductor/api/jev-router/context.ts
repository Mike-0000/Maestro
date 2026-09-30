/**
 * What the conversation so far says about "it", "that agent", and "the same task": the agents the
 * conductor last started, messaged, and heard from, its last reply (and whether that asked the
 * developer something), and the last send or spawn. Jev sees this, so anaphora and corrections
 * bind without Claude. Everything is in memory; nothing new is persisted.
 */

/** Referents older than this no longer count as "it". */
export const REFERENT_TTL_MS = 30 * 60_000;
/** A completion report stops being "the one that just reported" after this long. */
export const REPORTED_TTL_MS = 10 * 60_000;
/** A reply stops being the question the developer is answering after this long. */
export const QUESTION_TTL_MS = 3 * 60_000;
const RECENT_UTTERANCES = 6;

export type AgentRef = { readonly conversationId: string; readonly name: string };

export type SpawnRecord = AgentRef & {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly projectName: string | null;
  readonly prompt: string;
  readonly taskName: string;
  readonly worktree: boolean;
};

export type SendRecord = AgentRef & { readonly text: string };

type Stamped<T> = { readonly value: T; readonly at: number };

export type ConversationSnapshot = {
  readonly lastReply: string | null;
  /** The last reply asked the developer something, recently enough to be answered now. */
  readonly awaitingAnswer: boolean;
  readonly lastSpawned: SpawnRecord | null;
  readonly lastSent: SendRecord | null;
  /** Whichever of the last spawn or send came last. */
  readonly lastAction: 'spawn' | 'send' | null;
  readonly lastAddressed: AgentRef | null;
  readonly lastReported: AgentRef | null;
  readonly recentUtterances: readonly string[];
};

export function asksQuestion(reply: string): boolean {
  return /\?\s*["”')]?\s*$/.test(reply.trim());
}

export class ConversationContext {
  private reply: Stamped<string> | null = null;
  private spawned: Stamped<SpawnRecord> | null = null;
  private sent: Stamped<SendRecord> | null = null;
  private addressed: Stamped<AgentRef> | null = null;
  private reported: Stamped<AgentRef> | null = null;
  private utterances: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  noteUtterance(text: string): void {
    this.utterances = [...this.utterances, text.slice(0, 300)].slice(-RECENT_UTTERANCES);
  }

  noteReply(text: string): void {
    if (text.trim()) this.reply = { value: text.trim(), at: this.now() };
  }

  noteAddressed(agent: AgentRef): void {
    this.addressed = { value: agent, at: this.now() };
  }

  noteSpawn(record: SpawnRecord): void {
    this.spawned = { value: record, at: this.now() };
    this.noteAddressed(record);
  }

  noteSend(record: SendRecord): void {
    this.sent = { value: record, at: this.now() };
    this.noteAddressed(record);
  }

  noteReported(agent: AgentRef): void {
    this.reported = { value: agent, at: this.now() };
  }

  snapshot(): ConversationSnapshot {
    const now = this.now();
    const fresh = <T>(stamped: Stamped<T> | null, ttl: number): T | null =>
      stamped && now - stamped.at <= ttl ? stamped.value : null;
    const lastSpawned = fresh(this.spawned, REFERENT_TTL_MS);
    const lastSent = fresh(this.sent, REFERENT_TTL_MS);
    const lastAction =
      lastSpawned && lastSent
        ? (this.spawned?.at ?? 0) >= (this.sent?.at ?? 0)
          ? 'spawn'
          : 'send'
        : lastSpawned
          ? 'spawn'
          : lastSent
            ? 'send'
            : null;
    const lastReply = fresh(this.reply, REFERENT_TTL_MS);
    const recentReply = fresh(this.reply, QUESTION_TTL_MS);
    return {
      lastReply,
      awaitingAnswer: recentReply !== null && asksQuestion(recentReply),
      lastSpawned,
      lastSent,
      lastAction,
      lastAddressed: fresh(this.addressed, REFERENT_TTL_MS),
      lastReported: fresh(this.reported, REPORTED_TTL_MS),
      recentUtterances: [...this.utterances],
    };
  }

  /** Forgets everything, as when the conversation history is cleared. */
  clear(): void {
    this.reply = null;
    this.spawned = null;
    this.sent = null;
    this.addressed = null;
    this.reported = null;
    this.utterances = [];
  }
}
