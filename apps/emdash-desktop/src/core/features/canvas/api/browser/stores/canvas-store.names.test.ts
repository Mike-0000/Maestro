import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { canvasBoardMemento, type CanvasBoardState } from '../../../contributions/mementos';
import { CanvasStore } from './canvas-store';

/**
 * How agents get their spoken names, when a name is free again, and how the conversation title
 * follows the name. The projects, tasks, and conversations here are plain observable maps shaped
 * like the real stores.
 */
type FakeConversation = { data: Record<string, unknown>; status: string };
type FakeManager = {
  conversations: Map<string, FakeConversation>;
  list: { data: unknown[] | null };
  isSessionActive: () => boolean;
  renameConversation: (conversationId: string, name: string) => Promise<void>;
};
type FakeTask = {
  state: string;
  displayName: string;
  workspaceId: string;
  data: Record<string, unknown>;
};
type NewAgent = { id: string; title?: string; createdAt?: string; archived?: boolean };

const managers = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: { get: (taskId: string) => managers.get(taskId) },
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  asAvailableProject: (project: { context?: unknown } | undefined) => project?.context ?? null,
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: () => undefined,
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const MINUTE = 60_000;

function memento(initial: CanvasBoardState): MementoHandle<CanvasBoardState> {
  const box = observable.box(initial, { deep: false });
  return {
    get value() {
      return box.get();
    },
    update(next: CanvasBoardState | ((current: CanvasBoardState) => CanvasBoardState)) {
      runInAction(() => box.set(typeof next === 'function' ? next(box.get()) : next));
    },
  } as unknown as MementoHandle<CanvasBoardState>;
}

/**
 * One project whose tasks and conversations the test adds, archives, and removes. `loading`
 * holds its task list back, as while the app starts.
 */
function world(stored: Record<string, string> = {}, options: { loading?: boolean } = {}) {
  const tasks = observable.map<string, FakeTask>();
  const projects = observable.map<string, unknown>();
  const taskManager = { tasks, listLoaded: !options.loading };
  projects.set('p1', { id: 'p1', name: 'chorus', context: { get: () => taskManager } });
  const store = new CanvasStore({ projects } as unknown as ProjectManagerStore);
  store.attachMemento(memento({ ...canvasBoardMemento.default, spokenNames: stored }));
  /** Every title change the canvas asked for: `[conversationId, title]`. */
  const retitled: [string, string][] = [];
  /** Conversations whose host refuses a rename, as an offline one does. */
  const offline = new Set<string>();

  const manager = (id: string) => managers.get(`t-${id}`) as FakeManager;

  /** Adds agents the way a task list does: together, each a task with one conversation. */
  const addAgents = (agents: readonly NewAgent[]) => {
    runInAction(() => {
      for (const agent of agents) {
        const { id, title = 'Atlas', createdAt = '2026-10-01T10:00:00.000Z' } = agent;
        const conversations = observable.map<string, FakeConversation>();
        conversations.set(id, {
          data: {
            id,
            taskId: `t-${id}`,
            projectId: 'p1',
            providerId: 'claude',
            title,
            type: 'pty',
          },
          status: 'idle',
        });
        const fake: FakeManager = {
          conversations,
          list: { data: [] },
          isSessionActive: () => false,
          // Like the real one: the title changes at once and goes back if the host refuses.
          renameConversation: async (conversationId, name) => {
            retitled.push([conversationId, name]);
            const kept = conversations.get(conversationId);
            const before = kept?.data.title;
            runInAction(() => {
              if (kept) kept.data.title = name;
            });
            await Promise.resolve();
            if (!offline.has(conversationId)) return;
            runInAction(() => {
              if (kept) kept.data.title = before;
            });
            throw new Error('host offline');
          },
        };
        managers.set(`t-${id}`, fake);
        tasks.set(`t-${id}`, {
          state: 'provisioned',
          displayName: `task ${id}`,
          workspaceId: 'w1',
          data: {
            id: `t-${id}`,
            type: 'task',
            createdAt,
            archivedAt: agent.archived ? 'before' : null,
          },
        });
      }
    });
  };
  const addAgent = (id: string, title?: string, createdAt?: string) =>
    addAgents([{ id, title, createdAt }]);
  const setArchived = (id: string, archivedAt: string | null) =>
    runInAction(() => {
      const task = tasks.get(`t-${id}`);
      if (task) tasks.set(`t-${id}`, { ...task, data: { ...task.data, archivedAt } });
    });
  const names = () =>
    Object.fromEntries(
      store.agentEntries.map((entry) => [
        entry.conversationId,
        store.spokenName(entry.conversationId),
      ])
    );
  const titles = () =>
    Object.fromEntries(
      store.agentEntries.map((entry) => [entry.conversationId, entry.conversationTitle])
    );
  return {
    store,
    projects,
    addAgent,
    addAgents,
    archive: (id: string) => setArchived(id, 'now'),
    unarchive: (id: string) => setArchived(id, null),
    removeTask: (id: string) => runInAction(() => tasks.delete(`t-${id}`)),
    /** Takes a conversation out of its task, as an optimistic delete does; returns the undo. */
    removeConversation: (id: string) => {
      const conversations = manager(id).conversations;
      const conversation = conversations.get(id);
      runInAction(() => conversations.delete(id));
      return () => runInAction(() => conversation && conversations.set(id, conversation));
    },
    /** Changes a title the way the task view does, behind the canvas's back. */
    retitle: (id: string, title: string) =>
      runInAction(() => {
        const kept = manager(id).conversations.get(id);
        if (kept) kept.data.title = title;
      }),
    setListLoaded: (id: string, loaded: boolean) => {
      manager(id).list.data = loaded ? [] : null;
    },
    finishLoading: () => (taskManager.listLoaded = true),
    offline,
    names,
    titles,
    retitled,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
});

