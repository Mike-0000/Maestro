import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownShowAck } from '@core/features/markdown-viewer/api/contract';
import { markdownShowHub } from '@core/features/markdown-viewer/node/show-markdown-hub';
import { AgentRequestServer, type AgentRequestScope } from './agent-request-server';

/** Folders the fake workspace identity service points at; filled in before the tests run. */
const folders = vi.hoisted(() => ({ worktree: '', project: '' }));

vi.mock('@main/bootstrap/core/service-instances', () => ({
  getWorkspaceIdentityService: () => ({
    resolve: async (workspaceId: string) =>
      workspaceId === 'ws1'
        ? { workspaceId, host: LOCAL_HOST_REF, path: folders.worktree, projectId: 'p1' }
        : null,
    resolveProject: async (projectId: string) =>
      projectId === 'p1'
        ? { workspaceId: 'repo', host: LOCAL_HOST_REF, path: folders.project, projectId }
        : null,
  }),
}));

const { showMarkdownSessionTool } = await import('./show-markdown-tool');

const scope: AgentRequestScope = {
  conversationId: 'c1',
  projectId: 'p1',
  taskId: 't1',
  workspaceId: 'ws1',
  name: 'Nova',
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function post(port: number, body: unknown, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

type ToolReply = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('show_markdown on the maestro MCP server', () => {
  let root: string;
  let server: AgentRequestServer;
  let port: number;
  let auth: Record<string, string>;
  const show = vi.spyOn(markdownShowHub, 'show');

  const call = async (
    args: Record<string, unknown>,
    headers: Record<string, string> = auth
  ): Promise<ToolReply> => {
    const body = await post(
      port,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'show_markdown', arguments: args },
      },
      headers
    );
    return JSON.parse(body).result;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'show-markdown-tool-')));
    folders.project = path.join(root, 'project');
    folders.worktree = path.join(root, 'worktree');
    await mkdir(path.join(folders.worktree, 'docs'), { recursive: true });
    await mkdir(folders.project, { recursive: true });
    await writeFile(path.join(folders.worktree, 'docs', 'plan.md'), '# Plan\n');
    await writeFile(path.join(folders.worktree, 'notes.txt'), 'notes');
    await writeFile(path.join(root, 'secret.md'), '# Secret\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    show.mockReset();
    show.mockImplementation(
      async ({ present }): Promise<MarkdownShowAck> =>
        present
          ? { outcome: 'opened', message: 'Opened plan.md for the developer.' }
          : { outcome: 'offered', message: 'plan.md is offered to the developer.' }
    );
    server = new AgentRequestServer(
      async () => ({ accepted: true, message: 'accepted' }),
      logger,
      undefined,
      [showMarkdownSessionTool]
    );
    auth = (await server.register(scope)).headers;
    port = server.listeningPort;
  });

  afterEach(() => server.stop());

  it('is listed beside conductor_request and named in the instructions', async () => {
    const tools: Array<{ name: string; inputSchema: object; annotations: object }> = JSON.parse(
      await post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth)
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(['conductor_request', 'show_markdown']);
    expect(tools[1]?.inputSchema).toMatchObject({ type: 'object', required: ['path'] });
    expect(tools[1]?.annotations).toEqual({
      title: 'Show a Markdown file',
      readOnlyHint: false,
      openWorldHint: false,
    });

    const init = JSON.parse(
      await post(port, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, auth)
    ).result;
    expect(init.instructions).toContain('conductor_request');
    expect(init.instructions).toContain('show_markdown');
  });

  it("presents a file from the caller's working directory", async () => {
    const reply = await call({ path: 'docs/plan.md', present: true });

    expect(reply).toEqual({
      content: [{ type: 'text', text: 'Opened plan.md for the developer.' }],
    });
    expect(show).toHaveBeenCalledWith({
      conversationId: 'c1',
      doc: {
        projectId: 'p1',
        workspaceId: 'ws1',
        taskId: 't1',
        path: path.join(folders.worktree, 'docs', 'plan.md'),
        title: 'plan.md',
      },
      present: true,
    });
  });

  it('only offers the file when present is left out', async () => {
    const reply = await call({ path: path.join(folders.worktree, 'docs', 'plan.md') });
    expect(reply.content[0]?.text).toBe('plan.md is offered to the developer.');
    expect(reply.isError).toBeUndefined();
    expect(show.mock.calls[0]?.[0].present).toBe(false);
  });

  it('refuses a file outside the working directory and the project folder', async () => {
    const absolute = await call({ path: path.join(root, 'secret.md'), present: true });
    expect(absolute.isError).toBe(true);
    expect(absolute.content[0]?.text).toContain('outside');
    const climbing = await call({ path: '../secret.md', present: true });
    expect(climbing.isError).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('refuses a file that is not Markdown, and a missing one', async () => {
    const text = await call({ path: 'notes.txt', present: true });
    expect(text.isError).toBe(true);
    expect(text.content[0]?.text).toContain('Only Markdown files');
    const missing = await call({ path: 'docs/nope.md' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain('There is no file at');
    expect(show).not.toHaveBeenCalled();
  });

  it("acts for the token's conversation, never for ids in the arguments", async () => {
    await call({
      path: 'docs/plan.md',
      conversationId: 'c2',
      taskId: 't2',
      projectId: 'p2',
      workspaceId: 'ws2',
    });
    expect(show.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'c1',
      doc: { projectId: 'p1', workspaceId: 'ws1', taskId: 't1' },
    });
  });

  it('refuses a session whose scope has no workspace', async () => {
    const bare = (
      await server.register({ conversationId: 'c3', projectId: 'p1', taskId: 't3', name: 'Bare' })
    ).headers;
    const reply = await call({ path: 'docs/plan.md', present: true }, bare);
    expect(reply.isError).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('reports a window that could not show the file as an error', async () => {
    show.mockResolvedValue({ outcome: 'failed', message: 'Maestro did not pick the file up.' });
    const reply = await call({ path: 'docs/plan.md', present: true });
    expect(reply).toEqual({
      content: [{ type: 'text', text: 'Maestro did not pick the file up.' }],
      isError: true,
    });
  });
});
