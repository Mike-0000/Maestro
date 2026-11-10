import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { z } from 'zod';
import type {
  ClaudeUsageErrorType,
  ClaudeUsageLimit,
  ClaudeUsageSnapshot,
  ClaudeUsageWindow,
} from '../api/types';

export type ClaudeUsageError = (
  | { type: 'not-logged-in' }
  | { type: 'token-expired' }
  | { type: 'unauthorized' }
  | { type: 'rate-limited' }
  | { type: 'network'; message: string }
  | { type: 'unexpected-response'; status: number }
) & { type: ClaudeUsageErrorType };
export type ClaudeUsageDeps = {
  readFile(path: string): Promise<string>;
  fetch: typeof fetch;
  now(): number;
};

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10_000;

const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
  }),
});

const windowSchema = z
  .object({
    utilization: z.unknown().optional(),
    resets_at: z.unknown().optional(),
  })
  .nullish();

const limitSchema = z.object({
  kind: z.string().catch('unknown'),
  group: z.unknown().optional(),
  scope: z.unknown().optional(),
  percent: z.unknown().optional(),
  severity: z.unknown().optional(),
  resets_at: z.unknown().optional(),
});

const usageSchema = z.object({
  five_hour: windowSchema.catch(null),
  seven_day: windowSchema.catch(null),
  seven_day_opus: windowSchema.catch(null),
  seven_day_sonnet: windowSchema.catch(null),
  limits: z.array(z.unknown()).nullish().catch(null),
});

function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toWindow(raw: z.infer<typeof windowSchema>): ClaudeUsageWindow | null {
  if (!raw) return null;
  return { usedPercent: clampPercent(raw.utilization), resetsAt: str(raw.resets_at) };
}

function toLimits(raw: unknown[] | null | undefined): ClaudeUsageLimit[] {
  const limits: ClaudeUsageLimit[] = [];
  for (const item of raw ?? []) {
    const parsed = limitSchema.safeParse(item);
    if (!parsed.success) continue;
    const l = parsed.data;
    limits.push({
      kind: l.kind,
      group: str(l.group),
      scope: str(l.scope),
      usedPercent: clampPercent(l.percent),
      resetsAt: str(l.resets_at),
      severity: str(l.severity),
    });
  }
  return limits;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} (${code})` : error.name;
  }
  return 'Unknown error';
}

export async function fetchClaudeUsage(
  configDir: string,
  deps: ClaudeUsageDeps
): Promise<Result<ClaudeUsageSnapshot, ClaudeUsageError>> {
  let accessToken: string;
  let expiresAt: number | null;
  let subscriptionType: string | null;
  try {
    const raw = await deps.readFile(path.join(configDir, '.credentials.json'));
    const parsed = credentialsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return err({ type: 'not-logged-in' });
    const oauth = parsed.data.claudeAiOauth;
    accessToken = oauth.accessToken;
    expiresAt = oauth.expiresAt ?? null;
    subscriptionType = oauth.subscriptionType ?? null;
  } catch {
    return err({ type: 'not-logged-in' });
  }

  if (expiresAt !== null && expiresAt <= deps.now()) return err({ type: 'token-expired' });

  let response: Response;
  try {
    response = await deps.fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return err({ type: 'network', message: describeFailure(error) });
  }

  if (response.status === 401 || response.status === 403) return err({ type: 'unauthorized' });
  if (response.status === 429) return err({ type: 'rate-limited' });
  if (!response.ok) return err({ type: 'unexpected-response', status: response.status });

  let body: z.infer<typeof usageSchema>;
  try {
    const parsed = usageSchema.safeParse(await response.json());
    if (!parsed.success) return err({ type: 'unexpected-response', status: response.status });
    body = parsed.data;
  } catch {
    return err({ type: 'unexpected-response', status: response.status });
  }

  return ok({
    fetchedAt: new Date(deps.now()).toISOString(),
    subscriptionType,
    fiveHour: toWindow(body.five_hour),
    sevenDay: toWindow(body.seven_day),
    sevenDayOpus: toWindow(body.seven_day_opus),
    sevenDaySonnet: toWindow(body.seven_day_sonnet),
    limits: toLimits(body.limits),
  });
}
