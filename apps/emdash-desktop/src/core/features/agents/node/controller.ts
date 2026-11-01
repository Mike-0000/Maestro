import type {
  HostDependencyError,
  HostDependencySelection,
} from '@emdash/core/primitives/host-dependencies/api';
import type {
  DependencyId,
  HostDependencyOperationProgress,
  HostDependencySnapshot,
} from '@emdash/core/services/host-dependencies/node';
import { hostDependenciesContract } from '@emdash/core/services/host-dependencies/node';
import type { HostDependenciesContract } from '@emdash/core/services/host-dependencies/node';
import { runtimeResolveErrorAsError } from '@emdash/core/services/runtime-broker/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { err, ok, type Result } from '@emdash/shared';
import type { ContractClient } from '@emdash/wire/rpc';
import type { InstallMethod } from '@core/primitives/agents/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';
import type { ProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';
import { toAgentUpdateError } from './agent-error-mapping';
import {
  buildAgentMetadataList,
  buildAgentPayload,
  buildAgentPayloads,
  toAgentInstallationStatus,
} from './agent-payload-builder';

/** How old a probe may be before a status read starts another in the background. */
const PROBE_STALE_MS = 5 * 60_000;

export type HostDependenciesClient = ContractClient<HostDependenciesContract>;
export type AgentOperationContext = {
  signal?: AbortSignal;
  progress?: (progress: HostDependencyOperationProgress) => void;
};

export function createAgentOperations(dependencies: {
  ensureAgentDependenciesProbed(manager: HostDependenciesClient): Promise<void>;
  getDependencyManager(
    connectionId?: string
  ): Promise<Result<HostDependenciesClient, Parameters<typeof runtimeResolveErrorAsError>[0]>>;
  providerOverrideSettings: ProviderOverrideSettings;
}) {
  const { getDependencyManager, providerOverrideSettings } = dependencies;
  const probes = new ProbeSchedule(dependencies.ensureAgentDependenciesProbed);
  const snapshotFor = async (manager: HostDependenciesClient): Promise<HostDependencySnapshot> => {
    await probes.beforeRead(manager);
    const snapshot = await manager.snapshot.state(undefined, 'current').snapshot();
    return snapshot.data;
  };
  return {
    // ── Metadata ────────────────────────────────────────────────────────────────

    list: async (connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr);
      return buildAgentPayloads(providerOverrideSettings, snapshot, connectionId);
    },

    get: async (id: string, connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr);
      return buildAgentPayload(providerOverrideSettings, id, snapshot, connectionId);
    },

    // ── Installation status ──────────────────────────────────────────────────────

    listAgentInstallationStatus: async (
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr);
      return Object.values(snapshot.dependencies)
        .filter((view) => view.definition.category === 'agent')
        .map((view) => toAgentInstallationStatus(view.definition.id, connectionId, view));
    },

    getAgentInstallationStatus: async (
      id: string,
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr);
      return toAgentInstallationStatus(id, connectionId, snapshot.dependencies[id]);
    },

    // ── Install / update ─────────────────────────────────────────────────────────

    update: async (
      id: AgentProviderId,
      connectionId?: string,
      method?: InstallMethod,
      elevate?: boolean,
      manager?: HostDependenciesClient,
      context: AgentOperationContext = {}
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = method
        ? await runRuntimeLiveJob(
            hostDependenciesContract.runInstallCommand,
            mgr.runInstallCommand,
            { id, method, elevate, commandKind: 'update' },
            context.progress,
            { signal: context.signal }
          )
        : await runRuntimeLiveJob(
            hostDependenciesContract.runSelfUpdateCommand,
            mgr.runSelfUpdateCommand,
            { id },
            context.progress,
            { signal: context.signal }
          );
      if (result.success) {
        return {
          success: true as const,
          data: toAgentInstallationStatus(id, connectionId, result.data),
        };
      }
      return { success: false as const, error: toAgentUpdateError(result.error, id) };
    },

    install: async (
      id: AgentProviderId,
      connectionId?: string,
      method?: InstallMethod,
      elevate?: boolean,
      manager?: HostDependenciesClient,
      context: AgentOperationContext = {}
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await runRuntimeLiveJob(
        hostDependenciesContract.runInstallCommand,
        mgr.runInstallCommand,
        { id, method, elevate },
        context.progress,
        { signal: context.signal }
      );
      if (result.success) {
        return {
          success: true as const,
          data: toAgentInstallationStatus(id, connectionId, result.data),
        };
      }
      return { success: false as const, error: result.error };
    },

    uninstall: async (id: AgentProviderId, _connectionId?: string, _method?: InstallMethod) => ({
      success: false as const,
      error: { type: 'no-uninstall-strategy' as const, id },
    }),

    // ── Settings ─────────────────────────────────────────────────────────────────

    getDefaultSettings: async (id: string): Promise<ProviderCustomConfig> => {
      const meta = await providerOverrideSettings.getItemWithMeta(id);
      return meta.defaults;
    },

    getSettings: async (id: string) => {
      return providerOverrideSettings.getItemWithMeta(id);
    },

    updateSettings: (id: string, config: Partial<ProviderCustomConfig>): Promise<void> =>
      providerOverrideSettings.updateItem(id, config),

    // ── Selection + probe ────────────────────────────────────────────────────────

    setUsedInstallation: async (
      id: DependencyId,
      connectionId: string | undefined,
      selection: HostDependencySelection,
      manager?: HostDependenciesClient
    ): Promise<Result<void, HostDependencyError>> => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await mgr.snapshot.mutate('setSelection', {
        key: undefined,
        input: { id, selection },
      });
      return result.success ? ok() : err(result.error);
    },

    probe: async (id: DependencyId, connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await mgr.snapshot.mutate('refresh', {
        key: undefined,
        input: { id },
      });
      return result.success ? result.data.data.dependencies[id] : result;
    },

    resolveInstallation: async (
      id: DependencyId,
      selection: HostDependencySelection | undefined,
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      return mgr.resolver.resolve(selection === undefined ? { id } : { id, selection });
    },

    refreshLatestVersion: async (_id: DependencyId, _connectionId?: string): Promise<void> => {},

    probeAll: async (connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      await probes.now(mgr);
    },

    listMetadata: async () => {
      return buildAgentMetadataList();
    },
  };
}

