import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { app, powerMonitor } from 'electron';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import { IS_CANARY } from '@core/primitives/app-identity/api/app-identity';
import type { SshService } from '@core/primitives/ssh/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { sshConnections } from '@core/services/app-db/node/schema';
import { createHosts, type Hosts } from '@core/services/hosts/node/hosts';
import { MaestroHostCredentialService } from '@core/services/hosts/node/maestro/maestro-host-credentials';
import {
  createMaestroHostDirectory,
  type MaestroHostDirectory,
} from '@core/services/hosts/node/maestro/maestro-host-directory';
import { windowsBundleLoader } from '@core/services/hosts/node/workspace-server/provision/windows-bundle';
import { sshCredentialChanges } from '@core/services/ssh/node/credentials/credential-record';
import { SshCredentialService } from '@core/services/ssh/node/credentials/ssh-credential-service';
import { createSshService } from '@main/bootstrap/core/ssh-service-factory';
import { getDesktopClientId } from '@main/core/runtime/desktop-client-id';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { appScope } from '../../core/app-scope';
import type { DatabaseBundle } from './database';

export type InfrastructureBundle = {
  readonly ssh: SshServiceHandle;
  readonly hosts: Hosts;
  /** Machines reached over the Maestro app's listener; they have no SSH connection at all. */
  readonly maestroHosts: MaestroHostDirectory;
};

export async function bootInfrastructure(database: DatabaseBundle): Promise<InfrastructureBundle> {
  const maestroCredentials = new MaestroHostCredentialService(encryptedAppSecretsStore);
  const ssh = createSshService({
    scope: appScope,
    db: database.db,
    credentials: new SshCredentialService(encryptedAppSecretsStore),
    prepareCredentials: (id, credentials) =>
      encryptedAppSecretsStore.prepareChanges(sshCredentialChanges(id, credentials)),
    maestroCredentials,
    prepareMaestroSecrets: (changes) => encryptedAppSecretsStore.prepareChanges(changes),
    logger: log,
    telemetry: telemetryService,
    wslMirrorDirectory: join(app.getPath('userData'), 'wsl-mirror'),
  });
  const hostSettings = await database.appSettings.get('remoteMachine');
  const clientId = await getDesktopClientId();
  const maestroHosts = createMaestroHostDirectory({
    db: database.db,
    credentials: maestroCredentials,
  });
  const hosts = createHosts({
    scope: appScope,
    ssh: { manager: ssh.manager, control: ssh.control },
    maestro: {
      ...maestroHosts,
      publishConnectionEvent: (event) => ssh.connections.publishEvent(event),
    },
    machineEvents: ssh.machines,
    installBaseUrl: hostSettings.installBaseUrl,
    releaseChannel: IS_CANARY ? 'canary' : 'stable',
    windowsWorkspaceServerBundle: windowsBundleLoader(windowsWorkspaceServerBundleDirectory()),
    devAutoUpdate: process.env['EMDASH_WORKSPACE_SERVER_DEV_AUTO_UPDATE'] === '1',
    client: { id: clientId, appVersion: app.getVersion() },
    logger: log,
  });
  ssh.bindLifecycle(hosts.lifecycle);
  const resume = () => hosts.wake('resume');
  const suspend = () => hosts.wake('suspend');
  powerMonitor.on('resume', resume);
  powerMonitor.on('suspend', suspend);
  appScope.add(() => {
    powerMonitor.off('resume', resume);
    powerMonitor.off('suspend', suspend);
  });
  void reconnectIntendedSshConnections(database.db, ssh.ssh);
  return { ssh, hosts, maestroHosts };
}

/** Prepared by scripts/prepare-workspace-server-bundle.ts and shipped as an extra resource. */
function windowsWorkspaceServerBundleDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'workspace-server')
    : join(app.getAppPath(), '.cache', 'workspace-server-bundle');
}

async function reconnectIntendedSshConnections(db: AppDb, ssh: SshService): Promise<void> {
  try {
    const rows = await db
      .select({ id: sshConnections.id })
      .from(sshConnections)
      .where(eq(sshConnections.shouldConnect, 1));

    await Promise.all(
      rows.map(async ({ id }) => {
        try {
          await ssh.ensureConnected(id);
        } catch (error) {
          log.warn('Failed to reconnect intended SSH connection', {
            connectionId: id,
            error: String(error),
          });
        }
      })
    );
  } catch (error) {
    log.warn('Failed to load intended SSH connections', { error: String(error) });
  }
}
