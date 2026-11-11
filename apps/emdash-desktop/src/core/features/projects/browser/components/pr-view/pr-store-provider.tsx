import { EmptyState } from '@emdash/ui/react/components';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getPullRequestsRuntimeClient } from '@root/src/core/services/pull-requests/api/client';
import {
  PullRequestsStore,
  PullRequestsStoreProvider,
} from '@root/src/core/services/pull-requests/browser';

export function ProjectPullRequestsProvider({
  repositoryUrls,
  children,
}: {
  repositoryUrls: string[];
  children: ReactNode;
}) {
  const [store, setStore] = useState<PullRequestsStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repositoryKey = repositoryUrls.join('\n');
  const stableRepositoryUrls = useMemo(
    () => (repositoryKey ? repositoryKey.split('\n') : []),
    [repositoryKey]
  );

  useEffect(() => {
    let disposed = false;
    let createdStore: PullRequestsStore | undefined;
    setError(null);
    void getPullRequestsRuntimeClient()
      .then(async (client) => {
        if (disposed) return;
        // The list view's lifecycle (initialize/dispose) is owned by the
        // `view.Root` the PR view renders, not by this provider.
        createdStore = new PullRequestsStore(client, stableRepositoryUrls);
        await createdStore.ready;
        if (disposed) {
          await createdStore.dispose();
          return;
        }
        setStore(createdStore);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      setStore(null);
      if (createdStore) void createdStore.dispose();
    };
  }, [stableRepositoryUrls]);

  if (error) {
    return <EmptyState tone="error" label="Could not load pull requests" details={error} />;
  }
  if (!store) {
    return <EmptyState tone="loading" label="Loading pull requests…" />;
  }
  return <PullRequestsStoreProvider store={store}>{children}</PullRequestsStoreProvider>;
}
