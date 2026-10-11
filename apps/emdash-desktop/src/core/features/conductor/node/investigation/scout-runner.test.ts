import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecError } from '@emdash/core/services/exec/api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { scoutArgs } from './claude-scout';
import { scoutSettingsContent } from './scout-deny';
import {
  ensureScoutSettings,
  runScout,
  WATCHDOG_GRACE_MS,
  WATCHDOG_STOP_MS,
  type ScoutRunInput,
} from './scout-runner';
import {
  ANSWERED_EVENTS,
  CAPTURED_VERSION,
  DENIED_EVENTS,
  EARLY_EVENT_EVENTS,
  fakeScoutExec,
  FRESH_CONFIG_INIT_EVENT,
  INIT_EVENT,
  NO_RESULT_EVENTS,
  NOT_SIGNED_IN_EVENTS,
  scoutStream,
} from './testing';

/** Any absolute path: the fake exec never runs it. */
const CLI = process.execPath;
const TIMEOUT_MS = 45_000;

let dir: string;
let cwd: string;
let settingsPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scout-runner-'));
  cwd = path.join(dir, 'project');
  settingsPath = path.join(dir, 'scout', 'claude-settings.json');
  await mkdir(cwd, { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function input(overrides: Partial<ScoutRunInput> = {}): ScoutRunInput {
  return {
    cli: CLI,
    env: { PATH: '/usr/bin' },
    cwd,
    question: 'Is there a retry helper in this project?',
    model: 'haiku',
    timeoutMs: TIMEOUT_MS,
    settingsPath,
    signal: new AbortController().signal,
    verifiedVersions: new Set([CAPTURED_VERSION]),
    ...overrides,
  };
}

function timedOut(): ExecError {
  return new ExecError(CLI, [], null, '', `Timed out after ${TIMEOUT_MS}ms`);
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** A child that never exits, as when a kill does not reach it. */
const hang = () => new Promise<void>(() => {});

describe('runScout', () => {
  it('refuses a CLI that is not an absolute path, without starting anything', async () => {
    const fake = fakeScoutExec(async () => {});
    for (const cli of ['claude', 'claude.cmd', './claude', 'bin/claude']) {
      expect(await runScout(input({ cli }), fake)).toMatchObject({
        status: 'failed',
        reason: 'unsupported-cli',
      });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('runs the fixed command with the question on standard input', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(ANSWERED_EVENTS));
    });
    const run = await runScout(input({ model: 'sonnet' }), fake);

    expect(run).toMatchObject({
      status: 'answered',
      version: CAPTURED_VERSION,
      denials: [],
      answer: { found: 'yes', evidence: [{ path: 'src\\retry.ts', line: 1 }, { line: 4 }] },
    });
    expect(run.costUsd).toBeCloseTo(0.00198633);
    const [call] = fake.calls;
    expect(fake.calls).toHaveLength(1);
    expect(call?.file).toBe(CLI);
    expect(call?.cwd).toBe(cwd);
    expect(call?.env).toEqual({ PATH: '/usr/bin' });
    expect(call?.args).toEqual(scoutArgs({ model: 'sonnet', settingsPath }));
    expect(call?.args.join(' ')).not.toContain('retry helper');
    expect(call?.options.input).toContain('Question: Is there a retry helper in this project?');
    expect(call?.options).toMatchObject({
      timeoutMs: TIMEOUT_MS,
      windowsHide: true,
      killSignal: 'SIGKILL',
    });
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('writes the deny list before the run and puts back a file that was changed', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      // The file is in place by the time the process starts.
      expect(await readFile(settingsPath, 'utf8')).toBe(scoutSettingsContent());
      emit(scoutStream(ANSWERED_EVENTS));
    });
    await rm(settingsPath, { force: true });
    expect((await runScout(input(), fake)).status).toBe('answered');

    await writeFile(settingsPath, '{ "permissions": { "allow": ["Read(**)"] } }');
    expect((await runScout(input(), fake)).status).toBe('answered');
    expect(await readFile(settingsPath, 'utf8')).toBe(scoutSettingsContent());
  });

  it('does not start when the settings file cannot be written', async () => {
    const blocker = path.join(dir, 'not-a-folder');
    await writeFile(blocker, 'a file where a folder is needed');
    const fake = fakeScoutExec(async () => {});
    const unwritable = path.join(blocker, 'claude-settings.json');

    expect(await ensureScoutSettings(unwritable)).toBe(false);
    expect(await runScout(input({ settingsPath: unwritable }), fake)).toMatchObject({
      status: 'failed',
      reason: 'preflight',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('reports steps, at most two a second, and every chunk of output', async () => {
    const steps: string[] = [];
    const output: string[] = [];
    let clock = 1_000;
    const stream = scoutStream(ANSWERED_EVENTS);
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(stream.slice(0, 700));
      emit(stream.slice(700));
    });
    // Three tool calls: the first two arrive 100 ms apart, the third a second later.
    const times = [1_000, 1_000, 1_100, 2_100, 2_100];
    await runScout(
      input({ onStep: (step) => steps.push(step), onOutput: (chunk) => output.push(chunk) }),
      { ...fake, now: () => (clock = times.shift() ?? clock) }
    );
    expect(steps).toEqual([
      'Searching for (?i)\\b(retry|retries|withRetry|retryWith|backoff)\\b',
      'Reading retry.ts',
    ]);
    expect(output.join('')).toBe(stream);
  });

  it('carries the refused reads of an answered run', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(DENIED_EVENTS));
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'answered',
      denials: [
        { tool: 'Read', path: 'C:\\work\\project\\.env' },
        { tool: 'Read', path: 'C:\\work\\outside.txt' },
      ],
    });
  });

  it('lets a result decide even when the process then exits with an error', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(NOT_SIGNED_IN_EVENTS));
      throw new ExecError(CLI, [], 1, '', '');
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'not-signed-in',
      version: CAPTURED_VERSION,
    });
  });

  it('stops a run whose start does not match, naming what differed', async () => {
    const continued: boolean[] = [];
    const fake = fakeScoutExec(async (_call, emit) => {
      continued.push(emit(scoutStream([FRESH_CONFIG_INIT_EVENT])));
      // Whatever the process manages to print before it dies is ignored.
      continued.push(emit(scoutStream(ANSWERED_EVENTS.slice(1))));
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'preflight',
      message: 'Claude Code started in permission mode auto.',
      version: CAPTURED_VERSION,
    });
    expect(continued).toEqual([false, false]);
  });

  it('stops a run that prints anything before its start event', async () => {
    const continued: boolean[] = [];
    const fake = fakeScoutExec(async (_call, emit) => {
      continued.push(emit(scoutStream(EARLY_EVENT_EVENTS)));
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'preflight',
      message: 'Claude Code sent output before it reported how it started.',
    });
    expect(continued).toEqual([false]);
  });

  it('stops a run on a CLI version with no recorded self-test pass', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(ANSWERED_EVENTS));
    });
    expect(await runScout(input({ verifiedVersions: new Set(['2.1.295']) }), fake)).toMatchObject({
      status: 'failed',
      reason: 'unverified-version',
      version: CAPTURED_VERSION,
    });
    // With the check off, as the self-test runs it, the same stream answers.
    expect((await runScout(input({ verifiedVersions: null }), fake)).status).toBe('answered');
  });

  it('checks a second start event too', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream([INIT_EVENT, { ...INIT_EVENT, tools: [...INIT_EVENT.tools, 'Bash'] }]));
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'preflight',
      message: 'Claude Code started with the tool Bash.',
    });
  });

  it('maps the exec timeout to timeout', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(NO_RESULT_EVENTS));
      throw timedOut();
    });
    expect(await runScout(input(), fake)).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('maps an abort to cancelled', async () => {
    const controller = new AbortController();
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream([INIT_EVENT]));
      controller.abort();
      throw abortError();
    });
    expect(await runScout(input({ signal: controller.signal }), fake)).toMatchObject({
      status: 'failed',
      reason: 'cancelled',
    });
  });

  it('does not start once the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeScoutExec(async () => {});
    expect(await runScout(input({ signal: controller.signal }), fake)).toMatchObject({
      status: 'failed',
      reason: 'cancelled',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a failed spawn to an unusable CLI, or a missing folder when that is the cause', async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn' });
    const fake = fakeScoutExec(async () => {
      throw new ExecError(CLI, [], null, '', 'spawn ENOENT', { cause: enoent });
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'unsupported-cli',
      message: 'Claude Code could not be started.',
    });
    expect(await runScout(input({ cwd: path.join(dir, 'gone') }), fake)).toMatchObject({
      status: 'failed',
      reason: 'not-found',
    });
  });

  it('maps a spawn that throws outright the same way', async () => {
    const fake = fakeScoutExec(() => {
      throw Object.assign(new Error('spawn EFTYPE'), { code: 'EFTYPE', syscall: 'spawn' });
    });
    expect(await runScout(input(), fake)).toMatchObject({
      status: 'failed',
      reason: 'unsupported-cli',
    });
  });

  it('asks for an update when the CLI does not know an option', async () => {
    const fake = fakeScoutExec(async () => {
      throw new ExecError(CLI, [], 1, '', "error: unknown option '--restricted'\n");
    });
    expect(await runScout(input(), fake)).toEqual({
      status: 'failed',
      reason: 'unsupported-cli',
      message: 'This Claude Code is too old for code checks. Update Claude Code.',
      costUsd: 0,
      version: null,
      durationMs: expect.any(Number),
    });
  });

  it('reports bad output when the process ends without a result', async () => {
    const quiet = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(NO_RESULT_EVENTS));
    });
    expect(await runScout(input(), quiet)).toMatchObject({
      status: 'failed',
      reason: 'bad-output',
      version: CAPTURED_VERSION,
    });

    const crashed = fakeScoutExec(async () => {
      throw new ExecError(CLI, [], 3, '', 'fatal: token=abc123 was rejected\nstack line');
    });
    expect(await runScout(input(), crashed)).toMatchObject({
      status: 'failed',
      reason: 'bad-output',
      message:
        'Claude Code exited without a result: fatal: token=[REDACTED] was rejected stack line',
    });
  });

  it('reads a result that ends the stream without a line break', async () => {
    const fake = fakeScoutExec(async (_call, emit) => {
      emit(scoutStream(ANSWERED_EVENTS).trimEnd());
    });
    expect((await runScout(input(), fake)).status).toBe('answered');
  });
});

