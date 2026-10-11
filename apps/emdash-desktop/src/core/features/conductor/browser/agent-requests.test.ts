import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import type {
  AgentRequest,
  AgentRequestAck,
  OpenRequestView,
  RequestAction,
} from '../api/agent-requests';
import type { ToolOutcome } from '../api/tools';
import {
  AgentRequestDesk,
  atBlockingPrompt,
  DEVELOPER_ANSWER_MS,
  HEARD_MS,
  MAX_OPEN_REQUESTS_PER_AGENT,
  MAX_REQUESTS_PER_WINDOW,
  newlyCompleted,
  WATCH_MS,
  type AgentRequestHost,
} from './agent-requests';

// The request desk on its own: what an agent's request does from the moment it arrives until the
// agent has its reply, with the conductor behind a fake host.

vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const BRIEF = 'Drive Edge through the PCBWay order form and report each mismatch.';

function entry(conversationId: string, overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    tileId: `tile-${conversationId}`,
    conversationId,
    taskId: `task-${conversationId}`,
    projectId: `proj-${conversationId}`,
    projectName: 'shop',
    taskName: `Task of ${conversationId}`,
    providerId: 'claude',
    type: 'pty',
    status: 'working',
    ...overrides,
  } as AgentTileEntry;
}

const nameOf = (agent: AgentTileEntry) =>
  agent.conversationId[0]!.toUpperCase() + agent.conversationId.slice(1);

let sequence = 0;
function request(kind: string, payload: unknown, from = 'atlas'): AgentRequest {
  sequence += 1;
  return {
    id: `r-${String(sequence).padStart(6, '0')}`,
    at: '2026-10-10T20:00:00.000Z',
    from: { conversationId: from, taskId: `task-${from}`, projectId: `proj-${from}` },
    kind,
    payload,
  };
}

const spawn = (overrides: Record<string, unknown> = {}, from = 'atlas') =>
  request(
    'spawn_agent',
    { provider: 'codex', task_name: 'Order check', brief: BRIEF, ...overrides },
    from
  );

const question = (from = 'atlas', text = 'Keep the look or make the pod longer?') =>
  request('ask_developer', { question: text }, from);

function setup(options: { free?: boolean; canDecide?: boolean } = {}) {
  const entries = new Map(
    ['atlas', 'bravo', 'carol', 'echo'].map((id) => [id, entry(id)] as [string, AgentTileEntry])
  );
  const state = { free: options.free ?? true, now: 1_000_000, enabled: true, sendFails: '' };
  const said: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const acts: { action: RequestAction; from: string; targetId?: string }[] = [];
  let onDecide: (open: OpenRequestView) => Promise<string> = async () => '';
  let actOutcome: ToolOutcome = {
    content: 'Created task "Order check"; it will appear on the canvas as Echo.',
    subject: { conversationId: 'echo' },
  };
  const host: AgentRequestHost = {
    enabled: () => state.enabled,
    entryFor: (conversationId) => entries.get(conversationId),
    sender: (agent) => ({
      name: nameOf(agent),
      providerLabel: 'Claude',
      taskName: agent.taskName,
      projectName: agent.projectName,
    }),
    agentNamed: (name) =>
      [...entries.values()].find((agent) => nameOf(agent).toLowerCase() === name.toLowerCase()),
    agentNames: () => [...entries.values()].map(nameOf),
    installedProviders: async () => [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
    ],
    free: () => state.free,
    canDecide: () => options.canDecide ?? true,
    decide: vi.fn((open: OpenRequestView) => onDecide(open)),
    act: vi.fn(async (action, context) => {
      acts.push({
        action,
        from: context.from.conversationId,
        ...(context.targetId ? { targetId: context.targetId } : {}),
      });
      return actOutcome;
    }),
    say: (text) => void said.push(text),
    send: async (to, text) => {
      if (state.sendFails) throw new Error(state.sendFails);
      sent.push({ to, text });
    },
    record: vi.fn(),
  };
  const desk = new AgentRequestDesk(host, () => state.now);
  const acks: AgentRequestAck[] = [];
  const receive = async (incoming: AgentRequest, delivered = true) => {
    let own: AgentRequestAck | undefined;
    await desk.receive(incoming, async (ack) => {
      own = ack;
      acks.push(ack);
      return delivered;
    });
    // Let the drain the acceptance started run.
    await vi.waitFor(() => expect(desk['draining']).toBe(false));
    return own!;
  };
  /** A yes or no said once the last thing the conductor said has had time to be heard. */
  const say = (decision: 'approve' | 'deny', words: string) => {
    state.now += HEARD_MS;
    return desk.answerLatest(decision, words, said.at(-1) ?? '');
  };
  return {
    desk,
    host,
    state,
    said,
    sent,
    acts,
    acks,
    entries,
    receive,
    say,
    decideWith: (run: (open: OpenRequestView) => Promise<string>) => (onDecide = run),
    actReturns: (outcome: ToolOutcome) => (actOutcome = outcome),
  };
}

