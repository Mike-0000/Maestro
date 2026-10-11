import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { hostDependenciesContract } from '@emdash/core/services/host-dependencies/node';
import {
  runtimeResolveErrorAsError,
  type RuntimeBroker,
  type HostRuntimesClient,
} from '@emdash/core/services/runtime-broker/api';
import { err, ok } from '@emdash/shared';
import { createController, type Controller, type LiveModelProvider } from '@emdash/wire/rpc';
import type { MachinesService } from '@core/features/machines/api/node/machines-service';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';
import type { InstallMachineSystemDependenciesResult } from '../api';
import { machinesContract } from '../api';
import type { MaestroHostError } from '../api/maestro-host';
import { mapSystemDependencyView, systemDependencyIds } from '../api/system-dependencies';
import type { MaestroHostsService } from './maestro-hosts-service';

export function createMachinesWireController(
  service: MachinesService,
  runtimes: RuntimeBroker,
  maestroHosts?: MaestroHostsService
): Controller {
  const maestro = async <T>(run: (hosts: MaestroHostsService) => Promise<T>) =>
    maestroHosts ? await run(maestroHosts) : err(MAESTRO_HOSTS_UNAVAILABLE);
  return createController(machinesContract, {
    getMachines: () => service.getMachines(),
    getMachineUsage: () => service.getMachineUsage(),
    getMachineMetrics: async ({ machineId }) => {
      const runtime = await resolveMachineRuntime(runtimes, machineId);
      const sample = await runtime.resourceUsage.sample(undefined);
      if (!sample.success) throw new Error(sample.error.message);
      return sample.data;
    },
    systemDependencies: createSystemDependenciesModelProvider(runtimes),
    installSystemDependencies: {
      run: async ({ machineId, dependencies }, context) => {
        const mapped: InstallMachineSystemDependenciesResult = {};
        const requests = dependencies.filter(({ id }) => {
          if (systemDependencyIds.has(id)) return true;
          mapped[id] = err({ type: 'unknown-dependency', id });
          return false;
        });
        if (requests.length === 0) return ok(mapped);

        const runtime = await resolveMachineRuntime(runtimes, machineId);
        const result = await runRuntimeLiveJob(
          hostDependenciesContract.runInstallBatch,
          runtime.hostDependencies.runInstallBatch,
          { requests },
          context.progress,
          { signal: context.signal }
        );
        if (!result.success) {
          for (const { id } of requests) mapped[id] = err(result.error);
          return ok(mapped);
        }
        for (const { id } of requests) {
          const entry = result.data[id];
          mapped[id] = !entry
            ? err({ type: 'io', message: `Install result missing for dependency: ${id}` })
            : entry.success
              ? ok(mapSystemDependencyView(entry.data))
              : err(entry.error);
        }
        return ok(mapped);
      },
      toError: (error) => ({
        type: 'io',
        message: error instanceof Error ? error.message : String(error),
      }),
    },
    hostSettings: forwardLiveModel(machinesContract.hostSettings, async (key, name) => {
      const runtime = await resolveMachineRuntime(runtimes, key.machineId);
      // The upstream live model is itself named `state` on the host-settings contract.
      return runtime.hostSettings.state.state(undefined, name).asLiveSource();
    }),
    updateHostSettings: async ({ machineId, patch }) => {
      const runtime = await resolveMachineRuntime(runtimes, machineId);
      return runtime.hostSettings.update(patch);
    },
    saveMachine: (input) => service.saveMachine(input),
    addThisComputer: () => service.addThisComputer(),
    addWslDistro: ({ distro }) => service.addWslDistro(distro),
    mirrorRepositoryToWsl: (input) => service.mirrorRepositoryToWsl(input),
    getWslMirrors: () => service.getWslMirrors(),
    waitForWslMirror: ({ id, timeoutMs }) => service.waitForWslMirror(id, timeoutMs),
    setWslMirrorPaused: ({ id, paused }) => service.setWslMirrorPaused(id, paused),
    syncWslMirror: ({ id }) => service.syncWslMirror(id),
    removeWslMirror: ({ id }) => service.removeWslMirror(id),
    inspectMaestroHost: (input) => maestro((hosts) => hosts.inspect(input)),
    addMaestroHost: (input) => maestro((hosts) => hosts.add(input)),
    repairMaestroHost: (input) => maestro((hosts) => hosts.repair(input)),
    updateMaestroHost: (input) => maestro((hosts) => hosts.update(input)),
    setSyncLocalSettings: ({ id, enabled }) => service.setSyncLocalSettings(id, enabled),
    deleteMachine: ({ id }) => service.deleteMachine(id),
    renameMachine: ({ id, name }) => service.renameMachine(id, name),
  });
}

const MAESTRO_HOSTS_UNAVAILABLE: MaestroHostError = {
  type: 'failed',
  message: 'Maestro hosts are not available in this build.',
};

function createSystemDependenciesModelProvider(
  runtimes: RuntimeBroker
): LiveModelProvider<typeof machinesContract.systemDependencies> {
  const contract = machinesContract.systemDependencies;
  const sourceStateId = hostDependenciesContract.snapshot.states.current.id;
  const targetStateId = contract.states.current.id;

  return {
    kind: 'liveModelProvider',
    contract,
    resolveState: async (key, name) => {
      const runtime = await resolveMachineRuntime(runtimes, key.machineId);
      return runtime.hostDependencies.snapshot.state(undefined, name).asLiveSource();
    },
    async runMutation(_name, envelope) {
      const runtime = await resolveMachineRuntime(runtimes, envelope.key.machineId);
      const result = await runtime.hostDependencies.snapshot.mutate('refresh', {
        ...envelope,
        key: undefined,
        input: {},
      });
      if (!result.success) {
        return result as Awaited<ReturnType<LiveModelProvider<typeof contract>['runMutation']>>;
      }
      return ok({
        ...result.data,
        cursors: result.data.cursors.map((cursor) => ({
          ...cursor,
          model: cursor.model === sourceStateId ? targetStateId : cursor.model,
          key: envelope.key,
        })),
      }) as Awaited<ReturnType<LiveModelProvider<typeof contract>['runMutation']>>;
    },
  };
}

async function resolveMachineRuntime(
  runtimes: RuntimeBroker,
  machineId?: string
): Promise<HostRuntimesClient> {
  const runtime = await runtimes.client(machineId ? hostRef('remote', machineId) : LOCAL_HOST_REF);
  if (!runtime.success) throw runtimeResolveErrorAsError(runtime.error);
  return runtime.data;
}
