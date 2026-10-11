import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownShowRequest } from '../contract';

const mocks = vi.hoisted(() => ({
  openMarkdownDoc: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

vi.mock('@emdash/ui/react/primitives', () => ({ toast: mocks.toast }));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasStore: () => ({ spokenName: () => 'Nova' }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./client', () => ({ getMarkdownViewerClient: vi.fn() }));
vi.mock('./open-markdown-doc', () => ({ openMarkdownDoc: mocks.openMarkdownDoc }));

const { handleShowRequest } = await import('./show-request-bridge');

const doc = {
  projectId: 'p1',
  workspaceId: 'ws1',
  taskId: 't1',
  path: '/repo/docs/plan.md',
  title: 'plan.md',
};

function request(present: boolean): MarkdownShowRequest {
  return { id: 'm-1', at: '2026-10-10T00:00:00.000Z', conversationId: 'c1', doc, present };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openMarkdownDoc.mockResolvedValue({ placement: { surface: 'canvas' }, opened: true });
});

describe('handleShowRequest', () => {
  it('opens a presented file at once and tells the agent where', async () => {
    const ack = await handleShowRequest(request(true));

    expect(mocks.openMarkdownDoc).toHaveBeenCalledWith(doc, { conversationId: 'c1' });
    expect(ack).toEqual({
      outcome: 'opened',
      message: 'Opened plan.md for the developer in a window on the canvas.',
    });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('tells the agent the truth when the window did not come up', async () => {
    mocks.openMarkdownDoc.mockResolvedValue({ placement: { surface: 'canvas' }, opened: false });
    expect((await handleShowRequest(request(true))).outcome).toBe('failed');

    mocks.openMarkdownDoc.mockRejectedValue(new Error('store gone'));
    expect(await handleShowRequest(request(true))).toEqual({
      outcome: 'failed',
      message: 'Maestro could not open plan.md.',
    });
  });

  it('only offers a file that was not presented, and opens it when the developer asks', async () => {
    const ack = await handleShowRequest(request(false));

    expect(ack.outcome).toBe('offered');
    expect(mocks.openMarkdownDoc).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toast.mock.calls[0] as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe('Nova has a file for you');
    expect(options.description).toBe('plan.md');
    expect(options.action.label).toBe('Open');

    options.action.onClick();
    await vi.waitFor(() =>
      expect(mocks.openMarkdownDoc).toHaveBeenCalledWith(doc, { conversationId: 'c1' })
    );
  });
});
