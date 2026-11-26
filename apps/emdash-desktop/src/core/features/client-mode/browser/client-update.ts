import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopUpdateEvent, DesktopUpdateState } from '@core/features/updates/api';
import { getUpdatesClient, type UpdatesClient } from '@core/features/updates/api/browser/client';
import { errorMessage } from './client-session-format';

/** This client's own updater, reduced to what the build-mismatch screen shows. */
export type ClientUpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; version: string | null; percent: number | null }
  | { status: 'ready'; version: string | null }
  | { status: 'installing' }
  /** There is nothing newer to install on this side. */
  | { status: 'current' }
  | { status: 'failed'; message: string };

export type ClientUpdate = {
  state: ClientUpdateState;
  /** Checks for an update and downloads it when there is one. */
  start(): void;
  /** Restarts into the downloaded update. */
  install(): void;
};

/** The part of the `updates` domain the build-mismatch screen drives. */
export type ClientUpdatesPort = Pick<
  UpdatesClient,
  'check' | 'download' | 'getState' | 'quitAndInstall' | 'events'
>;

/** One sentence for the state, shown under the update buttons; null while idle. */
export function clientUpdateLine(state: ClientUpdateState): string | null {
  switch (state.status) {
    case 'idle':
      return null;
    case 'checking':
      return 'Checking for an update to this client…';
    case 'downloading': {
      const what = state.version ? `Downloading ${state.version}` : 'Downloading the update';
      return state.percent === null ? `${what}…` : `${what}, ${Math.round(state.percent)}%`;
    }
    case 'ready':
      return state.version
        ? `${state.version} is ready. Restart this client to finish.`
        : 'The update is ready. Restart this client to finish.';
    case 'installing':
      return 'Restarting to update…';
    case 'current':
      return 'This client is already on its newest build. Update the host instead.';
    case 'failed':
      return state.message;
  }
}

/**
 * Drives the client's own updater from a screen that shows before the app has booted, so it
 * talks to the `updates` domain directly instead of the app's update store.
 */
export function useClientUpdate(
  getClient: () => Promise<ClientUpdatesPort> = getUpdatesClient
): ClientUpdate {
  const [state, setState] = useState<ClientUpdateState>({ status: 'idle' });
  const getClientRef = useRef(getClient);
  getClientRef.current = getClient;
  const mounted = useRef(true);
  const running = useRef(false);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      unsubscribe.current?.();
      unsubscribe.current = undefined;
    };
  }, []);

  const settle = useCallback((next: ClientUpdateState) => {
    if (mounted.current) setState(next);
  }, []);

  const download = useCallback(
    async (client: ClientUpdatesPort, version: string | null) => {
      settle({ status: 'downloading', version, percent: null });
      const result = await client.download(undefined);
      if (!result.success) settle({ status: 'failed', message: result.error });
      else if (result.data.status === 'downloaded') {
        settle({ status: 'ready', version: result.data.availableVersion ?? version });
      }
    },
    [settle]
  );

  const applySnapshot = useCallback(
    async (client: ClientUpdatesPort, snapshot: DesktopUpdateState) => {
      const version = snapshot.availableVersion ?? null;
      switch (snapshot.status) {
        case 'available':
          return download(client, version);
        case 'downloading':
          return settle({
            status: 'downloading',
            version,
            percent: snapshot.downloadProgress?.percent ?? null,
          });
        case 'downloaded':
          return settle({ status: 'ready', version });
        case 'installing':
          return settle({ status: 'installing' });
        case 'error':
          return settle({ status: 'failed', message: snapshot.error ?? 'The update failed.' });
        case 'idle':
        case 'checking':
          return settle({ status: 'current' });
      }
    },
    [download, settle]
  );

  const applyEvent = useCallback(
    (event: DesktopUpdateEvent) => {
      if (!mounted.current) return;
      setState((current) => {
        switch (event.type) {
          case 'progress':
            return current.status === 'downloading'
              ? { ...current, percent: event.percent }
              : current;
          case 'downloaded':
            return { status: 'ready', version: event.version };
          case 'installing':
            return { status: 'installing' };
          case 'error':
            return { status: 'failed', message: event.message };
          default:
            return current;
        }
      });
    },
    [setState]
  );

  const start = useCallback(() => {
    if (running.current) return;
    running.current = true;
    settle({ status: 'checking' });
    void (async () => {
      try {
        const client = await getClientRef.current();
        if (!unsubscribe.current) {
          const stop = await client.events.subscribe(undefined, {
            onEvent: applyEvent,
            onGap: () => {},
          });
          if (mounted.current) unsubscribe.current = stop;
          else stop();
        }
        const checked = await client.check(undefined);
        if (!checked.success) return settle({ status: 'failed', message: checked.error });
        const current = await client.getState(undefined);
        if (!current.success) return settle({ status: 'failed', message: current.error });
        await applySnapshot(client, current.data);
      } catch (error) {
        settle({ status: 'failed', message: errorMessage(error) });
      } finally {
        running.current = false;
      }
    })();
  }, [applyEvent, applySnapshot, settle]);

  const install = useCallback(() => {
    settle({ status: 'installing' });
    void (async () => {
      try {
        const result = await (await getClientRef.current()).quitAndInstall(undefined);
        if (!result.success) settle({ status: 'failed', message: result.error });
      } catch (error) {
        settle({ status: 'failed', message: errorMessage(error) });
      }
    })();
  }, [settle]);

  return { state, start, install };
}
