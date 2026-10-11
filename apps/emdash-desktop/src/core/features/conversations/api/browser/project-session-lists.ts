import type { SerializedHostRef } from '@emdash/core/primitives/host/api';
import type { SessionSummary } from '@emdash/core/runtimes/acp/api/client';
import type { TuiSessionList } from '@emdash/core/runtimes/tui-agents/api';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { observe, remote } from '@emdash/wire/state';
import { reaction } from 'mobx';
import { conversationsContract } from '@core/features/conversations/api';
import type { ProjectHostAccess } from '@core/features/projects/api/browser/stores/project-context';
import { getConversationsClient } from './client';

export type ProjectSessionLists = {
  tui: TuiSessionList;
  acp: Record<string, SessionSummary>;
  hasObservedTui: boolean;
  hasObservedAcp: boolean;
};

type Listener = (lists: ProjectSessionLists) => void;

type CacheEntry = {
  refCount: number;
  lists: ProjectSessionLists;
  listeners: Set<Listener>;
  dispose: () => void;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(projectId: string, host: SerializedHostRef): string {
  return `${projectId}:${JSON.stringify(host)}`;
}

/**
 * One TUI/ACP session-list remote per project+host. Conversation managers subscribe
 * locally instead of each opening their own Wire remote of the same map.
 *
 * Each subscriber follows its own `sessionHost`: a task learns its host only once it is
 * provisioned, so a subscriber starts on the local host and moves when its task does. Sharing one
 * subscriber's host with the rest would show every agent of the project as stopped whenever that
 * one task was asleep, archived, or gone.
 */
export function acquireProjectSessionLists(
  projectId: string,
  sessionHost: () => SerializedHostRef,
  hostAccess: ProjectHostAccess | undefined,
  listener: Listener
): () => void {
  if (typeof window === 'undefined') return () => {};

  let detach: (() => void) | undefined;
  const disposeHostReaction = reaction(
    () => sessionHost(),
    (host) => {
      detach?.();
      detach = attach(projectId, host, hostAccess, listener);
    },
    { fireImmediately: true }
  );

  return () => {
    disposeHostReaction();
    detach?.();
    detach = undefined;
  };
}

function attach(
  projectId: string,
  host: SerializedHostRef,
  hostAccess: ProjectHostAccess | undefined,
  listener: Listener
): () => void {
  const key = cacheKey(projectId, host);
  let entry = cache.get(key);
  if (!entry) {
    entry = openEntry(projectId, host, hostAccess);
    cache.set(key, entry);
  }
  const attached = entry;
  attached.refCount += 1;
  attached.listeners.add(listener);
  listener(attached.lists);

  return () => {
    attached.listeners.delete(listener);
    attached.refCount -= 1;
    if (attached.refCount > 0) return;
    attached.dispose();
    if (cache.get(key) === attached) cache.delete(key);
  };
}

/** Observes one host's session lists for a project while that project's host is reachable. */
function openEntry(
  projectId: string,
  host: SerializedHostRef,
  hostAccess: ProjectHostAccess | undefined
): CacheEntry {
  const lists: ProjectSessionLists = {
    tui: {},
    acp: {},
    hasObservedTui: false,
    hasObservedAcp: false,
  };
  const listeners = new Set<Listener>();
  let currentScope: Scope | undefined;
  const disposeReaction = reaction(
    () => hostAccess?.state.kind,
    (accessKind) => {
      void currentScope?.dispose();
      currentScope = undefined;
      if (accessKind !== undefined && accessKind !== 'ready') return;
      currentScope = createScope({ label: `project-session-lists:${projectId}` });
      const scope = currentScope;
      void (async () => {
        const client = await getConversationsClient();
        if (scope.disposed) return;
        const tuiSessions = remote(conversationsContract.tui.sessions, client.tui.sessions, {
          scope,
          lingerMs: 15_000,
        });
        const acpSessions = remote(conversationsContract.acp.sessions, client.acp.sessions, {
          scope,
          lingerMs: 15_000,
        });
        observe(
          tuiSessions({ host, projectId }).states.list,
          (snapshot) => {
            lists.tui = snapshot.value ?? {};
            lists.hasObservedTui = true;
            notify(listeners, lists);
          },
          { scope }
        );
        observe(
          acpSessions({ host, projectId }).states.list,
          (snapshot) => {
            lists.acp = snapshot.value ?? {};
            lists.hasObservedAcp = true;
            notify(listeners, lists);
          },
          { scope }
        );
      })();
    },
    { fireImmediately: true }
  );
  return {
    refCount: 0,
    lists,
    listeners,
    dispose: () => {
      disposeReaction();
      void currentScope?.dispose();
      currentScope = undefined;
    },
  };
}

function notify(listeners: Set<Listener>, lists: ProjectSessionLists): void {
  for (const listener of listeners) listener(lists);
}

export function resetProjectSessionListsForTests(): void {
  for (const entry of cache.values()) entry.dispose();
  cache.clear();
}
