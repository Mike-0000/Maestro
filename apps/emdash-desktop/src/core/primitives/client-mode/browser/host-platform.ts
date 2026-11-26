import { useSyncExternalStore } from 'react';
import type { NodePlatform } from '@core/primitives/desktop-host/api/host-contract';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { log } from '@core/primitives/logging/browser/logger';
import { isClientMode } from './client-mode';

let platform: NodePlatform | undefined;
let pending: Promise<NodePlatform> | undefined;
const listeners = new Set<() => void>();

/**
 * The platform of the computer that runs projects, agents and terminals. In client mode that is
 * the remote host, answered by its `host.getPlatform`; the answer is fetched once per window.
 * Local mode never calls this: decisions about this computer read it directly.
 */
export function loadHostPlatform(): Promise<NodePlatform> {
  pending ??= getHostClient()
    .then((client) => client.getPlatform())
    .then((value) => {
      platform = value;
      for (const listener of listeners) listener();
      return value;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (isClientMode() && platform === undefined) {
    loadHostPlatform().catch((error: unknown) => {
      log.warn('Could not read the host platform', { error });
    });
  }
  return () => listeners.delete(listener);
}

function snapshot(): NodePlatform | undefined {
  return platform;
}

/**
 * The remote host's platform in client mode, undefined until it is known. Always undefined in
 * local mode, where it makes no call; branch on `isClientMode()` and keep the local decision.
 */
export function useHostPlatform(): NodePlatform | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Tests only: forget the cached answer, or seed one. */
export function setHostPlatformForTesting(value: NodePlatform | undefined): void {
  platform = value;
  pending = value === undefined ? undefined : Promise.resolve(value);
}
