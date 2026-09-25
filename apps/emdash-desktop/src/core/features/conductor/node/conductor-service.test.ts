import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secret, type Secret } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { ConductorService } from './conductor-service';

type Captured = { headers: IncomingHttpHeaders; body: Record<string, unknown> };

let server: Server;
let baseUrl = '';
let captured: Captured[] = [];
let respond: (res: ServerResponse) => void = () => {};

const toolUseMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name: 'focus_agent', input: { agent: 'Claude 1' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
};

function json(status: number, body: unknown) {
  return (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, Secret<string>>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: Secret<string>) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

let dataDir: string;
let secrets: MemorySecrets;
const savedEnv = { ...process.env };

function service(): ConductorService {
  const host: ChorusHostServices = {
    secrets,
    dataDir,
    globalShortcuts: { register: () => true, unregister: () => {} },
    openMicrophoneSettings: async () => {},
  };
  return new ConductorService(host, logger);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'chorus-conductor-'));
  secrets = new MemorySecrets();
  captured = [];
  respond = json(200, toolUseMessage);
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

async function withKey(): Promise<void> {
  await secrets.setSecret('chorus.credential.anthropic', secret('sk-ant-test', 'anthropic'));
}

const userTurn = [{ role: 'user' as const, content: '<context>\n</context>\n\nfocus claude one' }];

describe('ConductorService.runTurn', () => {
  it('asks for a key before calling the API', async () => {
    const result = await service().runTurn('command', userTurn);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('not-configured');
    expect(captured).toHaveLength(0);
  });

  it('sends adaptive thinking, effort, fallback, caching, and the tool list', async () => {
    await withKey();
    const result = await service().runTurn('command', userTurn);
    expect(result.success).toBe(true);

    const [request] = captured;
    expect(request?.headers['x-api-key']).toBe('sk-ant-test');
    expect(String(request?.headers['anthropic-beta'])).toContain('server-side-fallback-2026-06-01');
    const body = request?.body ?? {};
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    expect(body.messages).toEqual(userTurn);

    const tools = body.tools as { name: string; cache_control?: unknown }[];
    expect(tools.map((tool) => tool.name)).toContain('propose_plan');
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).every((tool) => tool.cache_control === undefined)).toBe(true);
    const system = body.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses plan effort and a larger budget for plans', async () => {
    await withKey();
    await service().runTurn('plan', userTurn);
    expect(captured[0]?.body.output_config).toEqual({ effort: 'high' });
    expect(captured[0]?.body.max_tokens).toBe(16000);
  });

  it('returns content blocks unchanged (thinking included) and records usage', async () => {
    await withKey();
    const conductor = service();
    const result = await conductor.runTurn('command', userTurn);
    expect(result.success && result.data.content.map((block) => block.type)).toEqual([
      'thinking',
      'tool_use',
    ]);
    expect(result.success && result.data.usage).toEqual({
      inputTokens: 110,
      outputTokens: 20,
      cacheReadTokens: 50,
    });
    const status = await conductor.status();
    expect(status.configured).toBe(true);
    expect(status.usageToday.inputTokens + status.usageToday.outputTokens).toBe(130);
  });

  it('stops at the daily token budget', async () => {
    await withKey();
    const conductor = service();
    await conductor.updateSettings({ dailyTokenBudget: 100 });
    await conductor.runTurn('command', userTurn);
    const blocked = await conductor.runTurn('command', userTurn);
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error.type).toBe('budget-exceeded');
    expect(captured).toHaveLength(1);
  });

  it('omits thinking and fallback for models without them', async () => {
    await withKey();
    const conductor = service();
    await conductor.updateSettings({ model: 'claude-haiku-4-5' });
    await conductor.runTurn('command', userTurn);
    const body = captured[0]?.body ?? {};
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
  });

  it('maps a rejected key to not-configured', async () => {
    await withKey();
    respond = json(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });
    const result = await service().runTurn('command', userTurn);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('not-configured');
  });

  it('reports refusals', async () => {
    await withKey();
    respond = json(200, { ...toolUseMessage, content: [], stop_reason: 'refusal' });
    const result = await service().runTurn('command', userTurn);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('refused');
  });
});

describe('ConductorService.runTurn via OpenRouter', () => {
  async function useOpenRouter(conductor: ConductorService) {
    await secrets.setSecret('chorus.credential.openrouter', secret('sk-or-test', 'openrouter'));
    process.env.OPENROUTER_BASE_URL = baseUrl;
    await conductor.updateSettings({ provider: 'openrouter' });
  }

  it('sends chat completions with tools and maps tool calls back to content blocks', async () => {
    const conductor = service();
    await useOpenRouter(conductor);
    respond = json(200, {
      model: 'anthropic/claude-opus-5',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'focus_agent', arguments: '{"agent":"Claude 1"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 15,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    const result = await conductor.runTurn('plan', userTurn);
    const [request] = captured;
    expect(request?.headers.authorization).toBe('Bearer sk-or-test');
    expect(request?.body.model).toBe('anthropic/claude-opus-5');
    expect(request?.body.max_tokens).toBe(16000);
    expect(request?.body.reasoning).toEqual({ effort: 'high' });
    const messages = request?.body.messages as { role: string }[];
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toEqual(userTurn[0]);
    const tools = request?.body.tools as { type: string; function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).toContain('propose_plan');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopReason).toBe('tool_use');
      expect(result.data.content).toEqual([
        { type: 'tool_use', id: 'call_1', name: 'focus_agent', input: { agent: 'Claude 1' } },
      ]);
      expect(result.data.usage).toEqual({
        inputTokens: 120,
        outputTokens: 15,
        cacheReadTokens: 40,
      });
    }
    expect((await conductor.status()).configured).toBe(true);
  });

  it('reports a missing OpenRouter key and a rejected one', async () => {
    const conductor = service();
    await conductor.updateSettings({ provider: 'openrouter' });
    const missing = await conductor.runTurn('command', userTurn);
    expect(!missing.success && missing.error.message).toContain('OpenRouter');
    await useOpenRouter(conductor);
    respond = json(401, { error: { message: 'bad key', code: 401 } });
    const rejected = await conductor.runTurn('command', userTurn);
    expect(!rejected.success && rejected.error.type).toBe('not-configured');
  });
});

describe('ConductorService log', () => {
  it('appends and reads back turns, newest last, skipping torn lines', async () => {
    const conductor = service();
    for (const utterance of ['one', 'two', 'three']) {
      await conductor.appendLog({
        at: new Date().toISOString(),
        utterance,
        route: 'grammar',
        actions: [],
        reply: '',
        latencyMs: 1,
      });
    }
    const records = await conductor.readLog(2);
    expect(records.map((record) => record.utterance)).toEqual(['two', 'three']);
  });
});
