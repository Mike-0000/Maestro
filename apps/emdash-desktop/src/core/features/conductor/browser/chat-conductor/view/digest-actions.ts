import { decideBrowserUrl } from '../../../api/chat-conductor/browser-policy';
import type { ChatDigest } from '../../../api/chat-conductor/digest';

/**
 * Which actions a digest card offers. `done` archives the task: only on the newest digest, when
 * the work is finished. `openApp` holds the address to open, or why it is refused (the address
 * came from a model reading agent output, so only the task's dev servers pass), or null when the
 * digest names no app. `merge` offers the integrate modal on the newest digest when the task can
 * be integrated.
 */
export type DigestActions = {
  done: boolean;
  openApp: { url: string } | { refused: string } | null;
  merge: boolean;
};

export function digestActions(input: {
  digest: ChatDigest;
  latest: boolean;
  canIntegrate: boolean;
  devServerOrigins: readonly string[];
}): DigestActions {
  return {
    done: input.latest && input.digest.outcome === 'finished',
    openApp: openApp(input.digest.appUrl, input.devServerOrigins),
    merge: input.latest && input.canIntegrate,
  };
}

function openApp(
  appUrl: string | undefined,
  devServerOrigins: readonly string[]
): DigestActions['openApp'] {
  if (appUrl === undefined || appUrl.trim().length === 0) return null;
  const decision = decideBrowserUrl(appUrl, {
    trigger: 'event',
    developerWords: null,
    devServerOrigins,
    publicWebEnabled: false,
  });
  if (!decision.ok) return { refused: decision.reason };
  if (decision.url === 'about:blank') return { refused: 'There is no page to open.' };
  return { url: decision.url };
}
