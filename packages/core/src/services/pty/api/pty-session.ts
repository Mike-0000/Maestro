import type { LiveLogSourceOptions } from '@emdash/wire/live';
import { LiveLogSource } from '@emdash/wire/live';
import { TerminalCapabilityResponder } from './terminal-capability-responder';
import type { PtyExitInfo, PtyProcess, PtySpawnSpec } from './types';

/**
 * How long output may wait to be batched into one log append. A PTY reports output in many
 * small pieces, and every append becomes its own Wire message that the desktop main process
 * relays to each viewer, so a redraw storm from a long agent session would otherwise flood the
 * main thread and queue keystrokes behind it. 8 ms is well under one frame of echo latency.
 */
export const PTY_OUTPUT_BATCH_MS = 8;
/** Output batched past this size is appended at once rather than waiting out the window. */
export const PTY_OUTPUT_BATCH_MAX_CHARS = 64 * 1024;

export interface PtySessionOptions {
  tmux?: boolean;
  log?: LiveLogSourceOptions;
  output?: LiveLogSource;
  /** Batching window for log appends; 0 appends every piece as it arrives. */
  outputBatchMs?: number;
  onProcess?: (process: PtyProcess) => void;
  onData?: (chunk: string) => void;
  onExit?: (info: PtyExitInfo) => void;
  onStateChange?: () => void;
}

export class PtySession {
  readonly output: LiveLogSource;
  readonly startedAt = Date.now();
  private disposed = false;
  private exitInfo: PtyExitInfo | null = null;
  private pendingOutput = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly key: string,
    readonly spec: PtySpawnSpec,
    private readonly process: PtyProcess,
    private readonly options: PtySessionOptions = {}
  ) {
    this.output = options.output ?? new LiveLogSource(options.log);
    const capabilities = options.tmux
      ? new TerminalCapabilityResponder((reply) => this.write(reply))
      : null;
    this.process.onData((chunk) => {
      if (this.disposed) return;
      const output = capabilities ? capabilities.push(chunk) : chunk;
      if (output) {
        this.queueOutput(output);
        this.options.onData?.(output);
      }
      this.options.onStateChange?.();
    });
    this.process.onExit((info) => {
      this.flushOutput();
      const pending = capabilities?.finish();
      if (pending && !this.disposed) {
        this.output.append(pending);
        this.options.onData?.(pending);
      }
      this.exitInfo = normalizeExitInfo(info);
      this.options.onExit?.(this.exitInfo);
      this.options.onStateChange?.();
    });
  }

  get exitStatus(): PtyExitInfo | null {
    return this.exitInfo;
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  write(data: string): void {
    if (this.disposed || this.exited) return;
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.exited) return;
    this.process.resize(cols, rows);
  }

  kill(): void {
    if (this.disposed) return;
    this.process.kill();
  }

  dispose(): void {
    if (this.disposed) return;
    this.kill();
    this.flushOutput();
    this.disposed = true;
  }

  private queueOutput(chunk: string): void {
    const batchMs = this.options.outputBatchMs ?? PTY_OUTPUT_BATCH_MS;
    if (batchMs <= 0) {
      this.output.append(chunk);
      return;
    }
    this.pendingOutput += chunk;
    if (this.pendingOutput.length >= PTY_OUTPUT_BATCH_MAX_CHARS) {
      this.flushOutput();
      return;
    }
    this.flushTimer ??= setTimeout(() => this.flushOutput(), batchMs);
  }

  /** Appends any batched output now, so it lands before an exit or dispose. */
  private flushOutput(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingOutput) return;
    const chunk = this.pendingOutput;
    this.pendingOutput = '';
    this.output.append(chunk);
  }

  getPid(): number | undefined {
    return this.process.getPid?.();
  }
}

function normalizeExitInfo(info: PtyExitInfo): PtyExitInfo {
  return {
    exitCode: info.exitCode ?? null,
    signal: info.signal ?? null,
  };
}
