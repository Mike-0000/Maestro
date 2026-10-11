import type Anthropic from '@anthropic-ai/sdk';
import { MAESTRO_EVENT_MARK } from './history';
import {
  CANCEL_WINDOW_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  conductorToolNames,
  type ConductorToolName,
} from './tools';

/**
 * A tainted turn is a turn whose choice of action rests on text the developer did not write:
 * they gave a reply that names no action ("yes", "sure, do that") to something an agent
 * suggested, or the turn holds the result of a code check. The developer's words then do not
 * name the action, so the action needs their explicit yes. Every tool is in exactly one class,
 * and the class says what a tainted turn does with it. The taint is decided before the fast
 * router runs, so a command Jev makes of such a reply asks first too. Commands the grammar reads
 * from the developer's own words are not affected.
 */
export type TaintClass =
  /** Reads or shows something. Runs as usual. `propose_plan` only proposes. */
  | 'view'
  /** Asks for its own confirmation already. Unchanged. */
  | 'confirms'
  /** Runs behind a cancel window. In a tainted turn the window becomes a confirmation. */
  | 'countdown'
  /** Everything else changes something without asking. In a tainted turn it asks first. */
  | 'other';

const VIEW_TOOLS: ReadonlySet<string> = new Set([
  'list_agents',
  'read_agent',
  'describe_canvas',
  'agent_details',
  'recent_activity',
  'find_conversations',
  'delivery_status',
  'check_conflicts',
  'look_at_app',
  'show_app',
  'focus_agent',
  'show_all',
  'canvas_view',
  'investigate',
  'propose_plan',
]);

/** A tool nobody classified changes something until shown otherwise, so it asks first. */
export function taintClass(name: string): TaintClass {
  if (VIEW_TOOLS.has(name)) return 'view';
  if (CONFIRM_REQUIRED_TOOLS.has(name as ConductorToolName)) return 'confirms';
  if (CANCEL_WINDOW_TOOLS.has(name as ConductorToolName)) return 'countdown';
  return 'other';
}

/** Every tool with its class, for the test that pins the table. */
export function taintClasses(): Record<string, TaintClass> {
  return Object.fromEntries(conductorToolNames.map((name) => [name, taintClass(name)]));
}