afterEach(() => {
  managers.clear();
  vi.useRealTimers();
});

describe('spoken names on the canvas', () => {
  it('gives every agent its own word, whatever the task view titled it', () => {
    const { store, addAgent, names } = world();
    addAgent('a');
    addAgent('b');
    addAgent('c', 'Cedar');
    // Every task titles its first agent "Atlas"; the canvas keeps them apart.
    expect(names()).toEqual({ a: 'Atlas', b: 'Bravo', c: 'Cedar' });
    store.dispose();
  });

  it('gives agents created together different names before they exist', () => {
    const { store } = world();
    expect([store.claimSpokenName('x'), store.claimSpokenName('y')]).toEqual(['Atlas', 'Bravo']);
    // A spawn that failed frees its name.
    store.releaseSpokenName('x');
    expect(store.claimSpokenName('z')).toBe('Atlas');
    store.dispose();
  });

  it('avoids a word another agent already uses with a number', () => {
    const stored = { a3: 'Atlas 3', k3: 'Kilo 3' };
    const { store, addAgents, addAgent, finishLoading, names } = world(stored, { loading: true });
    addAgents([
      { id: 'a3', title: 'Atlas 3' },
      { id: 'k3', title: 'Kilo 3' },
    ]);
    finishLoading();
    addAgent('fresh');
    // Not "Atlas" beside Atlas 3, and not the next number up.
    expect(names()).toEqual({ a3: 'Atlas 3', k3: 'Kilo 3', fresh: 'Bravo' });
    store.dispose();
  });

  it('lets agents that arrive together take back the names their titles carry', () => {
    // Two agents back from the archive at once: one titled by hand, one titled with its name.
    const { store, addAgents, names, titles } = world();
    addAgents([
      { id: 'x1', title: 'Fix login' },
      { id: 'x2', title: 'Atlas' },
    ]);
    expect(names()).toEqual({ x1: 'Bravo', x2: 'Atlas' });
    expect(titles()).toEqual({ x1: 'Fix login', x2: 'Atlas' });
    store.dispose();
  });

  it('heals two agents stored under one name', () => {
    const { store, addAgents, names } = world({ a: 'Atlas', b: 'atlas' }, { loading: true });
    addAgents([
      { id: 'a', createdAt: '2026-10-01T10:00:00.000Z' },
      { id: 'b', createdAt: '2026-10-05T10:00:00.000Z' },
    ]);
    // The newer task keeps the name; the other gets a word of its own.
    expect(names()).toEqual({ a: 'Bravo', b: 'atlas' });
    store.dispose();
  });

  it('refuses a rename to a name another agent has', () => {
    const { store, addAgent, names } = world();
    addAgent('a');
    addAgent('b');
    expect(store.setSpokenName('b', ' atlas ')).toBe(false);
    expect(store.setSpokenName('b', 'Atlas!')).toBe(false);
    expect(store.setSpokenName('b', '   ')).toBe(false);
    expect(names()).toEqual({ a: 'Atlas', b: 'Bravo' });
    expect(store.setSpokenName('b', 'Back  End')).toBe(true);
    expect(store.setSpokenName('a', 'Привет')).toBe(true);
    // Its own name again is not a clash.
    expect(store.setSpokenName('b', 'Back End')).toBe(true);
    expect(names()).toEqual({ a: 'Привет', b: 'Back End' });
    store.dispose();
  });

  it('refuses a rename to the name of an agent that has not loaded yet', () => {
    const { store, addAgent, finishLoading, names } = world({ old: 'Atlas' }, { loading: true });
    addAgent('a');
    expect(names()).toEqual({ a: 'Bravo' });
    expect(store.setSpokenName('a', 'Atlas')).toBe(false);
    // Everything has loaded and "old" is nowhere: the name is nobody's.
    finishLoading();
    expect(store.setSpokenName('a', 'Atlas')).toBe(true);
    store.dispose();
  });
});

