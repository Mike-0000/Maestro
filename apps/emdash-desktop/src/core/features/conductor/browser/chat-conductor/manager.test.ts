import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { ConductorStatus } from '../../api/contract';
import { ChatConductorManager } from './manager';

// Which chat conductor is in front: the one whose Conductor view the developer is looking at.

vi.mock('../../api/browser/client', () => ({
  getConductorClient: async () => ({
    readChatThread: async () => null,
    listChatThreads: async () => [],
  }),
}));
vi.mock('./agent-port', () => ({
  createChatAgentPort: () => ({ snapshot: () => null, watch: () => () => {} }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const NAMES: Record<string, string> = { 'conv-atlas': 'Atlas', 'conv-bravo': 'Bravo' };

function setup() {
  const conductor = observable(
    { status: { chatConductorReady: true } as unknown as ConductorStatus | null },
    { status: observable.ref }
  );
  const canvas = {
    agentEntries: [],
    spokenName: (conversationId: string) => NAMES[conversationId] ?? 'Agent',
  } as unknown as CanvasStore;
  const manager = new ChatConductorManager(canvas, conductor);
  const atlas = manager.session('conv-atlas');
  const bravo = manager.session('conv-bravo');
  const setReady = (ready: boolean) =>
    runInAction(() => {
      conductor.status = { chatConductorReady: ready } as unknown as ConductorStatus;
    });
  return { manager, atlas, bravo, setReady };
}

describe('the chat conductor in front', () => {
  it('is the conversation whose Conductor view is on screen, with its name', () => {
    const { manager, atlas } = setup();
    expect(manager.front).toBeNull();

    manager.showOnScreen('pane-1', { conversationId: 'conv-atlas', focusedPane: true });
    expect(manager.front?.session).toBe(atlas);
    expect(manager.front?.name).toBe('Atlas');

    // Switched to Raw, left the task, or the pane went away.
    manager.showOnScreen('pane-1', null);
    expect(manager.front).toBeNull();
    manager.dispose();
  });

  it('follows a switch to another chat in the same pane', () => {
    const { manager, bravo } = setup();
    manager.showOnScreen('pane-1', { conversationId: 'conv-atlas', focusedPane: true });
    manager.showOnScreen('pane-1', { conversationId: 'conv-bravo', focusedPane: true });
    expect(manager.front?.session).toBe(bravo);
    manager.dispose();
  });

  it('is nobody while chat conductors cannot run', () => {
    const { manager, atlas, setReady } = setup();
    manager.showOnScreen('pane-1', { conversationId: 'conv-atlas', focusedPane: true });
    setReady(false);
    expect(manager.front).toBeNull();
    setReady(true);
    expect(manager.front?.session).toBe(atlas);
    manager.dispose();
  });

  it('is nobody for a conversation that has no conductor yet', () => {
    const { manager } = setup();
    manager.showOnScreen('pane-1', { conversationId: 'conv-other', focusedPane: true });
    expect(manager.front).toBeNull();
    manager.dispose();
  });

  it('is the focused pane of two split panes, then the one used last', () => {
    const { manager, atlas, bravo } = setup();
    manager.showOnScreen('pane-1', { conversationId: 'conv-atlas', focusedPane: true });
    manager.showOnScreen('pane-2', { conversationId: 'conv-bravo', focusedPane: false });
    expect(manager.front?.session).toBe(atlas);

    // Focus moves to the second pane.
    manager.showOnScreen('pane-1', { conversationId: 'conv-atlas', focusedPane: false });
    manager.showOnScreen('pane-2', { conversationId: 'conv-bravo', focusedPane: true });
    expect(manager.front?.session).toBe(bravo);

    // Neither pane has focus (the focus is elsewhere in the task): the one worked in last.
    manager.showOnScreen('pane-2', { conversationId: 'conv-bravo', focusedPane: false });
    manager.touchScreen('pane-1');
    expect(manager.front?.session).toBe(atlas);
    manager.touchScreen('pane-2');
    expect(manager.front?.session).toBe(bravo);

    // The second pane closes.
    manager.showOnScreen('pane-2', null);
    expect(manager.front?.session).toBe(atlas);
    manager.dispose();
  });
});
