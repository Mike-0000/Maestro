import { hostRef } from '@emdash/core/primitives/host/api';
import type { Result } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { observe, remote, whenReady } from '@emdash/wire/state';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import {
  getMachinesClient as getMachinesDomainClient,
  type MachinesClient,
} from '@core/features/machines/api/browser/client';
import { Resource } from '@core/primitives/async-resource/browser/resource';
import { getHostDependencyErrorMessage } from '@core/primitives/host-dependencies/browser/error-message';
import type {
  ConnectionState,
  ConnectionTestResult,
  SshConfig,
  SshConfigHost,
  SshHealthState,
} from '@core/primitives/ssh/api';
import { runDesktopLiveJob } from '@core/primitives/wire/browser/run-live-job';
import { getHostsClient, type HostsClient } from '@core/services/hosts/api/client';
import { sshContract, type SshConnectionsRuntime } from '@core/services/ssh/api';
import { getSshClient as getSshDomainClient, type SshClient } from '@core/services/ssh/api/client';
import type { WslMirrorInfo } from '@core/services/wsl-mirror/api/types';
import { machinesContract } from '../api';
import type {
  InstallMachineSystemDependenciesInput,
  InstallMachineSystemDependenciesResult,
} from '../api';
import type {
  AddMaestroHostInput,
  InspectMaestroHostInput,
  MaestroHostError,
  MaestroHostInfo,
  RepairMaestroHostInput,
  UpdateMaestroHostInput,
} from '../api/maestro-host';

type SaveConnectionInput = Partial<Pick<SshConfig, 'id'>> &
  Omit<SshConfig, 'id'> & { password?: string; passphrase?: string };
export type SystemDependenciesStore = Pick<MachinesStore, 'installSystemDependencies'>;

export type MachinesStoreOptions = {
  sshClient?: SshClient;
  machinesClient?: MachinesClient;
  hostsClient?: Pick<HostsClient, 'disconnect' | 'requestReady'>;
};

const WSL_MIRROR_POLL_MS = 4_000;

