import { JEV_MAX_CHOICE_OPTIONS, type JevQuestions, type JevRubric } from '../jev';
import type { RosterAgent } from '../resolver';
import {
  buildCatalog,
  FOCUSED_PROJECT,
  INTENT_RUBRICS,
  liveSentinels,
  NOT_MENTIONED,
  providerRubric,
  rankedProjects,
  SAME_AS_LAST,
  SENTINEL,
  type Catalog,
  type RouterInput,
} from './catalog';
import { confusableNames } from './confusable';
import {
  endOptions,
  spanStarts,
  splitSentences,
  startOptions,
  type Sentence,
  type SpanStart,
} from './spans';

/**
 * One Jev request per utterance, fanned out: who the utterance is for, each slot of the action
 * (intent, target, project, provider, how many agents, the flags), the joint action catalog, the
 * message span, and correction binders — ~20–60 questions answered in parallel in one round trip.
 */

export const ADDRESSEE = {
  command: 'command_for_chorus',
  answer: 'answer_to_conductor_question',
  conversation: 'conversation_with_conductor',
  correction: 'correction_of_last_action',
  cancel: 'cancel_or_undo',
  artifact: 'transcription_artifact',
} as const;

export const CORRECTION_SLOTS = ['target', 'project', 'provider', 'content', 'none'] as const;
export type CorrectionSlot = (typeof CORRECTION_SLOTS)[number];

export const AGENT_COUNT_LEVELS = [
  'No new agent, or exactly one',
  'Two new agents',
  'Three new agents',
  'Four or more new agents',
] as const;

/** Per-sentence "meant for Chorus" checks (one Noul each). */
export const MAX_META_QUESTIONS = 30;

/** Everything the policy needs to turn answers back into actions. */
export type RouterPlan = {
  readonly input: RouterInput;
  readonly catalog: Catalog;
  readonly targets: ReadonlyMap<string, RosterAgent | string>;
  readonly sentences: readonly Sentence[];
  readonly starts: ReadonlyMap<string, SpanStart>;
  readonly ends: ReadonlyMap<string, number>;
  readonly confusable: ReadonlyMap<string, readonly string[]>;
};

export type RouterRequest = {
  readonly state: Record<string, unknown>;
  readonly questions: JevQuestions;
  readonly plan: RouterPlan;
};

function agentRubric(agent: RosterAgent, confusable: readonly string[] | undefined) {
  const what = `${agent.providerLabel} agent working on "${agent.taskName}"${agent.hidden ? ' (window closed)' : ''}`;
  return confusable?.length
    ? { what, not_for: `${confusable.join(' or ')}: a different agent with a similar name` }
    : what;
}

const SENTINEL_RUBRICS: Record<string, string> = {
  [SENTINEL.justStarted]:
    '`conversation.last_spawned`: "it" or "that agent" right after starting one',
  [SENTINEL.lastMessaged]:
    '`conversation.last_addressed`: the agent the developer was just dealing with',
  [SENTINEL.justReported]:
    '`conversation.last_reported`: the agent that just finished and reported',
  [SENTINEL.focused]: 'The `focused` agent: "this one", "here"',
  [SENTINEL.several]: 'Two or more specific agents',
  [SENTINEL.all]: 'Every agent',
  [SENTINEL.newAgent]: 'An agent that is to be started; it does not exist yet',
  [SENTINEL.unknownName]: 'An agent name that is not in this list (a mishearing or a typo)',
  [SENTINEL.none]: 'The utterance is not about an agent',
};

export function routerState(input: RouterInput, sentences: readonly Sentence[]) {
  const { context } = input;
  return {
    utterance: input.utterance,
    focused: input.focused?.name ?? '(none)',
    sentences: sentences.map((sentence) => input.utterance.slice(sentence.start, sentence.end)),
    conversation: {
      last_conductor_reply: context.lastReply ?? '(none)',
      last_conductor_asked_question: context.awaitingAnswer,
      last_spawned: context.lastSpawned
        ? {
            agent: context.lastSpawned.name,
            provider: context.lastSpawned.providerLabel,
            project: context.lastSpawned.projectName ?? '(default)',
            task: context.lastSpawned.taskName,
          }
        : '(none)',
      last_sent: context.lastSent
        ? { agent: context.lastSent.name, text: context.lastSent.text.slice(0, 300) }
        : '(none)',
      last_action: context.lastAction ?? '(none)',
      last_addressed: context.lastAddressed?.name ?? '(none)',
      last_reported: context.lastReported?.name ?? '(none)',
      recent_requests: context.recentUtterances.slice(-3),
    },
  };
}

