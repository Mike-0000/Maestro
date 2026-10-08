import { err, ok, type Result } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { createController, type ContractClient, type Controller } from '@emdash/wire/rpc';
import { peek, pin, remote } from '@emdash/wire/state';
import { acpApiContract, type AcpApiContract } from '#runtimes/acp/api';
import {
  automationDeliveryContract,
  type AutomationDeliveryError,
  type AutomationPublishInput,
  type AutomationPublishResult,
} from '#runtimes/automations/api';
import { tuiAgentsContract, type TuiAgentsContract } from '#runtimes/tui-agents/api';
import { acpSessionStatus, tuiSessionStatus } from './session-status';

export type AutomationDeliveryControllerOptions = {
  acp: ContractClient<AcpApiContract>;
  tuiAgents: ContractClient<TuiAgentsContract>;
  /** Turns a finished run's branch into a pull request; see `createAutomationPublisher`. */
  publish(
    input: AutomationPublishInput
  ): Promise<Result<AutomationPublishResult, AutomationDeliveryError>>;
  scope: Scope;
};

/**
 * Pull-request delivery for host-resident automation runs. It sits here because it joins
 * two session runtimes: session state comes from their own live models, and the host
 * supplies the publisher.
 */
export function createAutomationDeliveryController(
  options: AutomationDeliveryControllerOptions
): Controller {
  const { acp, tuiAgents, scope } = options;
  const acpSessions = remote(acpApiContract.sessions, acp.sessions, { scope })(undefined).states
    .list;
  const tuiAgentStates = remote(tuiAgentsContract.agentStates, tuiAgents.agentStates, { scope })(
    undefined
  ).states.list;
  const tuiSessions = remote(tuiAgentsContract.sessions, tuiAgents.sessions, { scope })(undefined)
    .states.list;
  // Pinned so the replicas stay subscribed between status polls.
  pin(scope, [acpSessions, tuiAgentStates, tuiSessions]);

  return createController(automationDeliveryContract, {
    sessionStatus: async ({ conversationId, type }) =>
      ok(
        type === 'acp'
          ? acpSessionStatus(peek(acpSessions)?.[conversationId])
          : tuiSessionStatus(
              peek(tuiAgentStates)?.[conversationId],
              peek(tuiSessions)?.[conversationId]
            )
      ),
    stopSession: async ({ conversationId, type }) => {
      const result =
        type === 'acp'
          ? await acp.cancelTurn({ conversationId })
          : await tuiAgents.stop({ conversationId });
      return result.success
        ? ok(undefined)
        : err({ type: result.error.type, message: 'Could not stop the agent session' });
    },
    publish: (input) => options.publish(input),
  });
}
