import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EnvSource } from '#primitives/exec/api';

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's standard input, which is then closed. Unset leaves it open. */
  input?: string;
  /**
   * The signal the stop sequence starts with on timeout, abort, a stream handler returning
   * `false`, and buffer overflow. `SIGKILL` makes the Windows path a forced tree kill at once,
   * which is what reaches a program started through a `.cmd` shim.
   */
  killSignal?: NodeJS.Signals;
  maxBuffer?: number;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Keeps a console program started from the packaged app from opening a window on Windows. */
  windowsHide?: boolean;
};

export type ExecSpawnOptions = Pick<ExecOptions, 'cwd' | 'env' | 'signal'>;

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export type ExecBufferResult = {
  stdout: Buffer;
  stderr: string;
};

export class ExecError extends Error {
  constructor(
    readonly file: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    options?: ErrorOptions
  ) {
    super(`${file} ${args.join(' ')} failed (exit ${exitCode ?? 'unknown'})`, options);
    this.name = 'ExecError';
  }
}

export type BoundExec = {
  readonly file: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | EnvSource;
  exec(args: string[], options?: ExecOptions): Promise<ExecResult>;
  execStreaming(
    args: string[],
    onStdout: (chunk: string) => boolean | void,
    options?: ExecOptions
  ): Promise<void>;
  execBuffer(args: string[], options?: ExecOptions): Promise<ExecBufferResult>;
  spawn(
    args: string[],
    options?: ExecSpawnOptions
  ): ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;
  withCwd(cwd: string): BoundExec;
};
