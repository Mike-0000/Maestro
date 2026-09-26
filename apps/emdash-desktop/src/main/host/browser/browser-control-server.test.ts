import http from 'node:http';
import { err, ok, type Result } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAction } from '@core/primitives/browser/api';
import { BrowserControlServer, type AgentBrowserScope } from './browser-control-server';

vi.mock('electron', () => ({}));

const scope: AgentBrowserScope = {
  kind: 'agent',
  conversationId: 'c1',
  name: 'Nova',
  projectId: 'p1',
  workspaceId: 'w1',
  taskId: 't1',
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/**
 * t1's tile is b1. `state.control` says who drives it: an agent may watch it either way (observe)
 * but only act once it is handed to agents. requestOpen stands in for the user allowing it.
 */
function fakeControl() {
  const state = { control: 'agents' as 'user' | 'agents' };
  return {
    state,
    observe: vi.fn(async (_scope: AgentBrowserScope, input: { mode: string }) =>
      ok({
        url: 'http://localhost:5173/',
        title: 'App',
        ...(input.mode === 'screenshot'
          ? { image: { mediaType: 'image/jpeg' as const, data: 'AAAA', width: 800, height: 600 } }
          : {}),
        ...(input.mode === 'outline'
          ? { text: '- textbox "Name" [ref=e3]\n- button "Save" [ref=e7]' }
          : {}),
      })
    ),
    act: vi.fn(async (_scope: AgentBrowserScope, _input: { action: BrowserAction }) =>
      ok({ url: 'http://localhost:5173/x', title: 'App', changed: true })
    ),
    consoleTail: vi.fn(async () => ok([])),
    findTaskBrowser: vi.fn((taskId: string, access: 'observe' | 'control' = 'control') => {
      if (taskId !== 't1') return null;
      return access === 'observe' || state.control === 'agents' ? 'b1' : null;
    }),
    describeTaskBrowser: vi.fn(() => ({
      browserId: 'b1',
      url: 'http://localhost:5173/',
      live: true,
      control: state.control,
      allowedOrigins: ['http://localhost:5173'],
    })),
    requestOpen: vi.fn(
      async (
        _scope: AgentBrowserScope,
        _url: string | null,
        _access: 'observe' | 'control'
      ): Promise<Result<string, { type: 'not-controllable'; message: string }>> => {
        state.control = 'agents';
        return ok('b1');
      }
    ),
  };
}

function refused(message: string) {
  return err({ type: 'not-controllable' as const, message });
}

type Reply = { status: number; body: string };

function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.end(method === 'POST' ? payload : undefined);
  });
}

function toolCall(name: string, args: Record<string, unknown>, id = 9) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

