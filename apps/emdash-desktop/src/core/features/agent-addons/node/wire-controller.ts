import type { HostRef } from '@emdash/core/primitives/host/api';
import type { InstalledAddon } from '@emdash/core/runtimes/agent-config/api';
import {
  runtimeResolveErrorAsError,
  type HostRuntimesClient,
  type RuntimeBroker,
} from '@emdash/core/services/runtime-broker/api';
import { err, ok, type Result } from '@emdash/shared';
import { createController, type CallMeta, type Controller } from '@emdash/wire/rpc';
import { getPluginMetadata } from '@core/features/agents/api/node/plugin-registry';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import {
  agentAddonsContract,
  type AddonCatalogEntry,
  type AgentAddonsError,
} from '../api/contract';
import type { AddonDefinition } from './addon-definition';
import { ADDONS } from './addons';

export type CreateAgentAddonsWireControllerOptions = Readonly<{
  runtimes: Pick<RuntimeBroker, 'client'>;
  addons?: readonly AddonDefinition[];
}>;

type AgentConfigClient = HostRuntimesClient['agentConfig'];
type AddonsResult = Result<{ addons: InstalledAddon[] }, AgentAddonsError>;

export function createAgentAddonsWireController(
  options: CreateAgentAddonsWireControllerOptions
): Controller {
  const addons = options.addons ?? ADDONS;
  const find = (addonId: string) => addons.find((addon) => addon.id === addonId);

  return createController(agentAddonsContract, {
    catalog: async () => addons.map(toCatalogEntry),
    installed: forwardLiveModel(agentAddonsContract.installed, async (key, name) => {
      const runtime = await options.runtimes.client(key.host);
      if (!runtime.success) throw runtimeResolveErrorAsError(runtime.error);
      return runtime.data.agentConfig.addons.state(undefined, name).asLiveSource();
    }),
    install: (input, meta) => {
      const addon = find(input.addonId);
      if (!addon) return Promise.resolve(err({ type: 'unknown-addon', addonId: input.addonId }));
      return withAgentConfig(options.runtimes, input.host, async (client) => {
        let last: AddonsResult = ok({ addons: [] });
        for (const target of addon.targets) {
          last = await client.installAddon(
            {
              addon: { id: addon.id, version: addon.version, ...target },
              replace: input.replace,
            },
            callOptions(meta)
          );
          if (!last.success) return last;
        }
        return last;
      });
    },
    remove: (input, meta) => {
      const addon = find(input.addonId);
      if (!addon) return Promise.resolve(err({ type: 'unknown-addon', addonId: input.addonId }));
      return withAgentConfig(options.runtimes, input.host, async (client) => {
        let removed: AddonsResult | undefined;
        let notInstalled: AddonsResult | undefined;
        for (const target of addon.targets) {
          const result = await client.removeAddon(
            { id: addon.id, providerId: target.providerId },
            callOptions(meta)
          );
          // A target that was never installed is fine to skip; any other failure stops here.
          if (!result.success && result.error.type === 'invalid-state') notInstalled = result;
          else if (!result.success) return result;
          else removed = result;
        }
        return removed ?? notInstalled ?? ok({ addons: [] });
      });
    },
  });
}

function toCatalogEntry(addon: AddonDefinition): AddonCatalogEntry {
  return {
    id: addon.id,
    name: addon.name,
    summary: addon.summary,
    description: addon.description,
    version: addon.version,
    targets: addon.targets.map((target) => ({
      providerId: target.providerId,
      providerName: getPluginMetadata(target.providerId).name,
      files: target.files.map((file) => file.path),
      ...(target.instructions ? { instructions: target.instructions } : {}),
    })),
  };
}

async function withAgentConfig(
  runtimes: Pick<RuntimeBroker, 'client'>,
  host: HostRef,
  work: (client: AgentConfigClient) => Promise<AddonsResult>
): Promise<AddonsResult> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtime.error);
  return await work(runtime.data.agentConfig);
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}
