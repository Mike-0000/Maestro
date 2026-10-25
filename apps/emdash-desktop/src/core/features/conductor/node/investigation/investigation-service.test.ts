import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONDUCTOR_SETTINGS,
  investigationResultSchema,
  type ConductorSettings,
  type InvestigationInput,
  type InvestigationProgress,
} from '../../api/contract';
import { SCOUT_PROFILE, type SelfTestOutcome, type SelfTestScout } from './containment-self-test';
import {
  InvestigationService,
  mirroredWindowsPath,
  type InvestigationFolder,
  type ScoutMirror,
} from './investigation-service';
import type { FolderCheckOptions } from './scout-folders';
import type { ScoutRun, ScoutRunInput } from './scout-runner';

const VERSION = '2.1.296';
const CLI = process.execPath;
const RETRY_LINE = 'export function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {';
const QUESTION = 'Is there a retry helper in this project?';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function answered(overrides: Partial<Extract<ScoutRun, { status: 'answered' }>> = {}): ScoutRun {
  return {
    status: 'answered',
    answer: {
      answer: 'Yes, `retry` in src/retry.ts.',
      found: 'yes',
      evidence: [{ path: 'src/retry.ts', line: 1, quote: RETRY_LINE }],
    },
    denials: [],
    costUsd: 0.002,
    version: VERSION,
    durationMs: 9_000,
    ...overrides,
  };
}

function failed(
  reason: Extract<ScoutRun, { status: 'failed' }>['reason'],
  message = `failed: ${reason}`
): ScoutRun {
  return { status: 'failed', reason, message, costUsd: 0, version: VERSION, durationMs: 1_000 };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let dir: string;
let project: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scout-service-'));
  project = path.join(dir, 'checkout');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'retry.ts'), `${RETRY_LINE}\n}\n`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Marks the CLI version as already verified, as after an earlier self-test. */
async function verified(): Promise<void> {
  await mkdir(path.join(dir, 'scout'), { recursive: true });
  await writeFile(
    path.join(dir, 'scout', 'self-test.json'),
    JSON.stringify({ profile: SCOUT_PROFILE, passed: { [VERSION]: '2026-10-10T00:00:00.000Z' } })
  );
}

function harness(
  settingsOverrides: Partial<ConductorSettings> = {},
  folderOptions?: FolderCheckOptions
) {
  const state = {
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, investigations: true, ...settingsOverrides },
    usage: { count: 0, costUsd: 0 },
    clock: 1_000_000,
    cli: CLI as string | null,
    folders: {
      project: { workspaceId: 'w-project', host: LOCAL_HOST_REF, path: project },
      workspace: { workspaceId: 'workspace', host: LOCAL_HOST_REF, path: project },
      remote: { workspaceId: 'w-remote', host: hostRef('remote', 'ssh-1'), path: '/srv/app' },
      wsl: {
        workspaceId: 'w-wsl',
        host: hostRef('remote', 'wsl-1'),
        path: '/home/dev/emdash/repositories/app',
      },
      deleted: { workspaceId: 'w-deleted', host: LOCAL_HOST_REF, path: path.join(dir, 'deleted') },
    } as Record<string, InvestigationFolder>,
    mirrors: [] as ScoutMirror[],
    selfTest: { status: 'passed', version: VERSION, costUsd: 0.003 } as SelfTestOutcome,
  };
  const conductor = {
    readSettings: vi.fn(async () => state.settings),
    investigationsToday: vi.fn(async () => ({ ...state.usage })),
    recordInvestigations: vi.fn(async (count: number, costUsd: number) => {
      state.usage.count += count;
      state.usage.costUsd += costUsd;
    }),
  };
  const ports = {
    resolveCli: vi.fn(async () => state.cli),
    providerEnv: vi.fn(async () => ({ ANTHROPIC_BASE_URL: 'https://corp.example' })),
    identity: {
      resolve: vi.fn(async (id: string) => state.folders[id] ?? null),
      resolveProject: vi.fn(async (id: string) => state.folders[id] ?? null),
    },
    wslMirrors: vi.fn(async () => state.mirrors),
  };
  // Like the real runner: a version with no recorded pass does not get to answer.
  const runScout = vi.fn(async (input: ScoutRunInput): Promise<ScoutRun> => {
    if (input.verifiedVersions && !input.verifiedVersions.has(VERSION)) {
      return failed('unverified-version');
    }
    return answered();
  });
  const runSelfTest = vi.fn(async (scout: SelfTestScout): Promise<SelfTestOutcome> => {
    await scout({
      cwd: project,
      question: 'self-test question',
      extraFolders: [],
      onOutput: () => {},
    });
    return state.selfTest;
  });
  const service = new InvestigationService({
    conductor,
    ports,
    dataDir: dir,
    logger,
    processEnv: { PATH: '/usr/bin', EMDASH_HOOK_PORT: '49152', OPENAI_API_KEY: 'sk-test' },
    now: () => state.clock,
    runScout,
    runSelfTest,
    folderOptions,
  });
  const progress: InvestigationProgress[] = [];
  const run = (
    input: Partial<InvestigationInput> = {},
    signal: AbortSignal = new AbortController().signal
  ) =>
    service.run(
      { target: { projectId: 'project' }, questions: [QUESTION], ...input },
      { signal, progress: (step) => progress.push(step) }
    );
  return { service, state, conductor, ports, runScout, runSelfTest, progress, run };
}