describe('runScout watchdog', () => {
  /** Resolves once the fake process has been started, which is after the real file work. */
  function hanging(onStart: (emit: (chunk: string) => boolean) => void = () => {}) {
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = fakeScoutExec((_call, emit) => {
      onStart(emit);
      started();
      return hang();
    });
    return { fake, ready };
  }

  it('settles as a timeout when the process outlives its limit and the kill', async () => {
    vi.useFakeTimers();
    const { fake, ready } = hanging();
    const run = runScout(input(), fake);
    await ready;

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + WATCHDOG_GRACE_MS - 1);
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('settles as cancelled three seconds after an abort the process ignores', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fake, ready } = hanging();
    const run = runScout(input({ signal: controller.signal }), fake);
    await ready;

    controller.abort();
    await vi.advanceTimersByTimeAsync(WATCHDOG_STOP_MS);
    expect(await run).toMatchObject({ status: 'failed', reason: 'cancelled' });
  });

  it('settles as a refused start three seconds after a kill that did not land', async () => {
    vi.useFakeTimers();
    const { fake, ready } = hanging((emit) => {
      emit(scoutStream([{ ...INIT_EVENT, permissionMode: 'bypassPermissions' }]));
    });
    const run = runScout(input(), fake);
    await ready;

    await vi.advanceTimersByTimeAsync(WATCHDOG_STOP_MS);
    expect(await run).toMatchObject({
      status: 'failed',
      reason: 'preflight',
      message: 'Claude Code started in permission mode bypassPermissions.',
    });
  });

  it('keeps an answer that arrived before the process hung', async () => {
    vi.useFakeTimers();
    const { fake, ready } = hanging((emit) => {
      emit(scoutStream(ANSWERED_EVENTS));
    });
    const run = runScout(input(), fake);
    await ready;

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + WATCHDOG_GRACE_MS);
    expect((await run).status).toBe('answered');
  });
});
