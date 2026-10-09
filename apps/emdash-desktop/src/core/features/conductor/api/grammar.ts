import type { CanvasRefContext } from './canvas-refs';
import { parseCanvasCommand, type CanvasAction } from './grammar-canvas';
import {
  isDeictic,
  normalizeSpoken,
  resolveAgent,
  startsWithProjectScope,
  type RosterAgent,
} from './resolver';

/**
 * Deterministic fast path for the most common spoken commands. It runs before any model call:
 * zero latency, zero cost, and fully testable. Anything it does not recognise returns null and
 * goes to the LLM conductor.
 */
export type GrammarCommand =
  | { kind: 'confirm' }
  | { kind: 'reject' }
  | { kind: 'next' }
  | { kind: 'overview' }
  | { kind: 'submit' }
  | { kind: 'mute' }
  | { kind: 'unmute' }
  | { kind: 'note'; text: string }
  | { kind: 'focus'; agent: RosterAgent }
  | { kind: 'interrupt'; agent: RosterAgent }
  | { kind: 'status'; agent: RosterAgent }
  | { kind: 'send'; agent: RosterAgent; text: string }
  /** Hide an agent's window; the agent keeps running. `null` means "whatever is in front of me". */
  | { kind: 'close'; agent: RosterAgent | null }
  | { kind: 'closeMany'; scope: CloseScope }
  /** Bring closed windows back: one agent, the most recently closed, or all of them. */
  | { kind: 'reopen'; target: RosterAgent | 'last' | 'all' }
  /** Stop an agent's session entirely (needs confirmation). */
  | { kind: 'kill'; agent: RosterAgent }
  /** Archive an agent's conversation (needs confirmation). */
  | { kind: 'archive'; agent: RosterAgent }
  /** Answer an agent's permission prompt (needs confirmation). */
  | { kind: 'permission'; agent: RosterAgent; decision: 'allow' | 'deny' }
  | { kind: 'help' }
  /** Canvas layout: regions, moves, sizes, the stage, and layout undo. */
  | { kind: 'canvas'; action: CanvasAction }
  | { kind: 'clarify'; question: string };

/** "close all", "close the others", "close the finished ones". */
export type CloseScope = 'all' | 'others' | 'done';

const LEADING_FILLER =
  /^(?:(?:uh+|um+|er+|ok(?:ay)?|so|hey|hi|chorus|please|alright|all right)[,.!]?\s+)+/i;
const TRAILING_FILLER = /[\s,]+(?:please|thanks|thank you)[.!]?$/i;

const CONFIRM =
  /^(?:yes|yeah|yep|yup|approve|approved|confirm|do it|go ahead|go|allow(?: it)?|ok go|send it off)$/;
