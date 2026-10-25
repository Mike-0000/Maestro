import type { ConductorMode } from '../contract';
import type { CloseScope } from '../grammar';
import { choiceOf, noulOf, type JevAnswer, type JevAnswers } from '../jev';
import { unknownSpokenNames, type RosterAgent } from '../resolver';
import {
  catalogKey,
  DESTRUCTIVE_INTENTS,
  DIRECT_CLASS,
  FOCUSED_PROJECT,
  INTENT_RUBRICS,
  NOT_MENTIONED,
  SAME_AS_LAST,
  SENTINEL,
  sentinelReferent,
  type ProjectOption,
  type ProviderOption,
  type RouterIntent,
} from './catalog';
import { confusableSplit } from './confusable';
import { ADDRESSEE, AGENT_COUNT_LEVELS, type RouterPlan } from './questions';
import { assembleBody, taskNameFrom } from './spans';

/**
 * Turns one fan-out of Jev answers into what the conductor does: act directly, ask a short
 * clarifying question, drop a transcription artifact, or hand the utterance to Claude with Jev's
 * partial reading as hints. Deterministic code, not a model: every threshold is here.
 */

export type RouterThresholds = { navigate: number; guarded: number; write: number };

/**
 * Per-class thresholds from the one user setting: navigation is visible and undoable (−0.10),
 * close/interrupt are harder to take back (the setting), and sends and spawns type into
 * agents or create tasks (+0.05).
 */
export function thresholdsFrom(base: number): RouterThresholds {
  const clamp = (value: number) => Math.round(Math.min(0.99, Math.max(0.5, value)) * 100) / 100;
  return { navigate: clamp(base - 0.1), guarded: clamp(base), write: clamp(base + 0.05) };
}

/** A message span must be at least this certain before its words go to an agent unchanged. */
export const SPAN_CONFIDENCE = 0.7;
/** Probability mass on destructive intents that blocks acting on a different top intent. */
export const DESTRUCTIVE_MASS = 0.15;
/** Artifact probability above which an utterance is dropped as a transcription error. */
export const ARTIFACT_THRESHOLD = 0.85;
/** While the conductor's own question is open, Jev acts alone only at this intent confidence. */
export const PENDING_QUESTION_CONFIDENCE = 0.9;

export type RouterAction =
  | { verb: 'focus' | 'status' | 'interrupt' | 'close' | 'reopen'; agent: RosterAgent }
  | { verb: 'overview' }
  | { verb: 'next' }
  | { verb: 'close_many'; scope: CloseScope }
  | { verb: 'reopen_all' }
  | { verb: 'send'; agent: RosterAgent; text: string; submit: boolean; rebind: boolean }
  | {
      verb: 'spawn';
      provider: ProviderOption;
      project: ProjectOption | null;
      prompt: string;
      taskName: string;
      worktree: boolean;
      rebind: boolean;
    };

export type RouterDecision =
  | { kind: 'act'; action: RouterAction; confidence: number; reason: string }
  | {
      kind: 'clarify';
      question: string;
      choices: { agent: RosterAgent; action: RouterAction }[];
      reason: string;
    }
  | { kind: 'artifact'; confidence: number }
  | {
      kind: 'llm';
      mode: ConductorMode;
      reason: string;
      hints: string;
      /** The project Jev is sure the developer named for new work; spawns and plans use it. */
      project: SettledProject | null;
    };

/** A project Jev read with at least the guarded confidence: the source of truth for new work. */
export type SettledProject = { readonly project: ProjectOption; readonly confidence: number };

export type RouterOptions = {
  readonly thresholds: RouterThresholds;
  /** Sends and spawns may run directly with the developer's words (the "Fast verbatim" setting). */
  readonly verbatim: boolean;
  /** The utterance has plan wording ("split", "in parallel", "spin up"). */
  readonly planCue: boolean;
};

type Bound<T> = { ok: true; value: T; confidence: number } | { ok: false; reason: string };

const fail = <T>(reason: string): Bound<T> => ({ ok: false, reason });

/** Probability mass on score levels at or above `minLevel`. */
export function scoreMass(
  answer: JevAnswer | undefined,
  levels: readonly string[],
  minLevel: number
): number {
  if (answer?.type !== 'score') return 0;
  let mass = 0;
  let recognized = false;
  for (const [key, probability] of Object.entries(answer.probabilities)) {
    const numeric = Number(key);
    const index = Number.isInteger(numeric) ? numeric : levels.indexOf(key);
    if (index < 0) continue;
    recognized = true;
    if (index >= minLevel) mass += probability;
  }
  if (recognized) return mass;
  return answer.score >= minLevel - 0.25 ? answer.confidence : 1 - answer.confidence;
}