describe('InvestigationService.run', () => {
  it('refuses while the setting is off, before anything else', async () => {
    const h = harness({ investigations: false });
    expect(await h.run()).toEqual({
      success: false,
      error: { type: 'disabled', message: 'Code checks are turned off in Settings.' },
    });
    expect(h.ports.identity.resolveProject).not.toHaveBeenCalled();
    expect(h.ports.resolveCli).not.toHaveBeenCalled();
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('refuses a request the contract would not accept', async () => {
    const h = harness();
    for (const questions of [[], ['short'], Array.from({ length: 4 }, () => QUESTION)]) {
      expect(await h.run({ questions })).toMatchObject({
        success: false,
        error: { type: 'failed' },
      });
    }
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('resolves a project or a workspace by id, and reports one that is not there', async () => {
    await verified();
    const h = harness();
    expect((await h.run({ target: { projectId: 'project' } })).success).toBe(true);
    expect((await h.run({ target: { workspaceId: 'workspace' } })).success).toBe(true);
    expect(h.ports.identity.resolveProject).toHaveBeenCalledWith('project');
    expect(h.ports.identity.resolve).toHaveBeenCalledWith('workspace');

    expect(await h.run({ target: { projectId: 'unknown' } })).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    expect(await h.run({ target: { workspaceId: 'deleted' } })).toMatchObject({
      success: false,
      error: { type: 'not-found', message: 'The project folder no longer exists.' },
    });
    expect(h.runScout).toHaveBeenCalledTimes(2);
  });

  it('reads a WSL project through the Windows folder its mirror keeps the same', async () => {
    await verified();
    const h = harness();
    h.state.mirrors = [
      {
        machineId: 'wsl-1',
        linuxPath: '/home/dev/emdash/repositories/app',
        windowsPath: project,
        seeded: true,
      },
    ];
    const result = await h.run({ target: { projectId: 'wsl' } });
    expect(result).toMatchObject({ success: true, data: { source: 'windows-copy' } });
    expect(h.runScout).toHaveBeenCalledWith(expect.objectContaining({ cwd: project }));
  });

  it('refuses a project on a network share on Windows, before touching the folder', async () => {
    await verified();
    const h = harness({}, { platform: 'win32' });
    for (const share of [
      '\\\\10.0.0.5\\c\\Program Files (x86)\\Steam\\steamapps\\common\\ACE COMBAT 8',
      '//10.0.0.5/c/Games',
      '\\\\?\\UNC\\10.0.0.5\\c\\Games',
    ]) {
      h.state.folders.project = { workspaceId: 'w-project', host: LOCAL_HOST_REF, path: share };
      expect(await h.run(), share).toEqual({
        success: false,
        error: {
          type: 'not-local',
          message: "Code checks can't read network shares; find_in_project still works.",
        },
      });
    }
    expect(h.runScout).not.toHaveBeenCalled();

    // A folder on this computer still runs, under the same Windows rules.
    h.state.folders.project = { workspaceId: 'w-project', host: LOCAL_HOST_REF, path: project };
    expect((await h.run()).success).toBe(true);
    expect(h.runScout).toHaveBeenCalledWith(expect.objectContaining({ cwd: project }));
  });

  it('does not take a local drive path in extended form for a network share', async () => {
    await verified();
    const h = harness({}, { platform: 'win32' });
    h.state.folders.project = {
      workspaceId: 'w-project',
      host: LOCAL_HOST_REF,
      path: '\\\\?\\C:\\Games\\ACE COMBAT 8',
    };
    // The folder is not on this test machine; what matters is that it was not refused as a share.
    expect(await h.run()).toEqual({
      success: false,
      error: { type: 'not-found', message: 'The project folder no longer exists.' },
    });
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('refuses a WSL project whose mirror has not finished its first copy', async () => {
    const h = harness();
    h.state.mirrors = [
      {
        machineId: 'wsl-1',
        linuxPath: '/home/dev/emdash/repositories/app',
        windowsPath: project,
        seeded: false,
      },
    ];
    expect(await h.run({ target: { projectId: 'wsl' } })).toMatchObject({
      success: false,
      error: { type: 'not-local' },
    });
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('passes the extra folders it accepts, and leaves out the ones it refuses', async () => {
    await verified();
    const notes = path.join(dir, 'notes');
    await mkdir(notes);
    const h = harness({ investigationFolders: [notes, '/', 'relative/folder'] });
    const result = await h.run();
    expect(result).toMatchObject({ success: true, data: { alsoRead: ['notes'] } });
    expect(h.runScout).toHaveBeenCalledWith(
      expect.objectContaining({ extraFolders: [await realpath(notes)] })
    );
  });

  it('refuses a project on a remote host', async () => {
    const h = harness();
    expect(await h.run({ target: { projectId: 'remote' } })).toMatchObject({
      success: false,
      error: { type: 'not-local' },
    });
    expect(h.ports.resolveCli).not.toHaveBeenCalled();
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('is unavailable without an absolute CLI path', async () => {
    const h = harness();
    h.state.cli = null;
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'unavailable' } });
    h.state.cli = 'claude';
    h.state.clock += 60_000;
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'unavailable' } });
    expect(h.runScout).not.toHaveBeenCalled();
  });

  it('counts questions against the daily limit, where 0 is no limit', async () => {
    await verified();
    const h = harness({ investigationsPerDay: 4 });
    expect((await h.run({ questions: [QUESTION, QUESTION, QUESTION] })).success).toBe(true);
    expect(h.state.usage.count).toBe(3);
    expect(await h.run({ questions: [QUESTION, QUESTION] })).toMatchObject({
      success: false,
      error: { type: 'daily-limit' },
    });
    expect((await h.run({ questions: [QUESTION] })).success).toBe(true);
    expect(h.state.usage.count).toBe(4);
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'daily-limit' } });

    h.state.settings = { ...h.state.settings, investigationsPerDay: 0 };
    expect((await h.run()).success).toBe(true);
  });

  it('holds questions that are running against the limit of a job that overlaps', async () => {
    await verified();
    const h = harness({ investigationsPerDay: 3 });
    const gate = deferred<ScoutRun>();
    h.runScout.mockImplementationOnce(() => gate.promise);
    const first = h.run({ questions: [QUESTION, QUESTION] });
    await vi.waitFor(() => expect(h.runScout).toHaveBeenCalled());

    // Nothing is recorded yet, but two of the three are spoken for.
    expect(await h.run({ questions: [QUESTION, QUESTION] })).toMatchObject({
      success: false,
      error: { type: 'daily-limit' },
    });
    gate.resolve(answered());
    expect((await first).success).toBe(true);
    expect((await h.run()).success).toBe(true);
  });

  it('stops at the daily cost limit, where 0 is no limit', async () => {
    await verified();
    const h = harness({ investigationDailyUsd: 2 });
    h.state.usage.costUsd = 1.99;
    expect((await h.run()).success).toBe(true);
    h.state.usage.costUsd = 2;
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'daily-limit' } });
    h.state.settings = { ...h.state.settings, investigationDailyUsd: 0 };
    expect((await h.run()).success).toBe(true);
  });

  it('refuses a seventh job within a minute', async () => {
    await verified();
    const h = harness();
    for (let job = 0; job < 6; job += 1) {
      h.state.clock += 1_000;
      expect((await h.run()).success, `job ${job + 1}`).toBe(true);
    }
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'rate-limit' } });
    h.state.clock += 55_000;
    expect((await h.run()).success).toBe(true);
  });

  it('returns each question as answered or failed, with quotes looked up and text redacted', async () => {
    await verified();
    const h = harness({ investigatorModel: 'sonnet', investigationTimeoutSec: 30 });
    h.runScout
      .mockResolvedValueOnce(
        answered({
          answer: {
            answer: 'It reads `api_key=sk-ant-REDACTME-0123456789abcdefghij` from the config.',
            found: 'yes',
            evidence: [
              { path: 'src/retry.ts', line: 1, quote: RETRY_LINE },
              { path: 'src/retry.ts', line: 9, quote: 'export function retryForever() {' },
              { path: '../outside.ts', quote: RETRY_LINE },
            ],
          },
          denials: [{ tool: 'Read', path: '.env' }],
        })
      )
      .mockResolvedValueOnce(failed('timeout', 'The check ran out of time.'))
      .mockImplementationOnce(async (input) => {
        input.onStep?.('Reading retry.ts');
        return answered({ costUsd: 0.004 });
      });

    const result = await h.run({
      questions: ['Where is the API key read?', 'Which tests cover uploads?', QUESTION],
    });

    expect(result).toEqual({
      success: true,
      data: {
        model: 'sonnet',
        folderName: 'checkout',
        outcomes: [
          {
            status: 'answered',
            question: 'Where is the API key read?',
            answer: 'It reads `api_key=[REDACTED] from the config.',
            found: 'yes',
            evidence: [
              { path: 'src/retry.ts', line: 1, quote: RETRY_LINE, found: true },
              {
                path: 'src/retry.ts',
                line: 9,
                quote: 'export function retryForever() {',
                found: false,
              },
              { path: '../outside.ts', quote: RETRY_LINE, found: false },
            ],
            durationMs: 9_000,
            costUsd: 0.002,
            denied: 1,
          },
          {
            status: 'failed',
            question: 'Which tests cover uploads?',
            reason: 'timeout',
            message: 'The check ran out of time.',
            durationMs: 1_000,
          },
          expect.objectContaining({ status: 'answered', question: QUESTION, denied: 0 }),
        ],
      },
    });
    expect(h.progress).toEqual([{ index: 2, step: 'Reading retry.ts' }]);
    expect(h.conductor.recordInvestigations).toHaveBeenCalledTimes(1);
    expect(h.state.usage.count).toBe(3);
    expect(h.state.usage.costUsd).toBeCloseTo(0.006);
    // The renderer checks the result against the contract and rejects one that does not fit.
    expect(investigationResultSchema.safeParse(result.success && result.data).success).toBe(true);
  });

  it('keeps every field within the contract when redaction makes text longer', async () => {
    await verified();
    const h = harness();
    // Each `password=x` becomes `password=[REDACTED]`, nine characters more.
    const answer = 'password=x '.repeat(136).trim();
    const quote = 'token=a '.repeat(25).trim();
    h.runScout.mockResolvedValueOnce(
      answered({
        answer: { answer, found: 'unsure', evidence: [{ path: 'src/retry.ts', quote }] },
      })
    );

    const result = await h.run();
    const [outcome] = result.success ? result.data.outcomes : [];
    expect(answer.length).toBeLessThanOrEqual(1_500);
    expect(outcome).toMatchObject({ status: 'answered' });
    if (outcome?.status !== 'answered') return;
    expect(outcome.answer).toHaveLength(1_500);
    expect(outcome.answer).not.toContain('password=x');
    expect(outcome.evidence[0]?.quote).toHaveLength(200);
    expect(outcome.evidence[0]?.quote).not.toContain('token=a');
    expect(investigationResultSchema.safeParse(result.success && result.data).success).toBe(true);
  });

  it('starts each scout with the resolved folder, a narrowed environment, and the limits', async () => {
    await verified();
    const h = harness({ investigatorModel: 'haiku --add-dir /', investigationTimeoutSec: 20 });
    await h.run();
    const [input] = h.runScout.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      cli: CLI,
      cwd: project,
      question: QUESTION,
      // Not a plain model name, so the default is used.
      model: 'haiku',
      timeoutMs: 20_000,
      settingsPath: path.join(dir, 'scout', 'claude-settings.json'),
    });
    expect(input?.verifiedVersions?.has(VERSION)).toBe(true);
    expect(input?.env).toMatchObject({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://corp.example',
    });
    expect(input?.env).not.toHaveProperty('EMDASH_HOOK_PORT');
    expect(input?.env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('runs at most three scouts at once and lets a waiting one leave the queue', async () => {
    await verified();
    const h = harness();
    const gates = [deferred<ScoutRun>(), deferred<ScoutRun>(), deferred<ScoutRun>()];
    let started = 0;
    h.runScout.mockImplementation(() => gates[started++]?.promise ?? Promise.resolve(answered()));

    const first = h.run({ questions: [QUESTION, QUESTION, QUESTION] });
    await vi.waitFor(() => expect(h.runScout).toHaveBeenCalledTimes(3));
    const waiting = new AbortController();
    const second = h.run({ questions: ['Which tests cover uploads?'] }, waiting.signal);
    // The second job is behind the limit: its scout has not started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.runScout).toHaveBeenCalledTimes(3);

    waiting.abort();
    expect(await second).toMatchObject({
      success: true,
      data: { outcomes: [{ status: 'failed', reason: 'cancelled' }] },
    });
    expect(h.runScout).toHaveBeenCalledTimes(3);
    // It asked nothing, so it adds nothing to today's count.
    expect(h.conductor.recordInvestigations).not.toHaveBeenCalled();

    for (const gate of gates) gate.resolve(answered());
    expect((await first).success).toBe(true);
    expect(h.state.usage.count).toBe(3);
  });

  it('stops running scouts when the job is cancelled or the service is disposed', async () => {
    await verified();
    const h = harness();
    const signals: AbortSignal[] = [];
    h.runScout.mockImplementation(
      (input) =>
        new Promise<ScoutRun>((resolve) => {
          signals.push(input.signal);
          input.signal.addEventListener('abort', () => resolve(failed('cancelled')));
        })
    );
    const job = new AbortController();
    const cancelled = h.run({}, job.signal);
    const disposed = h.run();
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    job.abort();
    expect(await cancelled).toMatchObject({ data: { outcomes: [{ reason: 'cancelled' }] } });
    expect(signals[1]?.aborted).toBe(false);

    h.service.dispose();
    expect(await disposed).toMatchObject({ data: { outcomes: [{ reason: 'cancelled' }] } });
  });
});

