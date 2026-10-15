import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secret, type Secret } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { DEFAULT_TALK_SETTINGS } from '../api/contract';
import { NO_TOKENS } from '../api/usage';
import { sessionConfig, TalkService } from './talk-service';

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
const savedKey = process.env.XAI_API_KEY;

function service(request: typeof fetch = vi.fn()): TalkService {
  return new TalkService({ secrets, dataDir } as unknown as ChorusHostServices, logger, request);
}

const asked = { instructions: 'Be brief.', tools: [] };

function minted(value = 'xai-secret-1', expiresAt = 1_800_000_000) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ value, expires_at: expiresAt }), { status: 200 });
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'talk-service-'));
  secrets = new MemorySecrets();
  delete process.env.XAI_API_KEY;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = savedKey;
});

describe('TalkService.openSession', () => {
  it('opens nothing while the line is off, and contacts nobody', async () => {
    const request = vi.fn();
    const result = await service(request).openSession(asked);
    expect(result).toMatchObject({ success: false, error: { type: 'disabled' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('needs an xAI key', async () => {
    const talk = service();
    await talk.updateSettings({ enabled: true });
    expect(await talk.openSession(asked)).toMatchObject({
      success: false,
      error: { type: 'not-configured' },
    });
    expect((await talk.status()).hasKey).toBe(false);
  });

  it('takes the key from XAI_API_KEY when none is stored', async () => {
    process.env.XAI_API_KEY = 'xai-env';
    expect((await service().status()).hasKey).toBe(true);
  });

  it('mints a short-lived client secret with the key, and returns it with the session', async () => {
    await secrets.setSecret('chorus.credential.xai', secret('xai-test', 'xai'));
    const request = minted();
    const talk = service(request as unknown as typeof fetch);
    await talk.updateSettings({ enabled: true, voice: 'rex' });

    const result = await talk.openSession({
      ...asked,
      tools: [{ type: 'function', name: 'read_agent', description: 'Reads.', parameters: {} }],
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        url: 'wss://api.x.ai/v1/realtime?model=grok-voice-3.0',
        clientSecret: 'xai-secret-1',
        expiresAt: 1_800_000_000,
        model: 'grok-voice-3.0',
        voice: 'rex',
        session: {
          model: 'grok-voice-3.0',
          instructions: 'Be brief.',
          voice: 'rex',
          tools: [{ name: 'read_agent' }],
        },
      },
    });
    const [url, init = {}] = request.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/realtime/client_secrets');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xai-test');
    expect(JSON.parse(String(init.body))).toEqual({ expires_after: { seconds: 120 } });
    // The key itself is never handed back.
    expect(JSON.stringify(result)).not.toContain('xai-test');
    expect((await talk.status()).usageToday.sessions).toBe(1);
  });

  it('reports a rejected key, a rate limit, a missing secret, and an unreachable provider', async () => {
    await secrets.setSecret('chorus.credential.xai', secret('xai-test', 'xai'));
    const respond = (status: number, body = '') =>
      vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

    const rejected = service(respond(401));
    await rejected.updateSettings({ enabled: true });
    expect(await rejected.openSession(asked)).toMatchObject({ error: { type: 'rejected-key' } });

    expect(await service(respond(429)).openSession(asked)).toMatchObject({
      error: { type: 'rate-limited' },
    });
    expect(
      await service(
        respond(400, JSON.stringify({ error: { message: 'bad request' } }))
      ).openSession(asked)
    ).toMatchObject({ error: { type: 'api-error', message: 'xAI error 400: bad request' } });
    expect(
      await service(respond(400, JSON.stringify({ error: 'no such team' }))).openSession(asked)
    ).toMatchObject({ error: { type: 'api-error', message: 'xAI error 400: no such team' } });
    expect(await service(respond(200, '{}')).openSession(asked)).toMatchObject({
      error: { type: 'api-error', message: 'xAI sent no client secret.' },
    });

    const down = service(
      vi.fn(async () => {
        throw new Error('network');
      }) as unknown as typeof fetch
    );
    expect(await down.openSession(asked)).toMatchObject({ error: { type: 'unreachable' } });
  });

  it('refuses a new session once the daily limit is spent', async () => {
    await secrets.setSecret('chorus.credential.xai', secret('xai-test', 'xai'));
    const request = minted();
    const talk = service(request as unknown as typeof fetch);
    await talk.updateSettings({ enabled: true, dailyUsd: 0.05 });
    // An hour open is $4.80.
    const status = await talk.recordUsage(DEFAULT_TALK_SETTINGS.model, NO_TOKENS, {
      seconds: 3_600,
    });
    expect(status.overBudget).toBe(true);
    expect(status.usageToday.usd).toBeCloseTo(4.8, 5);

    expect(await talk.openSession(asked)).toMatchObject({ error: { type: 'over-budget' } });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('TalkService settings', () => {
  it('moves settings saved for the OpenAI line to Grok Voice, and keeps the rest', async () => {
    writeFileSync(
      join(dataDir, 'talk-settings.json'),
      JSON.stringify({
        ...DEFAULT_TALK_SETTINGS,
        enabled: true,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        effort: 'low',
        transcriptionModel: 'gpt-transcribe',
        dailyUsd: 12,
        listening: 'open',
      })
    );
    const { settings } = await service().status();
    expect(settings).toMatchObject({
      enabled: true,
      model: 'grok-voice-3.0',
      voice: 'eve',
      effort: 'none',
      transcriptionModel: 'grok-transcribe',
      dailyUsd: 12,
      listening: 'open',
    });
  });

  it('keeps a Grok voice that was chosen', async () => {
    writeFileSync(
      join(dataDir, 'talk-settings.json'),
      JSON.stringify({ model: 'grok-voice-latest', voice: 'leo', effort: 'medium' })
    );
    expect((await service().status()).settings).toMatchObject({
      model: 'grok-voice-latest',
      voice: 'leo',
      effort: 'high',
    });
  });
});

describe('TalkService usage', () => {
  it('adds up reports written at the same time without losing one', async () => {
    const talk = service();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        talk.recordUsage(
          'grok-voice-3.0',
          { ...NO_TOKENS, textIn: 1_000 },
          { seconds: 12, textInputs: 1 }
        )
      )
    );
    const { usageToday } = await talk.status();
    expect(usageToday.responses).toBe(5);
    expect(usageToday.seconds).toBe(60);
    expect(usageToday.tokens.textIn).toBe(5_000);
    expect(usageToday.usd).toBeCloseTo(0.08 + 5 * 0.004, 8);
  });

  it('counts the clock of an open line as time, not as a response', async () => {
    const talk = service();
    const { usageToday } = await talk.recordUsage('grok-voice-3.0', NO_TOKENS, { seconds: 30 });
    expect(usageToday).toMatchObject({ responses: 0, seconds: 30 });
    expect(usageToday.usd).toBeCloseTo(0.04, 8);
  });

  it('reads a usage file written before time was counted', async () => {
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dataDir, 'talk-usage.json'),
      JSON.stringify({ day, usd: 1.5, responses: 3, sessions: 1, tokens: NO_TOKENS })
    );
    expect((await service().status()).usageToday).toMatchObject({ usd: 1.5, seconds: 0 });
  });
});

describe('sessionConfig', () => {
  it('takes turns by hand, so Maestro decides who answers each turn', () => {
    const config = sessionConfig(DEFAULT_TALK_SETTINGS, 'x', []);
    expect(config).toMatchObject({
      model: 'grok-voice-3.0',
      voice: 'eve',
      reasoning: { effort: 'high' },
      turn_detection: { type: null },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: { model: 'grok-transcribe' },
        },
        output: { format: { type: 'audio/pcm', rate: 24_000 } },
      },
    });
  });

  it('sends the effort as Grok takes it, and nothing OpenAI-only', () => {
    const config = sessionConfig({ ...DEFAULT_TALK_SETTINGS, effort: 'none' }, 'x', []);
    expect(config.reasoning).toEqual({ effort: 'none' });
    expect(config).not.toHaveProperty('type');
    expect(config).not.toHaveProperty('tool_choice');
  });
});
