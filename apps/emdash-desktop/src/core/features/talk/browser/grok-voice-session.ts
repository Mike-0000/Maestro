/**
 * One session with Grok Voice, xAI's realtime voice model, over a WebSocket. The main process
 * holds the key and mints a short-lived client secret that opens this one connection, so the key
 * is never in the renderer. Events are the Realtime API's JSON, which xAI follows.
 *
 * Grok Voice speaks over a WebSocket only, so this window carries the sound itself: it streams
 * the microphone as 24 kHz PCM, and plays the voice it gets back. And where xAI differs from what
 * the line was built on, the difference is made up here, so the line sees the events it knows:
 * - Turns are taken by hand (Grok's server VAD always answers by itself). Speech is found here,
 *   reported as `input_audio_buffer.speech_started` / `speech_stopped`, and each stretch of it is
 *   committed; a commit asked for when nothing is left gets the `input_audio_buffer_commit_empty`
 *   error OpenAI sends.
 * - `output_audio_buffer.started`, `stopped` and `cleared` follow the voice as it plays here, and
 *   `output_audio_buffer.clear` stops it here, cutting the answer the model remembers to what
 *   was heard.
 * - `response.done` lists the response's output, `response.output_text.done` is sent for text,
 *   and every function call has its `response.function_call_arguments.done` before the response
 *   is done.
 */

import {
  base64ToBytes,
  bytesToBase64,
  downsample,
  pcm16Bytes,
  rms,
} from '@core/features/voice/api/wav';
import { TurnDetector } from '../api/turn-detector';

export type SessionState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export type RealtimeEvent = { readonly type: string } & Record<string, unknown>;

/** The sample rate of the line's audio both ways. */
export const LINE_SAMPLE_RATE = 24_000;

/** The WebSocket as the session uses it, so a test can stand in for the browser's. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Where the line's sound comes in and goes out. */
export interface LineAudio {
  /** The voice, as a stream the page plays. */
  readonly output: MediaStream;
  /** Mono microphone samples as they arrive, and their rate. */
  onCapture: ((samples: Float32Array, rate: number) => void) | null;
  /** Everything queued has played. */
  onDrained: (() => void) | null;
  /** Queues 16-bit little-endian PCM at LINE_SAMPLE_RATE. */
  play(pcm: Uint8Array): void;
  /** Drops everything queued and not yet played. */
  clear(): void;
  /** Milliseconds of sound queued since the start, and of those, played. */
  queuedMs(): number;
  playedMs(): number;
  close(): void;
}

/** Where to connect and what to ask for, as the main process set it up. */
export type SessionGrant = {
  readonly url: string;
  readonly clientSecret: string;
  /** The body of the first `session.update`. */
  readonly session: Record<string, unknown>;
};

/** What a session is given by the line. */
export type LineSessionDeps = {
  /** Sets the session up through the main process, which holds the key. */
  connect(): Promise<SessionGrant>;
  /** The microphone the provider hears. Disabled, nothing of it is sent. */
  readonly track: MediaStreamTrack;
  /** Speech over the voice stops it, as talk-over asks. */
  readonly interrupt: boolean;
  onEvent(event: RealtimeEvent): void;
  onState(state: SessionState): void;
  /** The provider's voice, to be played. */
  onRemoteStream(stream: MediaStream): void;
};

/** And what it needs of the platform. */
export type SessionDeps = LineSessionDeps & {
  createSocket(url: string, protocols: string[]): SocketLike;
  createAudio(track: MediaStreamTrack): Promise<LineAudio>;
};

/** A session that has not been configured by now is given up on. */
const OPEN_TIMEOUT_MS = 15_000;
/** Sound kept from before speech is found, so its first syllable is not lost. */
const PRE_ROLL_MS = 300;
/** Most of what is said while the session opens that is kept, to be sent once it is open. */
const EARLY_MAX_MS = 20_000;
/** A commit with nothing to commit waits this long at most for the commits before it. */
const COMMIT_WAIT_MS = 1_500;
const SOCKET_OPEN = 1;
/** xAI's subprotocol prefix for a client secret: browsers cannot set an Authorization header. */
const CLIENT_SECRET_PROTOCOL = 'xai-client-secret.';
const COMMIT_EVENT_PREFIX = 'line_commit_';

type OutputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

