import { createHash } from 'node:crypto';
import { realpath as realpathJs, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBoundExec, ExecError, type BoundExec } from '@emdash/core/services/exec/api';
import { redactReply } from '@core/primitives/agents/api/completion-report';
import type { InvestigationFailureReason } from '../../api/contract';
import {
  checkPreflight,
  oneLine,
  resultFailure,
  sameScoutFolder,
  scoutAnswer,
  scoutArgs,
  scoutPrompt,
  ScoutStreamParser,
  type ScoutAnswer,
  type ScoutDenial,
  type ScoutEvent,
  type ScoutFailure,
  type ScoutResult,
} from './claude-scout';
import { scoutSettingsContent } from './scout-deny';

/**
 * Runs one code scout: Claude Code in print mode, read-only, answering one question about one
 * folder. The process goes through the shared exec helper; this file adds no spawn path of its
 * own. It never throws: every way a run can go wrong comes back as a `failed` run with a reason.
 */

/** How long after the CLI's own time limit the call is settled regardless. */
export const WATCHDOG_GRACE_MS = 5_000;
/** How long after a stop (an abort, or a refused start) the call is settled regardless. */
export const WATCHDOG_STOP_MS = 3_000;
/** At most two progress steps a second reach the caller. */
const STEP_INTERVAL_MS = 500;

