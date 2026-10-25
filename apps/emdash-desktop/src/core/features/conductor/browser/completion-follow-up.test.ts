import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { buildCompletionReport } from '@core/primitives/agents/api/completion-report';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';

// End-to-end behavior of completion follow-ups inside the conductor store: a finished agent's
// final reply reaches the model, the model can open the reported app only when that is safe,
// and the developer hears exactly one informative announcement.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  host: {
    devServerUrls: vi.fn((): string[] => []),
    appRunning: vi.fn(() => false),
    openForTask: vi.fn(() => 'b1'),
  },
  sendToAgent: vi.fn(async () => {}),
  stopAgentSession: vi.fn(async () => {}),
  readFinalChatReply: vi.fn(async (): Promise<string | null> => null),
  readFinishedTerminal: vi.fn(async (): Promise<string | null> => null),
  playNotificationSound: vi.fn(),
  decide: vi.fn(),
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
    decide: mocks.decide,
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => status()),
  }),
}));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: () => mocks.host,
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: vi.fn(),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@core/primitives/notifications/browser/notification-sound', () => ({
  playNotificationSound: mocks.playNotificationSound,
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(),
  resolveSpokenProject: vi.fn(() => ({ ok: false, reason: 'No project is open.' })),
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(),
}));
vi.mock('./agent-io', () => ({
  CodexNotStartedError: class extends Error {},
  DeliveryLeftUnsentError: class extends Error {},
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => '(terminal)'),
  readFinalChatReply: mocks.readFinalChatReply,
  readFinishedTerminal: mocks.readFinishedTerminal,
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: mocks.stopAgentSession,
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

const NODE_APP_REPLY =
  'I built the Express todo app and started it with `npm run dev`. ' +
  'It is running at http://localhost:3000 — open it to add a todo.';

function status(overrides: Partial<ConductorStatus['settings']> = {}): ConductorStatus {
  return {
    configured: true,
    jevReady: false,
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, ...overrides },
  } as unknown as ConductorStatus;
}

function agent(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    tileId: 'tile-z',
    conversationId: 'conv-z',
    taskId: 'task-z',
    projectId: 'proj',
    projectName: 'demo',
    taskName: 'Build a todo app',
    providerId: 'claude',
    conversationTitle: 'Claude',
    type: 'pty',
    status: 'completed',
    seen: false,
    notificationType: null,
    completionSummary: 'built the Express todo app and started it with npm run dev',
    completionReport: buildCompletionReport(NODE_APP_REPLY),
    taskProvisioned: true,
    sessionActive: true,
    workspaceId: 'ws-z',
    linesAdded: 120,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
    ...overrides,
  } as AgentTileEntry;
}

