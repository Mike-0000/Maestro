import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    delivery: { installRoot: null, installWorkerPath: null, profileRoot: dataDir },
    globalShortcuts: { register: () => true, unregister: () => {} },
    keyboardHook: { start: () => true, stop: () => {} },
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
    // The one message is the turn's start and the conversation's last: one breakpoint on it.
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: userTurn[0]!.content, cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);

    const tools = body.tools as { name: string; cache_control?: unknown }[];
    expect(tools.map((tool) => tool.name)).toContain('propose_plan');
    // The fixed prefix is kept an hour: turns are often more than five minutes apart.
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(tools.slice(0, -1).every((tool) => tool.cache_control === undefined)).toBe(true);
    const system = body.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
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
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: userTurn[0]!.content, cache_control: { type: 'ephemeral' } }],
    });
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

describe('ConductorService.decide (Jev)', () => {
  const jevReply = {
    model: 'typesafe/jev-1.13-20260917',
    answers: { is_urgent: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.000004 },
  };
  const questions = { is_urgent: { type: 'noul' as const, instructions: 'Urgent?' } };

  it('runs purely through OpenRouter when only an OpenRouter key is set', async () => {
    await secrets.setSecret('chorus.credential.openrouter', secret('sk-or-test', 'openrouter'));
    process.env.OPENROUTER_BASE_URL = baseUrl;
    respond = json(200, jevReply);
    const conductor = service();
    const status = await conductor.status();
    expect(status.jevReady).toBe(true);
    expect(status.jevVia).toBe('openrouter');
    const result = await conductor.decide({ text: 'prod is down' }, questions);
    expect(result.success && result.data.via).toBe('openrouter');
    expect(result.success && result.data.costUsd).toBe(0.000004);
    expect(captured[0]?.headers.authorization).toBe('Bearer sk-or-test');
    expect(captured[0]?.body.model).toBe('~typesafe/jev-latest');
  });

  it('honours an explicit source and reports when Jev has no key', async () => {
    const conductor = service();
    expect((await conductor.status()).jevVia).toBeNull();
    const missing = await conductor.decide('s', questions);
    expect(!missing.success && missing.error.type).toBe('not-configured');

    await secrets.setSecret('chorus.credential.openrouter', secret('sk-or-test', 'openrouter'));
    await secrets.setSecret('chorus.credential.typesafe', secret('ts-test', 'typesafe'));
    expect((await conductor.status()).jevVia).toBe('typesafe');
    await conductor.updateSettings({ provider: 'openrouter' });
    expect((await conductor.status()).jevVia).toBe('openrouter');
    await conductor.updateSettings({ jevSource: 'typesafe' });
    expect((await conductor.status()).jevVia).toBe('typesafe');
  });
});

