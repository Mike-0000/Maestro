import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  view: { viewId: 'canvas', params: {} as Record<string, string> },
  navigate: vi.fn(),
  openDoc: vi.fn(),
  isDocOnScreen: vi.fn(),
  openTaskTabBeside: vi.fn(),
  resolve: vi.fn(),
  provisioned: { workspaceId: 'ws1' } as { workspaceId: string } | undefined,
}));

vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasStore: () => ({ openDoc: mocks.openDoc, isDocOnScreen: mocks.isDocOnScreen }),
}));
vi.mock('@core/features/canvas/contributions/views', () => ({ canvasViewDef: { id: 'canvas' } }));
vi.mock('@core/features/tasks/contributions/views', () => ({
  taskViewDef: Object.assign(
    (params: { projectId: string; taskId: string }) => ({ viewId: 'task', params }),
    { id: 'task' }
  ),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: () => ({}),
  asProvisioned: () => mocks.provisioned,
}));
vi.mock('@core/features/workbench/api/browser/task-composition-selectors', () => ({
  openTaskTabBeside: mocks.openTaskTabBeside,
}));
vi.mock('@core/primitives/navigation/browser/navigation-selectors', () => ({
  getNavigation: () => ({ currentRef: mocks.view, navigate: mocks.navigate }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./client', () => ({
  getMarkdownViewerClient: async () => ({ resolve: mocks.resolve }),
}));

const { openAgentMarkdownLink, openMarkdownDoc, openMarkdownPath } =
  await import('./open-markdown-doc');

const doc = {
  projectId: 'p1',
  workspaceId: 'ws1',
  taskId: 't1',
  path: '/repo/docs/plan.md',
  title: 'plan.md',
};

function show(viewId: string, params: Record<string, string> = {}): void {
  mocks.view = { viewId, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  show('canvas');
  mocks.provisioned = { workspaceId: 'ws1' };
  mocks.openDoc.mockReturnValue('doc:1');
  mocks.isDocOnScreen.mockReturnValue(true);
  mocks.openTaskTabBeside.mockResolvedValue(true);
  mocks.resolve.mockResolvedValue({
    success: true,
    data: { path: '/repo/docs/plan.md', name: 'plan.md' },
  });
});

afterEach(() => vi.useRealTimers());

describe('openMarkdownDoc', () => {
  it('opens a canvas window beside the sending agent while the canvas is on screen', async () => {
    const result = await openMarkdownDoc(doc, { conversationId: 'c1' });

    expect(mocks.openDoc).toHaveBeenCalledWith({ ...doc, conversationId: 'c1' });
    expect(result).toEqual({ placement: { surface: 'canvas' }, opened: true });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.openTaskTabBeside).not.toHaveBeenCalled();
  });

  it('reports a canvas window that is not on screen as not opened', async () => {
    mocks.isDocOnScreen.mockReturnValue(false);
    expect((await openMarkdownDoc(doc)).opened).toBe(false);
  });

  it("goes to the task's own view when the canvas has no place for the file", async () => {
    mocks.openDoc.mockReturnValue(null);
    const result = await openMarkdownDoc(doc);

    expect(mocks.navigate).toHaveBeenCalledWith({
      viewId: 'task',
      params: { projectId: 'p1', taskId: 't1' },
    });
    expect(mocks.openTaskTabBeside).toHaveBeenCalledWith('p1', 't1', 'markdown', doc);
    expect(result).toEqual({
      placement: { surface: 'task', projectId: 'p1', taskId: 't1', navigate: true },
      opened: true,
    });
  });

  it('opens a tab in the task view on screen, even for another task, without leaving it', async () => {
    show('task', { projectId: 'p2', taskId: 't9' });
    const result = await openMarkdownDoc(doc);

    expect(mocks.openTaskTabBeside).toHaveBeenCalledWith('p2', 't9', 'markdown', doc);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.openDoc).not.toHaveBeenCalled();
    expect(result.placement).toEqual({
      surface: 'task',
      projectId: 'p2',
      taskId: 't9',
      navigate: false,
    });
  });

  it("opens the agent's task view from a view that holds no agent windows", async () => {
    show('settings');
    const result = await openMarkdownDoc(doc);

    expect(mocks.navigate).toHaveBeenCalledWith({
      viewId: 'task',
      params: { projectId: 'p1', taskId: 't1' },
    });
    expect(mocks.openTaskTabBeside).toHaveBeenCalledWith('p1', 't1', 'markdown', doc);
    expect(result.opened).toBe(true);
  });

  it('reports a tab that the task view refused, or that did not open in time', async () => {
    show('task', { projectId: 'p1', taskId: 't1' });
    mocks.openTaskTabBeside.mockResolvedValue(false);
    expect((await openMarkdownDoc(doc)).opened).toBe(false);

    mocks.openTaskTabBeside.mockRejectedValue(new Error('layout gone'));
    expect((await openMarkdownDoc(doc)).opened).toBe(false);

    vi.useFakeTimers();
    mocks.openTaskTabBeside.mockReturnValue(new Promise(() => {}));
    const pending = openMarkdownDoc(doc);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await pending).opened).toBe(false);
  });
});

describe('openMarkdownPath', () => {
  const workspace = { projectId: 'p1', workspaceId: 'ws1', taskId: 't1' };

  it('opens the file the main process resolved, under its real path and name', async () => {
    mocks.resolve.mockResolvedValue({
      success: true,
      data: { path: '/repo/docs/notes/design.md', name: 'design.md' },
    });
    const opened = await openMarkdownPath(workspace, './notes/design.md', {
      from: '/repo/docs/plan.md',
      conversationId: 'c1',
    });

    expect(opened).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith({
      projectId: 'p1',
      workspaceId: 'ws1',
      path: './notes/design.md',
      from: '/repo/docs/plan.md',
    });
    expect(mocks.openDoc).toHaveBeenCalledWith({
      ...workspace,
      path: '/repo/docs/notes/design.md',
      title: 'design.md',
      conversationId: 'c1',
    });
  });

  it('opens nothing for a path the main process refuses', async () => {
    mocks.resolve.mockResolvedValue({
      success: false,
      error: { code: 'outside-roots', message: 'Outside.' },
    });
    expect(await openMarkdownPath(workspace, '../secret.md')).toBe(false);
    expect(mocks.openDoc).not.toHaveBeenCalled();
  });

  it('does not ask about a file that is not Markdown', async () => {
    expect(await openMarkdownPath(workspace, 'src/app.ts')).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('answers false when the check itself fails', async () => {
    mocks.resolve.mockRejectedValue(new Error('wire closed'));
    expect(await openMarkdownPath(workspace, 'plan.md')).toBe(false);
  });
});

describe('openAgentMarkdownLink', () => {
  it("checks the path against the task's workspace", async () => {
    const opened = await openAgentMarkdownLink(
      { projectId: 'p1', taskId: 't1', conversationId: 'c1' },
      'docs/plan.md'
    );
    expect(opened).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith({
      projectId: 'p1',
      workspaceId: 'ws1',
      path: 'docs/plan.md',
    });
    expect(mocks.openDoc).toHaveBeenCalledWith({ ...doc, conversationId: 'c1' });
  });

  it('opens nothing for a task with no workspace yet', async () => {
    mocks.provisioned = undefined;
    expect(await openAgentMarkdownLink({ projectId: 'p1', taskId: 't1' }, 'plan.md')).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