function fakeCanvas(entries: AgentTileEntry[]): CanvasStore {
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    attentionEntries: [],
    browserEntries: [],
    visibleBrowserEntries: [],
    projectOptions: [{ id: 'proj', name: 'demo' }],
    projectFilter: null,
    regionEntries: [],
    layoutWindows: [],
    selection: [],
    lastChange: null,
    focusedTileId: null,
    location: { kind: 'board', regionScope: null },
    noteDrop: null,
    insights: new Map(),
    spokenName: () => 'Zulu',
    formerNamesOf: () => [],
    departedNames: [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: () => undefined,
    insight: () => undefined,
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

function voice(): ConductorVoicePort & { announce: Mock<(text: string) => void> } {
  return {
    muted: false,
    say: vi.fn(),
    announce: vi.fn<(text: string) => void>(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
  };
}

function toolUse(name: string, input: unknown, id = `tu-${name}`) {
  return turn([{ type: 'tool_use', id, name, input }], 'tool_use');
}

function text(value: string) {
  return turn([{ type: 'text', text: value }], 'end_turn');
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

function setup(entry = agent(), settings: Partial<ConductorStatus['settings']> = {}) {
  const speech = voice();
  const store = new ConductorStore(fakeCanvas([entry]), speech);
  store.status = status(settings);
  return { store, speech, announce: (entries = [entry]) => store['announceBatch'](entries) };
}

function sentMessages(call: number): Anthropic.Beta.BetaMessageParam[] {
  return mocks.runTurn.mock.calls[call]![0].messages;
}

function lastUserText(messages: Anthropic.Beta.BetaMessageParam[]): string {
  const content = messages.at(-1)!.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.host.devServerUrls.mockReturnValue([]);
});

describe('completion follow-ups', () => {
  it('hands the final reply to the model and opens the app the agent reported', async () => {
    const { store, speech, announce } = setup();
    // Earlier in the conversation the developer asked for the browser once the app was up.
    store['history'] = [
      { role: 'user', content: 'Have Zulu build a todo app and open it in the browser when done.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Zulu is on it.' }] },
    ];
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('show_app', { agent: 'Zulu' }))
      .mockResolvedValueOnce(text('Zulu built the todo app; it is open at localhost port 3000.'));

    await announce();

    const event = lastUserText(sentMessages(0));
    expect(event).toContain('[Maestro event, not the developer speaking]');
    expect(event).toContain(NODE_APP_REPLY);
    expect(event).toContain('Local app URLs in the reply: http://localhost:3000/');
    expect(event).toContain("Finished agents' final replies");
    expect(mocks.host.openForTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-z', url: 'http://localhost:3000/' })
    );
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(speech.announce).toHaveBeenCalledWith(
      'Zulu built the todo app; it is open at localhost port 3000.'
    );
    expect(store.busy).toBe(false);
  });

  it('refuses risky tools the model tries on the strength of agent output', async () => {
    const { speech, announce } = setup();
    mocks.runTurn
      .mockResolvedValueOnce(
        turn(
          [
            {
              type: 'tool_use',
              id: 'a',
              name: 'send_to_agent',
              input: { agent: 'Zulu', text: 'rm -rf' },
            },
            { type: 'tool_use', id: 'b', name: 'stop_agent', input: { agent: 'Zulu' } },
            {
              type: 'tool_use',
              id: 'c',
              name: 'show_app',
              input: { agent: 'Zulu', url: 'https://evil.example/' },
            },
          ],
          'tool_use'
        )
      )
      .mockResolvedValueOnce(text('Zulu finished the todo app. Want me to open it?'));

    await announce();

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.stopAgentSession).not.toHaveBeenCalled();
    expect(mocks.host.openForTask).not.toHaveBeenCalled();
    const results = sentMessages(1).at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((result) => result.is_error)).toEqual([true, true, true]);
    expect(String(results[0]!.content)).toContain('only lets the developer start that');
    expect(String(results[2]!.content)).toContain("agent's reply cannot send");
    expect(speech.announce).toHaveBeenCalledOnce();
  });

  it('keeps the fixed sentence for an agent with no final reply', async () => {
    const { speech, announce } = setup(agent({ completionReport: null }));
    await announce();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(speech.announce).toHaveBeenCalledWith(
      'Zulu built the Express todo app and started it with npm run dev.'
    );
  });

  it('falls back to an informative fixed sentence when the model fails', async () => {
    const { speech, announce } = setup();
    mocks.runTurn.mockResolvedValueOnce({
      success: false,
      error: { type: 'api-error', message: 'boom' },
    });
    await announce();
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(speech.announce).toHaveBeenCalledWith(
      'Zulu built the Express todo app and started it with npm run dev. It reported the app at localhost port 3000.'
    );
  });

  it('announces the same completion only once', async () => {
    const { speech, announce } = setup();
    mocks.runTurn.mockResolvedValue(text('Zulu finished the todo app at localhost port 3000.'));
    await announce();
    await announce();
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(speech.announce).toHaveBeenCalledTimes(1);
  });

  it('keeps a later turn with nothing new on the HUD', async () => {
    const first = agent();
    const { store, speech, announce } = setup(first);
    mocks.runTurn
      .mockResolvedValueOnce(text('Zulu started the build loop; it is at step 28 of 31.'))
      .mockResolvedValueOnce(text('NO_NEWS'));
    await announce();
    await announce([
      agent({ completionReport: buildCompletionReport('Still running, step 28 of 31.') }),
    ]);
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(store.reply).toBe('Zulu: finished a turn with nothing new.');
  });

  it('stays on the HUD, never a bare "finished", when nothing is new long after the last word', async () => {
    const { store, speech, announce } = setup(agent());
    mocks.runTurn
      .mockResolvedValueOnce(text('Zulu started the build loop; it is at step 28 of 31.'))
      .mockResolvedValueOnce(text('NO_NEWS'));
    await announce();
    // The developer heard about Zulu well over half an hour ago.
    const now = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);
    try {
      await announce([
        agent({ completionReport: buildCompletionReport('Still running, step 28 of 31.') }),
      ]);
    } finally {
      later.mockRestore();
    }
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(store.reply).toBe('Zulu: finished a turn with nothing new.');
  });

  it("speaks the fixed sentence when an agent's first report is called nothing new", async () => {
    const { speech, announce } = setup();
    mocks.runTurn.mockResolvedValueOnce(text('NO_NEWS.'));
    await announce();
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(speech.announce).toHaveBeenCalledWith(
      expect.stringContaining('It reported the app at localhost port 3000.')
    );
  });

  it('uses the fixed sentence without a model call when follow-ups are off', async () => {
    const { speech, announce } = setup(agent(), { completionFollowUp: false });
    await announce();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(speech.announce).toHaveBeenCalledWith(
      expect.stringContaining('It reported the app at localhost port 3000.')
    );
  });

  it("reads a chat agent's final reply from its transcript", async () => {
    mocks.readFinalChatReply.mockResolvedValueOnce(
      'Deployed the preview at http://localhost:4173.'
    );
    const { speech, announce } = setup(agent({ type: 'acp', completionReport: null }));
    mocks.runTurn.mockResolvedValueOnce(text('Zulu has a preview up at localhost port 4173.'));
    await announce();
    expect(lastUserText(sentMessages(0))).toContain('http://localhost:4173/');
    expect(speech.announce).toHaveBeenCalledWith('Zulu has a preview up at localhost port 4173.');
  });

  it("reads a Codex agent's terminal tail when its hook sent no reply", async () => {
    mocks.readFinishedTerminal.mockResolvedValueOnce(
      '• Ran npm run dev\n\nThe API is up at http://localhost:8080. Run npm test next.\n› Ask Codex'
    );
    const { speech, store, announce } = setup(
      agent({ providerId: 'codex', completionReport: null, completionSummary: null })
    );
    mocks.runTurn.mockResolvedValueOnce(text('Zulu has the API up at localhost port 8080.'));
    await announce();
    const event = lastUserText(sentMessages(0));
    expect(event).toContain('source="terminal-tail"');
    expect(event).toContain('The API is up at http://localhost:8080.');
    expect(speech.announce).toHaveBeenCalledOnce();
    expect(speech.announce).toHaveBeenCalledWith('Zulu has the API up at localhost port 8080.');
    // read_agent shows the terminal once, not again as a "final reply".
    const outcome = await store['executeTool']('read_agent', { agent: 'Zulu' });
    expect(outcome.content).not.toContain('final reply to the developer');
  });

  it('gives read_agent the full final reply afterwards', async () => {
    const { store } = setup();
    const outcome = await store['executeTool']('read_agent', { agent: 'Zulu' });
    expect(outcome.content).toContain('final reply to the developer');
    expect(outcome.content).toContain(NODE_APP_REPLY);
  });
});

