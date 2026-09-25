import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { voiceContract, voiceDomain } from '../contract';

export type VoiceClient = ContractClient<typeof voiceContract>;

export function getVoiceClient(): Promise<VoiceClient> {
  return domainClient<VoiceClient>(voiceDomain, voiceContract);
}
