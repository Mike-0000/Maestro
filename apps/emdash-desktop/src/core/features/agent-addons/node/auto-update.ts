import type { HostRef } from '@emdash/core/primitives/host/api';
import type { InstalledAddon } from '@emdash/core/runtimes/agent-config/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import type { AddonDefinition } from './addon-definition';
import { ADDONS } from './addons';

export type AddonAutoUpdateOutcome = {
  addonId: string;
  providerId: string;
  from: number;
  to: number;
  result: 'updated' | 'conflict' | 'failed';
  detail?: string;
};

export type UpdateInstalledAddonsOptions = Readonly<{
  runtimes: Pick<RuntimeBroker, 'client'>;
  host: HostRef;
  addons?: readonly AddonDefinition[];
  /**
   * The host's add-on list starts empty and fills once its runtime has read its receipts, so an
   * empty first read is retried after each of these delays before concluding nothing is installed.
   */
  emptyRetryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
}>;

const DEFAULT_EMPTY_RETRY_DELAYS_MS = [1_000, 4_000];

/**
 * Bring every add-on already installed on a host up to the version this Maestro ships. It never
 * installs an add-on the developer hasn't, and never replaces files they edited: those come back
 * as `conflict`, and the Add-ons page keeps offering Update so they can decide.
 */
export async function updateInstalledAddons(
  options: UpdateInstalledAddonsOptions
): Promise<AddonAutoUpdateOutcome[]> {
  const addons = options.addons ?? ADDONS;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runtime = await options.runtimes.client(options.host);
  if (!runtime.success) return [];
  const agentConfig = runtime.data.agentConfig;

  const readInstalled = async (): Promise<InstalledAddon[]> =>
    (await agentConfig.addons.state(undefined, 'list').snapshot()).data;
  let installed = await readInstalled();
  for (const delay of options.emptyRetryDelaysMs ?? DEFAULT_EMPTY_RETRY_DELAYS_MS) {
    if (installed.length > 0) break;
    await wait(delay);
    installed = await readInstalled();
  }

  const outcomes: AddonAutoUpdateOutcome[] = [];
  for (const addon of addons) {
    for (const target of addon.targets) {
      const record = installed.find(
        (entry) => entry.id === addon.id && entry.providerId === target.providerId
      );
      if (!record || record.version >= addon.version) continue;
      const base = {
        addonId: addon.id,
        providerId: target.providerId,
        from: record.version,
        to: addon.version,
      };
      try {
        const result = await agentConfig.installAddon({
          addon: { id: addon.id, version: addon.version, ...target },
        });
        if (result.success) outcomes.push({ ...base, result: 'updated' });
        else if (result.error.type === 'conflict')
          outcomes.push({ ...base, result: 'conflict', detail: result.error.paths.join(', ') });
        else outcomes.push({ ...base, result: 'failed', detail: describeError(result.error) });
      } catch (error) {
        outcomes.push({
          ...base,
          result: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcomes;
}

function describeError(error: { type: string }): string {
  return 'message' in error && typeof error.message === 'string' ? error.message : error.type;
}