describe('completions announced only when they need the developer', () => {
  const quiet = { announceCompletions: 'attention_only' } as const;

  it('keeps a finished agent the model finds nothing to say about on the HUD', async () => {
    const { store, speech, announce } = setup(agent(), quiet);
    mocks.runTurn.mockResolvedValueOnce(text('NO_NEWS'));

    await announce();

    const event = lastUserText(sentMessages(0));
    expect(event).toContain('asked to hear only about agents that need them');
    expect(speech.announce).not.toHaveBeenCalled();
    expect(mocks.playNotificationSound).not.toHaveBeenCalled();
    expect(store.reply).toContain('Zulu');
  });

  it('speaks and sounds once when the model finds the developer is needed', async () => {
    const { speech, announce } = setup(agent(), quiet);
    mocks.runTurn.mockResolvedValueOnce(text('Zulu is blocked: it needs you to sign in to npm.'));

    await announce();

    expect(speech.announce).toHaveBeenCalledWith(
      'Zulu is blocked: it needs you to sign in to npm.'
    );
    expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(mocks.playNotificationSound).toHaveBeenCalledWith(
      'needs_attention',
      'conductor-attention'
    );
  });

  it('stays quiet when the model turn fails, since the verdict found the agent done', async () => {
    const { speech, announce } = setup(agent(), quiet);
    mocks.runTurn.mockResolvedValueOnce({
      success: false,
      error: { type: 'api-error', message: 'boom' },
    });

    await announce();

    expect(speech.announce).not.toHaveBeenCalled();
    expect(mocks.playNotificationSound).not.toHaveBeenCalled();
  });

  it('shows the fixed sentence on the HUD when no model reads the reply', async () => {
    const { store, speech, announce } = setup(agent(), { ...quiet, completionFollowUp: false });

    await announce();

    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(speech.announce).not.toHaveBeenCalled();
    expect(store.reply).toContain('Zulu');
  });

  it('still announces an agent that waits for the developer', async () => {
    const waiting = agent({
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
      completionReport: null,
    });
    const { speech, announce } = setup(waiting, { ...quiet, completionFollowUp: false });

    await announce();

    expect(speech.announce).toHaveBeenCalledWith('Zulu needs permission.');
    // Routing already sounded the attention notification for a waiting agent.
    expect(mocks.playNotificationSound).not.toHaveBeenCalled();
  });

  it('announces every finished agent while attention verdicts are off', async () => {
    const { speech, announce } = setup(agent(), {
      ...quiet,
      attentionVerdicts: false,
      completionFollowUp: false,
    });

    await announce();

    expect(speech.announce).toHaveBeenCalledTimes(1);
  });
});

