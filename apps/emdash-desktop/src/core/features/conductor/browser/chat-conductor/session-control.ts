import type {
  MoveClaudeAccountError,
  MoveClaudeAccountResult,
} from '@core/features/conversations/api/claude-account-move';

/**
 * Restarting and stopping a chat's agent session, and moving it to another Claude account, for
 * the chat's conductor. The steps and what is reported live here; everything they touch comes in
 * through `SessionControlDeps`, so the logic is tested without the app.
 */

type Account = { id: string; label: string };

export type AccountChoice = { ok: true; account: Account } | { ok: false; message: string };

export type MoveOutcome =
  | { success: true; data: MoveClaudeAccountResult }
  | { success: false; error: MoveClaudeAccountError };

export type SessionControlDeps = {
  /** A terminal agent, or a chat (ACP) agent whose session starts with its next prompt. */
  kind: 'pty' | 'acp';
  /** What the agent is called, for messages ("Claude Code"). */
  agentLabel: string;
  /** The host reports a running session. */
  running(): boolean;
  stop(): Promise<void>;
  /** Resolves true once the host no longer reports the session, false if it still does. */
  stopped(): Promise<boolean>;
  /** Starts the session on its conversation. False when it never became ready. */
  start(): Promise<boolean>;
  /** Types a prompt into the session once it takes input. False when it did not get there. */
  deliver(prompt: string): Promise<boolean>;
  /** The account the agent runs on; null when it runs on none (not Claude Code). */
  currentAccount(): Account | null;
  resolveAccount(reference: string): AccountChoice;
  /** Maestro's own move: records the account and restarts the session on it. */
  move(accountId: string, followUpPrompt: string | undefined): Promise<MoveOutcome>;
  /** One sentence on why a move failed. */
  describeMoveError(error: MoveClaudeAccountError, target: string, previous: string): string;
};

export type RestartInput = { claudeAccount?: string; prompt?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends the prompt once the restarted session takes input; the turn does not wait for it. */
function deliverLater(
  deps: SessionControlDeps,
  prompt: string,
  onLateFailure: (message: string) => void
): void {
  void deps.deliver(prompt).then(
    (delivered) => {
      if (!delivered) onLateFailure('The restarted agent did not take the prompt.');
    },
    (error: unknown) =>
      onLateFailure(`The restarted agent did not take the prompt: ${errorMessage(error)}`)
  );
}

async function restartInPlace(
  deps: SessionControlDeps,
  prompt: string | undefined,
  onLateFailure: (message: string) => void
): Promise<string> {
  const wasRunning = deps.running();
  if (wasRunning) {
    await deps.stop();
    if (!(await deps.stopped())) {
      throw new Error(
        'The session was told to stop but Maestro still shows it running, so it was not started again.'
      );
    }
  }
  if (deps.kind === 'acp') {
    // A chat agent's session opens with a prompt; there is no process to bring up beforehand.
    if (prompt) {
      if (!(await deps.deliver(prompt))) {
        throw new Error(
          `${wasRunning ? 'The session was ended, but the' : 'The'} agent did not take the prompt.`
        );
      }
      return `${wasRunning ? 'Ended the session and sent' : 'Sent'} the prompt, which starts a new session on the same conversation.`;
    }
    return wasRunning
      ? 'Ended the session. This kind of agent starts a new one, on the same conversation, with its next prompt.'
      : 'The session was not running. This kind of agent starts one with its next prompt.';
  }
  if (!(await deps.start())) {
    throw new Error(
      wasRunning
        ? 'The session was stopped, but it did not start again. The conversation is kept.'
        : 'The session did not start.'
    );
  }
  if (prompt) deliverLater(deps, prompt, onLateFailure);
  const sent = prompt
    ? ' The prompt is typed once it takes input; the thread shows the developer if that fails.'
    : '';
  return wasRunning
    ? `Stopped the session and started it again on the same conversation, which the agent resumes.${sent}`
    : `The session was not running; started it on the same conversation.${sent}`;
}

/**
 * Restarts the chat's agent session. With `claudeAccount` it moves the chat to that account
 * through Maestro's own move, which stops, switches and resumes; asked for the account it is
 * already on, it restarts in place. Resolves to what happened; rejects when nothing useful did.
 */
export async function restartChatAgent(
  deps: SessionControlDeps,
  input: RestartInput,
  onLateFailure: (message: string) => void
): Promise<string> {
  if (!input.claudeAccount) return restartInPlace(deps, input.prompt, onLateFailure);
  const current = deps.currentAccount();
  if (!current) {
    throw new Error(
      `Only Claude Code agents run on a Claude account, and this chat's agent is ${deps.agentLabel}. Nothing was changed.`
    );
  }
  const choice = deps.resolveAccount(input.claudeAccount);
  if (!choice.ok) throw new Error(`${choice.message} Nothing was changed.`);
  const target = choice.account;
  if (target.id === current.id) {
    const restarted = await restartInPlace(deps, input.prompt, onLateFailure);
    return `The agent already runs on ${target.label}. ${restarted}`;
  }
  const wasRunning = deps.running();
  const moved = await deps.move(target.id, input.prompt);
  if (!moved.success) {
    throw new Error(deps.describeMoveError(moved.error, target.label, current.label));
  }
  const { restarted, followUpSent } = moved.data;
  const where = restarted
    ? `${wasRunning ? 'Stopped the session and resumed' : 'Started'} the conversation on ${target.label} (it was on ${current.label}).`
    : `The chat now runs on ${target.label} (it was on ${current.label}). Its session was not running and was not started: it starts on ${target.label} the next time.`;
  if (!input.prompt) return where;
  return `${where} ${followUpSent ? 'The prompt was sent.' : 'The prompt was not delivered: send it with send_to_agent.'}`;
}

/** Ends the chat's agent session and keeps its conversation. */
export async function stopChatAgent(deps: SessionControlDeps): Promise<string> {
  if (!deps.running()) return 'The session is not running, so there was nothing to stop.';
  await deps.stop();
  if (!(await deps.stopped())) {
    throw new Error('The session was told to stop, but Maestro still shows it running.');
  }
  return 'Stopped the session. The conversation is kept; restart_agent starts it again.';
}
