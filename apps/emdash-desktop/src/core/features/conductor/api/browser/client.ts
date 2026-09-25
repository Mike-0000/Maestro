import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { conductorContract, conductorDomain } from '../contract';

export type ConductorClient = ContractClient<typeof conductorContract>;

export function getConductorClient(): Promise<ConductorClient> {
  return domainClient<ConductorClient>(conductorDomain, conductorContract);
}
