import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { remoteAccessContract, remoteAccessDomain } from '../contract';

export type RemoteAccessClient = ContractClient<typeof remoteAccessContract>;

export function getRemoteAccessClient(): Promise<RemoteAccessClient> {
  return domainClient<RemoteAccessClient>(remoteAccessDomain, remoteAccessContract);
}
