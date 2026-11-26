import type { Logger } from '@emdash/shared/logger';
import type { OwnerExternalOpenRequest } from '@core/features/client-mode/api/owner-contract';
import type { OwnerHostClient } from '../host-link';

// Pages the host wanted to open in a browser (an OAuth sign-in, for example) open on this
// computer instead. Only web addresses are opened. A request for the host's own loopback needs a
// local mirror of that port first, which `openLoopback` provides (the tunnel workstream); without
// it such a request is logged and dropped, because `localhost` here is not the host.

export function startExternalOpenBridge(options: {
  host: () => Promise<OwnerHostClient>;
  openExternal(url: string): Promise<void>;
  openLoopback?: (request: OwnerExternalOpenRequest) => Promise<void>;
  signal: AbortSignal;
  log: Pick<Logger, 'info' | 'warn'>;
}): void {
  const handle = async (request: OwnerExternalOpenRequest): Promise<void> => {
    if (!isWebUrl(request.url)) {
      options.log.warn('client: refused a host open request that is not a web address');
      return;
    }
    if (request.loopbackPort !== undefined) {
      if (!options.openLoopback) {
        options.log.warn('client: cannot open a host loopback page without the tunnel bridge', {
          port: request.loopbackPort,
        });
        return;
      }
      await options.openLoopback(request);
      return;
    }
    await options.openExternal(request.url);
  };

  void options
    .host()
    .then((owner) =>
      owner.bridge.externalOpenRequests.subscribe(undefined, {
        onEvent: (request) => {
          handle(request).catch((error: unknown) =>
            options.log.warn('client: opening a host page failed', { error })
          );
        },
        signal: options.signal,
      })
    )
    .catch((error: unknown) => {
      if (options.signal.aborted) return;
      options.log.warn('client: host open requests unavailable', { error });
    });
}

export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
