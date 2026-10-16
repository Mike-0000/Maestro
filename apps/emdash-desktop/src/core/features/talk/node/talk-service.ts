import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { z } from 'zod';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';
import {
  DEFAULT_TALK_SETTINGS,
  isTalkAgentId,
  migrateTalkSettings,
  talkLineModel,
  talkSettingsSchema,
  talkUsageSchema,
  type TalkError,
  type TalkSettings,
  type TalkStatus,
  type TalkTool,
  type TalkUsage,
} from '../api/contract';
import { NO_TOKENS, talkCostUsd, type TalkBilled, type TalkTokens } from '../api/usage';

const CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';
const REALTIME_URL = 'wss://api.x.ai/v1/realtime';
const OPEN_TIMEOUT_MS = 15_000;
/**
 * How long a client secret is good for. It is used once, to open the connection right after it
 * is made; a session outlives it. Short, so a secret that leaks is useless soon after.
 */
const CLIENT_SECRET_TTL_S = 120;
/** xAI's own search tools, which run on its side: the line sees only what the model says. */
const SEARCH_TOOLS = [{ type: 'web_search' }, { type: 'x_search' }] as const;
/** The sample rate of the line's audio both ways: xAI's default, and no resampling at its end. */
export const TALK_SAMPLE_RATE = 24_000;

/** Settings saved for the OpenAI line are moved to Grok Voice's as they are read. */
const storedTalkSettingsSchema = z.preprocess(migrateTalkSettings, talkSettingsSchema);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): TalkUsage {
  return { day: today(), usd: 0, responses: 0, sessions: 0, seconds: 0, tokens: NO_TOKENS };
}

/**
 * The main-process half of the talk line. It holds the provider key, sets sessions up on the
 * renderer's behalf, and counts what the line costs against a daily limit.
 */
export class TalkService {
  private readonly credentials: ChorusCredentials;
  private readonly settings: JsonSettingsFile<TalkSettings>;
  private readonly usage: JsonSettingsFile<TalkUsage>;
  private usageWrites: Promise<unknown> = Promise.resolve();

  constructor(
    host: ChorusHostServices,
    private readonly logger: Logger,
    private readonly request: typeof fetch = fetch
  ) {
    this.credentials = new ChorusCredentials(host.secrets);
    this.settings = JsonSettingsFile.inDir(
      host.dataDir,
      'talk-settings.json',
      storedTalkSettingsSchema as z.ZodType<TalkSettings>,
      DEFAULT_TALK_SETTINGS
    );
    this.usage = JsonSettingsFile.inDir(
      host.dataDir,
      'talk-usage.json',
      talkUsageSchema,
      emptyUsage()
    );
  }

  async status(): Promise<TalkStatus> {
    const settings = await this.settings.read();
    const usageToday = await this.usageToday();
    return {
      settings,
      hasKey: (await this.credentials.get('xai')) !== null,
      usageToday,
      overBudget: settings.dailyUsd > 0 && usageToday.usd >= settings.dailyUsd,
    };
  }

  async updateSettings(patch: Partial<TalkSettings>): Promise<TalkStatus> {
    await this.settings.update(patch);
    return this.status();
  }

