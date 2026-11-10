import { describe, expect, it, vi } from 'vitest';
import { fetchClaudeUsage, type ClaudeUsageDeps } from './usage-client';

const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE';
const NOW = 1_780_000_000_000;

function creds(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN,
      refreshToken: 'REFRESH-SECRET',
      expiresAt: NOW + 3_600_000,
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeDeps(opts: {
  file?: string | Error;
  response?: Response | Error;
}): ClaudeUsageDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => {
    if (opts.response instanceof Error) throw opts.response;
    return opts.response ?? jsonResponse({});
  });
  return {
    readFile: vi.fn(async () => {
      if (opts.file instanceof Error) throw opts.file;
      return opts.file ?? creds();
    }),
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
  } as unknown as ClaudeUsageDeps & { fetch: ReturnType<typeof vi.fn> };
}

const sample = {
  five_hour: null,
  seven_day: { utilization: 33.0, resets_at: '2026-11-15T10:00:00.496319+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 33,
      severity: 'normal',
      resets_at: '2026-11-15T10:00:00.496319+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 158,
      severity: 'normal',
      resets_at: null,
      scope: 'opus',
      is_active: false,
    },
  ],
};

describe('fetchClaudeUsage', () => {
  it('maps a real response', async () => {
    const deps = makeDeps({ response: jsonResponse(sample) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      fetchedAt: new Date(NOW).toISOString(),
      subscriptionType: 'max',
      fiveHour: null,
      sevenDay: { usedPercent: 33, resetsAt: '2026-11-15T10:00:00.496319+00:00' },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      limits: [
        {
          kind: 'weekly_all',
          group: 'weekly',
          scope: null,
          usedPercent: 33,
          resetsAt: '2026-11-15T10:00:00.496319+00:00',
          severity: 'normal',
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          scope: 'opus',
          usedPercent: 100,
          resetsAt: null,
          severity: 'normal',
        },
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain(TOKEN);
  });

  it('handles all-null windows and missing limits', async () => {
    const deps = makeDeps({ response: jsonResponse({ five_hour: null, seven_day: null }) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fiveHour).toBeNull();
    expect(result.data.sevenDay).toBeNull();
    expect(result.data.limits).toEqual([]);
  });

  it('sends the url and headers', async () => {
    const deps = makeDeps({ response: jsonResponse(sample) });
    await fetchClaudeUsage('/cfg', deps);
    const [url, init] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(init.signal).toBeDefined();
  });

  it('returns not-logged-in when the file is missing', async () => {
    const deps = makeDeps({ file: new Error('ENOENT') });
    expect(await fetchClaudeUsage('/cfg', deps)).toEqual({
      success: false,
      error: { type: 'not-logged-in' },
    });
  });

  it('returns not-logged-in for malformed JSON', async () => {
    const deps = makeDeps({ file: '{not json' });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(!result.success && result.error.type).toBe('not-logged-in');
  });

  it('returns not-logged-in without an access token', async () => {
    const deps = makeDeps({ file: JSON.stringify({ claudeAiOauth: {} }) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(!result.success && result.error.type).toBe('not-logged-in');
  });

  it('returns token-expired without calling the network', async () => {
    const deps = makeDeps({ file: creds({ expiresAt: NOW - 1 }) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(!result.success && result.error.type).toBe('token-expired');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate-limited'],
  ])('maps HTTP %i to %s', async (status, type) => {
    const deps = makeDeps({ response: jsonResponse({}, status) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(!result.success && result.error.type).toBe(type);
  });

  it('maps HTTP 500 to unexpected-response', async () => {
    const deps = makeDeps({ response: jsonResponse({}, 500) });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(result).toEqual({ success: false, error: { type: 'unexpected-response', status: 500 } });
  });

  it('maps a thrown fetch to network without leaking the token', async () => {
    const failure = Object.assign(new Error(`boom Bearer ${TOKEN}`), { code: 'ECONNRESET' });
    const deps = makeDeps({ response: failure });
    const result = await fetchClaudeUsage('/cfg', deps);
    expect(!result.success && result.error.type).toBe('network');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
