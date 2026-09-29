import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openWindowsPipeBridge } from '@core/services/hosts/node/workspace-server/connect/windows-pipe-bridge';
import { SshClientProxy } from '@core/services/ssh/node/lifecycle/ssh-client-proxy';
import { LocalShellClient } from '@core/services/ssh/node/local/local-shell-client';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// "This computer" Hosts run the same bridge through a local shell instead of an SSH exec channel;
// its stdin is then an anonymous pipe rather than an OpenSSH channel handle.
describe.runIf(process.platform === 'win32')('Windows pipe bridge on a local shell', () => {
  it('relays bytes between the channel and the recorded daemon pipe', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emdash-local-bridge-'q' "));
    const pipeName = `emdash-workspace-server-${randomUUID()}`;
    const recordPath = path.join(directory, 'workspace.sock');
    fs.writeFileSync(recordPath, `\\\\.\\pipe\\${pipeName}\n`);
    const server = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolve));

    const client = new LocalShellClient();
    await new Promise<void>((resolve) => {
      client.once('ready', () => resolve());
      client.connect();
    });
    const proxy = new SshClientProxy('this-computer');
    proxy.update(client.asSshClient());
    cleanups.push(() => {
      client.destroy();
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });

    const channel = await openWindowsPipeBridge(proxy, recordPath);
    const echoed = new Promise<string>((resolve) =>
      channel.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    );
    channel.write('round trip');
    expect(await echoed).toBe('round trip');
    channel.destroy();
  }, 60_000);
});
