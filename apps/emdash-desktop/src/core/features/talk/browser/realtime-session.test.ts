import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeSession,
  type ChannelLike,
  type PeerLike,
  type RealtimeEvent,
  type SessionState,
} from './realtime-session';

function fakePeer() {
  const channel: ChannelLike & { sent: string[] } = {
    readyState: 'connecting',
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onmessage: null,
  };
  const calls: string[] = [];
  const peer: PeerLike & { connectionState: string } = {
    connectionState: 'new',
    createDataChannel: (label) => {
      calls.push(`channel:${label}`);
      return channel;
    },
    addTrack: () => {
      calls.push('track');
    },
    createOffer: async () => {
      calls.push('offer');
      return { sdp: 'v=0 offer' };
    },
    setLocalDescription: async () => {
      calls.push('local');
    },
    setRemoteDescription: async (description) => {
      calls.push(`remote:${description.sdp}`);
    },
    close: vi.fn(),
    ontrack: null,
    onconnectionstatechange: null,
  };
  const openChannel = () => {
    (channel as { readyState: string }).readyState = 'open';
    channel.onopen?.();
  };
  return { peer, channel, calls, openChannel };
}

function session(overrides: { exchange?: (sdp: string) => Promise<string> } = {}) {
  const fake = fakePeer();
  const events: RealtimeEvent[] = [];
  const states: SessionState[] = [];
  const streams: unknown[] = [];
  const instance = new RealtimeSession({
    createPeer: () => fake.peer,
    exchange: overrides.exchange ?? (async () => 'v=0 answer'),
    track: {} as MediaStreamTrack,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onRemoteStream: (stream) => streams.push(stream),
  });
  return { ...fake, instance, events, states, streams };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

describe('RealtimeSession', () => {
  it('makes the events channel before the offer, trades it for the answer, and opens', async () => {
    const exchange = vi.fn(async () => 'v=0 answer');
    const { instance, calls, openChannel, states } = session({ exchange });
    const opening = instance.open();
    await settle();
    openChannel();
    await opening;

    expect(calls).toEqual(['channel:oai-events', 'track', 'offer', 'local', 'remote:v=0 answer']);
    expect(exchange).toHaveBeenCalledWith('v=0 offer');
    expect(states).toEqual(['connecting', 'open']);
    expect(instance.state).toBe('open');
  });

  it('sends events as JSON once open, and refuses before', async () => {
    const { instance, channel, openChannel } = session();
    expect(instance.send({ type: 'response.create' })).toBe(false);
    const opening = instance.open();
    await settle();
    openChannel();
    await opening;
    expect(instance.send({ type: 'response.create' })).toBe(true);
    expect(channel.sent).toEqual(['{"type":"response.create"}']);
  });

  it('passes on well-formed events and ignores anything else', async () => {
    const { instance, channel, openChannel, events } = session();
    const opening = instance.open();
    await settle();
    openChannel();
    await opening;
    channel.onmessage?.({ data: '{"type":"response.done","response":{}}' });
    channel.onmessage?.({ data: 'not json' });
    channel.onmessage?.({ data: '{"no":"type"}' });
    channel.onmessage?.({ data: new ArrayBuffer(4) });
    expect(events).toEqual([{ type: 'response.done', response: {} }]);
  });

  it('hands the remote voice to be played', async () => {
    const { instance, peer, openChannel, streams } = session();
    const opening = instance.open();
    await settle();
    const stream = {} as MediaStream;
    peer.ontrack?.({ streams: [stream] });
    openChannel();
    await opening;
    expect(streams).toEqual([stream]);
  });

  it('fails, and closes the connection, when the provider refuses', async () => {
    const { instance, peer, states } = session({
      exchange: async () => {
        throw new Error('over budget');
      },
    });
    await expect(instance.open()).rejects.toThrow('over budget');
    expect(states).toEqual(['connecting', 'failed']);
    expect(peer.close).toHaveBeenCalled();
    expect(instance.send({ type: 'response.create' })).toBe(false);
  });

  it('reports a dropped connection once', async () => {
    const { instance, peer, openChannel, states } = session();
    const opening = instance.open();
    await settle();
    openChannel();
    await opening;
    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange?.();
    instance.close();
    expect(states).toEqual(['connecting', 'open', 'failed']);
  });

  it('does not connect a session that was closed while the provider answered', async () => {
    let answer: (sdp: string) => void = () => {};
    const { instance, calls } = session({
      exchange: () => new Promise((resolve) => (answer = resolve)),
    });
    const opening = instance.open();
    await settle();
    instance.close();
    answer('v=0 answer');
    await expect(opening).rejects.toThrow('closed');
    expect(calls).not.toContain('remote:v=0 answer');
  });
});
