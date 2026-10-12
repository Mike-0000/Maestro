import { makeAutoObservable, runInAction } from 'mobx';
import type { TraceEvent } from '@core/features/conductor/api/contract';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { log } from '@core/primitives/logging/browser/logger';
import { getVoiceClient } from '../api/browser/client';
import type { VoiceSettings, VoiceStatus } from '../api/contract';
import { bytesToBase64, SilenceDetector, SpeechOnsetDetector, stripWakePhrase } from '../api/wav';
import { MicError, MicRecorder } from './mic-recorder';
import { SpeechOutput } from './speech-output';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'error';
/** "command" goes to the conductor; "dictation" types into the focused agent. */
export type TranscriptIntent = 'command' | 'dictation';
export type ListenMode = 'hold' | 'toggle';
/** Who started listening: the user (key, click, shortcut) or hands-free speech detection. */
export type ListenOrigin = 'user' | 'hands-free';
export type TranscriptHandler = (
  text: string,
  intent: TranscriptIntent,
  interactionId: string
) => Promise<void> | void;

export type VoiceErrorState = {
  message: string;
  kind: 'mic-permission' | 'mic-missing' | 'engine' | 'not-configured' | 'other';
};

/**
 * The developer started speaking, or a capture ended without handing a transcript on (it was
 * cancelled, too short, failed, or lacked the wake phrase). A capture that produced a transcript
 * ends with the transcript handler, not with an event.
 */
export type CaptureEvent =
  | {
      readonly type: 'start';
      readonly interactionId: string;
      readonly origin: ListenOrigin;
      readonly intent: TranscriptIntent;
    }
  | {
      readonly type: 'end';
      readonly interactionId: string;
      readonly reason: 'cancelled' | 'too-short' | 'failed' | 'ignored';
    };

/**
 * Something that hears the microphone itself (a live voice session) and takes a capture the
 * developer starts with a key or a click, in place of the recorder and the transcription.
 */
export type LiveCapture = {
  /** False when it cannot take the capture; the recorder then does. */
  begin(interactionId: string): boolean;
  /** The developer finished. Resolves false when nothing they said was handed on. */
  end(interactionId: string): Promise<boolean>;
  cancel(): void;
};

/**
 * On-device dictation to the open agent. It owns a single tap of the talk key, and the command
 * microphone stays closed while it is listening.
 */
export type TapDictation = {
  /** Its panel is up: a tap belongs to it. */
  readonly active: boolean;
  /** Its microphone is open or its last words are being transcribed. */
  readonly capturing: boolean;
  toggle(): void;
};

/** How a spoken sentence ended; `suppressed` when it was never started (muted, or listening). */
export type SpeechResult = 'ended' | 'cancelled' | 'failed' | 'suppressed';

export type SpeakOptions = {
  /** `system` uses the computer's own voice: no network wait, and it never paraphrases. */
  readonly voice?: 'main' | 'system';
  /** An attention notice follows the speak-attention setting; anything else speak-replies. */
  readonly attention?: boolean;
  readonly interactionId?: string;
};

/** Utterances shorter than this are treated as accidental taps. */
const MIN_UTTERANCE_MS = 300;
/** A tap-started capture with no speech at all is dropped after this long. */
const NO_SPEECH_MS = 6_000;
/** A second report of a tap this soon after the one that opened the microphone is the same tap. */
const TAP_REPEAT_MS = 600;
/** A hands-free utterance (which ends on a pause) never records longer than this. */
const MAX_HANDS_FREE_MS = 60_000;
/**
 * A click-to-talk utterance waits for Send, so cap it just under the upload limit
 * (MAX_UTTERANCE_BYTES, ~5.4 minutes of 16 kHz PCM16) in case it is left open.
 */
const MAX_MANUAL_MS = 5 * 60_000;
/** A click-to-talk capture this long without speech was left open: it is sent, or dropped if empty. */
const LEFT_OPEN_MS = 90_000;
/** After a reply to a command, hands-free speech this soon needs no wake phrase. */
const FOLLOW_UP_MS = 10_000;
/** How long after a command a reply that finishes being spoken still opens that window. */
const FOLLOW_UP_REPLY_MS = 30_000;