export function buildRouterRequest(input: RouterInput): RouterRequest {
  const sentences = splitSentences(input.utterance);
  const starts = startOptions(input.utterance, sentences, spanStarts(input.utterance, sentences));
  const ends = endOptions(input.utterance, sentences);
  const confusable = confusableNames(input.roster);
  const catalog = buildCatalog(input);

  const sentinels = liveSentinels(input);
  const targets = new Map<string, RosterAgent | string>();
  const targetCriteria: Record<string, JevRubric> = {};
  const visibleFirst = [...input.roster].sort(
    (a, b) => Number(a.hidden ?? false) - Number(b.hidden ?? false)
  );
  for (const agent of visibleFirst.slice(0, JEV_MAX_CHOICE_OPTIONS - sentinels.length)) {
    targets.set(agent.name, agent);
    targetCriteria[agent.name] = agentRubric(agent, confusable.get(agent.name));
  }
  for (const sentinel of sentinels) {
    targets.set(sentinel, sentinel);
    targetCriteria[sentinel] = SENTINEL_RUBRICS[sentinel] ?? sentinel;
  }

  const projectCriteria: Record<string, JevRubric> = {};
  for (const project of rankedProjects(input).slice(0, JEV_MAX_CHOICE_OPTIONS - 3)) {
    projectCriteria[project.name] = `The ${project.name} project`;
  }
  projectCriteria[FOCUSED_PROJECT] =
    'The project of the `focused` agent: "here", "this project", "the same project"';
  projectCriteria[NOT_MENTIONED] = 'No project is named or implied';
  if (input.context.lastSpawned) {
    projectCriteria[SAME_AS_LAST] = 'The project of `conversation.last_spawned`';
  }

  const providerCriteria: Record<string, JevRubric> = {};
  for (const provider of input.providers.slice(0, JEV_MAX_CHOICE_OPTIONS - 2)) {
    providerCriteria[provider.label] = providerRubric(provider);
  }
  providerCriteria[NOT_MENTIONED] = 'No agent provider is named';
  if (input.context.lastSpawned) {
    providerCriteria[SAME_AS_LAST] = 'The provider of `conversation.last_spawned`';
  }

  const questions: JevQuestions = {
    addressee: {
      type: 'choice',
      instructions:
        'The `utterance` is a speech transcript from a developer who controls coding agents through Chorus, a voice assistant. What is it?',
      criteria: {
        [ADDRESSEE.command]: 'A new command for Chorus about agents, projects, or the canvas',
        [ADDRESSEE.answer]:
          'An answer to the question in `conversation.last_conductor_reply` (only when it asked one)',
        [ADDRESSEE.conversation]: 'A question, idea, or remark for Chorus itself; not a command',
        [ADDRESSEE.correction]:
          'Fixes the last action: "no, send that to Tango", "I meant in the Chorus project", "do it again with Codex"',
        [ADDRESSEE.cancel]: 'Cancel, undo, or never mind',
        [ADDRESSEE.artifact]:
          'Not something a developer said: an assistant-style apology, silence filler, "thank you for watching", or a repeated fragment',
      },
    },
    stt_artifact: {
      type: 'noul',
      instructions:
        'Is the `utterance` a speech-to-text artifact (an assistant-style apology like "I\'m sorry, I can\'t hear any audio", filler, or a repeated fragment) rather than something a developer said?',
    },
    answers_question: {
      type: 'noul',
      instructions:
        'Is the `utterance` answering the question Chorus asked in `conversation.last_conductor_reply`?',
    },
    correction_slot: {
      type: 'choice',
      instructions:
        'If the `utterance` corrects the last action (`conversation.last_action`), what does it change?',
      criteria: {
        target: 'Which agent: "send that to Tango instead"',
        project: 'Which project: "create that again but in Chorus"',
        provider: 'Which agent provider: "do that with Codex instead"',
        content: 'What was said or asked: "no, tell it to use Postgres"',
        none: 'It does not correct the last action',
      },
    },
    intent: {
      type: 'choice',
      instructions:
        'What does the developer want Chorus to do? Use `conversation` to understand "it", "that", and "again".',
      criteria: INTENT_RUBRICS,
    },
    target: {
      type: 'choice',
      instructions:
        'Which existing agent is the `utterance` about? Transcripts mishear names ("clod" is Claude, "codecs" is Codex). "It" or "that agent" usually means the agent in `conversation` the developer was just dealing with.',
      criteria: targetCriteria,
    },
    project: {
      type: 'choice',
      instructions: 'Which project does the `utterance` put new work in?',
      criteria: projectCriteria,
    },
    provider: {
      type: 'choice',
      instructions:
        'Which coding agent provider does the `utterance` name for new work? Transcripts mishear names.',
      criteria: providerCriteria,
    },
    agent_count: {
      type: 'score',
      instructions: 'How many new agents does the `utterance` ask to start?',
      criteria: [...AGENT_COUNT_LEVELS],
    },
    blank_prompt: {
      type: 'noul',
      instructions:
        'Does the developer want a new agent started with no task yet ("leave it blank", "I\'ll give it a prompt in a second")?',
    },
    wants_verbatim: {
      type: 'noul',
      instructions:
        "Should the agent receive the developer's own words as they are, rather than a message Chorus writes?",
    },
    worktree: {
      type: 'noul',
      instructions: 'Does the developer ask for a new git worktree or branch for new work?',
    },
    submit: {
      type: 'noul',
      instructions:
        'Should the message be sent (typed and Enter pressed) rather than only typed into the agent?',
    },
    action: {
      type: 'choice',
      instructions:
        'Which single action carries out the `utterance`? Pick an "other" option when Chorus must write text, explain, plan, or do several things.',
      criteria: catalog.criteria,
    },
    body_start: {
      type: 'choice',
      instructions:
        'If the `utterance` gives a message or task for a coding agent, where does that message begin? Skip words addressed to Chorus ("tell Maple to", "spin up a Codex agent that").',
      criteria: Object.fromEntries([...starts.keys()].map((key) => [key, null])),
    },
    body_end: {
      type: 'choice',
      instructions:
        'Where does that message end? Stop before trailing words addressed to Chorus ("and focus it", "can you change the model first?").',
      criteria: Object.fromEntries([...ends.keys()].map((key) => [key, null])),
    },
  };
  for (const sentence of sentences.slice(0, MAX_META_QUESTIONS)) {
    questions[`meta_${sentence.index}`] = {
      type: 'noul',
      instructions: `Is \`sentences[${sentence.index}]\` addressed to Chorus (which agent, which project, how to send, a question to Chorus) rather than content the coding agent should receive?`,
    };
  }

  return {
    state: routerState(input, sentences),
    questions,
    plan: { input, catalog, targets, sentences, starts, ends, confusable },
  };
}