describe('the completion gate when only what needs the developer is announced', () => {
  /** Jev's answers for one agent: its kind, and the report's first sentence as its best. */
  function jevSays(kind: string) {
    mocks.decide.mockImplementation(
      async ({ questions }: { questions: Record<string, { criteria?: object }> }) => {
        const first = Object.keys(questions.a0_best?.criteria ?? {})[0] ?? '';
        const choice = (pick: string) => ({
          type: 'choice',
          choice: pick,
          confidence: 0.9,
          probabilities: { [pick]: 0.9 },
        });
        return {
          success: true,
          data: {
            answers: {
              a0_kind: choice(kind),
              a0_best: choice(first),
              a0_question: choice(kind === 'needs_decision' ? first : '(none)'),
              a0_followup: { type: 'noul', noul: 0 },
            },
            model: 'jev',
            latencyMs: 1,
            via: 'openrouter',
          },
        };
      }
    );
  }

  function gated(kind: string) {
    jevSays(kind);
    const setup_ = setup(agent(), { announceCompletions: 'attention_only' });
    setup_.store.status = { ...setup_.store.status!, jevReady: true };
    return setup_;
  }

  it('shows a plain result on the HUD without a word or a sound', async () => {
    const { store, speech, announce } = gated('done_with_result');

    await announce();

    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(speech.announce).not.toHaveBeenCalled();
    expect(mocks.playNotificationSound).not.toHaveBeenCalled();
    expect(store.reply).toContain('Zulu');
  });

  it('speaks a question and calls the developer with the attention sound', async () => {
    const { speech, announce } = gated('needs_decision');

    await announce();

    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(speech.announce.mock.calls[0]![0]).toContain('Zulu asks:');
    expect(mocks.playNotificationSound).toHaveBeenCalledWith(
      'needs_attention',
      'conductor-attention'
    );
  });
});