export class VoiceStore {
  phase: VoicePhase = 'idle';
  mode: ListenMode = 'hold';
  intent: TranscriptIntent = 'command';
  level = 0;
  lastTranscript = '';
  /** Live partial transcript while streaming (Deepgram). */
  partial = '';
  origin: ListenOrigin = 'user';
  /** Set when a hands-free utterance was ignored for lacking the wake phrase. */
  ignoredUtterance: string | null = null;
  lastLatencyMs: number | null = null;
  error: VoiceErrorState | null = null;
  speaking = false;
  muted = false;
  status: VoiceStatus | null = null;

  readonly speech = new SpeechOutput();
  private readonly recorder = new MicRecorder();
  private silence: SilenceDetector | null = null;
  /** Watches a capture the developer ends themselves for being left open. */
  private leftOpen: SilenceDetector | null = null;
  /**
   * A command was just answered: until this time, the end of its spoken reply reopens the window
   * in which the next hands-free utterance may skip the wake phrase.
   */
  private followUpArmed = 0;
  private followUpUntil = 0;
  private readonly onset = new SpeechOnsetDetector();
  private streamId: string | null = null;
  private streamPending: string[] = [];
  private streamOpening: Promise<void> | null = null;
  private captureNext: ((text: string) => void) | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: TranscriptHandler | null = null;
  private traceHandler: ((event: TraceEvent) => void) | null = null;
  private captureHandler: ((event: CaptureEvent) => void) | null = null;
  /** Asked on a tap of the talk key: true when something is waiting for a spoken answer. */
  private tapGate: (() => boolean) | null = null;
  private dictation: TapDictation | null = null;
  private liveCapture: LiveCapture | null = null;
  /** The capture in progress is heard by the live session, since when. */
  private live: { capture: LiveCapture; since: number } | null = null;
  /** How long a tap-started capture has heard nothing, in ms. */
  private quietMs = 0;
  private endsOnPause = false;
  private lastTapAt = 0;
  private interactionId: string | null = null;
  private vocabulary: () => string[] = () => [];
  private disposers: (() => void)[] = [];

  constructor() {
    makeAutoObservable<
      VoiceStore,
      | 'captureHandler'
      | 'tapGate'
      | 'dictation'
      | 'liveCapture'
      | 'live'
      | 'quietMs'
      | 'endsOnPause'
      | 'lastTapAt'
      | 'recorder'
      | 'silence'
      | 'leftOpen'
      | 'followUpArmed'
      | 'followUpUntil'
      | 'maxTimer'
      | 'handler'
      | 'vocabulary'
      | 'disposers'
      | 'onset'
      | 'streamId'
      | 'streamPending'
      | 'streamOpening'
      | 'captureNext'
      | 'traceHandler'
      | 'interactionId'
    >(this, {
      speech: false,
      captureHandler: false,
      tapGate: false,
      dictation: false,
      liveCapture: false,
      live: false,
      quietMs: false,
      endsOnPause: false,
      lastTapAt: false,
      recorder: false,
      silence: false,
      leftOpen: false,
      followUpArmed: false,
      followUpUntil: false,
      onset: false,
      streamId: false,
      streamPending: false,
      streamOpening: false,
      captureNext: false,
      traceHandler: false,
      interactionId: false,
      maxTimer: false,
      handler: false,
      vocabulary: false,
      disposers: false,
    });
    this.recorder.onChunk = (level, durationMs) => this.onChunk(level, durationMs);
    this.recorder.onPcm = (pcm) => this.onPcm(pcm);
    this.speech.onSpeakingChange = (speaking) => {
      const wasSpeaking = this.speaking;
      runInAction(() => (this.speaking = speaking));
      // The follow-up window opens once the reply has been said, not while it plays.
      if (wasSpeaking && !speaking && Date.now() < this.followUpArmed) {
        this.followUpUntil = Date.now() + FOLLOW_UP_MS;
      }
    };
  }