function field(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The one-line question for a tool that asks first only because the turn is tainted. */
export function taintedActionLabel(name: string, input: unknown): string {
  const agent = field(input, 'agent');
  switch (name) {
    case 'add_note':
      return `Add the note “${clip(field(input, 'text') ?? '', 80)}”`;
    case 'rename_agent':
      return `Rename ${agent ?? 'the agent'} to ${field(input, 'name') ?? 'a new name'}`;
    case 'close_agent':
      return `Close ${agent ? `${agent}'s window` : 'the window in front'}`;
    case 'reopen_agent':
      return `Reopen ${agent ? `${agent}'s window` : 'the closed windows'}`;
    case 'close_app':
      return `Close the app browser${agent ? ` for ${agent}` : ''}`;
    case 'use_app':
      return `Use the app${agent ? ` for ${agent}` : ''}: ${clip(JSON.stringify(input ?? {}), 100)}`;
    case 'arrange_canvas':
      return 'Rearrange the canvas';
    case 'filter_canvas':
      return field(input, 'project')
        ? `Show only ${field(input, 'project')} on the canvas`
        : 'Show every project on the canvas';
    case 'read_clipboard':
      return 'Read the clipboard';
    case 'answer_request':
      return `Answer request ${field(input, 'request_id') ?? ''}: ${field(input, 'decision') ?? 'decide'}`.trim();
    default:
      return `${name.replace(/_/g, ' ')}: ${clip(JSON.stringify(input ?? {}), 100)}`;
  }
}

/** Words of agreement, refusal and pointing: none of them says what to do. */
const REPLY_WORDS: ReadonlySet<string> = new Set(
  (
    'yes yeah yep yup ya aye sure ok okay k alright fine right correct good great perfect cool ' +
    'nice sounds please thanks thank you do did does it that this those them these so go ahead ' +
    'for and then just let lets us proceed carry on approved approve agreed agree ' +
    'absolutely definitely totally exactly affirmative confirm confirmed accept accepted the a ' +
    'an one first second third last both all either option number two three of what he she ' +
    'they said says suggested suggests suggestion asked asks wants want wanted recommended ' +
    'recommends as with way i we think guess would should can could will be is make happen ' +
    'work works me to too now up same thing plan idea no not nope nah yet why its his her ' +
    'their oh uh um er well hmm mm mhm huh hm by away whatever your call course latter former ' +
    'b c d s t ll re ve m if approach quickly'
  ).split(' ')
);

/** Words a spoken reply starts with before it says anything. */
const FILLERS: ReadonlySet<string> = new Set(
  'oh uh um er well hmm mm mhm huh hm so and'.split(' ')
);
/** Words of agreement a reply opens with: what follows them usually leans on what was asked. */
const AGREEMENT: ReadonlySet<string> = new Set(
  (
    'yes yeah yep yup ya aye sure ok okay k alright fine right correct good great perfect ' +
    'cool absolutely definitely totally exactly agreed approved sounds'
  ).split(' ')
);

function plainWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when what the developer said names no action of its own: "yes", "um, sure, do that",
 * "the second one", "go with what Atlas suggested". Such a reply means whatever the text before
 * it proposed. An agent's name is not an action, so names do not count. A reply that opens with
 * agreement may carry one word of its own and still lean on what was asked ("yeah totally",
 * "yes, run it"); with two it is an instruction ("yes, and add a changelog entry"). Words that
 * do not open with agreement and name anything ("merge it", "push it", "continue") are the
 * developer's own instruction. It is a word list, so it can miss; missing costs one question
 * asked, or one not asked.
 */
export function isBareReply(text: string, agentNames: readonly string[] = []): boolean {
  let rest = ` ${plainWords(text.replace(/['’]s\b/gi, ''))} `;
  for (const name of agentNames) {
    const spoken = plainWords(name);
    if (spoken) rest = rest.split(` ${spoken} `).join(' ');
  }
  const words = rest.split(' ').filter(Boolean);
  // Nothing but a name: it says who, not what.
  if (words.length === 0) return text.trim().length > 0;
  const own = words.filter((word) => !REPLY_WORDS.has(word)).length;
  if (own === 0) return true;
  const opening = words.find((word) => !FILLERS.has(word));
  return own === 1 && opening !== undefined && AGREEMENT.has(opening);
}

/** Tools whose result is text the developer did not write: an agent's, a page's, a file's. */
const AGENT_TEXT_TOOLS: ReadonlySet<string> = new Set([
  'read_agent',
  'agent_details',
  'recent_activity',
  'find_conversations',
  'look_at_app',
  'read_clipboard',
  'investigate',
]);
/** True for a tool whose result is text an agent, an app, or a file wrote. */
export function readsAgentText(name: string): boolean {
  return AGENT_TEXT_TOOLS.has(name);
}

/** How many stored turns back a bare reply may still be about what an agent wrote. */
export const AGENT_TEXT_REACH = 2;

/**
 * True when one of the newest stored turns rests on text the developer did not write: a Maestro
 * event started it, or the model read an agent's output in it. The conductor's replies to those
 * turns may carry an agent's suggestion, and a bare reply that follows answers it.
 */
export function restsOnAgentText(
  history: readonly Anthropic.Beta.BetaMessageParam[],
  turns: number = AGENT_TEXT_REACH
): boolean {
  let seen = 0;
  for (let index = history.length - 1; index >= 0 && seen < turns; index--) {
    const message = history[index];
    if (!message) continue;
    if (message.role === 'assistant') {
      if (
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === 'tool_use' && AGENT_TEXT_TOOLS.has(block.name)
        )
      ) {
        return true;
      }
      continue;
    }
    // A turn starts with the developer's (or an event's) words; tool results are lists.
    if (typeof message.content !== 'string') continue;
    if (message.content.includes(MAESTRO_EVENT_MARK)) return true;
    seen++;
  }
  return false;
}

/**
 * True when the newest stored turn was started by a Maestro event, not by the developer: the
 * conductor read an agent's output and may have asked "want me to…?". A bare "yes" that follows
 * answers that agent-shaped question.
 */
export function lastTurnIsEvent(history: readonly Anthropic.Beta.BetaMessageParam[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    return message.content.includes(MAESTRO_EVENT_MARK);
  }
  return false;
}
