import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { describe, expect, it } from 'vitest';
import { readHostActivity, type HostActivitySources } from './host-activity';

function runtimesWith(data: { acp: Record<string, unknown>; agents: Record<string, unknown> }) {
  const client = {
    acp: { sessions: { state: () => ({ snapshot: async () => ({ data: data.acp }) }) } },
    tuiAgents: {
      agentStates: { state: () => ({ snapshot: async () => ({ data: data.agents }) }) },
    },
  };
  return {
    client: async () => ({ success: true, data: client }),
  } as unknown as HostActivitySources['runtimes'];
}

describe('host activity', () => {
  it('is idle when nothing works: open shells and agents waiting for a person do not count', async () => {
    const activity = await readHostActivity({
      runtimes: runtimesWith({
        acp: { a: { lifecycle: 'ready', isGenerating: false } },
        agents: { b: { status: 'awaiting-input' }, c: { status: 'idle' } },
      }),
      attachedHosts: () => [LOCAL_HOST_REF],
      inFlightAutomationRuns: async () => 0,
    });
    expect(activity).toEqual({ busy: false, detail: 'idle' });
  });

  it('is busy while chats or agents work or an automation run starts', async () => {
    const activity = await readHostActivity({
      runtimes: runtimesWith({
        acp: { a: { lifecycle: 'working' }, b: { lifecycle: 'ready', isGenerating: true } },
        agents: { c: { status: 'working' } },
      }),
      attachedHosts: () => [LOCAL_HOST_REF],
      inFlightAutomationRuns: async () => 1,
    });
    expect(activity).toEqual({
      busy: true,
      detail: '2 working chats, 1 working agent, 1 starting automation run',
    });
  });

  it('counts a read that fails as busy', async () => {
    const activity = await readHostActivity({
      runtimes: {
        client: async () => ({ success: false, error: { message: 'worker down' } }),
      } as unknown as HostActivitySources['runtimes'],
      attachedHosts: () => [LOCAL_HOST_REF],
      inFlightAutomationRuns: async () => {
        throw new Error('db closed');
      },
    });
    expect(activity).toEqual({ busy: true, detail: 'activity could not be read' });
  });
});