  activate(): void {
    void this.refreshStatus();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getVoiceClient()
      .then(async (client) => {
        const next = await client.events.subscribe(undefined, {
          onEvent: (event) => {
            if (event.type === 'global-toggle') void this.toggle();
            else if (event.type === 'global-hold') this.onGlobalHold(event.action, event.intent);
            else if (event.type === 'partial' && event.streamId === this.streamId) {
              runInAction(() => (this.partial = event.text));
              this.trace('stt-partial', event.text, {
                engine: 'deepgram',
                ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
              });
            } else this.speech.handleEvent(event);
          },
        });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch((error: unknown) => log.warn('voice: event subscription failed', { error }));
    this.disposers.push(() => {
      disposed = true;
      unsubscribe?.();
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.recorder.dispose();
    this.speech.stop();
  }

  setTranscriptHandler(handler: TranscriptHandler): void {
    this.handler = handler;
  }

  setTraceHandler(handler: (event: TraceEvent) => void): void {
    this.traceHandler = handler;
  }

  setCaptureHandler(handler: (event: CaptureEvent) => void): void {
    this.captureHandler = handler;
  }

  setTapGate(gate: () => boolean): void {
    this.tapGate = gate;
  }

  setDictation(dictation: TapDictation): void {
    this.dictation = dictation;
  }

  /** Hands captures to a live voice session while one is open; null takes them back. */
  setLiveCapture(capture: LiveCapture | null): void {
    this.liveCapture = capture;
  }

  /** True from the moment the microphone opens until the transcript is handed on. */
  get capturing(): boolean {
    return this.phase === 'listening' || this.phase === 'transcribing';
  }

  private captureEnded(reason: Extract<CaptureEvent, { type: 'end' }>['reason']): void {
    const interactionId = this.interactionId;
    if (interactionId) this.captureHandler?.({ type: 'end', interactionId, reason });
  }

  private trace(
    kind: TraceEvent['kind'],
    text?: string,
    detail?: TraceEvent['detail'],
    id = this.interactionId
  ): void {
    if (!id) return;
    this.traceHandler?.({
      interactionId: id,
      at: new Date().toISOString(),
      kind,
      ...(text !== undefined ? { text: text.slice(0, 4000) } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  setVocabularyProvider(provider: () => string[]): void {
    this.vocabulary = provider;
  }

  get settings(): VoiceSettings | null {
    return this.status?.settings ?? null;
  }

  get isListening(): boolean {
    return this.phase === 'listening';
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  async startListening(
    mode: ListenMode,
    intent: TranscriptIntent = 'command',
    origin: ListenOrigin = 'user',
    options: { endOnPause?: boolean } = {}
  ): Promise<void> {
    if (this.phase === 'listening' || this.phase === 'transcribing') return;
    // One microphone at a time: dictation is finished or cancelled first.
    if (this.dictation?.capturing) return;
    this.speech.stop(); // barge-in
    const interactionId = crypto.randomUUID();
    this.interactionId = interactionId;
    this.trace('capture', undefined, { mode, intent, origin });
    this.captureHandler?.({ type: 'start', interactionId, origin, intent });
    this.mode = mode;
    this.intent = intent;
    this.origin = origin;
    this.error = null;
    this.ignoredUtterance = null;
    this.level = 0;
    this.partial = '';
    // Hands-free listening and a tap end on a pause; otherwise the user ends it by releasing the
    // hold key, pressing the toggle shortcut again, or clicking Send.
    this.endsOnPause = origin === 'hands-free' || options.endOnPause === true;
    this.quietMs = 0;
    this.silence = this.endsOnPause ? new SilenceDetector() : null;
    this.leftOpen =
      mode === 'toggle' && origin === 'user' && !this.endsOnPause
        ? new SilenceDetector(LEFT_OPEN_MS)
        : null;
    this.phase = 'listening';
    // A command the developer ends themselves is heard by the live session when one is open.
    // Dictation, a tap (which ends on a pause the recorder measures), the wake phrase and the
    // voice test keep the recorder.
    const live =
      intent === 'command' && origin === 'user' && !this.endsOnPause && !this.captureNext
        ? this.liveCapture
        : null;
    if (live?.begin(interactionId)) {
      this.live = { capture: live, since: Date.now() };
      this.meterLive(true);
      if (mode === 'toggle') {
        this.maxTimer = setTimeout(() => void this.stopListening(), MAX_MANUAL_MS);
      }
      return;
    }
    this.openStream();
    try {
      await this.recorder.start({ withPreRoll: origin === 'hands-free' });
    } catch (error) {
      this.abortStream();
      this.trace('stt-failed', undefined, { reason: 'microphone' });
      runInAction(() => {
        this.phase = 'error';
        this.error = describeMicError(error);
      });
      this.captureEnded('failed');
      return;
    }
    if (mode === 'toggle') {
      const maxMs = this.endsOnPause ? MAX_HANDS_FREE_MS : MAX_MANUAL_MS;
      this.maxTimer = setTimeout(() => void this.stopListening(), maxMs);
    }
  }

  /**
   * One tap of the talk key. With something waiting for a spoken reply it answers that: the
   * capture it starts ends on a pause, and a second tap sends it at once. Otherwise it starts
   * dictation to the open agent, and the next tap finishes and sends it.
   */
  tap(): void {
    const now = Date.now();
    // The in-app key and the system-wide key hook can both report the same tap.
    if (now - this.lastTapAt < TAP_REPEAT_MS) return;
    if (this.phase === 'listening') {
      if (this.mode === 'toggle' && this.endsOnPause && this.origin === 'user') {
        this.lastTapAt = now;
        void this.stopListening();
      }
      return;
    }
    if (this.dictation?.active) {
      this.lastTapAt = now;
      this.dictation.toggle();
      return;
    }
    if (this.phase !== 'idle') return;
    if (this.tapGate?.()) {
      this.lastTapAt = now;
      void this.startListening('toggle', 'command', 'user', { endOnPause: true });
    } else if (this.dictation) {
      this.lastTapAt = now;
      this.dictation.toggle();
    }
  }

  async stopListening(): Promise<void> {
    if (this.phase !== 'listening') return;
    this.clearMaxTimer();
    if (this.live) {
      this.finishLive(this.live);
      return;
    }
    const { wav, durationMs } = this.recorder.stop();
    if (durationMs < MIN_UTTERANCE_MS) {
      this.abortStream();
      this.trace('ignored', undefined, { reason: 'too-short' });
      runInAction(() => {
        this.phase = 'idle';
        this.level = 0;
      });
      this.captureEnded('too-short');
      return;
    }
    runInAction(() => {
      this.phase = 'transcribing';
      this.level = 0;
    });
    const intent = this.intent;
    const origin = this.origin;
    const streamed = await this.closeStream();
    if (streamed !== null) {
      await this.finishTranscript(
        streamed.text,
        streamed.latencyMs,
        intent,
        origin,
        streamed.confidence
      );
      return;
    }
    try {
      const client = await getVoiceClient();
      const result = await client.transcribe(
        { vocabulary: this.vocabulary().slice(0, 200) },
        {
          name: 'utterance.wav',
          mimeType: 'audio/wav',
          size: wav.byteLength,
          source: (async function* () {
            yield wav;
          })(),
        }
      );
      if (!result.success) {
        this.trace('stt-failed', undefined, { reason: result.error.type });
        runInAction(() => {
          this.phase = 'error';
          this.error = {
            message: result.error.message,
            kind: result.error.type === 'not-configured' ? 'not-configured' : 'engine',
          };
        });
        this.captureEnded('failed');
        return;
      }
      await this.finishTranscript(
        result.data.text,
        result.data.latencyMs,
        intent,
        origin,
        result.data.confidence
      );
    } catch (error) {
      this.trace('stt-failed', undefined, { reason: 'request' });
      log.error('voice: transcription request failed', { error });
      runInAction(() => {
        this.phase = 'error';
        this.error = { message: 'Transcription failed. See the log for details.', kind: 'other' };
      });
      this.captureEnded('failed');
    }
  }

  /** The live session heard the capture: it answers, and no transcript is handed on here. */
  private finishLive(live: { capture: LiveCapture; since: number }): void {
    const interactionId = this.interactionId;
    this.live = null;
    this.meterLive(false);
    if (!interactionId || Date.now() - live.since < MIN_UTTERANCE_MS) {
      live.capture.cancel();
      runInAction(() => {
        this.phase = 'idle';
        this.level = 0;
      });
      this.trace('ignored', undefined, { reason: 'too-short' });
      this.captureEnded('too-short');
      return;
    }
    // Until the session has taken the words the capture is not over, as with a transcription
    // in progress: a cancel window that appears meanwhile waits for what was said.
    runInAction(() => {
      this.phase = 'transcribing';
      this.level = 0;
    });
    void live.capture
      .end(interactionId)
      .catch(() => false)
      .then((taken) => {
        runInAction(() => {
          if (this.phase === 'transcribing' && this.interactionId === interactionId) {
            this.phase = 'idle';
          }
        });
        if (!taken) this.captureHandler?.({ type: 'end', interactionId, reason: 'ignored' });
      });
  }

  /**
   * The live session hears a capture through its own track, which nothing here measures: the
   * recorder listens along without recording, so the level meter moves as the developer speaks.
   * Afterwards it goes back to what hands-free asks for.
   */
  private meterLive(on: boolean): void {
    const monitor = on || (this.settings?.handsFree ?? false);
    void this.recorder.setMonitoring(monitor).catch((error: unknown) => {
      // The session still hears the developer; only the meter stays flat.
      if (on) log.warn('voice: no level meter for the live capture', { error });
    });
  }

  cancelListening(): void {
    this.trace('ignored', undefined, { reason: 'cancelled' });
    this.clearMaxTimer();
    this.abortStream();
    this.partial = '';
    if (this.live) {
      this.live.capture.cancel();
      this.live = null;
      this.meterLive(false);
    } else this.recorder.cancel();
    this.phase = 'idle';
    this.level = 0;
    // After the phase changed, so a listener sees the microphone closed.
    this.captureEnded('cancelled');
  }

  async toggle(intent: TranscriptIntent = 'command'): Promise<void> {
    if (this.phase === 'listening') await this.stopListening();
    else await this.startListening('toggle', intent);
  }

  dismissError(): void {
    this.error = null;
    if (this.phase === 'error') this.phase = 'idle';
  }

  private onChunk(level: number, durationMs: number): void {
    if (this.phase === 'idle' && this.settings?.handsFree && !this.speaking && !this.muted) {
      if (this.onset.push(level, durationMs)) {
        this.onset.reset();
        void this.startListening('toggle', 'command', 'hands-free');
      }
      return;
    }
    if (this.phase !== 'listening') return;
    runInAction(() => {
      // Smooth for the HUD meter.
      this.level = this.level * 0.6 + Math.min(1, level * 6) * 0.4;
    });
    if (this.silence?.push(level, durationMs)) {
      void this.stopListening();
      return;
    }
    // A tap that nobody spoke after: close the microphone instead of waiting out the full limit.
    if (this.origin === 'user' && this.endsOnPause && this.silence && !this.silence.hasSpeech) {
      this.quietMs += durationMs;
      if (this.quietMs >= NO_SPEECH_MS) this.cancelListening();
    }
    // A click-to-talk capture nobody ended: send what was said, or drop one with no speech.
    if (this.leftOpen?.push(level, durationMs)) {
      void this.stopListening();
      return;
    }
    if (this.leftOpen && !this.leftOpen.hasSpeech) {
      this.quietMs += durationMs;
      if (this.quietMs >= LEFT_OPEN_MS) this.cancelListening();
    }
  }

  /** Applies the wake phrase to hands-free speech, records the transcript, and hands it off. */
  private async finishTranscript(
    raw: string,
    latencyMs: number,
    intent: TranscriptIntent,
    origin: ListenOrigin,
    confidence?: number
  ): Promise<void> {
    const text = raw.trim();
    let command: string | null = text;
    let followUp = false;
    if (origin === 'hands-free') {
      command = stripWakePhrase(text, this.settings?.wakePhrase ?? 'chorus');
      // Right after a reply, the developer is still talking to the conductor.
      if (command === null && text && intent === 'command' && Date.now() < this.followUpUntil) {
        command = text;
        followUp = true;
      }
    }
    this.followUpArmed = 0;
    this.followUpUntil = 0;
    runInAction(() => {
      this.phase = 'idle';
      this.partial = '';
      this.lastTranscript = text;
      this.lastLatencyMs = latencyMs;
      this.ignoredUtterance = command === null && text ? text : null;
    });
    this.trace('stt-final', text, {
      origin,
      intent,
      latencyMs,
      engine: this.settings?.engine ?? 'unknown',
      ...(confidence !== undefined ? { confidence } : {}),
      ...(followUp ? { followUp: true } : {}),
    });
    if (command === null) this.trace('ignored', text, { reason: 'wake-phrase' });
    const capture = this.captureNext;
    if (capture) {
      this.captureNext = null;
      this.captureEnded('ignored');
      capture(text);
      return;
    }
    if (!command) {
      this.captureEnded('ignored');
      return;
    }
    await this.handler?.(command, intent, this.interactionId ?? crypto.randomUUID());
    // One follow-up per command: a follow-up itself opens no window, so stray speech cannot
    // keep a conversation going on its own.
    if (intent === 'command' && !followUp && this.settings?.handsFree) {
      // A reply that takes a moment to start is still this command's reply, for a while.
      this.followUpArmed = Date.now() + FOLLOW_UP_REPLY_MS;
      this.followUpUntil = Date.now() + FOLLOW_UP_MS;
    }
  }

  /**
   * Records one utterance and returns its transcript without sending it to the conductor (voice
   * setup's "say hello" test). Resolves '' if nothing was heard.
   */
  async captureOnce(): Promise<string> {
    const result = new Promise<string>((resolve) => (this.captureNext = resolve));
    await this.startListening('toggle', 'command', 'user');
    if (this.phase === 'error') {
      this.captureNext = null;
      return '';
    }
    return result;
  }

  // ── Live streaming ─────────────────────────────────────────────────────────

  private openStream(): void {
    this.streamId = null;
    this.streamPending = [];
    if (this.settings?.engine !== 'deepgram' || this.settings.streaming === false) {
      this.streamOpening = null;
      return;
    }
    this.streamOpening = getVoiceClient()
      .then((client) => client.openStream({ vocabulary: this.vocabulary().slice(0, 200) }))
      .then(async (opened) => {
        if (!opened.supported || !opened.streamId || this.phase !== 'listening') {
          if (opened.streamId)
            await (await getVoiceClient()).abortStream({ streamId: opened.streamId });
          this.streamPending = [];
          return;
        }
        this.streamId = opened.streamId;
        const client = await getVoiceClient();
        for (const pcm of this.streamPending.splice(0)) {
          void client.pushAudio({ streamId: opened.streamId, pcm });
        }
      })
      .catch((error: unknown) => {
        log.warn('voice: live stream unavailable; will upload instead', { error });
        this.streamPending = [];
      });
  }

  private onPcm(pcm: Uint8Array<ArrayBuffer>): void {
    if (this.phase !== 'listening' || !this.streamOpening) return;
    const encoded = bytesToBase64(pcm);
    const streamId = this.streamId;
    if (!streamId) {
      this.streamPending.push(encoded);
      return;
    }
    void getVoiceClient().then((client) => client.pushAudio({ streamId, pcm: encoded }));
  }

  /** Final text from the live stream, or null to fall back to uploading the recording. */
  private async closeStream(): Promise<{
    text: string;
    latencyMs: number;
    confidence?: number;
  } | null> {
    const opening = this.streamOpening;
    this.streamOpening = null;
    if (!opening) return null;
    await opening;
    const streamId = this.streamId;
    this.streamId = null;
    if (!streamId) return null;
    try {
      const result = await (await getVoiceClient()).closeStream({ streamId });
      if (result.success) return result.data;
      log.warn('voice: live stream failed; uploading instead', { error: result.error });
    } catch (error) {
      log.warn('voice: live stream failed; uploading instead', { error });
    }
    return null;
  }

  private abortStream(): void {
    const streamId = this.streamId;
    this.streamId = null;
    this.streamOpening = null;
    this.streamPending = [];
    if (streamId) void getVoiceClient().then((client) => client.abortStream({ streamId }));
  }

  /** Global hold-to-talk from the system-wide key hook (works while other apps are focused). */
  private onGlobalHold(
    action: 'start' | 'stop' | 'cancel' | 'tap',
    intent: TranscriptIntent = 'command'
  ): void {
    if (action === 'start') void this.startListening('hold', intent);
    else if (action === 'stop') void this.stopListening();
    else if (action === 'tap') this.tap();
    else this.cancelListening();
  }

  // ── Hands-free ─────────────────────────────────────────────────────────────

  /** Starts or stops continuous listening to match the setting. */
  async applyHandsFree(): Promise<void> {
    const on = this.settings?.handsFree ?? false;
    try {
      await this.recorder.setMonitoring(on);
    } catch (error) {
      runInAction(() => {
        this.phase = 'error';
        this.error = describeMicError(error);
      });
    }
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** Speaks a conductor reply (respects mute and the speak-replies setting). */
  say(text: string, interactionId?: string): void {
    const id = interactionId ?? this.interactionId;
    if (this.muted || this.settings?.speakReplies === false) {
      this.trace('speech', undefined, { status: 'suppressed' }, id);
      return;
    }
    void this.play(text, id, false);
  }

  /**
   * Speaks one sentence and resolves when it has ended, however it ended. It never talks over the
   * developer: while the microphone is open the sentence is not started.
   */
  speak(text: string, options: SpeakOptions = {}): Promise<SpeechResult> {
    const id = options.interactionId ?? this.interactionId;
    const allowed = options.attention
      ? this.settings?.speakAttention !== false
      : this.settings?.speakReplies !== false;
    if (this.muted || !allowed || this.isListening) {
      this.trace('speech', undefined, { status: 'suppressed' }, id);
      return Promise.resolve('suppressed');
    }
    return this.play(text, id, options.voice === 'system');
  }

  private play(text: string, id: string | null, system: boolean): Promise<SpeechResult> {
    this.trace(
      'speech',
      undefined,
      { status: 'requested', ...(system ? { voice: 'system' } : {}) },
      id
    );
    const requestedAt = performance.now();
    return new Promise<SpeechResult>((resolve) => {
      this.speech.speak(
        text,
        (status) => {
          if (status === 'started') {
            // How long the developer waited for the first sound.
            const ms = Math.round(performance.now() - requestedAt);
            this.trace('speech', undefined, { status, ms }, id);
            return;
          }
          this.trace('speech', undefined, { status }, id);
          resolve(status);
        },
        { platform: system }
      );
    });
  }

  /** Speaks an attention event such as "Codex 1 needs permission". */
  announce(text: string): void {
    if (this.muted || this.settings?.speakAttention === false || this.isListening) return;
    this.speech.speak(text);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.speech.stop();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async refreshStatus(): Promise<void> {
    try {
      const status = await (await getVoiceClient()).getStatus();
      runInAction(() => {
        this.status = status;
        this.speech.configure(status.settings, status.credentials);
      });
      void this.applyHandsFree();
    } catch (error) {
      log.warn('voice: status unavailable', { error });
    }
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<void> {
    const status = await (await getVoiceClient()).updateSettings(patch);
    runInAction(() => {
      this.status = status;
      this.speech.configure(status.settings, status.credentials);
    });
    if ('handsFree' in patch) void this.applyHandsFree();
  }

  async openMicrophoneSettings(): Promise<void> {
    await (await getVoiceClient()).openMicrophoneSettings();
  }

  async setCredential(id: ChorusCredentialId, value: string | null): Promise<void> {
    const status = await (await getVoiceClient()).setCredential({ id, value });
    runInAction(() => {
      this.status = status;
      this.speech.configure(status.settings, status.credentials);
    });
  }
}

function describeMicError(error: unknown): VoiceErrorState {
  if (error instanceof MicError) {
    if (error.kind === 'permission-denied')
      return { message: error.message, kind: 'mic-permission' };
    if (error.kind === 'no-device') return { message: error.message, kind: 'mic-missing' };
    return { message: error.message, kind: 'other' };
  }
  return { message: 'The microphone could not be opened.', kind: 'other' };
}
