import type { Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import {
  MachinesService,
  type MachinesServiceDeps,
} from '@core/features/machines/api/node/machines-service';
import { createMaestroHostClient } from '@core/features/machines/node/maestro-host-client';
import {
  MaestroHostsService,
  type MaestroHostsServiceDeps,
} from '@core/features/machines/node/maestro-hosts-service';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import type { AppDb } from '@core/services/app-db/node/db';
import type { MaestroHostCredentialService } from '@core/services/hosts/node/maestro/maestro-host-credentials';
import { resolveSshConfig } from '@core/services/ssh/node/config/resolve-ssh-config';
import { parseSshConfigFile } from '@core/services/ssh/node/config/sshConfigParser';
import { createProductionSshConnectConfigResolver } from '@core/services/ssh/node/connect/production-connect-config';
import { SshConnectionsModel } from '@core/services/ssh/node/connections-model';
import type { SshCredentialService } from '@core/services/ssh/node/credentials/ssh-credential-service';
import { SshConnectionManager } from '@core/services/ssh/node/lifecycle/ssh-connection-manager';
import { SshService, type SshServiceDeps } from '@core/services/ssh/node/ssh-service';
import { WslMirrorService } from '@core/services/wsl-mirror/node/wsl-mirror-service';

export interface CreateSshServiceDeps {
  scope: Scope;
  db: AppDb;
  credentials: SshCredentialService;
  prepareCredentials: MachinesServiceDeps['prepareCredentials'];
  maestroCredentials: MaestroHostCredentialService;
  prepareMaestroSecrets: MaestroHostsServiceDeps['prepareSecrets'];
  logger: Logger;
  telemetry: SshServiceDeps['telemetry'];
  /** Where live WSL mirrors keep their records. Without it there are no mirrors. */
  wslMirrorDirectory?: string;
}

export function createSshService(deps: CreateSshServiceDeps): SshServiceHandle {
  const scope = deps.scope.child('ssh-service');
  const connections = scope.use(new SshConnectionsModel());
  const resolveConnectConfig = createProductionSshConnectConfigResolver(deps.credentials);
  const manager = new SshConnectionManager({
    publishEvent: (event) => connections.publishEvent(event),
    log: deps.logger,
  });
  const ssh = new SshService({
    db: deps.db,
    manager,
    runtime: connections,
    resolveConnectConfig,
    parseSshConfigFile,
    resolveSshConfig,
    telemetry: deps.telemetry,
    log: deps.logger,
  });
  const wslMirrors =
    deps.wslMirrorDirectory && process.platform === 'win32'
      ? new WslMirrorService({ directory: deps.wslMirrorDirectory, log: deps.logger })
      : undefined;
  if (wslMirrors) {
    // Remembered mirrors run whenever the app does.
    void wslMirrors.start().catch((error: unknown) => {
      deps.logger.warn('WSL mirrors could not be started', { error: String(error) });
    });
    scope.add(() => wslMirrors.dispose());
  }
  const machines = new MachinesService({
    db: deps.db,
    credentials: deps.credentials,
    maestroCredentials: deps.maestroCredentials,
    prepareCredentials: deps.prepareCredentials,
    ssh,
    wslMirrors,
    log: deps.logger,
  });
  const maestroHosts = new MaestroHostsService({
    db: deps.db,
    client: createMaestroHostClient(),
    credentials: deps.maestroCredentials,
    prepareSecrets: deps.prepareMaestroSecrets,
    notifyMutated: (event) => machines.notifyMutated(event),
  });

  scope.add(() => manager.disconnectAll());

  let disposePromise: Promise<void> | undefined;
  return {
    control: ssh.control,
    bindLifecycle: (lifecycle) => ssh.bindLifecycle(lifecycle),
    ssh,
    machines,
    maestroHosts,
    manager,
    connections,
    dispose() {
      disposePromise ??= scope.dispose();
      return disposePromise;
    },
  };
}
