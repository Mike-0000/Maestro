/**
 * One WebRTC session with the realtime voice provider. Audio flows directly between this
 * window and the provider; the connection is set up through the main process, which holds the
 * key, so no credential is ever in the renderer. Events travel on a data channel as JSON.
 */

export type SessionState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export type RealtimeEvent = { readonly type: string } & Record<string, unknown>;

/** The data channel as the session uses it. */
export interface ChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The parts of RTCPeerConnection the session uses, so a test can stand in for the browser. */
export interface PeerLike {
  readonly connectionState: string;
  createDataChannel(label: string): ChannelLike;
  addTrack(track: MediaStreamTrack): unknown;
  createOffer(): Promise<{ sdp?: string }>;
  setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  close(): void;
  ontrack: ((event: { streams: readonly MediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
}

export type SessionDeps = {
  createPeer(): PeerLike;
  /** Trades this window's offer for the provider's answer, through the main process. */
  exchange(offerSdp: string): Promise<string>;
  /** The microphone track the provider hears. Disabled, it carries silence. */
  readonly track: MediaStreamTrack;
  onEvent(event: RealtimeEvent): void;
  onState(state: SessionState): void;
  /** The provider's voice, to be played. */
  onRemoteStream(stream: MediaStream): void;
};

/** The provider's name for the events channel. */
const EVENTS_CHANNEL = 'oai-events';
/** A session that has not opened its channel by now is given up on. */
const OPEN_TIMEOUT_MS = 15_000;

export class RealtimeSession {
  state: SessionState = 'idle';
  private peer: PeerLike | null = null;
  private channel: ChannelLike | null = null;

  constructor(private readonly deps: SessionDeps) {}

  /** Connects. Resolves once events can be sent; rejects when the session could not open. */
  async open(): Promise<void> {
    if (this.state !== 'idle') throw new Error('A session opens once.');
    this.setState('connecting');
    try {
      const peer = this.deps.createPeer();
      this.peer = peer;
      peer.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) this.deps.onRemoteStream(stream);
      };
      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        if (state === 'failed' || state === 'disconnected') this.fail();
        else if (state === 'closed') this.end('closed');
      };
      // The events channel has to exist before the offer is made.
      const channel = peer.createDataChannel(EVENTS_CHANNEL);
      this.channel = channel;
      const opened = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The voice session did not open in time.')),
          OPEN_TIMEOUT_MS
        );
        channel.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        channel.onclose = () => {
          clearTimeout(timer);
          reject(new Error('The voice session closed while opening.'));
        };
      });
      // Opening can fail before anyone waits for this promise (the offer, the provider): its
      // own failure must then not surface later as a rejection nobody handled.
      opened.catch(() => undefined);
      channel.onmessage = (event) => this.receive(event.data);
      peer.addTrack(this.deps.track);
      const offer = await peer.createOffer();
      if (!offer.sdp) throw new Error('The browser produced no connection offer.');
      await peer.setLocalDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await this.deps.exchange(offer.sdp);
      // Closed while the provider was answering: nothing to connect any more.
      if (this.ended()) throw new Error('The voice session was closed.');
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      await opened;
      channel.onclose = () => this.end('closed');
      this.setState('open');
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  /** Sends one event. False when the session is not open, so the caller can fall back. */
  send(event: RealtimeEvent): boolean {
    if (this.state !== 'open' || this.channel?.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  close(): void {
    this.end('closed');
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (typeof (event as { type?: unknown }).type !== 'string') return;
    this.deps.onEvent(event as RealtimeEvent);
  }

  private fail(): void {
    this.end('failed');
  }

  /** Read through a call, so a state changed by a callback in the meantime is seen. */
  private ended(): boolean {
    return this.state === 'closed' || this.state === 'failed';
  }

  private end(state: 'closed' | 'failed'): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    const { peer, channel } = this;
    this.peer = null;
    this.channel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      try {
        peer.close();
      } catch {
        // Already closed.
      }
    }
    this.setState(state);
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.deps.onState(state);
  }
}
