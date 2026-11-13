import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserSessionStore } from './browser-session-store';
import { browserUserOrigins } from './browser-user-origins';
import { TaskBrowserControlStore } from './task-browser-control';

const client = vi.hoisted(() => ({
  registerSession: vi.fn(async (_input: { browserId: string; partition: string }) => ({
    success: true,
  })),
  setControl: vi.fn(async (_input: Record<string, unknown>) => ok(undefined)),
  forgetControl: vi.fn(async (_input: { browserId: string }) => ({ success: true })),
}));

vi.mock('./client', () => ({ getBrowserClient: async () => client }));
vi.mock('@core/primitives/logging/browser/logger', () => ({ log: { warn: vi.fn() } }));

const identity = { projectId: 'p1', workspaceId: 'w1', taskId: 't1' };
const ISOLATED = 'persist:emdash-browser-isolated-p1-w1-t1';

function openTab(browserId: string, profileId = 'default', url = 'http://localhost:4100/') {
  browserSessionStore.createSession({ ...identity, browserId, profileId, initialUrl: url });
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('TaskBrowserControlStore', () => {
  let store: TaskBrowserControlStore;

  beforeEach(() => {
    browserSessionStore.clear();
    browserUserOrigins.origins.clear();
    vi.clearAllMocks();
    store = new TaskBrowserControlStore();
  });

  it("registers a tab on the developer's own profile with main as theirs, never for agents", async () => {
    openTab('tab-1');
    const stop = store.track('tab-1', 'agents');
    await settle();

    expect(client.registerSession).toHaveBeenCalledWith({
      browserId: 'tab-1',
      partition: 'persist:emdash-browser-profile',
    });
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        browserId: 'tab-1',
        control: 'user',
        surface: 'task-view',
        ...identity,
      })
    );
    expect(store.control('tab-1')).toBe('user');
    stop();
    await settle();
    expect(client.forgetControl).toHaveBeenCalledWith({ browserId: 'tab-1' });
  });

  it("hands a tab over by moving it to the task's isolated profile first", async () => {
    openTab('tab-1');
    const stop = store.track('tab-1', 'user');
    await settle();

    expect(await store.handOver('tab-1', ['http://localhost:4100/'])).toBe(true);
    expect(browserSessionStore.getSession('tab-1')?.partition).toBe(ISOLATED);
    expect(browserSessionStore.getSession('tab-1')?.currentUrl).toBe('http://localhost:4100/');
    expect(client.registerSession).toHaveBeenLastCalledWith({
      browserId: 'tab-1',
      partition: ISOLATED,
    });
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ control: 'agents', surface: 'task-view' })
    );
    // Main heard about the isolated partition before it was asked to hand the tab to agents.
    const registerOrder = client.registerSession.mock.invocationCallOrder.at(-1)!;
    const controlOrder = client.setControl.mock.invocationCallOrder.at(-1)!;
    expect(registerOrder).toBeLessThan(controlOrder);
    stop();
  });

  it('never carries a page the developer had open on their own profile over to agents', async () => {
    // A magic sign-in link on another local port: its address and page must not reach agents.
    openTab('tab-1', 'default', 'http://localhost:4300/login?token=secret');
    const stop = store.track('tab-1', 'user');
    await settle();

    expect(await store.handOver('tab-1', ['http://localhost:4100/'])).toBe(true);
    const session = browserSessionStore.getSession('tab-1');
    expect(session?.partition).toBe(ISOLATED);
    expect(session?.currentUrl).toBe('http://localhost:4100/');
    expect(JSON.stringify(client.setControl.mock.calls.at(-1))).not.toContain('4300');
    stop();

    openTab('tab-2', 'default', 'https://mail.example.com/inbox');
    const stopOther = store.track('tab-2', 'user');
    await settle();
    expect(await store.handOver('tab-2', [])).toBe(true);
    expect(browserSessionStore.getSession('tab-2')?.currentUrl).toBe('about:blank');
    stopOther();
  });

  it('allows only local origins the developer opened themselves, never where the page went', async () => {
    openTab('tab-1', 'isolated-per-task');
    const stop = store.track('tab-1', 'agents');
    await settle();
    expect(client.setControl.mock.calls.at(-1)![0]).not.toHaveProperty('origins');

    // The page (or a conductor or agent call) moves the tab to another local service.
    browserSessionStore.updateSession('tab-1', { currentUrl: 'http://localhost:5432/' });
    await settle();
    expect(JSON.stringify(client.setControl.mock.calls)).not.toContain('5432');

    // The developer types an address into the toolbar.
    browserUserOrigins.record('tab-1', 'http://localhost:4300/admin');
    await settle();
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ origins: ['http://localhost:4300'] })
    );
    stop();
  });

  it('drops origins the developer opened on their own profile when the tab moves to agents', async () => {
    openTab('tab-1');
    browserUserOrigins.record('tab-1', 'http://localhost:4300/');
    const stop = store.track('tab-1', 'user');
    await settle();
    await store.handOver('tab-1', ['http://localhost:4100/']);
    expect(JSON.stringify(client.setControl.mock.calls.at(-1))).not.toContain('4300');
    stop();
  });

  it('gives the tab back to the developer when they take it back or leave the isolated profile', async () => {
    openTab('tab-1', 'isolated-per-task');
    const stop = store.track('tab-1', 'agents');
    await settle();
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ control: 'agents' })
    );

    store.takeBack('tab-1');
    await settle();
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ control: 'user' })
    );

    store.setControl('tab-1', 'agents');
    browserSessionStore.setSessionProfile('tab-1', 'default');
    await settle();
    expect(store.control('tab-1')).toBe('user');
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ control: 'user' })
    );
    stop();
  });

  it('falls back to the developer when main refuses', async () => {
    openTab('tab-1', 'isolated-per-task');
    client.setControl.mockResolvedValueOnce({
      success: false,
      error: { type: 'disabled', message: 'off' },
    } as never);
    const stop = store.track('tab-1', 'agents');
    await settle();
    expect(store.control('tab-1')).toBe('user');
    stop();
  });
});
