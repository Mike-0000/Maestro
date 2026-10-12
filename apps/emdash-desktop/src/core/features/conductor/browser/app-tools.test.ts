import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConductorAppTools, type AppTask, type AppToolDeps } from './app-tools';

const client = {
  observe: vi.fn(),
  act: vi.fn(),
};

vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => client,
}));

const task: AppTask = { taskId: 't1', projectId: 'p1', workspaceId: 'w1', name: 'Atlas' };

type Entry = { taskId: string; browserId: string; url: string; control: 'user' | 'agents' };

type AgentEntry = {
  taskId: string;
  status: string;
  completionReport: { appUrls: string[] } | null;
};

function setup(
  options: { entry?: Entry; running?: boolean; answers?: boolean[]; agents?: AgentEntry[] } = {}
) {
  let entry = options.entry;
  const answers = [...(options.answers ?? [])];
  const requestPending = vi.fn(async () => answers.shift() ?? true);
  const host = {
    devServerUrls: vi.fn(() => (options.running ? ['http://localhost:5173/'] : [])),
    appRunning: vi.fn(() => options.running ?? false),
    openForTask: vi.fn((input: AppTask & { url?: string }) => {
      entry ??= {
        taskId: input.taskId,
        browserId: 'b1',
        url: input.url ?? 'http://localhost:5173/',
        control: 'user',
      };
      return entry.browserId;
    }),
    runApp: vi.fn(async () => {}),
    stopApp: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ensureAlive: vi.fn(),
    applyControl: vi.fn(async (_entry: Entry, control: Entry['control']) => {
      if (entry) entry = { ...entry, control };
      return true;
    }),
  };
  const canvas = { browserForTask: vi.fn(() => entry), agentEntries: options.agents ?? [] };
  let now = 1_000;
  const deps = {
    canvas,
    host,
    requestPending,
    resolveTask: (agent: string | undefined) =>
      agent === 'Nobody' ? { error: 'No agent called "Nobody".' } : { task },
  } as unknown as AppToolDeps;
  const tools = new ConductorAppTools(deps, () => now);
  return { tools, host, requestPending, advance: (ms: number) => (now += ms) };
}

const agentsEntry: Entry = {
  taskId: 't1',
  browserId: 'b1',
  url: 'http://localhost:5173/',
  control: 'agents',
};

