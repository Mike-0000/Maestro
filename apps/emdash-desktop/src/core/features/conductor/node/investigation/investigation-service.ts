import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isLocalHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import { err, ok, type Result } from '@emdash/shared';
import { createConcurrencyLimiter } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import { abortableWait } from '@emdash/shared/scheduling';
import { redactReply } from '@core/primitives/agents/api/completion-report';
import {
  INVESTIGATION_LIMITS,
  investigationInputSchema,
  type ConductorSettings,
  type InvestigationError,
  type InvestigationOutcome,
  type InvestigationProgress,
  type InvestigationResult,
  type InvestigatorStatus,
} from '../../api/contract';
import type { ConductorService } from '../conductor-service';
import { scoutModel } from './claude-scout';
import {
  runContainmentSelfTest,
  SelfTestRecord,
  type SelfTestOutcome,
} from './containment-self-test';
import { checkEvidence } from './evidence';
import { scoutEnv } from './scout-env';
import { runScout, type ScoutRun } from './scout-runner';

/**
 * Code checks in the main process: the conductor's `investigate` job. It decides whether a check
 * may run (the setting, the limits, a local folder, a usable Claude Code), runs up to three
 * scouts at once across the app, and hands back answers whose quotes it has looked up itself.
 *
 * It owns no files but the scout's own two under `<dataDir>/scout`. Settings and usage belong to
 * `ConductorService`, which this class reads and writes through.
 */

/** Scouts running at once, across every job and the self-test. */
const MAX_SCOUTS = 3;
const MAX_JOBS_PER_MINUTE = 6;
/** The resolver runs `where` or `which`, so its answer is reused for this long. */
const CLI_PATH_TTL_MS = 60_000;
/** How long a signed-out or unusable CLI keeps code checks marked unavailable. */
const UNAVAILABLE_MS = 10 * 60_000;
const VERIFYING_STEP = 'Verifying Claude Code…';
const NO_CLI = 'Claude Code was not found on this computer.';

/** What the service needs from outside the conductor slice. Built in the node manifest. */
export type InvestigationPorts = {
  /** The absolute path of the Claude Code CLI, or null when there is none. */
  resolveCli(): Promise<string | null>;
  /** The environment the user set for Claude Code in Settings. */
  providerEnv(): Promise<Record<string, string>>;
  /** Turns an id from the renderer into a folder. The renderer never supplies a path. */
  identity: {
    resolve(workspaceId: string): Promise<InvestigationFolder | null>;
    resolveProject(projectId: string): Promise<InvestigationFolder | null>;
  };
};

export type InvestigationFolder = { readonly host: HostRef; readonly path: string };

export type InvestigationJobContext = {
  signal: AbortSignal;
  progress: (progress: InvestigationProgress) => void;
};

export type InvestigationServiceOptions = {
  conductor: Pick<
    ConductorService,
    'readSettings' | 'investigationsToday' | 'recordInvestigations'
  >;
  ports: InvestigationPorts;
  dataDir: string;
  logger: Logger;
  processEnv?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Replaced in tests. */
  runScout?: typeof runScout;
  runSelfTest?: typeof runContainmentSelfTest;
};

/** What one scout needs besides its folder and question. */
type ScoutSetup = {
  cli: string;
  env: Record<string, string>;
  model: string;
  timeoutMs: number;
};

export class InvestigationService {
  private readonly conductor: InvestigationServiceOptions['conductor'];
  private readonly ports: InvestigationPorts;
  private readonly logger: Logger;
  private readonly processEnv: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly runScout: typeof runScout;
  private readonly runSelfTest: typeof runContainmentSelfTest;
  private readonly settingsPath: string;
  private readonly record: SelfTestRecord;
  private readonly slots = createConcurrencyLimiter(MAX_SCOUTS);
  private readonly disposed = new AbortController();

  /** The last answer from the dependency resolver; `path` is null when it found no CLI. */
  private cli: { path: string | null; at: number } | null = null;
  /** Why code checks are unavailable. `until` is null for a failed self-test: no expiry. */
  private mark: { reason: string; until: number | null } | null = null;
  private selfTest: Promise<SelfTestOutcome> | null = null;
  private jobStarts: number[] = [];
  /** Questions counted against today's limit by jobs that have not recorded them yet. */
  private reserved = 0;