const REJECT =
  /^(?:no|nope|deny|cancel|never ?mind|reject|don'?t|stop|stop that|abort|wait|hold on|hold it|scratch that|forget it|forget that)$/;
const NEXT = /^(?:next|next one|next agent|what'?s next|who needs me|who'?s waiting)$/;
const OVERVIEW =
  /^(?:show (?:me )?(?:all|everything|everyone|all agents|the whole board)|overview|zoom out|fit(?: all)?|show all agents)$/;
const SUBMIT = /^(?:send it|submit|submit it|enter|hit enter|press enter)$/;
const MUTE = /^(?:mute|be quiet|quiet|stop talking|shut up)$/;
const UNMUTE = /^(?:unmute|talk to me|speak)$/;
const NOTE = /^(?:take a note|add a note|note)[:,]?\s+(.+)$/i;
const FOCUS =
  /^(?:focus(?: on)?|go to|open|show(?: me)?|zoom (?:in )?(?:on|to)|switch to|jump to|look at)\s+(.+)$/i;
const INTERRUPT = /^(?:stop|interrupt|pause|halt|escape)\s+(.+)$/i;
const STATUS =
  /^(?:what(?:'?s| is)\s+(.+?)\s+doing|how(?:'?s| is)\s+(.+?)\s+doing|status (?:of|for)\s+(.+)|is\s+(.+?)\s+(?:done|finished))$/i;
const TELL = /^(?:tell|ask)\s+(.+)$/i;

// Window and agent management. These run on the utterance with a polite lead-in removed
// ("can you close Atlas"), which the older commands never needed.
const POLITE = /^(?:(?:can|could|would) you|i want to|i'd like to|let'?s|go ahead and|just)\s+/i;
const HELP =
  /^(?:help|help me|what can i say|what can you do|what do you understand|(?:list |show |voice )?commands|how do i use (?:this|you))$/;
const CLOSE_VERB = '(?:close|hide|dismiss|remove|minimi[sz]e|put away|get rid of|close out)';
const CLOSE = new RegExp(`^${CLOSE_VERB}(?:\\s+(.+?))?$`, 'i');
const CLOSE_ALL = new RegExp(
  `^${CLOSE_VERB}\\s+(?:all|everything|everyone|every (?:agent|window)|all (?:of )?(?:them|the agents|the windows|agents|windows))$`,
  'i'
);
const CLOSE_OTHERS = new RegExp(
  `^${CLOSE_VERB}\\s+(?:(?:all )?(?:the )?others|everything else|every other (?:agent|window)|all (?:the )?other (?:agents|windows|ones)|the rest|all but (?:this|this one|the focused one|the current one))$`,
  'i'
);
const CLOSE_DONE = new RegExp(
  `^${CLOSE_VERB}\\s+(?:all )?(?:the )?(?:finished|done|completed|idle|stopped)(?: (?:ones|agents|windows))?$`,
  'i'
);
const REOPEN_ALL =
  /^(?:(?:reopen|re open|restore|unhide|bring back) (?:all|everything|everyone|all (?:of )?(?:them|the agents|the windows|agents|windows))|bring (?:them|everything|everyone|all of them) back|show (?:the )?(?:hidden|closed)(?: (?:ones|agents|windows))?)$/i;
const REOPEN_LAST =
  /^(?:reopen|re open|restore|unhide|undo|undo (?:that|close|the close)|bring (?:it|that) back|reopen (?:it|that|the last one|last))$/i;
const REOPEN = /^(?:reopen|re open|restore|unhide|bring back|un ?close)\s+(.+)$/i;
const REOPEN_BACK = /^bring\s+(.+?)\s+back$/i;
const KILL = /^(?:kill|terminate|shut down|force quit)\s+(.+?)(?:'s session| session)?$/i;
const KILL_DOWN = /^shut\s+(.+?)\s+down$/i;
const ARCHIVE = /^archive\s+(.+)$/i;
const DELETE = /^(?:delete|destroy|trash)\s+(.+)$/i;
const PERMISSION_TAIL = String.raw`(?:'s)?(?:\s+(?:request|permission|prompt))?$`;
const ALLOW = new RegExp(
  String.raw`^(?:allow|approve|accept|grant|permit)\s+(.+?)` + PERMISSION_TAIL,
  'i'
);
const DENY = new RegExp(String.raw`^(?:deny|decline|refuse|block)\s+(.+?)` + PERMISSION_TAIL, 'i');

function clean(utterance: string): string {
  return utterance
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(LEADING_FILLER, '')
    .replace(TRAILING_FILLER, '')
    .replace(/[.!?,]+$/, '')
    .trim();
}

function key(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function describeCandidates(candidates: readonly RosterAgent[]): string {
  const names = candidates.map((agent) => agent.name);
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

function resolveOrClarify(
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): RosterAgent | { question: string } | null {
  const resolution = resolveAgent(reference, roster, focusedId);
  if (resolution.kind === 'match') return resolution.agent;
  if (resolution.kind === 'ambiguous') {
    return { question: `Which one: ${describeCandidates(resolution.candidates)}?` };
  }
  return null;
}

/** A command aimed at one agent: resolved, a clarifying question, or not ours (null). */
function target(
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): RosterAgent | { question: string } | null {
  const agent = resolveOrClarify(reference, roster, focusedId);
  if (agent) return agent;
  if (isDeictic(reference)) return { question: 'Which agent? None is focused right now.' };
  return null;
}

type Targeted = 'reopen' | 'kill' | 'archive';

function targeted(
  kind: Targeted,
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): GrammarCommand | null {
  const agent = target(reference, roster, focusedId);
  if (!agent) return null;
  if ('question' in agent) return { kind: 'clarify', question: agent.question };
  return kind === 'reopen' ? { kind, target: agent } : { kind, agent };
}

/** Window and agent management: close, reopen, stop, archive, allow/deny, help. */
function parseWindowCommand(
  text: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): GrammarCommand | null {
  if (HELP.test(key(text))) return { kind: 'help' };
  if (CLOSE_ALL.test(text)) return { kind: 'closeMany', scope: 'all' };
  if (CLOSE_OTHERS.test(text)) return { kind: 'closeMany', scope: 'others' };
  if (CLOSE_DONE.test(text)) return { kind: 'closeMany', scope: 'done' };
  if (REOPEN_ALL.test(text)) return { kind: 'reopen', target: 'all' };
  if (REOPEN_LAST.test(text)) return { kind: 'reopen', target: 'last' };

  const close = CLOSE.exec(text);
  if (close) {
    const reference = close[1]?.trim() ?? '';
    if (!reference || isDeictic(reference)) return { kind: 'close', agent: null };
    const agent = resolveOrClarify(reference, roster, focusedId);
    if (agent && 'question' in agent) return { kind: 'clarify', question: agent.question };
    return agent ? { kind: 'close', agent } : null;
  }

  const reopen = REOPEN.exec(text) ?? REOPEN_BACK.exec(text);
  if (reopen?.[1]) return targeted('reopen', reopen[1], roster, focusedId);
  const kill = KILL.exec(text) ?? KILL_DOWN.exec(text);
  if (kill?.[1]) return targeted('kill', kill[1], roster, focusedId);
  const archive = ARCHIVE.exec(text);
  if (archive?.[1]) return targeted('archive', archive[1], roster, focusedId);

  const remove = DELETE.exec(text);
  if (remove?.[1]) {
    const agent = target(remove[1], roster, focusedId);
    if (!agent) return null;
    if ('question' in agent) return { kind: 'clarify', question: agent.question };
    return {
      kind: 'clarify',
      question:
        `Say "close ${agent.name}" to hide its window and keep it running, ` +
        `or "archive ${agent.name}" to put it away for good.`,
    };
  }

  for (const [pattern, decision] of [
    [ALLOW, 'allow'],
    [DENY, 'deny'],
  ] as const) {
    const permission = pattern.exec(text);
    if (!permission?.[1]) continue;
    const agent = target(permission[1], roster, focusedId);
    if (agent && 'question' in agent) return { kind: 'clarify', question: agent.question };
    if (agent) return { kind: 'permission', agent, decision };
  }
  return null;
}

/** Longest reference tried: "the latest claude code agent in the ace combat project". */
const MAX_REFERENCE_WORDS = 9;

type Split = {
  agent: RosterAgent;
  text: string;
  refEndsWithTo: boolean;
  connector: boolean;
  /** The reference only resembled the agent's name; a reading that is a name is preferred. */
  fuzzy: boolean;
};

/**
 * Splits "codex to run the tests" / "claude two to fix lint" into an agent and an instruction,
 * trying the longest agent reference first. A reference that only matched because "to" was read
 * as "two" is used only when no shorter reading works. A reference that merely resembles a name
 * loses to one that is a name, so "Lima 3 how much…" is Lima 3 plus "how much…", not "Lima 3 how".
 */
function splitAddressed(
  rest: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): Split | { question: string } | null {
  const words = rest.split(/\s+/).filter(Boolean);
  const splits: Split[] = [];
  let ambiguity: { question: string } | null = null;
  for (let k = Math.min(MAX_REFERENCE_WORDS, words.length - 1); k >= 1; k--) {
    const reference = words.slice(0, k).join(' ');
    const lastWord = (words[k - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
    let remainder = words.slice(k);
    // Never split a name from its number ("claude | 3 to deploy").
    if (
      /^\d+$/.test(normalizeSpoken(remainder[0] ?? '')) &&
      !/^(?:to|too)$/i.test(remainder[0] ?? '')
    ) {
      continue;
    }
    // "Atlas | in chorus to run…": the scope belongs to the reference, not to the message. The
    // longer reading resolves it, or nobody matches and the model sorts it out.
    if (startsWithProjectScope(remainder, roster)) continue;
    const connector = /^(?:to|that)$/i.test(remainder[0] ?? '');
    if (connector) remainder = remainder.slice(1);
    const text = remainder.join(' ').trim();
    if (!text) continue;
    const resolution = resolveAgent(reference, roster, focusedId);
    if (resolution.kind === 'match') {
      splits.push({
        agent: resolution.agent,
        text,
        refEndsWithTo: /^(?:to|too)$/.test(lastWord),
        connector,
        fuzzy: resolution.fuzzy === true,
      });
    } else if (resolution.kind === 'ambiguous' && !ambiguity) {
      ambiguity = { question: `Which one: ${describeCandidates(resolution.candidates)}?` };
    }
  }
  // Among readings that only resemble a name, the shortest keeps the most of the message.
  const preferred =
    splits.find((split) => !split.refEndsWithTo && !split.fuzzy) ??
    [...splits].reverse().find((split) => !split.refEndsWithTo);
  if (preferred) return preferred;
  // "Claude too to run…": a name read with a trailing to/too counts as "2" only when a connector
  // still follows it; "tell Claude to run…" stays ambiguous instead of guessing Claude 2.
  const numbered = splits.find((split) => split.refEndsWithTo && split.connector);
  if (numbered) return numbered;
  if (ambiguity) return ambiguity;
  return splits[0] ?? null;
}

export function parseCommand(
  utterance: string,
  roster: readonly RosterAgent[],
  focusedId: string | null,
  canvas?: CanvasRefContext
): GrammarCommand | null {
  const text = clean(utterance);
  if (!text) return null;
  const normalized = key(text);

  if (CONFIRM.test(normalized)) return { kind: 'confirm' };
  if (REJECT.test(normalized)) return { kind: 'reject' };
  if (NEXT.test(normalized)) return { kind: 'next' };
  if (OVERVIEW.test(normalized)) return { kind: 'overview' };
  if (SUBMIT.test(normalized)) return { kind: 'submit' };
  if (MUTE.test(normalized)) return { kind: 'mute' };
  if (UNMUTE.test(normalized)) return { kind: 'unmute' };

  const note = NOTE.exec(text);
  if (note?.[1]) return { kind: 'note', text: note[1].trim() };

  if (canvas) {
    const layout = parseCanvasCommand(text.replace(POLITE, ''), canvas);
    if (layout) return layout;
  }

  const windowCommand = parseWindowCommand(text.replace(POLITE, ''), roster, focusedId);
  if (windowCommand) return windowCommand;

  const status = STATUS.exec(text);
  if (status) {
    const reference = status[1] ?? status[2] ?? status[3] ?? status[4] ?? '';
    const agent = resolveOrClarify(reference, roster, focusedId);
    if (agent && 'question' in agent) return { kind: 'clarify', question: agent.question };
    if (agent) return { kind: 'status', agent };
    return null;
  }

  const focus = FOCUS.exec(text);
  if (focus?.[1]) {
    const agent = resolveOrClarify(focus[1], roster, focusedId);
    if (agent && 'question' in agent) return { kind: 'clarify', question: agent.question };
    if (agent) return { kind: 'focus', agent };
    return null;
  }

  const interrupt = INTERRUPT.exec(text);
  if (interrupt?.[1]) {
    const agent = resolveOrClarify(interrupt[1], roster, focusedId);
    if (agent && 'question' in agent) return { kind: 'clarify', question: agent.question };
    if (agent) return { kind: 'interrupt', agent };
    return null;
  }

  const tell = TELL.exec(text);
  if (tell?.[1]) {
    const split = splitAddressed(tell[1], roster, focusedId);
    if (split && 'question' in split) return { kind: 'clarify', question: split.question };
    if (split) return { kind: 'send', agent: split.agent, text: split.text };
    return null;
  }

  // Vocative form: "Claude 2, run the tests." Requires the comma the recognizer inserts.
  const vocative = /^([^,]{2,40}),\s*(.+)$/.exec(text);
  if (vocative?.[1] && vocative[2]) {
    // Names only: any opening clause could match a task ("Sure, please…" against "Make sure…").
    const resolution = resolveAgent(vocative[1], roster, focusedId, 'name');
    if (resolution.kind === 'match' && !resolution.fuzzy) {
      return { kind: 'send', agent: resolution.agent, text: vocative[2].trim() };
    }
  }
  return null;
}

const PLAN_CUES =
  /\b(?:plan|split|parallel|in parallel|break (?:it|this|that) (?:down|up)|spin up|several agents|multiple agents|a few agents|team of|fan out|divide)\b/i;
const BUILD_VERBS =
  /^(?:(?:let'?s|we need to|i want to|i'd like to|can you|could you|go|please)\s+)*(?:build|implement|add|create|refactor|migrate|rewrite|port|redesign|set up)\b/i;

/**
 * Chooses the conductor's reasoning effort for an utterance: "plan" for goals that likely need
 * decomposing into several agents, "command" (fast) for everything else.
 */
export function chooseMode(utterance: string): 'command' | 'plan' {
  const text = clean(utterance);
  if (PLAN_CUES.test(text)) return 'plan';
  const words = text.split(/\s+/).filter(Boolean).length;
  return BUILD_VERBS.test(text) && words >= 8 ? 'plan' : 'command';
}
