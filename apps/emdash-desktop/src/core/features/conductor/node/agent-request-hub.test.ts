import { describe, expect, it } from 'vitest';
import type { AgentRequest, AgentRequestAck } from '../api/agent-requests';
import { AgentRequestHub } from './agent-request-hub';

const from: AgentRequest['from'] = { conversationId: 'c1', taskId: 't1', projectId: 'p1' };

const report = { kind: 'report', payload: { status: 'progress', message: 'x' } };

function createHub(ackTimeoutMs: number) {
  const emitted: AgentRequest[] = [];
  const hub = new AgentRequestHub((request) => {
    emitted.push(request);
  }, ackTimeoutMs);
  return { hub, emitted };
}

describe('AgentRequestHub', () => {
  it('emits a valid request with its sender and resolves with the acknowledgement', async () => {
    const { hub, emitted } = createHub(5_000);

    const pending = hub.submit(from, { ...report, reason: 'Tests are green.' });

    expect(emitted).toHaveLength(1);
    const request = emitted[0];
    if (!request) throw new Error('expected an emitted request');
    expect(request.id).toMatch(/^r-[0-9a-f]{6}$/);
    expect(Number.isNaN(Date.parse(request.at))).toBe(false);
    expect(request).toMatchObject({
      from,
      kind: 'report',
      payload: { status: 'progress', message: 'x' },
      reason: 'Tests are green.',
    });

    const ack: AgentRequestAck = { accepted: true, message: `Request ${request.id} accepted.` };
    expect(hub.acknowledge(request.id, ack)).toBe(true);
    await expect(pending).resolves.toEqual(ack);
    // One verdict per request.
    expect(hub.acknowledge(request.id, ack)).toBe(false);
  });

  it('refuses an unknown kind and an invalid payload without emitting', async () => {
    const { hub, emitted } = createHub(5_000);

    const unknown = await hub.submit(from, { kind: 'launch_missiles', payload: {} });
    expect(unknown.accepted).toBe(false);
    expect(unknown.message).toMatch(/Unknown request kind "launch_missiles"/);

    const invalid = await hub.submit(from, {
      kind: 'report',
      payload: { status: 'almost', message: 'x' },
    });
    expect(invalid.accepted).toBe(false);
    expect(invalid.message).toMatch(/Invalid report payload/);

    expect(emitted).toEqual([]);
  });

  it('refuses the request when no window acknowledges it in time', async () => {
    const { hub, emitted } = createHub(20);

    const ack = await hub.submit(from, report);

    expect(emitted).toHaveLength(1);
    expect(ack.accepted).toBe(false);
    expect(ack.message).toMatch(/did not pick the request up/);
    expect(hub.acknowledge(emitted[0]?.id ?? '', { accepted: true, message: 'late' })).toBe(false);
  });
});
