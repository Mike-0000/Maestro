import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { localUpdatesContract, localUpdatesDomain } from '../contract';

export type LocalUpdatesClient = ContractClient<typeof localUpdatesContract>;

export function getLocalUpdatesClient(): Promise<LocalUpdatesClient> {
  return domainClient<LocalUpdatesClient>(localUpdatesDomain, localUpdatesContract);
}
