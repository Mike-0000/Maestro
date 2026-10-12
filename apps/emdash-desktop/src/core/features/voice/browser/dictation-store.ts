import { makeAutoObservable, runInAction } from 'mobx';
import { log } from '@core/primitives/logging/browser/logger';
import { getVoiceClient } from '../api/browser/client';
import type { DictationModelStatus } from '../api/contract';
import { bytesToBase64, SilenceDetector } from '../api/wav';
import { MicError, MicRecorder } from './mic-recorder';

/**
 * `setup`: the model is not on this computer yet. `review`: the microphone is closed and the
 * words are held, because they could not be sent or the dictation was left open.
 */
export type DictationPhase = 'idle' | 'setup' | 'listening' | 'finishing' | 'review';

export type DictationSendResult =
  | { readonly ok: true; readonly agentName: string }
  | { readonly ok: false; readonly message: string };

/** What dictation needs from the rest of voice: it never runs over an open command capture. */
export type DictationHost = {
  /** The command microphone is open or its words are still being transcribed. */
  capturing(): boolean;
  /** Stops any spoken reply, so it is not dictated back. */
  quiet(): void;
};

/** A dictation with no sound for this long was left open: it stops and holds what was said. */
const LEFT_OPEN_MS = 2 * 60_000;
/** How long "Sent to Atlas" stays up. */
const SENT_VISIBLE_MS = 4_000;

/**
 * Dictation to the agent that is open, transcribed on this computer by NVIDIA Parakeet. The words
 * appear as they are spoken; finishing sends them straight to that agent. It is separate from
 * the command microphone, which goes to the conductor.
 */
export class DictationStore {
  phase: DictationPhase = 'idle';
  /** Everything heard so far. */
  text = '';
  level = 0;
  model: DictationModelStatus | null = null;
  /** Why the words are held in `review`, or why dictation could not start. */
  error: string | null = null;
  /** The agent the last dictation went to, shown briefly. */
  sentTo: string | null = null;