export type AgentOperations = ReturnType<typeof createAgentOperations>;

async function resolveDependencyManager(
  getDependencyManager: (
    connectionId?: string
  ) => ReturnType<Parameters<typeof createAgentOperations>[0]['getDependencyManager']>,
  connectionId?: string,
  manager?: HostDependenciesClient
): Promise<HostDependenciesClient> {
  if (manager) return manager;
  const result = await getDependencyManager(connectionId);
  if (!result.success) throw runtimeResolveErrorAsError(result.error);
  return result.data;
}

/**
 * Decides when reading agent status also re-checks what is installed. The first read for a host
 * waits for a probe. Later reads answer from the snapshot at once, and past `PROBE_STALE_MS` start
 * one in the background so a CLI installed outside the app still shows up. Probing on every read
 * ran one lookup per known CLI each time, in series and in the main process; on a slow machine a
 * pass outlasted the 30 s wire deadline, so the callers failed and asked again.
 */
class ProbeSchedule {
  private readonly lastProbes = new WeakMap<
    HostDependenciesClient,
    { startedAt: number; done: Promise<void> }
  >();
  private readonly probed = new WeakSet<HostDependenciesClient>();

  constructor(private readonly probe: (manager: HostDependenciesClient) => Promise<void>) {}

  async beforeRead(manager: HostDependenciesClient): Promise<void> {
    const last = this.lastProbes.get(manager);
    if (!this.probed.has(manager)) {
      // Nothing to answer from yet: wait for the first probe, joining one already running.
      await (last ? last.done : this.now(manager));
      return;
    }
    if (last && Date.now() - last.startedAt >= PROBE_STALE_MS) {
      this.now(manager).catch(() => {
        // The snapshot being served is still the last good answer; a later read tries again.
      });
    }
  }

  now(manager: HostDependenciesClient): Promise<void> {
    const entry = {
      startedAt: Date.now(),
      done: this.probe(manager).then(
        () => {
          this.probed.add(manager);
        },
        (error: unknown) => {
          // With nothing probed yet, the next read must probe rather than join this failure.
          if (!this.probed.has(manager) && this.lastProbes.get(manager) === entry) {
            this.lastProbes.delete(manager);
          }
          throw error;
        }
      ),
    };
    this.lastProbes.set(manager, entry);
    return entry.done;
  }
}