/** What the session knows of one response while it is being made. */
type ResponseState = {
  readonly items: Map<string, OutputItem>;
  /** Text written so far, by item. */
  readonly text: Map<string, string>;
  /** Items whose text was reported done. */
  readonly textDone: Set<string>;
  /** Calls whose arguments were reported done. */
  readonly calls: Set<string>;
  /** Its voice was stopped: what is still to come of it is not played. */
  cleared: boolean;
};

/** The response the voice is playing, and where in the queue its current item started. */
type Audible = { responseId: string; itemId: string; startMs: number; done: boolean };

export class GrokVoiceSession {
  state: SessionState = 'idle';
  private socket: SocketLike | null = null;
  private audio: LineAudio | null = null;
  private readonly detector = new TurnDetector();
  /** Speech is being sent, and has not been committed yet. */
  private utterance = false;
  /** The last moments before speech was found, with their length in milliseconds. */
  private preRoll: { pcm: Uint8Array; ms: number }[] = [];
  /** Commits sent and not yet confirmed. */
  private pendingCommits = 0;
  private commitSeq = 0;
  /** Commits asked for when there was nothing to commit, answered once those before are in. */
  private emptyCommits: ReturnType<typeof setTimeout>[] = [];
  private readonly responses = new Map<string, ResponseState>();
  private audible: Audible | null = null;
  /** Settles the wait for `session.updated` while opening. */
  private configured: { resolve(): void; reject(error: Error): void } | null = null;
  /**
   * What the microphone heard while it was held for the line before the line was ready, or
   * null when nothing is being held. See `holdAudio`.
   */
  private early: { samples: Float32Array; rate: number; ms: number }[] | null = null;

  constructor(private readonly deps: SessionDeps) {}

