import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { RemoteAccessTailscale } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';

/**
 * Tailscale's forwarding state, read from the Tailscale CLI on demand. It is re-read
 * whenever the listener it forwards to changes (`listenerKey`), when the window regains
 * focus (the person may have just installed or signed in), and through `refresh`.
 */
export function useRemoteAccessTailscale(listenerKey: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['remoteAccess', 'tailscale', listenerKey], [listenerKey]);
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<RemoteAccessTailscale> =>
      (await getRemoteAccessClient()).getTailscale(undefined),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const { refetch } = query;

  const refresh = useCallback(() => void refetch(), [refetch]);
  /** Adopts the state a `setTailscaleServe` call returned, without another CLI round trip. */
  const adopt = useCallback(
    (next: RemoteAccessTailscale) => queryClient.setQueryData(queryKey, next),
    [queryClient, queryKey]
  );

  return {
    tailscale: query.data,
    isFetching: query.isFetching,
    error: query.isError ? query.error : null,
    refresh,
    adopt,
  };
}
