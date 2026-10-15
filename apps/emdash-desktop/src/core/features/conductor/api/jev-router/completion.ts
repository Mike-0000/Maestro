import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import { choiceOf, noulOf, type JevAnswers, type JevQuestions } from '../jev';
import { splitSentences } from './spans';

/**
 * The completion gate: before Claude narrates a finished agent's report, Jev reads it. A progress
 * ping with nothing new stays on the HUD, a clear result or question is spoken as the agent's own
 * best sentence, and only reports that need interpretation (terminal noise, a follow-up the
 * developer asked for, low confidence) still get a Claude turn. One request covers the batch.
 */

export const COMPLETION_KINDS = {
  done_with_result: 'Finished the task and reports a concrete result',
  needs_decision: 'Asks the developer a question or needs a decision before going on',
  blocked_or_failed: 'Could not finish: blocked, failed, or hit an error',
  progress_no_news: 'A progress note or restatement with no new result or question',
  terminal_prompt_only: 'Only terminal or interface output, no real report',
} as const;
export type CompletionKind = keyof typeof COMPLETION_KINDS;

/** Kind confidence needed to speak a report without Claude. */
export const COMPLETION_CONFIDENCE = 0.75;
/** Upper bound on a spoken extractive line. */
export const SPOKEN_MAX_CHARS = 220;
const MAX_REPORT_SENTENCES = 40;
const NO_QUESTION = '(none)';

export type CompletionCandidate = {
  readonly name: string;
  readonly task: string;
  readonly report: CompletionReport;
  /** The previous report from the same agent, when it reported before. */
  readonly previous: string | null;
};

export type CompletionVerdict =
  | { kind: 'silent'; hud: string; reason: string }
  | { kind: 'speak'; text: string; reason: string }
  /**
   * The model words it. `fallback` is the agent's own question or best sentence, said when the
   * model's turn fails: a bare "finished" says nothing about what the agent reported.
   */
  | { kind: 'llm'; reason: string; fallback?: string };

/** Report text as speakable sentences: markdown, code, and fragments removed. */
export function reportSentences(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '\n')
    .replace(/^\s*\|.*\|\s*$/gm, '\n');
  const sentences = splitSentences(cleaned, Number.MAX_SAFE_INTEGER)
    .map((sentence) => cleaned.slice(sentence.start, sentence.end).replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.split(' ').length >= 3)
    .map((sentence) => (sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence));
  if (sentences.length <= MAX_REPORT_SENTENCES) return sentences;
  return [...sentences.slice(0, 30), ...sentences.slice(-(MAX_REPORT_SENTENCES - 30))];
}

