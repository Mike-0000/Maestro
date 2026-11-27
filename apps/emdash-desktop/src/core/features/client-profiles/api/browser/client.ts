import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { clientProfilesContract, clientProfilesDomain } from '../contract';

export type ClientProfilesClient = ContractClient<typeof clientProfilesContract>;

/** This computer's client profiles. Local mode only: a client window never shows them. */
export function getClientProfilesClient(): Promise<ClientProfilesClient> {
  return domainClient<ClientProfilesClient>(clientProfilesDomain, clientProfilesContract);
}
