import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { MarkdownShowAck, MarkdownShowRequest } from '../api/contract';
import { createShowMarkdownHandler, type ShowMarkdownCaller } from './show-markdown-handler';
import { MarkdownShowHub } from './show-markdown-hub';

const caller: ShowMarkdownCaller = {
  conversationId: 'c1',
  projectId: 'p1',
  taskId: 't1',
  workspaceId: 'ws1',
};

function setup(ack: MarkdownShowAck = { outcome: 'opened', message: 'Opened plan.md.' }) {
  const resolveDocument = vi.fn(async (input: { path: string }) =>
    input.path.includes('secret')
      ? err({ code: 'outside-roots' as const, message: 'That file is outside.' })
      : ok({ path: `/repo/${input.path}`, name: input.path.split('/').at(-1) ?? input.path })
  );
  const show = vi.fn(async (_input: Omit<MarkdownShowRequest, 'id' | 'at'>) => ack);
  return {
    resolveDocument,
    show,
    handle: createShowMarkdownHandler({ access: { resolveDocument }, hub: { show } }),
  };
}

describe('show_markdown handler', () => {
  it("checks the path against the caller's workspace and hands the file to the window", async () => {
    const { handle, resolveDocument, show } = setup();
    const result = await handle(caller, { path: 'docs/plan.md', present: true });

    expect(resolveDocument).toHaveBeenCalledWith({
      projectId: 'p1',
      workspaceId: 'ws1',
      path: 'docs/plan.md',
    });
    expect(show).toHaveBeenCalledWith({
      conversationId: 'c1',
      doc: {
        projectId: 'p1',
        workspaceId: 'ws1',
        taskId: 't1',
        path: '/repo/docs/plan.md',
        title: 'plan.md',
      },
      present: true,
    });
    expect(result).toEqual({ ok: true, message: 'Opened plan.md.' });
  });

  it('only offers the file unless present is true', async () => {
    const { handle, show } = setup({ outcome: 'offered', message: 'plan.md is offered.' });
    const result = await handle(caller, { path: 'docs/plan.md' });
    expect(show.mock.calls[0]?.[0].present).toBe(false);
    expect(result).toEqual({ ok: true, message: 'plan.md is offered.' });
  });

  it('uses the title the agent gives', async () => {
    const { handle, show } = setup();
    await handle(caller, { path: 'docs/plan.md', title: 'Migration plan' });
    expect(show.mock.calls[0]?.[0].doc.title).toBe('Migration plan');
  });

  it('acts for the caller, whatever ids the arguments carry', async () => {
    const { handle, resolveDocument, show } = setup();
    await handle(caller, {
      path: 'docs/plan.md',
      projectId: 'p9',
      workspaceId: 'ws9',
      taskId: 't9',
      conversationId: 'c9',
    });
    expect(resolveDocument.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p1',
      workspaceId: 'ws1',
    });
    expect(show.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'c1',
      doc: { projectId: 'p1', workspaceId: 'ws1', taskId: 't1' },
    });
  });

  it('refuses a path the access check refuses, without telling the window', async () => {
    const { handle, show } = setup();
    const result = await handle(caller, { path: '../secret.md', present: true });
    expect(result).toEqual({ ok: false, message: 'That file is outside.' });
    expect(show).not.toHaveBeenCalled();
  });

  it('refuses bad arguments before anything is looked up', async () => {
    const { handle, resolveDocument, show } = setup();
    expect((await handle(caller, {})).ok).toBe(false);
    expect((await handle(caller, { path: 'plan.md', present: 'yes' })).ok).toBe(false);
    expect(resolveDocument).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('refuses a session that has no workspace', async () => {
    const { handle, resolveDocument } = setup();
    const result = await handle(
      { conversationId: 'c1', projectId: 'p1', taskId: 't1' },
      { path: 'plan.md' }
    );
    expect(result.ok).toBe(false);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it('reports failure when the window could not show the file', async () => {
    const { handle } = setup({ outcome: 'failed', message: 'Maestro could not open plan.md.' });
    expect(await handle(caller, { path: 'plan.md', present: true })).toEqual({
      ok: false,
      message: 'Maestro could not open plan.md.',
    });
  });
});

describe('MarkdownShowHub', () => {
  const doc = {
    projectId: 'p1',
    workspaceId: 'ws1',
    taskId: 't1',
    path: '/repo/plan.md',
    title: 'plan.md',
  };

  it("resolves a show with the window's acknowledgement", async () => {
    const emitted: MarkdownShowRequest[] = [];
    const hub = new MarkdownShowHub((request) => emitted.push(request), 1_000);
    const pending = hub.show({ conversationId: 'c1', doc, present: true });
    const [request] = emitted;
    expect(request).toMatchObject({ conversationId: 'c1', doc, present: true });
    expect(request?.id).toMatch(/^m-[a-f0-9]{6}$/);

    expect(hub.acknowledge(request?.id ?? '', { outcome: 'opened', message: 'Opened.' })).toBe(
      true
    );
    expect(await pending).toEqual({ outcome: 'opened', message: 'Opened.' });
    // A second acknowledgement has nobody waiting for it.
    expect(hub.acknowledge(request?.id ?? '', { outcome: 'opened', message: 'Again.' })).toBe(
      false
    );
  });

  it('reports the file as not shown when no window answers', async () => {
    const emitted: MarkdownShowRequest[] = [];
    const hub = new MarkdownShowHub((request) => emitted.push(request), 5);
    const ack = await hub.show({ conversationId: 'c1', doc, present: false });
    expect(ack.outcome).toBe('failed');
    expect(hub.acknowledge(emitted[0]?.id ?? '', { outcome: 'opened', message: 'Late.' })).toBe(
      false
    );
  });
});