function windowsPathKey(path: string): string {
  return path
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

export class MachinesStore {
  readonly connectionsResource: Resource<SshConfig[]>;
  /** Live mirrors between Windows folders and their copies in WSL2 distros. */
  wslMirrors: WslMirrorInfo[] = [];
  private wslMirrorTimer: ReturnType<typeof setInterval> | undefined;

  private pendingMutations = 0;
  private started = false;
  private modelReady = false;
  private runtimeData: SshConnectionsRuntime = {};
  private modelScope: Scope | undefined;
  private startPromise: Promise<void> | undefined;
  private sshClientPromise: Promise<SshClient> | undefined;
  private hostsClientPromise: Promise<Pick<HostsClient, 'disconnect' | 'requestReady'>> | undefined;
  private machinesClientPromise: Promise<MachinesClient> | undefined;
  private readonly sshClientOverride?: SshClient;
  private readonly machinesClientOverride?: MachinesClient;
  private readonly hostsClientOverride?: Pick<HostsClient, 'disconnect' | 'requestReady'>;

  constructor({ sshClient, machinesClient, hostsClient }: MachinesStoreOptions = {}) {
    this.sshClientOverride = sshClient;
    this.machinesClientOverride = machinesClient;
    this.hostsClientOverride = hostsClient;
    this.connectionsResource = new Resource<SshConfig[]>(
      async () => (await this.getMachinesClient()).getMachines(undefined),
      []
    );

    makeObservable<MachinesStore, 'runtimeData' | 'modelReady' | 'pendingMutations' | 'started'>(
      this,
      {
        runtimeData: observable.ref,
        modelReady: observable,
        pendingMutations: observable,
        started: observable,
        wslMirrors: observable.ref,
        connections: computed,
        connectionStates: computed,
        healthStates: computed,
        isLoading: computed,
        start: action,
        dispose: action,
      }
    );
  }

  get connections(): SshConfig[] {
    return this.connectionsResource.data ?? [];
  }

  get connectionStates(): Record<string, ConnectionState> {
    return Object.fromEntries(
      Object.entries(this.runtime).map(([connectionId, value]) => [connectionId, value.state])
    );
  }

  get healthStates(): Record<string, SshHealthState> {
    return Object.fromEntries(
      Object.entries(this.runtime).map(([connectionId, value]) => [connectionId, value.health])
    );
  }

  get isLoading(): boolean {
    return this.connectionsResource.loading || !this.modelReady || this.pendingMutations > 0;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.started = true;
    this.startPromise = Promise.all([
      this.connectionsResource.load(),
      this.initializeConnectionsModel(),
    ]).then(() => {});
    // Mirrors are a Windows feature; anywhere else the list is simply empty.
    void this.refreshWslMirrors().catch(() => undefined);
    return this.startPromise;
  }

  dispose(): void {
    if (this.wslMirrorTimer) clearInterval(this.wslMirrorTimer);
    this.wslMirrorTimer = undefined;
    this.started = false;
    this.modelReady = false;
    this.startPromise = undefined;
    this.connectionsResource.dispose();
    const scope = this.modelScope;
    this.modelScope = undefined;
    this.runtimeData = {};
    if (scope) void scope.dispose();
  }

  stateFor(connectionId: string): ConnectionState {
    return this.runtime[connectionId]?.state ?? 'disconnected';
  }

  healthFor(connectionId: string): SshHealthState {
    return this.runtime[connectionId]?.health ?? { status: 'ok' };
  }

  async connect(connectionId: string): Promise<void> {
    await this.ensureConnectionsModel();
    await (
      await this.getHostsClient()
    ).requestReady({
      host: hostRef('remote', connectionId),
      cause: 'connect',
    });
  }

  async retry(connectionId: string): Promise<void> {
    await this.ensureConnectionsModel();
    await (
      await this.getHostsClient()
    ).requestReady({
      host: hostRef('remote', connectionId),
      cause: 'retry',
    });
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.ensureConnectionsModel();
    await (
      await this.getHostsClient()
    ).disconnect({
      host: { type: 'remote', id: connectionId },
    });
  }

  async saveConnection(config: SaveConnectionInput): Promise<SshConfig> {
    return await this.withMutation(async () => {
      const savedConnection = await (await this.getMachinesClient()).saveMachine(config);
      this.connectionsResource.setValue(this.upsertConnection(savedConnection));
      return savedConnection;
    });
  }

  async addThisComputer(): Promise<SshConfig> {
    return await this.withMutation(async () => {
      const machine = await (await this.getMachinesClient()).addThisComputer(undefined);
      this.connectionsResource.setValue(this.upsertConnection(machine));
      return machine;
    });
  }

  async addWslDistro(distro?: string): Promise<SshConfig> {
    return await this.withMutation(async () => {
      const machine = await (await this.getMachinesClient()).addWslDistro(distro ? { distro } : {});
      this.connectionsResource.setValue(this.upsertConnection(machine));
      return machine;
    });
  }

  /**
   * Puts a Windows repository into a WSL2 distro and starts its live mirror; see the contract.
   * Can take minutes.
   */
  async mirrorRepositoryToWsl(input: { windowsPath: string; name: string }): Promise<{
    machine: SshConfig;
    path: string;
    reused: boolean;
    notes: string[];
    mirror: WslMirrorInfo;
  }> {
    return await this.withMutation(async () => {
      // Installing a distro or Claude Code takes longer than a call's usual deadline.
      const result = await (
        await this.getMachinesClient()
      ).mirrorRepositoryToWsl(input, { timeoutMs: 0 });
      this.connectionsResource.setValue(this.upsertConnection(result.machine));
      this.putWslMirror(result.mirror);
      return result;
    });
  }

  /** The mirror of a project, found by either of its two folders. */
  wslMirrorFor(
    project: { type: 'local'; path: string } | { type: 'ssh'; connectionId: string; path: string }
  ): WslMirrorInfo | undefined {
    if (project.type === 'ssh') {
      return this.wslMirrors.find(
        (mirror) => mirror.machineId === project.connectionId && mirror.linuxPath === project.path
      );
    }
    const key = windowsPathKey(project.path);
    return this.wslMirrors.find((mirror) => windowsPathKey(mirror.windowsPath) === key);
  }

  async refreshWslMirrors(): Promise<void> {
    const mirrors = await (await this.getMachinesClient()).getWslMirrors(undefined);
    runInAction(() => {
      this.wslMirrors = mirrors;
    });
    this.watchWslMirrors();
  }

  /** Waits for a mirror's two sides to agree; a new mirror's first run can take a while. */
  async waitForWslMirror(id: string, timeoutMs: number): Promise<WslMirrorInfo> {
    const mirror = await (
      await this.getMachinesClient()
    ).waitForWslMirror({ id, timeoutMs }, { timeoutMs: 0 });
    this.putWslMirror(mirror);
    return mirror;
  }

  async setWslMirrorPaused(id: string, paused: boolean): Promise<void> {
    this.putWslMirror(await (await this.getMachinesClient()).setWslMirrorPaused({ id, paused }));
  }

  async syncWslMirror(id: string): Promise<void> {
    this.putWslMirror(await (await this.getMachinesClient()).syncWslMirror({ id }));
  }

  async removeWslMirror(id: string): Promise<void> {
    await (await this.getMachinesClient()).removeWslMirror({ id });
    runInAction(() => {
      this.wslMirrors = this.wslMirrors.filter((mirror) => mirror.id !== id);
    });
  }

  private putWslMirror(mirror: WslMirrorInfo): void {
    runInAction(() => {
      this.wslMirrors = [...this.wslMirrors.filter((known) => known.id !== mirror.id), mirror];
    });
    this.watchWslMirrors();
  }

  /** While there are mirrors, their state is read again every few seconds. */
  private watchWslMirrors(): void {
    if (this.wslMirrorTimer || !this.started || this.wslMirrors.length === 0) return;
    this.wslMirrorTimer = setInterval(() => {
      if (this.wslMirrors.length === 0) {
        clearInterval(this.wslMirrorTimer);
        this.wslMirrorTimer = undefined;
        return;
      }
      void this.refreshWslMirrors().catch(() => undefined);
    }, WSL_MIRROR_POLL_MS);
  }

  /** Asks a Maestro host's address who it is, without pairing or saving anything. */
  async inspectMaestroHost(
    input: InspectMaestroHostInput
  ): Promise<Result<MaestroHostInfo, MaestroHostError>> {
    return await (await this.getMachinesClient()).inspectMaestroHost(input);
  }

  async addMaestroHost(input: AddMaestroHostInput): Promise<Result<SshConfig, MaestroHostError>> {
    return await this.saveMaestroHost(async (client) => client.addMaestroHost(input), 'connect');
  }

  /** Pairs again after the host revoked this device, then retries the blocked connection. */
  async repairMaestroHost(
    input: RepairMaestroHostInput
  ): Promise<Result<SshConfig, MaestroHostError>> {
    return await this.saveMaestroHost(async (client) => client.repairMaestroHost(input), 'retry');
  }

  async updateMaestroHost(
    input: UpdateMaestroHostInput
  ): Promise<Result<SshConfig, MaestroHostError>> {
    return await this.saveMaestroHost(async (client) => client.updateMaestroHost(input), 'retry');
  }

  async setSyncLocalSettings(id: string, enabled: boolean): Promise<void> {
    await this.withMutation(async () => {
      const updated = await (await this.getMachinesClient()).setSyncLocalSettings({ id, enabled });
      this.connectionsResource.setValue(this.upsertConnection(updated));
    });
  }

  async getSshConfigHosts(): Promise<SshConfigHost[]> {
    return await (await this.getSshClient()).getSshConfigHosts(undefined);
  }

  async getSshConfigHost(alias: string): Promise<SshConfigHost> {
    return await (await this.getSshClient()).getSshConfigHost({ alias });
  }

  async renameConnection(id: string, name: string): Promise<void> {
    await this.withMutation(async () => {
      await (await this.getMachinesClient()).renameMachine({ id, name });
      const current = this.connectionsResource.data ?? [];
      this.connectionsResource.setValue(
        current.map((connection) => (connection.id === id ? { ...connection, name } : connection))
      );
    });
  }

  async deleteConnection(id: string): Promise<void> {
    await this.withMutation(async () => {
      await (await this.getMachinesClient()).deleteMachine({ id });
      const currentConnections = this.connectionsResource.data ?? [];
      this.connectionsResource.setValue(
        currentConnections.filter((connection) => connection.id !== id)
      );
    });
  }

  async testConnection(
    config: SshConfig & { password?: string; passphrase?: string }
  ): Promise<ConnectionTestResult> {
    return await (await this.getSshClient()).testConnection(config);
  }

  async installSystemDependencies(
    input: InstallMachineSystemDependenciesInput
  ): Promise<InstallMachineSystemDependenciesResult> {
    return await runSystemDependencyInstall(await this.getMachinesClient(), input);
  }

  private async saveMaestroHost(
    save: (client: MachinesClient) => Promise<Result<SshConfig, MaestroHostError>>,
    cause: 'connect' | 'retry'
  ): Promise<Result<SshConfig, MaestroHostError>> {
    const result = await this.withMutation(async () => {
      const saved = await save(await this.getMachinesClient());
      if (saved.success) this.connectionsResource.setValue(this.upsertConnection(saved.data));
      return saved;
    });
    // The machine is saved either way; a failed connection shows on its page with a Retry.
    if (result.success) {
      const request = cause === 'connect' ? this.connect : this.retry;
      await request.call(this, result.data.id).catch(() => {});
    }
    return result;
  }

  private get runtime(): SshConnectionsRuntime {
    return this.runtimeData;
  }

  private getSshClient(): Promise<SshClient> {
    this.sshClientPromise ??= this.sshClientOverride
      ? Promise.resolve(this.sshClientOverride)
      : getSshDomainClient();
    return this.sshClientPromise;
  }

  private getMachinesClient(): Promise<MachinesClient> {
    this.machinesClientPromise ??= this.machinesClientOverride
      ? Promise.resolve(this.machinesClientOverride)
      : getMachinesDomainClient();
    return this.machinesClientPromise;
  }

  private getHostsClient(): Promise<Pick<HostsClient, 'disconnect' | 'requestReady'>> {
    this.hostsClientPromise ??= this.hostsClientOverride
      ? Promise.resolve(this.hostsClientOverride)
      : getHostsClient();
    return this.hostsClientPromise;
  }

  private async initializeConnectionsModel(): Promise<void> {
    const client = await this.getSshClient();
    if (!this.started) return;

    const scope = createScope({ label: 'machines-store:ssh-connections' });
    const connectionsRemote = remote(sshContract.connections, client.connections, {
      scope,
      lingerMs: 15_000,
    });
    const model = connectionsRemote(undefined);

    observe(
      model.states.runtime,
      (snapshot) => {
        const runtime = snapshot.value ?? {};
        runInAction(() => {
          this.runtimeData = runtime;
          if (snapshot.status !== 'loading') this.modelReady = true;
        });
      },
      { scope }
    );

    runInAction(() => {
      this.modelScope = scope;
    });
    await whenReady(model.states.runtime, { scope });

    if (!this.started || this.modelScope !== scope) {
      await scope.dispose();
      return;
    }
  }

  private async ensureConnectionsModel(): Promise<void> {
    await this.start();
    if (!this.modelReady) throw new Error('SSH connections model is not ready');
  }

  private upsertConnection(savedConnection: SshConfig): SshConfig[] {
    const current = this.connectionsResource.data ?? [];
    const index = current.findIndex((connection) => connection.id === savedConnection.id);
    if (index === -1) return [...current, savedConnection];

    const next = [...current];
    next[index] = savedConnection;
    return next;
  }

  private async withMutation<T>(run: () => Promise<T>): Promise<T> {
    runInAction(() => {
      this.pendingMutations += 1;
    });

    try {
      return await run();
    } finally {
      runInAction(() => {
        this.pendingMutations = Math.max(0, this.pendingMutations - 1);
      });
    }
  }
}

export function createSystemDependenciesStore(): SystemDependenciesStore {
  return {
    installSystemDependencies: async (input: InstallMachineSystemDependenciesInput) =>
      await runSystemDependencyInstall(await getMachinesDomainClient(), input),
  };
}

async function runSystemDependencyInstall(
  client: MachinesClient,
  input: InstallMachineSystemDependenciesInput
): Promise<InstallMachineSystemDependenciesResult> {
  const result = await runDesktopLiveJob(
    machinesContract.installSystemDependencies,
    client.installSystemDependencies,
    input
  );
  if (!result.success) throw new Error(getHostDependencyErrorMessage(result.error));
  return result.data;
}