describe('when a name is free again', () => {
  it('frees the name of an archived agent after a moment, now and for later sessions', () => {
    const { store, addAgent, archive } = world();
    addAgent('a');
    addAgent('b');
    archive('a');
    // Straight away the archive could still be refused and undone.
    expect(store.claimSpokenName('soon')).toBe('Cedar');
    vi.advanceTimersByTime(MINUTE);
    expect(store.claimSpokenName('later')).toBe('Atlas');
    expect(store.state.spokenNames).toEqual({ b: 'Bravo', soon: 'Cedar', later: 'Atlas' });
    store.dispose();
  });

  it('frees the name of an agent whose task or conversation was deleted', () => {
    const { store, addAgent, removeTask, removeConversation } = world();
    addAgent('a');
    addAgent('b');
    addAgent('c');
    removeTask('a');
    removeConversation('b');
    expect(store.claimSpokenName('soon')).toBe('Delta');
    vi.advanceTimersByTime(MINUTE);
    expect([store.claimSpokenName('x'), store.claimSpokenName('y')]).toEqual(['Atlas', 'Bravo']);
    store.dispose();
  });

  it('keeps the name of an agent whose removal was refused and undone', () => {
    const { store, addAgent, removeConversation, names } = world();
    addAgent('a');
    addAgent('b');
    expect(store.setSpokenName('b', 'Backend')).toBe(true);
    // The host refuses the delete a few seconds later and the conversation is put back.
    const restore = removeConversation('b');
    expect(store.claimSpokenName('meanwhile')).toBe('Bravo');
    vi.advanceTimersByTime(5_000);
    restore();
    expect(names()).toEqual({ a: 'Atlas', b: 'Backend' });
    vi.advanceTimersByTime(10 * MINUTE);
    expect(store.claimSpokenName('later')).toBe('Cedar');
    expect(names()).toEqual({ a: 'Atlas', b: 'Backend' });
    store.dispose();
  });

  it('clears names kept for agents archived in an earlier session', () => {
    // Stored from before: two agents whose tasks are archived, and one that is still around.
    const stored = { old1: 'Atlas', old2: 'Bravo', keep: 'Cedar 2' };
    const { store, addAgents, addAgent, names } = world(stored, { loading: true });
    addAgents([
      { id: 'old1', archived: true },
      { id: 'old2', archived: true },
      { id: 'keep', title: 'Cedar 2' },
    ]);
    addAgent('fresh');
    expect(names()).toEqual({ keep: 'Cedar 2', fresh: 'Atlas' });
    expect(Object.keys(store.state.spokenNames).sort()).toEqual(['fresh', 'keep']);
    store.dispose();
  });

  it('clears names kept for agents that are nowhere, once everything has loaded', () => {
    // Left over from deleted agents: nothing in any project carries these ids.
    const stored = { ghost1: 'Atlas', ghost2: 'Bravo', ghost3: 'Atlas 2', here: 'Cedar' };
    const { store, addAgent, finishLoading, names } = world(stored, { loading: true });
    addAgent('here', 'Cedar');
    // While the task list is on its way, a ghost may be an agent.
    expect(store.claimSpokenName('early')).toBe('Delta');
    finishLoading();
    addAgent('fresh');
    expect(names()).toEqual({ here: 'Cedar', fresh: 'Atlas' });
    expect(Object.keys(store.state.spokenNames).sort()).toEqual(['early', 'fresh', 'here']);
    // Freed from long ago: nobody the developer could still be talking to.
    expect(store.departedNames).toEqual([]);
    store.dispose();
  });

  it('keeps every stored name while a conversation list is still loading', () => {
    const { store, addAgents, setListLoaded, finishLoading, names } = world(
      { unloaded: 'Atlas' },
      { loading: true }
    );
    addAgents([{ id: 'slow' }, { id: 'quick' }]);
    // "slow" has a task but its conversations have not arrived: "unloaded" may be among them.
    setListLoaded('slow', false);
    finishLoading();
    expect(store.claimSpokenName('new')).toBe('Delta');
    setListLoaded('slow', true);
    expect(store.claimSpokenName('next')).toBe('Atlas');
    expect(names()).toEqual({ quick: 'Bravo', slow: 'Cedar' });
    store.dispose();
  });

  it('keeps every stored name while a project has not loaded, or failed to', () => {
    const { store, projects, finishLoading } = world({ elsewhere: 'Atlas' }, { loading: true });
    // A second project is still hydrating: "elsewhere" may be one of its agents.
    runInAction(() => projects.set('p2', { id: 'p2', name: 'website', context: null }));
    finishLoading();
    expect(store.claimSpokenName('one')).toBe('Bravo');
    // The project is removed from the app: now nothing can hold the name.
    runInAction(() => projects.delete('p2'));
    expect(store.claimSpokenName('two')).toBe('Atlas');
    store.dispose();
  });

  it('never hands out the name of an agent that has not loaded yet', () => {
    // The app just started: "old" holds Atlas and its project's task list is still on its way.
    const { store, addAgent, finishLoading, names } = world({ old: 'Atlas' }, { loading: true });
    expect(store.claimSpokenName('spawned')).toBe('Bravo');
    addAgent('typed');
    expect(names()).toEqual({ typed: 'Cedar' });
    // It loads, and is still Atlas.
    addAgent('old');
    finishLoading();
    expect(names()).toMatchObject({ old: 'Atlas', typed: 'Cedar' });
    expect(store.claimSpokenName('later')).toBe('Delta');
    store.dispose();
  });

  it('keeps a name claimed for an agent that is still being created', () => {
    const { store, addAgent, names } = world();
    expect(store.claimSpokenName('spawning')).toBe('Atlas');
    // Everything is loaded and "spawning" is nowhere yet: its claim is what holds the name.
    addAgent('other');
    expect(names()).toEqual({ other: 'Bravo' });
    expect(store.state.spokenNames).toMatchObject({ spawning: 'Atlas' });
    store.dispose();
  });

  it('gives an agent back from the archive its own name, or a new one if that was taken', () => {
    const { store, addAgent, archive, unarchive, names } = world();
    addAgent('first');
    addAgent('other');
    archive('first');
    vi.advanceTimersByTime(10_000);
    // Back within the minute: nothing changed.
    unarchive('first');
    expect(names()).toEqual({ first: 'Atlas', other: 'Bravo' });
    archive('first');
    vi.advanceTimersByTime(MINUTE);
    addAgent('second');
    expect(names()).toEqual({ other: 'Bravo', second: 'Atlas' });
    // Its name went to "second" while it was away: the one already here keeps it.
    unarchive('first');
    expect(names()).toEqual({ first: 'Cedar', other: 'Bravo', second: 'Atlas' });
    store.dispose();
  });

  it('remembers for a few minutes who just left', () => {
    const { store, addAgent, archive, unarchive } = world();
    addAgent('a');
    addAgent('b');
    expect(store.departedNames).toEqual([]);
    archive('b');
    unarchive('b');
    archive('b');
    // Once, however often it came and went.
    expect(store.departedNames).toEqual(['Bravo']);
    vi.advanceTimersByTime(11 * MINUTE);
    expect(store.departedNames).toEqual([]);
    store.dispose();
  });

  it('frees the name of the only task of a project, and of a removed project', () => {
    const { store, projects, addAgent, removeTask } = world();
    addAgent('only');
    removeTask('only');
    vi.advanceTimersByTime(MINUTE);
    expect(store.claimSpokenName('next')).toBe('Atlas');
    addAgent('again', 'Bravo');
    runInAction(() => projects.delete('p1'));
    expect(store.departedNames).toContain('Bravo');
    store.dispose();
  });

  it('lets a rename take the name of an agent archived a moment ago', () => {
    const { store, addAgent, archive, names } = world();
    addAgent('a');
    addAgent('b');
    archive('a');
    // New agents wait out the minute; the rename the developer asked for does not.
    expect(store.claimSpokenName('new')).toBe('Cedar');
    expect(store.setSpokenName('b', 'Atlas')).toBe(true);
    expect(names()).toEqual({ b: 'Atlas' });
    store.dispose();
  });
});

