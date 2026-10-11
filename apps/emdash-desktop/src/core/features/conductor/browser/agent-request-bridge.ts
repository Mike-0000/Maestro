import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../api/browser/client';
import type { AgentRequestDesk } from './agent-requests';

/**
 * Brings agents' requests from the main process to this window's conductor. Each request is
 * acknowledged at once (the asking agent's tool call is waiting for the verdict), and taken on
 * only when the main process says the verdict reached the agent.
 */
export function startAgentRequestBridge(desk: Pick<AgentRequestDesk, 'receive'>): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  void getConductorClient()
    .then(async (client) => {
      const next = await client.agentRequests.subscribe(undefined, {
        onEvent: (request) => {
          void desk
            .receive(request, async (ack) => {
              const result = await client.acknowledgeAgentRequest({ id: request.id, ack });
              return result.delivered;
            })
            .catch((error: unknown) =>
              log.warn('conductor: agent request failed', { error, id: request.id })
            );
        },
      });
      if (disposed) next();
      else unsubscribe = next;
    })
    .catch((error: unknown) =>
      log.warn('conductor: subscribing to agent requests failed', { error })
    );

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
