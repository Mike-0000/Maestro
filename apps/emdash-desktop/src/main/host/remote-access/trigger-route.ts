import type { AutomationsContract } from '@emdash/core/runtimes/automations/api';
import {
  createTriggerRequestListener,
  type TriggerDaemon,
  type TriggerLogEntry,
} from '@emdash/core/runtimes/automations/node';
import { err, ok } from '@emdash/shared';
import type { ContractClient } from '@emdash/wire/rpc';
import type { RemoteTriggers } from './device-store';
import type { RemoteAccessRoute } from './http-server';

/**
 * The on-demand agent HTTP API (`POST /v1/requests` and friends), answered by this app's own
 * automations runtime. It has its own bearer token, separate from device pairing: the caller
 * is a service that submits requests, never a person steering agents.
 */
export function createTriggerRoute(options: {
  automations: ContractClient<AutomationsContract>;
  triggers(): RemoteTriggers;
  log(entry: TriggerLogEntry): void;
}): RemoteAccessRoute {
  const daemon = automationsTriggerDaemon(options.automations);
  return async (request, response, url) => {
    if (url.pathname !== '/healthz' && !url.pathname.startsWith('/v1/')) return false;
    const triggers = options.triggers();
    if (!triggers.tokenDigest) {
      // No token has been generated, so nobody can be authorized; the routes do not exist.
      return false;
    }
    createTriggerRequestListener({
      config: {
        triggers: triggers.routes,
        maxQueued: triggers.maxQueued,
        tokenDigest: triggers.tokenDigest,
      },
      daemon,
      log: options.log,
    })(request, response);
    return true;
  };
}

function automationsTriggerDaemon(automations: ContractClient<AutomationsContract>): TriggerDaemon {
  return {
    healthy: async () => true,
    startRun: async (automationId, request) => {
      const result = await automations.startRun({ automationId, request });
      return result.success ? ok(result.data.run) : err(result.error);
    },
    getRun: async (automationId, runId) => {
      const result = await automations.getRun({ automationId, runId });
      return result.success ? ok(result.data.run) : err(result.error);
    },
    cancelRun: async (automationId, runId) => {
      const result = await automations.cancelRun({ automationId, runId });
      return result.success ? ok(undefined) : err(result.error);
    },
    queuedCount: async (automationId) => {
      const result = await automations.getRunOverview({ automationId });
      return result.success ? ok(result.data.counts['queued'] ?? 0) : err(result.error);
    },
  };
}
