import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { err, ok, type Result, type Secret } from '@emdash/shared';
import { redactAll, type Logger } from '@emdash/shared/logger';
import type {
  AttentionJudgeInput,
  AttentionVerdict,
} from '@core/primitives/agents/api/attention-judge';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';
import { openRouterChat, OpenRouterError } from '@core/primitives/chorus-host/node/openrouter';
import {
  ATTENTION_MAX_OUTPUT_TOKENS,
  ATTENTION_SYSTEM_PROMPT,
  attentionVerdictPrompt,
  parseAttentionVerdict,
} from '../api/attention-verdict';
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
  type InvestigatorStatus,
  type JevDecision,
  type JevError,
  type TraceEvent,
} from '../api/contract';
import type { JevQuestions } from '../api/jev';
import {
  cachesByBreakpoint,
  fromOpenAiChoice,
  openRouterEffort,
  toOpenAiMessages,
  toOpenAiTools,
} from '../api/openrouter-format';
import {
  applyInstructionChange,
  EMPTY_STANDING_INSTRUCTIONS,
  standingInstructionsBlock,
  standingInstructionsFileSchema,
  type InstructionChange,
  type StandingInstructionsFile,
} from '../api/standing-instructions';
import { CONDUCTOR_SYSTEM_PROMPT } from '../api/system-prompt';
import { conductorToolDefinitions } from '../api/tools';
import { InteractionDiagnostics } from './diagnostics';
import { evaluateWithJev, JevRequestError, type JevVia } from './jev-client';

const LOG_FILE = 'conductor-log.jsonl';
/**
 * Room for a whole agent prompt in a logged action input, so a log review sees exactly what an
 * agent was sent (the log is opt-in, bounded by age, and redacted).
 */
const LOG_ACTION_INPUT_CHARS = 16_000;
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
  return {
    day: today(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    investigations: 0,
    investigationCostUsd: 0,
  };
}

