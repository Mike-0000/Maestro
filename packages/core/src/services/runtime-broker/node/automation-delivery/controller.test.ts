import { err, ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { defineContract, type ContractClient } from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { acpApiContract, type AcpApiContract } from '#runtimes/acp/api';
import { automationDeliveryContract } from '#runtimes/automations/api';
import { tuiAgentsContract, type TuiAgentsContract } from '#runtimes/tui-agents/api';
import { createAutomationDeliveryController } from './controller';

/**
 * Runs the controller against in-process session runtimes that implement only the
 * verbs and live models it touches, and records which session verb each call used.
 */
function harness(options: { tuiUnavailable?: boolean } = {}) {
  const calls: string[] = [];
  const tuiReply = (verb: string) => {
    calls.push(verb);
    return options.tuiUnavailable
      ? err({ type: 'runtime-unavailable' as const, message: 'down' })
      : ok(undefined);
  };

  // The runtime contracts are large; serving the slice the controller reaches keeps
  // the test about routing. Paths match the full contracts, so the clients line up.
  const acpSlice = defineContract({
    sessions: acpApiContract.sessions,
    terminate: acpApiContract.terminate,
    cancelTurn: acpApiContract.cancelTurn,
  });
  const tuiSlice = defineContract({
    sessions: tuiAgentsContract.sessions,
    agentStates: tuiAgentsContract.agentStates,
    kill: tuiAgentsContract.kill,
    stop: tuiAgentsContract.stop,
  });
  const acpWire = createTestWire(acpSlice, {
    sessions: expose(acpSlice.sessions, {
      list: () => cell({}, { name: 'test-acp-sessions' }),
    }),
    terminate: async () => {
      calls.push('acp.terminate');
      return ok(undefined);
    },
    cancelTurn: async () => {
      calls.push('acp.cancelTurn');
      return ok(undefined);
    },
  });
  const tuiWire = createTestWire(tuiSlice, {
    sessions: expose(tuiSlice.sessions, {
      list: () => cell({}, { name: 'test-tui-sessions' }),
    }),
    agentStates: expose(tuiSlice.agentStates, {
      list: () => cell({}, { name: 'test-tui-agent-states' }),
    }),
    kill: async () => tuiReply('tui.kill'),
    stop: async () => tuiReply('tui.stop'),
  });

  const scope = createScope({ label: 'test:automation-delivery' });
  const deliveryWire = createTestWire(
    automationDeliveryContract,
    createAutomationDeliveryController({
      acp: acpWire.client as unknown as ContractClient<AcpApiContract>,
      tuiAgents: tuiWire.client as unknown as ContractClient<TuiAgentsContract>,
      publish: async () => ok({ outcome: 'no-changes' }),
      scope,
    })
  );

  return {
    calls,
    delivery: deliveryWire.client,
    async dispose() {
      await deliveryWire.dispose();
      await scope.dispose();
      await acpWire.dispose();
      await tuiWire.dispose();
    },
  };
}

describe('createAutomationDeliveryController', () => {
  let current: ReturnType<typeof harness> | undefined;

  afterEach(async () => {
    await current?.dispose();
    current = undefined;
  });

  it('closes an ACP session with terminate, which drops its resume intent', async () => {
    current = harness();

    const result = await current.delivery.closeSession({ conversationId: 'conv-1', type: 'acp' });

    expect(result).toEqual(ok(undefined));
    expect(current.calls).toEqual(['acp.terminate']);
  });

  it('closes a terminal session with kill, which drops its resume intent', async () => {
    current = harness();

    const result = await current.delivery.closeSession({ conversationId: 'conv-1', type: 'tui' });

    expect(result).toEqual(ok(undefined));
    expect(current.calls).toEqual(['tui.kill']);
  });

  it('reports a refused close with the runtime error type', async () => {
    current = harness({ tuiUnavailable: true });

    const result = await current.delivery.closeSession({ conversationId: 'conv-1', type: 'tui' });

    expect(result).toEqual(
      err({ type: 'runtime-unavailable', message: 'Could not close the agent session' })
    );
  });

  it('keeps stopSession on the resumable verbs', async () => {
    current = harness();

    await current.delivery.stopSession({ conversationId: 'conv-1', type: 'acp' });
    await current.delivery.stopSession({ conversationId: 'conv-1', type: 'tui' });

    expect(current.calls).toEqual(['acp.cancelTurn', 'tui.stop']);
  });
});
