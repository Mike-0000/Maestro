import { err } from '@emdash/shared';
import { createController, type Controller } from '@emdash/wire/rpc';
import { clientProfilesContract } from '../api/contract';
import type { ClientProfilesOperations } from './client-profiles';

export function createClientProfilesWireController(
  operations: ClientProfilesOperations
): Controller {
  return createController(clientProfilesContract, {
    list: () => operations.list(),
    add: ({ name }) => operations.add(name),
    open: ({ profile }) => operations.open(profile),
  });
}

const UNAVAILABLE = {
  type: 'unsupported',
  message: 'Client profiles are managed from Maestro running outside client mode.',
} as const;

/** A client-mode window never shows the profiles page, so its controller has nothing to manage. */
export const unavailableClientProfilesOperations: ClientProfilesOperations = {
  list: async () => [],
  add: async () => err(UNAVAILABLE),
  open: async () => err(UNAVAILABLE),
};