beforeEach(() => {
  sequence = 0;
});
afterEach(() => vi.useRealTimers());

describe('accepting or refusing a request', () => {
  it('refuses everything while the developer has agent requests turned off', async () => {
    const { receive, said, host, state } = setup();
    state.enabled = false;
    const ack = await receive(request('report', { status: 'done', message: 'shipped' }));
    expect(ack).toEqual({ accepted: false, message: expect.stringContaining('turned off') });
    expect(said).toEqual([]);
    expect(host.decide).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind, a bad payload, and an agent the canvas does not show', async () => {
    const { receive } = setup();
    expect((await receive(request('launch_rocket', {}))).message).toContain('Unknown request kind');
    expect((await receive(request('report', { status: 'maybe' }))).accepted).toBe(false);
    expect(
      (await receive(request('report', { status: 'done', message: 'x' }, 'ghost'))).message
    ).toContain('does not show this conversation');
  });

  it('refuses a provider that is not installed and names the ones that are', async () => {
    const { receive, host } = setup();
    const ack = await receive(spawn({ provider: 'chatgpt' }));
    expect(ack.accepted).toBe(false);
    expect(ack.message).toContain('Installed: claude (Claude Code), codex (Codex)');
    expect(host.decide).not.toHaveBeenCalled();
  });

  it('drops an accepted request whose verdict never reached the agent', async () => {
    const { receive, host, desk } = setup();
    const ack = await receive(spawn(), false);
    expect(ack.accepted).toBe(true);
    expect(host.decide).not.toHaveBeenCalled();
    expect(desk.contextLines()).toEqual([]);
  });

  it('limits how many requests one agent can leave open', async () => {
    const { receive } = setup({ canDecide: false });
    for (let index = 0; index < MAX_OPEN_REQUESTS_PER_AGENT; index++) {
      expect((await receive(spawn())).accepted).toBe(true);
    }
    const ack = await receive(spawn());
    expect(ack.accepted).toBe(false);
    expect(ack.message).toContain('already have 3 open requests');
    // Another agent is not held back by it.
    expect((await receive(question('bravo'))).accepted).toBe(true);
  });

  it('holds the same limits against requests sent all at once', async () => {
    const spawns = setup({ canDecide: false });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        spawns.desk.receive(spawn(), async (ack) => {
          spawns.acks.push(ack);
          return true;
        })
      )
    );
    expect(spawns.acks.filter((ack) => ack.accepted)).toHaveLength(MAX_OPEN_REQUESTS_PER_AGENT);

    const reports = setup();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        reports.desk.receive(
          request('report', { status: 'progress', message: 'still going' }),
          async (ack) => {
            reports.acks.push(ack);
            return true;
          }
        )
      )
    );
    expect(reports.said).toHaveLength(MAX_REQUESTS_PER_WINDOW);
    expect(reports.acks.filter((ack) => !ack.accepted)[0]!.message).toContain('Too many requests');
  });

  it('counts refused requests against the window too', async () => {
    const { receive } = setup();
    for (let index = 0; index < MAX_REQUESTS_PER_WINDOW; index++) {
      await receive(spawn({ provider: 'chatgpt' }));
    }
    expect((await receive(request('report', { status: 'done', message: 'x' }))).message).toContain(
      'Too many requests'
    );
  });
});

