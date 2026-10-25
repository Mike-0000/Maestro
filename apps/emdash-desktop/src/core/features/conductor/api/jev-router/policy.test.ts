import { describe, expect, it } from 'vitest';
import { isSingleAgentWithSubagents } from '../grammar';
import type { JevAnswer, JevAnswers } from '../jev';
import type { RosterAgent } from '../resolver';
import { catalogKey, FOCUSED_PROJECT, NOT_MENTIONED, SENTINEL, type RouterInput } from './catalog';
import { ConversationContext } from './context';
import { decideRoute, planMode, routerHints, thresholdsFrom, type RouterOptions } from './policy';
import { ADDRESSEE, buildRouterRequest } from './questions';
import { END_OF_UTTERANCE, WHOLE_UTTERANCE } from './spans';

const agent = (name: string, extra: Partial<RosterAgent> = {}): RosterAgent => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  providerLabel: 'Codex',
  taskName: `${name} task`,
  ...extra,
});

const MAPLE = agent('Maple');
const MAPLE_2 = agent('Maple 2');
const TANGO = agent('Tango', { providerLabel: 'Claude Code' });
const CHORUS = { id: 'p-chorus', name: 'Chorus' };
const SITE = { id: 'p-site', name: 'Website' };
const CODEX = { id: 'codex', label: 'Codex' };
const CLAUDE = { id: 'claude', label: 'Claude Code' };

function input(utterance: string, context = new ConversationContext(() => 1_000)): RouterInput {
  return {
    utterance,
    roster: [MAPLE, MAPLE_2, TANGO],
    focused: TANGO,
    projects: [CHORUS, SITE],
    focusedProject: CHORUS,
    providers: [CODEX, CLAUDE],
    context: context.snapshot(),
  };
}

function choice(pick: string, confidence = 0.95, rest: Record<string, number> = {}): JevAnswer {
  return {
    type: 'choice',
    choice: pick,
    confidence,
    probabilities: { [pick]: confidence, ...rest },
  };
}

const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value });

const ONE_AGENT: JevAnswer = {
  type: 'score',
  score: 0,
  confidence: 0.95,
  probabilities: { '0': 0.95, '1': 0.05 },
};

/** A confident command reading; tests override the slots they are about. */
function answers(overrides: JevAnswers): JevAnswers {
  return {
    addressee: choice(ADDRESSEE.command),
    stt_artifact: noul(0.01),
    answers_question: noul(0.02),
    correction_slot: choice('none'),
    agent_count: ONE_AGENT,
    blank_prompt: noul(0.05),
    wants_verbatim: noul(0.5),
    worktree: noul(0.05),
    submit: noul(0.9),
    project: choice(NOT_MENTIONED),
    provider: choice(NOT_MENTIONED),
    target: choice(SENTINEL.none),
    ...overrides,
  };
}

const options: RouterOptions = { thresholds: thresholdsFrom(0.85), verbatim: true, planCue: false };

/** The span option key whose text starts with `text`. */
function startKey(request: ReturnType<typeof buildRouterRequest>, text: string): string {
  const { utterance } = request.plan.input;
  for (const [key, start] of request.plan.starts) {
    if (utterance.slice(start.offset).startsWith(text)) return key;
  }
  throw new Error(`no start option for ${text}`);
}

describe('thresholdsFrom', () => {
  it('derives per-class thresholds from the one setting, clamped', () => {
    expect(thresholdsFrom(0.85)).toEqual({ navigate: 0.75, guarded: 0.85, write: 0.9 });
    expect(thresholdsFrom(0.99).write).toBe(0.99);
    expect(thresholdsFrom(0.5).navigate).toBe(0.5);
  });
});