/** "Maple: Tests pass." trimmed for speech: URLs become "a link", cut at a word boundary. */
export function spokenLine(prefix: string, sentence: string, max = SPOKEN_MAX_CHARS): string {
  const text = `${prefix} ${sentence.replace(/https?:\/\/\S+/g, 'a link')}`.replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

function sentenceOptions(sentences: readonly string[]): Record<string, null> {
  return Object.fromEntries(
    sentences.map((sentence, index) => [
      `#${index} ${sentence.split(' ').slice(0, 8).join(' ')}`,
      null,
    ])
  );
}

function sentenceIndex(option: string): number | null {
  const match = /^#(\d+) /.exec(option);
  return match ? Number(match[1]) : null;
}

export type CompletionGate = {
  readonly state: Record<string, unknown>;
  readonly questions: JevQuestions;
  readonly sentences: readonly (readonly string[])[];
};

export function completionGateRequest(
  agents: readonly CompletionCandidate[],
  recentRequests: readonly string[]
): CompletionGate {
  const sentences = agents.map((agent) => reportSentences(agent.report.text));
  const questions: JevQuestions = {};
  agents.forEach((agent, i) => {
    const ref = `agents[${i}]`;
    questions[`a${i}_kind`] = {
      type: 'choice',
      instructions: `What is \`${ref}.report_sentences\`, the final message of a coding agent that just stopped?`,
      criteria: COMPLETION_KINDS,
    };
    if (agent.previous) {
      questions[`a${i}_novel`] = {
        type: 'noul',
        instructions: `Does \`${ref}.report_sentences\` say something new compared with \`${ref}.previous_report\` (a new result, error, or question)?`,
      };
    }
    const options = sentenceOptions(sentences[i] ?? []);
    if (Object.keys(options).length > 0) {
      questions[`a${i}_best`] = {
        type: 'choice',
        instructions: `Which one sentence of \`${ref}.report_sentences\` best tells the developer the outcome?`,
        criteria: options,
      };
      questions[`a${i}_question`] = {
        type: 'choice',
        instructions: `Which sentence of \`${ref}.report_sentences\` asks the developer to decide or answer something?`,
        criteria: { ...options, [NO_QUESTION]: 'It asks nothing' },
      };
    }
    questions[`a${i}_followup`] = {
      type: 'noul',
      instructions: `Did the developer, in \`recent_requests\`, ask Chorus to do something once \`${ref}.name\` finishes (open its app, check or test its work, send it more, explain its result in detail)?`,
    };
  });
  return {
    state: {
      agents: agents.map((agent, i) => ({
        name: agent.name,
        task: agent.task,
        report_sentences: sentences[i] ?? [],
        previous_report: agent.previous?.slice(0, 1_500) ?? '(none)',
      })),
      recent_requests: recentRequests.slice(-4),
    },
    questions,
    sentences,
  };
}

export function interpretCompletionGate(
  answers: JevAnswers,
  gate: CompletionGate,
  agents: readonly CompletionCandidate[]
): CompletionVerdict[] {
  return agents.map((agent, i) => {
    const sentences = gate.sentences[i] ?? [];
    const pick = (id: string): string | null => {
      const answer = choiceOf(answers, id);
      if (!answer || answer.confidence < 0.5) return null;
      const index = sentenceIndex(answer.choice);
      return index === null ? null : (sentences[index] ?? null);
    };
    const best = pick(`a${i}_best`);
    const asked = pick(`a${i}_question`);
    const fallback = asked
      ? spokenLine(`${agent.name} asks:`, asked)
      : best
        ? spokenLine(`${agent.name}:`, best)
        : null;
    const llm = (reason: string): CompletionVerdict =>
      fallback ? { kind: 'llm', reason, fallback } : { kind: 'llm', reason };
    const kind = choiceOf(answers, `a${i}_kind`);
    if (!kind) return llm('no-answer');
    if ((noulOf(answers, `a${i}_followup`) ?? 0) >= 0.5) {
      return llm('follow-up-requested');
    }
    const novel = noulOf(answers, `a${i}_novel`);
    const confident = kind.confidence >= COMPLETION_CONFIDENCE;
    const quiet = (reason: string): CompletionVerdict => ({
      kind: 'silent',
      hud: spokenLine(`${agent.name}:`, best ?? `finished "${agent.task}" with nothing new.`),
      reason,
    });
    const choice = kind.choice as CompletionKind;
    if (choice === 'progress_no_news' && confident && (novel === null || novel < 0.5)) {
      return quiet('no-news');
    }
    if (
      novel !== null &&
      novel < 0.3 &&
      (choice === 'done_with_result' || choice === 'progress_no_news')
    ) {
      return quiet('repeat');
    }
    if (!confident) return llm('low-confidence');
    if (agent.report.source === 'terminal-tail') return llm('terminal-tail');
    if (choice === 'terminal_prompt_only') return llm('terminal-only');
    if (choice === 'needs_decision' && asked) {
      return { kind: 'speak', text: spokenLine(`${agent.name} asks:`, asked), reason: choice };
    }
    if (!best) return llm('no-sentence');
    const prefix = choice === 'blocked_or_failed' ? `${agent.name} is stuck:` : `${agent.name}:`;
    return { kind: 'speak', text: spokenLine(prefix, best), reason: choice };
  });
}
