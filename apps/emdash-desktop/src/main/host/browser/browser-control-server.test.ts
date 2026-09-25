import http from 'node:http';
import { ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function fakeControl() {
  return {
    observe: vi.fn(async () =>
      ok({
        url: 'http://localhost:5173/',
        title: 'App',
        image: { mediaType: 'image/jpeg' as const, data: 'AAAA', width: 10, height: 10 },
      })
    ),
    act: vi.fn(async () => ok({ url: 'http://localhost:5173/x', title: 'App', changed: true })),
    consoleTail: vi.fn(async () => ok([])),
    findTaskBrowser: vi.fn((taskId: string) => (taskId === 't1' ? 'b1' : null)),
    describeTaskBrowser: vi.fn(() => ({
      browserId: 'b1',
      url: 'http://localhost:5173/',
      live: true,
      allowedOrigins: ['http://localhost:5173'],
    })),
    requestOpen: vi.fn(async () => ok('b1')),
  };
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

  it('speaks the MCP handshake and lists tools', async () => {
    const init = await post(
      port,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      auth
    );
    expect(JSON.parse(init.body).result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'chorus-browser' },
    });
    const notification = await post(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      auth
    );
    expect(notification.status).toBe(202);
    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    expect(JSON.parse(list.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'open_app',
      'look_at_app',
      'use_app',
      'app_console',
    ]);
  });

  it('returns screenshots as MCP image content', async () => {
    const reply = await post(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'look_at_app', arguments: { mode: 'screenshot' } },
      },
      auth
    );
    const result = JSON.parse(reply.body).result;
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(control.observe).toHaveBeenCalledWith(scope, {
      browserId: 'b1',
      mode: 'screenshot',
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

  it('asks the user to open the app when the task has no browser', async () => {
    const result = await server.callTool({ ...scope, taskId: 't9' }, 'look_at_app', {
      mode: 'text',
    });
    expect(result).toMatchObject({ isError: true });
  });
});