  constructor(options: InvestigationServiceOptions) {
    this.conductor = options.conductor;
    this.ports = options.ports;
    this.logger = options.logger;
    this.processEnv = options.processEnv ?? process.env;
    this.now = options.now ?? Date.now;
    this.runScout = options.runScout ?? runScout;
    this.runSelfTest = options.runSelfTest ?? runContainmentSelfTest;
    this.settingsPath = path.join(options.dataDir, 'scout', 'claude-settings.json');
    this.record = new SelfTestRecord(path.join(options.dataDir, 'scout', 'self-test.json'));
  }

  dispose(): void {
    this.disposed.abort();
  }

  /**
   * The conductor's status asks this after every model turn, so it answers from memory and the
   * setting alone. It never starts a process and never calls the resolver.
   */
  investigatorStatus(settings: ConductorSettings): InvestigatorStatus {
    if (!settings.investigations) return { state: 'off', reason: null };
    const mark = this.activeMark();
    if (mark) return { state: 'unavailable', reason: mark.reason };
    if (this.cli && this.cli.path === null) return { state: 'unavailable', reason: NO_CLI };
    return { state: 'ready', reason: null };
  }

  /** A setting changed: a timed mark is dropped, so the next check finds out afresh. */
  settingsChanged(patch: Partial<ConductorSettings>): void {
    const touched = Object.keys(patch).some((key) => key.startsWith('investigat'));
    if (touched && this.mark && this.mark.until !== null) this.mark = null;
  }

  /**
   * "Check again", and the first check after the switch is turned on: forget what was wrong,
   * find the CLI again, and run the containment self-test. The caller then reads the status.
   */
  async recheck(): Promise<void> {
    this.mark = null;
    this.cli = null;
    const settings = await this.conductor.readSettings();
    // Off means nothing leaves this computer, a self-test included.
    if (!settings.investigations) return;
    const cli = await this.cliPath();
    if (!cli) return;
    await this.verify(await this.setup(cli, settings)).catch((error: unknown) => {
      this.logger.warn('conductor: the scout self-test could not run', { error });
    });
  }

  async run(
    input: unknown,
    context: InvestigationJobContext
  ): Promise<Result<InvestigationResult, InvestigationError>> {
    const request = investigationInputSchema.safeParse(input);
    if (!request.success) {
      return err({ type: 'failed', message: 'That code check request was not valid.' });
    }
    const { target, questions } = request.data;

    const settings = await this.conductor.readSettings();
    if (!settings.investigations) {
      return err({ type: 'disabled', message: 'Code checks are turned off in Settings.' });
    }

    const startedAt = this.now();
    this.jobStarts = this.jobStarts.filter((at) => startedAt - at < 60_000);
    if (this.jobStarts.length >= MAX_JOBS_PER_MINUTE) {
      return err({
        type: 'rate-limit',
        message: 'Too many code checks in the last minute. Try again shortly.',
      });
    }
    this.jobStarts.push(startedAt);

    const folder =
      'projectId' in target
        ? await this.ports.identity.resolveProject(target.projectId)
        : await this.ports.identity.resolve(target.workspaceId);
    if (!folder) return err({ type: 'not-found', message: 'That project was not found.' });
    if (!isLocalHostRef(folder.host)) {
      return err({
        type: 'not-local',
        message: 'Code checks only work for projects on this computer.',
      });
    }
    const cwd = folder.path;
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) {
      return err({ type: 'not-found', message: 'The project folder no longer exists.' });
    }

    const marked = this.activeMark();
    if (marked) return err({ type: 'unavailable', message: marked.reason });
    const cli = await this.cliPath();
    if (!cli) return err({ type: 'unavailable', message: NO_CLI });

    const today = await this.conductor.investigationsToday();
    const { investigationsPerDay: perDay, investigationDailyUsd: dailyUsd } = settings;
    if (perDay > 0 && today.count + this.reserved + questions.length > perDay) {
      return err({
        type: 'daily-limit',
        message: "Today's limit on code checks is reached. It can be raised in Settings.",
      });
    }
    if (dailyUsd > 0 && today.costUsd >= dailyUsd) {
      return err({
        type: 'daily-limit',
        message: "Today's spending limit for code checks is reached. It can be raised in Settings.",
      });
    }

