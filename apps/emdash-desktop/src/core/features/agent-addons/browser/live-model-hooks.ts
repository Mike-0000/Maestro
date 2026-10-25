import type { HostRef } from '@emdash/core/primitives/host/api';
import type { InstalledAddon } from '@emdash/core/runtimes/agent-config/api';
import { remote, type RemoteModel } from '@emdash/wire/state';
import { useMemo } from 'react';
import { agentAddonsContract } from '@core/features/agent-addons/api/contract';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';
import { getAgentAddonsClient } from './client';

let installedRemotePromise: Promise<RemoteModel<typeof agentAddonsContract.installed>> | undefined;

export function useInstalledAddons(host: HostRef): { data: InstalledAddon[]; isLoading: boolean } {
  const key = useMemo(() => ({ host }), [host]);
  const state = useRemoteModelState(
    agentAddonsContract.installed,
    getInstalledRemote,
    key,
    'list',
    {
      initialValue: [],
    }
  );
  return { data: state.value ?? [], isLoading: state.isLoading };
}

function getInstalledRemote(): Promise<RemoteModel<typeof agentAddonsContract.installed>> {
  installedRemotePromise ??= getAgentAddonsClient().then((client) =>
    remote(agentAddonsContract.installed, client.installed, { lingerMs: 15_000 })
  );
  return installedRemotePromise;
}