export type ScoutExecFactory = (options: {
  file: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Pick<BoundExec, 'execStreaming'>;

export type ScoutRunInput = {
  /** Absolute path to the Claude Code CLI, from the app's dependency resolver. */
  cli: string;
  /** The child's whole environment; see `scoutEnv`. */
  env: Record<string, string>;
  /** The folder the scout reads, resolved by the main process. */
  cwd: string;
  question: string;
  /** Already passed through `scoutModel`. */
  model: string;
  timeoutMs: number;
  /**
   * The scout's settings file. With extra folders, a sibling file named for that set of folders
   * is used instead, so scouts with different folders never share one file.
   */
  settingsPath: string;
  /**
   * Folders outside `cwd` the scout may also read, already checked by `usableScoutFolders`.
   * They reach the CLI through the settings file and the prompt, never the command line.
   */
  extraFolders?: readonly string[];
  signal: AbortSignal;
  /**
   * CLI versions that passed the containment self-test. A run on any other version is stopped
   * as `unverified-version`. Null turns the check off, which only the self-test does.
   */
  verifiedVersions: ReadonlySet<string> | null;
  onStep?: (step: string) => void;
  /** Every chunk of the CLI's standard output, for the containment tests. */
  onOutput?: (chunk: string) => void;
};

type ScoutRunBase = {
  durationMs: number;
  costUsd: number;
  /** The CLI version, once its first event reported one. */
  version: string | null;
};

export type ScoutRun =
  | (ScoutRunBase & {
      status: 'answered';
      /** Cut to fit, with evidence not yet looked up and nothing redacted. */
      answer: ScoutAnswer;
      denials: ScoutDenial[];
    })
  | (ScoutRunBase & { status: 'failed'; reason: InvestigationFailureReason; message: string });

export type ScoutRunnerDeps = {
  exec?: ScoutExecFactory;
  now?: () => number;
  platform?: NodeJS.Platform;
};

const CANCELLED: ScoutFailure = { reason: 'cancelled', message: 'The check was cancelled.' };
const TIMED_OUT: ScoutFailure = { reason: 'timeout', message: 'The check ran out of time.' };
const ELSEWHERE: ScoutFailure = {
  reason: 'preflight',
  message: 'Claude Code started outside the project folder, so the check was stopped.',
};

export async function runScout(
  input: ScoutRunInput,
  deps: ScoutRunnerDeps = {}
): Promise<ScoutRun> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // What the stream has shown so far. The stream handler below fills it in.
  const seen: {
    started: boolean;
    version: string | null;
    refused: ScoutFailure | null;
    result: ScoutResult | null;
  } = { started: false, version: null, refused: null, result: null };
  const failed = (failure: ScoutFailure, costUsd = 0): ScoutRun => ({
    status: 'failed',
    ...failure,
    costUsd,
    version: seen.version,
    durationMs: now() - startedAt,
  });

  // A bare name would be looked up by the system: on Windows, in the project folder first.
  if (!path.isAbsolute(input.cli)) {
    return failed({ reason: 'unsupported-cli', message: 'Claude Code was not found.' });
  }
  if (input.signal.aborted) return failed(CANCELLED);
  const extraFolders = input.extraFolders ?? [];
  const settingsPath = scoutSettingsPath(input.settingsPath, extraFolders);
  if (!(await ensureScoutSettings(settingsPath, extraFolders))) {
    return failed({
      reason: 'preflight',
      message: "The scout's settings file could not be written.",
    });
  }

  const platform = deps.platform ?? process.platform;
  const folders = await folderForms(input.cwd);
  /** The CLI reports the folder it really runs in; it must be the project, or nothing is read. */
  const inProject = (reported: string | null): boolean =>
    sameScoutFolder(reported, folders, platform) ||
    (reported !== null && sameScoutFolder(realFolder(reported), folders, platform));

  const parser = new ScoutStreamParser();
  let lastStepAt = Number.NEGATIVE_INFINITY;

  /** False as soon as the run must stop: the process is then killed. */
  const accept = (events: ScoutEvent[]): boolean => {
    for (const event of events) {
      if (event.kind === 'init') {
        // Checked every time one arrives, so a later event cannot restate how the run started.
        const preflight = checkPreflight(event.init, input.verifiedVersions);
        seen.version = event.init.version;
        if (!preflight.success) {
          seen.refused = preflight.error;
          return false;
        }
        if (!inProject(event.init.cwd)) {
          seen.refused = ELSEWHERE;
          return false;
        }
        seen.started = true;
      } else if (!seen.started) {
        seen.refused = {
          reason: 'preflight',
          message: 'Claude Code sent output before it reported how it started.',
        };
        return false;
      } else if (event.kind === 'step') {
        const at = now();
        if (at - lastStepAt >= STEP_INTERVAL_MS) {
          lastStepAt = at;
          input.onStep?.(event.text);
        }
      } else if (event.kind === 'result') {
        seen.result ??= event.result;
      }
    }
    return true;
  };

  const timers = new Set<ReturnType<typeof setTimeout>>();
  let fire: () => void = () => {};
  const watchdog = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const arm = (ms: number) => {
    timers.add(setTimeout(fire, ms));
  };
  // A kill that fails leaves the process holding its output pipe open, and the exec call then
  // never returns. These settle the run anyway, so nothing can hold the developer's turn.
  arm(input.timeoutMs + WATCHDOG_GRACE_MS);
  const onAbort = () => arm(WATCHDOG_STOP_MS);
  input.signal.addEventListener('abort', onAbort, { once: true });

  const onChunk = (chunk: string): boolean => {
    input.onOutput?.(chunk);
    if (seen.refused) return false;
    if (accept(parser.push(chunk))) return true;
    arm(WATCHDOG_STOP_MS);
    return false;
  };

  const exec = (deps.exec ?? createBoundExec)({ file: input.cli, cwd: input.cwd, env: input.env });
  const execution = Promise.resolve()
    .then(() =>
      exec.execStreaming(scoutArgs({ model: input.model, settingsPath }), onChunk, {
        input: scoutPrompt(input.question, extraFolders),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        windowsHide: true,
        killSignal: 'SIGKILL',
      })
    )
    .then(
      () => ({ kind: 'exited' as const }),
      (error: unknown) => ({ kind: 'threw' as const, error })
    );
  const settled = await Promise.race([
    execution,
    watchdog.then(() => ({ kind: 'watchdog' as const })),
  ]);
  for (const timer of timers) clearTimeout(timer);
  input.signal.removeEventListener('abort', onAbort);
  // A stream that ended without a final line break still holds its last event.
  if (settled.kind !== 'watchdog' && !seen.refused) accept(parser.end());

  if (seen.refused) return failed(seen.refused);
  // A result decides the outcome, even when the process then exited with an error code.
  if (seen.result) {
    const { costUsd, denials } = seen.result;
    const failure = resultFailure(seen.result);
    if (failure) return failed(failure, costUsd);
    const answer = scoutAnswer(seen.result);
    if (!answer) {
      return failed(
        { reason: 'bad-output', message: 'Claude Code finished without an answer.' },
        costUsd
      );
    }
    return {
      status: 'answered',
      answer,
      denials,
      costUsd,
      version: seen.version,
      durationMs: now() - startedAt,
    };
  }
  if (input.signal.aborted) return failed(CANCELLED);
  // The watchdog only gets this far when the time limit passed and the kill did not end the run.
  if (settled.kind === 'watchdog') return failed(TIMED_OUT);
  if (settled.kind === 'threw') return failed(await failureFromError(settled.error, input.cwd));
  return failed({ reason: 'bad-output', message: 'Claude Code ended without a result.' });
}

async function failureFromError(error: unknown, cwd: string): Promise<ScoutFailure> {
  if (error instanceof Error && error.name === 'AbortError') return CANCELLED;
  if (error instanceof ExecError) {
    if (error.stderr.startsWith('Timed out')) return TIMED_OUT;
    if (/unknown option/i.test(error.stderr)) {
      return {
        reason: 'unsupported-cli',
        message: 'This Claude Code is too old for code checks. Update Claude Code.',
      };
    }
    if (/not logged in|please run \/login/i.test(error.stderr)) {
      return {
        reason: 'not-signed-in',
        message: 'Claude Code is not signed in. Run claude in a terminal and sign in.',
      };
    }
    // A cause means the process never started.
    if (error.cause !== undefined) return spawnFailure(cwd);
    const detail = oneLine(redactReply(error.stderr), 160);
    return {
      reason: 'bad-output',
      message: `Claude Code exited without a result${detail ? `: ${detail}` : '.'}`,
    };
  }
  // spawn also throws outright, before the helper can wrap it: a file that is not a program.
  if (isSpawnError(error)) return spawnFailure(cwd);
  return { reason: 'crashed', message: 'The check could not be run.' };
}

/** The process did not start: either the folder is gone, or the CLI at that path is. */
async function spawnFailure(cwd: string): Promise<ScoutFailure> {
  const folder = await stat(cwd).catch(() => null);
  if (!folder?.isDirectory()) {
    return { reason: 'not-found', message: 'The project folder no longer exists.' };
  }
  return { reason: 'unsupported-cli', message: 'Claude Code could not be started.' };
}

function isSpawnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('syscall' in error)) return false;
  return typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
}

