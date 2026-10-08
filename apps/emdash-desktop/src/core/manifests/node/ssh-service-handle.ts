import type { MachinesService } from '@core/features/machines/api/node/machines-service';
import type { MaestroHostsService } from '@core/features/machines/node/maestro-hosts-service';
import type { SshService } from '@core/primitives/ssh/api';
import type {
  SshConnectionControl,
  SshConnectionLifecycle,
} from '@core/primitives/ssh/api/node/connection-control';
import type { SshConnectionManager } from '@core/primitives/ssh/api/node/ssh-connection-manager';
import type { SshConnectionsModel } from '@core/services/ssh/node/connections-model';

export interface SshServiceHandle {
  readonly control: SshConnectionControl;
  bindLifecycle(lifecycle: SshConnectionLifecycle): void;
  readonly ssh: SshService;
  readonly machines: MachinesService;
  /** Pairing and upkeep of machines reached over the Maestro app's listener instead of SSH. */
  readonly maestroHosts: MaestroHostsService;
  readonly manager: SshConnectionManager;
  readonly connections: SshConnectionsModel;
  dispose(): Promise<void>;
}
