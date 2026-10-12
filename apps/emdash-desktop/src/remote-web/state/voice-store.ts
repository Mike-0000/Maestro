import {
  REMOTE_MAX_UTTERANCE_BYTES,
  type RemoteVoiceEvent,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { ReplicaState, type StateStore } from '@emdash/wire/live';
import { createImmutableMobxStore } from '@emdash/wire/mobx';
import { makeAutoObservable, reaction, runInAction, when } from 'mobx';
import { bytesToBase64, concatBytes, meterLevel } from '../lib/audio-codec';
import { AudioSession } from '../lib/audio-session';
import { MicError, MicRecorder, type MicErrorKind, type Recording } from '../lib/mic-recorder';
import { SpeechOutput } from '../lib/speech-output';
import {
  AttentionBatcher,
  detectReply,
  formatElapsed,
  IDLE_CAPTURE,
  MAX_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  newlyNeedingAttention,
  reduceCapture,
  type CaptureEvent,
  type CaptureIntent,
  type CaptureMode,
  type CaptureState,
  type ReplyCursor,
} from '../lib/voice-logic';
import type { RemoteApi } from '../lib/wire-link';
import type { AppStore } from './app-store';

/**
 * What happens to a finished recording, or typed text, on its way to the conductor.
 * - `waiting-link`: recorded while the host was out of reach; sent when it is back.
 * - `transcribing`: the host is turning the recording into text.
 * - `sending`: the text is being handed to the conductor.
 */
export type VoiceStage = 'idle' | 'waiting-link' | 'transcribing' | 'sending';

/** Something that went wrong on this device or on the way to the host, shown in the HUD. */
export type VoiceNotice = {
  kind:
    | 'mic-insecure'
    | 'mic-denied'
    | 'mic-missing'
    | 'mic-busy'
    | 'mic-failed'
    | 'too-short'
    | 'silent'
    | 'no-speech'
    | 'too-long'
    | 'stt-unavailable'
    | 'host-unavailable'
    | 'offline'
    | 'backgrounded'
    | 'failed';
  title: string;
  body: string;
  /** The recording or text is still held and can be sent again. */
  canRetry: boolean;
};

const HUD_RETRY_MS = 1_500;
/** Number of bars in the recording waveform. */
export const WAVEFORM_BARS = 36;
/** Audio is streamed for live transcription in batches of about this long. */
const STREAM_BATCH_BYTES = 6_400; // 200 ms of 16 kHz PCM16
/** A recording whose loudest moment is below this is a microphone delivering silence. */
const SILENT_PEAK = 0.0015;
/** How long a recording made offline waits for the host before giving up. */
const LINK_WAIT_MS = 45_000;
/** After the link comes up, a changed reply is treated as old news for this long. */
const SETTLE_MS = 2_500;
/** How long this device counts as waiting for the conductor's answer to what it sent. */
const AWAIT_REPLY_MS = 45_000;

const MUTED_KEY = 'maestro.voice.muted';
const ATTENTION_KEY = 'maestro.voice.attention';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Private browsing: the choice lasts for this visit only.
  }
}

function haptic(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Haptics are a nicety.
  }
}

type Stream = {
  /** Resolves once the host has said whether it can transcribe live. */
  opening: Promise<void>;
  id: string | null;
  /** PCM waiting to be batched, and batches waiting for the stream id. */
  buffered: Uint8Array[];
  bufferedBytes: number;
  queued: string[];
  broken: boolean;
};

/**
 * Voice mode: this device as the host conductor's microphone, speaker and heads-up display.
 * Owns recording, the path from a recording to the conductor, spoken replies, and the notices
 * about agents that start waiting.
 */
export class VoiceStore {
  hudOpen = false;
  capture: CaptureState = IDLE_CAPTURE;
  stage: VoiceStage = 'idle';
  /** The finger is in the cancel zone: releasing now discards the recording. */
  cancelArmed = false;
  /** Smoothed microphone level, 0..1. */
  level = 0;
  /** Recent levels, oldest first, for the waveform. */
  levels: number[] = Array<number>(WAVEFORM_BARS).fill(0);
  elapsedMs = 0;
  /** Live transcript while the host is transcribing as you speak. */
  partial = '';
  /** What this device last said or typed, shown until the host's display catches up. */
  heard = '';
  notice: VoiceNotice | null = null;
  speaking = false;
  muted = readFlag(MUTED_KEY, false);
  announceAttention = readFlag(ATTENTION_KEY, true);
  responding = false;
  /** The command being typed in the HUD. */
  typed = '';
  /** The composer a dictation in progress belongs to. */
  dictationKey: string | null = null;

