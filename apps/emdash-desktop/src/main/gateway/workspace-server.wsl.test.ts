import { hostRef } from '@emdash/core/primitives/host/api';
import { createScope } from '@emdash/shared/concurrency';
import { describe, expect, it } from 'vitest';
import { createHosts } from '@core/services/hosts/node/hosts';
import { DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL } from '@core/services/hosts/node/workspace-server/provision/installer';
import { SshConnectionManager } from '@core/services/ssh/node/lifecycle/ssh-connection-manager';
import { createDesktopRuntimeBroker } from './runtime-broker';

// End to end against a real WSL2 distro on this computer: the Host is probed, its workspace
// server installed and started, and a runtime answers, all through wsl.exe. Opt in by naming
// the distro: EMDASH_TEST_WSL_DISTRO=Ubuntu. The distro needs network access for the install.
const distro = process.env['EMDASH_TEST_WSL_DISTRO'];

describe.skipIf(process.platform !== 'win32' || !distro)('a WSL2 distro as a Host', () => {
  it('connects, prepares the workspace server, and serves the distro file system', async () => {
    const connectionId = 'wsl-distro-smoke';
    const scope = createScope({ label: 'workspace-server-wsl-test' });
    const manager = new SshConnectionManager();
    const resolve = async () => ({
      config: { readyTimeout: 30_000 },
      cleanup: () => {},
      debugLogs: [],
      transport: 'wsl' as const,
      wslDistro: distro ?? '',
    });
    const hosts = createHosts({
      scope,
      ssh: {
        manager,
        control: {
          readIntent: async () => true,
          writeIntent: async () => {},
          establish: (id, signal) => manager.createConnection(id, resolve, { signal }),
          reset: (id) => manager.resetConnection(id),
          probe: async (id, signal) => {
            const proxy = manager.getProxy(id);
            if (!proxy) throw new Error('The distro is disconnected');
            await proxy.execScript('true', { signal, timeoutMs: 15_000 });
          },
        },
      },
      machineEvents: { on: () => () => {} },
      installBaseUrl: DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL,
    });
    const broker = createDesktopRuntimeBroker({} as never, hosts);
    const host = hostRef('remote', connectionId);
    const service = hosts.get(host);
    if (!service) throw new Error('Missing Host');
    try {
      await manager.createConnection(connectionId, resolve);
      hosts.lease(connectionId, scope);
      await service.runtime.client();

      const resolved = await broker.client(host);
      if (!resolved.success) throw new Error(resolved.error.message);
      const home = (await resolved.data.files.getHomeDir(undefined)).path;
      // The distro's own home, on its Linux filesystem: not a Windows drive mount.
      expect(home).toMatchObject({ root: { kind: 'posix' } });
      expect(home.segments[0]).not.toBe('mnt');

      // git is the distro's own, never git.exe found through the Windows PATH.
      const git = await resolved.data.hostDependencies.resolver.resolve({ id: 'git' });
      expect(git).toMatchObject({ success: true });
      if (git.success) expect(git.data.path).not.toMatch(/^\/mnt\/|\.exe$/);
      // An agent CLI in the distro is found where its installer put it. Set
      // EMDASH_TEST_WSL_AGENT=claude when the distro has one.
      const agent = process.env['EMDASH_TEST_WSL_AGENT'];
      if (agent) {
        const cli = await resolved.data.hostDependencies.resolver.resolve({ id: agent });
        expect(cli).toMatchObject({ success: true });
        if (cli.success) expect(cli.data.path).not.toMatch(/^\/mnt\//);
      }
    } finally {
      await scope.dispose();
      manager.resetConnection(connectionId);
    }
  }, 300_000);
});
