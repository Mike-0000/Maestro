import type Anthropic from '@anthropic-ai/sdk';
import { normalizeSpoken } from './resolver';

/**
 * When a code check's result keeps a turn tainted, the developer's own explicit command to
 * start an agent or message one still asked for a yes: three confirmations in an evening for
 * spawns they had dictated themselves. The confirmation is waived only for those two tools, only
 * when the fast router read the developer's own words as that very command, only in the project
 * the check read, and never for a brief that carries text the check returned.
 */

/** The two actions a code check's taint may be waived for. */
export type WaivableAction = 'spawn_agent' | 'send_to_agent';

/** How sure the router must be that the developer's words are that command, for Chorus. */
export const WAIVER_CONFIDENCE = 0.95;

const SPAWN_INTENTS = new Set(['spawn_with_brief', 'spawn_blank']);
const SEND_INTENTS = new Set(['send_verbatim', 'send_composed']);
/** Words in a brief that ask for something outward or destructive: those still ask first. */
const RISKY_WORDS = /\b(?:merg\w*|push\w*|archiv\w*|kill\w*|delet\w*|force)\b/i;
/** A run of this many words shared with a code check's result means the brief quotes it. */
const QUOTE_WORDS = 8;

/**
 * One answer of the router's trace detail, as `summarizeAnswer` wrote it: "spawn_with_brief
 * (0.97) | spawn_blank=0.02". Null when the detail has no such answer.
 */
export function jevReading(
  detail: Readonly<Record<string, unknown>>,
  id: string
): { choice: string; confidence: number } | null {
  const value = detail[`jev_${id}`];
  if (typeof value !== 'string') return null;
  const match = /^(.*?) \((\d+(?:\.\d+)?)\)/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { choice: match[1], confidence: Number(match[2]) };
}

/**
 * The action the router read the developer's own words as, when it was sure: a command for
 * Chorus to start an agent, or to send one a message. Null otherwise.
 */
export function namedAction(detail: Readonly<Record<string, unknown>>): WaivableAction | null {
  const addressee = jevReading(detail, 'addressee');
  if (addressee?.choice !== 'command_for_chorus' || addressee.confidence < WAIVER_CONFIDENCE) {
    return null;
  }
  const intent = jevReading(detail, 'intent');
  if (!intent || intent.confidence < WAIVER_CONFIDENCE) return null;
  if (SPAWN_INTENTS.has(intent.choice)) return 'spawn_agent';
  return SEND_INTENTS.has(intent.choice) ? 'send_to_agent' : null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

function resultText(content: Anthropic.Beta.BetaToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** The text of every code check result still in the history. */
export function codeCheckTexts(messages: readonly Anthropic.Beta.BetaMessageParam[]): string[] {
  return messages.flatMap((message) =>
    message.role !== 'user' || typeof message.content === 'string'
      ? []
      : message.content.flatMap((block) => {
          if (block.type !== 'tool_result') return [];
          const text = resultText(block.content);
          return text.includes('<code-check ') ? [text] : [];
        })
  );
}

/**
 * The inputs of the `investigate` calls whose results are still code checks in the history:
 * a check compacted away (see `compactCodeChecks`) no longer taints, so it waives nothing either.
 */
export function liveCodeCheckInputs(
  messages: readonly Anthropic.Beta.BetaMessageParam[]
): unknown[] {
  const live = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && resultText(block.content).includes('<code-check ')) {
        live.add(block.tool_use_id);
      }
    }
  }
  return messages.flatMap((message) =>
    message.role !== 'assistant' || typeof message.content === 'string'
      ? []
      : message.content.flatMap((block) =>
          block.type === 'tool_use' && block.name === 'investigate' && live.has(block.id)
            ? [block.input]
            : []
        )
  );
}

/**
 * Words after which a name is whom the words are for: "tell Atlas", "send to Atlas". Spoken
 * text is normalized first, which reads "to" as the number "2".
 */
const ADDRESSING = /(?:^| )(?:tell|ask|send(?: (?:to|2))?|message|have|get|ping) $/;

/**
 * Whether the developer named this agent as the one to send to: the router read it so, surely,
 * or their words address it: right after "tell", "ask", "send (to)", "message", "have", "get",
 * or as the leading vocative ("Bravo, run the tests"). A name said in passing ("tell Atlas what
 * Bravo found") is not whom the words are for.
 */
export function namesAgent(
  name: string,
  utterance: string,
  routerTarget: { choice: string; confidence: number } | null
): boolean {
  const wanted = normalizeSpoken(name);
  if (!wanted) return false;
  if (
    routerTarget &&
    routerTarget.confidence >= WAIVER_CONFIDENCE &&
    normalizeSpoken(routerTarget.choice) === wanted
  ) {
    return true;
  }
  // The leading vocative: the name, alone before the first comma.
  const [lead] = utterance.split(',');
  if (
    utterance.includes(',') &&
    normalizeSpoken(lead ?? '').replace(/^(?:hey|ok|okay) /, '') === wanted
  ) {
    return true;
  }
  const said = normalizeSpoken(utterance);
  for (let at = said.indexOf(wanted); at >= 0; at = said.indexOf(wanted, at + 1)) {
    const after = said.slice(at + wanted.length);
    const wholeWord = (at === 0 || said[at - 1] === ' ') && (after === '' || after.startsWith(' '));
    if (wholeWord && ADDRESSING.test(said.slice(0, at))) return true;
  }
  return false;
}

/** True when `brief` carries a run of words from a code check's result. */
export function quotesCodeCheck(brief: string, checks: readonly string[]): boolean {
  const said = ` ${words(brief).join(' ')} `;
  return checks.some((check) => {
    const read = words(check);
    for (let start = 0; start + QUOTE_WORDS <= read.length; start++) {
      if (said.includes(` ${read.slice(start, start + QUOTE_WORDS).join(' ')} `)) return true;
    }
    return false;
  });
}

/**
 * Whether a tool call in a turn tainted only by an earlier code check may run without asking:
 * it is the action the developer's words named, in a project the check read, and its brief asks
 * for nothing risky and quotes nothing the check returned.
 */
export function waivesCodeCheckTaint(call: {
  readonly tool: string;
  /** What the developer's words were read as (see `namedAction`). */
  readonly named: WaivableAction | null;
  readonly projectId: string | null;
  readonly checkedProjects: ReadonlySet<string>;
  readonly brief: string;
  readonly checks: readonly string[];
  /** For a send: the developer named the agent it goes to (see `namesAgent`). */
  readonly targetNamed?: boolean;
}): boolean {
  if (call.tool !== 'spawn_agent' && call.tool !== 'send_to_agent') return false;
  if (call.named !== call.tool) return false;
  if (call.tool === 'send_to_agent' && call.targetNamed !== true) return false;
  if (!call.projectId || !call.checkedProjects.has(call.projectId)) return false;
  if (RISKY_WORDS.test(call.brief)) return false;
  return !quotesCodeCheck(call.brief, call.checks);
}