describe('report', () => {
  it('is spoken at once, decided by nobody, and leaves nothing open', async () => {
    const { receive, said, sent, host, desk } = setup({ free: false });
    const ack = await receive(
      request('report', { status: 'blocked', message: 'the Azure login expired' })
    );
    expect(ack).toEqual({ accepted: true, message: expect.stringContaining('No reply follows') });
    expect(said).toEqual(['Atlas is blocked: the Azure login expired.']);
    expect(host.decide).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(desk.awaitingDeveloper).toBe(false);
  });
});

describe('ask_developer', () => {
  it('asks aloud and types the developer’s answer into the asking agent', async () => {
    const { receive, said, sent, desk, host } = setup();
    const asked = question();
    await receive(asked);
    expect(said).toEqual(['Atlas asks: Keep the look or make the pod longer?']);
    expect(host.decide).not.toHaveBeenCalled();
    expect(desk.awaitingDeveloper).toBe(true);
    expect(desk.contextLines().join('\n')).toContain(`${asked.id} from Atlas`);

    const outcome = await desk.answer(asked.id, 'answer', 'Make the pod longer.', false);
    expect(outcome.isError).toBeUndefined();
    expect(sent).toEqual([
      {
        to: 'atlas',
        text: `[Maestro reply ${asked.id} to your ask_developer request] The developer answered: Make the pod longer.`,
      },
    ]);
    expect(desk.awaitingDeveloper).toBe(false);
  });

  it('takes a spoken yes as the answer, in the developer’s words', async () => {
    const { receive, sent, say } = setup();
    await receive(question());
    const result = await say('approve', 'yes go ahead');
    expect(result?.spoken).toBe('Told Atlas.');
    expect(sent[0]!.text).toContain('The developer answered: yes go ahead');
  });

  it('ignores a yes that came before the question could be heard', async () => {
    const { receive, desk, said, sent, state } = setup();
    await receive(question());
    expect(await desk.answerLatest('approve', 'yes', said.at(-1)!)).toBeNull();
    state.now += HEARD_MS;
    expect(await desk.answerLatest('approve', 'yes', said.at(-1)!)).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('ignores a yes when the question is not the last thing the conductor said', async () => {
    const { receive, desk, sent, state } = setup();
    await receive(question());
    state.now += HEARD_MS;
    // The conductor has since asked the developer something of its own.
    expect(await desk.answerLatest('approve', 'yes', 'Want me to open it?')).toBeNull();
    expect(sent).toEqual([]);
    expect(desk.awaitingDeveloper).toBe(true);
  });

  it('answers the request that was asked last, not the one that arrived last', async () => {
    const { receive, desk, say, sent, state } = setup({ free: false, canDecide: false });
    // Atlas's request arrives first and waits for a free conductor. Bravo's question arrives
    // and is spoken. Then the conductor, with no model to decide, asks about Atlas's request.
    await receive(spawn());
    await receive(question('bravo', 'Which database?'));
    state.now += 5_000;
    state.free = true;
    await desk.drain();

    const result = await say('deny', 'no');
    expect(result?.spoken).toBe('Told Atlas no.');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'atlas', text: expect.stringContaining('Denied') });
    // Bravo's question is still open for its own answer.
    expect(desk.awaitingDeveloper).toBe(true);
  });

  it('counts the developer writing to the agent directly as the answer', async () => {
    const { receive, sent, desk, say } = setup();
    await receive(question());
    desk.noteDeveloperSend('atlas');
    expect(desk.awaitingDeveloper).toBe(false);
    expect(sent).toEqual([]);
    expect(await say('approve', 'yes')).toBeNull();
  });

  it('tells the agent to carry on when the developer never answers', async () => {
    vi.useFakeTimers();
    const { desk, sent, host } = setup();
    await desk.receive(question(), async () => true);
    await vi.advanceTimersByTimeAsync(DEVELOPER_ANSWER_MS + 1);
    expect(sent[0]!.text).toContain('did not respond in time');
    expect(desk.awaitingDeveloper).toBe(false);
    expect(host.decide).not.toHaveBeenCalled();
  });

  it('keeps an unanswered question for the developer’s return, and tells it once', async () => {
    vi.useFakeTimers();
    const { desk, said } = setup();
    await desk.receive(question('atlas', 'Upload the five STEP files?'), async () => true);
    await desk.receive(question('bravo', 'Sign in to PCBWay?'), async () => true);
    expect(desk.takeMissed()).toBeNull();
    await vi.advanceTimersByTimeAsync(DEVELOPER_ANSWER_MS + 1);

    expect(desk.takeMissed()).toBe(
      `2 questions went unanswered while you were away. ${said[0]} ${said[1]}`
    );
    expect(desk.takeMissed()).toBeNull();
  });

  it('drops an unanswered question once the developer has written to that agent', async () => {
    vi.useFakeTimers();
    const { desk } = setup();
    await desk.receive(question(), async () => true);
    await vi.advanceTimersByTimeAsync(DEVELOPER_ANSWER_MS + 1);
    desk.noteDeveloperSend('atlas');
    expect(desk.takeMissed()).toBeNull();
  });

  it('is answered only with words, never with a bare approve or deny', async () => {
    const { receive, desk, sent } = setup();
    const asked = question();
    await receive(asked);
    for (const [decision, words] of [
      ['answer', undefined],
      ['approve', undefined],
      ['deny', 'no'],
    ] as const) {
      expect(await desk.answer(asked.id, decision, words, false)).toMatchObject({ isError: true });
    }
    expect(sent).toEqual([]);
  });
});