describe('BrowserControlServer', () => {
  let control: ReturnType<typeof fakeControl>;
  let server: BrowserControlServer;
  let port: number;
  let auth: Record<string, string>;

  beforeEach(async () => {
    control = fakeControl();
    server = new BrowserControlServer(control as never, logger);
    const registration = await server.register(scope);
    port = server.listeningPort;
    auth = registration.headers;
    expect(registration.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(auth.Authorization).toMatch(/^Bearer chorus_bt_[a-f0-9]{48}$/);
  });

  afterEach(() => server.stop());

  it('reuses the token for the same task and rotates it for a new scope', async () => {
    const again = await server.register(scope);
    expect(again.headers).toEqual(auth);
    const moved = await server.register({ ...scope, taskId: 't2' });
    expect(moved.headers).not.toEqual(auth);
    expect((await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, auth)).status).toBe(401);
  });

  it('rejects missing, wrong and revoked tokens', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(port, ping)).status).toBe(401);
    expect((await post(port, ping, { Authorization: 'Bearer chorus_bt_nope' })).status).toBe(401);
    expect((await post(port, ping, auth)).status).toBe(200);
    server.revoke('c1');
    expect((await post(port, ping, auth)).status).toBe(401);
  });

  it('refuses browser-originated requests before auth', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(port, ping, { ...auth, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(port, ping, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post(port, ping, { ...auth, Host: `localhost:${port}` })).status).toBe(403);
    expect((await post(port, ping, { ...auth, Host: `evil.example:${port}` })).status).toBe(403);
  });

  it('refuses non-JSON bodies and GET streams', async () => {
    const reply = await post(port, 'x', { ...auth, 'Content-Type': 'text/plain' });
    expect(reply.status).toBe(415);
    expect((await post(port, '', auth, 'GET')).status).toBe(405);
  });

  it('speaks the MCP handshake and advertises both ways of working', async () => {
    const init = await post(
      port,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      auth
    );
    const initResult = JSON.parse(init.body).result;
    expect(initResult).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'chorus-browser' },
    });
    expect(initResult.instructions).toMatch(/app_screenshot, then use_app with x\/y/);
    expect(initResult.instructions).toMatch(/look_at_app mode outline, then use_app with ref/);
    const notification = await post(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      auth
    );
    expect(notification.status).toBe(202);

    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    const tools: Array<{ name: string; description: string; annotations: object }> = JSON.parse(
      list.body
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'app_screenshot',
      'look_at_app',
      'use_app',
      'open_app',
      'app_console',
    ]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const readOnly of ['app_screenshot', 'look_at_app', 'app_console']) {
      expect(byName[readOnly].annotations).toMatchObject({ readOnlyHint: true });
    }
    expect(byName.use_app.annotations).toMatchObject({ readOnlyHint: false });
    expect(byName.app_screenshot.description).toMatch(/Read-only/);
  });

  describe('read-only screenshot', () => {
    it('returns the image without acting, leasing, or asking for control', async () => {
      const reply = await post(port, toolCall('app_screenshot', {}), auth);
      const result = JSON.parse(reply.body).result;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/800×600 attached; use_app x\/y are in these pixels/);
      expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
      expect(control.findTaskBrowser).toHaveBeenCalledWith('t1', 'observe');
      expect(control.observe).toHaveBeenCalledWith(scope, {
        browserId: 'b1',
        mode: 'screenshot',
        includeConsole: false,
      });
      expect(control.act).not.toHaveBeenCalled();
      expect(control.requestOpen).not.toHaveBeenCalled();
    });

    it('works while the user drives the tile and leaves it with them', async () => {
      control.state.control = 'user';
      const result = await server.callTool(scope, 'app_screenshot', { max_edge: 640 });
      expect(result.isError).toBeUndefined();
      expect(control.observe).toHaveBeenCalledWith(scope, {
        browserId: 'b1',
        mode: 'screenshot',
        maxEdge: 640,
        includeConsole: false,
      });
      expect(control.state.control).toBe('user');
      expect(control.requestOpen).not.toHaveBeenCalled();
      expect(control.act).not.toHaveBeenCalled();
    });

    it('rejects bad arguments and a task without a browser', async () => {
      const bad = await server.callTool(scope, 'app_screenshot', { max_edge: 'big' });
      expect(bad.isError).toBe(true);
      const none = await server.callTool({ ...scope, taskId: 't9' }, 'app_screenshot', {});
      expect(none.isError).toBe(true);
      expect(control.observe).not.toHaveBeenCalled();
    });
  });

  it('look_at_app screenshots are MCP image content too', async () => {
    const result = await server.callTool(scope, 'look_at_app', { mode: 'screenshot' });
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(control.act).not.toHaveBeenCalled();
  });

  it('visual path: clicks at x/y from the latest screenshot', async () => {
    await post(port, toolCall('app_screenshot', {}, 1), auth);
    const reply = await post(
      port,
      toolCall('use_app', { action: 'click', x: 412, y: 230 }, 2),
      auth
    );
    expect(JSON.parse(reply.body).result.isError).toBeUndefined();
    expect(control.act).toHaveBeenCalledWith(scope, {
      browserId: 'b1',
      action: { kind: 'click', target: { x: 412, y: 230 } },
    });
  });

  it('structural path: outline refs drive type, select, click and press with no screenshot', async () => {
    const outline = await server.callTool(scope, 'look_at_app', { mode: 'outline' });
    expect(JSON.stringify(outline.content)).toContain('[ref=e7]');
    expect(outline.content.some((part) => part.type === 'image')).toBe(false);

    await server.callTool(scope, 'use_app', { action: 'type', ref: 'e3', text: 'Ada' });
    await server.callTool(scope, 'use_app', { action: 'select', ref: 'e5', value: 'admin' });
    await server.callTool(scope, 'use_app', { action: 'click', ref: '[ref=e7]' });
    await server.callTool(scope, 'use_app', { action: 'press', key: 'Enter' });
    expect(control.act.mock.calls.map(([, input]) => input.action)).toEqual([
      { kind: 'type', text: 'Ada', submit: false, target: { ref: 'e3' } },
      { kind: 'select', target: { ref: 'e5' }, value: 'admin' },
      { kind: 'click', target: { ref: 'e7' } },
      { kind: 'press', key: 'Enter' },
    ]);
    expect(control.observe).toHaveBeenCalledTimes(1);
    expect(control.observe).toHaveBeenCalledWith(scope, {
      browserId: 'b1',
      mode: 'outline',
      includeConsole: false,
    });
  });

  it('passes the token scope, not caller input, to the control service', async () => {
    await server.callTool(scope, 'use_app', { action: 'navigate', url: '/settings' });
    expect(control.act).toHaveBeenCalledWith(scope, {
      browserId: 'b1',
      action: { kind: 'navigate', url: 'http://localhost:5173/settings' },
    });
    const bad = await server.callTool(scope, 'use_app', { action: 'click' });
    expect(bad.isError).toBe(true);
  });

  it('asks the user for control before acting on a tile they drive', async () => {
    control.state.control = 'user';
    const result = await server.callTool(scope, 'use_app', { action: 'click', ref: 'e7' });
    expect(result.isError).toBeUndefined();
    expect(control.requestOpen).toHaveBeenCalledWith(scope, null, 'control');
    expect(control.act).toHaveBeenCalledWith(scope, {
      browserId: 'b1',
      action: { kind: 'click', target: { ref: 'e7' } },
    });
  });

  it('does not act when the user keeps control', async () => {
    control.state.control = 'user';
    control.requestOpen.mockResolvedValueOnce(refused('The user kept control of the app.'));
    const result = await server.callTool(scope, 'use_app', { action: 'click', x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('The user kept control of the app.');
    expect(control.act).not.toHaveBeenCalled();
  });

  it('routes every tool to the token task, never another task', async () => {
    const other = { ...scope, conversationId: 'c2', taskId: 't2' };
    for (const name of ['app_screenshot', 'look_at_app', 'app_console']) {
      expect((await server.callTool(other, name, { mode: 'outline' })).isError).toBe(true);
    }
    control.requestOpen.mockResolvedValueOnce(refused('No app browser is open for this task.'));
    expect((await server.callTool(other, 'use_app', { action: 'reload' })).isError).toBe(true);
    expect(control.findTaskBrowser.mock.calls.every(([taskId]) => taskId === 't2')).toBe(true);
    expect(control.requestOpen).toHaveBeenCalledWith(other, null, 'control');
    expect(control.observe).not.toHaveBeenCalled();
    expect(control.act).not.toHaveBeenCalled();
  });

  it('points at open_app when the task has no browser', async () => {
    const result = await server.callTool({ ...scope, taskId: 't9' }, 'look_at_app', {
      mode: 'text',
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.content)).toContain('open_app');
  });
});
