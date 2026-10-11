import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopbackMcpServer, textResult, type ToolResult } from './loopback-mcp-server';

type Scope = { conversationId: string; taskId: string };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

class EchoServer extends LoopbackMcpServer<Scope> {
  readonly calls: Array<{ scope: Scope; name: string; args: Record<string, unknown> }> = [];

  constructor(onPort?: (port: number) => void) {
    super(
      {
        name: 'echo',
        tokenPrefix: 'echo_t_',
        instructions: 'Echoes.',
        tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } }],
        logLabel: 'EchoServer',
        sameScope: (left, right) => left.taskId === right.taskId,
        ...(onPort ? { onPort } : {}),
      },
      logger as never
    );
  }

  async callTool(scope: Scope, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ scope, name, args });
    if (name === 'boom') throw new Error('tool exploded');
    return textResult(`${scope.taskId}:${name}`);
  }
}

type Reply = { status: number; body: string; allow: string | undefined };

function send(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  { method = 'POST', path = '/mcp' } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, allow: res.headers.allow })
        );
      }
    );
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('LoopbackMcpServer', () => {
  let server: EchoServer;
  let port: number;
  let auth: Record<string, string>;

  beforeEach(async () => {
    logger.warn.mockClear();
    server = new EchoServer();
    auth = (await server.register({ conversationId: 'c1', taskId: 't1' })).headers;
    port = server.listeningPort;
  });

  afterEach(() => server.stop());

  it('reports its port once it listens and forgets it when stopped', async () => {
    const onPort = vi.fn();
    const other = new EchoServer(onPort);
    expect(other.listeningPort).toBe(0);
    const started = await other.ensureStarted();
    expect(await other.ensureStarted()).toBe(started);
    expect(onPort).toHaveBeenCalledExactlyOnceWith(started);
    expect(other.listeningPort).toBe(started);
    other.stop();
    expect(other.listeningPort).toBe(0);
  });

  it('keeps a token while the scope is unchanged and refreshes the stored scope', async () => {
    const again = await server.register({ conversationId: 'c1', taskId: 't1' });
    expect(again.headers).toEqual(auth);
    const moved = await server.register({ conversationId: 'c1', taskId: 't2' });
    expect(moved.headers).not.toEqual(auth);
    expect((await send(port, ping, auth)).status).toBe(401);

    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } };
    const reply = await send(port, call, moved.headers);
    expect(JSON.parse(reply.body).result).toEqual({ content: [{ type: 'text', text: 't2:echo' }] });
    expect(server.calls).toEqual([
      { scope: { conversationId: 'c1', taskId: 't2' }, name: 'echo', args: {} },
    ]);
  });

  it('evicts the oldest token once the registry is full', async () => {
    for (let index = 0; index < 255; index += 1) {
      await server.register({ conversationId: `filler-${index}`, taskId: 't1' });
    }
    expect((await send(port, ping, auth)).status).toBe(200);
    const newest = await server.register({ conversationId: 'one-more', taskId: 't1' });
    expect((await send(port, ping, auth)).status).toBe(401);
    expect((await send(port, ping, newest.headers)).status).toBe(200);
  });

  it('screens the request before it reads the token', async () => {
    const wrong = { Authorization: 'Bearer echo_t_nope' };
    expect((await send(port, ping, { ...wrong, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await send(port, ping, { ...wrong, 'Sec-Fetch-Mode': 'cors' })).status).toBe(403);
    expect((await send(port, ping, { ...wrong, Host: `localhost:${port}` })).status).toBe(403);
    expect((await send(port, ping, wrong, { path: '/other' })).status).toBe(404);
    expect((await send(port, ping, auth, { path: '/other' })).status).toBe(404);
    expect((await send(port, ping, wrong)).status).toBe(401);
    expect((await send(port, ping, { Authorization: auth.Authorization.slice(7) })).status).toBe(
      401
    );
    expect((await send(port, ping, auth, { path: '/mcp?session=1' })).status).toBe(200);
  });

  it('accepts only JSON POSTs', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const reply = await send(port, '', auth, { method });
      expect(reply.status).toBe(405);
      expect(reply.allow).toBe('POST');
    }
    expect((await send(port, 'x', { ...auth, 'Content-Type': 'text/plain' })).status).toBe(415);
  });

  it('never runs a tool for a body over the size cap', async () => {
    const call = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x'.repeat(300 * 1024) } },
    };
    // The server stops reading at the cap, so the client sees a 413 or a dropped connection.
    const outcome = await send(port, call, auth).then(
      (reply) => reply.status,
      () => 'dropped'
    );
    expect([413, 'dropped']).toContain(outcome);
    expect(server.calls).toEqual([]);
  });

  it('answers JSON-RPC errors without running a tool', async () => {
    const error = async (body: unknown) => JSON.parse((await send(port, body, auth)).body).error;
    expect(await error('{not json')).toMatchObject({ code: -32700 });
    expect(await error([ping])).toMatchObject({ code: -32600 });
    expect(await error({ id: 1, method: 'ping' })).toMatchObject({ code: -32600 });
    expect(await error({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).toMatchObject({
      code: -32601,
    });
    expect(await error({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} })).toMatchObject({
      code: -32602,
    });
    const notification = await send(port, { jsonrpc: '2.0', method: 'tools/call' }, auth);
    expect(notification).toMatchObject({ status: 202, body: '' });
    expect(server.calls).toEqual([]);
  });

  it('negotiates the protocol version and describes itself', async () => {
    const initialize = async (protocolVersion: unknown) =>
      JSON.parse(
        (
          await send(
            port,
            { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion } },
            auth
          )
        ).body
      ).result;
    expect(await initialize('2024-11-05')).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'echo', version: '1.0.0' },
      instructions: 'Echoes.',
    });
    expect((await initialize('1999-01-01')).protocolVersion).toBe('2025-06-18');

    const list = await send(port, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, auth);
    expect(JSON.parse(list.body).result).toEqual({
      tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } }],
    });
  });

  it('answers 500 and logs when a tool throws', async () => {
    const call = { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom' } };
    const reply = await send(port, call, auth);
    expect(reply).toMatchObject({ status: 500, body: '' });
    expect(logger.warn).toHaveBeenCalledWith('EchoServer: request failed', {
      error: 'Error: tool exploded',
    });
  });

  it('drops every token when stopped', async () => {
    server.stop();
    const restarted = await server.ensureStarted();
    expect((await send(restarted, ping, auth)).status).toBe(401);
  });
});