describe('spawn_agent', () => {
  it('runs exactly what was asked when the conductor approves, and tells the agent', async () => {
    const { receive, desk, decideWith, acts, sent, said, host } = setup();
    decideWith(async (open) => {
      expect(open).toMatchObject({ kind: 'spawn_agent', awaitingDeveloper: false });
      expect(open.body).toContain(BRIEF);
      const outcome = await desk.answer(open.id, 'approve', undefined, true);
      expect(outcome.content).toContain('Approved');
      return 'Starting a Codex agent for Atlas.';
    });
    const asked = spawn();
    const ack = await receive(asked);

    expect(ack.message).toContain('the conductor will decide it');
    expect(host.decide).toHaveBeenCalledTimes(1);
    expect(acts).toHaveLength(1);
    // Carried out for the asking agent, whose project the new agent starts in.
    expect(acts[0]!.from).toBe('atlas');
    expect(acts[0]!.action).toMatchObject({
      tool: 'spawn_agent',
      input: { provider: 'codex', task_name: 'Order check' },
    });
    expect(acts[0]!.action.input).not.toHaveProperty('project');
    expect(String(acts[0]!.action.input.prompt)).toContain(BRIEF);
    expect(sent).toEqual([
      {
        to: 'atlas',
        text: `[Maestro reply ${asked.id} to your spawn_agent request] Approved by the conductor. Created task "Order check"; it will appear on the canvas as Echo. That agent's final reply will be passed back to you when it finishes.`,
      },
    ]);
    expect(said).toEqual(['Starting a Codex agent for Atlas.']);
    expect(desk.contextLines()).toEqual([]);
  });

  it('passes the new agent’s final reply back to the agent that asked, once', async () => {
    const { receive, desk, decideWith, sent, entries } = setup();
    decideWith(async (open) => {
      await desk.answer(open.id, 'approve', undefined, true);
      return '';
    });
    const asked = spawn();
    await receive(asked);
    sent.length = 0;

    expect(desk.watching('echo')).toBe(true);
    const report = { text: 'All 12 checks pass.', truncated: false, appUrls: [] };
    desk.relayFinished(entries.get('echo')!, report);
    desk.relayFinished(entries.get('echo')!, report);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('atlas');
    expect(sent[0]!.text).toContain(
      `[Reply from agent Echo (task "Task of echo") to your request ${asked.id}`
    );
    expect(sent[0]!.text).toContain('All 12 checks pass.');
  });

  it('does not watch for a reply the agent said it does not need', async () => {
    const { receive, desk, decideWith } = setup();
    decideWith(async (open) => {
      await desk.answer(open.id, 'approve', undefined, true);
      return '';
    });
    await receive(spawn({ report_back: false }));
    expect(desk.watching('echo')).toBe(false);
  });

  it('says a fixed sentence when the model settles a request without a word', async () => {
    const { receive, desk, decideWith, said } = setup();
    decideWith(async (open) => {
      await desk.answer(open.id, 'deny', 'The developer asked for a manual check.', true);
      return '';
    });
    await receive(spawn());
    expect(said).toEqual(['Atlas asks to start a codex agent on “Order check”. I said no.']);
  });

  it('tells the agent why when the conductor denies it', async () => {
    const { receive, desk, decideWith, sent, acts } = setup();
    decideWith(async (open) => {
      await desk.answer(open.id, 'deny', 'The developer asked for a manual check.', true);
      return 'I told Atlas no.';
    });
    const asked = spawn();
    await receive(asked);
    expect(acts).toEqual([]);
    expect(sent[0]!.text).toBe(
      `[Maestro reply ${asked.id} to your spawn_agent request] Denied by the conductor: The developer asked for a manual check. Continue without it.`
    );
  });

  it('keeps what a deciding model can tell the agent to one short, plain line', async () => {
    const { receive, desk, decideWith, sent } = setup();
    decideWith(async (open) => {
      await desk.answer(open.id, 'deny', `secret ${'x'.repeat(2_000)}\u001b[201~`, true);
      return '';
    });
    await receive(spawn());
    expect(sent[0]!.text.length).toBeLessThan(450);
    expect(sent[0]!.text).not.toContain('\u001b');
  });

  it('never waits for the developer when the model leaves the request open', async () => {
    const { receive, desk, decideWith, said, sent, acts, say } = setup();
    decideWith(async () => 'Atlas wants a Codex agent to drive the order form. Okay?');
    const asked = spawn();
    await receive(asked);

    expect(said).toEqual([
      'Atlas asks to start a codex agent on “Order check”. I could not decide it, so nothing was done.',
    ]);
    expect(desk.awaitingDeveloper).toBe(false);
    expect(acts).toEqual([]);
    expect(sent).toEqual([
      {
        to: 'atlas',
        text: expect.stringContaining(
          `[Maestro reply ${asked.id} to your spawn_agent request] The conductor could not decide it just now`
        ),
      },
    ]);
    expect(await say('approve', 'yes')).toBeNull();
  });

  it('asks the developer itself only when no model can decide, and takes their yes', async () => {
    const { receive, desk, said, sent, acts, host, say } = setup({ canDecide: false });
    const asked = spawn();
    await receive(asked);
    expect(host.decide).not.toHaveBeenCalled();
    expect(said).toEqual([
      'Atlas asks to start a codex agent on “Order check”. Say yes to allow it, or no.',
    ]);
    expect(desk.awaitingDeveloper).toBe(true);
    expect(desk.contextLines().join('\n')).toContain("waiting for the developer's yes or no");

    const result = await say('approve', 'yes');
    expect(result?.spoken).toBe('Approved for Atlas.');
    expect(acts).toHaveLength(1);
    expect(sent[0]!.text).toContain(
      `[Maestro reply ${asked.id} to your spawn_agent request] Approved by the developer.`
    );
  });

  it('takes the developer’s no when no model can decide', async () => {
    const { receive, say } = setup({ canDecide: false });
    await receive(spawn());
    const result = await say('deny', 'no');
    expect(result?.spoken).toBe('Told Atlas no.');
  });

  it('does not wait for the developer when the model turn fails', async () => {
    const { receive, said, sent, desk, decideWith } = setup();
    decideWith(async () => {
      throw new Error('api down');
    });
    await receive(spawn());
    expect(said[0]).toContain('I could not decide it, so nothing was done.');
    expect(sent[0]!.text).toContain('Carry on with what you can');
    expect(desk.awaitingDeveloper).toBe(false);
  });

  it('answers a question put to the conductor in its own name, with room to explain', async () => {
    const { receive, desk, decideWith, said, sent } = setup();
    const answer = `Keep the schema and add a nullable column. ${'x'.repeat(2_000)}`;
    decideWith(async (open) => {
      expect(open).toMatchObject({ kind: 'ask_conductor', awaitingDeveloper: false });
      expect((await desk.answer(open.id, 'approve', '', true)).isError).toBe(true);
      expect((await desk.answer(open.id, 'answer', answer, true)).isError).toBeUndefined();
      return 'I told Atlas to add a nullable column.';
    });
    const asked = request('ask_conductor', {
      question: 'The migration fails twice on the old rows. Change the schema or backfill first?',
    });
    await receive(asked);

    expect(said).toEqual(['I told Atlas to add a nullable column.']);
    expect(desk.awaitingDeveloper).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(
      `[Maestro reply ${asked.id} to your ask_conductor request] The conductor answered, deciding on the developer's behalf: Keep the schema`
    );
    expect(sent[0]!.text).not.toContain('The developer answered');
    expect(sent[0]!.text.length).toBeLessThan(1_700);
  });

  it('puts a question for the conductor to the developer when no model can answer it', async () => {
    const { receive, said, sent, say } = setup({ canDecide: false });
    await receive(request('ask_conductor', { question: 'Backfill first?' }));
    expect(said).toEqual(['Atlas asked me: Backfill first? What should I tell it?']);
    await say('approve', 'yes, backfill first');
    expect(sent[0]!.text).toContain('The developer answered: yes, backfill first');
  });

  it('reports a cancelled or failed action to the agent instead of approving', async () => {
    const cancelled = setup();
    cancelled.actReturns({ content: 'The user cancelled the new agent.', cancelled: true });
    cancelled.decideWith(async (open) => {
      const outcome = await cancelled.desk.answer(open.id, 'approve', undefined, true);
      expect(outcome.cancelled).toBe(true);
      return '';
    });
    await cancelled.receive(spawn());
    expect(cancelled.sent[0]!.text).toContain('The developer cancelled it.');
    expect(cancelled.desk.watching('echo')).toBe(false);

    const failed = setup();
    failed.actReturns({ content: 'That project is not open.', isError: true });
    failed.decideWith(async (open) => {
      await failed.desk.answer(open.id, 'approve', undefined, true);
      return '';
    });
    await failed.receive(spawn());
    expect(failed.sent[0]!.text).toContain(
      'Approved, but it could not be carried out: That project is not open.'
    );
  });

  it('waits for the conductor to be free, and decides one request at a time', async () => {
    const { receive, desk, host, state, decideWith } = setup({ free: false });
    let deciding = 0;
    let overlapped = false;
    decideWith(async (open) => {
      deciding += 1;
      overlapped ||= deciding > 1;
      await Promise.resolve();
      await desk.answer(open.id, 'deny', undefined, true);
      deciding -= 1;
      return '';
    });
    await receive(spawn());
    await receive(spawn({ task_name: 'Second' }));
    expect(host.decide).not.toHaveBeenCalled();

    state.free = true;
    await desk.drain();
    expect(host.decide).toHaveBeenCalledTimes(2);
    expect(overlapped).toBe(false);
    expect(desk.contextLines()).toEqual([]);
  });

  it('gives up on a request the conductor never got free to decide', async () => {
    vi.useFakeTimers();
    const { desk, sent, host } = setup({ free: false });
    await desk.receive(spawn(), async () => true);
    await vi.advanceTimersByTimeAsync(DEVELOPER_ANSWER_MS + 1);
    expect(host.decide).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain('No answer');
    expect(desk.contextLines()).toEqual([]);
  });

  it('lets a decision turn settle only its own request', async () => {
    const { receive, desk, decideWith, acts } = setup();
    // Bravo's question already waits for the developer when Atlas's request is decided.
    const waiting = question('bravo', 'Which database?');
    await receive(waiting);
    let refusal: ToolOutcome | undefined;
    decideWith(async (open) => {
      refusal = await desk.answer(waiting.id, 'answer', 'Postgres, the agent says so.', true);
      await desk.answer(open.id, 'deny', undefined, true);
      return '';
    });
    await receive(spawn());

    expect(refusal).toMatchObject({ isError: true });
    expect(refusal!.content).toContain(`${waiting.id} waits for the developer`);
    expect(acts).toEqual([]);
    expect(desk.contextLines().join('\n')).toContain(waiting.id);
  });

  it('lets the developer answer another agent as a decision turn ends', async () => {
    const { receive, desk, decideWith, sent } = setup();
    const waiting = question('bravo', 'Which database?');
    await receive(waiting);
    let answered: ToolOutcome | undefined;
    decideWith(async () => {
      // The developer's own turn, queued behind the decision, starts before the desk hears
      // that the decision turn is over.
      answered = await desk.answer(waiting.id, 'answer', 'Postgres.', false);
      return 'Atlas wants a Codex agent. Okay?';
    });
    await receive(spawn());
    expect(answered?.isError).toBeUndefined();
    expect(sent.filter((message) => message.to === 'bravo')).toEqual([
      { to: 'bravo', text: expect.stringContaining('The developer answered: Postgres.') },
    ]);
  });

  it('does not let a developer turn settle a request that was never put to them', async () => {
    const { receive, desk, acts } = setup({ free: false });
    const asked = spawn();
    await receive(asked);
    const outcome = await desk.answer(asked.id, 'approve', undefined, false);
    expect(outcome).toMatchObject({
      isError: true,
      content: expect.stringContaining('has not been put to the developer yet'),
    });
    expect(acts).toEqual([]);
  });

  it('refuses to approve or deny with "answer", and finds a request by its bare id', async () => {
    const { receive, desk } = setup({ canDecide: false });
    const asked = spawn();
    await receive(asked);
    expect(await desk.answer(asked.id, 'answer', 'sure', false)).toMatchObject({ isError: true });
    expect(await desk.answer('r-nope', 'approve', undefined, false)).toMatchObject({
      isError: true,
      content: expect.stringContaining(`Open: ${asked.id}.`),
    });
    expect(
      (await desk.answer(asked.id.replace('r-', ''), 'deny', undefined, false)).isError
    ).toBeUndefined();
  });

  it('settles everything still open when the developer turns requests off', async () => {
    const { receive, desk, state, sent, acts } = setup({ canDecide: false });
    await receive(spawn());
    await receive(question('bravo'));
    state.enabled = false;
    await desk.drain();
    expect(sent.map((message) => message.to).sort()).toEqual(['atlas', 'bravo']);
    expect(sent[0]!.text).toContain('Requests from agents were turned off.');
    expect(acts).toEqual([]);
    expect(desk.awaitingDeveloper).toBe(false);
  });
});

