import { eq } from 'drizzle-orm';
import { SshConnectionNotFoundError } from '@core/primitives/ssh/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { sshConnections } from '@core/services/app-db/node/schema';
import {
  MaestroHostConnectionError,
  type MaestroHostConnectPort,
  type MaestroHostDialConfig,
} from '../workspace-server/connect/maestro-websocket-transport';
import type { MaestroHostCredentialService } from './maestro-host-credentials';

/** Which machines are Maestro hosts, and how each one is dialed right now. */
export type MaestroHostDirectory = Pick<MaestroHostConnectPort, 'resolve'> & {
  /**
   * Synchronous because the Hosts registry chooses a machine's service the moment it is first
   * asked for. An unknown or deleted machine is not a Maestro host.
   */
  isMaestroHost(connectionId: string): boolean;
};

export function createMaestroHostDirectory(deps: {
  db: AppDb;
  credentials: Pick<MaestroHostCredentialService, 'getDeviceToken' | 'getCfAccessClientSecret'>;
}): MaestroHostDirectory {
  const metadataOf = (connectionId: string) =>
    deps.db
      .select({ metadata: sshConnections.metadata })
      .from(sshConnections)
      .where(eq(sshConnections.id, connectionId))
      .get();

  return {
    isMaestroHost: (connectionId) => metadataOf(connectionId)?.metadata?.transport === 'maestro',
    async resolve(connectionId): Promise<MaestroHostDialConfig> {
      const row = metadataOf(connectionId);
      if (!row) throw new SshConnectionNotFoundError(connectionId);
      const maestro = row.metadata?.transport === 'maestro' ? row.metadata.maestro : undefined;
      if (!maestro?.url) {
        throw new MaestroHostConnectionError(
          'not-configured',
          'This machine has no Maestro host address. Edit it and enter the address again.'
        );
      }
      const token = await deps.credentials.getDeviceToken(connectionId);
      if (!maestro.cfAccessClientId) return { url: maestro.url, token };
      const clientSecret = await deps.credentials.getCfAccessClientSecret(connectionId);
      if (!clientSecret) {
        throw new MaestroHostConnectionError(
          'cloudflare-access',
          'The Cloudflare Access client secret for this host is missing. Edit the machine and enter it again.'
        );
      }
      return {
        url: maestro.url,
        token,
        cfAccess: { clientId: maestro.cfAccessClientId, clientSecret },
      };
    },
  };
}
