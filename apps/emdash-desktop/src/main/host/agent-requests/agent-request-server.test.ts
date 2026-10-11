import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_REQUEST_INSTRUCTIONS,
  type AgentRequest,
  type AgentRequestAck,
} from '@core/features/conductor/api/agent-requests';
import { AgentRequestServer, type AgentRequestScope } from './agent-request-server';

const scope: AgentRequestScope = {
  conversationId: 'c1',
  projectId: 'p1',
  taskId: 't1',
  name: 'Nova',
};

const other: AgentRequestScope = {
  conversationId: 'c2',
  projectId: 'p2',
  taskId: 't2',
  name: 'Atlas',
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

type Reply = { status: number; body: string };

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } };
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('AgentRequestServer', () => {
  let submit: ReturnType<
    typeof vi.fn<
      (from: AgentRequest['from'], args: Record<string, unknown>) => Promise<AgentRequestAck>
    >
  >;
  let server: AgentRequestServer;
  let port: number;
  let auth: Record<string, string>;

  beforeEach(async () => {
    submit = vi.fn(async () => ({ accepted: true, message: 'Request r-1a2b3c accepted.' }));
    server = new AgentRequestServer(submit, logger);
    const registration = await server.register(scope);
    port = server.listeningPort;
    auth = registration.headers;
    expect(registration.name).toBe('maestro');
    expect(registration.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(auth.Authorization).toMatch(/^Bearer maestro_at_[a-f0-9]{48}$/);
  });

  afterEach(() => server.stop());

  it('introduces itself as maestro with the conductor instructions', async () => {
    const reply = await post(
      port,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      auth
    );
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'maestro' },
      instructions: AGENT_REQUEST_INSTRUCTIONS,
    });
  });

  it('lists exactly the conductor_request tool', async () => {
    const reply = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    const tools: Array<{ name: string; inputSchema: object; annotations: object }> = JSON.parse(
      reply.body
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(['conductor_request']);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['kind', 'payload'] });
    expect(tools[0]?.annotations).toEqual({
      title: 'Ask the conductor',
      readOnlyHint: false,
      openWorldHint: false,
    });
  });

  it('stamps the sender from the token, never from the arguments', async () => {
    const otherAuth = (await server.register(other)).headers;
    // c1 claims to be c2, which really exists and holds its own token.
    const forged = {
      kind: 'report',
      payload: { status: 'done', message: 'x' },
      conversationId: 'c2',
      taskId: 't2',
      projectId: 'p2',
      from: { conversationId: 'c2', taskId: 't2', projectId: 'p2' },
    };
    const reply = await post(port, toolCall('conductor_request', forged), auth);

    expect(JSON.parse(reply.body).result).toEqual({
      content: [{ type: 'text', text: 'Request r-1a2b3c accepted.' }],
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toStrictEqual({
      conversationId: 'c1',
      taskId: 't1',
      projectId: 'p1',
    });
    expect(submit.mock.calls[0]?.[1]).toEqual(forged);

    await post(port, toolCall('conductor_request', { kind: 'report' }), otherAuth);
    expect(submit.mock.calls[1]?.[0]).toStrictEqual({
      conversationId: 'c2',
      taskId: 't2',
      projectId: 'p2',
    });
  });

  it('returns a refused request as a tool error', async () => {
    submit.mockResolvedValueOnce({ accepted: false, message: 'Unknown request kind "x".' });
    const reply = await post(port, toolCall('conductor_request', { kind: 'x' }), auth);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).result).toEqual({
      content: [{ type: 'text', text: 'Unknown request kind "x".' }],
      isError: true,
    });
  });

  it('refuses an unknown tool without reaching the conductor', async () => {
    const reply = await post(port, toolCall('spawn_agent', { provider: 'codex' }), auth);
    expect(JSON.parse(reply.body).result).toMatchObject({ isError: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects missing, wrong and foreign tokens', async () => {
    expect((await post(port, ping)).status).toBe(401);
    expect((await post(port, ping, { Authorization: 'Bearer maestro_at_nope' })).status).toBe(401);
    // A browser-control token is no authority here.
    const foreign = `Bearer chorus_bt_${auth.Authorization.slice('Bearer maestro_at_'.length)}`;
    expect((await post(port, ping, { Authorization: foreign })).status).toBe(401);
    expect((await post(port, ping, auth)).status).toBe(200);
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses browser-originated requests before auth', async () => {
    const call = toolCall('conductor_request', { kind: 'report' });
    expect((await post(port, call, { ...auth, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(port, call, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post(port, call, { ...auth, Host: `localhost:${port}` })).status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });
});