describe('ConductorService log', () => {
  it('does not persist diagnostics without opt-in and deletes them when disabled', async () => {
    const conductor = service();
    const record = {
      at: new Date().toISOString(),
      utterance: 'secret',
      route: 'grammar' as const,
      actions: [],
      reply: 'ok',
      latencyMs: 1,
    };
    await conductor.appendLog(record);
    await conductor.appendTrace({
      interactionId: crypto.randomUUID(),
      at: record.at,
      kind: 'stt-final',
      text: 'secret',
    });
    expect(await conductor.readLog(10)).toEqual([]);
    expect(await conductor.readTrace({ limit: 10 })).toEqual([]);
    await conductor.updateSettings({ diagnosticHistory: true });
    await conductor.appendLog(record);
    expect(await conductor.readLog(10)).toHaveLength(1);
    await conductor.updateSettings({ diagnosticHistory: false });
    await conductor.updateSettings({ diagnosticHistory: true });
    expect(await conductor.readLog(10)).toEqual([]);
  });
  it('appends and reads back turns, newest last, skipping torn lines', async () => {
    const conductor = service();
    await conductor.updateSettings({ diagnosticHistory: true });
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
  it('keeps a whole multi-paragraph agent prompt in the logged action input', async () => {
    const conductor = service();
    await conductor.updateSettings({ diagnosticHistory: true });
    const prompt = Array.from({ length: 12 }, (_, index) => `Requirement ${index}. `.repeat(20))
      .join('\n\n')
      .trim();
    await conductor.appendLog({
      at: new Date().toISOString(),
      utterance: 'create an agent',
      route: 'llm',
      actions: [{ tool: 'spawn_agent', input: { prompt }, outcome: 'Created task.' }],
      reply: '',
      latencyMs: 1,
    });
    const [record] = await conductor.readLog(1);
    expect(prompt.length).toBeGreaterThan(2000);
    expect(JSON.parse(record!.actions[0]!.input as string)).toEqual({ prompt });
  });
});

describe('ConductorService code checks', () => {
  type SentTool = { name: string; cache_control?: unknown };
  const marked = (tools: SentTool[]) =>
    tools.filter((tool) => tool.cache_control !== undefined).map((tool) => tool.name);

  it('sends the code-check and lookup tools only while the setting is on, each list with its own marker', async () => {
    await withKey();
    const conductor = service();

    await conductor.runTurn('command', userTurn);
    const off = captured[0]?.body.tools as SentTool[];
    expect(off.map((tool) => tool.name)).not.toContain('investigate');
    expect(off.map((tool) => tool.name)).not.toContain('find_in_project');
    expect(marked(off)).toEqual([off.at(-1)?.name]);

    await conductor.updateSettings({ investigations: true });
    await conductor.runTurn('command', userTurn);
    const on = captured[1]?.body.tools as SentTool[];
    expect(on.slice(-2).map((tool) => tool.name)).toEqual(['investigate', 'find_in_project']);
    expect(marked(on)).toEqual(['find_in_project']);
    // Everything before them is the other list, minus that list's own marker.
    expect(on.slice(0, -2).map((tool) => tool.name)).toEqual(off.map((tool) => tool.name));

    await conductor.updateSettings({ investigations: false });
    await conductor.runTurn('command', userTurn);
    expect(captured[2]?.body.tools).toEqual(off);
  });

  it('selects the same list on the OpenRouter path', async () => {
    await secrets.setSecret('chorus.credential.openrouter', secret('sk-or-test', 'openrouter'));
    process.env.OPENROUTER_BASE_URL = baseUrl;
    respond = json(200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    const conductor = service();
    await conductor.updateSettings({ provider: 'openrouter' });
    const names = (index: number) =>
      ((captured[index]?.body.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name
      );

    await conductor.runTurn('command', userTurn);
    expect(names(0)).not.toContain('investigate');
    await conductor.updateSettings({ investigations: true });
    await conductor.runTurn('command', userTurn);
    expect(names(1).slice(-2)).toEqual(['investigate', 'find_in_project']);
    expect(names(1).slice(0, -2)).toEqual(names(0));
  });

  it('reports the investigator as off until one is attached, then asks it with the settings', async () => {
    const conductor = service();
    expect((await conductor.status()).investigator).toEqual({ state: 'off', reason: null });

    const read = vi.fn((settings: { investigations: boolean }) =>
      settings.investigations
        ? { state: 'unavailable' as const, reason: 'Claude Code is not signed in.' }
        : { state: 'off' as const, reason: null }
    );
    conductor.attachInvestigator(read);
    expect((await conductor.status()).investigator).toEqual({ state: 'off', reason: null });
    expect((await conductor.updateSettings({ investigations: true })).investigator).toEqual({
      state: 'unavailable',
      reason: 'Claude Code is not signed in.',
    });
    expect(await conductor.readSettings()).toMatchObject({
      investigations: true,
      investigatorModel: 'haiku',
      investigationTimeoutSec: 45,
      investigationsPerDay: 100,
      investigationDailyUsd: 2,
      investigationOfferShown: false,
    });
  });

  it('records checks next to tokens, and keeps both when writes overlap', async () => {
    await withKey();
    const conductor = service();
    expect(await conductor.investigationsToday()).toEqual({ count: 0, costUsd: 0 });

    await Promise.all([
      conductor.recordInvestigations(1, 0.004),
      conductor.runTurn('command', userTurn),
      conductor.recordInvestigations(2, 0.006),
      conductor.runTurn('command', userTurn),
      conductor.recordInvestigations(0, 0.003),
    ]);

    const today = await conductor.investigationsToday();
    expect(today.count).toBe(3);
    expect(today.costUsd).toBeCloseTo(0.013);
    expect((await conductor.status()).usageToday).toMatchObject({
      inputTokens: 220,
      outputTokens: 40,
      cacheReadTokens: 100,
      investigations: 3,
    });
    // A second instance reads the same totals from the file.
    expect(await service().investigationsToday()).toEqual(today);
  });

  it("starts a new day with no checks and only that day's tokens", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
      await withKey();
      const conductor = service();
      await conductor.runTurn('command', userTurn);
      await conductor.recordInvestigations(5, 0.02);
      expect((await conductor.status()).usageToday).toMatchObject({
        day: '2026-10-10',
        inputTokens: 110,
        investigations: 5,
      });

      vi.setSystemTime(new Date('2026-10-11T00:00:05Z'));
      expect(await conductor.investigationsToday()).toEqual({ count: 0, costUsd: 0 });
      // The first write of the new day must not carry yesterday's cached counts along.
      await conductor.runTurn('command', userTurn);
      expect((await conductor.status()).usageToday).toEqual({
        day: '2026-10-11',
        inputTokens: 110,
        outputTokens: 20,
        cacheReadTokens: 50,
        investigations: 0,
        investigationCostUsd: 0,
      });
      await conductor.recordInvestigations(1, 0.001);
      expect((await conductor.status()).usageToday).toMatchObject({
        day: '2026-10-11',
        inputTokens: 110,
        investigations: 1,
        investigationCostUsd: 0.001,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads settings and usage files written before code checks existed', async () => {
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dataDir, 'conductor-settings.json'),
      JSON.stringify({ model: 'claude-haiku-4-5', dailyTokenBudget: 5_000, jevEnabled: false })
    );
    writeFileSync(
      join(dataDir, 'conductor-usage.json'),
      JSON.stringify({ day, inputTokens: 900, outputTokens: 100, cacheReadTokens: 300 })
    );

    const status = await service().status();
    expect(status.settings).toMatchObject({
      model: 'claude-haiku-4-5',
      dailyTokenBudget: 5_000,
      jevEnabled: false,
      investigations: false,
      investigatorModel: 'haiku',
    });
    expect(status.usageToday).toEqual({
      day,
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 300,
      investigations: 0,
      investigationCostUsd: 0,
    });
  });
});

describe('ConductorService standing instructions', () => {
  it('saves them, reports them, and sends them after the fixed prompt', async () => {
    await withKey();
    const first = service();
    expect((await first.status()).instructions).toEqual([]);
    await first.runTurn('command', userTurn);
    const plain = captured[0]?.body.system as { text: string }[];
    expect(plain).toHaveLength(1);

    const added = await first.adjustInstructions({
      action: 'add',
      text: 'Keep prompts to agents short and open-ended.',
    });
    expect(added.success).toBe(true);
    if (added.success) {
      expect(added.data.summary).toContain('Saved as i1');
      expect(added.data.status.instructions.map((entry) => entry.id)).toEqual(['i1']);
    }

    // A new service is a restart: the instruction is read from disk.
    await service().runTurn('command', userTurn);
    const system = captured[1]?.body.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    // The fixed prompt is the same bytes with the same marker, so its cache is kept.
    expect(system[0]).toEqual(plain[0]);
    expect(system[1]?.text).toContain('- [i1] Keep prompts to agents short and open-ended.');
    // No breakpoint of their own: the conversation's breakpoints after them cache them.
    expect(system[1]?.cache_control).toBeUndefined();
  });

  it('refuses a change it cannot make, keeps overlapping changes, and redacts secrets', async () => {
    const conductor = service();
    const missing = await conductor.adjustInstructions({ action: 'remove', id: 'i4' });
    expect(missing.success).toBe(false);
    await Promise.all([
      conductor.adjustInstructions({ action: 'add', text: 'Use Codex for reviews.' }),
      conductor.adjustInstructions({ action: 'add', text: 'Answer in one sentence.' }),
    ]);
    const key = `sk-ant-api03-${'a'.repeat(40)}`;
    await conductor.adjustInstructions({ action: 'add', text: `Use the key ${key} for it.` });
    const saved = (await service().status()).instructions;
    expect(saved.map((entry) => entry.id)).toEqual(['i1', 'i2', 'i3']);
    expect(saved[2]?.text).not.toContain(key);
  });
});
