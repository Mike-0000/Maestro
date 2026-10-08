import { remote, type RemoteModel } from '@emdash/wire/state';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';
import { remoteAccessContract, type RemoteAccessStatus } from '../contract';
import { getRemoteAccessClient } from './client';

let statusRemotePromise: Promise<RemoteModel<typeof remoteAccessContract.status>> | undefined;

function getStatusRemote(): Promise<RemoteModel<typeof remoteAccessContract.status>> {
  statusRemotePromise ??= getRemoteAccessClient().then((client) =>
    remote(remoteAccessContract.status, client.status, { lingerMs: 15_000 })
  );
  return statusRemotePromise;
}

export type RemoteAccessStatusState = {
  /** Undefined until the first snapshot arrives. */
  status: RemoteAccessStatus | undefined;
  isLoading: boolean;
  isError: boolean;
};

/**
 * The remote-access listener's state, live: the main process pushes every change (switch,
 * port, pairing code issued or used, devices connecting), so nothing here is refetched.
 */
export function useRemoteAccessStatus(): RemoteAccessStatusState {
  const state = useRemoteModelState(
    remoteAccessContract.status,
    getStatusRemote,
    undefined,
    'state'
  );

  return {
    status: state.value,
    isLoading: state.isLoading,
    isError: state.status === 'error',
  };
}
