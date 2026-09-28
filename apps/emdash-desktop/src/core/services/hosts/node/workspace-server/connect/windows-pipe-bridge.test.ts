import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { WINDOWS_PIPE_BRIDGE_READY_MARKER } from '../windows-scripts';
import { openWindowsPipeBridge, WindowsPipeBridgeError } from './windows-pipe-bridge';

const RECORD_PATH = 'C:\\Users\\dev\\.emdash\\workspace-server\\run\\workspace.sock';

function fakeChannel() {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    destroy: vi.fn(),
  });
  return channel;
}

function setup() {
  const channel = fakeChannel();
  const openExecChannel = vi
    .fn<SshClientProxy['openExecChannel']>()
    .mockResolvedValue(channel as unknown as ClientChannel);
  return { channel, proxy: { openExecChannel } };
}

function decodedCommand(command: string): string {
  const encoded = command.split(' ').at(-1) ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('openWindowsPipeBridge', () => {
  it('runs the encoded bridge script and resolves once the marker arrives', async () => {
    const { channel, proxy } = setup();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH);
    await vi.waitFor(() => expect(proxy.openExecChannel).toHaveBeenCalled());
    channel.stderr.write('Preparing');
    channel.stderr.write(` ${WINDOWS_PIPE_BRIDGE_READY_MARKER.slice(0, 8)}`);
    channel.stderr.write(WINDOWS_PIPE_BRIDGE_READY_MARKER.slice(8));

    await expect(opened).resolves.toBe(channel);
    const [command] = proxy.openExecChannel.mock.calls[0] ?? [];
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decodedCommand(command ?? '')).toContain(`$recordPath = '${RECORD_PATH}'`);
    expect(channel.destroy).not.toHaveBeenCalled();
    expect(channel.listenerCount('close')).toBe(0);
  });

  it('rejects with the decoded bridge diagnostic when the channel closes early', async () => {
    const { channel, proxy } = setup();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH);
    await vi.waitFor(() => expect(proxy.openExecChannel).toHaveBeenCalled());
    channel.stderr.write(
      '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">The workspace server is not running' +
        '_x000D__x000A_</S></Objs>'
    );
    channel.emit('exit', 48);
    channel.emit('close');

    await expect(opened).rejects.toThrow(
      new WindowsPipeBridgeError('The workspace server is not running')
    );
    expect(channel.destroy).toHaveBeenCalledOnce();
  });

  it('reports the exit code when the bridge closes silently', async () => {
    const { channel, proxy } = setup();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH);
    await vi.waitFor(() => expect(proxy.openExecChannel).toHaveBeenCalled());
    channel.emit('exit', 47);
    channel.emit('close');

    await expect(opened).rejects.toThrow('exited before connecting (exit 47)');
  });

  it('times out and destroys the channel when the marker never arrives', async () => {
    vi.useFakeTimers();
    const { channel, proxy } = setup();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH, { readyTimeoutMs: 1_000 });
    const assertion = expect(opened).rejects.toThrow('did not connect within 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(channel.destroy).toHaveBeenCalledOnce();
  });

  it('rejects with the abort reason and destroys the channel', async () => {
    const { channel, proxy } = setup();
    const controller = new AbortController();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH, { signal: controller.signal });
    await vi.waitFor(() => expect(proxy.openExecChannel).toHaveBeenCalled());
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(opened).rejects.toBe(reason);
    expect(channel.destroy).toHaveBeenCalledOnce();
    expect(proxy.openExecChannel.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('propagates channel errors', async () => {
    const { channel, proxy } = setup();

    const opened = openWindowsPipeBridge(proxy, RECORD_PATH);
    await vi.waitFor(() => expect(proxy.openExecChannel).toHaveBeenCalled());
    channel.emit('error', new Error('channel reset'));

    await expect(opened).rejects.toThrow('channel reset');
    expect(channel.destroy).toHaveBeenCalledOnce();
  });
});
