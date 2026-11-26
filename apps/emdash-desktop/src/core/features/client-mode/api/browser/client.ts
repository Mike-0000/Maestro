import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { clientSessionContract, clientSessionDomain } from '../client-session-contract';

export type ClientSessionClient = ContractClient<typeof clientSessionContract>;

/** The client process's link to its host. Only request this when `isClientMode()` is true. */
export function getClientSessionClient(): Promise<ClientSessionClient> {
  return domainClient<ClientSessionClient>(clientSessionDomain, clientSessionContract);
}
