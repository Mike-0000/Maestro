import type { WireTransport } from '@emdash/wire/rpc';
import type { SshWorkspaceServerTarget } from '../../../api/targets';
import type { WorkspaceServerSshPort } from '../ports';
import { ownedStreamTransport } from './owned-stream-transport';
import { openWindowsPipeBridge } from './windows-pipe-bridge';

export async function openSshWorkspaceServerTransport(
  target: SshWorkspaceServerTarget,
  ssh: WorkspaceServerSshPort,
  options?: { signal?: AbortSignal }
): Promise<WireTransport> {
  const proxy = await ssh.ensureProxy(target.sshConnectionId);
  const channel =
    target.channel === 'windows-pipe-bridge'
      ? await openWindowsPipeBridge(proxy, target.socketPath, options)
      : await proxy.forwardOutStreamLocal(target.socketPath, options);
  return ownedStreamTransport(channel);
}
