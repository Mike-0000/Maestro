import type { Result } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { createController, type Controller } from '@emdash/wire/rpc';
import { expose, type Readable } from '@emdash/wire/state';
import {
  remoteAccessContract,
  type RemoteAccessError,
  type RemoteAccessPairing,
  type RemoteAccessStatus,
  type RemoteAccessTailscale,
  type RemoteAccessTrigger,
} from '../api';

/** The listener itself lives in the main process; the slice only describes and steers it. */
export type RemoteAccessOperations = {
  readonly status: Readable<RemoteAccessStatus>;
  configure(input: {
    enabled?: boolean;
    port?: number;
    bindAddress?: string;
  }): Promise<Result<void, RemoteAccessError>>;
  createPairingCode(): RemoteAccessPairing;
  cancelPairingCode(): void;
  revokeDevice(deviceId: string): Promise<void>;
  rotateTriggerToken(): Promise<Result<{ token: string }, RemoteAccessError>>;
  setTrigger(trigger: RemoteAccessTrigger): Promise<Result<void, RemoteAccessError>>;
  removeTrigger(name: string): Promise<void>;
  getTailscale(): Promise<RemoteAccessTailscale>;
  setTailscaleServe(enabled: boolean): Promise<Result<RemoteAccessTailscale, RemoteAccessError>>;
};

export function createRemoteAccessWireController(
  operations: RemoteAccessOperations,
  scope: Scope
): Controller {
  return createController(remoteAccessContract, {
    status: expose(remoteAccessContract.status, { state: operations.status }, { scope }),
    configure: (input) => operations.configure(input),
    createPairingCode: () => operations.createPairingCode(),
    cancelPairingCode: () => operations.cancelPairingCode(),
    revokeDevice: ({ deviceId }) => operations.revokeDevice(deviceId),
    rotateTriggerToken: () => operations.rotateTriggerToken(),
    setTrigger: (trigger) => operations.setTrigger(trigger),
    removeTrigger: ({ name }) => operations.removeTrigger(name),
    getTailscale: () => operations.getTailscale(),
    setTailscaleServe: ({ enabled }) => operations.setTailscaleServe(enabled),
  });
}