function startsWithAny(model: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

/**
 * Cache the stable prefix: tools render before the system prompt, so a breakpoint on the last
 * tool plus one on the system prompt covers the whole static prefix.
 */
function withCacheBreakpoint(tools: Anthropic.Beta.BetaTool[]): Anthropic.Beta.BetaTool[] {
  const lastTool = tools[tools.length - 1];
  if (lastTool) lastTool.cache_control = { type: 'ephemeral' };
  return tools;
}

/** The code-check tool is sent only while the setting is on. */
const INVESTIGATE_TOOL = 'investigate';
/** A verdict holds an agent's status back while it runs, so it gets seconds, not the usual 90. */
const ATTENTION_TIMEOUT_MS = 8_000;

export class ConductorService {
  private readonly credentials: ChorusCredentials;
  private readonly settings: JsonSettingsFile<ConductorSettings>;
  private readonly usage: JsonSettingsFile<ConductorUsage>;
  /** What the developer told the conductor to do from now on; see standing-instructions.ts. */
  private readonly instructions: JsonSettingsFile<StandingInstructionsFile>;
  private instructionWrites: Promise<void> = Promise.resolve();
  /**
   * Two tool lists, each built once from its own definitions so each carries the breakpoint on
   * its own last tool: without the code-check tool, and with it. Switching the setting starts a
   * new cached prefix, once.
   */
  private readonly tools = withCacheBreakpoint(
    conductorToolDefinitions().filter((tool) => tool.name !== INVESTIGATE_TOOL)
  );
  private readonly toolsWithInvestigate = withCacheBreakpoint(conductorToolDefinitions());
  private client: { key: string; client: Anthropic } | null = null;
  private readonly diagnostics: InteractionDiagnostics;
  private logWrites: Promise<void> = Promise.resolve();
  private usageWrites: Promise<void> = Promise.resolve();
  private investigator: ((settings: ConductorSettings) => InvestigatorStatus) | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: ChorusHostServices,
    private readonly logger: Logger
  ) {
    this.credentials = new ChorusCredentials(host.secrets);
    this.diagnostics = new InteractionDiagnostics(host.dataDir);
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
    this.instructions = JsonSettingsFile.inDir(
      host.dataDir,
      'conductor-instructions.json',
      standingInstructionsFileSchema,
      EMPTY_STANDING_INSTRUCTIONS
    );
  }

  start(): void {
    const prune = () =>
      void this.prune().catch((error: unknown) =>
        this.logger.warn('conductor: diagnostic pruning failed', { error })
      );
    prune();
    this.pruneTimer = setInterval(prune, 60 * 60_000);
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  private async prune(): Promise<void> {
    const settings = await this.settings.read();
    if (!settings.diagnosticHistory) {
      await this.deleteDiagnostics();
    } else {
      await this.readLog(1);
      await this.diagnostics.read({ limit: 1 }, settings.diagnosticDays);
    }
  }

  async status(): Promise<ConductorStatus> {
    const settings = await this.settings.read();
    return {
      configured: (await this.credentials.get(await this.providerCredential())) !== null,
      jevReady: (await this.jevRoute()) !== null,
      jevVia: (await this.jevRoute())?.via ?? null,
      settings,
      usageToday: await this.usageToday(),
      investigator: this.investigator?.(settings) ?? { state: 'off', reason: null },
      instructions: (await this.instructions.read()).entries,
    };
  }

  /**
   * One change to the standing instructions, saved before it is reported. Changes run one after
   * another, so two that overlap cannot lose one. The text is redacted like a log line: a key
   * said aloud by mistake is never written to disk or sent with every later turn.
   */
  adjustInstructions(
    change: InstructionChange
  ): Promise<Result<{ status: ConductorStatus; summary: string }, { message: string }>> {
    const next = this.instructionWrites.then(async () => {
      const result = applyInstructionChange(
        await this.instructions.read(),
        { ...change, ...(change.text === undefined ? {} : { text: redactAll(change.text) }) },
        new Date()
      );
      if (!result.ok) return err({ message: result.message });
      await this.instructions.update(result.file);
      return ok({ status: await this.status(), summary: result.summary });
    });
    this.instructionWrites = next.then(
      () => {},
      () => {}
    );
    return next.catch((error: unknown) => {
      this.logger.warn('conductor: standing instructions could not be saved', { error });
      return err({ message: 'The instruction could not be saved.' });
    });
  }

  /** The block that follows the system prompt, read from memory; '' when nothing is saved. */
  private async standingBlock(): Promise<string> {
    return standingInstructionsBlock((await this.instructions.read()).entries);
  }

  /**
   * Lets the code-check service report its state through `status()`. It needs settings from
   * this class and this class needs its status, so it is attached after both exist. `read` runs
   * after every model turn: it must answer from memory and never start a process.
   */
  attachInvestigator(read: (settings: ConductorSettings) => InvestigatorStatus): void {
    this.investigator = read;
  }

  /** The current settings. This class is the only owner of the settings and usage files. */
  readSettings(): Promise<ConductorSettings> {
    return this.settings.read();
  }

  /** Today's code-check questions and what Claude Code reported they cost. */
  async investigationsToday(): Promise<{ count: number; costUsd: number }> {
    const usage = await this.usageToday();
    return { count: usage.investigations, costUsd: usage.investigationCostUsd };
  }

  /** Adds code-check questions and their reported cost to today's usage. */
  recordInvestigations(count: number, costUsd: number): Promise<void> {
    return this.updateUsage((current) => ({
      ...current,
      investigations: current.investigations + count,
      investigationCostUsd: current.investigationCostUsd + costUsd,
    }));
  }

  async updateSettings(patch: Partial<ConductorSettings>): Promise<ConductorStatus> {
    await this.settings.update(patch);
    if (patch.diagnosticHistory === false) await this.deleteDiagnostics();
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

    const standing = await this.standingBlock();
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
        // The fixed prompt keeps its own breakpoint: standing instructions come after it, so
        // changing them never costs the cached tools and prompt.
        system: [
          { type: 'text', text: CONDUCTOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ...(standing
            ? [
                {
                  type: 'text' as const,
                  text: standing,
                  cache_control: { type: 'ephemeral' as const },
                },
              ]
            : []),
        ],
        tools: this.toolsFor(settings),
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

  /** True when finished turns get a verdict: the setting is on and the model has a key. */
  async attentionEnabled(): Promise<boolean> {
    const settings = await this.settings.read();
    if (!settings.attentionVerdicts) return false;
    return (await this.credentials.get(await this.providerCredential())) !== null;
  }

  /**
   * One short call on the conductor's own provider and model: does the agent that wrote this
   * final reply need the developer? No tools, no history, no conductor prompt. Never throws and
   * resolves null when it cannot answer (off, no key, over budget, an error, an unreadable
   * answer), so the caller keeps its rule-based status.
   */
  async judgeAttention(input: AttentionJudgeInput): Promise<AttentionVerdict | null> {
    const settings = await this.settings.read();
    if (!settings.attentionVerdicts) return null;
    const key = await this.credentials.get(
      settings.provider === 'openrouter' ? 'openrouter' : 'anthropic'
    );
    if (!key) return null;
    const usage = await this.usageToday();
    if (
      settings.dailyTokenBudget > 0 &&
      usage.inputTokens + usage.outputTokens >= settings.dailyTokenBudget
    ) {
      return null;
    }
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: attentionVerdictPrompt(input) },
    ];
    const startedAt = performance.now();
    let verdict: AttentionVerdict | null = null;
    let status = 'answered';
    try {
      let content: Anthropic.Beta.BetaContentBlock[];
      if (settings.provider === 'openrouter') {
        const response = await openRouterChat(
          key,
          {
            model: settings.openrouterModel,
            max_tokens: ATTENTION_MAX_OUTPUT_TOKENS,
            messages: toOpenAiMessages(ATTENTION_SYSTEM_PROMPT, messages),
            // A model that reasons by default must not spend the answer's tokens thinking.
            reasoning: { effort: openRouterEffort('low') },
          },
          { timeoutMs: ATTENTION_TIMEOUT_MS }
        );
        const choice = response.choices?.[0];
        content = choice ? fromOpenAiChoice(choice).content : [];
        await this.recordUsage({
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        });
      } else {
        const response = await this.clientFor(key).beta.messages.create(
          {
            model: settings.model,
            max_tokens: ATTENTION_MAX_OUTPUT_TOKENS,
            system: ATTENTION_SYSTEM_PROMPT,
            messages,
          },
          { timeout: ATTENTION_TIMEOUT_MS, maxRetries: 0 }
        );
        content = response.content;
        await this.recordUsage({
          inputTokens:
            response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        });
      }
      const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      verdict = parseAttentionVerdict(text);
      if (!verdict) status = 'unreadable';
    } catch (error) {
      status = 'failed';
      this.logger.warn('conductor: attention verdict failed', { error });
    }
    void this.appendTrace({
      interactionId: randomUUID(),
      at: new Date().toISOString(),
      kind: 'model',
      ...(verdict?.reason ? { text: verdict.reason } : {}),
      detail: {
        purpose: 'attention',
        status,
        ms: Math.round(performance.now() - startedAt),
        conversationId: input.conversationId,
        needsDeveloper: verdict?.needsDeveloper ?? null,
      },
    }).catch(() => {});
    return verdict;
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

  /** The model sees the code-check tool only while the setting is on. */
  private toolsFor(settings: ConductorSettings): Anthropic.Beta.BetaTool[] {
    return settings.investigations ? this.toolsWithInvestigate : this.tools;
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
        messages: toOpenAiMessages(CONDUCTOR_SYSTEM_PROMPT, messages, {
          cacheSystem: cachesByBreakpoint(settings.openrouterModel),
          standing: await this.standingBlock(),
        }),
        tools: toOpenAiTools(this.toolsFor(settings)),
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

  private enqueueLog<T>(work: () => Promise<T>): Promise<T> {
    const next = this.logWrites.then(work, work);
    this.logWrites = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  async appendLog(record: ConductorTurnRecord): Promise<void> {
    // Legacy HUD summaries follow the same opt-in policy as detailed traces.
    return this.enqueueLog(async () => {
      const settings = await this.settings.read();
      if (!settings.diagnosticHistory) return;
      const records = await this.loadLog(settings.diagnosticDays);
      const bounded = {
        ...record,
        utterance: record.utterance.slice(0, 4000),
        reply: record.reply.slice(0, 4000),
        actions: record.actions.slice(0, 20).map((action) => ({
          ...action,
          input: JSON.stringify(action.input)?.slice(0, LOG_ACTION_INPUT_CHARS) ?? null,
          outcome: action.outcome.slice(0, 4000),
        })),
      };
      records.push(conductorTurnRecordSchema.parse(JSON.parse(redactAll(JSON.stringify(bounded)))));
      await this.saveLog(records);
    });
  }

  async readLog(limit: number): Promise<ConductorTurnRecord[]> {
    return this.enqueueLog(async () => {
      const settings = await this.settings.read();
      if (!settings.diagnosticHistory) return [];
      const records = await this.loadLog(settings.diagnosticDays);
      await this.saveLog(records);
      return records
        .slice(-limit)
        .map((record) =>
          conductorTurnRecordSchema.parse(JSON.parse(redactAll(JSON.stringify(record))))
        );
    });
  }

  async appendTrace(event: TraceEvent): Promise<void> {
    const settings = await this.settings.read();
    if (settings.diagnosticHistory) await this.diagnostics.append(event, settings.diagnosticDays);
  }

  async readTrace(query: {
    interactionId?: string;
    since?: string;
    before?: string;
    limit: number;
  }): Promise<TraceEvent[]> {
    const settings = await this.settings.read();
    if (!settings.diagnosticHistory) return [];
    return this.diagnostics.read(query, settings.diagnosticDays);
  }

  async deleteDiagnostics(): Promise<void> {
    await this.diagnostics.delete();
    await this.enqueueLog(async () => {
      await rm(join(this.host.dataDir, LOG_FILE), { force: true });
      await rm(join(this.host.dataDir, LOG_FILE + '.tmp'), { force: true });
    });
  }

  private async loadLog(days: number): Promise<ConductorTurnRecord[]> {
    const path = join(this.host.dataDir, LOG_FILE);
    if (((await stat(path).catch(() => null))?.size ?? 0) > 4 * 1024 * 1024) return [];
    const raw = await readFile(path, 'utf8').catch(() => '');
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return raw.split('\n').flatMap((line) => {
      try {
        const parsed = conductorTurnRecordSchema.safeParse(JSON.parse(line));
        return parsed.success && parsed.data.at >= cutoff ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  private async saveLog(records: ConductorTurnRecord[]): Promise<void> {
    await mkdir(this.host.dataDir, { recursive: true, mode: 0o700 });
    const lines = records.map((record) => redactAll(JSON.stringify(record)) + '\n');
    let size = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const bytes = Buffer.byteLength(line);
      if (size + bytes > 2 * 1024 * 1024) break;
      kept.unshift(line);
      size += bytes;
    }
    const path = join(this.host.dataDir, LOG_FILE);
    await writeFile(path + '.tmp', kept.join(''), { encoding: 'utf8', mode: 0o600 });
    await rename(path + '.tmp', path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
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

  private recordUsage(
    turn: Pick<ConductorUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>
  ): Promise<void> {
    return this.updateUsage((current) => ({
      ...current,
      inputTokens: current.inputTokens + turn.inputTokens,
      outputTokens: current.outputTokens + turn.outputTokens,
      cacheReadTokens: current.cacheReadTokens + turn.cacheReadTokens,
    }));
  }

  /**
   * One read-then-write of today's usage. Writers run one after another, so two that overlap
   * cannot lose an update. Each writes the whole of today's record: a patch would be merged over
   * the cached record, and carry yesterday's counts into a new day.
   */
  private updateUsage(change: (current: ConductorUsage) => ConductorUsage): Promise<void> {
    const next = this.usageWrites.then(async () => {
      await this.usage.update(change(await this.usageToday()));
    });
    this.usageWrites = next.then(
      () => {},
      () => {}
    );
    return next;
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
