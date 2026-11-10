import { createController, type Controller } from '@emdash/wire/rpc';
import { claudeAccountsContract } from '../api';
import type { ClaudeAccountsService } from './claude-accounts-service';
import { claudeAccountsEvents } from './event-host';
import type { ClaudeUsageService } from './usage-service';

export function createClaudeAccountsWireController(
  service: ClaudeAccountsService,
  usage: ClaudeUsageService
): {
  controller: Controller;
  dispose(): void;
} {
  const dispose = service.onChanged((state) =>
    claudeAccountsEvents.emit(undefined, { type: 'changed', state })
  );
  const controller = createController(claudeAccountsContract, {
    list: () => service.list(),
    create: ({ label }) => service.create(label),
    rename: ({ accountId, label }) => service.rename(accountId, label),
    remove: ({ accountId }) => service.remove(accountId),
    setDefault: ({ accountId }) => service.setDefault(accountId),
    refreshIdentity: ({ accountId }) => service.refreshIdentity(accountId),
    usage: (input) => usage.usage(input),
    setAutoSwitchOnLimit: ({ enabled }) => service.setAutoSwitchOnLimit(enabled),
    events: claudeAccountsEvents,
  });
  return { controller, dispose };
}
