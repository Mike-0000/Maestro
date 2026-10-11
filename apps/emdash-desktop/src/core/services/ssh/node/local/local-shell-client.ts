import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { homedir } from 'node:os';
import { Duplex, type Readable } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';

type ChannelCallback = (error: Error | undefined, channel: ClientChannel) => void;

export type LocalShellClientDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcessWithoutNullStreams;
  connect?: (options: net.NetConnectOpts) => net.Socket;
  /** Windows only: ends a command's whole process tree (cmd.exe does not forward kills). */
  killTree?: (pid: number) => void;
  /**
   * Run everything inside this WSL2 distro instead of on Windows: commands through
   * `wsl.exe --exec /bin/sh -c`, and socket forwards through a relay inside the distro.
   */
  wsl?: { distro: string };
};

/**
 * Stands in for an ssh2 `Client` on the machine that runs the app, so a "This computer" Host runs
 * its workspace server through the same install, probe, daemon, and bridge code as SSH Hosts.
 *
 * Commands run the way an OpenSSH server runs them for this user: through the Windows default
 * shell (`cmd.exe /c`) or `/bin/sh -c`, from the home directory. Callers already build those
 * command lines with the SSH quoting helpers, so this adds no quoting of its own. Forwarding opens
 * the same local TCP ports and sockets the remote end of an SSH forward would.
 *
 * With `wsl`, the machine is a WSL2 distro on this computer. A command is handed to the
 * distro's `/bin/sh -c` as one argument, which `wsl.exe --exec` passes on untouched, so the POSIX
 * quoting callers already did is all the quoting there is. The command starts in the distro
 * user's home with the Windows directories taken off `PATH`, as an SSH login would find it. A
 * socket in the distro is not reachable from Windows, so a forward to one runs a small relay
 * inside the distro and uses its stdin and stdout as the channel. TCP forwards still dial
 * `localhost` from Windows, which WSL maps to the distro.
 *
 * Only the Client surface the SSH proxy uses is implemented: connect/end/destroy, `exec`,
 * `forwardOut`, and `openssh_forwardOutStreamLocal`, plus the ready/close/end/error events.
 */
export class LocalShellClient extends EventEmitter {
  private readonly platform: NodeJS.Platform;
  private readonly channels = new Set<LocalExecChannel>();
  private readonly sockets = new Set<net.Socket>();
  private state: 'idle' | 'ready' | 'closed' = 'idle';

  constructor(private readonly deps: LocalShellClientDeps = {}) {
    super();
    this.platform = deps.platform ?? process.platform;
  }

  /** Narrowed to the ssh2 type at the one boundary that stores Clients. */
  asSshClient(): Client {
    return this as unknown as Client;
  }

  connect(_config?: unknown): this {
    if (this.state !== 'idle') return this;
    setImmediate(() => {
      if (this.state !== 'idle') return;
      this.state = 'ready';
      this.emit('ready');
    });
    return this;
  }

  end(): this {
    this.close();
    return this;
  }

  destroy(): this {
    this.close();
    return this;
  }

  exec(command: string, callback: ChannelCallback): boolean {
    const failure = this.unavailable();
    if (failure) {
      queueMicrotask(() => callback(failure, undefined as unknown as ClientChannel));
      return false;
    }
    let channel: LocalExecChannel;
    try {
      channel = new LocalExecChannel(this.spawnShell(command), this.platform, this.deps.killTree);
    } catch (error) {
      queueMicrotask(() => callback(asError(error), undefined as unknown as ClientChannel));
      return false;
    }
    this.channels.add(channel);
    channel.once('close', () => this.channels.delete(channel));
    queueMicrotask(() => callback(undefined, channel.asClientChannel()));
    return true;
  }

  forwardOut(
    _sourceHost: string,
    _sourcePort: number,
    remoteHost: string,
    remotePort: number,
    callback: ChannelCallback
  ): this {
    this.openSocket({ host: remoteHost, port: remotePort }, callback);
    return this;
  }

