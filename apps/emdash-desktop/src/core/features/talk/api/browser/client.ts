import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { talkContract, talkDomain } from '../contract';

export type TalkClient = ContractClient<typeof talkContract>;

export function getTalkClient(): Promise<TalkClient> {
  return domainClient<TalkClient>(talkDomain, talkContract);
}