  /** Connects and configures. Resolves once events can be sent; rejects when it could not open. */
  async open(): Promise<void> {
    if (this.state !== 'idle') throw new Error('A session opens once.');
    this.setState('connecting');
    // The sound is set up while the main process asks for the secret.
    const audioReady = this.deps.createAudio(this.deps.track);
    // Opening can fail before anyone waits for this (the secret, the socket): its own failure
    // must then not surface later as a rejection nobody handled. The microphone is heard from
    // as soon as it is ready, so what is said while the session opens can be held.
    audioReady.then(
      (audio) => {
        if (!this.ended()) audio.onCapture = (samples, rate) => this.capture(samples, rate);
      },
      () => undefined
    );
    try {
      const grant = await this.deps.connect();
      if (this.ended()) throw new Error('The voice session was closed.');
      const socket = this.deps.createSocket(grant.url, [
        `${CLIENT_SECRET_PROTOCOL}${grant.clientSecret}`,
      ]);
      this.socket = socket;
      await this.within(
        new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onclose = () => reject(new Error('The voice session closed while opening.'));
          socket.onerror = () => reject(new Error('Could not connect to xAI.'));
        })
      );
      socket.onmessage = (event) => this.receive(event.data);
      socket.onclose = () => this.fail();
      const configured = new Promise<void>((resolve, reject) => {
        this.configured = { resolve, reject };
      });
      this.sendRaw({ type: 'session.update', session: grant.session });
      await this.within(configured);
      const audio = await audioReady;
      if (this.ended()) {
        audio.close();
        throw new Error('The voice session was closed.');
      }
      this.audio = audio;
      audio.onCapture = (samples, rate) => this.capture(samples, rate);
      audio.onDrained = () => this.drained();
      socket.onclose = (event) => this.end(event.code === 1000 ? 'closed' : 'failed');
      socket.onerror = null;
      this.deps.onRemoteStream(audio.output);
      this.setState('open');
    } catch (error) {
      void audioReady.then(
        (audio) => {
          if (this.audio !== audio) audio.close();
        },
        () => undefined
      );
      this.fail();
      throw error;
    }
  }

  /** Sends one event. False when the session is not open, so the caller can fall back. */
  send(event: RealtimeEvent): boolean {
    if (this.state !== 'open') return false;
    switch (event.type) {
      case 'output_audio_buffer.clear':
        this.stopVoice(false);
        return true;
      case 'input_audio_buffer.commit':
        this.commitAsked();
        return true;
      case 'input_audio_buffer.clear':
        this.dropSpeech();
        return this.sendRaw(event);
      case 'response.cancel':
        this.cancelled(str(event.response_id));
        return this.sendRaw(event);
      default:
        return this.sendRaw(event);
    }
  }

  close(): void {
    this.end('closed');
  }

  /**
   * Keeps what the microphone hears, from now until `releaseAudio`, instead of sending it. The
   * developer may start speaking before the session is open; their words are sent once it is,
   * after the line is ready to take them.
   */
  holdAudio(): void {
    this.early ??= [];
  }

  /** Sends what was held, as if it were heard now, or drops it. Nothing is held after this. */
  releaseAudio(keep: boolean): void {
    const early = this.early;
    this.early = null;
    if (!keep || !early || this.state !== 'open') return;
    for (const chunk of early) this.capture(chunk.samples, chunk.rate);
  }

  // ── The microphone ──────────────────────────────────────────────────────────

  private capture(samples: Float32Array, rate: number): void {
    if (this.early) {
      if (!this.deps.track.enabled) return;
      const ms = (samples.length / rate) * 1000;
      const kept = this.early.reduce((total, chunk) => total + chunk.ms, 0);
      if (kept + ms <= EARLY_MAX_MS) this.early.push({ samples: samples.slice(), rate, ms });
      return;
    }
    if (this.state !== 'open') return;
    // The key is up and the window is shut: nothing is sent, and speech in progress has ended.
    if (!this.deps.track.enabled) {
      if (this.utterance) this.endSpeech();
      this.detector.reset();
      this.preRoll = [];
      return;
    }
    const durationMs = (samples.length / rate) * 1000;
    const pcm = pcm16Bytes(
      rate > LINE_SAMPLE_RATE ? downsample(samples, rate, LINE_SAMPLE_RATE) : samples
    );
    const edge = this.detector.push(rms(samples), durationMs);
    if (this.utterance) {
      this.append(pcm);
      if (edge === 'stop') this.endSpeech();
      return;
    }
    this.preRoll.push({ pcm, ms: durationMs });
    let kept = this.preRoll.reduce((total, chunk) => total + chunk.ms, 0);
    while (this.preRoll.length > 1 && kept - (this.preRoll[0]?.ms ?? 0) >= PRE_ROLL_MS) {
      kept -= this.preRoll.shift()?.ms ?? 0;
    }
    if (edge !== 'start') return;
    this.utterance = true;
    this.emit({ type: 'input_audio_buffer.speech_started' });
    for (const chunk of this.preRoll.splice(0)) this.append(chunk.pcm);
    // Talking over the voice stops it, as the provider's own detection would.
    if (this.deps.interrupt && this.audible) this.stopVoice(true);
  }

  private append(pcm: Uint8Array): void {
    this.sendRaw({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcm) });
  }

  /** A stretch of speech ended: it is committed, and becomes an item of the conversation. */
  private endSpeech(): void {
    this.utterance = false;
    this.detector.reset();
    this.emit({ type: 'input_audio_buffer.speech_stopped' });
    this.pendingCommits++;
    this.sendRaw({
      type: 'input_audio_buffer.commit',
      event_id: `${COMMIT_EVENT_PREFIX}${++this.commitSeq}`,
    });
  }

  /** The line asked for what was said to be committed. */
  private commitAsked(): void {
    if (this.utterance) {
      this.endSpeech();
      return;
    }
    // Nothing is left: everything said was committed at its pause. That is answered once the
    // commits before have been confirmed, so their items are seen first.
    const timer = setTimeout(() => this.answerEmptyCommit(timer), COMMIT_WAIT_MS);
    this.emptyCommits.push(timer);
    if (this.pendingCommits === 0) this.answerEmptyCommits();
  }

  private answerEmptyCommits(): void {
    for (const timer of [...this.emptyCommits]) this.answerEmptyCommit(timer);
  }

  private answerEmptyCommit(timer: ReturnType<typeof setTimeout>): void {
    const index = this.emptyCommits.indexOf(timer);
    if (index < 0) return;
    this.emptyCommits.splice(index, 1);
    clearTimeout(timer);
    this.emit({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'input_audio_buffer_commit_empty',
        message: 'Nothing was left to commit.',
      },
    });
  }

  private commitSettled(): void {
    this.pendingCommits = Math.max(0, this.pendingCommits - 1);
    if (this.pendingCommits === 0) this.answerEmptyCommits();
  }

  /** What was heard and not committed is dropped. */
  private dropSpeech(): void {
    if (this.utterance) {
      this.utterance = false;
      this.emit({ type: 'input_audio_buffer.speech_stopped' });
    }
    this.detector.reset();
    this.preRoll = [];
  }

  // ── The voice ───────────────────────────────────────────────────────────────

  private onAudio(event: RealtimeEvent): void {
    const responseId = str(event.response_id);
    const itemId = str(event.item_id);
    const delta = str(event.delta);
    const audio = this.audio;
    if (!audio || !delta) return;
    const response = this.response(responseId);
    if (response.cleared) return;
    let pcm: Uint8Array;
    try {
      pcm = base64ToBytes(delta);
    } catch {
      return;
    }
    if (pcm.length === 0) return;
    const audible = this.audible;
    if (!audible || audible.responseId !== responseId) {
      if (audible)
        this.emit({ type: 'output_audio_buffer.stopped', response_id: audible.responseId });
      this.audible = { responseId, itemId, startMs: audio.queuedMs(), done: false };
      this.emit({ type: 'output_audio_buffer.started', response_id: responseId });
    } else if (audible.itemId !== itemId) {
      audible.itemId = itemId;
      audible.startMs = audio.queuedMs();
    }
    audio.play(pcm);
  }

  /** Everything queued has played: once its response is done, the voice has stopped. */
  private drained(): void {
    const audible = this.audible;
    if (!audible?.done) return;
    this.audible = null;
    this.emit({ type: 'output_audio_buffer.stopped', response_id: audible.responseId });
  }

  /**
   * Stops the voice. What the model remembers saying is cut to what was heard; when the
   * developer spoke over it, the response stops too.
   */
  private stopVoice(interrupted: boolean): void {
    const audio = this.audio;
    const audible = this.audible;
    if (!audio) return;
    if (!audible) {
      audio.clear();
      return;
    }
    this.audible = null;
    const response = this.responses.get(audible.responseId);
    if (response) response.cleared = true;
    const heardMs = Math.max(0, Math.round(audio.playedMs() - audible.startMs));
    audio.clear();
    if (interrupted && !audible.done) {
      this.sendRaw({ type: 'response.cancel', response_id: audible.responseId });
    }
    // An answer still being made is cut by its cancel, or ends as made; one that is done is cut
    // here to what was heard.
    if (audible.done && audible.itemId) {
      this.sendRaw({
        type: 'conversation.item.truncate',
        item_id: audible.itemId,
        content_index: 0,
        audio_end_ms: heardMs,
      });
    }
    this.emit({ type: 'output_audio_buffer.cleared', response_id: audible.responseId });
  }

  /** A response named in a cancel is not heard: nothing more of it plays, nor what is queued. */
  private cancelled(responseId: string): void {
    if (!responseId) return;
    this.response(responseId).cleared = true;
    if (this.audible?.responseId !== responseId || !this.audio) return;
    this.audible = null;
    this.audio.clear();
    this.emit({ type: 'output_audio_buffer.cleared', response_id: responseId });
  }

  // ── What the provider sends ─────────────────────────────────────────────────

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
    this.handle(event as RealtimeEvent);
  }

  private handle(event: RealtimeEvent): void {
    switch (event.type) {
      case 'session.updated':
        this.configured?.resolve();
        this.configured = null;
        break;
      case 'error': {
        const error = (event.error ?? {}) as { message?: unknown; event_id?: unknown };
        if (this.configured) {
          this.configured.reject(
            new Error(str(error.message) || 'xAI would not set the voice session up.')
          );
          this.configured = null;
        }
        // A commit that failed is settled too: nothing waits on it any more.
        if (str(error.event_id).startsWith(COMMIT_EVENT_PREFIX)) this.commitSettled();
        break;
      }
      case 'input_audio_buffer.committed':
        this.emit(event);
        this.commitSettled();
        return;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        // Played here; the line has no use for the sound itself.
        this.onAudio(event);
        return;
      case 'response.created': {
        const id = str((event.response as { id?: unknown } | undefined)?.id);
        if (id) this.response(id);
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done':
        this.onItem(event);
        break;
      case 'response.function_call_arguments.done': {
        // Reported already, from its item: each call is reported once.
        const calls = this.response(str(event.response_id)).calls;
        if (calls.has(str(event.call_id))) return;
        calls.add(str(event.call_id));
        break;
      }
      case 'response.text.delta':
      case 'response.output_text.delta': {
        const response = this.response(str(event.response_id));
        const itemId = str(event.item_id);
        response.text.set(itemId, (response.text.get(itemId) ?? '') + str(event.delta));
        break;
      }
      case 'response.output_text.done':
        this.response(str(event.response_id)).textDone.add(str(event.item_id));
        break;
      case 'response.done':
        this.onResponseDone(event);
        return;
      default:
        break;
    }
    this.emit(event);
  }

  private onItem(event: RealtimeEvent): void {
    const responseId = str(event.response_id);
    const item = event.item as OutputItem | undefined;
    const itemId = str(item?.id);
    if (!item || !itemId) return;
    const response = this.response(responseId);
    response.items.set(itemId, item);
    if (event.type === 'response.output_item.done') this.reportCall(responseId, response, item);
  }

  /** A finished function call is reported once, whether or not the provider reported it. */
  private reportCall(responseId: string, response: ResponseState, item: OutputItem): void {
    const callId = str(item.call_id);
    if (item.type !== 'function_call' || !callId || response.calls.has(callId)) return;
    response.calls.add(callId);
    this.emit({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      item_id: str(item.id),
      call_id: callId,
      name: str(item.name),
      arguments: str(item.arguments),
    });
  }

  private onResponseDone(event: RealtimeEvent): void {
    const done = (event.response ?? {}) as Record<string, unknown> & { output?: unknown };
    const id = str(done.id);
    const response = this.response(id);
    for (const [itemId, text] of response.text) {
      if (response.textDone.has(itemId) || !text.trim()) continue;
      this.emit({ type: 'response.output_text.done', response_id: id, item_id: itemId, text });
    }
    const output =
      Array.isArray(done.output) && done.output.length > 0
        ? (done.output as OutputItem[])
        : [...response.items.values()].map((item) => withText(item, response.text));
    for (const item of output) this.reportCall(id, response, item);
    this.emit({ ...event, response: { ...done, output } });
    this.responses.delete(id);
    const audible = this.audible;
    if (audible?.responseId === id) {
      audible.done = true;
      if (this.audio && this.audio.playedMs() >= this.audio.queuedMs()) this.drained();
    }
  }

  private response(id: string): ResponseState {
    let response = this.responses.get(id);
    if (!response) {
      response = {
        items: new Map(),
        text: new Map(),
        textDone: new Set(),
        calls: new Set(),
        cleared: false,
      };
      this.responses.set(id, response);
    }
    return response;
  }

  // ── The connection ──────────────────────────────────────────────────────────

  private sendRaw(event: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  private emit(event: RealtimeEvent): void {
    this.deps.onEvent(event);
  }

  /** `promise`, or a rejection when it has not settled in time. */
  private within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('The voice session did not open in time.')),
        OPEN_TIMEOUT_MS
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private fail(): void {
    this.end('failed');
  }

  /** Read through a call, so a state changed by a callback in the meantime is seen. */
  private ended(): boolean {
    return this.state === 'closed' || this.state === 'failed';
  }

  private end(state: 'closed' | 'failed'): void {
    if (this.ended()) return;
    const { socket, audio } = this;
    this.socket = null;
    this.audio = null;
    this.audible = null;
    this.utterance = false;
    this.early = null;
    this.responses.clear();
    for (const timer of this.emptyCommits.splice(0)) clearTimeout(timer);
    this.configured?.reject(new Error('The voice session closed while opening.'));
    this.configured = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    if (audio) {
      audio.onCapture = null;
      audio.onDrained = null;
      audio.close();
    }
    this.setState(state);
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.deps.onState(state);
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** An output item with the text written for it, when the provider listed none. */
function withText(item: OutputItem, text: ReadonlyMap<string, string>): OutputItem {
  const written = text.get(str(item.id));
  if (!written || item.type !== 'message') return item;
  const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
  const hasText = content.some(
    (part) => typeof part?.text === 'string' || typeof part?.transcript === 'string'
  );
  return hasText ? item : { ...item, content: [...content, { type: 'text', text: written }] };
}