    // Reserved until this job records what it asked, so jobs that overlap share one limit.
    this.reserved += questions.length;
    const signal = AbortSignal.any([context.signal, this.disposed.signal]);
    const asked = new Set<number>();
    let costUsd = 0;
    try {
      const setup = await this.setup(cli, settings);
      const attempt = async (): Promise<ScoutRun[]> => {
        const runs = await this.askAll(setup, cwd, questions, signal, context.progress, asked);
        costUsd += runs.reduce((sum, run) => sum + run.costUsd, 0);
        return runs;
      };

      let runs = await attempt();
      if (!signal.aborted && runs.some(isUnverified)) {
        // The CLI is a version with no recorded pass: after it updated itself, most often.
        questions.forEach((_, index) => context.progress({ index, step: VERIFYING_STEP }));
        const verification = this.verify(setup);
        const verified = await abortableWait<SelfTestOutcome | null>({ signal }, (settle) => {
          void verification.then(settle.resolve, settle.reject);
        }).catch((error: unknown) => {
          // This job was cancelled: it only stops waiting, and the self-test runs on.
          if (signal.aborted) return null;
          throw error;
        });
        if (verified === null) return err({ type: 'failed', message: 'The check was cancelled.' });
        if (verified.status !== 'passed') {
          return err({
            type: 'unavailable',
            message:
              verified.status === 'failed'
                ? verified.message
                : `Claude Code could not be verified: ${verified.message}`,
          });
        }
        // Once. The questions are already counted against today's limit.
        runs = await attempt();
      }

      this.noteFailures(runs);
      const outcomes = await Promise.all(
        runs.map((run, index) => toOutcome(questions[index] ?? '', run, cwd))
      );
      return ok({ model: setup.model, folderName: path.basename(cwd), outcomes });
    } finally {
      this.reserved -= questions.length;
      if (asked.size > 0 || costUsd > 0) await this.recordUsage(asked.size, costUsd);
    }
  }

  /** Every question at once, each behind the app-wide limit on running scouts. */
  private async askAll(
    setup: ScoutSetup,
    cwd: string,
    questions: readonly string[],
    jobSignal: AbortSignal,
    progress: InvestigationJobContext['progress'],
    asked: Set<number>
  ): Promise<ScoutRun[]> {
    await this.record.load();
    // One unverified scout stops the rest: none of them may answer on this CLI version.
    const stop = new AbortController();
    const signal = AbortSignal.any([jobSignal, stop.signal]);
    return Promise.all(
      questions.map(async (question, index) => {
        const run = await this.inSlot(signal, () => {
          asked.add(index);
          return this.runScout({
            ...setup,
            cwd,
            question,
            settingsPath: this.settingsPath,
            signal,
            verifiedVersions: this.record.verifiedVersions(),
            onStep: (step) => progress({ index, step }),
          });
        });
        if (isUnverified(run)) stop.abort();
        return run;
      })
    );
  }

  /** Waits its turn, first come first served. A wait that is aborted leaves the queue. */
  private async inSlot(signal: AbortSignal, work: () => Promise<ScoutRun>): Promise<ScoutRun> {
    try {
      return await this.slots.run(signal, work);
    } catch (error) {
      if (!signal.aborted) throw error;
      return {
        status: 'failed',
        reason: 'cancelled',
        message: 'The check was cancelled.',
        costUsd: 0,
        version: null,
        durationMs: 0,
      };
    }
  }

  private async setup(cli: string, settings: ConductorSettings): Promise<ScoutSetup> {
    return {
      cli,
      env: scoutEnv(this.processEnv, await this.ports.providerEnv()),
      model: scoutModel(settings.investigatorModel),
      timeoutMs: settings.investigationTimeoutSec * 1_000,
    };
  }

  /**
   * The containment self-test, one run at a time: callers that arrive while it runs get the same
   * run. It stops only when the service is disposed, never because one job was cancelled.
   */
  private verify(setup: ScoutSetup): Promise<SelfTestOutcome> {
    this.selfTest ??= this.runVerification(setup).finally(() => {
      this.selfTest = null;
    });
    return this.selfTest;
  }

  private async runVerification(setup: ScoutSetup): Promise<SelfTestOutcome> {
    const signal = this.disposed.signal;
    const outcome = await this.runSelfTest((run) =>
      this.inSlot(signal, () =>
        this.runScout({
          ...setup,
          ...run,
          settingsPath: this.settingsPath,
          signal,
          // The version check is off: this is the run that earns a version its pass.
          verifiedVersions: null,
        })
      )
    );
    if (outcome.costUsd > 0) await this.recordUsage(0, outcome.costUsd);
    if (outcome.status === 'passed') {
      this.mark = null;
      await this.record.recordPass(outcome.version).catch((error: unknown) => {
        // The pass still counts until the app closes; it is tested again after that.
        this.logger.warn('conductor: could not save the scout self-test record', { error });
      });
    } else if (outcome.status === 'failed') {
      this.mark = { reason: outcome.message, until: null };
    } else if (outcome.reason === 'not-signed-in' || outcome.reason === 'unsupported-cli') {
      // An unfinished self-test records no failure, but a CLI that is signed out is still that.
      this.markFor(outcome.reason, outcome.message);
    }
    return outcome;
  }

  private noteFailures(runs: readonly ScoutRun[]): void {
    for (const run of runs) {
      if (run.status !== 'failed') continue;
      if (run.reason === 'not-signed-in' || run.reason === 'unsupported-cli') {
        this.markFor(run.reason, run.message);
        return;
      }
    }
  }

  private markFor(reason: 'not-signed-in' | 'unsupported-cli', message: string): void {
    // A failed self-test is the stronger mark and is not replaced by a timed one.
    const failedSelfTest = this.mark !== null && this.mark.until === null;
    if (!failedSelfTest) this.mark = { reason: message, until: this.now() + UNAVAILABLE_MS };
    // The path may be what is wrong, so the next check asks the resolver again.
    if (reason === 'unsupported-cli') this.cli = null;
  }

  private activeMark(): { reason: string } | null {
    if (this.mark && this.mark.until !== null && this.now() >= this.mark.until) this.mark = null;
    return this.mark;
  }

  private async cliPath(): Promise<string | null> {
    if (!this.cli || this.now() - this.cli.at >= CLI_PATH_TTL_MS) {
      const resolved = await this.ports.resolveCli().catch((error: unknown) => {
        this.logger.warn('conductor: could not resolve Claude Code for code checks', { error });
        return null;
      });
      // Only an absolute path is ever run: a bare name would be looked up in the project folder.
      this.cli = { path: resolved && path.isAbsolute(resolved) ? resolved : null, at: this.now() };
    }
    return this.cli.path;
  }

  private async recordUsage(count: number, costUsd: number): Promise<void> {
    await this.conductor.recordInvestigations(count, costUsd).catch((error: unknown) => {
      this.logger.warn('conductor: could not record code check usage', { error });
    });
  }
}

function isUnverified(run: ScoutRun): boolean {
  return run.status === 'failed' && run.reason === 'unverified-version';
}

/**
 * What leaves the main process for one question. Quotes are looked up first and redacted after:
 * a redacted quote would not match its file. Redaction can lengthen text, so the limits are
 * applied again at the end.
 */
async function toOutcome(
  question: string,
  run: ScoutRun,
  cwd: string
): Promise<InvestigationOutcome> {
  if (run.status === 'failed') {
    return {
      status: 'failed',
      question,
      reason: run.reason,
      message: run.message,
      durationMs: run.durationMs,
    };
  }
  const evidence = await checkEvidence(cwd, run.answer.evidence);
  return {
    status: 'answered',
    question,
    answer: redactReply(run.answer.answer).slice(0, INVESTIGATION_LIMITS.answerChars),
    found: run.answer.found,
    evidence: evidence.map((item) => ({
      ...item,
      quote: redactReply(item.quote).slice(0, INVESTIGATION_LIMITS.quoteChars),
    })),
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    denied: run.denials.length,
  };
}