  private hudStore: StateStore<RemoteVoiceState> | null = null;
  private hudReplica: ReplicaState<RemoteVoiceState> | null = null;
  private hudReady = false;
  private unsubscribeEvents: (() => void) | null = null;
  private api: RemoteApi | null = null;

  private readonly audio = new AudioSession();
  private readonly recorder: MicRecorder;
  private readonly speech: SpeechOutput;
  private readonly attention: AttentionBatcher;

  private stream: Stream | null = null;
  private pressedAt = 0;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever the work in flight is abandoned; late results check it. */
  private job = 0;
  private retryAction: (() => void) | null = null;
  private dictationSink: ((text: string) => void) | null = null;

  private replyCursor: ReplyCursor = null;
  /** The turn last seen on the display, to notice when a new one begins. */
  private lastTurn: { utterance: string; phase: RemoteVoiceState['phase'] } | null = null;
  private awaitingReply = false;
  private awaitingTimer: ReturnType<typeof setTimeout> | undefined;
  /** The reply that was on the display when this device last spoke; hidden until replaced. */
  private supersededReplyAt: number | null = null;
  private dismissedHostError: string | null = null;
  private waitingAgents: Set<string> | null = null;
  private queuedAnnouncement: string | null = null;
  private waveformTick = 0;

  constructor(private readonly app: AppStore) {
    this.recorder = new MicRecorder(() => this.audio.context(), {
      onLevel: (level, elapsedMs) => this.onLevel(level, elapsedMs),
      onPcm: (pcm) => this.onPcm(pcm),
    });
    this.speech = new SpeechOutput(
      this.audio,
      {
        start: async (requestId, text) => {
          const api = this.api;
          if (!api) return false;
          return (await api.remote.voice.speak({ requestId, text })).success;
        },
        stop: (requestId) => {
          void this.api?.remote.voice.stopSpeaking({ requestId }).catch(() => {});
        },
      },
      (speaking) => this.onSpeakingChange(speaking)
    );
    this.attention = new AttentionBatcher((sentence) => this.announce(sentence));
    makeAutoObservable<
      VoiceStore,
      | 'app'
      | 'hudStore'
      | 'hudReplica'
      | 'unsubscribeEvents'
      | 'api'
      | 'audio'
      | 'recorder'
      | 'speech'
      | 'attention'
      | 'stream'
      | 'pressedAt'
      | 'maxTimer'
      | 'job'
      | 'retryAction'
      | 'dictationSink'
      | 'replyCursor'
      | 'lastTurn'
      | 'awaitingTimer'
      | 'waitingAgents'
      | 'queuedAnnouncement'
      | 'waveformTick'
    >(this, {
      app: false,
      hudStore: false,
      hudReplica: false,
      unsubscribeEvents: false,
      api: false,
      audio: false,
      recorder: false,
      speech: false,
      attention: false,
      stream: false,
      pressedAt: false,
      maxTimer: false,
      job: false,
      retryAction: false,
      dictationSink: false,
      replyCursor: false,
      lastTurn: false,
      awaitingTimer: false,
      waitingAgents: false,
      queuedAnnouncement: false,
      waveformTick: false,
    });
  }