describe('message_agent', () => {
  const message = (agent: string, from = 'atlas') =>
    request('message_agent', { agent, text: 'Which port is the API on?' }, from);
  const reply = { text: 'Port 8080.', truncated: false, appUrls: [] };

  it('sends the text to the agent named, by id, and returns that agent’s reply', async () => {
    const { receive, desk, decideWith, acts, sent, actReturns, entries } = setup();
    actReturns({ content: 'Sent to Echo (120 characters).', subject: { conversationId: 'echo' } });
    decideWith(async (open) => {
      expect(open.spoken).toBe('Atlas asks to send Echo a message.');
      await desk.answer(open.id, 'approve', undefined, true);
      return 'Passed Atlas’s question to Echo.';
    });
    await receive(message('echo'));

    expect(acts[0]).toMatchObject({
      from: 'atlas',
      targetId: 'echo',
      action: { tool: 'send_to_agent', input: { agent: 'Echo' } },
    });
    expect(String(acts[0]!.action.input.text)).toContain('Which port is the API on?');
    expect(String(acts[0]!.action.input.text)).toContain('[Message from agent Atlas');
    sent.length = 0;
    desk.relayFinished(entries.get('echo')!, reply);
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ to: 'atlas', text: expect.stringContaining('Port 8080.') });
  });

  it('refuses a name that is not an agent on the canvas, and the asker itself', async () => {
    const { receive, host } = setup();
    const unknown = await receive(message('it'));
    expect(unknown).toEqual({
      accepted: false,
      message: 'No agent named "it" is on the canvas. Agents: Atlas, Bravo, Carol, Echo.',
    });
    expect((await receive(message('ATLAS'))).message).toContain('is you');
    expect(host.decide).not.toHaveBeenCalled();
  });

  it('fails the request when the agent it named has gone', async () => {
    const { receive, say, entries, sent, acts } = setup({ canDecide: false });
    await receive(message('Echo'));
    entries.delete('echo');
    const result = await say('approve', 'yes');
    expect(result?.outcome.isError).toBe(true);
    expect(acts).toEqual([]);
    expect(sent[0]!.text).toContain('The agent you named is no longer there.');
  });

  it('gives each agent that asked the same target its reply', async () => {
    const { receive, desk, decideWith, sent, actReturns, entries } = setup();
    actReturns({ content: 'Sent to Echo.', subject: { conversationId: 'echo' } });
    decideWith(async (open) => {
      await desk.answer(open.id, 'approve', undefined, true);
      return '';
    });
    await receive(message('Echo', 'atlas'));
    await receive(message('Echo', 'carol'));
    sent.length = 0;
    desk.relayFinished(entries.get('echo')!, reply);
    await Promise.resolve();
    expect(sent.map((item) => item.to).sort()).toEqual(['atlas', 'carol']);
  });

  it('does not pass on a reply that comes long after the request', async () => {
    const { receive, desk, decideWith, sent, actReturns, entries, state } = setup();
    actReturns({ content: 'Sent to Echo.', subject: { conversationId: 'echo' } });
    decideWith(async (open) => {
      await desk.answer(open.id, 'approve', undefined, true);
      return '';
    });
    await receive(message('Echo'));
    sent.length = 0;
    state.now += WATCH_MS + 1;
    desk.relayFinished(entries.get('echo')!, reply);
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(desk.watching('echo')).toBe(false);
  });
});