describe('the conversation title follows the spoken name', () => {
  it('replaces a default title, so the task view shows the name that is said', () => {
    const { store, addAgent, titles, retitled } = world();
    addAgent('a');
    addAgent('b');
    addAgent('c', 'claude (2)');
    // Both tasks titled their agent "Atlas"; the second is Bravo on the canvas.
    expect(titles()).toEqual({ a: 'Atlas', b: 'Bravo', c: 'Cedar' });
    expect(retitled).toEqual([
      ['b', 'Bravo'],
      ['c', 'Cedar'],
    ]);
    // The title it was created under still reaches it for now.
    expect(store.formerNamesOf('b')).toEqual(['Atlas']);
    store.dispose();
  });

  it('leaves a title someone wrote, and one that already matches', () => {
    const { store, addAgents, titles, retitled } = world({ a: 'Atlas' }, { loading: true });
    addAgents([
      { id: 'a', title: 'atlas' },
      { id: 'b', title: 'Fix the login page' },
    ]);
    expect(titles()).toEqual({ a: 'atlas', b: 'Fix the login page' });
    expect(retitled).toEqual([]);
    store.dispose();
  });

  it('leaves a title from before that could only mean its own agent', () => {
    // Named Jasper 3 here, titled "Vesper 2" where it was started; a hand-written "Harbor".
    const stored = { j: 'Jasper 3', h: 'Delta' };
    const { store, addAgents, titles, retitled } = world(stored, { loading: true });
    addAgents([
      { id: 'j', title: 'Vesper 2' },
      { id: 'h', title: 'Harbor' },
    ]);
    expect(titles()).toEqual({ j: 'Vesper 2', h: 'Harbor' });
    expect(retitled).toEqual([]);
    store.dispose();
  });

  it('replaces a title from before that would send the developer to another agent', () => {
    // "k" is titled Atlas, but Atlas is "a"; "l" is titled Bravo beside an agent called Bravo 3.
    const stored = { a: 'Atlas', k: 'Kilo 3', b3: 'Bravo 3', l: 'Lima' };
    const { store, addAgent, finishLoading, titles, retitled } = world(stored, { loading: true });
    // They load one at a time: who a title misleads about is only known once all are here.
    addAgent('k', 'Atlas');
    addAgent('l', 'Bravo');
    addAgent('b3', 'Bravo 3');
    expect(retitled).toEqual([]);
    finishLoading();
    addAgent('a', 'Atlas');
    expect(titles()).toEqual({ a: 'Atlas', k: 'Kilo 3', b3: 'Bravo 3', l: 'Lima' });
    expect(store.formerNamesOf('l')).toEqual(['Bravo']);
    // Once: if another computer titles it its own way afterwards, the canvas does not fight.
    addAgent('other', 'Zulu');
    expect(retitled).toEqual([
      ['k', 'Kilo 3'],
      ['l', 'Lima'],
    ]);
    store.dispose();
  });

  it('follows a rename, and the agent still answers to its old name', () => {
    const { store, addAgent, titles } = world();
    addAgent('a');
    addAgent('b', 'Fix the login page');
    expect(store.setSpokenName('a', 'Backend')).toBe(true);
    expect(store.setSpokenName('b', 'Frontend')).toBe(true);
    // A's title was its name; B's was written by someone and stays.
    expect(titles()).toEqual({ a: 'Backend', b: 'Fix the login page' });
    expect(store.formerNamesOf('a')).toEqual(['Atlas']);
    expect(store.formerNamesOf('b')).toEqual(['Bravo']);
    store.dispose();
  });

  it('tries again when the host refused', async () => {
    const { store, addAgent, offline, titles, retitled } = world();
    addAgent('a');
    offline.add('b');
    addAgent('b');
    await vi.runAllTimersAsync();
    expect(titles()).toMatchObject({ b: 'Atlas' });
    // The roster changes while the host is still away, then it is back.
    addAgent('c', 'Cedar');
    await vi.runAllTimersAsync();
    offline.delete('b');
    addAgent('d', 'Delta');
    await vi.runAllTimersAsync();
    expect(titles()).toMatchObject({ b: 'Bravo' });
    expect(retitled.filter(([id]) => id === 'b')).toHaveLength(3);
    // Done: later changes leave it alone.
    addAgent('e', 'Echo');
    await vi.runAllTimersAsync();
    expect(retitled.filter(([id]) => id === 'b')).toHaveLength(3);
    store.dispose();
  });

  it('waits for the host instead of taking the title it just set for done', async () => {
    const { store, addAgent, offline, titles, retitled } = world();
    addAgent('a');
    offline.add('b');
    addAgent('b');
    // The roster changes while the host has not answered: the title already reads "Bravo".
    addAgent('c', 'Cedar');
    expect(retitled.filter(([id]) => id === 'b')).toHaveLength(1);
    await vi.runAllTimersAsync();
    // Refused and put back: still owed, and tried again on the next change.
    expect(titles()).toMatchObject({ b: 'Atlas' });
    offline.delete('b');
    addAgent('d', 'Delta');
    await vi.runAllTimersAsync();
    expect(titles()).toMatchObject({ b: 'Bravo' });
    store.dispose();
  });

  it('leaves a title the developer wrote while the name was still owed', async () => {
    const { store, addAgent, retitle, offline, titles, retitled } = world();
    addAgent('a');
    offline.add('b');
    addAgent('b');
    await vi.runAllTimersAsync();
    // The host is back, and meanwhile the developer has titled it "Pilot" by hand.
    offline.delete('b');
    retitle('b', 'Pilot');
    addAgent('c', 'Cedar');
    await vi.runAllTimersAsync();
    expect(titles()).toMatchObject({ b: 'Pilot' });
    expect(retitled.filter(([id]) => id === 'b')).toHaveLength(1);
    // Only the title it was created under counts as an earlier name.
    expect(store.formerNamesOf('b')).toEqual(['Atlas']);
    store.dispose();
  });

  it('stops asking a host that keeps refusing', async () => {
    const { store, addAgent, offline, retitled } = world();
    offline.add('b');
    addAgent('a');
    addAgent('b');
    for (const id of ['c', 'd', 'e', 'f', 'g']) {
      await vi.runAllTimersAsync();
      addAgent(id, 'Fix something');
    }
    expect(retitled.filter(([id]) => id === 'b')).toHaveLength(3);
    store.dispose();
  });
});

