import type { ConductorTurnRecord } from './contract';

/**
 * What the conductor did lately, whichever path did it. The grammar and Jev act without Claude,
 * so Claude's own message history misses most sends: "that message was supposed to go to Echo"
 * then has nothing to resend. Every turn is noted here and the latest ones ride along in each
 * turn's context, with the exact text that was sent. In memory, and seeded from the turn log
 * when the user keeps one.
 */

/** Turns kept; the context shows fewer. */
export const LEDGER_TURNS = 40;
const CONTEXT_TURNS = 6;
/** The newest sent text is shown whole up to this; older ones are previews. */
const CONTEXT_LATEST_TEXT_CHARS = 1_200;
const CONTEXT_TEXT_CHARS = 160;
const CONTEXT_SAID_CHARS = 140;
/** Stored per text; long briefs are cut in the middle, keeping how they start and end. */
const STORED_TEXT_CHARS = 6_000;

export type LedgerAction = {
  readonly tool: string;
  /** The agent the action was aimed at, by spoken name. */
  readonly agent?: string;
  readonly project?: string;
  /** The text typed into an agent, or a new agent's prompt, as the conductor wrote it. */
  readonly text?: string;
  readonly outcome: string;
  /** Set when the action did not happen. */
  readonly status?: 'failed' | 'cancelled';
};

export type LedgerTurn = {
  readonly at: number;
  readonly route: ConductorTurnRecord['route'];
  /** What the developer said, or what started the turn. */
  readonly said: string;
  readonly actions: readonly LedgerAction[];
  readonly reply: string;
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 20) / 2);
  return `${text.slice(0, half)}\n[… middle omitted …]\n${text.slice(-half)}`;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A logged tool input: an object while the turn runs, its JSON once read back from the log. */
function parsedInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

/** The ledger's view of one logged action. */
export function ledgerAction(action: ConductorTurnRecord['actions'][number]): LedgerAction {
  const input = parsedInput(action.input);
  const text = stringField(input, 'text') ?? stringField(input, 'prompt');
  const agent = stringField(input, 'agent');
  const project = stringField(input, 'project');
  return {
    tool: action.tool,
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(text ? { text: clipMiddle(text, STORED_TEXT_CHARS) } : {}),
    outcome: action.outcome,
    ...(action.status ? { status: action.status } : {}),
  };
}

function describeAction(action: LedgerAction, textChars: number): string {
  const failed =
    action.status === 'cancelled'
      ? ' (cancelled, it did not happen)'
      : action.status === 'failed'
        ? ` (FAILED, it did not happen: ${clip(action.outcome, 100)})`
        : '';
  const text = action.text ? `: “${clip(action.text, textChars)}”` : '';
  switch (action.tool) {
    case 'send_to_agent':
      return `${failed ? 'tried to send' : 'sent'} to ${action.agent ?? 'an agent'}${failed}${text}`;
    case 'spawn_agent': {
      const named = /appear on the canvas as ([^.]+)\./.exec(action.outcome)?.[1];
      const where = action.project ? ` in ${action.project}` : '';
      return `${failed ? 'tried to start' : 'started'} ${named ?? 'a new agent'}${where}${failed}${text}`;
    }
    default:
      return `${action.tool}${action.agent ? ` ${action.agent}` : ''} → ${clip(action.outcome, 80)}`;
  }
}

export class ActivityLedger {
  private turns: LedgerTurn[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  note(turn: LedgerTurn): void {
    this.turns = [...this.turns, turn].slice(-LEDGER_TURNS);
  }

  noteRecord(record: ConductorTurnRecord): void {
    this.note(this.turnOf(record));
  }

  /** Loads turns from the turn log behind anything already noted. */
  seed(records: readonly ConductorTurnRecord[]): void {
    this.turns = [...records.map((record) => this.turnOf(record)), ...this.turns]
      .sort((a, b) => a.at - b.at)
      .slice(-LEDGER_TURNS);
  }

  private turnOf(record: ConductorTurnRecord): LedgerTurn {
    return {
      at: Date.parse(record.at) || this.now(),
      route: record.route,
      said: record.utterance,
      actions: record.actions.map(ledgerAction),
      reply: record.reply,
    };
  }

  /** What the conductor typed into an agent lately, by its exact name, oldest first. */
  sentTo(agent: string): string[] {
    const wanted = agent.toLowerCase();
    return this.turns.flatMap((turn) =>
      turn.actions.flatMap((action) =>
        action.tool === 'send_to_agent' &&
        action.text &&
        !action.status &&
        action.agent?.toLowerCase() === wanted
          ? [action.text]
          : []
      )
    );
  }

  clear(): void {
    this.turns = [];
  }

  /** Newest first. */
  recent(limit = LEDGER_TURNS): LedgerTurn[] {
    return this.turns.slice(-limit).reverse();
  }

  /** Lines for the per-turn context: the latest turns, newest first, with what was sent. */
  contextLines(): string[] {
    const turns = this.recent(CONTEXT_TURNS).filter(
      (turn) => !turn.said.startsWith('[completion]') || turn.actions.length > 0
    );
    if (turns.length === 0) return [];
    const now = this.now();
    const lines = [
      'Recent conductor activity, newest first (recent_activity gives more, with full texts):',
    ];
    let shownWhole = false;
    for (const turn of turns) {
      const sends = turn.actions.filter((action) => action.text);
      const did =
        turn.actions.length > 0
          ? turn.actions
              .map((action) => {
                const whole = !shownWhole && Boolean(action.text);
                if (whole) shownWhole = true;
                return describeAction(
                  action,
                  whole ? CONTEXT_LATEST_TEXT_CHARS : CONTEXT_TEXT_CHARS
                );
              })
              .join('; ')
          : `replied “${clip(turn.reply, CONTEXT_TEXT_CHARS)}”`;
      // What was sent already quotes the developer when the text went through unchanged.
      const said =
        sends.length > 0 && turn.route !== 'llm' && turn.route !== 'line'
          ? ''
          : `you said “${clip(turn.said, CONTEXT_SAID_CHARS)}” → `;
      lines.push(`- ${formatAgo(turn.at, now)}: ${said}${did}`);
    }
    return lines;
  }

  /**
   * The fuller listing behind the recent_activity tool. `agent` narrows it to turns that involved
   * that agent: by any part of the name, or by the exact name with `exact`.
   */
  describe(limit: number, agent?: string, exact = false): string {
    const wanted = agent?.trim().toLowerCase();
    const involves = (name: string | undefined) =>
      name !== undefined &&
      wanted !== undefined &&
      (exact ? name.toLowerCase() === wanted : name.toLowerCase().includes(wanted));
    const turns = this.recent()
      .filter((turn) => !wanted || turn.actions.some((action) => involves(action.agent)))
      .slice(0, limit);
    if (turns.length === 0) {
      return wanted ? `Nothing recent involving ${agent}.` : 'Nothing has happened yet.';
    }
    const now = this.now();
    return turns
      .map((turn) => {
        const lines = [
          `${formatAgo(turn.at, now)} — the developer said: “${clip(turn.said, 600)}”`,
        ];
        for (const action of turn.actions) {
          lines.push(
            `  ${action.tool}${action.agent ? ` → ${action.agent}` : ''}${action.project ? ` (project ${action.project})` : ''}${action.status ? ` [${action.status}, it did not happen]` : ''}: ${clip(action.outcome, 200)}`
          );
          if (action.text) lines.push(`  exact text:\n${action.text}`);
        }
        if (turn.reply) lines.push(`  you replied: “${clip(turn.reply, 300)}”`);
        return lines.join('\n');
      })
      .join('\n\n');
  }
}