describe('when a reply cannot be delivered', () => {
  it('tells the developer instead of losing it silently', async () => {
    const { receive, desk, state, said } = setup();
    const asked = question();
    await receive(asked);
    state.sendFails = 'it is not running.';
    await desk.answer(asked.id, 'answer', 'Longer pod.', false);
    await vi.waitFor(() =>
      expect(said.at(-1)).toBe('Atlas did not get my answer to its request: it is not running.')
    );
  });
});

describe('helpers', () => {
  it('holds typing at permission prompts and dialogs, not at an idle prompt', () => {
    const at = (notificationType: string | null, type = 'pty') =>
      atBlockingPrompt({
        type,
        status: 'awaiting-input',
        notificationType,
      } as Pick<AgentTileEntry, 'type' | 'status' | 'notificationType'>);
    expect(at('permission_prompt')).toBe(true);
    expect(at('elicitation_dialog')).toBe(true);
    expect(at('idle_prompt')).toBe(false);
    expect(at('permission_prompt', 'acp')).toBe(false);
  });

  it('sees a completion only as a change from another state it saw', () => {
    const before = new Map([
      ['a', 'working'],
      ['b', 'completed'],
    ]);
    expect(
      newlyCompleted(before, [
        ['a', 'completed'],
        ['b', 'completed'],
        // Reopened or reloaded already finished: nothing new happened.
        ['c', 'completed'],
        ['d', 'working'],
      ])
    ).toEqual(['a']);
  });
});
