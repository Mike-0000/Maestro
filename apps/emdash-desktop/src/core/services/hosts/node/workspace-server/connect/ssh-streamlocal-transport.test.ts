import { PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { openSshWorkspaceServerTransport } from './ssh-streamlocal-transport';

describe('openSshWorkspaceServerTransport', () => {
  it('uses the current managed proxy and owns the returned channel', async () => {
    const channel = new PassThrough() as unknown as ClientChannel;
    const destroy = vi.spyOn(channel, 'destroy');
    const forwardOutStreamLocal = vi
      .fn<SshClientProxy['forwardOutStreamLocal']>()
      .mockResolvedValue(channel);
    const proxy = { forwardOutStreamLocal } as Pick<
      SshClientProxy,
      'forwardOutStreamLocal'
    > as SshClientProxy;
    const ensureProxy = vi.fn(async () => proxy);

    const transport = await openSshWorkspaceServerTransport(
      {
        kind: 'ssh',
        sshConnectionId: 'ssh-1',
        socketPath: '/home/devuser/.emdash/workspace-server/run/workspace.sock',
        channel: 'streamlocal',
      },
      { ensureProxy }
    );
    transport.close?.();
    transport.close?.();

    expect(ensureProxy).toHaveBeenCalledWith('ssh-1');
    expect(forwardOutStreamLocal).toHaveBeenCalledWith(
      '/home/devuser/.emdash/workspace-server/run/workspace.sock',
      undefined
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('bridges Windows targets through an exec channel instead of streamlocal forwarding', async () => {
    const stderr = new PassThrough();
    const channel = Object.assign(new PassThrough(), { stderr }) as unknown as ClientChannel;
    const openExecChannel = vi
      .fn<SshClientProxy['openExecChannel']>()
      .mockImplementation(async () => {
        setImmediate(() => stderr.write('emdash-workspace-bridge-ready'));
        return channel;
      });
    const forwardOutStreamLocal = vi.fn<SshClientProxy['forwardOutStreamLocal']>();
    const proxy = { openExecChannel, forwardOutStreamLocal } as Pick<
      SshClientProxy,
      'openExecChannel' | 'forwardOutStreamLocal'
    > as SshClientProxy;

    const transport = await openSshWorkspaceServerTransport(
      {
        kind: 'ssh',
        sshConnectionId: 'ssh-1',
        socketPath: 'C:\\Users\\dev\\.emdash\\workspace-server\\run\\workspace.sock',
        channel: 'windows-pipe-bridge',
      },
      { ensureProxy: async () => proxy }
    );
    transport.close?.();

    expect(openExecChannel).toHaveBeenCalledWith(
      expect.stringMatching(/^powershell\.exe .* -EncodedCommand /),
      { signal: undefined }
    );
    expect(forwardOutStreamLocal).not.toHaveBeenCalled();
  });
});