describe('taking the numbers off', () => {
  it('drops the number from a name whose word nobody else uses', () => {
    const stored = { a3: 'Atlas 3', k3: 'Kilo 3', ghost: 'Kilo' };
    const { store, addAgents, finishLoading, names, titles } = world(stored, { loading: true });
    addAgents([
      { id: 'a3', title: 'Atlas 3' },
      { id: 'k3', title: 'Kilo 3' },
    ]);
    // While the list loads, the ghost may be an agent: Kilo 3 keeps its number.
    expect(store.simplifiableNames()).toEqual([
      { conversationId: 'a3', from: 'Atlas 3', to: 'Atlas' },
    ]);
    finishLoading();
    expect(store.simplifySpokenNames()).toEqual([
      { from: 'Atlas 3', to: 'Atlas' },
      { from: 'Kilo 3', to: 'Kilo' },
    ]);
    expect(names()).toEqual({ a3: 'Atlas', k3: 'Kilo' });
    expect(titles()).toEqual({ a3: 'Atlas', k3: 'Kilo' });
    // Said from habit, the old names still reach them.
    expect(store.formerNamesOf('a3')).toEqual(['Atlas 3']);
    expect(store.simplifySpokenNames()).toEqual([]);
    store.dispose();
  });

  it('leaves names that would collide, and names someone chose', () => {
    const stored = { a: 'Atlas', a3: 'Atlas 3', b2: 'Bravo 2', b3: 'Bravo 3', own: 'Backend 2' };
    const { store, addAgents, finishLoading, names } = world(stored, { loading: true });
    addAgents(Object.entries(stored).map(([id, title]) => ({ id, title })));
    finishLoading();
    expect(store.simplifySpokenNames()).toEqual([]);
    expect(names()).toEqual(stored);
    store.dispose();
  });
});