  /**
   * Mints a client secret for one connection, and says where to connect and what session to
   * configure. The key is used here and nowhere else; the renderer only gets the secret, which
   * opens a connection for the next couple of minutes and nothing else.
   */
  async openSession(input: { instructions: string; tools: readonly TalkTool[] }): Promise<
    Result<
      {
        url: string;
        clientSecret: string;
        expiresAt: number;
        session: Record<string, unknown>;
        model: string;
        voice: string;
      },
      TalkError
    >
  > {
    const settings = await this.settings.read();
    if (!settings.enabled) {
      return err({ type: 'disabled', message: 'The talk line is turned off.' });
    }
    const key = await this.credentials.get('xai');
    if (!key) {
      return err({
        type: 'not-configured',
        message: 'Add an xAI API key in Settings → Voice & Conductor to use the talk line.',
      });
    }
    const agentId = settings.agentId.trim();
    if (agentId && !isTalkAgentId(agentId)) {
      return err({
        type: 'invalid-agent',
        message:
          'The custom voice agent id is not one xAI gives out (agent_ and letters or digits). Fix or clear it in Settings → Voice & Conductor.',
      });
    }
    const usage = await this.usageToday();
    if (settings.dailyUsd > 0 && usage.usd >= settings.dailyUsd) {
      return err({
        type: 'over-budget',
        message: "Today's talk line limit is used up. Raise it in Settings → Voice & Conductor.",
      });
    }

    let response: Response;
    try {
      response = await this.request(CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.expose()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expires_after: { seconds: CLIENT_SECRET_TTL_S } }),
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err({
        type: 'unreachable',
        message: timedOut ? 'xAI took too long to answer.' : 'Could not reach xAI.',
      });
    }
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      this.logger.warn('talk: the provider refused the session', { status: response.status });
      return err(describeFailure(response.status, body));
    }
    const minted = parseClientSecret(body);
    if (!minted) {
      this.logger.warn('talk: the provider sent no client secret');
      return err({ type: 'api-error', message: 'xAI sent no client secret.' });
    }
    await this.updateUsage((current) => ({ ...current, sessions: current.sessions + 1 }));
    // A custom agent is reached by its id and brings its own model and voice.
    const target = agentId
      ? `agent_id=${encodeURIComponent(agentId)}`
      : `model=${encodeURIComponent(settings.model)}`;
    return ok({
      url: `${REALTIME_URL}?${target}`,
      clientSecret: minted.value,
      expiresAt: minted.expiresAt,
      session: sessionConfig(settings, input.instructions, input.tools),
      model: talkLineModel(settings),
      voice: agentId ? '' : settings.voice,
    });
  }

  /**
   * Adds what the line used since it last reported to today's count: a response's tokens, and
   * the seconds and text inputs that are billed. A report with no tokens is the line's clock,
   * not a response.
   */
  async recordUsage(
    model: string,
    tokens: TalkTokens,
    billed: Partial<TalkBilled> = {}
  ): Promise<TalkStatus> {
    const seconds = billed.seconds ?? 0;
    const usd = talkCostUsd(model, { seconds, textInputs: billed.textInputs ?? 0 });
    const response = Object.values(tokens).some((count) => count > 0);
    await this.updateUsage((current) => ({
      ...current,
      usd: current.usd + usd,
      responses: current.responses + (response ? 1 : 0),
      seconds: current.seconds + seconds,
      tokens: {
        textIn: current.tokens.textIn + tokens.textIn,
        cachedTextIn: current.tokens.cachedTextIn + tokens.cachedTextIn,
        audioIn: current.tokens.audioIn + tokens.audioIn,
        cachedAudioIn: current.tokens.cachedAudioIn + tokens.cachedAudioIn,
        textOut: current.tokens.textOut + tokens.textOut,
        audioOut: current.tokens.audioOut + tokens.audioOut,
      },
    }));
    return this.status();
  }

  private async usageToday(): Promise<TalkUsage> {
    const usage = await this.usage.read();
    return usage.day === today() ? usage : emptyUsage();
  }

  /** One writer at a time, each from today's record, so two responses cannot lose a count. */
  private updateUsage(change: (current: TalkUsage) => TalkUsage): Promise<unknown> {
    this.usageWrites = this.usageWrites
      .catch(() => undefined)
      .then(async () => this.usage.update(change(await this.usageToday())));
    return this.usageWrites;
  }
}

/**
 * The session the provider runs: who it is, what it may call, how it sounds, and how turns are
 * taken. It is the body of the renderer's first `session.update`.
 *
 * With a custom agent, its model, voice and reasoning are left as the agent has them. The rest is
 * sent all the same: the line is the conductor only with Maestro's instructions and tools, and
 * only takes turns and plays audio correctly with Maestro's turn-taking and audio format.
 */
export function sessionConfig(
  settings: TalkSettings,
  instructions: string,
  tools: readonly TalkTool[]
): Record<string, unknown> {
  const own = settings.agentId.trim()
    ? {}
    : { model: settings.model, voice: settings.voice, reasoning: { effort: settings.effort } };
  return {
    ...own,
    instructions,
    // Built-in tools are off unless they are listed, and this list replaces any a custom agent
    // was given, so search is asked for here.
    tools: settings.webSearch ? [...tools, ...SEARCH_TOOLS] : tools,
    // Turns are taken by hand. Grok's server VAD always answers by itself; Maestro decides when a
    // turn is the developer's (the talk key was released, or the words were read and are neither
    // an echo nor noise) and asks for the answer then. The renderer finds where speech starts
    // and stops, and commits each stretch of it.
    turn_detection: { type: null },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: TALK_SAMPLE_RATE },
        // grok-transcribe also streams the transcript as it is spoken.
        transcription: { model: settings.transcriptionModel },
      },
      output: { format: { type: 'audio/pcm', rate: TALK_SAMPLE_RATE } },
    },
  };
}

/** The `value` and `expires_at` of a client secret response, or null when it has none. */
function parseClientSecret(body: string): { value: string; expiresAt: number } | null {
  try {
    const parsed = JSON.parse(body) as { value?: unknown; expires_at?: unknown };
    if (typeof parsed.value !== 'string' || !parsed.value) return null;
    const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : 0;
    return { value: parsed.value, expiresAt };
  } catch {
    return null;
  }
}

function describeFailure(status: number, body: string): TalkError {
  if (status === 401 || status === 403) {
    return { type: 'rejected-key', message: 'The xAI API key was rejected.' };
  }
  if (status === 429) {
    return { type: 'rate-limited', message: 'xAI is rate limited right now.' };
  }
  let detail = '';
  try {
    // The error may be a string, or `{ message }` as on OpenAI's API, which xAI follows.
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
  } catch {
    // A body that is not JSON is reported by status alone.
  }
  return {
    type: 'api-error',
    message: `xAI error ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
  };
}