/**
 * The project folder in each form the CLI could report it: as given, its real path from the
 * system, and the one Node's own lookup gives (which keeps short 8.3 names and drive letters
 * made with `subst`).
 */
async function folderForms(cwd: string): Promise<string[]> {
  const real = await realpath(cwd).catch(() => null);
  const js = await new Promise<string | null>((resolve) => {
    realpathJs(cwd, (error, resolved) => resolve(error ? null : resolved));
  });
  return [cwd, real, js].filter((form): form is string => form !== null);
}

/** What the system says a reported folder is; null when it cannot say. Only after a mismatch. */
function realFolder(folder: string): string | null {
  try {
    return realpathSync.native(folder);
  } catch {
    return null;
  }
}

let settingsWrites: Promise<unknown> = Promise.resolve();

/**
 * The settings file for a set of extra folders: the base file when there are none, otherwise a
 * sibling named for the set, so two scouts with different folders cannot rewrite each other's.
 */
export function scoutSettingsPath(base: string, extraFolders: readonly string[]): string {
  if (extraFolders.length === 0) return base;
  const id = createHash('sha256').update(extraFolders.join('\u0000')).digest('hex').slice(0, 12);
  const extension = path.extname(base);
  return `${base.slice(0, base.length - extension.length)}-${id}${extension}`;
}

/**
 * Makes the scout's settings file hold exactly the deny list (and the extra folders it is for).
 * It is checked before every run and rewritten whenever it differs, so an edited or damaged file
 * cannot widen what a scout reads. False when it could not be written: the run must then not
 * start.
 */
export function ensureScoutSettings(
  settingsPath: string,
  extraFolders: readonly string[] = []
): Promise<boolean> {
  // One at a time: scouts start together, and two renames onto one file can collide.
  const next = settingsWrites.then(async () => {
    const wanted = scoutSettingsContent(extraFolders);
    const current = await readFile(settingsPath, 'utf8').catch(() => null);
    if (current === wanted) return true;
    try {
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const temp = `${settingsPath}.tmp`;
      await writeFile(temp, wanted, 'utf8');
      await rename(temp, settingsPath);
      return true;
    } catch {
      return false;
    }
  });
  settingsWrites = next;
  return next;
}