  openssh_forwardOutStreamLocal(socketPath: string, callback: ChannelCallback): this {
    if (this.deps.wsl) {
      // The relay is an exec channel like any other: its stdio is the socket's byte stream.
      this.execRaw(WSL_SOCKET_RELAY_ARGS(socketPath), callback);
      return this;
    }
    this.openSocket({ path: socketPath }, callback);
    return this;
  }

  /** Runs `wsl.exe --exec <argv>` in the distro and hands its stdio back as a channel. */
  private execRaw(argv: readonly string[], callback: ChannelCallback): void {
    const failure = this.unavailable();
    if (failure) {
      queueMicrotask(() => callback(failure, undefined as unknown as ClientChannel));
      return;
    }
    let channel: LocalExecChannel;
    try {
      channel = new LocalExecChannel(this.spawnInDistro(argv), 'win32', this.deps.killTree);
    } catch (error) {
      queueMicrotask(() => callback(asError(error), undefined as unknown as ClientChannel));
      return;
    }
    this.channels.add(channel);
    channel.once('close', () => this.channels.delete(channel));
    queueMicrotask(() => callback(undefined, channel.asClientChannel()));
  }

  private spawnInDistro(argv: readonly string[]): ChildProcessWithoutNullStreams {
    const run = this.deps.spawn ?? (spawn as NonNullable<LocalShellClientDeps['spawn']>);
    const distro = this.deps.wsl?.distro ?? '';
    // `--cd ~` is the distro user's home; without it the command would start in the Windows
    // directory the app runs from, seen through the drive mount.
    return run(
      wslExecutable(this.deps.env ?? process.env),
      ['-d', distro, '--cd', '~', '--exec', ...argv],
      {
        env: localShellEnvironment(this.deps.env ?? process.env),
        stdio: 'pipe',
        windowsHide: true,
      }
    );
  }

  private openSocket(options: net.NetConnectOpts, callback: ChannelCallback): void {
    const failure = this.unavailable();
    if (failure) {
      queueMicrotask(() => callback(failure, undefined as unknown as ClientChannel));
      return;
    }
    const socket = (this.deps.connect ?? net.connect)(options);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      socket.destroy();
      callback(error, undefined as unknown as ClientChannel);
    };
    const onConnect = () => {
      socket.off('error', onError);
      // A socket has no stderr; consumers of forwarded channels never read it.
      callback(undefined, socket as unknown as ClientChannel);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  }

  private spawnShell(command: string): ChildProcessWithoutNullStreams {
    if (this.deps.wsl) {
      return this.spawnInDistro(['/bin/sh', '-c', `${WSL_POSIX_PATH}\n${command}`]);
    }
    const run = this.deps.spawn ?? (spawn as NonNullable<LocalShellClientDeps['spawn']>);
    const options: SpawnOptions = {
      cwd: this.deps.cwd ?? homedir(),
      env: localShellEnvironment(this.deps.env ?? process.env),
      stdio: 'pipe',
      windowsHide: true,
    };
    if (this.platform === 'win32') {
      // `/s /c "<line>"` strips exactly the quotes added here and runs the line verbatim, as
      // Windows OpenSSH runs an exec request through its default shell.
      const shell = this.deps.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe';
      return run(shell, ['/d', '/s', '/c', `"${command}"`], {
        ...options,
        windowsVerbatimArguments: true,
      });
    }
    // Its own process group, so a destroyed channel can end everything the command started.
    return run('/bin/sh', ['-c', command], { ...options, detached: true });
  }

  private unavailable(): Error | undefined {
    if (this.state === 'ready') return undefined;
    return new Error(
      this.state === 'closed'
        ? 'The local connection is closed'
        : 'The local connection is not ready'
    );
  }

