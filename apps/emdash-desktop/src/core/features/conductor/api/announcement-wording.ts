import { completionSentence, taskNamePhrase } from '@core/primitives/agents/api/completion-summary';

/**
 * The fixed (no model) wording of announcements, work first: the task's title leads and the
 * agent's name follows once as a handle ("TTS research is finished. Kilo researched…", "Login fix
 * needs permission, on Atlas."). Where the title would add nothing, `completionSentence` stays
 * the sentence, as it always was.
 */

/** Words too small to count when checking whether a summary already says the title. */
const MINOR_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

/** The offer appended when exactly one agent finished and the caller asks for it. */
export const ANNOUNCEMENT_OFFER = 'Want to see it?';

/** One sentence for a finished agent, led by its task's title when that adds something. */
export function finishedSentence(agent: {
  readonly name: string;
  readonly taskName: string;
  readonly completionSummary: string | null;
}): string {
  const base = completionSentence(agent.name, agent.completionSummary, agent.taskName);
  const summary = agent.completionSummary;
  const title = spokenTitle(agent.name, agent.taskName);
  // Title only, or nothing usable: the sentence already names the work, or there is none.
  if (!summary || !title || saysTitle(summary, title.words)) return base;
  const lead = `${title.lead} is finished`;
  // completionSentence speaks a past-tense summary as "Kilo researched…".
  if (base.startsWith(`${agent.name} finished: `)) {
    return `${lead}, on ${agent.name}: ${summary}.`.replace(/\s+\./, '.');
  }
  return `${lead}. ${base}`;
}

/** One sentence for a single waiting agent, led by its task's title when it has one. */
export function waitingSentence(agent: {
  readonly name: string;
  readonly taskName: string;
  /** "needs permission", "needs you", "hit an error". */
  readonly phrase: string;
  /** " for something risky", ", low risk", or ''. */
  readonly suffix: string;
}): string {
  const title = spokenTitle(agent.name, agent.taskName);
  return title
    ? `${title.lead} ${agent.phrase}${agent.suffix}, on ${agent.name}.`
    : `${agent.name} ${agent.phrase}${agent.suffix}.`;
}

/** Ends the text with one offer a yes settles, only when asked and exactly one agent finished. */
export function withOffer(text: string, finishedCount: number, offer: boolean): string {
  return offer && finishedCount === 1 ? `${text} ${ANNOUNCEMENT_OFFER}` : text;
}

/**
 * The task's title as the subject of a sentence, or null for a generic one ("New task"). A title
 * that is an instruction ("Build a todo app") is said as what it is doing ("Building a todo app"),
 * phrased as `completionSentence` phrases it, and its verb is left out of `words`: a summary
 * says it in the past tense ("built…"), which is no reason to lead with the title.
 */
function spokenTitle(name: string, taskName: string): { lead: string; words: string } | null {
  const title = taskNamePhrase(taskName);
  if (!title) return null;
  const fromTask = completionSentence(name, null, taskName);
  const prefix = `${name} finished `;
  if (fromTask.startsWith(prefix) && !fromTask.startsWith(`${prefix.trimEnd()}:`)) {
    const doing = fromTask.slice(prefix.length).replace(/\.$/, '');
    return { lead: capitalize(doing), words: doing.split(' ').slice(1).join(' ') };
  }
  return { lead: capitalize(title), words: title };
}

/** True when every word of the title already appears in the summary, so leading with it doubles. */
function saysTitle(summary: string, title: string): boolean {
  const said = new Set(words(summary));
  const needed = words(title).filter((word) => !MINOR_WORDS.has(word));
  return needed.length > 0 && needed.every((word) => said.has(word));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9'+#-]+/)
    .filter(Boolean);
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
