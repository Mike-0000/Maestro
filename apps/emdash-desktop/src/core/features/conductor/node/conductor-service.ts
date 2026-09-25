import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { err, ok, type Result, type Secret } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';
import { openRouterChat, OpenRouterError } from '@core/primitives/chorus-host/node/openrouter';
import {
  conductorSettingsSchema,
  conductorTurnRecordSchema,
  conductorUsageSchema,
  DEFAULT_CONDUCTOR_SETTINGS,
  type ConductorError,
  type ConductorMode,
  type ConductorSettings,
  type ConductorStatus,
  type ConductorTurnRecord,
  type ConductorTurnResult,
  type ConductorUsage,
  type JevDecision,
  type JevError,
} from '../api/contract';
import type { JevQuestions } from '../api/jev';
import {
  fromOpenAiChoice,
  openRouterEffort,
  toOpenAiMessages,
  toOpenAiTools,
} from '../api/openrouter-format';
import { CONDUCTOR_SYSTEM_PROMPT } from '../api/system-prompt';
import { conductorToolDefinitions } from '../api/tools';
import { evaluateWithJev, JevRequestError, type JevVia } from './jev-client';

const LOG_FILE = 'conductor-log.jsonl';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
/** Models that take adaptive thinking and output_config.effort. */
const ADAPTIVE_MODEL_PREFIXES = [
  'claude-opus-',
  'claude-fable-',
  'claude-sonnet-5',
  'claude-mythos-',
];
/** Models for which the server-side refusal fallback is enabled by default. */
const FALLBACK_MODEL_PREFIXES = ['claude-opus-5', 'claude-fable-5'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): ConductorUsage {
  return { day: today(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

function startsWithAny(model: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

export class ConductorService {
  private readonly credentials: ChorusCredentials;
  private readonly settings: JsonSettingsFile<ConductorSettings>;
  private readonly usage: JsonSettingsFile<ConductorUsage>;
  private readonly tools = conductorToolDefinitions();
  private client: { key: string; client: Anthropic } | null = null;

  constructor(
    private readonly host: ChorusHostServices,
    private readonly logger: Logger
  ) {
    this.credentials = new ChorusCredentials(host.secrets);
    this.settings = JsonSettingsFile.inDir(
      host.dataDir,
      'conductor-settings.json',
      conductorSettingsSchema,
      DEFAULT_CONDUCTOR_SETTINGS
    );
    this.usage = JsonSettingsFile.inDir(
      host.dataDir,
      'conductor-usage.json',
      conductorUsageSchema,
      emptyUsage()
    );
    // Cache the stable prefix: tools render before the system prompt, so a breakpoint on the
    // last tool plus one on the system prompt covers the whole static prefix.
    const lastTool = this.tools[this.tools.length - 1];
    if (lastTool) lastTool.cache_control = { type: 'ephemeral' };
  }

  async status(): Promise<ConductorStatus> {
    return {
      configured: (await this.credentials.get(await this.providerCredential())) !== null,
      jevReady: (await this.jevRoute()) !== null,
      jevVia: (await this.jevRoute())?.via ?? null,
      settings: await this.settings.read(),
      usageToday: await this.usageToday(),
    };
  }

  async updateSettings(patch: Partial<ConductorSettings>): Promise<ConductorStatus> {
    await this.settings.update(patch);
    return this.status();
  }

  async runTurn(
    mode: ConductorMode,
    messages: Anthropic.Beta.BetaMessageParam[]
  ): Promise<Result<ConductorTurnResult, ConductorError>> {
    const settings = await this.settings.read();
    const key = await this.credentials.get(
      settings.provider === 'openrouter' ? 'openrouter' : 'anthropic'
    );
    if (!key) {
      return err({
        type: 'not-configured',
        message:
          settings.provider === 'openrouter'
            ? 'Add an OpenRouter API key in Settings → Voice & Conductor to use the conductor.'
            : 'Add an Anthropic API key in Settings → Voice & Conductor to use the conductor.',
      });
    }
    const usage = await this.usageToday();
    if (
      settings.dailyTokenBudget > 0 &&
      usage.inputTokens + usage.outputTokens >= settings.dailyTokenBudget
    ) {
      return err({
        type: 'budget-exceeded',
        message:
          "Today's conductor token budget is used up. Raise it in Settings → Voice & Conductor.",
      });
    }

    if (settings.provider === 'openrouter')
      return this.runOpenRouterTurn(key, settings, mode, messages);

    const adaptive = startsWithAny(settings.model, ADAPTIVE_MODEL_PREFIXES);
    const withFallback = startsWithAny(settings.model, FALLBACK_MODEL_PREFIXES);
    try {
      const response = await this.clientFor(key).beta.messages.create({
        model: settings.model,
        max_tokens: mode === 'plan' ? 16000 : 4096,
        ...(withFallback
          ? { betas: [FALLBACK_BETA], fallbacks: [{ model: settings.fallbackModel }] }
          : {}),
        ...(adaptive
          ? {
              thinking: { type: 'adaptive' as const },
              output_config: {
                effort: mode === 'plan' ? settings.planEffort : settings.commandEffort,
              },
            }
          : {}),
        system: [
          { type: 'text', text: CONDUCTOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        tools: this.tools,
        messages,
      });
      const turnUsage = {
        inputTokens:
          response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      await this.recordUsage(turnUsage);
      if (response.stop_reason === 'refusal') {
        return err({ type: 'refused', message: 'Claude declined that request.' });
      }
      return ok({
        content: response.content,
        stopReason: response.stop_reason,
        model: response.model,
        usage: turnUsage,
      });
    } catch (error) {
      return err(this.describeError(error));
    }
  }

  /**
   * Which System One endpoint Jev uses and with which key, or null when Jev is off or unkeyed.
   * Auto prefers OpenRouter when the conductor runs on OpenRouter (one key for everything), then
   * whichever key exists.
   */
  private async jevRoute(): Promise<{ via: JevVia; key: Secret<string> } | null> {
    const settings = await this.settings.read();
    if (!settings.jevEnabled) return null;
    const openrouter = await this.credentials.get('openrouter');
    const typesafe = await this.credentials.get('typesafe');
    const order: JevVia[] =
      settings.jevSource === 'openrouter'
        ? ['openrouter']
        : settings.jevSource === 'typesafe'
          ? ['typesafe']
          : settings.provider === 'openrouter'
            ? ['openrouter', 'typesafe']
            : ['typesafe', 'openrouter'];
    for (const via of order) {
      const key = via === 'openrouter' ? openrouter : typesafe;
      if (key) return { via, key };
    }
    return null;
  }

  private async providerCredential(): Promise<'anthropic' | 'openrouter'> {
    return (await this.settings.read()).provider === 'openrouter' ? 'openrouter' : 'anthropic';
  }

  /** The same turn through OpenRouter: translated to chat completions and back to content blocks. */
  private async runOpenRouterTurn(
    key: Secret<string>,
    settings: ConductorSettings,
    mode: ConductorMode,
    messages: Anthropic.Beta.BetaMessageParam[]
  ): Promise<Result<ConductorTurnResult, ConductorError>> {
    try {
      const response = await openRouterChat(key, {
        model: settings.openrouterModel,
        max_tokens: mode === 'plan' ? 16000 : 4096,
        messages: toOpenAiMessages(CONDUCTOR_SYSTEM_PROMPT, messages),
        tools: toOpenAiTools(this.tools),
        reasoning: {
          effort: openRouterEffort(mode === 'plan' ? settings.planEffort : settings.commandEffort),
        },
      });
      const choice = response.choices?.[0];
      if (!choice) return err({ type: 'api-error', message: 'OpenRouter returned no answer.' });
      const usage = response.usage ?? {};
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const turnUsage = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: cached,
      };
      await this.recordUsage(turnUsage);
      const { content, stopReason } = fromOpenAiChoice(choice);
      if (stopReason === 'refusal') {
        return err({ type: 'refused', message: 'The model declined that request.' });
      }
      return ok({
        content,
        stopReason,
        model: response.model ?? settings.openrouterModel,
        usage: turnUsage,
      });
    } catch (error) {
      if (error instanceof OpenRouterError) {
        if (error.kind === 'rejected-key')
          return err({ type: 'not-configured', message: error.message });
        if (error.kind === 'rate-limited')
          return err({ type: 'rate-limited', message: error.message });
        return err({ type: 'api-error', message: error.message });
      }
      this.logger.error('conductor: OpenRouter failure', { error });
      return err({ type: 'api-error', message: 'The OpenRouter request failed.' });
    }
  }

  /** One Jev evaluation. Never throws: routing callers fall back to Claude on any error. */
  async decide(state: unknown, questions: JevQuestions): Promise<Result<JevDecision, JevError>> {
    const settings = await this.settings.read();
    if (!settings.jevEnabled) return err({ type: 'disabled', message: 'Jev is turned off.' });
    const route = await this.jevRoute();
    if (!route) {
      return err({
        type: 'not-configured',
        message:
          'Add an OpenRouter or TypeSafe API key in Settings → Voice & Conductor to use Jev.',
      });
    }
    const startedAt = performance.now();
    try {
      const result = await evaluateWithJev(route.key, state, questions, { via: route.via });
      return ok({
        answers: result.answers,
        model: result.model,
        latencyMs: Math.round(performance.now() - startedAt),
        via: route.via,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      });
    } catch (error) {
      if (error instanceof JevRequestError) {
        if (error.kind === 'rejected-key')
          return err({ type: 'not-configured', message: error.message });
        if (error.kind === 'no-credits') return err({ type: 'api-error', message: error.message });
        return err({ type: error.kind, message: error.message });
      }
      this.logger.warn('conductor: Jev request failed', { error });
      return err({ type: 'api-error', message: 'The Jev request failed.' });
    }
  }

  async appendLog(record: ConductorTurnRecord): Promise<void> {
    await mkdir(this.host.dataDir, { recursive: true });
    await appendFile(join(this.host.dataDir, LOG_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async readLog(limit: number): Promise<ConductorTurnRecord[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.host.dataDir, LOG_FILE), 'utf8');
    } catch {
      return [];
    }
    const records: ConductorTurnRecord[] = [];
    for (const line of raw.split('\n').slice(-limit - 1)) {
      if (!line.trim()) continue;
      try {
        const parsed = conductorTurnRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch {
        // A torn final line from a crash is skipped.
      }
    }
    return records.slice(-limit);
  }

  private clientFor(key: Secret<string>): Anthropic {
    const plaintext = key.expose();
    if (this.client?.key !== plaintext) {
      this.client = { key: plaintext, client: new Anthropic({ apiKey: plaintext, maxRetries: 1 }) };
    }
    return this.client.client;
  }

  private async usageToday(): Promise<ConductorUsage> {
    const usage = await this.usage.read();
    return usage.day === today() ? usage : emptyUsage();
  }

  private async recordUsage(turn: Omit<ConductorUsage, 'day'>): Promise<void> {
    const current = await this.usageToday();
    await this.usage.update({
      day: current.day,
      inputTokens: current.inputTokens + turn.inputTokens,
      outputTokens: current.outputTokens + turn.outputTokens,
      cacheReadTokens: current.cacheReadTokens + turn.cacheReadTokens,
    });
  }

  private describeError(error: unknown): ConductorError {
    if (error instanceof Anthropic.AuthenticationError) {
      return { type: 'not-configured', message: 'The Anthropic API key was rejected.' };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return {
        type: 'rate-limited',
        message: 'Claude is rate limited right now. Try again shortly.',
      };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { type: 'api-error', message: 'Could not reach the Claude API.' };
    }
    if (error instanceof Anthropic.APIError) {
      this.logger.warn('conductor: API error', { status: error.status, message: error.message });
      return {
        type: 'api-error',
        message: `Claude API error ${error.status ?? ''}: ${error.message}`,
      };
    }
    this.logger.error('conductor: unexpected failure', { error });
    return { type: 'api-error', message: error instanceof Error ? error.message : String(error) };
  }
}
