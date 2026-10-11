import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { markdownViewerContract, markdownViewerDomain } from '../contract';

export type MarkdownViewerClient = ContractClient<typeof markdownViewerContract>;

export function getMarkdownViewerClient(): Promise<MarkdownViewerClient> {
  return domainClient<MarkdownViewerClient>(markdownViewerDomain, markdownViewerContract);
}