  private close(): void {
    if (this.state === 'closed') return;
    const wasReady = this.state === 'ready';
    this.state = 'closed';
    for (const channel of this.channels) channel.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.channels.clear();
    this.sockets.clear();
    queueMicrotask(() => {
      if (wasReady) this.emit('end');
      this.emit('close');
    });
  }
}

/**
 * WSL appends every Windows `PATH` directory to the distro's. Left in, the distro would find
 * Windows programs (`git.exe`, a Windows `claude`) and every lookup would cross the drive mount.
 * This drops them for the command and everything it starts, the workspace server included.
 */
const WSL_POSIX_PATH =
  'PATH=$(printf %s "$PATH" | tr ":" "\\n" | grep -v "^/mnt/[a-z]/" | paste -sd: -); export PATH';

/**
 * A stdin/stdout relay to a unix socket inside the distro, run by the Node the workspace server
 * ships with (`<root>/current/node`, two levels above `<root>/run/<socket>`). It exits when
 * either side closes, and with a non-zero code when the socket cannot be reached.
 */
const WSL_SOCKET_RELAY =
  "const n=require('net');const s=n.connect(process.argv[1]);" +
  'process.stdin.pipe(s);s.pipe(process.stdout);' +
  "s.on('error',(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(111)});" +
  "s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());";

function WSL_SOCKET_RELAY_ARGS(socketPath: string): string[] {
  return [
    '/bin/sh',
    '-c',
    'exec "$(dirname -- "$(dirname -- "$1")")/current/node" -e "$2" "$1"',
    'relay',
    socketPath,
    WSL_SOCKET_RELAY,
  ];
}

/** `wsl.exe` from the Windows system directory, never from a `PATH` someone else can add to. */
function wslExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return root ? `${root}\\System32\\wsl.exe` : 'wsl.exe';
}

/**
 * Removes variables that describe this app's own process rather than the user's session, so
 * commands and the daemon they start see what an SSH login would give them.
 */
export function localShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|EMDASH_|VITE_)/iu.test(key)) continue;
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_ENV)$/iu.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * An exec channel over a local child process: stdout is the readable side, stdin the writable
 * side, and `stderr` is the child's stderr, as on an ssh2 exec channel. `exit` and `close` carry
 * the exit code; the stream never closes on its own before the process does.
 */
class LocalExecChannel extends Duplex {
  readonly stderr: Readable;
  private exited = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly platform: NodeJS.Platform,
    private readonly killTree: ((pid: number) => void) | undefined
  ) {
    super({ emitClose: false, autoDestroy: false, allowHalfOpen: true });
    this.stderr = child.stderr;
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.once('end', () => this.push(null));
    // A command that exits without reading stdin makes later writes fail with EPIPE; that is the
    // command's choice, not a channel failure.
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      if (this.exited) return;
      this.exited = true;
      this.push(null);
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.finish(1, undefined);
    });
    child.once('close', (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      // A signal-terminated command did not succeed, even though it has no exit code.
      this.finish(code ?? 1, signal ?? undefined);
    });
  }

  /**
   * Reports the exit after a flowing reader has seen all of stdout, so `close` never overtakes
   * buffered output. A paused or absent reader keeps its buffered data readable.
   */
  private finish(code: number, signal: string | undefined): void {
    const emit = () => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    };
    if (this.destroyed || this.readableEnded || this.readableFlowing !== true) setImmediate(emit);
    else this.once('end', emit);
  }

  asClientChannel(): ClientChannel {
    return this as unknown as ClientChannel;
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      callback();
      return;
    }
    this.child.stdin.write(chunk, encoding, () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(() => callback());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.stdin.destroy();
    if (!this.exited) this.terminate();
    callback(error);
  }

  private terminate(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (this.platform === 'win32') {
        (this.killTree ?? killWindowsProcessTree)(pid);
      } else {
        process.kill(-pid, 'SIGTERM');
      }
    } catch {
      this.child.kill();
    }
  }
}

function killWindowsProcessTree(pid: number): void {
  const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  killer.once('error', () => {});
  killer.unref();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
