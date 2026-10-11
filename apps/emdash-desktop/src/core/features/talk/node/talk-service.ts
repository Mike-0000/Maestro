import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';
import {
  DEFAULT_TALK_SETTINGS,
  talkSettingsSchema,
  talkUsageSchema,
  type TalkError,
  type TalkSettings,
  type TalkStatus,
  type TalkTool,
  type TalkUsage,
} from '../api/contract';
import { NO_TOKENS, talkCostUsd, type TalkTokens } from '../api/usage';

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const OPEN_TIMEOUT_MS = 15_000;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): TalkUsage {
  return { day: today(), usd: 0, responses: 0, sessions: 0, tokens: NO_TOKENS };
}

/** Effort is a setting of the reasoning realtime models only; older ones reject the field. */
function reasons(model: string): boolean {
  return /^gpt-realtime-(?:[2-9]|\d{2,})/.test(model);
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
      talkSettingsSchema,
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
      hasKey: (await this.credentials.get('openai')) !== null,
      usageToday,
      overBudget: settings.dailyUsd > 0 && usageToday.usd >= settings.dailyUsd,
    };
  }

  async updateSettings(patch: Partial<TalkSettings>): Promise<TalkStatus> {
    await this.settings.update(patch);
    return this.status();
  }

  /**
   * Forwards the renderer's WebRTC offer to the provider together with the session it should
   * run, and returns the provider's answer. The key is used here and nowhere else.
   */
  async openCall(input: {
    sdp: string;
    instructions: string;
    tools: readonly TalkTool[];
  }): Promise<Result<{ sdp: string; model: string; voice: string }, TalkError>> {
    const settings = await this.settings.read();
    if (!settings.enabled) {
      return err({ type: 'disabled', message: 'The talk line is turned off.' });
    }
    const key = await this.credentials.get('openai');
    if (!key) {
      return err({
        type: 'not-configured',
        message: 'Add an OpenAI API key in Settings → Voice & Conductor to use the talk line.',
      });
    }
    const usage = await this.usageToday();
    if (settings.dailyUsd > 0 && usage.usd >= settings.dailyUsd) {
      return err({
        type: 'over-budget',
        message: "Today's talk line limit is used up. Raise it in Settings → Voice & Conductor.",
      });
    }

    const form = new FormData();
    form.set('sdp', input.sdp);
    form.set('session', JSON.stringify(sessionConfig(settings, input.instructions, input.tools)));
    let response: Response;
    try {
      response = await this.request(CALLS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.expose()}` },
        body: form,
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err({
        type: 'unreachable',
        message: timedOut ? 'OpenAI took too long to answer.' : 'Could not reach OpenAI.',
      });
    }
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      this.logger.warn('talk: the provider refused the session', { status: response.status });
      return err(describeFailure(response.status, body));
    }
    await this.updateUsage((current) => ({ ...current, sessions: current.sessions + 1 }));
    return ok({ sdp: body, model: settings.model, voice: settings.voice });
  }

  /** Adds one response's tokens to today's count. */
  async recordUsage(model: string, tokens: TalkTokens): Promise<TalkStatus> {
    const usd = talkCostUsd(model, tokens);
    await this.updateUsage((current) => ({
      ...current,
      usd: current.usd + usd,
      responses: current.responses + 1,
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

/** The session the provider runs: who it is, what it may call, and how turns are taken. */
export function sessionConfig(
  settings: TalkSettings,
  instructions: string,
  tools: readonly TalkTool[]
): Record<string, unknown> {
  return {
    type: 'realtime',
    model: settings.model,
    instructions,
    tools,
    tool_choice: 'auto',
    ...(reasons(settings.model) ? { reasoning: { effort: settings.effort } } : {}),
    audio: {
      input: {
        transcription: { model: settings.transcriptionModel },
        // The provider detects the end of a turn, but never answers by itself: Maestro decides
        // when a turn is the developer's (the talk key was released, or the words were read and
        // are neither an echo nor noise) and asks for the answer then.
        turn_detection: {
          type: 'semantic_vad',
          create_response: false,
          interrupt_response: settings.talkOver,
        },
      },
      output: { voice: settings.voice },
    },
  };
}

function describeFailure(status: number, body: string): TalkError {
  if (status === 401 || status === 403) {
    return { type: 'rejected-key', message: 'The OpenAI API key was rejected.' };
  }
  if (status === 429) {
    return { type: 'rate-limited', message: 'OpenAI is rate limited right now.' };
  }
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
  } catch {
    // A body that is not JSON is reported by status alone.
  }
  return {
    type: 'api-error',
    message: `OpenAI error ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
  };
}
