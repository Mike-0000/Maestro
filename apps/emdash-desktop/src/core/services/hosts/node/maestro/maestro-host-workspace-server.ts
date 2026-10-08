import type { Scope } from '@emdash/shared/concurrency';
import { cell, derived, snapshot, type Readable } from '@emdash/wire/state';
import { MaestroHostUnsupportedError } from '@core/primitives/maestro-host/api/unsupported';
import type { HostServerState } from '../../api/contract';
import type { HostWorkspaceServer } from '../../api/node/host-workspace-server';
import type { HostStateModel } from '../state-model';

type MaestroHostWorkspaceServerDeps = {
  connectionId: string;
  scope: Scope;
  state: Pick<HostStateModel, 'runtime'>;
  /** Republishes what the current connection knows; there is nothing else to inspect. */
  refresh(): void;
};

/**
 * The `server` face of a Maestro host. The Maestro app on that computer is the workspace server:
 * its state is whatever the live connection reports, and it cannot be installed, updated,
 * started, or stopped from here.
 */
export class MaestroHostWorkspaceServer implements HostWorkspaceServer {
  readonly state: Readable<HostServerState | undefined>;

  constructor(private readonly deps: MaestroHostWorkspaceServerDeps) {
    const active = cell(!deps.scope.disposed);
    this.state = derived(() =>
      snapshot(active).value ? snapshot(deps.state.runtime).value[deps.connectionId] : undefined
    ) as Readable<HostServerState | undefined>;
    deps.scope.add(() => {
      active.set(false);
    });
  }

  async refresh(): Promise<void> {
    this.deps.scope.signal.throwIfAborted();
    this.deps.refresh();
  }

  install(): Promise<void> {
    return this.refuse();
  }

  start(): Promise<void> {
    return this.refuse();
  }

  stop(): Promise<void> {
    return this.refuse();
  }

  restart(): Promise<void> {
    return this.refuse();
  }

  update(): Promise<void> {
    return this.refuse();
  }

  private refuse(): Promise<never> {
    return Promise.reject(new MaestroHostUnsupportedError('workspace-server-control'));
  }
}
