export const HOOK_EVENTS = [
  'notification',
  'stop',
  'session',
  'start',
  'tool-use',
  'tool-use-failure',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookRegistration = {
  event: string;
  command: string;
};

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

/**
 * How a piece of in-flight background work bears on whether the agent's turn is finished:
 *
 * - 'agent'   — delegated work that reports its result back into the conversation (subagents,
 *   workflows). The turn is not finished until it does, so it always holds completion.
 * - 'process' — long-lived work that need not end (shells, dev servers, monitors). It holds
 *   the turn that launched it; a later user turn acknowledges it and stops waiting.
 * - 'wakeup'  — a one-shot scheduled wake-up. Acknowledged like a process.
 *
 * Plugins classify provider task types; a type they cannot vouch for should be 'process', since
 * an 'agent' that never settles would pin the agent at working with no way out.
 */
export type BackgroundWorkKind = 'agent' | 'process' | 'wakeup';

export type BackgroundWork = {
  /** Unique within the session across kinds (plugins namespace task and cron ids). */
  id: string;
  kind: BackgroundWorkKind;
};

/**
 * Normalised hook event produced by a plugin's parseHookEvent method.
 *
 * - kind: 'status'  — maps to an agent lifecycle event (start/stop/error/notification).
 *   May also carry `providerSessionId` when the provider includes its session id in
 *   every hook payload; the runtime adopts it whenever it differs from the stored id,
 *   so an in-session switch (Claude's `/resume`) is tracked without a dedicated event.
 *   `backgroundWork` (stop only) lists in-flight background work — shells, subagents,
 *   one-shot wakeups — that will wake the session when it settles: the turn ended but the
 *   agent is waiting, not done, unless all of it was acknowledged (see BackgroundWorkKind).
 *   `initiator` (start only) is 'background' when such a wake-up, rather than the user,
 *   opened the turn.
 * - kind: 'session' — carries a provider session id to persist on the conversation
 * - kind: 'ignore'  — event should be silently dropped
 */
export type CanonicalHookEvent =
  | {
      kind: 'status';
      type: 'start' | 'stop' | 'error' | 'notification';
      notificationType?: NotificationType;
      title?: string;
      message?: string;
      lastAssistantMessage?: string;
      providerSessionId?: string;
      backgroundWork?: BackgroundWork[];
      initiator?: 'user' | 'background';
    }
  | { kind: 'session'; providerSessionId: string }
  | { kind: 'ignore' };