  private readonly recorder = new MicRecorder();
  private streamId: string | null = null;
  private pending: string[] = [];
  private opening: Promise<void> | null = null;
  private leftOpen: SilenceDetector | null = null;
  private quietMs = 0;
  private sender: ((text: string) => Promise<DictationSendResult>) | null = null;
  private sentTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];

  constructor(private readonly host: DictationHost) {
    makeAutoObservable<
      DictationStore,
      | 'recorder'
      | 'streamId'
      | 'pending'
      | 'opening'
      | 'leftOpen'
      | 'quietMs'
      | 'sender'
      | 'sentTimer'
      | 'disposers'
      | 'host'
    >(this, {
      recorder: false,
      streamId: false,
      pending: false,
      opening: false,
      leftOpen: false,
      quietMs: false,
      sender: false,
      sentTimer: false,
      disposers: false,
      host: false,
    });
    this.recorder.onChunk = (level, durationMs) => this.onChunk(level, durationMs);
    this.recorder.onPcm = (pcm) => this.onPcm(pcm);
  }

  activate(): void {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getVoiceClient()
      .then(async (client) => {
        const next = await client.events.subscribe(undefined, {
          onEvent: (event) => {
            if (event.type === 'partial' && event.streamId === this.streamId) {
              runInAction(() => (this.text = event.text));
            } else if (event.type === 'dictation-model') {
              runInAction(() => (this.model = event.status));
            }
          },
        });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch((error: unknown) => log.warn('dictation: event subscription failed', { error }));
    this.disposers.push(() => {
      disposed = true;
      unsubscribe?.();
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.sentTimer) clearTimeout(this.sentTimer);
    this.abortStream();
    this.recorder.dispose();
  }

  /** Where finished dictation goes: the agent that is open. */
  setSender(sender: (text: string) => Promise<DictationSendResult>): void {
    this.sender = sender;
  }

  /** Anything but idle: the dictation panel is up and a tap of the talk key belongs to it. */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** The microphone is open, or the last words are still being transcribed. */
  get capturing(): boolean {
    return this.phase === 'listening' || this.phase === 'finishing';
  }

  /** The dictation button and a tap of the talk key: start, then finish and send. */
  toggle(): void {
    if (this.phase === 'idle') void this.start();
    else if (this.phase === 'listening') void this.finish();
    else if (this.phase === 'review' && this.text) void this.send();
    else if (this.phase !== 'finishing') this.cancel();
  }

  async start(): Promise<void> {
    if (this.capturing || this.host.capturing()) return;
    this.host.quiet();
    this.clearSent();
    this.phase = 'listening';
    this.text = '';
    this.error = null;
    this.level = 0;
    this.quietMs = 0;
    this.leftOpen = new SilenceDetector(LEFT_OPEN_MS);
    this.openStream();
    try {
      // The microphone opens at once; audio queues until the stream is there.
      await this.recorder.start();
    } catch (error) {
      this.abortStream();
      runInAction(() => {
        this.phase = 'review';
        this.error =
          error instanceof MicError ? error.message : 'The microphone could not be opened.';
      });
    }
  }

  /** Stops listening and sends what was said to the open agent. */
  async finish(): Promise<void> {
    if (this.phase !== 'listening') return;
    this.recorder.stop();
    this.phase = 'finishing';
    this.level = 0;
    const final = await this.closeStream();
    if (this.phase !== 'finishing') return;
    if (final === null) {
      runInAction(() => {
        this.phase = 'review';
        this.error = 'The last words could not be transcribed.';
      });
      return;
    }
    runInAction(() => (this.text = final));
    if (!final) {
      runInAction(() => (this.phase = 'idle'));
      return;
    }
    await this.send();
  }

  /** Sends the held words; they stay in `review` with the reason when that fails. */
  async send(): Promise<void> {
    const text = this.text.trim();
    if (!text || (this.phase !== 'finishing' && this.phase !== 'review')) return;
    this.phase = 'finishing';
    this.error = null;
    const result: DictationSendResult = this.sender
      ? await this.sender(text).catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : 'The words could not be sent.',
        }))
      : { ok: false, message: 'No agent is open.' };
    runInAction(() => {
      if (!result.ok) {
        this.phase = 'review';
        this.error = result.message;
        return;
      }
      this.phase = 'idle';
      this.text = '';
      this.sentTo = result.agentName;
      this.sentTimer = setTimeout(() => this.clearSent(), SENT_VISIBLE_MS);
    });
  }

  /** Closes dictation and drops what was said. */
  cancel(): void {
    this.abortStream();
    if (this.phase === 'listening') this.recorder.cancel();
    this.phase = 'idle';
    this.text = '';
    this.error = null;
    this.level = 0;
  }

  async refreshModel(): Promise<void> {
    try {
      const model = await (await getVoiceClient()).getDictationModel();
      runInAction(() => (this.model = model));
    } catch (error) {
      log.warn('dictation: model status unavailable', { error });
    }
  }

  /** Fetches the model (about 660 MB, once). Progress arrives on events. */
  async downloadModel(): Promise<void> {
    try {
      const model = await (await getVoiceClient()).downloadDictationModel();
      runInAction(() => (this.model = model));
    } catch (error) {
      log.warn('dictation: model download could not start', { error });
    }
  }

  private clearSent(): void {
    if (this.sentTimer) clearTimeout(this.sentTimer);
    this.sentTimer = null;
    this.sentTo = null;
  }

  private onChunk(level: number, durationMs: number): void {
    if (this.phase !== 'listening') return;
    // Smooth for the meter.
    this.level = this.level * 0.6 + Math.min(1, level * 6) * 0.4;
    const leftOpen = this.leftOpen;
    if (!leftOpen) return;
    const ended = leftOpen.push(level, durationMs);
    if (!leftOpen.hasSpeech) {
      this.quietMs += durationMs;
      if (this.quietMs >= LEFT_OPEN_MS) this.cancel();
    } else if (ended) {
      void this.hold('Dictation stopped after two quiet minutes. Nothing was sent.');
    }
  }

  /** Closes the microphone and keeps the words for the developer to send or drop. */
  private async hold(reason: string): Promise<void> {
    if (this.phase !== 'listening') return;
    this.recorder.stop();
    this.phase = 'finishing';
    this.level = 0;
    const final = await this.closeStream();
    if (this.phase !== 'finishing') return;
    runInAction(() => {
      if (final !== null) this.text = final;
      if (!this.text) {
        this.phase = 'idle';
        return;
      }
      this.phase = 'review';
      this.error = reason;
    });
  }

  private openStream(): void {
    this.streamId = null;
    this.pending = [];
    const opening = getVoiceClient()
      .then((client) => client.openDictation())
      .then(async (opened) => {
        if (this.opening !== opening) {
          // Cancelled meanwhile.
          if (opened.success) {
            await (await getVoiceClient()).abortStream({ streamId: opened.data.streamId });
          }
          return;
        }
        if (!opened.success) {
          this.opening = null;
          this.recorder.cancel();
          this.pending = [];
          const needsModel = opened.error.type === 'not-configured';
          if (needsModel) void this.refreshModel();
          runInAction(() => {
            this.phase = needsModel ? 'setup' : 'review';
            this.error = needsModel ? null : opened.error.message;
            this.level = 0;
          });
          return;
        }
        const streamId = opened.data.streamId;
        this.streamId = streamId;
        const client = await getVoiceClient();
        for (const pcm of this.pending.splice(0)) void client.pushAudio({ streamId, pcm });
      })
      .catch((error: unknown) => {
        log.warn('dictation: could not open a stream', { error });
        if (this.opening !== opening) return;
        this.opening = null;
        this.recorder.cancel();
        this.pending = [];
        runInAction(() => {
          this.phase = 'review';
          this.error = 'Dictation could not start.';
          this.level = 0;
        });
      });
    this.opening = opening;
  }

  private onPcm(pcm: Uint8Array<ArrayBuffer>): void {
    if (this.phase !== 'listening' || !this.opening) return;
    const encoded = bytesToBase64(pcm);
    const streamId = this.streamId;
    if (!streamId) {
      this.pending.push(encoded);
      return;
    }
    void getVoiceClient().then((client) => client.pushAudio({ streamId, pcm: encoded }));
  }

  /** The final text, or null when the stream failed. */
  private async closeStream(): Promise<string | null> {
    const opening = this.opening;
    if (!opening) return null;
    await opening;
    this.opening = null;
    const streamId = this.streamId;
    this.streamId = null;
    if (!streamId) return null;
    try {
      const result = await (await getVoiceClient()).closeDictation({ streamId });
      if (result.success) return result.data.text;
      log.warn('dictation: stream failed', { error: result.error });
    } catch (error) {
      log.warn('dictation: stream failed', { error });
    }
    return null;
  }

  private abortStream(): void {
    const streamId = this.streamId;
    this.streamId = null;
    this.opening = null;
    this.pending = [];
    if (streamId) void getVoiceClient().then((client) => client.abortStream({ streamId }));
  }
}
