import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { ConductorStatus } from '../../api/contract';
import { ChatConductorManager } from './manager';

// Which conductor is in front, and which of its task's chats is on screen.

vi.mock('../../api/browser/client', () => ({
  getConductorClient: async () => ({
    readTaskThread: async () => null,
    listTaskThreads: async () => [],
    listChatThreads: async () => [],
  }),
}));
vi.mock('./agent-port', () => ({
  chatName: () => 'Chat',
  createTaskAgentPort: () => ({ chats: () => [], snapshot: () => null, watch: () => () => {} }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const ENTRIES = [
  { conversationId: 'conv-atlas', taskId: 'task-login', taskName: 'Fix login' },
  { conversationId: 'conv-bravo', taskId: 'task-login', taskName: 'Fix login' },
  { conversationId: 'conv-cid', taskId: 'task-docs', taskName: 'Docs' },
];

function setup() {
  const conductor = observable(
    { status: { chatConductorReady: true } as unknown as ConductorStatus | null },
    { status: observable.ref }
  );
  const canvas = {
    agentEntries: ENTRIES,
    spokenName: () => 'Agent',
  } as unknown as CanvasStore;
  const manager = new ChatConductorManager(canvas, conductor);
  const login = manager.session('task-login');
  const docs = manager.session('task-docs');
  const setReady = (ready: boolean) =>
    runInAction(() => {
      conductor.status = { chatConductorReady: ready } as unknown as ConductorStatus;
    });
  return { manager, login, docs, setReady };
}

const screen = (
  conversationId: string,
  taskId: string,
  options: { focusedPane?: boolean; conductor?: boolean } = {}
) => ({
  conversationId,
  taskId,
  focusedPane: options.focusedPane ?? true,
  conductor: options.conductor ?? true,
});

describe('the conductor in front', () => {
  it("is the task's conductor, named for the task, with the chat tab that shows it", () => {
    const { manager, login } = setup();
    expect(manager.front).toBeNull();

    manager.showOnScreen('pane-1', screen('conv-atlas', 'task-login'));
    expect(manager.front?.session).toBe(login);
    expect(manager.front?.name).toBe('Fix login');
    expect(manager.front?.chatId).toBe('conv-atlas');

    // Another chat of the same task: the same conductor, the chat on screen follows.
    manager.showOnScreen('pane-1', screen('conv-bravo', 'task-login'));
    expect(manager.front?.session).toBe(login);
    expect(manager.front?.chatId).toBe('conv-bravo');

    // Switched to Raw: no conductor in front, but the chat on screen is still known.
    manager.showOnScreen('pane-1', screen('conv-bravo', 'task-login', { conductor: false }));
    expect(manager.front).toBeNull();
    expect(manager.chatOnScreen('task-login')).toBe('conv-bravo');

    manager.showOnScreen('pane-1', null);
    expect(manager.chatOnScreen('task-login')).toBeNull();
    manager.dispose();
  });

  it('is nobody while conductors cannot run', () => {
    const { manager, login, setReady } = setup();
    manager.showOnScreen('pane-1', screen('conv-atlas', 'task-login'));
    setReady(false);
    expect(manager.front).toBeNull();
    setReady(true);
    expect(manager.front?.session).toBe(login);
    manager.dispose();
  });

  it('is nobody for a task that has no conductor yet', () => {
    const { manager } = setup();
    manager.showOnScreen('pane-1', screen('conv-x', 'task-other'));
    expect(manager.front).toBeNull();
    manager.dispose();
  });

  it('is the focused pane of two split panes, then the one used last', () => {
    const { manager, login, docs } = setup();
    manager.showOnScreen('pane-1', screen('conv-atlas', 'task-login'));
    manager.showOnScreen('pane-2', screen('conv-cid', 'task-docs', { focusedPane: false }));
    expect(manager.front?.session).toBe(login);

    manager.showOnScreen('pane-1', screen('conv-atlas', 'task-login', { focusedPane: false }));
    manager.showOnScreen('pane-2', screen('conv-cid', 'task-docs'));
    expect(manager.front?.session).toBe(docs);

    manager.showOnScreen('pane-2', screen('conv-cid', 'task-docs', { focusedPane: false }));
    manager.touchScreen('pane-1');
    expect(manager.front?.session).toBe(login);
    manager.touchScreen('pane-2');
    expect(manager.front?.session).toBe(docs);

    manager.showOnScreen('pane-2', null);
    expect(manager.front?.session).toBe(login);
    manager.dispose();
  });

  it("knows each task's chat on screen apart", () => {
    const { manager } = setup();
    manager.showOnScreen('pane-1', screen('conv-bravo', 'task-login', { conductor: false }));
    manager.showOnScreen('pane-2', screen('conv-cid', 'task-docs', { focusedPane: false }));
    expect(manager.chatOnScreen('task-login')).toBe('conv-bravo');
    expect(manager.chatOnScreen('task-docs')).toBe('conv-cid');
    manager.dispose();
  });
});