  /** Follows the session and the page's lifecycle. Returns the teardown. */
  start(): () => void {
    const stopApi = reaction(
      () => this.app.api,
      (api) => (api ? this.attach(api) : this.detach()),
      { fireImmediately: true }
    );
    const stopHud = reaction(
      () => this.hud,
      (hud) => {
        if (hud) this.onHud(hud);
      }
    );
    const stopAgents = reaction(
      () => this.app.overview?.agents ?? null,
      (agents) => {
        if (!agents) {
          this.waitingAgents = null;
          this.attention.clear();
          return;
        }
        const { waiting, names } = newlyNeedingAttention(this.waitingAgents, agents);
        this.waitingAgents = waiting;
        this.attention.add(names);
      },
      { fireImmediately: true }
    );
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        this.audio.resume();
        return;
      }
      // A page in the background loses the microphone; do not send half an utterance.
      if (this.capture.phase !== 'idle') {
        const command = this.capture.intent === 'command';
        this.dispatch({ type: 'cancel' });
        if (command) {
          this.setNotice(
            'backgrounded',
            'Recording stopped',
            'Maestro went to the background, so nothing was sent.'
          );
        }
      }
      this.speech.stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopApi();
      stopHud();
      stopAgents();
      document.removeEventListener('visibilitychange', onVisibility);
      this.detach();
    };
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  /** The host conductor's display; null until it has loaded. */
  get hud(): RemoteVoiceState | null {
    if (!this.hudReady || !this.hudStore) return null;
    return this.hudStore.current();
  }

  /** The host's window is up and can take commands. */
  get available(): boolean {
    return this.hud?.available === true;
  }

  get isRecording(): boolean {
    return this.capture.phase !== 'idle';
  }

  /** Recording, or working on a recording, for the conductor (not a dictation). */
  get commandActive(): boolean {
    return (
      (this.capture.phase !== 'idle' && this.capture.intent === 'command') ||
      (this.stage !== 'idle' && this.dictationKey === null)
    );
  }

  /** A recording for the conductor is open or opening. */
  get commandRecording(): boolean {
    return this.capture.phase !== 'idle' && this.capture.intent === 'command';
  }

  get recordingMode(): CaptureMode | null {
    return this.capture.phase === 'idle' ? null : this.capture.mode;
  }

  get elapsedLabel(): string {
    return formatElapsed(this.elapsedMs);
  }

  /** The conductor is working on something, or has yet to react to what this device sent. */
  get thinking(): boolean {
    return this.awaitingReply || (this.hud !== null && this.hud.phase !== 'idle');
  }

  /** What was said, as far as anyone knows: this device's own words first. */
  get utterance(): string {
    return this.heard || this.hud?.lastUtterance || '';
  }

  /** The conductor's latest reply, unless this device has since said something new. */
  get reply(): string {
    const hud = this.hud;
    if (!hud || hud.replyAt === this.supersededReplyAt) return '';
    return hud.reply;
  }

  get hostError(): string | null {
    const error = this.hud?.error ?? null;
    return error && error !== this.dismissedHostError ? error : null;
  }

  /** Something on the display wants an answer or is in progress, for the mic button's badge. */
  get needsLook(): boolean {
    const hud = this.hud;
    if (!hud) return false;
    return hud.pending !== null || hud.plan?.status === 'proposed' || this.thinking;
  }

  dictationPhase(key: string): 'idle' | 'starting' | 'recording' | 'transcribing' {
    if (this.dictationKey !== key) return 'idle';
    if (this.capture.phase !== 'idle') return this.capture.phase;
    return this.stage === 'idle' ? 'idle' : 'transcribing';
  }

  // ── HUD ────────────────────────────────────────────────────────────────────

  openHud(): void {
    this.hudOpen = true;
  }

  closeHud(): void {
    if (this.capture.phase !== 'idle' && this.capture.intent === 'command') {
      this.dispatch({ type: 'cancel' });
    }
    this.hudOpen = false;
  }

  dismissNotice(): void {
    this.notice = null;
    this.retryAction = null;
  }

  dismissHostError(): void {
    this.dismissedHostError = this.hud?.error ?? null;
  }

  retry(): void {
    const action = this.retryAction;
    this.dismissNotice();
    action?.();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    writeFlag(MUTED_KEY, muted);
    if (muted) {
      this.queuedAnnouncement = null;
      this.speech.stop();
    }
  }

  setAnnounceAttention(on: boolean): void {
    this.announceAttention = on;
    writeFlag(ATTENTION_KEY, on);
    if (!on) this.queuedAnnouncement = null;
  }

  /** Says a sample with the voice replies will use. Call from a tap, which also unlocks audio. */
  testVoice(): void {
    this.audio.unlock();
    this.speech.speak('This is how Maestro sounds on this device.', this.hud?.speech ?? 'device');
  }

  setTyped(text: string): void {
    this.typed = text;
  }

  /** Reads the reply on the display aloud because the person asked, muted or not. */
  readReplyAloud(): void {
    const reply = this.reply;
    if (!reply) return;
    this.audio.unlock();
    this.queuedAnnouncement = null;
    this.speech.speak(reply, this.hud?.speech ?? 'device');
  }

  stopSpeaking(): void {
    this.queuedAnnouncement = null;
    this.speech.stop();
  }

  // ── Talking ────────────────────────────────────────────────────────────────

  /**
   * The mic was pressed (finger or key). Starts recording at once: holding records until the
   * release, and a press too short to hold speech becomes tap-to-talk. Must run inside the user
   * gesture, because this is where audio playback is unlocked for the replies to come.
   */
  pressStart(): void {
    this.audio.unlock();
    this.stopSpeaking();
    this.hudOpen = true;
    if (this.capture.phase !== 'idle' || this.stage !== 'idle') return;
    this.pressedAt = performance.now();
    this.cancelArmed = false;
    haptic(10);
    this.dispatch({ type: 'begin', mode: 'hold', intent: 'command' });
  }

  /** The finger moved into or out of the cancel zone. */
  pressArm(cancel: boolean): void {
    if (this.cancelArmed === cancel || this.recordingMode !== 'hold') return;
    this.cancelArmed = cancel;
    haptic(6);
  }

  /** The press ended. `latch` turns a quick tap into tap-to-talk instead of dropping it. */
  pressEnd(options: { cancel?: boolean; latch: boolean }): void {
    if (this.recordingMode !== 'hold') return;
    const cancel = options.cancel === true || this.cancelArmed;
    this.cancelArmed = false;
    this.dispatch({
      type: 'release',
      heldMs: performance.now() - this.pressedAt,
      cancel,
      latch: options.latch,
    });
  }

  /** Tap-to-talk from the keyboard or an assistive tap: start, or finish and send. */
  toggleTalk(): void {
    if (this.capture.phase !== 'idle') {
      this.finishTalking();
      return;
    }
    this.audio.unlock();
    this.stopSpeaking();
    this.hudOpen = true;
    if (this.stage !== 'idle') return;
    haptic(10);
    this.dispatch({ type: 'begin', mode: 'tap', intent: 'command' });
  }

  /** Ends the recording and sends it. */
  finishTalking(): void {
    if (this.capture.phase === 'idle') return;
    haptic(8);
    this.dispatch({ type: 'finish' });
  }

  /** Drops the recording, or abandons one that is on its way to the conductor. */
  cancelTalking(): void {
    if (this.capture.phase !== 'idle') {
      this.dispatch({ type: 'cancel' });
      return;
    }
    if (this.stage === 'idle') return;
    this.job += 1;
    this.retryAction = null;
    this.stage = 'idle';
    this.dictationKey = null;
    this.dictationSink = null;
  }

  /** Hands typed text to the conductor. Resolves false when it could not be delivered. */
  async sendTyped(text: string): Promise<boolean> {
    const command = text.trim();
    if (!command || this.stage !== 'idle' || this.capture.phase !== 'idle') return false;
    this.audio.unlock();
    this.stopSpeaking();
    this.dismissNotice();
    return this.say(command, { keepOnFailure: false });
  }

  /** Answers a confirmation or a proposed plan. */
  async respond(decision: 'yes' | 'no'): Promise<void> {
    const api = this.api;
    if (!api || this.responding) return;
    this.audio.unlock();
    this.responding = true;
    try {
      const result = await api.remote.voice.respond({ decision });
      if (!result.success) this.reportHostFailure(result.error.type, result.error.message);
    } catch {
      this.setNotice('offline', 'Couldn’t reach the host', 'Your answer was not sent. Try again.');
    } finally {
      runInAction(() => {
        this.responding = false;
      });
    }
  }

  // ── Dictation ──────────────────────────────────────────────────────────────

  /**
   * Starts dictating into a text field, or finishes a dictation already running for it. The
   * transcript goes to `insert`; it is not sent anywhere and never reaches the conductor.
   */
  toggleDictation(key: string, insert: (text: string) => void): void {
    if (this.dictationKey === key) {
      if (this.capture.phase !== 'idle') this.finishTalking();
      return;
    }
    if (this.capture.phase !== 'idle' || this.stage !== 'idle') return;
    this.audio.unlock();
    this.stopSpeaking();
    haptic(10);
    this.dictationKey = key;
    this.dictationSink = insert;
    this.dispatch({ type: 'begin', mode: 'tap', intent: 'dictation' });
  }

  cancelDictation(key: string): void {
    if (this.dictationKey === key) this.cancelTalking();
  }

  // ── Capture machinery ──────────────────────────────────────────────────────

  private dispatch(event: CaptureEvent): void {
    const before = this.capture;
    const { state, effect } = reduceCapture(before, event);
    this.capture = state;
    if (effect === 'open') void this.openMic();
    else if (effect === 'finish' && before.phase !== 'idle') this.finishCapture(before.intent);
    else if (effect === 'discard') this.discardCapture();
    if (state.phase === 'idle') {
      clearTimeout(this.maxTimer);
      this.cancelArmed = false;
      if (effect !== 'finish' && before.phase !== 'idle' && before.intent === 'dictation') {
        this.dictationKey = null;
        this.dictationSink = null;
      }
    }
  }

  private async openMic(): Promise<void> {
    const intent = this.capture.phase === 'idle' ? 'command' : this.capture.intent;
    this.job += 1;
    this.notice = null;
    this.retryAction = null;
    this.partial = '';
    this.level = 0;
    this.levels = Array<number>(WAVEFORM_BARS).fill(0);
    this.elapsedMs = 0;
    this.stream = intent === 'command' ? this.openStream() : null;
    try {
      await this.recorder.open();
    } catch (error) {
      this.abortStream();
      const kind = error instanceof MicError ? error.kind : 'failed';
      runInAction(() => {
        if (this.capture.phase !== 'starting') return;
        this.dispatch({ type: 'failed' });
        this.reportMicError(kind, intent);
      });
      return;
    }
    runInAction(() => {
      if (this.capture.phase !== 'starting') {
        // Cancelled by something other than the state machine (the page went away).
        this.recorder.cancel();
        this.abortStream();
        return;
      }
      this.maxTimer = setTimeout(() => this.finishTalking(), MAX_UTTERANCE_MS);
      this.dispatch({ type: 'opened' });
    });
  }

  private discardCapture(): void {
    this.recorder.cancel();
    this.abortStream();
    this.partial = '';
    this.level = 0;
  }

  private finishCapture(intent: CaptureIntent): void {
    const recording = this.recorder.stop();
    this.level = 0;
    const reject = (kind: VoiceNotice['kind'], title: string, body: string): void => {
      this.abortStream();
      this.partial = '';
      this.report(intent, kind, title, body);
      this.endDictation();
    };
    if (recording.durationMs < MIN_UTTERANCE_MS) {
      reject(
        'too-short',
        'That was too short',
        'Hold the mic while you speak, or tap it once and tap again when you’re done.'
      );
      return;
    }
    if (recording.peak < SILENT_PEAK) {
      reject(
        'silent',
        'No sound from the microphone',
        'The microphone was open but silent. Check that it isn’t muted or in use by a call.'
      );
      return;
    }
    if (recording.wav.byteLength > REMOTE_MAX_UTTERANCE_BYTES) {
      reject(
        'too-long',
        'That recording is too long',
        'Recordings can be up to about five minutes. Say it in shorter parts.'
      );
      return;
    }
    void this.deliver(recording, intent);
  }

  /** Turns a recording into text and passes it on: to the conductor, or into the composer. */
  private async deliver(recording: Recording, intent: CaptureIntent): Promise<void> {
    const job = (this.job += 1);
    const current = (): boolean => this.job === job;
    this.stage = 'transcribing';
    const keep = (kind: VoiceNotice['kind'], title: string, body: string): void => {
      if (!current()) return;
      this.stage = 'idle';
      this.partial = '';
      if (intent === 'command') {
        this.setNotice(kind, title, body, () => void this.deliver(recording, intent));
      } else {
        this.app.toast(`${title}. ${body}`, 'error');
        this.endDictation();
      }
    };

    let text = await this.closeStream();
    if (!current()) return;

    if (text === null) {
      if (!this.app.linkUp) {
        runInAction(() => {
          this.stage = 'waiting-link';
        });
        const back = await this.waitForLink();
        if (!current()) return;
        if (!back) {
          runInAction(() =>
            keep(
              'offline',
              'Couldn’t reach the host',
              `Your recording is kept. Send it again when ${this.app.hostName} is back.`
            )
          );
          return;
        }
        runInAction(() => {
          this.stage = 'transcribing';
        });
      }
      const api = this.api;
      if (!api) return;
      try {
        const wav = recording.wav;
        const result = await api.remote.voice.transcribe(
          {},
          {
            name: 'utterance.wav',
            mimeType: 'audio/wav',
            size: wav.byteLength,
            source: (async function* () {
              yield wav;
            })(),
          }
        );
        if (!current()) return;
        if (!result.success) {
          runInAction(() => {
            if (result.error.type === 'unavailable') {
              this.stage = 'idle';
              this.partial = '';
              this.report(
                intent,
                'stt-unavailable',
                'Speech-to-text isn’t set up',
                `Set it up in Maestro on ${this.app.hostName}, under Settings → Voice & Conductor. You can still type.`
              );
              this.endDictation();
            } else {
              keep('failed', 'Couldn’t transcribe that', result.error.message);
            }
          });
          return;
        }
        text = result.data.text;
      } catch {
        runInAction(() =>
          keep(
            'offline',
            'Couldn’t reach the host',
            'The recording did not get through. Your recording is kept; send it again.'
          )
        );
        return;
      }
    }

    const heard = text.trim();
    runInAction(() => {
      this.partial = '';
      if (!heard) {
        this.stage = 'idle';
        this.report(
          intent,
          'no-speech',
          'Didn’t catch that',
          'No words were heard in that recording. Try again, a little closer to the microphone.'
        );
        this.endDictation();
        return;
      }
      if (intent === 'dictation') {
        this.stage = 'idle';
        const insert = this.dictationSink;
        this.endDictation();
        insert?.(heard);
        return;
      }
      void this.say(heard, { keepOnFailure: true });
    });
  }

  /** Hands text to the conductor; its answer arrives through the display. */
  private async say(text: string, options: { keepOnFailure: boolean }): Promise<boolean> {
    const api = this.api;
    const job = (this.job += 1);
    this.stage = 'sending';
    this.heard = text;
    // The answer can reach the display before this call returns, so expect it from now.
    const superseded = this.supersededReplyAt;
    this.supersededReplyAt = this.hud?.replyAt ?? null;
    this.dismissedHostError = this.hud?.error ?? null;
    this.setAwaiting(true);
    const fail = (kind: VoiceNotice['kind'], title: string, body: string): false => {
      runInAction(() => {
        if (this.job !== job) return;
        this.stage = 'idle';
        this.supersededReplyAt = superseded;
        this.setAwaiting(false);
        this.setNotice(
          kind,
          title,
          body,
          options.keepOnFailure ? () => void this.say(text, options) : undefined
        );
      });
      return false;
    };
    if (!api) return fail('offline', 'Couldn’t reach the host', 'Nothing was sent. Try again.');
    try {
      const result = await api.remote.voice.say({ text });
      if (this.job !== job) return result.success;
      if (!result.success) {
        if (result.error.type === 'unavailable') {
          return fail(
            'host-unavailable',
            `Open Maestro on ${this.app.hostName}`,
            'Its window has to be open to take commands. Nothing was sent.'
          );
        }
        return fail('failed', 'The conductor didn’t take that', result.error.message);
      }
      runInAction(() => {
        this.stage = 'idle';
      });
      return true;
    } catch {
      return fail('offline', 'Couldn’t reach the host', 'Nothing was sent. Try again.');
    }
  }

  private waitForLink(): Promise<boolean> {
    const online = when(() => this.app.linkUp, { timeout: LINK_WAIT_MS });
    return online.then(
      () => true,
      () => false
    );
  }

  private endDictation(): void {
    if (this.capture.phase !== 'idle') return;
    this.dictationKey = null;
    this.dictationSink = null;
  }

  // ── Live transcription ─────────────────────────────────────────────────────

  private openStream(): Stream | null {
    const api = this.api;
    if (!api || !this.app.linkUp || this.hud?.transcriptionReady === false) return null;
    const stream: Stream = {
      opening: Promise.resolve(),
      id: null,
      buffered: [],
      bufferedBytes: 0,
      queued: [],
      broken: false,
    };
    stream.opening = api.remote.voice.openStream({}).then(
      (result) => {
        const id = result.success ? result.data.streamId : null;
        if (!id) {
          stream.broken = true;
          stream.queued = [];
          return;
        }
        if (this.stream !== stream) {
          void api.remote.voice.abortStream({ streamId: id }).catch(() => {});
          return;
        }
        stream.id = id;
        for (const pcm of stream.queued.splice(0)) this.pushAudio(stream, pcm);
      },
      () => {
        stream.broken = true;
        stream.queued = [];
      }
    );
    return stream;
  }

  private onPcm(pcm: Uint8Array<ArrayBuffer>): void {
    const stream = this.stream;
    if (!stream || stream.broken) return;
    stream.buffered.push(pcm);
    stream.bufferedBytes += pcm.byteLength;
    if (stream.bufferedBytes >= STREAM_BATCH_BYTES) this.flushStream(stream);
  }

  private flushStream(stream: Stream): void {
    if (stream.bufferedBytes === 0 || stream.broken) return;
    const encoded = bytesToBase64(concatBytes(stream.buffered));
    stream.buffered = [];
    stream.bufferedBytes = 0;
    if (stream.id) this.pushAudio(stream, encoded);
    else stream.queued.push(encoded);
  }

  private pushAudio(stream: Stream, pcm: string): void {
    const api = this.api;
    if (!api || !stream.id) return;
    api.remote.voice.pushAudio({ streamId: stream.id, pcm }).then(
      (result) => {
        if (!result.success) stream.broken = true;
      },
      () => {
        stream.broken = true;
      }
    );
  }

  /** The live stream's final text, or null when the recording has to be uploaded instead. */
  private async closeStream(): Promise<string | null> {
    const stream = this.stream;
    const api = this.api;
    if (!stream || !api) return null;
    await stream.opening;
    this.flushStream(stream);
    if (this.stream === stream) this.stream = null;
    if (!stream.id) return null;
    const streamId = stream.id;
    if (stream.broken) {
      void api.remote.voice.abortStream({ streamId }).catch(() => {});
      return null;
    }
    try {
      const result = await api.remote.voice.closeStream({ streamId });
      // An empty live transcript is not trusted: the upload gets a second opinion.
      return result.success && result.data.text.trim() ? result.data.text : null;
    } catch {
      return null;
    }
  }

  private abortStream(): void {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    stream.broken = true;
    void stream.opening.then(() => {
      if (stream.id) {
        void this.api?.remote.voice.abortStream({ streamId: stream.id }).catch(() => {});
      }
    });
  }

  private onLevel(level: number, elapsedMs: number): void {
    runInAction(() => {
      if (this.capture.phase === 'idle') return;
      const scaled = meterLevel(level);
      this.level = this.level * 0.55 + scaled * 0.45;
      this.elapsedMs = elapsedMs;
      // Two chunks a bar, so the waveform spans about three seconds.
      this.waveformTick += 1;
      const last = this.levels.length - 1;
      if (this.waveformTick % 2 === 0) this.levels = [...this.levels.slice(1), scaled];
      else this.levels[last] = Math.max(this.levels[last] ?? 0, scaled);
    });
  }

  // ── Notices ────────────────────────────────────────────────────────────────

  private setNotice(
    kind: VoiceNotice['kind'],
    title: string,
    body: string,
    retry?: () => void
  ): void {
    this.notice = { kind, title, body, canRetry: retry !== undefined };
    this.retryAction = retry ?? null;
  }

  /** A command's problems show in the HUD; a dictation has no HUD, so they go to a toast. */
  private report(
    intent: CaptureIntent,
    kind: VoiceNotice['kind'],
    title: string,
    body: string
  ): void {
    if (intent === 'command') this.setNotice(kind, title, body);
    else this.app.toast(`${title}. ${body}`, 'error');
  }

  private reportHostFailure(type: string, message: string): void {
    if (type === 'unavailable') {
      this.setNotice(
        'host-unavailable',
        `Open Maestro on ${this.app.hostName}`,
        'Its window has to be open to take commands.'
      );
    } else {
      this.setNotice('failed', 'That didn’t work', message);
    }
  }

  private reportMicError(kind: MicErrorKind, intent: CaptureIntent): void {
    const typing = intent === 'command' ? ' You can still type.' : '';
    switch (kind) {
      case 'insecure':
        this.report(
          intent,
          'mic-insecure',
          'The microphone needs a secure address',
          `Browsers only allow the microphone on https pages. Open Maestro through its https address (your Tailscale or tunnel link) to talk.${typing}`
        );
        return;
      case 'denied':
        this.report(
          intent,
          'mic-denied',
          'Microphone access is off',
          `Allow the microphone for this site in your browser’s site settings, then try again.${typing}`
        );
        return;
      case 'no-device':
        this.report(
          intent,
          'mic-missing',
          'No microphone found',
          `This device has no microphone the browser can use.${typing}`
        );
        return;
      case 'busy':
        this.report(
          intent,
          'mic-busy',
          'The microphone is busy',
          `Another app is using it, perhaps a call. Close that and try again.${typing}`
        );
        return;
      case 'unsupported':
      case 'failed':
        this.report(
          intent,
          'mic-failed',
          'Couldn’t open the microphone',
          `This browser did not provide a microphone.${typing}`
        );
    }
  }

  // ── Display and speech ─────────────────────────────────────────────────────

  private onHud(hud: RemoteVoiceState): void {
    const settling = Date.now() - this.app.linkUpAt < SETTLE_MS;
    const { cursor, fresh, speak } = detectReply(this.replyCursor, hud, {
      settling,
      awaiting: this.awaitingReply,
    });
    this.replyCursor = cursor;
    // A new turn has begun (from this device, another one, or the host itself): the reply on
    // the display answers the previous turn, so it steps aside until a new one arrives.
    const turn = this.lastTurn;
    this.lastTurn = { utterance: hud.lastUtterance, phase: hud.phase };
    const began =
      turn !== null &&
      (turn.utterance !== hud.lastUtterance || (turn.phase === 'idle' && hud.phase !== 'idle'));
    if (began && !fresh) this.supersededReplyAt = hud.replyAt;
    // The host has caught up with what this device said; its wording wins from here.
    if (this.heard && hud.lastUtterance && fresh) this.heard = '';
    if (fresh || hud.pending !== null || hud.plan?.status === 'proposed' || hud.error !== null) {
      this.setAwaiting(false);
    }
    if (hud.error === null) this.dismissedHostError = null;
    if (speak) this.speakReply(speak, hud.speech);
  }

  private speakReply(text: string, mode: RemoteVoiceState['speech']): void {
    if (this.muted || this.capture.phase !== 'idle') return;
    if (document.visibilityState !== 'visible') return;
    this.queuedAnnouncement = null;
    this.speech.speak(text, mode);
  }

  /** "<task> needs you": local to this device, never over a recording or a reply. */
  private announce(sentence: string): void {
    if (!this.announceAttention || this.muted || this.capture.phase !== 'idle') return;
    if (document.visibilityState !== 'visible') return;
    if (this.speaking) {
      this.queuedAnnouncement = sentence;
      return;
    }
    this.speech.speak(sentence, this.hud?.speech ?? 'device');
  }

  private onSpeakingChange(speaking: boolean): void {
    runInAction(() => {
      this.speaking = speaking;
    });
    if (speaking) return;
    const queued = this.queuedAnnouncement;
    this.queuedAnnouncement = null;
    if (queued) this.announce(queued);
  }

  private setAwaiting(awaiting: boolean): void {
    clearTimeout(this.awaitingTimer);
    this.awaitingReply = awaiting;
    if (!awaiting) return;
    this.awaitingTimer = setTimeout(() => {
      runInAction(() => {
        this.awaitingReply = false;
      });
    }, AWAIT_REPLY_MS);
  }

  // ── Host link ──────────────────────────────────────────────────────────────

  private attach(api: RemoteApi): void {
    if (this.api === api) return;
    this.detach();
    this.api = api;
    this.followHud(api);
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    api.remote.voice.events.subscribe(undefined, { onEvent: (event) => this.onEvent(event) }).then(
      (stop) => {
        if (cancelled) stop();
        else unsubscribe = stop;
      },
      () => {
        // Without events there are no live partials and no host speech; replies still arrive
        // through the display and are spoken with the device voice after the usual wait.
      }
    );
    this.unsubscribeEvents = () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  private onEvent(event: RemoteVoiceEvent): void {
    if (event.type !== 'partial') {
      this.speech.handleEvent(event);
      return;
    }
    if (this.stream?.id !== event.streamId) return;
    runInAction(() => {
      this.partial = event.text;
    });
  }

  private followHud(api: RemoteApi): void {
    if (this.api !== api) return;
    const store = createImmutableMobxStore<RemoteVoiceState>();
    const replica = new ReplicaState<RemoteVoiceState>(
      api.remote.voice.state.state(undefined, 'hud'),
      { store }
    );
    this.hudStore = store;
    this.hudReplica = replica;
    replica.ready.then(
      () =>
        runInAction(() => {
          if (this.hudReplica === replica) this.hudReady = true;
        }),
      () => {
        void replica.dispose().catch(() => {});
        if (this.hudReplica !== replica) return;
        setTimeout(() => this.followHud(api), HUD_RETRY_MS);
      }
    );
  }

  private detach(): void {
    this.job += 1;
    if (this.capture.phase !== 'idle') this.dispatch({ type: 'cancel' });
    this.speech.stop();
    this.attention.clear();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    const replica = this.hudReplica;
    this.hudReplica = null;
    this.hudStore = null;
    this.hudReady = false;
    void replica?.dispose().catch(() => {});
    this.api = null;
    this.stage = 'idle';
    this.replyCursor = null;
    this.lastTurn = null;
    this.supersededReplyAt = null;
    this.heard = '';
    this.partial = '';
    this.notice = null;
    this.retryAction = null;
    this.dictationKey = null;
    this.dictationSink = null;
    this.queuedAnnouncement = null;
    this.setAwaiting(false);
  }
}
