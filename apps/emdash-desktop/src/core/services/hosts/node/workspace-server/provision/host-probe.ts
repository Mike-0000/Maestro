import { probeRemotePlatform } from '@core/primitives/ssh/api/node/remote-platform-probe';
import {
  requireSupportedRemoteHost,
  type SupportedRemoteHost,
} from '@core/primitives/ssh/api/remote-platform';
import type { WorkspaceServerSshPort } from '../ports';

export type RemoteHostInfo = SupportedRemoteHost;

/**
 * Probes and caches the remote platform facts the workspace server needs. Rejects with
 * RemotePlatformUnsupportedError when a blocking requirement fails, and with
 * RemotePlatformProbeError when the host cannot be identified.
 */
export class RemoteHostProbe {
  private cached: Promise<RemoteHostInfo> | undefined;

  constructor(
    private readonly connectionId: string,
    private readonly ssh: WorkspaceServerSshPort
  ) {}

  probe(signal?: AbortSignal): Promise<RemoteHostInfo> {
    if (this.cached) return this.cached;

    const pending = this.probeUncached(signal).catch((error: unknown) => {
      if (this.cached === pending) this.cached = undefined;
      throw error;
    });
    this.cached = pending;
    return pending;
  }

  drop(): void {
    this.cached = undefined;
  }

  private async probeUncached(signal?: AbortSignal): Promise<RemoteHostInfo> {
    const proxy = await this.ssh.ensureProxy(this.connectionId);
    return requireSupportedRemoteHost(await probeRemotePlatform(proxy, signal));
  }
}