describe('InvestigationService and the containment self-test', () => {
  it('verifies an unknown CLI version, then asks the questions again, once', async () => {
    const h = harness();
    const result = await h.run({ questions: [QUESTION, 'Which tests cover uploads?'] });

    expect(result).toMatchObject({
      success: true,
      data: { outcomes: [{ status: 'answered' }, { status: 'answered' }] },
    });
    expect(h.runSelfTest).toHaveBeenCalledTimes(1);
    // Two refused runs, the self-test's own scout with the version check off, two answers.
    const checks = h.runScout.mock.calls.map(([input]) => input.verifiedVersions);
    expect(checks.filter((versions) => versions === null)).toHaveLength(1);
    expect(checks.filter((versions) => versions?.has(VERSION))).toHaveLength(2);
    expect(h.runScout).toHaveBeenCalledTimes(5);
    expect(h.progress).toEqual([
      { index: 0, step: 'Verifying Claude Code…' },
      { index: 1, step: 'Verifying Claude Code…' },
    ]);
    // The questions count once; the self-test adds its cost and no questions.
    expect(h.state.usage.count).toBe(2);
    expect(h.state.usage.costUsd).toBeCloseTo(0.003 + 0.004);
    expect(h.conductor.recordInvestigations).toHaveBeenCalledWith(0, 0.003);

    // The pass is remembered: the next job runs straight away.
    await h.run();
    expect(h.runSelfTest).toHaveBeenCalledTimes(1);
    expect(h.runScout).toHaveBeenCalledTimes(6);
  });

  it('is unavailable after a failed self-test, until a recheck passes', async () => {
    const h = harness();
    h.state.selfTest = {
      status: 'failed',
      version: VERSION,
      message: "Claude Code ran a hook from the project's own settings.",
      costUsd: 0.003,
    };
    expect(await h.run()).toEqual({
      success: false,
      error: {
        type: 'unavailable',
        message: "Claude Code ran a hook from the project's own settings.",
      },
    });
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'unavailable',
      reason: "Claude Code ran a hook from the project's own settings.",
    });

    // It does not expire, and a changed setting does not clear it.
    h.state.clock += 24 * 60 * 60_000;
    h.service.settingsChanged({ investigatorModel: 'sonnet' });
    const scouts = h.runScout.mock.calls.length;
    expect(await h.run()).toMatchObject({ success: false, error: { type: 'unavailable' } });
    expect(h.runScout).toHaveBeenCalledTimes(scouts);

    h.state.selfTest = { status: 'passed', version: VERSION, costUsd: 0.003 };
    await h.service.recheck();
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'ready',
      reason: null,
    });
    expect((await h.run()).success).toBe(true);
  });

  it('learns nothing from a self-test that could not finish', async () => {
    const h = harness();
    h.state.selfTest = {
      status: 'incomplete',
      reason: 'cancelled',
      message: 'The check was cancelled.',
      costUsd: 0,
    };
    expect(await h.run()).toEqual({
      success: false,
      error: {
        type: 'unavailable',
        message: 'Claude Code could not be verified: The check was cancelled.',
      },
    });
    // No mark: the feature is still on offer, and the next job tries again.
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'ready',
      reason: null,
    });
    h.state.selfTest = { status: 'passed', version: VERSION, costUsd: 0.003 };
    expect((await h.run()).success).toBe(true);
    expect(h.runSelfTest).toHaveBeenCalledTimes(2);
  });

  it('marks a signed-out CLI found by the self-test for ten minutes, without a failure', async () => {
    const h = harness();
    h.state.selfTest = {
      status: 'incomplete',
      reason: 'not-signed-in',
      message: 'Claude Code is not signed in.',
      costUsd: 0,
    };
    await h.run();
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'unavailable',
      reason: 'Claude Code is not signed in.',
    });
    h.state.clock += 10 * 60_000;
    expect(h.service.investigatorStatus(h.state.settings).state).toBe('ready');
  });

  it('runs one self-test for jobs that arrive together', async () => {
    const h = harness();
    const gate = deferred<SelfTestOutcome>();
    h.runSelfTest.mockImplementation(() => gate.promise);
    const jobs = [h.run(), h.run(), h.run()];
    await vi.waitFor(() => expect(h.runSelfTest).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve({ status: 'passed', version: VERSION, costUsd: 0.003 });

    for (const job of jobs) expect((await job).success).toBe(true);
    expect(h.runSelfTest).toHaveBeenCalledTimes(1);
  });

  it('lets a cancelled job stop waiting while the self-test runs on', async () => {
    const h = harness();
    const gate = deferred<SelfTestOutcome>();
    h.runSelfTest.mockImplementation(() => gate.promise);
    const job = new AbortController();
    const cancelled = h.run({}, job.signal);
    await vi.waitFor(() => expect(h.runSelfTest).toHaveBeenCalled());

    job.abort();
    expect(await cancelled).toMatchObject({ success: false, error: { type: 'failed' } });

    // The run it started still records its pass.
    gate.resolve({ status: 'passed', version: VERSION, costUsd: 0.003 });
    await vi.waitFor(() => expect(h.conductor.recordInvestigations).toHaveBeenCalledWith(0, 0.003));
    expect((await h.run()).success).toBe(true);
    expect(h.runSelfTest).toHaveBeenCalledTimes(1);
  });

  it('rechecks only while the setting is on', async () => {
    const off = harness({ investigations: false });
    await off.service.recheck();
    expect(off.ports.resolveCli).not.toHaveBeenCalled();
    expect(off.runSelfTest).not.toHaveBeenCalled();

    const on = harness();
    await on.service.recheck();
    expect(on.ports.resolveCli).toHaveBeenCalledTimes(1);
    expect(on.runSelfTest).toHaveBeenCalledTimes(1);
    expect(on.state.usage).toEqual({ count: 0, costUsd: 0.003 });
    expect((await on.run()).success).toBe(true);
    expect(on.runSelfTest).toHaveBeenCalledTimes(1);
  });
});

