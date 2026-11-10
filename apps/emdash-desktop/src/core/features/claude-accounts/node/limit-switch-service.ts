import type { Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { AgentEvent } from '@core/primitives/agents/api';
import { CLAUDE_ACCOUNTS_PROVIDER_ID } from '../api/node/launch';
import {
  AUTO_SWITCH_BURST_LIMIT,
  AUTO_SWITCH_BURST_WINDOW_MS,
  type ClaudeAccountsEvent,
  type ClaudeAccountsState,
  type ClaudeAccountUsage,
  type ClaudeLimitUnhandledReason,
  type ClaudeUsageSnapshot,
  type ClaudeUsageWindow,
} from '../api/types';
import { usageLimitLineInReply, usageLimitLineInTerminal } from './usage-limit-text';

/** At or above this share of a window, the account counts as out of usage. */
export const LIMIT_REACHED_PERCENT = 99;
/** A target must be below this on both its five-hour and its weekly window. */
export const TARGET_MAX_USED_PERCENT = 90;
/** At most one automatic move per conversation in this time. */
export const AUTO_MOVE_COOLDOWN_MS = 15 * 60_000;
/**
 * A forced usage refresh is reused for this long. Ten agents stopping on one limit are handled
 * one after another; without this, each would ask the usage endpoint about every account.
 */
export const FORCED_USAGE_REUSE_MS = 10_000;

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/** Sent to a session moved because of a limit, so it picks its work back up. */
export const LIMIT_FOLLOW_UP_PROMPT =
  'The previous turn was cut off by a usage limit. This session now runs on another account. ' +
  'Continue where you left off.';

/** A local Claude conversation the switch may move, and the account it runs on now. */
export type LimitSwitchConversation = {
  conversationId: string;
  projectId: string;
  taskId: string;
  type: 'pty' | 'acp';
  accountId: string;
};

export type ClaudeLimitSwitchDeps = {
  /** The `autoSwitchOnLimit` setting. */
  enabled(): Promise<boolean>;
  accounts(): Promise<ClaudeAccountsState>;
  /** The shared usage service; always called with `force`. */
  usage(input: { force: true }): Promise<ClaudeAccountUsage[]>;
  /** Null when the conversation is not a local Claude conversation the switch may move. */
  describe(conversationId: string): Promise<LimitSwitchConversation | null>;
  /** The raw end of a terminal session's output, or null when it cannot be read. */
  terminalTail(conversationId: string): Promise<string | null>;
  /** The final assistant reply of a chat session's latest turn, or null. */
  lastChatReply(conversationId: string): Promise<string | null>;
  move(input: {
    conversationId: string;
    accountId: string;
    followUpPrompt: string;
    reason: 'limit';
  }): Promise<Result<unknown, { type: string; message?: string }>>;
  emit(event: ClaudeAccountsEvent): void;
  logger: Pick<Logger, 'info' | 'warn'>;
  now(): number;
};

/**
 * Moves a Claude conversation that stopped on a usage limit to another signed-in account.
 *
 * The rule: a conversation that was working ends its turn (a stop, an error, or the idle
 * reminder a terminal agent sends when a turn ended without one), AND the session itself said
 * it hit a usage limit (Claude Code's own limit message as the turn's last reply, or as the
 * last lines in its terminal), AND a forced usage refresh shows that account at
 * `LIMIT_REACHED_PERCENT` or more on its five-hour, weekly or a model's weekly window. Any one
 * of these alone is not enough: an ordinary stop or error carries no limit message, a 429 or
 * overload retries with other text, and the message alone could be quoted text on screen.
 */
export class ClaudeLimitSwitchService {
  /** Conversations whose last signal started a turn that has not ended yet. */
  private readonly working = new Set<string>();
  /** Conversations with a check queued or running. */
  private readonly pending = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly lastAutoMove = new Map<string, number>();
  /** Accounts that hit a limit, until the window that ran out resets. */
  private readonly limitedUntil = new Map<string, number>();
  /** When conversations were moved onto each account, for the burst cap. */
  private readonly movesOnto = new Map<string, number[]>();
  private lastUsage: { at: number; usage: ClaudeAccountUsage[] } | null = null;
  private disposed = false;

  constructor(private readonly deps: ClaudeLimitSwitchDeps) {}

  /** Feed every delivered agent event here. Never throws; the check runs in the background. */
  handleAgentEvent(event: AgentEvent): void {
    if (this.disposed || event.providerId !== CLAUDE_ACCOUNTS_PROVIDER_ID) return;
    const id = event.conversationId;
    if (event.type === 'start') {
      this.working.add(id);
      return;
    }
    if (!endsTurn(event)) return;
    // Only a conversation that was working when the turn ended can have been cut off.
    if (!this.working.delete(id)) return;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.queue = this.queue
      .then(() => this.check(event))
      .catch((error: unknown) => {
        this.deps.logger.warn('ClaudeAccounts: usage limit check failed', {
          conversationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.pending.delete(id));
  }

  /** Resolves once every queued check has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    this.working.clear();
  }

  private async check(event: AgentEvent): Promise<void> {
    if (this.disposed || !(await this.deps.enabled())) return;
    const state = await this.deps.accounts();
    if (state.accounts.length < 2) return;
    const conversation = await this.deps.describe(event.conversationId);
    if (!conversation) return;
    const limitLine = await this.sessionLimitLine(conversation, event);
    if (!limitLine) return;

    const usage = await this.forcedUsage();
    const now = this.deps.now();
    const current = usage.find((entry) => entry.accountId === conversation.accountId);
    const resetAt = exhaustedUntil(current, now);
    if (resetAt === null) {
      // The session said so, but the account's figures do not: not switching on that alone.
      this.deps.logger.info('ClaudeAccounts: limit message without usage at the limit', {
        conversationId: conversation.conversationId,
        accountId: conversation.accountId,
        usage: current?.status ?? 'missing',
      });
      return;
    }
    this.limitedUntil.set(conversation.accountId, resetAt);

    const lastMove = this.lastAutoMove.get(conversation.conversationId);
    if (lastMove !== undefined && now - lastMove < AUTO_MOVE_COOLDOWN_MS) {
      this.unhandled(conversation, 'cooldown');
      return;
    }

    // Re-read: an account can have been signed out or removed while this was queued.
    const latest = await this.deps.accounts();
    const eligible = latest.accounts
      // The stored sign-in flag is only refreshed on request; a fresh usage answer (required
      // below) is what proves the account is signed in.
      .filter((account) => account.id !== conversation.accountId)
      .filter((account) => !this.isLimited(account.id, now))
      .map((account) => ({
        id: account.id,
        usage: usage.find((entry) => entry.accountId === account.id),
      }))
      .filter((candidate) => isEligibleTarget(candidate.usage))
      .sort((left, right) => compareTargets(left.usage!, right.usage!));
    if (eligible.length === 0) {
      this.unhandled(conversation, 'no-eligible-account');
      return;
    }
    const target = eligible.find((candidate) => !this.burstCapped(candidate.id, now));
    if (!target) {
      this.unhandled(conversation, 'burst-cap');
      return;
    }

    const moved = await this.deps.move({
      conversationId: conversation.conversationId,
      accountId: target.id,
      followUpPrompt: LIMIT_FOLLOW_UP_PROMPT,
      reason: 'limit',
    });
    if (!moved.success) {
      this.unhandled(conversation, 'move-failed', moved.error.message ?? moved.error.type);
      return;
    }
    const movedAt = this.deps.now();
    this.lastAutoMove.set(conversation.conversationId, movedAt);
    this.movesOnto.set(target.id, [...this.recentMovesOnto(target.id, movedAt), movedAt]);
  }

  /** The limit message the session ended its turn with, or null. */
  private async sessionLimitLine(
    conversation: LimitSwitchConversation,
    event: AgentEvent
  ): Promise<string | null> {
    const fromEvent =
      usageLimitLineInReply(event.payload.lastAssistantMessage) ??
      usageLimitLineInReply(event.payload.message);
    if (fromEvent) return fromEvent;
    if (conversation.type === 'acp') {
      // A chat turn that ran into a limit fails; its transcript ends with the CLI's message.
      if (event.type !== 'error') return null;
      return usageLimitLineInReply(await this.deps.lastChatReply(conversation.conversationId));
    }
    // Whether Claude Code ends a turn cut off by a limit with a stop or only with the idle
    // reminder is not known, so the screen is read on either; the usage check keeps this safe.
    return usageLimitLineInTerminal(await this.deps.terminalTail(conversation.conversationId));
  }

  private async forcedUsage(): Promise<ClaudeAccountUsage[]> {
    const now = this.deps.now();
    if (this.lastUsage && now - this.lastUsage.at < FORCED_USAGE_REUSE_MS) {
      return this.lastUsage.usage;
    }
    const usage = await this.deps.usage({ force: true });
    this.lastUsage = { at: this.deps.now(), usage };
    return usage;
  }

  private isLimited(accountId: string, now: number): boolean {
    const until = this.limitedUntil.get(accountId);
    if (until === undefined) return false;
    if (now < until) return true;
    this.limitedUntil.delete(accountId);
    return false;
  }

  private burstCapped(accountId: string, now: number): boolean {
    return this.recentMovesOnto(accountId, now).length >= AUTO_SWITCH_BURST_LIMIT;
  }

  private recentMovesOnto(accountId: string, now: number): number[] {
    return (this.movesOnto.get(accountId) ?? []).filter(
      (at) => now - at < AUTO_SWITCH_BURST_WINDOW_MS
    );
  }

  private unhandled(
    conversation: LimitSwitchConversation,
    reason: ClaudeLimitUnhandledReason,
    message?: string
  ): void {
    this.deps.logger.info('ClaudeAccounts: usage limit hit, conversation not moved', {
      conversationId: conversation.conversationId,
      accountId: conversation.accountId,
      reason,
    });
    this.deps.emit({
      type: 'limit-unhandled',
      conversationId: conversation.conversationId,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      accountId: conversation.accountId,
      reason,
      ...(message ? { message } : {}),
    });
  }
}

/**
 * Whether the event ends the turn. A permission or question prompt pauses a turn rather than
 * ending it; the idle reminder (or an untyped notification) means the agent is waiting.
 */
function endsTurn(event: AgentEvent): boolean {
  if (event.type === 'stop' || event.type === 'error') return true;
  if (event.type !== 'notification') return false;
  const kind = event.payload.notificationType;
  return kind === undefined || kind === 'idle_prompt';
}

/**
 * When the account's exhausted window resets (the latest, if several ran out), or null when
 * fresh figures do not show it at its limit. An unknown reset time counts as a full window.
 */
function exhaustedUntil(usage: ClaudeAccountUsage | undefined, now: number): number | null {
  const snapshot = usage?.status === 'fresh' ? usage.snapshot : null;
  if (!snapshot) return null;
  const windows: Array<[ClaudeUsageWindow | null, number]> = [
    [snapshot.fiveHour, FIVE_HOURS_MS],
    [snapshot.sevenDay, SEVEN_DAYS_MS],
    [snapshot.sevenDayOpus, SEVEN_DAYS_MS],
    [snapshot.sevenDaySonnet, SEVEN_DAYS_MS],
  ];
  let until: number | null = null;
  for (const [window, length] of windows) {
    if (!window || window.usedPercent < LIMIT_REACHED_PERCENT) continue;
    const parsed = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const resetsAt = Number.isNaN(parsed) ? now + length : parsed;
    until = until === null ? resetsAt : Math.max(until, resetsAt);
  }
  return until;
}

/** Known (freshly fetched) usage below the target ceiling on both windows. */
function isEligibleTarget(usage: ClaudeAccountUsage | undefined): boolean {
  if (usage?.status !== 'fresh' || !usage.snapshot) return false;
  return (
    fiveHourPercent(usage.snapshot) < TARGET_MAX_USED_PERCENT &&
    weeklyPercent(usage.snapshot) < TARGET_MAX_USED_PERCENT
  );
}

/** Lowest five-hour figure first, then lowest weekly. */
function compareTargets(left: ClaudeAccountUsage, right: ClaudeAccountUsage): number {
  const l = left.snapshot!;
  const r = right.snapshot!;
  return fiveHourPercent(l) - fiveHourPercent(r) || weeklyPercent(l) - weeklyPercent(r);
}

/** A subscription without a five-hour window reports none: nothing used. */
function fiveHourPercent(snapshot: ClaudeUsageSnapshot): number {
  return snapshot.fiveHour?.usedPercent ?? 0;
}

/** Likewise for the weekly window. */
function weeklyPercent(snapshot: ClaudeUsageSnapshot): number {
  return snapshot.sevenDay?.usedPercent ?? 0;
}

export function createClaudeLimitSwitchService(
  deps: ClaudeLimitSwitchDeps
): ClaudeLimitSwitchService {
  return new ClaudeLimitSwitchService(deps);
}
