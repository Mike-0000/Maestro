import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Worker } from 'node:worker_threads';

/** An event an agent raises on its own: something changed, or its watching stopped working. */
export type MirrorAgentEvent = { event: string; error?: string };

/** One side of a mirror, wherever it runs. See mirror-agent.cjs for what it answers. */
export interface MirrorAgent {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onEvent(listener: (event: MirrorAgentEvent) => void): void;
  /** The agent is gone, on its own or after `dispose`. Pending requests have been rejected. */
  onExit(listener: (reason: string) => void): void;
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type Reply = { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string };

/** The request bookkeeping both transports share. */
class AgentLink implements MirrorAgent {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly eventListeners: Array<(event: MirrorAgentEvent) => void> = [];
  private readonly exitListeners: Array<(reason: string) => void> = [];
  private closed: string | null = null;

  constructor(
    private readonly post: (message: unknown) => void,
    private readonly stop: () => void
  ) {}

  request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed !== null) return Promise.reject(new Error(this.closed));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The mirror agent did not answer "${method}" in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.post({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(listener: (event: MirrorAgentEvent) => void): void {
    this.eventListeners.push(listener);
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    this.close('The mirror agent was stopped.');
    this.stop();
  }

  deliver(reply: Reply): void {
    if (typeof reply.event === 'string') {
      for (const listener of this.eventListeners)
        listener({ event: reply.event, error: reply.error });
      return;
    }
    if (typeof reply.id !== 'number') return;
    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);
    clearTimeout(waiting.timer);
    if (reply.ok) waiting.resolve(reply.result);
    else waiting.reject(new Error(reply.error ?? 'The mirror agent failed.'));
  }

  close(reason: string): void {
    if (this.closed !== null) return;
    this.closed = reason;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.pending.clear();
    for (const listener of this.exitListeners) listener(reason);
  }
}

/** Runs the agent in this process, on a thread of its own, so reading a tree never blocks. */
export function createWorkerAgent(source: string): MirrorAgent {
  const worker = new Worker(source, { eval: true, stdout: false, stderr: false });
  const link = new AgentLink(
    (message) => worker.postMessage(message),
    () => void worker.terminate()
  );
  worker.on('message', (reply: Reply) => link.deliver(reply));
  worker.on('error', (error) => link.close(`The mirror agent failed: ${error.message}`));
  worker.on('exit', () => link.close('The mirror agent stopped.'));
  return link;
}

/** Runs the agent as another program (in the distro, through `wsl.exe`), one JSON line each way. */
export function createProcessAgent(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): MirrorAgent {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    stdio: 'pipe',
    windowsHide: true,
    env: options.env,
  });
  const link = new AgentLink(
    (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    () => {
      child.stdin.end();
      child.kill();
    }
  );
  let buffered = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      try {
        link.deliver(JSON.parse(line) as Reply);
      } catch {
        // Not a message: something else wrote to the agent's output. Nothing to act on.
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdin.on('error', () => {});
  child.once('error', (error) => link.close(`The mirror agent could not start: ${error.message}`));
  child.once('close', (code) => {
    const said = stderr.replace(/\0/g, '').trim();
    link.close(`The mirror agent stopped (code ${code ?? 'none'})${said ? `: ${said}` : '.'}`);
  });
  return link;
}