describe('InvestigationService.investigatorStatus', () => {
  it('never calls the resolver or starts a process', async () => {
    await verified();
    const h = harness();
    for (let turn = 0; turn < 50; turn += 1) {
      expect(h.service.investigatorStatus(h.state.settings)).toEqual({
        state: 'ready',
        reason: null,
      });
      expect(
        h.service.investigatorStatus({ ...h.state.settings, investigations: false }).state
      ).toBe('off');
    }
    expect(h.ports.resolveCli).not.toHaveBeenCalled();
    expect(h.runScout).not.toHaveBeenCalled();
    expect(h.conductor.readSettings).not.toHaveBeenCalled();

    await h.run();
    const resolved = h.ports.resolveCli.mock.calls.length;
    for (let turn = 0; turn < 50; turn += 1) h.service.investigatorStatus(h.state.settings);
    expect(h.ports.resolveCli).toHaveBeenCalledTimes(resolved);
  });

  it('is unavailable once the resolver found no CLI', async () => {
    const h = harness();
    h.state.cli = null;
    await h.run();
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'unavailable',
      reason: 'Claude Code was not found on this computer.',
    });
    expect(h.service.investigatorStatus({ ...h.state.settings, investigations: false })).toEqual({
      state: 'off',
      reason: null,
    });
  });

  it('asks the resolver again only after a minute', async () => {
    await verified();
    const h = harness();
    await h.run();
    h.state.clock += 59_000;
    await h.run();
    expect(h.ports.resolveCli).toHaveBeenCalledTimes(1);
    h.state.clock += 1_000;
    await h.run();
    expect(h.ports.resolveCli).toHaveBeenCalledTimes(2);
  });

  it('marks a signed-out CLI unavailable for ten minutes, or until a setting changes', async () => {
    await verified();
    const h = harness();
    h.runScout.mockResolvedValueOnce(failed('not-signed-in', 'Claude Code is not signed in.'));
    expect(await h.run()).toMatchObject({
      success: true,
      data: { outcomes: [{ status: 'failed', reason: 'not-signed-in' }] },
    });
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'unavailable',
      reason: 'Claude Code is not signed in.',
    });
    h.state.clock += 61_000;
    expect(await h.run()).toEqual({
      success: false,
      error: { type: 'unavailable', message: 'Claude Code is not signed in.' },
    });
    expect(h.runScout).toHaveBeenCalledTimes(1);

    // A setting that has nothing to do with code checks leaves the mark alone.
    h.service.settingsChanged({ jevEnabled: false });
    expect(h.service.investigatorStatus(h.state.settings).state).toBe('unavailable');
    h.service.settingsChanged({ investigatorModel: 'sonnet' });
    expect(h.service.investigatorStatus(h.state.settings).state).toBe('ready');

    h.runScout.mockResolvedValueOnce(failed('not-signed-in', 'Claude Code is not signed in.'));
    h.state.clock += 61_000;
    await h.run();
    h.state.clock += 10 * 60_000 - 1;
    expect(h.service.investigatorStatus(h.state.settings).state).toBe('unavailable');
    h.state.clock += 1;
    expect(h.service.investigatorStatus(h.state.settings).state).toBe('ready');
  });

  it('forgets the CLI path after a run that could not start it', async () => {
    await verified();
    const h = harness();
    h.runScout.mockResolvedValueOnce(
      failed('unsupported-cli', 'Claude Code could not be started.')
    );
    await h.run();
    expect(h.service.investigatorStatus(h.state.settings)).toEqual({
      state: 'unavailable',
      reason: 'Claude Code could not be started.',
    });
    h.service.settingsChanged({ investigations: true });
    h.state.clock += 1_000;
    expect((await h.run()).success).toBe(true);
    // Well inside the minute a path is normally kept for.
    expect(h.ports.resolveCli).toHaveBeenCalledTimes(2);
  });
});

describe('mirroredWindowsPath', () => {
  const mirror: ScoutMirror = {
    machineId: 'wsl-1',
    linuxPath: '/home/dev/repos/app/',
    windowsPath: 'C:\\Github\\app',
    seeded: true,
  };

  it('maps the mirror folder and folders inside it on the same machine', () => {
    expect(mirroredWindowsPath([mirror], 'wsl-1', '/home/dev/repos/app')).toBe('C:\\Github\\app');
    expect(mirroredWindowsPath([mirror], 'wsl-1', '/home/dev/repos/app/src')).toBe(
      'C:\\Github\\app\\src'
    );
  });

  it('maps nothing outside the mirror, on another machine, or before its first copy', () => {
    expect(mirroredWindowsPath([mirror], 'wsl-1', '/home/dev/repos/app-2')).toBeNull();
    expect(mirroredWindowsPath([mirror], 'wsl-1', '/home/dev/repos')).toBeNull();
    expect(mirroredWindowsPath([mirror], 'ssh-1', '/home/dev/repos/app')).toBeNull();
    expect(
      mirroredWindowsPath([{ ...mirror, seeded: false }], 'wsl-1', '/home/dev/repos/app')
    ).toBeNull();
  });
});