/** Plan mode only when Jev expects several new agents, or plan wording backs a weaker signal. */
export function planMode(answers: JevAnswers, planCue: boolean): ConductorMode {
  const multi = scoreMass(answers.agent_count, AGENT_COUNT_LEVELS, 1);
  const intent = choiceOf(answers, 'intent');
  if (multi >= 0.7) return 'plan';
  if (intent?.choice === 'plan_multi' && intent.confidence >= 0.6) return 'plan';
  return planCue && multi >= 0.3 ? 'plan' : 'command';
}

/** The agent a target option means right now (a roster name, or a sentinel's referent). */
function targetAgent(plan: RouterPlan, option: string): RosterAgent | null {
  const target = plan.targets.get(option);
  if (!target) return null;
  return typeof target === 'string' ? sentinelReferent(target, plan.input) : target;
}

/**
 * The agent the `target` answer points at, with the summed probability of every option that means
 * that agent ("Maple 2" plus "the agent you just started" when that is Maple 2).
 */
function bindTarget(answers: JevAnswers, plan: RouterPlan): Bound<RosterAgent> {
  const target = choiceOf(answers, 'target');
  if (!target) return fail('no-target-answer');
  if (target.choice === SENTINEL.unknownName) return fail('unknown-name');
  const agent = targetAgent(plan, target.choice);
  if (!agent) return fail(`target:${target.choice}`);
  let mass = 0;
  for (const [option, probability] of Object.entries(target.probabilities)) {
    if (targetAgent(plan, option)?.id === agent.id) mass += probability;
  }
  return { ok: true, value: agent, confidence: Math.max(mass, target.confidence) };
}

function bindProvider(answers: JevAnswers, plan: RouterPlan): Bound<ProviderOption> {
  const provider = choiceOf(answers, 'provider');
  if (!provider) return fail('no-provider-answer');
  if (provider.choice === NOT_MENTIONED) return fail('provider-not-mentioned');
  const { providers, context } = plan.input;
  const found =
    provider.choice === SAME_AS_LAST
      ? providers.find((option) => option.id === context.lastSpawned?.providerId)
      : providers.find((option) => option.label === provider.choice);
  if (!found) return fail(`provider:${provider.choice}`);
  return { ok: true, value: found, confidence: provider.confidence };
}

/**
 * The project for new work: one the developer named, "here" (the focused agent's or on-screen
 * project), or the last spawn's. Nothing named is no project unless only one is open: with
 * several, the developer is asked rather than the focused one guessed.
 */
function bindProject(answers: JevAnswers, plan: RouterPlan): Bound<ProjectOption> {
  const project = choiceOf(answers, 'project');
  if (!project) return fail('no-project-answer');
  const { projects, focusedProject, context } = plan.input;
  const resolve = (option: string): ProjectOption | undefined => {
    if (option === NOT_MENTIONED) return projects.length === 1 ? projects[0] : undefined;
    if (option === FOCUSED_PROJECT) return focusedProject ?? undefined;
    if (option === SAME_AS_LAST) {
      const name = context.lastSpawned?.projectName;
      return name ? projects.find((candidate) => candidate.name === name) : undefined;
    }
    return projects.find((candidate) => candidate.name === option);
  };
  const chosen = resolve(project.choice);
  if (!chosen) {
    return fail(
      project.choice === NOT_MENTIONED ? 'project-not-named' : `project:${project.choice}`
    );
  }
  let mass = 0;
  for (const [option, probability] of Object.entries(project.probabilities)) {
    if (resolve(option)?.id === chosen.id) mass += probability;
  }
  return { ok: true, value: chosen, confidence: Math.max(mass, project.confidence) };
}

/** The project Jev is sure of, at `threshold` or above, or null. */
export function settledProject(
  answers: JevAnswers,
  plan: RouterPlan,
  threshold: number
): SettledProject | null {
  const bound = bindProject(answers, plan);
  if (!bound.ok || bound.confidence < threshold) return null;
  return { project: bound.value, confidence: bound.confidence };
}

const SEND_LEAD = /^(?:please\s+)?(?:tell|ask|send|message|say to|let)\b/i;
const SPAWN_LEAD =
  /^(?:please\s+)?(?:spin up|start|create|open|launch|make|fire up|kick off)\s+(?:a|an|another|one|new)\b/i;

