import { mkdtempSync, rmSync } from 'node:fs';
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
const savedKey = process.env.OPENAI_API_KEY;

function service(request: typeof fetch = vi.fn()): TalkService {
  return new TalkService({ secrets, dataDir } as unknown as ChorusHostServices, logger, request);
}

const offer = { sdp: 'v=0 offer', instructions: 'Be brief.', tools: [] };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'talk-service-'));
  secrets = new MemorySecrets();
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

describe('TalkService.openCall', () => {
  it('opens nothing while the line is off, and contacts nobody', async () => {
    const request = vi.fn();
    const result = await service(request).openCall(offer);
    expect(result).toMatchObject({ success: false, error: { type: 'disabled' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('needs a key', async () => {
    const talk = service();
    await talk.updateSettings({ enabled: true });
    expect(await talk.openCall(offer)).toMatchObject({
      success: false,
      error: { type: 'not-configured' },
    });
    expect((await talk.status()).hasKey).toBe(false);
  });

  it('forwards the offer with the key and the session, and returns the answer', async () => {
    await secrets.setSecret('chorus.credential.openai', secret('sk-test', 'openai'));
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response('v=0 answer', { status: 201 });
    });
    const talk = service(request as unknown as typeof fetch);
    await talk.updateSettings({ enabled: true, voice: 'cedar' });

    const result = await talk.openCall({
      ...offer,
      tools: [{ type: 'function', name: 'read_agent', description: 'Reads.', parameters: {} }],
    });

    expect(result).toEqual({
      success: true,
      data: { sdp: 'v=0 answer', model: DEFAULT_TALK_SETTINGS.model, voice: 'cedar' },
    });
    const [url, init = {}] = request.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('sdp')).toBe('v=0 offer');
    const session = JSON.parse(String(form.get('session')));
    expect(session).toMatchObject({
      type: 'realtime',
      model: DEFAULT_TALK_SETTINGS.model,
      instructions: 'Be brief.',
      tools: [{ name: 'read_agent' }],
      audio: { output: { voice: 'cedar' } },
    });
    expect((await talk.status()).usageToday.sessions).toBe(1);
  });

  it('reports a rejected key, a rate limit, and an unreachable provider', async () => {
    await secrets.setSecret('chorus.credential.openai', secret('sk-test', 'openai'));
    const respond = (status: number, body = '') =>
      vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

    const rejected = service(respond(401));
    await rejected.updateSettings({ enabled: true });
    expect(await rejected.openCall(offer)).toMatchObject({ error: { type: 'rejected-key' } });

    expect(await service(respond(429)).openCall(offer)).toMatchObject({
      error: { type: 'rate-limited' },
    });
    expect(
      await service(respond(400, JSON.stringify({ error: { message: 'bad session' } }))).openCall(
        offer
      )
    ).toMatchObject({ error: { type: 'api-error', message: 'OpenAI error 400: bad session' } });

    const down = service(
      vi.fn(async () => {
        throw new Error('network');
      }) as unknown as typeof fetch
    );
    expect(await down.openCall(offer)).toMatchObject({ error: { type: 'unreachable' } });
  });

  it('refuses a new session once the daily limit is spent', async () => {
    await secrets.setSecret('chorus.credential.openai', secret('sk-test', 'openai'));
    const request = vi.fn(async () => new Response('answer', { status: 200 }));
    const talk = service(request as unknown as typeof fetch);
    await talk.updateSettings({ enabled: true, dailyUsd: 0.01 });
    // One million uncached text tokens on the default model is four dollars.
    const status = await talk.recordUsage(DEFAULT_TALK_SETTINGS.model, {
      ...NO_TOKENS,
      textIn: 1_000_000,
    });
    expect(status.overBudget).toBe(true);
    expect(status.usageToday.usd).toBeCloseTo(4, 5);

    expect(await talk.openCall(offer)).toMatchObject({ error: { type: 'over-budget' } });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('TalkService usage', () => {
  it('adds up responses written at the same time without losing one', async () => {
    const talk = service();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        talk.recordUsage('gpt-realtime-2.1-mini', { ...NO_TOKENS, audioOut: 1_000 })
      )
    );
    const { usageToday } = await talk.status();
    expect(usageToday.responses).toBe(5);
    expect(usageToday.tokens.audioOut).toBe(5_000);
    expect(usageToday.usd).toBeCloseTo((5_000 / 1_000_000) * 20, 8);
  });
});

describe('sessionConfig', () => {
  it('lets Maestro decide who answers each turn', () => {
    const config = sessionConfig(DEFAULT_TALK_SETTINGS, 'x', []) as {
      audio: { input: { turn_detection: Record<string, unknown> } };
      reasoning?: unknown;
    };
    expect(config.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      create_response: false,
      interrupt_response: false,
    });
    expect(config.reasoning).toEqual({ effort: 'low' });
  });

  it('interrupts by voice only when talk-over is on, and sends effort only to models that take it', () => {
    const config = sessionConfig(
      { ...DEFAULT_TALK_SETTINGS, talkOver: true, model: 'gpt-realtime-1.5' },
      'x',
      []
    ) as { audio: { input: { turn_detection: Record<string, unknown> } }; reasoning?: unknown };
    expect(config.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(config.reasoning).toBeUndefined();
  });
});