describe('decideRoute', () => {
  it('focuses when intent, target, and the joint catalog agree', () => {
    const request = buildRouterRequest(input('show me Maple 2'));
    const decision = decideRoute(
      answers({
        intent: choice('focus', 0.9),
        target: choice('Maple 2', 0.9),
        action: choice(catalogKey.agent('focus', 'Maple 2'), 0.8),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'act', action: { verb: 'focus', agent: MAPLE_2 } });
  });

  it('falls back to Claude when the catalog disagrees with the slots', () => {
    const request = buildRouterRequest(input('show me Tango'));
    const decision = decideRoute(
      answers({
        intent: choice('focus'),
        target: choice('Tango'),
        action: choice(catalogKey.agent('status', 'Tango')),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'catalog-disagrees', mode: 'command' });
  });

  it('asks which one when the target splits between confusable names', () => {
    const request = buildRouterRequest(input('show me maple'));
    const decision = decideRoute(
      answers({
        intent: choice('focus'),
        target: choice('Maple', 0.5, { 'Maple 2': 0.45 }),
        action: choice(catalogKey.agent('focus', 'Maple')),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'clarify', question: 'Maple or Maple 2?' });
    if (decision.kind !== 'clarify') return;
    expect(decision.choices.map((entry) => entry.agent.name)).toEqual(['Maple', 'Maple 2']);
  });

  it("sends the developer's own words when the span is certain", () => {
    const utterance = 'Tell Maple 2 to run the full test suite.';
    const request = buildRouterRequest(input(utterance));
    const decision = decideRoute(
      answers({
        intent: choice('send_verbatim', 0.95),
        target: choice('Maple 2', 0.95),
        action: choice(catalogKey.agent('send_verbatim', 'Maple 2'), 0.9),
        body_start: choice(startKey(request, 'run the full'), 0.9),
        body_end: choice(END_OF_UTTERANCE, 0.9),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'act',
      action: { verb: 'send', agent: MAPLE_2, text: 'Run the full test suite.', submit: true },
    });
  });

  it('rejects a span that still contains the command', () => {
    const request = buildRouterRequest(input('Tell Maple 2 to run the full test suite.'));
    const decision = decideRoute(
      answers({
        intent: choice('send_verbatim'),
        target: choice('Maple 2'),
        action: choice(catalogKey.agent('send_verbatim', 'Maple 2')),
        body_start: choice(WHOLE_UTTERANCE),
        body_end: choice(END_OF_UTTERANCE),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'span-includes-command' });
  });

  it('leaves sends to Claude when fast verbatim routing is off', () => {
    const request = buildRouterRequest(input('Tell Maple 2 to run the full test suite.'));
    const decision = decideRoute(
      answers({ intent: choice('send_verbatim'), target: choice('Maple 2') }),
      request.plan,
      { ...options, verbatim: false }
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'verbatim-routing-off' });
  });

  it('starts an agent with its task in the named project', () => {
    const utterance = 'Start a Codex agent in Website to fix the login redirect.';
    const request = buildRouterRequest(input(utterance));
    const decision = decideRoute(
      answers({
        intent: choice('spawn_with_brief', 0.95),
        provider: choice('Codex', 0.95),
        project: choice('Website', 0.95),
        target: choice(SENTINEL.newAgent),
        action: choice(catalogKey.spawn(CODEX, SITE), 0.9),
        body_start: choice(startKey(request, 'fix the login'), 0.9),
        body_end: choice(END_OF_UTTERANCE, 0.9),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'act',
      action: {
        verb: 'spawn',
        provider: CODEX,
        project: SITE,
        prompt: 'Fix the login redirect.',
        taskName: 'Fix the login redirect',
        worktree: false,
      },
    });
  });

  it('starts a blank agent in the project on screen when the developer says "here"', () => {
    const request = buildRouterRequest(input('open a new codex agent here'));
    const decision = decideRoute(
      answers({
        intent: choice('spawn_blank', 0.95),
        provider: choice('Codex', 0.95),
        project: choice(FOCUSED_PROJECT, 0.95),
        action: choice(catalogKey.spawn(CODEX, CHORUS), 0.9),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'act',
      action: { verb: 'spawn', project: CHORUS, prompt: '', taskName: 'Codex agent' },
    });
  });

  it('hands a spawn with no project named to the model, which asks, when several are open', () => {
    const request = buildRouterRequest(input('open a new codex agent'));
    const decision = decideRoute(
      answers({
        intent: choice('spawn_blank', 0.95),
        provider: choice('Codex', 0.95),
        action: choice(catalogKey.spawn(CODEX, CHORUS), 0.9),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'project-not-named', project: null });
    expect(decision.kind === 'llm' && decision.hints).toContain('ask which project');
  });

  it('starts in the only open project when none is named', () => {
    const request = buildRouterRequest({ ...input('open a new codex agent'), projects: [CHORUS] });
    const decision = decideRoute(
      answers({
        intent: choice('spawn_blank', 0.95),
        provider: choice('Codex', 0.95),
        action: choice(catalogKey.spawn(CODEX, CHORUS), 0.9),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'act', action: { verb: 'spawn', project: CHORUS } });
  });

  it('settles the project Jev is sure of when the model takes the turn', () => {
    const request = buildRouterRequest(input('send this to a claude agent for the website'));
    const decision = decideRoute(
      answers({
        intent: choice('spawn_with_brief', 0.82, { send_verbatim: 0.13 }),
        provider: choice('Claude Code', 0.99),
        project: choice('Website', 0.89, { [FOCUSED_PROJECT]: 0.09 }),
        action: choice(catalogKey.spawn(CLAUDE, SITE), 0.47, { 'send_verbatim · Tango': 0.43 }),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'llm',
      reason: 'low-intent-confidence',
      project: { project: SITE },
    });
    const hints = decision.kind === 'llm' ? decision.hints : '';
    expect(hints).toContain('Project: Website (89%). Settled');
    expect(hints).toContain(
      'Torn between: spawn · Claude Code in Website (47%) or send_verbatim · Tango (43%)'
    );
    expect(hints).toContain('not sure enough what the developer wants');
  });

  it('does not settle a project below the confidence setting', () => {
    const request = buildRouterRequest(input('start a claude agent on the website maybe'));
    const decision = decideRoute(
      answers({
        intent: choice('spawn_with_brief', 0.6),
        provider: choice('Claude Code', 0.99),
        project: choice('Website', 0.6, { Chorus: 0.3 }),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', project: null });
    expect(decision.kind === 'llm' && decision.hints).toContain(
      'Project: unsure (Website 60%, Chorus 30%)'
    );
  });

  it('re-sends the last message to a corrected target', () => {
    const context = new ConversationContext(() => 1_000);
    context.noteSend({ conversationId: MAPLE.id, name: 'Maple', text: 'Use Postgres.' });
    const request = buildRouterRequest(input('no, send that to Tango', context));
    const decision = decideRoute(
      answers({
        addressee: choice(ADDRESSEE.correction),
        correction_slot: choice('target'),
        intent: choice('send_verbatim'),
        target: choice('Tango'),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'act',
      reason: 'correction-target',
      action: { verb: 'send', agent: TANGO, text: 'Use Postgres.', rebind: true },
    });
  });

  it('restarts the last spawn in the corrected project', () => {
    const context = new ConversationContext(() => 1_000);
    context.noteSpawn({
      conversationId: 'new',
      name: 'Harbor',
      providerId: 'codex',
      providerLabel: 'Codex',
      projectName: 'Chorus',
      prompt: 'Add dark mode.',
      taskName: 'Add dark mode',
      worktree: false,
    });
    const request = buildRouterRequest(input('I meant in Website', context));
    const decision = decideRoute(
      answers({
        addressee: choice(ADDRESSEE.correction),
        correction_slot: choice('project'),
        intent: choice('spawn_with_brief'),
        project: choice('Website'),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({
      kind: 'act',
      reason: 'correction-project',
      action: { verb: 'spawn', provider: CODEX, project: SITE, prompt: 'Add dark mode.' },
    });
  });

  it('drops transcription artifacts', () => {
    const request = buildRouterRequest(input("I'm sorry, I can't hear any audio."));
    expect(decideRoute(answers({ stt_artifact: noul(0.95) }), request.plan, options)).toMatchObject(
      { kind: 'artifact' }
    );
  });

  it('hands answers to its own question to Claude', () => {
    const context = new ConversationContext(() => 1_000);
    context.noteReply('Which project should it go in?');
    const request = buildRouterRequest(input('the website one', context));
    const decision = decideRoute(
      answers({ answers_question: noul(0.9), intent: choice('focus') }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'answers-question' });
  });

  it('leaves a half-sure command to Claude while its own question is open', () => {
    // "Set that to Maple 2" after "did you mean Maple 2?": Jev read it as focus at 0.75.
    const context = new ConversationContext(() => 1_000);
    context.noteReply("I don't have a Vesper on the canvas — did you mean Maple 2?");
    const slots = {
      intent: choice('focus', 0.76),
      target: choice('Maple 2', 0.9),
      action: choice(catalogKey.agent('focus', 'Maple 2'), 0.8),
    };
    const asked = buildRouterRequest(input('Set that to Maple 2', context));
    expect(decideRoute(answers(slots), asked.plan, options)).toMatchObject({
      kind: 'llm',
      reason: 'pending-question',
    });
    // The same reading acts when nothing was asked.
    const fresh = buildRouterRequest(input('Set that to Maple 2'));
    expect(decideRoute(answers(slots), fresh.plan, options)).toMatchObject({ kind: 'act' });
  });

  it('never acts when destructive intents carry real mass', () => {
    const request = buildRouterRequest(input('close Tango'));
    const decision = decideRoute(
      answers({
        intent: choice('close', 0.8, { kill: 0.18 }),
        target: choice('Tango'),
        action: choice(catalogKey.agent('close', 'Tango')),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'destructive-mass' });
  });

  it('routes kill and archive to Claude however confident Jev is', () => {
    const request = buildRouterRequest(input('kill Tango'));
    const decision = decideRoute(
      answers({ intent: choice('kill', 0.99), target: choice('Tango', 0.99) }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'intent:kill' });
  });

  it('switches to plan mode when several agents are asked for', () => {
    const request = buildRouterRequest(input('split the auth rewrite across three agents'));
    const decision = decideRoute(
      answers({
        intent: choice('plan_multi', 0.9),
        agent_count: {
          type: 'score',
          score: 2,
          confidence: 0.9,
          probabilities: { '0': 0.05, '2': 0.9, '3': 0.05 },
        },
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', mode: 'plan', reason: 'several-agents' });
  });
});

describe('names nobody has', () => {
  it('hands a numbered name that matches no agent to Claude, however sure Jev is', () => {
    const request = buildRouterRequest(input('show me Maple 3'));
    const decision = decideRoute(
      answers({
        intent: choice('focus', 0.97),
        target: choice('Maple 2', 0.97),
        action: choice(catalogKey.agent('focus', 'Maple 2'), 0.97),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'unknown-agent-name' });
  });

  it('does not rebind a correction to the nearest agent', () => {
    const context = new ConversationContext(() => 1_000);
    context.noteSend({ conversationId: TANGO.id, name: 'Tango', text: 'run the tests' });
    const request = buildRouterRequest(input('no, send that to Maple 3', context));
    const decision = decideRoute(
      answers({
        addressee: choice(ADDRESSEE.correction),
        correction_slot: choice('target', 0.97),
        intent: choice('send_verbatim', 0.97),
        target: choice('Maple 2', 0.97),
      }),
      request.plan,
      options
    );
    expect(decision).toMatchObject({ kind: 'llm', reason: 'unknown-agent-name' });
  });

  it('does not offer Jev agents that share a name', () => {
    const twins = [MAPLE, { ...MAPLE, id: 'maple-b', taskName: 'other' }, TANGO];
    const request = buildRouterRequest({ ...input('show me Maple'), roster: twins });
    expect([...request.plan.targets.keys()]).not.toContain('Maple');
    expect([...request.plan.targets.keys()]).toContain('Tango');
  });
});

describe('planMode and hints', () => {
  it('needs plan wording to act on a weak multi-agent signal', () => {
    const weak = answers({
      intent: choice('spawn_with_brief'),
      agent_count: {
        type: 'score',
        score: 0,
        confidence: 0.6,
        probabilities: { '0': 0.6, '1': 0.4 },
      },
    });
    expect(planMode(weak, false)).toBe('command');
    expect(planMode(weak, true)).toBe('plan');
  });

  it('stays in command mode for one agent that should use subagents', () => {
    const multi = answers({
      intent: choice('plan_multi', 0.96),
      agent_count: {
        type: 'score',
        score: 2,
        confidence: 0.9,
        probabilities: { '2': 0.9, '1': 0.1 },
      },
    });
    for (const said of [
      'Start a Claude agent and have it spin up subagents to review the auth module.',
      'Spin up a new agent for the billing bug, maybe spin up some sub-agent review agents.',
    ]) {
      expect(isSingleAgentWithSubagents(said)).toBe(true);
      expect(planMode(multi, true, said)).toBe('command');
    }
    for (const said of [
      'Split this across agents, one per package.',
      'Start three agents to fix the lint errors in parallel.',
      'Make a plan for the migration and start a Claude agent for each part.',
      'Start a Claude agent and two more agents for the docs, with subagents for review.',
      'Start a Claude agent to fix the bug.',
    ]) {
      expect(isSingleAgentWithSubagents(said)).toBe(false);
      expect(planMode(multi, true, said)).toBe('plan');
    }
  });

  it('summarizes confident slots and warns about confusable names', () => {
    const request = buildRouterRequest(input('what is maple doing'));
    const hints = routerHints(
      answers({
        intent: choice('status', 0.9),
        target: choice('Maple', 0.5, { 'Maple 2': 0.45 }),
      }),
      request.plan
    );
    expect(hints).toContain('(90%)');
    expect(hints).toContain('"Maple" and "Maple 2"');
  });
});
