import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientChannel } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { execOnClient } from '../operations/exec';
import { openChannel } from '../operations/open-channel';
import { LocalShellClient, localShellEnvironment } from './local-shell-client';

const clients: LocalShellClient[] = [];

async function readyClient(): Promise<LocalShellClient> {
  const client = new LocalShellClient();
  clients.push(client);
  await new Promise<void>((resolve) => {
    client.once('ready', () => resolve());
    client.connect();
  });
  return client;
}

function openExec(client: LocalShellClient, command: string): Promise<ClientChannel> {
  const ssh = client.asSshClient();
  return openChannel(ssh, 'exec', (callback) => {
    ssh.exec(command, callback);
  });
}

function collect(channel: ClientChannel): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    channel.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    channel.once('close', (code: number) => resolve({ stdout, code }));
  });
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

describe('localShellEnvironment', () => {
  it("drops the app's own process variables and keeps the user's", () => {
    expect(
      localShellEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/me',
        ELECTRON_RUN_AS_NODE: '1',
        EMDASH_DB_FILE: '/tmp/db',
        NODE_OPTIONS: '--inspect',
        VITE_POSTHOG_KEY: 'key',
        UNSET: undefined,
      })
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });
});

describe('LocalShellClient', () => {
  it('refuses work before it is ready and after it closes', async () => {
    const client = new LocalShellClient();
    const ssh = client.asSshClient();
    const early = await new Promise<Error | undefined>((resolve) => {
      ssh.exec('exit 0', (error) => resolve(error));
    });
    expect(early?.message).toContain('not ready');

    const ready = await readyClient();
    const closed = new Promise<void>((resolve) => ready.once('close', () => resolve()));
    ready.end();
    await closed;
    const late = await new Promise<Error | undefined>((resolve) => {
      ready.asSshClient().exec('exit 0', (error) => resolve(error));
    });
    expect(late?.message).toContain('closed');
  });

  it('runs commands through the default shell with their exit codes and output', async () => {
    const client = await readyClient();
    const result = await execOnClient(client.asSshClient(), 'echo hello&& exit 3');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(3);
  });

  it('carries stdin to the command and its stdout back, as exec channels do', async () => {
    const client = await readyClient();
    const reader =
      process.platform === 'win32'
        ? 'powershell.exe -NoProfile -NonInteractive -Command "[Console]::In.ReadToEnd().ToUpper()"'
        : 'tr a-z A-Z';
    const channel = await openExec(client, reader);
    const output = collect(channel);
    channel.end('piped text');
    const { stdout, code } = await output;
    expect(stdout.trim()).toBe('PIPED TEXT');
    expect(code).toBe(0);
  }, 30_000);

  it('reports exit codes on exec channels through exit and close', async () => {
    const client = await readyClient();
    const channel = await openExec(client, 'exit 7');
    const exit = new Promise<number>((resolve) => channel.once('exit', resolve));
    const { code } = await collect(channel);
    expect(code).toBe(7);
    expect(await exit).toBe(7);
  });

  it('ends a running command when its channel is destroyed', async () => {
    const client = await readyClient();
    const waiter =
      process.platform === 'win32'
        ? 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"'
        : 'sleep 60';
    const channel = await openExec(client, waiter);
    const closed = collect(channel);
    channel.destroy();
    const { code } = await closed;
    expect(code).not.toBe(0);
  }, 30_000);

  it('forwards TCP and local-socket channels to this machine', async () => {
    const client = await readyClient();
    const ssh = client.asSshClient();
    const directory = await mkdtemp(join(tmpdir(), 'emdash-local-client-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\emdash-local-client-${process.pid}-${Date.now()}`
        : join(directory, 'server.sock');
    const echo = (socket: net.Socket) => socket.pipe(socket);
    const tcp = net.createServer(echo);
    const local = net.createServer(echo);
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => local.listen(socketPath, resolve));
    try {
      const port = (tcp.address() as net.AddressInfo).port;
      const tcpChannel = await openChannel(ssh, 'TCP', (callback) => {
        ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', port, callback);
      });
      const localChannel = await openChannel(ssh, 'streamlocal', (callback) => {
        ssh.openssh_forwardOutStreamLocal(socketPath, callback);
      });
      for (const channel of [tcpChannel, localChannel]) {
        const echoed = new Promise<string>((resolve) =>
          channel.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
        );
        channel.write('ping');
        expect(await echoed).toBe('ping');
        channel.destroy();
      }

      await expect(
        openChannel(ssh, 'TCP', (callback) => {
          ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', 1, callback);
        })
      ).rejects.toThrow();
    } finally {
      tcp.close();
      local.close();
    }
  });
});