/** The message Jev marked in the utterance, verbatim, and how sure it is of the boundaries. */
export function extractBody(answers: JevAnswers, plan: RouterPlan): Bound<string> {
  const start = choiceOf(answers, 'body_start');
  const end = choiceOf(answers, 'body_end');
  if (!start || !end) return fail('no-span-answer');
  const from = plan.starts.get(start.choice);
  const to = plan.ends.get(end.choice);
  if (!from || to === undefined || to < from.sentence) return fail('span-invalid');
  const meta = new Map<number, number>();
  let uncertain = false;
  for (const sentence of plan.sentences) {
    const probability = noulOf(answers, `meta_${sentence.index}`);
    if (probability === null) continue;
    meta.set(sentence.index, probability);
    if (sentence.index > from.sentence && sentence.index <= to) {
      if (probability > 0.3 && probability < 0.7) uncertain = true;
    }
  }
  const body = assembleBody(plan.input.utterance, plan.sentences, from, to, meta);
  const confidence = Math.min(start.confidence, end.confidence, uncertain ? 0.6 : 1);
  if (body.split(/\s+/).filter(Boolean).length < 2) return fail('span-too-short');
  return { ok: true, value: body, confidence };
}

function intentMass(answers: JevAnswers, intents: ReadonlySet<RouterIntent>, except: string) {
  const intent = choiceOf(answers, 'intent');
  if (!intent) return 0;
  return Object.entries(intent.probabilities)
    .filter(([option]) => option !== except && intents.has(option as RouterIntent))
    .reduce((sum, [, probability]) => sum + probability, 0);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Why Jev handed the turn to the model, in words the model can act on. */
const REASON_TEXT: Record<string, string> = {
  'low-intent-confidence': 'it was not sure enough what the developer wants to act alone',
  'answers-question': 'the developer seems to be answering your last question',
  'pending-question': 'your last question is still open and this may answer it',
  conversation: 'the developer is talking with you, not giving a command',
  cancel: 'the developer may be calling something off',
  correction: 'the developer is correcting your last action',
  'several-agents': 'it expects several new agents',
  'destructive-mass': 'part of its reading is a destructive command',
  'unknown-agent-name': 'a numbered agent name that no agent has was said',
  'catalog-disagrees': 'its reading of the parts disagrees with its reading of the whole',
  'project-not-named': 'no project was named and several are open',
  'low-project-confidence': 'it was unsure which project',
  'provider-not-mentioned': 'no provider was named',
  'low-provider-confidence': 'it was unsure which provider',
  'span-uncertain': 'it could not cleanly separate the message from the instructions to you',
  'span-includes-command': 'it could not cleanly separate the message from the instructions to you',
  'verbatim-routing-off': "acting on the developer's words directly is turned off",
};

function reasonText(reason: string): string {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (reason.startsWith('intent:')) return 'this kind of request is yours to handle';
  return reason;
}

/** An intent in words ("Start one new agent and give it a task…"), else its id. */
function intentText(intent: string): string {
  const rubric = (INTENT_RUBRICS as Record<string, { what: string } | undefined>)[intent];
  return rubric ? rubric.what : intent;
}

/** The two best options of a choice answer, highest first. */
function topTwo(answer: JevAnswer & { type: 'choice' }): [string, number][] {
  return Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
}

/** What Jev read about the project, and what the model must do with it. */
function projectHint(
  answers: JevAnswers,
  plan: RouterPlan,
  settled: SettledProject | null
): string | null {
  if (settled) {
    return `Project: ${settled.project.name} (${pct(settled.confidence)}). Settled: spawn_agent and propose_plan put new work there even if you leave project out.`;
  }
  const project = choiceOf(answers, 'project');
  if (!project) return null;
  const { projects, focusedProject } = plan.input;
  if (project.choice === NOT_MENTIONED && project.confidence >= 0.6) {
    if (projects.length < 2) return null;
    return `Project: none named, and ${projects.length} are open. If this starts new work and the conversation has not already settled where, ask which project in one short question; never pick one for them.`;
  }
  const label = (option: string): string => {
    if (option === FOCUSED_PROJECT)
      return `${focusedProject?.name ?? 'the current project'} ("here")`;
    if (option === SAME_AS_LAST) return 'the same project as last time';
    if (option === NOT_MENTIONED) return 'none named';
    return option;
  };
  const options = topTwo(project)
    .filter(([, probability]) => probability >= 0.1)
    .map(([option, probability]) => `${label(option)} ${pct(probability)}`);
  return `Project: unsure (${options.join(', ')}). Pass project only when the context makes it clear; otherwise ask which project.`;
}

/**
 * Jev's reading for the model when it does not act: why it handed over, what it thinks the
 * request is and its runner-up, each slot it is fairly sure of, what is settled about the project,
 * and a warning when the transcript may confuse two agent names.
 */
export function routerHints(
  answers: JevAnswers,
  plan: RouterPlan,
  reason = '',
  settled: SettledProject | null = null
): string {
  const lines: string[] = [];
  if (reason) lines.push(`- It handed this to you because ${reasonText(reason)}.`);
  const intent = choiceOf(answers, 'intent');
  if (intent) lines.push(`- Request: ${intentText(intent.choice)} (${pct(intent.confidence)}).`);
  const joint = choiceOf(answers, 'action');
  const readings = joint ? topTwo(joint) : [];
  if (readings.length === 2 && readings[1][1] >= 0.15) {
    lines.push(
      `- Torn between: ${readings.map(([option, p]) => `${option} (${pct(p)})`).join(' or ')}.`
    );
  }
  const show = (id: string, label: string, skip: readonly string[] = []) => {
    const answer = choiceOf(answers, id);
    if (answer && answer.confidence >= 0.6 && !skip.includes(answer.choice)) {
      lines.push(`- ${label}: ${answer.choice} (${pct(answer.confidence)}).`);
    }
  };
  show('target', 'Agent', [SENTINEL.none]);
  const project = projectHint(answers, plan, settled);
  if (project) lines.push(`- ${project}`);
  show('provider', 'Provider', [NOT_MENTIONED]);
  const multi = scoreMass(answers.agent_count, AGENT_COUNT_LEVELS, 1);
  if (multi >= 0.6) lines.push(`- Several new agents (${pct(multi)}).`);
  const verbatim = noulOf(answers, 'wants_verbatim');
  if (verbatim !== null && verbatim >= 0.7) {
    lines.push(`- Wants their words passed on verbatim (${pct(verbatim)}).`);
  }
  const target = choiceOf(answers, 'target');
  const split = target ? confusableSplit(target.probabilities, plan.confusable, 0.5) : null;
  if (split)
    lines.push(`- Careful: "${split[0]}" and "${split[1]}" are both live and sound alike.`);
  if (lines.length === 0) return '';
  return [
    'Fast router (Jev) read this request first; percentages are its confidence. Check them against the context, except what it marks settled:',
    ...lines,
  ].join('\n');
}

function sendAction(
  answers: JevAnswers,
  plan: RouterPlan,
  agent: RosterAgent
): Bound<RouterAction> {
  const body = extractBody(answers, plan);
  if (!body.ok) return body;
  if (body.confidence < SPAN_CONFIDENCE) return fail('span-uncertain');
  if (SEND_LEAD.test(body.value)) return fail('span-includes-command');
  const submit = (noulOf(answers, 'submit') ?? 1) >= 0.3;
  return {
    ok: true,
    value: { verb: 'send', agent, text: body.value, submit, rebind: false },
    confidence: body.confidence,
  };
}

function spawnAction(
  answers: JevAnswers,
  plan: RouterPlan,
  intent: RouterIntent,
  threshold: number
): Bound<RouterAction> {
  const provider = bindProvider(answers, plan);
  if (!provider.ok) return provider;
  if (provider.confidence < threshold) return fail('low-provider-confidence');
  const project = bindProject(answers, plan);
  if (!project.ok) return project;
  if (project.confidence < threshold) return fail('low-project-confidence');
  const blank = intent === 'spawn_blank' || (noulOf(answers, 'blank_prompt') ?? 0) >= 0.5;
  let prompt = '';
  let confidence = Math.min(provider.confidence, project.confidence);
  if (!blank) {
    const body = extractBody(answers, plan);
    if (!body.ok) return body;
    if (body.confidence < SPAN_CONFIDENCE) return fail('span-uncertain');
    if (SPAWN_LEAD.test(body.value)) return fail('span-includes-command');
    prompt = body.value;
    confidence = Math.min(confidence, body.confidence);
  }
  const label = provider.value.label;
  return {
    ok: true,
    value: {
      verb: 'spawn',
      provider: provider.value,
      project: project.value,
      prompt,
      taskName: prompt ? taskNameFrom(prompt, `${label} agent`) : `${label} agent`,
      worktree: (noulOf(answers, 'worktree') ?? 0) >= 0.5,
      rebind: false,
    },
    confidence,
  };
}

/** The catalog key the separate slot answers compose to, for the self-agreement check. */
function composedKey(action: RouterAction): string {
  switch (action.verb) {
    case 'overview':
    case 'next':
      return action.verb;
    case 'close_many':
      return catalogKey.closeMany(action.scope);
    case 'reopen_all':
      return catalogKey.reopenAll;
    case 'send':
      return catalogKey.agent('send_verbatim', action.agent.name);
    case 'spawn':
      return action.project
        ? catalogKey.spawn(action.provider, action.project)
        : `spawn · ${action.provider.label}`;
    default:
      return catalogKey.agent(action.verb, action.agent.name);
  }
}

/** The action for an agent-directed intent once its agent is known. */
function agentAction(
  answers: JevAnswers,
  plan: RouterPlan,
  intent: RouterIntent,
  agent: RosterAgent
): Bound<RouterAction> {
  switch (intent) {
    case 'focus':
    case 'status':
    case 'interrupt':
    case 'close':
    case 'reopen':
      return { ok: true, value: { verb: intent, agent }, confidence: 1 };
    case 'send_verbatim':
      return sendAction(answers, plan, agent);
    default:
      return fail(`intent:${intent}`);
  }
}

/** "No, send that to Tango" / "start it again but in Chorus": re-run the last action, rebound. */
function correction(
  answers: JevAnswers,
  plan: RouterPlan,
  options: RouterOptions
): RouterDecision | null {
  const slot = choiceOf(answers, 'correction_slot');
  const threshold = options.thresholds.write;
  if (!slot || slot.confidence < threshold || !options.verbatim) return null;
  const { context } = plan.input;
  if (slot.choice === 'target' && context.lastAction === 'send' && context.lastSent) {
    const target = bindTarget(answers, plan);
    if (!target.ok || target.confidence < threshold) return null;
    if (target.value.id === context.lastSent.conversationId) return null;
    return {
      kind: 'act',
      action: {
        verb: 'send',
        agent: target.value,
        text: context.lastSent.text,
        submit: true,
        rebind: true,
      },
      confidence: Math.min(slot.confidence, target.confidence),
      reason: 'correction-target',
    };
  }
  const last = context.lastSpawned;
  if (
    (slot.choice === 'project' || slot.choice === 'provider') &&
    context.lastAction === 'spawn' &&
    last
  ) {
    const lastProvider = plan.input.providers.find((provider) => provider.id === last.providerId);
    const lastProject =
      plan.input.projects.find((project) => project.name === last.projectName) ?? null;
    let provider = lastProvider;
    let project = lastProject;
    let confidence = slot.confidence;
    if (slot.choice === 'provider') {
      const bound = bindProvider(answers, plan);
      if (!bound.ok || bound.confidence < threshold || bound.value.id === last.providerId) {
        return null;
      }
      provider = bound.value;
      confidence = Math.min(confidence, bound.confidence);
    } else {
      const bound = bindProject(answers, plan);
      const chosen = choiceOf(answers, 'project')?.choice;
      if (!bound.ok || bound.confidence < threshold) return null;
      if (chosen === NOT_MENTIONED || chosen === SAME_AS_LAST) return null;
      if (bound.value.name === last.projectName) return null;
      project = bound.value;
      confidence = Math.min(confidence, bound.confidence);
    }
    if (!provider) return null;
    return {
      kind: 'act',
      action: {
        verb: 'spawn',
        provider,
        project,
        prompt: last.prompt,
        taskName: last.taskName,
        worktree: last.worktree,
        rebind: true,
      },
      confidence,
      reason: `correction-${slot.choice}`,
    };
  }
  return null;
}

export function decideRoute(
  answers: JevAnswers,
  plan: RouterPlan,
  options: RouterOptions
): RouterDecision {
  const mode = planMode(answers, options.planCue);
  // Jev's project is the source of truth for one new piece of work, not for a split plan.
  const settled =
    mode === 'command' ? settledProject(answers, plan, options.thresholds.guarded) : null;
  const llm = (reason: string): RouterDecision => ({
    kind: 'llm',
    mode,
    reason,
    hints: routerHints(answers, plan, reason, settled),
    project: settled,
  });

  const artifact = noulOf(answers, 'stt_artifact') ?? 0;
  const addressee = choiceOf(answers, 'addressee');
  const artifactVote = addressee?.choice === ADDRESSEE.artifact ? addressee.confidence : 0;
  if (Math.max(artifact, artifactVote) >= ARTIFACT_THRESHOLD) {
    return { kind: 'artifact', confidence: Math.max(artifact, artifactVote) };
  }

  const intent = choiceOf(answers, 'intent');
  if (!intent) return llm('no-intent-answer');

  const { context } = plan.input;
  const answering = noulOf(answers, 'answers_question') ?? 0;
  if (context.awaitingAnswer && (answering >= 0.5 || addressee?.choice === ADDRESSEE.answer)) {
    return llm('answers-question');
  }
  if (addressee?.choice === ADDRESSEE.conversation) return llm('conversation');
  if (addressee?.choice === ADDRESSEE.cancel) return llm('cancel');
  if (addressee?.choice === ADDRESSEE.answer) return llm('answers-question');
  // The conductor just asked something. A short reply that Jev reads as a new command without
  // being sure ("Set that to Maple 3" as "focus Maple 3") is more likely the answer: Claude has
  // the question and decides.
  if (context.awaitingAnswer && intent.confidence < PENDING_QUESTION_CONFIDENCE) {
    return llm('pending-question');
  }
  // A numbered name nobody has ("Atlas 3" with only Atlas and Atlas 2) is never bound to the
  // agent that sounds nearest, in a command or a correction: Claude asks which one was meant.
  if (unknownSpokenNames(plan.input.utterance, plan.input.roster).length > 0) {
    return llm('unknown-agent-name');
  }
  if (addressee?.choice === ADDRESSEE.correction) {
    return correction(answers, plan, options) ?? llm('correction');
  }

  if (mode === 'plan') return llm('several-agents');
  const name = intent.choice as RouterIntent;
  const riskClass = DIRECT_CLASS[name];
  if (!riskClass) return llm(`intent:${name}`);
  if (intentMass(answers, DESTRUCTIVE_INTENTS, name) > DESTRUCTIVE_MASS) {
    return llm('destructive-mass');
  }
  const threshold = options.thresholds[riskClass];
  if (intent.confidence < threshold) return llm('low-intent-confidence');
  if (riskClass === 'write' && !options.verbatim) return llm('verbatim-routing-off');

  const joint = choiceOf(answers, 'action');
  const agrees = (action: RouterAction): boolean =>
    joint !== null && joint.choice === composedKey(action) && joint.confidence >= 0.5;
  const act = (action: RouterAction, confidence: number, reason: string): RouterDecision =>
    agrees(action)
      ? { kind: 'act', action, confidence: Math.min(intent.confidence, confidence), reason }
      : llm(joint ? 'catalog-disagrees' : 'no-catalog-answer');

  switch (name) {
    case 'overview':
    case 'next':
      return act({ verb: name }, 1, 'direct');
    case 'close_many': {
      const bound = joint ? plan.catalog.actions.get(joint.choice) : undefined;
      if (bound?.intent !== 'close_many' || !('scope' in bound)) return llm('no-close-scope');
      return act({ verb: 'close_many', scope: bound.scope }, joint?.confidence ?? 0, 'direct');
    }
    case 'spawn_blank':
    case 'spawn_with_brief': {
      const spawn = spawnAction(answers, plan, name, threshold);
      if (!spawn.ok) return llm(spawn.reason);
      return act(spawn.value, spawn.confidence, 'direct');
    }
    default:
      break;
  }

  // Agent-directed intents.
  const target = choiceOf(answers, 'target');
  if (name === 'reopen' && target?.choice === SENTINEL.all) {
    return act({ verb: 'reopen_all' }, target.confidence, 'direct');
  }
  const split = target ? confusableSplit(target.probabilities, plan.confusable) : null;
  if (split) {
    const choices: { agent: RosterAgent; action: RouterAction }[] = [];
    for (const option of split) {
      const agent = targetAgent(plan, option);
      const bound = agent ? agentAction(answers, plan, name, agent) : null;
      if (agent && bound?.ok) choices.push({ agent, action: bound.value });
    }
    if (choices.length === 2) {
      return {
        kind: 'clarify',
        question: `${split[0]} or ${split[1]}?`,
        choices,
        reason: 'confusable-names',
      };
    }
    return llm('confusable-names');
  }
  const agent = bindTarget(answers, plan);
  if (!agent.ok) return llm(agent.reason);
  if (agent.confidence < threshold) return llm('low-target-confidence');
  const action = agentAction(answers, plan, name, agent.value);
  if (!action.ok) return llm(action.reason);
  return act(action.value, Math.min(agent.confidence, action.confidence), 'direct');
}
