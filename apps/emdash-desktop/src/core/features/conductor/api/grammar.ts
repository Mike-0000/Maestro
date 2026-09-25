import { normalizeSpoken, resolveAgent, type RosterAgent } from './resolver';

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
  | { kind: 'clarify'; question: string };

const LEADING_FILLER =
  /^(?:(?:uh+|um+|er+|ok(?:ay)?|so|hey|hi|chorus|please|alright|all right)[,.!]?\s+)+/i;
const TRAILING_FILLER = /[\s,]+(?:please|thanks|thank you)[.!]?$/i;

const CONFIRM =
  /^(?:yes|yeah|yep|yup|approve|approved|confirm|do it|go ahead|go|allow(?: it)?|ok go|send it off)$/;
const REJECT = /^(?:no|nope|deny|cancel|never ?mind|reject|don'?t|stop that|abort)$/;
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

function clean(utterance: string): string {
  return utterance
    .trim()
    .replace(LEADING_FILLER, '')
    .replace(TRAILING_FILLER, '')
    .replace(/[.!?]+$/, '')
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

type Split = { agent: RosterAgent; text: string; refEndsWithTo: boolean };

/**
 * Splits "codex to run the tests" / "claude two to fix lint" into an agent and an instruction,
 * trying the longest agent reference first. A reference that only matched because "to" was read
 * as "two" is used only when no shorter reading works.
 */
function splitAddressed(
  rest: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): Split | { question: string } | null {
  const words = rest.split(/\s+/).filter(Boolean);
  const splits: Split[] = [];
  let ambiguity: { question: string } | null = null;
  for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
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
    if (/^(?:to|that)$/i.test(remainder[0] ?? '')) remainder = remainder.slice(1);
    const text = remainder.join(' ').trim();
    if (!text) continue;
    const resolution = resolveAgent(reference, roster, focusedId);
    if (resolution.kind === 'match') {
      splits.push({ agent: resolution.agent, text, refEndsWithTo: /^(?:to|too)$/.test(lastWord) });
    } else if (resolution.kind === 'ambiguous' && !ambiguity) {
      ambiguity = { question: `Which one: ${describeCandidates(resolution.candidates)}?` };
    }
  }
  const preferred = splits.find((split) => !split.refEndsWithTo);
  if (preferred) return preferred;
  if (ambiguity) return ambiguity;
  return splits[0] ?? null;
}

export function parseCommand(
  utterance: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
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
    const resolution = resolveAgent(vocative[1], roster, focusedId);
    if (resolution.kind === 'match') {
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
