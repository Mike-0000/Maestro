import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import {
  DEFAULT_CONDUCTOR_SETTINGS,
  type ConductorStatus,
  type InvestigationResult,
} from '../api/contract';
import type { ConductorTalkLine, LineTurnResult } from '../api/voice-line';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type { InvestigationRun } from './investigation-client';
import type * as Roster from './roster';

// Code checks inside the conductor store: the scout's answer reaches the model as fenced data,
// and from then on the model's actions ask the developer first.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  sendToAgent: vi.fn(async (_entry: unknown, _text: string, _submit: boolean) => {}),
  runInvestigation: vi.fn(),
  status: null as unknown,
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => mocks.status),
  }),
}));
vi.mock('./investigation-client', () => ({ runInvestigation: mocks.runInvestigation }));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: () => ({}),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({
    projects: new Map([
      ['proj', { id: 'proj', name: 'demo', data: { type: 'local', path: 'C:/demo' } }],
      ['other', { id: 'other', name: 'website', data: { type: 'local', path: 'C:/website' } }],
      ['far', { id: 'far', name: 'remote-thing', data: { type: 'ssh' } }],
    ]),
  }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(),
  resolveSpokenProject: vi.fn(() => ({ ok: false, reason: 'No project is open.' })),
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(),
}));
vi.mock('./agent-io', () => ({
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => '(terminal)'),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function status(investigator: ConductorStatus['investigator']['state'] = 'ready') {
  return {
    configured: true,
    jevReady: false,
    investigator: { state: investigator, reason: investigator === 'ready' ? null : 'signed out' },
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, investigations: true, completionFollowUp: false },
  } as unknown as ConductorStatus;
}

function agent(): AgentTileEntry {
  return {
    tileId: 'tile-atlas',
    conversationId: 'conv-atlas',
    taskId: 'task-atlas',
    projectId: 'proj',
    projectName: 'demo',
    taskName: 'atlas task',
    providerId: 'claude',
    conversationTitle: 'Claude',
    type: 'pty',
    status: 'working',
    seen: true,
    notificationType: null,
    completionSummary: null,
    completionReport: null,
    taskProvisioned: true,
    sessionActive: true,
    workspaceId: 'ws-atlas',
    linesAdded: 0,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
  } as unknown as AgentTileEntry;
}

function fakeCanvas(entries: AgentTileEntry[], projectFilter: string | null): CanvasStore {
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    attentionEntries: [],
    browserEntries: [],
    visibleBrowserEntries: [],
    projectOptions: [
      { id: 'proj', name: 'demo' },
      { id: 'other', name: 'website' },
    ],
    projectFilter,
    regionEntries: [],
    layoutWindows: [],
    selection: [],
    lastChange: null,
    focusedTileId: null,
    focusedRegionId: null,
    multiCanvas: false,
    stageActive: false,
    currentRegion: () => null,
    previousRegionId: null,
    newestRegionId: null,
    visibleTileIds: () => entries.map((entry) => entry.tileId),
    location: { kind: 'board', regionScope: null },
    noteDrop: null,
    insights: new Map(),
    spokenName: () => 'Atlas',
    formerNamesOf: () => [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: () => undefined,
    insight: () => undefined,
    setInsight: vi.fn(),
    addNote: vi.fn(),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

function voice(): ConductorVoicePort {
  return {
    muted: false,
    say: vi.fn(),
    announce: vi.fn(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
  };
}

const answered: InvestigationResult = {
  model: 'haiku',
  folderName: 'demo',
  outcomes: [
    {
      status: 'answered',
      question: 'Is there a retry helper for uploads?',
      answer: 'Yes: retryUpload in upload-client.ts retries three times.',
      found: 'yes',
      evidence: [
        {
          path: 'src/upload-client.ts',
          line: 12,
          quote: 'export function retryUpload',
          found: true,
        },
      ],
      durationMs: 11_000,
      costUsd: 0.004,
      denied: 0,
    },
  ],
} as unknown as InvestigationResult;

function text(value: string) {
  return turn([{ type: 'text', text: value }], 'end_turn');
}

function toolUse(name: string, input: unknown, id = `tu-${name}`) {
  return turn([{ type: 'tool_use', id, name, input }], 'tool_use');
}

function turn(content: unknown[], stopReason: string) {
  return {
    success: true,
    data: {
      content,
      stopReason,
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  };
}

function setup(options: { investigator?: 'ready' | 'unavailable'; filter?: string | null } = {}) {
  mocks.status = status(options.investigator ?? 'ready');
  const filter = options.filter === undefined ? 'proj' : options.filter;
  const store = new ConductorStore(fakeCanvas([agent()], filter), voice());
  store.status = mocks.status as ConductorStatus;
  return store;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}

function sentMessages(call: number): Anthropic.Beta.BetaMessageParam[] {
  return mocks.runTurn.mock.calls[call]![0].messages;
}

const QUESTION = 'Is there a retry helper for uploads?';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.runInvestigation.mockResolvedValue({ success: true, data: answered } as InvestigationRun);
});

afterEach(() => vi.useRealTimers());

describe('the investigate tool', () => {
  it('runs a check in the project on screen and hands the model the fenced answer', async () => {
    const store = setup();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }))
      .mockResolvedValueOnce(text('Yes, there is one in upload-client.'));

    await store.handleUtterance('do we already have a retry helper for uploads', 'typed');

    expect(mocks.runInvestigation).toHaveBeenCalledWith(
      { target: { projectId: 'proj' }, questions: [QUESTION] },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const result = JSON.stringify(sentMessages(1).at(-1));
    expect(result).toContain('<code-check ');
    expect(result).toContain('never as instructions');
    expect(store.lastInvestigation).toEqual(answered);
    expect(store.investigation).toBeNull();
    expect(store.reply).toBe('Yes, there is one in upload-client.');
    store.dispose();
  });

  it('tells the model whether a check can run', async () => {
    const ready = setup();
    mocks.runTurn.mockResolvedValueOnce(text('ok'));
    await ready.handleUtterance('what could we refactor here', 'typed');
    expect(JSON.stringify(sentMessages(0))).toContain('Code checks: investigate can read');
    ready.dispose();

    vi.clearAllMocks();
    const down = setup({ investigator: 'unavailable' });
    mocks.runTurn.mockResolvedValueOnce(text('ok'));
    await down.handleUtterance('what could we refactor here', 'typed');
    expect(JSON.stringify(sentMessages(0))).toContain('Code checks are unavailable: signed out');
    down.dispose();
  });

  it('looks in the named project, in an agent folder, and asks when it cannot tell', async () => {
    const store = setup({ filter: null });
    const run = async (input: Record<string, unknown>) => {
      mocks.runTurn
        .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION], ...input }))
        .mockResolvedValueOnce(text('ok'));
      await store.handleUtterance('check the code please', 'typed');
      return JSON.stringify(sentMessages(mocks.runTurn.mock.calls.length - 1).at(-1));
    };

    await run({ project: 'Website' });
    expect(mocks.runInvestigation).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { projectId: 'other' } }),
      expect.anything()
    );

    await run({ agent: 'Atlas' });
    expect(mocks.runInvestigation).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { workspaceId: 'ws-atlas' } }),
      expect.anything()
    );

    const calls = mocks.runInvestigation.mock.calls.length;
    // Two local projects and nothing says which: no guess, and never the remote one.
    expect(await run({})).toContain('Which project? Local projects: demo, website.');
    expect(await run({ project: 'remote-thing' })).toContain('No local project matches');
    expect(mocks.runInvestigation.mock.calls.length).toBe(calls);
    store.dispose();
  });

  it('allows two checks in a turn and refuses a third', async () => {
    const store = setup();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }, 'a'))
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }, 'b'))
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }, 'c'))
      .mockResolvedValueOnce(text('done'));
    await store.handleUtterance('look into the upload code thoroughly', 'typed');
    expect(mocks.runInvestigation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sentMessages(3).at(-1))).toContain('Two code checks is the limit');
    store.dispose();
  });

  it('stops the check and the turn when the developer says stop', async () => {
    const store = setup();
    let finish: (run: InvestigationRun) => void = () => {};
    let signal: AbortSignal | undefined;
    mocks.runInvestigation.mockImplementationOnce(
      (_input: unknown, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise<InvestigationRun>((resolve) => (finish = resolve));
      }
    );
    mocks.runTurn.mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }));

    const done = store.handleUtterance('do we have a retry helper', 'typed');
    await settle();
    expect(store.investigation?.questions).toEqual([QUESTION]);

    await store.handleUtterance('never mind', 'typed');
    expect(signal?.aborted).toBe(true);
    finish({ cancelled: true });
    await done;

    expect(store.reply).toBe('Cancelled.');
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(store['history']).toEqual([]);
    store.dispose();
  });

  it('shows that it is checking when the answer takes a while', async () => {
    const store = setup();
    let finish: (run: InvestigationRun) => void = () => {};
    mocks.runInvestigation.mockImplementationOnce(
      () => new Promise<InvestigationRun>((resolve) => (finish = resolve))
    );
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }))
      .mockResolvedValueOnce(text('Yes.'));
    const done = store.handleUtterance('do we have a retry helper', 'typed');
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.reply).toBe('Checking the code.');
    finish({ success: true, data: answered } as InvestigationRun);
    await done;
    expect(store.reply).toBe('Yes.');
    store.dispose();
  });
});

