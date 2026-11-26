import type { PendingLease } from '@emdash/shared';
import { WireError, type Controller, type LiveSource } from '@emdash/wire/rpc';
import { isHostServedPath } from '@core/manifests/shared/client-mode-routing';

// The `desktop.*` part of the owner link. An owner client is served the host's own desktop
// contract, but only the endpoints `clientModeRouting` marks host-served: the client's window,
// dialogs, clipboard and in-app browser belong to the client's computer, so asking the host for
// them is a mistake at best (`desktop.host.openExternal` would open a browser on the host).

export const OWNER_DESKTOP_PREFIX = 'desktop.';

/**
 * Wraps the host's desktop controller (paths `<domain>.<rest>`) as the owner's `desktop` mount
 * (paths `desktop.<domain>.<rest>`). Anything not host-served answers `NOT_FOUND`.
 */
export function createOwnerDesktopFilter(desktop: Controller): Controller {
  return {
    async call(path, input, meta) {
      const inner = hostServedDesktopPath(path);
      if (inner === undefined) throw notServed(path);
      return await desktop.call(inner, input, meta);
    },
    resolveLive(topic) {
      const inner = hostServedDesktopTopic(topic);
      return inner === undefined ? refusedLiveSource(topic) : desktop.resolveLive(inner);
    },
    acquireLive(topic) {
      const inner = hostServedDesktopTopic(topic);
      return inner === undefined ? refusedLiveLease(topic) : desktop.acquireLive(inner);
    },
  };
}

/**
 * The desktop controller's path for an owner path, or undefined when the host does not serve
 * it. `path` must be `desktop.<domain>.<endpoint path>`.
 */
export function hostServedDesktopPath(path: string): string | undefined {
  if (!path.startsWith(OWNER_DESKTOP_PREFIX)) return undefined;
  const inner = path.slice(OWNER_DESKTOP_PREFIX.length);
  const separator = inner.indexOf('.');
  if (separator <= 0 || separator === inner.length - 1) return undefined;
  const domain = inner.slice(0, separator);
  const rest = inner.slice(separator + 1);
  return isHostServedPath(domain, rest) ? inner : undefined;
}

/** The same for a live topic (`<ref id>` or `<ref id>|<key>`); the key is kept as it is. */
export function hostServedDesktopTopic(topic: string): string | undefined {
  const keyAt = topic.indexOf('|');
  const refId = keyAt === -1 ? topic : topic.slice(0, keyAt);
  const inner = hostServedDesktopPath(refId);
  if (inner === undefined) return undefined;
  return keyAt === -1 ? inner : `${inner}${topic.slice(keyAt)}`;
}

function notServed(path: string): WireError {
  return new WireError('NOT_FOUND', `'${path}' is not served to a full-access client`);
}

/** A live source that refuses every use, for topics an owner may not reach. */
export function refusedLiveSource(topic: string, error = notServed(topic)): LiveSource {
  return {
    snapshot() {
      throw error;
    },
    subscribe() {
      throw error;
    },
  };
}

export function refusedLiveLease(
  topic: string,
  error = notServed(topic)
): PendingLease<LiveSource> {
  return {
    ready: async () => {
      throw error;
    },
    release: async () => {},
  };
}