describe('ConductorAppTools', () => {
  beforeEach(() => {
    client.observe.mockReset();
    client.act.mockReset();
  });

  it('opens an already running app instead of starting it again', async () => {
    const { tools, host, requestPending } = setup({ running: true });
    const outcome = await tools.startApp({});
    expect(outcome.content).toContain('already running');
    expect(host.runApp).not.toHaveBeenCalled();
    expect(requestPending).not.toHaveBeenCalled();
  });

  it('starts the app, and respects a turn that does not allow it', async () => {
    const started = setup();
    await started.tools.startApp({ agent: 'Atlas' });
    expect(started.requestPending).toHaveBeenCalledWith("Run Atlas's app", 'direct');
    expect(started.host.runApp).toHaveBeenCalledWith(task);

    const cancelled = setup({ answers: [false] });
    expect((await cancelled.tools.startApp({})).content).toBe('Cancelled by the user.');
    expect(cancelled.host.runApp).not.toHaveBeenCalled();
  });

  it('reports resolution errors', async () => {
    const { tools } = setup();
    expect(await tools.showApp({ agent: 'Nobody' })).toMatchObject({ isError: true });
  });

  it('asks before handing a user-controlled app to the conductor', async () => {
    const { tools, host, requestPending } = setup({
      entry: { ...agentsEntry, control: 'user' },
      answers: [false],
    });
    const outcome = await tools.lookAtApp({ mode: 'outline' });
    expect(requestPending).toHaveBeenCalledWith("Let the conductor see Atlas's app", 'confirm');
    expect(outcome.content).toContain('keeps this app');
    expect(host.applyControl).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
  });

  it('returns screenshots as images, separate from the text', async () => {
    client.observe.mockResolvedValue({
      success: true,
      data: {
        url: 'http://localhost:5173/',
        title: 'App',
        image: { mediaType: 'image/jpeg', data: 'AAAA', width: 10, height: 10 },
      },
    });
    const { tools } = setup({ entry: agentsEntry });
    const outcome = await tools.lookAtApp({ mode: 'screenshot' });
    expect(outcome.images).toEqual([
      { mediaType: 'image/jpeg', data: 'AAAA', width: 10, height: 10 },
    ]);
    expect(outcome.content).toContain('http://localhost:5173/');
    expect(outcome.content).not.toContain('AAAA');
  });

  it('asks for the first action, then drives without asking during the grace window', async () => {
    client.act.mockResolvedValue({
      success: true,
      data: { url: 'http://localhost:5173/settings', title: 'App', changed: true },
    });
    const { tools, requestPending, advance } = setup({ entry: agentsEntry });
    await tools.useApp({ action: 'navigate', url: '/settings' });
    expect(requestPending).toHaveBeenCalledTimes(1);
    expect(client.act).toHaveBeenCalledWith({
      browserId: 'b1',
      action: { kind: 'navigate', url: 'http://localhost:5173/settings' },
    });
    advance(30_000);
    await tools.useApp({ action: 'click', ref: 'e2' });
    expect(requestPending).toHaveBeenCalledTimes(1);
    advance(61_000);
    await tools.useApp({ action: 'click', ref: 'e2' });
    expect(requestPending).toHaveBeenCalledTimes(2);
  });

  it('does not act when the action is not allowed or input is invalid', async () => {
    const { tools } = setup({ entry: agentsEntry, answers: [false] });
    expect((await tools.useApp({ action: 'reload' })).content).toBe('Cancelled by the user.');
    expect(await tools.useApp({ action: 'click' })).toMatchObject({ isError: true });
    expect(client.act).not.toHaveBeenCalled();
  });

  it('opens the local URL a finished agent reported when no dev server is detected', async () => {
    const { tools, host } = setup({
      agents: [
        {
          taskId: 't1',
          status: 'completed',
          completionReport: { appUrls: ['http://localhost:3000/'] },
        },
      ],
    });
    const outcome = await tools.showApp({ agent: 'Atlas' });
    expect(host.openForTask).toHaveBeenCalledWith({ ...task, url: 'http://localhost:3000/' });
    expect(outcome.content).toContain('http://localhost:3000/');
  });

  it('prefers a detected dev server over a reported URL', async () => {
    const { tools, host } = setup({
      running: true,
      agents: [
        {
          taskId: 't1',
          status: 'completed',
          completionReport: { appUrls: ['http://localhost:3000/'] },
        },
      ],
    });
    await tools.showApp({});
    expect(host.openForTask).toHaveBeenCalledWith(task);
  });

  it('opens local URLs but refuses other origins, whoever named them', async () => {
    const local = setup();
    expect(await local.tools.showApp({ url: 'http://127.0.0.1:8080/admin' })).not.toMatchObject({
      isError: true,
    });
    expect(local.host.openForTask).toHaveBeenCalledWith({
      ...task,
      url: 'http://127.0.0.1:8080/admin',
    });

    const remote = setup({ running: true });
    const outcome = await remote.tools.showApp({ url: 'https://evil.example/login' });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.content).toContain('only opens');
    expect(remote.host.openForTask).not.toHaveBeenCalled();

    const relative = setup({ running: true });
    await relative.tools.showApp({ url: '/settings' });
    expect(relative.host.openForTask).toHaveBeenCalledWith({
      ...task,
      url: 'http://localhost:5173/settings',
    });
  });

  it('refuses to observe when there is neither a browser nor a dev server', async () => {
    const { tools, host } = setup();
    expect(await tools.lookAtApp({ mode: 'text' })).toMatchObject({ isError: true });
    expect(host.openForTask).not.toHaveBeenCalled();
  });
});