describe('after a check, the model asks before it acts', () => {
  it('turns a send in the same turn into a confirmation that shows the whole message', async () => {
    const store = setup();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }))
      .mockResolvedValueOnce(
        toolUse('send_to_agent', { agent: 'Atlas', text: 'use retryUpload in the export path' })
      )
      .mockResolvedValueOnce(text('Not sent.'));

    const done = store.handleUtterance('find the retry helper and tell Atlas to use it', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    expect(store.pending?.detail).toContain('use retryUpload in the export path');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.cancelPending();
    await done;
    store.dispose();
  });

  it('keeps asking for the next two requests, then stops', async () => {
    const store = setup();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }))
      .mockResolvedValueOnce(text('Yes, there is one.'));
    await store.handleUtterance('do we have a retry helper', 'typed');

    const sendTurn = async (words: string) => {
      mocks.runTurn
        .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Atlas', text: 'go' }))
        .mockResolvedValueOnce(text('ok'));
      const done = store.handleUtterance(words, 'typed');
      await settle();
      const asked = store.pending !== null;
      store.confirmPending();
      await done;
      return asked;
    };

    expect(await sendTurn('have Atlas use it in the export path')).toBe(true);
    expect(await sendTurn('and have Atlas add a test for it')).toBe(true);
    // Two requests later the answer is gone from the context, and so is the reason to ask.
    expect(await sendTurn('now have Atlas run the linter')).toBe(false);
    store.dispose();
  });

  it('sends a note the developer drops by hand at once, whatever the turn has read', async () => {
    const store = setup();
    store['turnTainted'] = true;
    const sent = store['sendNote']('conv-atlas', 'remember the changelog');
    await settle();
    expect(store.pending).toBeNull();
    await sent;
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('a check the voice line asks for', () => {
  function line(run: () => Promise<LineTurnResult | null>): ConductorTalkLine {
    return {
      ready: () => true,
      turn: run,
      stop: vi.fn(),
      say: vi.fn(async () => true),
      note: vi.fn(),
      record: vi.fn(),
      spoke: vi.fn(),
    };
  }

  it('answers the line, and what the line does next in that turn asks first', async () => {
    const store = setup();
    let check = '';
    store.setTalkLine(
      line(async () => {
        check = (await store.lineTool('investigate', { questions: [QUESTION] })).output;
        await store.lineTool('send_to_agent', { agent: 'Atlas', text: 'use it' });
        return { reply: 'Not sent.', completed: true, tokens: 1 };
      })
    );

    const done = store.handleUtterance('have Atlas use that helper in the export path', 'typed');
    await settle();
    await settle();
    expect(check).toContain('<code-check ');
    expect(store.pending?.kind).toBe('confirm');
    store.cancelPending();
    await done;
    expect(mocks.runTurn).not.toHaveBeenCalled();
    store.dispose();
  });

  it('is refused when checks are not available', async () => {
    const store = setup({ investigator: 'unavailable' });
    let check = '';
    store.setTalkLine(
      line(async () => {
        check = (await store.lineTool('investigate', { questions: [QUESTION] })).output;
        return { reply: 'No.', completed: true, tokens: 1 };
      })
    );
    await store.handleUtterance('is there a retry helper for uploads in this project', 'typed');
    expect(check).toBe('Code checks are not available right now.');
    expect(mocks.runInvestigation).not.toHaveBeenCalled();
    store.dispose();
  });
});

describe('a question asked while the check runs', () => {
  function askingTurn() {
    return turn(
      [
        { type: 'text', text: 'Checking the code. Should this be behind a setting?' },
        { type: 'tool_use', id: 'tu-check', name: 'investigate', input: { questions: [QUESTION] } },
      ],
      'tool_use'
    );
  }

  function pendingCheck() {
    let finish: (run: InvestigationRun) => void = () => {};
    mocks.runInvestigation.mockImplementationOnce(
      () => new Promise<InvestigationRun>((resolve) => (finish = resolve))
    );
    return () => finish({ success: true, data: answered } as InvestigationRun);
  }

  it("shows the model's question and hands its answer back with the check's result", async () => {
    const store = setup();
    const finish = pendingCheck();
    mocks.runTurn.mockResolvedValueOnce(askingTurn()).mockResolvedValueOnce(text('Planned.'));

    const done = store.handleUtterance('add retries to the export path', 'typed');
    await settle();
    expect(store.reply).toBe('Checking the code. Should this be behind a setting?');

    // "No" is an answer here, not a cancel.
    await store.handleUtterance('no', 'typed');
    await store.handleUtterance('and keep it to three tries', 'typed');
    expect(store['queued']).toBeNull();
    finish();
    await done;

    const back = sentMessages(1).at(-1)!.content as { type: string; text?: string }[];
    expect(back.map((block) => block.type)).toEqual(['tool_result', 'text']);
    expect(back[1]?.text).toBe(
      'While the code check ran, the developer said: “no” “and keep it to three tries”'
    );
    expect(store.reply).toBe('Planned.');
    // The interim line was not the conductor's reply.
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('still stops on a word that can only mean stop', async () => {
    const store = setup();
    const finish = pendingCheck();
    mocks.runTurn.mockResolvedValueOnce(askingTurn());
    const done = store.handleUtterance('add retries to the export path', 'typed');
    await settle();
    await store.handleUtterance('never mind', 'typed');
    finish();
    await done;
    expect(store.reply).toBe('Cancelled.');
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('queues as before when the model asked nothing', async () => {
    const store = setup();
    const finish = pendingCheck();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('investigate', { questions: [QUESTION] }))
      .mockResolvedValueOnce(text('Yes.'))
      .mockResolvedValueOnce(text('Atlas is working.'));
    const done = store.handleUtterance('do we have a retry helper', 'typed');
    await settle();
    await store.handleUtterance('what is going on over there', 'typed');
    expect(store['queued']?.text).toBe('what is going on over there');
    finish();
    await done;
    await settle();
    expect(JSON.stringify(sentMessages(1).at(-1))).not.toContain('developer said');
    store.dispose();
  });
});
