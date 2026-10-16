import type { JevAnswers } from '../jev';

/**
 * Compact, primitive-only summaries of Jev answers for the interaction trace, so every routing,
 * triage, completion, and plan-review decision can be audited and mined for edge cases later.
 */

type Detail = Record<string, string | number | boolean | null>;

const round = (value: number) => Math.round(value * 100) / 100;

/** "focus=.91 | status=.05 | close=.02" for a Choice or Score; the probability for a Noul. */
export function summarizeAnswer(answer: JevAnswers[string], top = 3): string | number {
  if (answer.type === 'noul') return round(answer.noul);
  const ranked = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([option, probability]) => `${option.slice(0, 60)}=${round(probability)}`);
  const head = answer.type === 'choice' ? answer.choice.slice(0, 60) : String(round(answer.score));
  return `${head} (${round(answer.confidence)})${ranked.length ? ` | ${ranked.join(' | ')}` : ''}`;
}

/** Answers flattened to `jev_<id>` detail fields; meta-sentence nouls are collapsed to one list. */
export function answersDetail(answers: JevAnswers): Detail {
  const detail: Detail = {};
  const meta: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (/^meta_\d+$/.test(id) && answer.type === 'noul') {
      meta.push(`${id.slice(5)}=${round(answer.noul)}`);
      continue;
    }
    detail[`jev_${id}`] = summarizeAnswer(answer);
  }
  if (meta.length > 0) detail.jev_meta = meta.join(' ');
  return detail;
}

/** Normalized entropy (0–1) of a Choice, for ranking uncertain decisions when mining. */
export function normalizedEntropy(probabilities: Readonly<Record<string, number>>): number {
  const values = Object.values(probabilities).filter((value) => value > 0);
  if (values.length <= 1) return 0;
  const entropy = -values.reduce((sum, value) => sum + value * Math.log(value), 0);
  return round(entropy / Math.log(values.length));
}

/**
 * Layout talk that goes to Claude's canvas tools without asking Jev. Long utterances and ones
 * that start by starting or messaging an agent still go through Jev ("spin up an agent to split
 * the panel layout" is a spawn, not a layout command).
 */
export function layoutBypass(text: string, layoutCue: boolean): boolean {
  if (!layoutCue) return false;
  const words = text.trim().split(/\s+/).length;
  if (words > 25) return false;
  return !/^(?:please\s+)?(?:spin up|start|create|launch|open (?:a|an|another) (?:new )?\w+ agent|tell|ask|send|message)\b/i.test(
    text.trim()
  );
}

/**
 * The developer asked the conductor to look something up before it acts ("check the code
 * first", "look it up before you write the prompt"). Jev would bind the action and run it at
 * once, so such an utterance goes to the model, which can look first. Only an explicit ask
 * counts: a term the developer did not explain is the model's call, not a routing rule.
 */
export function lookupBypass(text: string): boolean {
  return LOOKUP_CUES.test(text);
}

const LOOKUP_CUES =
  /\b(?:(?:check|look (?:at|in|into|through)|search|read|dig into)\s+(?:the |our |my )?(?:code|codebase|repo|repository|project files)\s+first|(?:check|look(?: it| that| this)? up|look into it|investigate|research)\s+(?:it |that |this )?(?:first|before (?:you|writing|sending|starting|you write|you send|you start))|before (?:you )?(?:write|send|start|spawn)\w*\b[^.]*\b(?:check|look (?:it |that )?up|look (?:at|in|into) the code|investigate)|find out what (?:that|this|it|\w+) (?:is|means|does)\b[^.]*\bfirst)/i;

/**
 * Obvious speech-to-text hallucinations (assistant-style apologies and video outros), caught
 * without a Jev round trip so they never reach Claude as a command.
 */
export function looksLikeSttArtifact(text: string): boolean {
  return /^(?:i'?m sorry,?\s+(?:but\s+)?i\s+(?:can(?:'|no)?t|cannot|am unable to|couldn'?t)\s+(?:hear|understand|process|make out)|(?:thanks|thank you) for watching|there (?:is|was) no (?:audio|speech)|(?:sure[,.!]?\s+)?please (?:provide|share) (?:the )?audio)/i.test(
    text.trim()
  );
}
