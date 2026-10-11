import { comparer, makeAutoObservable, reaction, runInAction } from 'mobx';
import { looksLikeSttArtifact } from '@core/features/conductor/api/jev-router/trace';
import {
  VOICE_HAND_OFF_TOOL,
  type ConductorTalkLine,
  type LineAgent,
  type LineHearing,
} from '@core/features/conductor/api/voice-line';
import { log } from '@core/primitives/logging/browser/logger';
import type { TalkClient } from '../api/browser/client';
import type { TalkSettings, TalkStatus } from '../api/contract';
import { isEcho, neverEcho, recentSpoken, type Spoken } from '../api/echo-guard';
import { inputSize, tokensFromUsage } from '../api/usage';
import {
  NEEDS_KEY_REPLY,
  NEEDS_KEY_RESULT,
  ROLLOVER_INSTRUCTIONS,
  sayExactly,
  VOICE_INSTRUCTIONS,
  voiceTools,
} from '../api/voice-prompt';
import {
  agentChanges,
  carriedOver,
  feedSnapshot,
  feedUpdate,
  needsRollover,
} from '../api/world-feed';
import type { RealtimeEvent, SessionDeps, SessionState } from './realtime-session';

/** What the line needs from the conductor (kept structural so it tests without one). */
export interface TalkConductorPort {
  setTalkLine(line: ConductorTalkLine | null): void;
  /** One read-only tool call from the voice model, as text for it. */
  voiceRead(name: string, input: unknown): Promise<string>;
  /** Everything the conductor knows right now, for the start of a session. */
  voiceSnapshot(): Promise<string>;
  lineAgents(): LineAgent[];
  /** Words heard with no key pressed: they may steer or cancel, never act. */
  hearOnLine(text: string): LineHearing;
  /** The voice model asked for an action; the developer's own words go to the conductor. */
  handOffFromVoice(text: string): Promise<string>;
  /** Shows what the voice said. */
  showVoiceReply(text: string): void;
  traceLine(status: string, detail?: Record<string, string | number | boolean>): void;
  /** True while a call from an agent can be picked up. */
  readonly callOnLine: boolean;
  /** True when a code check can run, so the voice may be offered that tool. */
  readonly codeChecksReady: boolean;
}

/** What the line needs from the voice slice. */
export interface TalkVoicePort {
  /** A local voice (a reply, a read-back) is playing. */
  readonly speaking: boolean;
  /** The developer holds the microphone through a key. */
  readonly capturing: boolean;
  readonly muted: boolean;
}

export interface SessionLike {
  readonly state: SessionState;
  open(): Promise<void>;
  send(event: RealtimeEvent): boolean;
  close(): void;
}

export type TalkDeps = {
  client(): Promise<TalkClient>;
  conductor: TalkConductorPort;
  voice: TalkVoicePort;
  createSession(deps: Omit<SessionDeps, 'createPeer'>): SessionLike;
  /** Opens the microphone for the line. The track starts disabled. */
  microphone(): Promise<MediaStreamTrack>;
  /** Plays the provider's voice; null stops playing. */
  play(stream: MediaStream | null, muted: boolean): void;
  now?: () => number;
};

/** off: not wanted. connecting, open: as they say. down: wanted, but not working right now. */
export type LineState = 'off' | 'connecting' | 'open' | 'down';

/** How long the voice may take to start a sentence it was asked to say as written. */
const SAY_START_MS = 4_000;
/** No sentence plays longer than this: a missed "stopped" event must not hold anything up. */
const VOICE_MAX_MS = 60_000;
/** The room is given this long to go quiet after a voice stops, before the microphone opens. */
const ECHO_TAIL_MS = 300;
/** The microphone stays open this long at most without words that were meant for Maestro. */
const MAX_WINDOW_MS = 60_000;
/** A line shut for the day's limit looks again this often: the limit starts over with the day. */
const BUDGET_RECHECK_MS = 30 * 60_000;
/** A summary for a fresh session that has not come back after this long is given up. */
const ROLLOVER_MS = 30_000;
/** A hand-off is honoured only this soon after the key-started words it belongs to. */
const KEY_TURN_MS = 60_000;
/** Changes to agents are gathered this long before they are sent as one update. */
const FEED_DELAY_MS = 500;
const RETRY_MS = 30_000;
const MAX_RETRIES = 3;

type Saying = {
  resolve(said: boolean): void;
  timer: ReturnType<typeof setTimeout>;
  /** Ends the wait whatever happened: a lost "stopped" event must not hold the caller up. */
  maxTimer: ReturnType<typeof setTimeout>;
  started: boolean;
  /** The provider's id for the response that says it, once known. */
  responseId: string | null;
};

/**
 * The talk line: a realtime voice session that lets the developer talk with Maestro without
 * pressing a key for every sentence. It reads the transcript of each turn before anything
 * answers, lets the voice model answer only talk, and passes every action back to the conductor.
 * When the line is not open, everything works as it did without it.
 */
export class TalkStore {
  line: LineState = 'off';
  /** The microphone is open for talk (no key held). */
  windowOpen = false;
  /** The provider's voice is playing. */
  speaking = false;
  status: TalkStatus | null = null;
  error: string | null = null;

  private session: SessionLike | null = null;
  private track: MediaStreamTrack | null = null;
  private spoken: Spoken[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceTimer: ReturnType<typeof setTimeout> | null = null;
  private rollTimer: ReturnType<typeof setTimeout> | null = null;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the window opened, or last heard words meant for Maestro. */
  private windowSince = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  /** The provider hears speech right now. */
  private hearing = false;
  private known = new Map<string, LineAgent>();
  private openedAt = 0;
  private inputTokens = 0;
  /** The key-started words the voice is answering, and when: a hand-off is theirs alone. */
  private keyTurn: { text: string; at: number } | null = null;
  private saying: Saying | null = null;
  private toolsRunning = 0;
  private readonly handledCalls = new Set<string>();
  private rolling = false;
  private carry: string | null = null;
  private disposers: (() => void)[] = [];
  private readonly now: () => number;

  /** What the conductor sees of the line. */
  private readonly port: ConductorTalkLine = {
    ready: () => this.ready,
    answer: (text) => this.answer(text),
    say: (text) => this.say(text),
    note: (text) => this.note(text),
    spoke: (text) => this.noteSpoken(text),
  };

  constructor(private readonly deps: TalkDeps) {
    this.now = deps.now ?? Date.now;
    makeAutoObservable<
      TalkStore,
      | 'deps'
      | 'session'
      | 'track'
      | 'spoken'
      | 'windowTimer'
      | 'tailTimer'
      | 'voiceTimer'
      | 'rollTimer'
      | 'budgetTimer'
      | 'windowSince'
      | 'retryTimer'
      | 'retries'
      | 'hearing'
      | 'known'
      | 'openedAt'
      | 'inputTokens'
      | 'keyTurn'
      | 'saying'
      | 'toolsRunning'
      | 'handledCalls'
      | 'rolling'
      | 'carry'
      | 'disposers'
      | 'now'
      | 'port'
    >(this, {
      deps: false,
      session: false,
      track: false,
      spoken: false,
      windowTimer: false,
      tailTimer: false,
      voiceTimer: false,
      rollTimer: false,
      budgetTimer: false,
      windowSince: false,
      retryTimer: false,
      retries: false,
      hearing: false,
      known: false,
      openedAt: false,
      inputTokens: false,
      keyTurn: false,
      saying: false,
      toolsRunning: false,
      handledCalls: false,
      rolling: false,
      carry: false,
      disposers: false,
      now: false,
      port: false,
    });
  }

  get settings(): TalkSettings | null {
    return this.status?.settings ?? null;
  }

  /** The line can take a turn right now. */
  get ready(): boolean {
    return this.line === 'open' && !this.rolling && this.status?.overBudget !== true;
  }

  activate(): void {
    void this.refreshStatus().then(() => this.reconcile());
    const { voice, conductor } = this.deps;
    this.disposers.push(
      // A key was pressed, or a local voice started: the line's microphone closes at once, so
      // the same words are never heard twice and a read-back is never heard at all.
      reaction(
        () => voice.capturing || voice.speaking,
        (busy) => {
          if (busy) {
            if (voice.capturing) this.stopVoice();
            this.closeWindow();
          } else if (conductor.callOnLine) this.openWindowSoon();
        }
      ),
      // A call went on the line: steering it ("skip", "later") needs no key.
      reaction(
        () => conductor.callOnLine,
        (onLine) => {
          if (onLine) this.openWindowSoon();
        }
      ),
      reaction(
        () => conductor.lineAgents(),
        (agents) => this.onAgents(agents),
        { delay: FEED_DELAY_MS, equals: comparer.structural }
      ),
      reaction(
        () => voice.muted,
        (muted) => {
          // Muted, the line neither speaks nor listens for talk it could not answer aloud.
          if (!muted) return;
          this.stopVoice();
          this.closeWindow();
        }
      )
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.budgetTimer = null;
    this.shut('off');
  }

  async refreshStatus(): Promise<void> {
    try {
      const status = await (await this.deps.client()).getStatus();
      runInAction(() => (this.status = status));
    } catch (error) {
      log.warn('talk: status unavailable', { error });
    }
  }

  async updateSettings(patch: Partial<TalkSettings>): Promise<void> {
    const before = this.settings;
    const status = await (await this.deps.client()).updateSettings(patch);
    runInAction(() => (this.status = status));
    // A different model, voice, or way of taking turns is a different session.
    const after = status.settings;
    const reshaped =
      before !== null &&
      (before.model !== after.model ||
        before.voice !== after.voice ||
        before.effort !== after.effort ||
        before.talkOver !== after.talkOver ||
        before.transcriptionModel !== after.transcriptionModel);
    if (reshaped && this.line !== 'off') this.shut('off');
    this.retries = 0;
    this.reconcile();
  }

  /** Opens or closes the line to match what the settings ask for. */
  private reconcile(): void {
    const status = this.status;
    const wanted = status?.settings.enabled === true && status.hasKey && !status.overBudget;
    if (wanted && (this.line === 'off' || this.line === 'down')) void this.start();
    else if (!wanted && this.line !== 'off') this.shut('off');
    // Wanted, and only the day's limit is in the way: the line opens again by itself.
    if (status?.settings.enabled === true && status.hasKey && status.overBudget) {
      this.recheckBudgetLater();
    }
  }

  private recheckBudgetLater(): void {
    if (this.budgetTimer) return;
    this.budgetTimer = setTimeout(() => {
      this.budgetTimer = null;
      void this.refreshStatus().then(() => this.reconcile());
    }, BUDGET_RECHECK_MS);
  }

  // ── Opening and closing ─────────────────────────────────────────────────────

  private async start(): Promise<void> {
    if (this.line === 'connecting' || this.line === 'open') return;
    runInAction(() => {
      this.line = 'connecting';
      this.error = null;
    });
    let track: MediaStreamTrack | null = null;
    try {
      track = await this.deps.microphone();
      // Nothing is heard until a window opens.
      track.enabled = false;
      const session = this.deps.createSession({
        track,
        exchange: (sdp) => this.exchange(sdp),
        onEvent: (event) => this.onEvent(event),
        onState: (state) => this.onSessionState(session, state),
        // Never attached muted: a muted line does not speak at all (see `say`, `onHeard`), and
        // a player muted here would stay silent after the developer unmutes.
        onRemoteStream: (stream) => this.deps.play(stream, false),
      });
      this.session = session;
      this.track = track;
      await session.open();
      if (this.session !== session) return;
      const snapshot = feedSnapshot(
        await this.deps.conductor.voiceSnapshot(),
        new Date(this.now())
      );
      this.known = new Map(this.deps.conductor.lineAgents().map((agent) => [agent.id, agent]));
      this.openedAt = this.now();
      this.inputTokens = 0;
      this.retries = 0;
      this.sendNote(snapshot);
      if (this.carry) this.sendNote(this.carry);
      this.carry = null;
      runInAction(() => (this.line = 'open'));
      this.deps.conductor.setTalkLine(this.port);
      this.deps.conductor.traceLine('opened', { model: this.settings?.model ?? '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The talk line could not open.';
      log.warn('talk: the line could not open', { error });
      if (track && this.track !== track) track.stop();
      this.shut('down', message);
      this.retryLater(error);
    }
  }

  /** Trades the offer for the provider's answer, through the main process. */
  private async exchange(sdp: string): Promise<string> {
    const client = await this.deps.client();
    const result = await client.openCall({
      sdp,
      instructions: VOICE_INSTRUCTIONS,
      tools: voiceTools({ codeChecks: this.deps.conductor.codeChecksReady }),
    });
    if (!result.success) throw new TalkOpenError(result.error.type, result.error.message);
    return result.data.sdp;
  }

  private retryLater(error: unknown): void {
    // A missing key, a spent limit, or a switch that is off does not fix itself.
    const transient =
      !(error instanceof TalkOpenError) ||
      error.kind === 'unreachable' ||
      error.kind === 'api-error' ||
      error.kind === 'rate-limited';
    if (!transient || this.retries >= MAX_RETRIES || this.retryTimer) return;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.reconcile();
    }, RETRY_MS);
  }

  private onSessionState(session: SessionLike, state: SessionState): void {
    if (this.session !== session) return;
    if ((state === 'failed' || state === 'closed') && this.line === 'open') {
      this.shut('down', 'The talk line dropped.');
      this.retryLater(null);
    }
  }

  /** Closes the session and everything that depends on it. */
  private shut(next: 'off' | 'down', message: string | null = null): void {
    const wasOpen = this.line === 'open';
    const session = this.session;
    this.session = null;
    session?.close();
    this.track?.stop();
    this.track = null;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    this.hearing = false;
    this.keyTurn = null;
    this.toolsRunning = 0;
    this.handledCalls.clear();
    this.endRollover();
    this.finishSaying(false);
    this.deps.play(null, false);
    this.deps.conductor.setTalkLine(null);
    if (wasOpen) this.deps.conductor.traceLine(next === 'off' ? 'closed' : 'dropped');
    runInAction(() => {
      this.line = next;
      this.windowOpen = false;
      this.speaking = false;
      this.error = message;
    });
  }

  // ── What the conductor asks of the line ─────────────────────────────────────

  /** Answers words the developer said with a key, which the router read as talk. */
  private async answer(text: string): Promise<boolean> {
    if (!this.ready || this.deps.voice.muted) return false;
    const sent = this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    if (!sent) return false;
    this.keyTurn = { text, at: this.now() };
    return this.send({ type: 'response.create' });
  }

  /** Says one sentence as written; resolves once it has been said, or false if it was not. */
  private say(text: string): Promise<boolean> {
    const { voice } = this.deps;
    // While the developer holds the key, nothing of Maestro's may play into what they say.
    if (!this.ready || this.saying || voice.muted || voice.capturing) {
      return Promise.resolve(false);
    }
    const sent = this.send({
      type: 'response.create',
      response: {
        // Outside the conversation: the sentence is the conductor's, not the voice model's.
        conversation: 'none',
        input: [],
        output_modalities: ['audio'],
        instructions: sayExactly(text),
        // The sentence may quote an agent. Saying it must never turn into doing something.
        tool_choice: 'none',
        metadata: { purpose: 'say' },
      },
    });
    if (!sent) return Promise.resolve(false);
    this.noteSpoken(text);
    this.sendNote(`[Maestro told the developer] ${text}`);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Nothing was heard in time: stop it, and let the caller say it another way.
        if (this.saying && !this.saying.started) {
          this.send({ type: 'response.cancel' });
          this.finishSaying(false);
        }
      }, SAY_START_MS);
      const maxTimer = setTimeout(
        () => this.finishSaying(this.saying?.started === true),
        VOICE_MAX_MS
      );
      this.saying = { resolve, timer, maxTimer, started: false, responseId: null };
    });
  }

  private finishSaying(said: boolean): void {
    const saying = this.saying;
    if (!saying) return;
    this.saying = null;
    clearTimeout(saying.timer);
    clearTimeout(saying.maxTimer);
    saying.resolve(said);
  }

  /** Tells the voice model something, without making it speak. */
  private note(text: string): void {
    if (this.line === 'open') this.sendNote(text);
  }

  private sendNote(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  private send(event: RealtimeEvent): boolean {
    return this.session?.send(event) ?? false;
  }

  // ── What the provider tells the line ────────────────────────────────────────

  private onEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.hearing = true;
        break;
      case 'input_audio_buffer.speech_stopped':
        this.hearing = false;
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.onHeard(str(event.item_id), str(event.transcript));
        break;
      case 'conversation.item.input_audio_transcription.failed':
        // Nothing to read, so nothing may answer it; like noise, it does not keep the
        // microphone open either.
        this.forget(str(event.item_id));
        break;
      case 'response.output_audio_transcript.done':
        this.onSaid(str(event.transcript));
        break;
      case 'response.function_call_arguments.done':
        void this.onToolCall(str(event.call_id), str(event.name), str(event.arguments));
        break;
      case 'response.created':
        this.onResponseCreated(event.response);
        break;
      case 'output_audio_buffer.started':
        this.onVoiceStarted(str(event.response_id));
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.onVoiceStopped(str(event.response_id));
        break;
      case 'response.done':
        this.onResponseDone(event.response);
        break;
      case 'error':
        log.warn('talk: the provider reported an error', { error: event.error });
        // Whatever was asked for may never come: a sentence that has not started is not said,
        // and a summary that was refused must not keep the line shut.
        if (this.saying && !this.saying.started) this.finishSaying(false);
        this.endRollover();
        break;
      default:
        break;
    }
  }

  /**
   * The transcript of a turn heard with no key pressed. It is read before anything answers:
   * an echo or noise is dropped, a steering word runs, a command is refused until a key is
   * pressed, and only talk reaches the voice model.
   */
  private onHeard(itemId: string, transcript: string): void {
    const heard = transcript.trim();
    this.spoken = recentSpoken(this.spoken, this.now());
    const echo = !neverEcho(heard) && isEcho(heard, this.spoken, this.now());
    if (!heard || looksLikeSttArtifact(heard) || echo) {
      // Noise does not keep the microphone open: the window runs out as it would have.
      this.forget(itemId);
      this.deps.conductor.traceLine('ignored', { reason: heard ? 'echo-or-noise' : 'empty' });
      return;
    }
    // Words spoken with no key are never the key-started request a hand-off may carry.
    this.keyTurn = null;
    this.windowSince = this.now();
    const hearing = this.deps.conductor.hearOnLine(heard);
    this.deps.conductor.traceLine('heard', { owner: hearing });
    // The developer took the key meanwhile, or muted Maestro: no voice of Maestro's may play.
    // What they say with the key is what counts now.
    const silent = this.deps.voice.capturing || this.deps.voice.muted;
    if (hearing === 'talk' && !silent) {
      this.send({ type: 'response.create' });
      return;
    }
    // A command is not conversation: the voice model should not answer it later.
    this.forget(itemId);
    if (silent) return;
    if (hearing === 'needs-key') void this.say(NEEDS_KEY_REPLY).then(() => this.openWindow());
    else this.openWindow();
  }

  /** Removes a turn the voice model must not see as something said to it. */
  private forget(itemId: string): void {
    if (itemId) this.send({ type: 'conversation.item.delete', item_id: itemId });
  }

  private onSaid(transcript: string): void {
    const said = transcript.trim();
    if (!said) return;
    this.noteSpoken(said);
    // A sentence said as written was shown by whoever asked for it.
    if (!this.saying) this.deps.conductor.showVoiceReply(said);
  }

  private noteSpoken(said: string): void {
    this.spoken = [...recentSpoken(this.spoken, this.now()), { text: said, at: this.now() }];
  }

  private async onToolCall(callId: string, name: string, rawArguments: string): Promise<void> {
    if (!callId || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    const session = this.session;
    this.toolsRunning++;
    let output: string;
    try {
      output =
        name === VOICE_HAND_OFF_TOOL
          ? await this.handOff()
          : await this.deps.conductor.voiceRead(name, parseArguments(rawArguments));
    } catch (error) {
      output = error instanceof Error ? error.message : 'That could not be read.';
    }
    // The session was replaced while the tool ran: its answer belongs to nobody.
    if (this.session !== session) return;
    this.toolsRunning = Math.max(0, this.toolsRunning - 1);
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // One answer for all the calls of a response, once the last result is in. Not while the
    // developer holds the key: they have moved on, and the result waits for their next words.
    if (this.toolsRunning === 0 && !this.deps.voice.capturing && !this.deps.voice.muted) {
      this.send({ type: 'response.create' });
    }
  }

  /** The voice model wants something done. Only key-started words may ask for that. */
  private async handOff(): Promise<string> {
    const turn = this.keyTurn;
    this.keyTurn = null;
    if (!turn || this.now() - turn.at > KEY_TURN_MS) return NEEDS_KEY_RESULT;
    this.deps.conductor.traceLine('hand-off');
    return this.deps.conductor.handOffFromVoice(turn.text);
  }

  private onResponseCreated(response: unknown): void {
    const created = (response ?? {}) as { id?: unknown; metadata?: { purpose?: unknown } | null };
    if (created.metadata?.purpose === 'say' && this.saying && typeof created.id === 'string') {
      this.saying.responseId = created.id;
    }
  }

  /** True when `responseId` is the response of the sentence being said as written. */
  private isSaying(responseId: string): boolean {
    const saying = this.saying;
    if (!saying) return false;
    // Without ids on both sides there is nothing to tell two responses apart by.
    return !saying.responseId || !responseId || saying.responseId === responseId;
  }

  private onVoiceStarted(responseId: string): void {
    if (this.saying && this.isSaying(responseId)) this.saying.started = true;
    runInAction(() => (this.speaking = true));
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = setTimeout(() => {
      this.voiceTimer = null;
      this.onVoiceStopped('');
    }, VOICE_MAX_MS);
    // The developer is holding the key: nothing of Maestro's plays into what they are saying.
    if (this.deps.voice.capturing) {
      this.stopVoice();
      return;
    }
    // Without talk-over the microphone is shut while the voice speaks, so it never hears itself.
    if (!this.settings?.talkOver) this.closeWindow();
  }

  private onVoiceStopped(responseId: string): void {
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    runInAction(() => (this.speaking = false));
    // Another response stopping says nothing about the sentence that was asked for.
    if (this.saying?.started && this.isSaying(responseId)) this.finishSaying(true);
    this.openWindowSoon();
    this.maybeRollOver();
  }

  private onResponseDone(response: unknown): void {
    const done = (response ?? {}) as {
      status?: unknown;
      usage?: unknown;
      metadata?: { purpose?: unknown } | null;
      output?: unknown;
    };
    const purpose = done.metadata?.purpose;
    const tokens = tokensFromUsage(done.usage);
    // Only a response in the conversation says how full the session is.
    if (purpose === undefined) {
      this.inputTokens = inputSize(tokens);
      // The answer to the key-started words is finished: a later response cannot hand them
      // off. A response that only called tools is not finished yet.
      if (!callsTools(done.output)) this.keyTurn = null;
    }
    void this.recordUsage(tokens);
    if (purpose === 'say' && done.status !== 'completed') this.finishSaying(false);
    if (purpose === 'rollover') {
      // A summary that comes after the line gave up waiting belongs to nothing: the session
      // has been taking turns again.
      if (!this.rolling) return;
      if (done.status === 'completed') void this.replace(responseText(done.output));
      else this.endRollover();
    }
  }

  private async recordUsage(tokens: ReturnType<typeof tokensFromUsage>): Promise<void> {
    const model = this.settings?.model;
    if (!model) return;
    try {
      const status = await (await this.deps.client()).recordUsage({ model, tokens });
      runInAction(() => (this.status = status));
      if (status.overBudget && this.line !== 'off') {
        this.deps.conductor.traceLine('over-budget', { usd: status.usageToday.usd });
        this.shut('off', "Today's talk line limit is used up.");
        this.recheckBudgetLater();
      }
    } catch (error) {
      log.warn('talk: usage was not recorded', { error });
    }
  }

  // ── The microphone window ───────────────────────────────────────────────────

  /**
   * Opens the microphone for talk. It stays shut while a key is held, while any voice the
   * microphone could hear is playing, and when the setting asks for no window at all.
   */
  private openWindow(): void {
    const settings = this.settings;
    const track = this.track;
    if (this.line !== 'open' || !track || !settings || settings.windowSec <= 0) return;
    const { voice } = this.deps;
    if (voice.capturing || voice.speaking || voice.muted) return;
    // A session about to be replaced takes no more talk.
    if (this.rolling) return;
    if (this.speaking && !settings.talkOver) return;
    if (!this.windowOpen) this.windowSince = this.now();
    track.enabled = true;
    runInAction(() => (this.windowOpen = true));
    this.armWindow(settings.windowSec * 1000);
  }

  /** Opens the window once the room has had a moment to go quiet after a voice. */
  private openWindowSoon(): void {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      this.openWindow();
    }, ECHO_TAIL_MS);
  }

  private armWindow(ms: number): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      // Mid-sentence: the window waits for the developer to finish. Sound that never turns
      // into words for Maestro (a meeting, a radio) does not hold it open for ever.
      const stale = this.now() - this.windowSince >= MAX_WINDOW_MS;
      if (this.hearing && !stale) this.armWindow(ms);
      else this.closeWindow();
    }, ms);
  }

  private closeWindow(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    if (this.track) this.track.enabled = false;
    this.hearing = false;
    if (this.windowOpen) runInAction(() => (this.windowOpen = false));
    // Nobody is talking now: the moment to swap a full session for a fresh one.
    if (!this.speaking && !this.deps.voice.capturing) this.maybeRollOver();
  }

  /** Stops the voice mid-sentence (the developer pressed a key or muted). */
  private stopVoice(): void {
    if (!this.speaking && !this.saying) return;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
    this.finishSaying(false);
  }

  // ── Keeping the voice model's picture current ───────────────────────────────

  private onAgents(agents: readonly LineAgent[]): void {
    if (this.line !== 'open') return;
    const update = feedUpdate(agentChanges(this.known, agents), new Date(this.now()));
    this.known = new Map(agents.map((agent) => [agent.id, agent]));
    if (update) this.sendNote(update);
  }

  /** A long or full session is replaced by a fresh one, at a moment nobody is talking. */
  private maybeRollOver(): void {
    if (this.rolling || this.line !== 'open' || this.windowOpen || this.toolsRunning > 0) return;
    if (!needsRollover(this.inputTokens, this.now() - this.openedAt)) return;
    this.rolling = true;
    const asked = this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        instructions: ROLLOVER_INSTRUCTIONS,
        tool_choice: 'none',
        metadata: { purpose: 'rollover' },
      },
    });
    if (!asked) {
      this.rolling = false;
      return;
    }
    // The line takes no turn while it waits for the summary; it must not wait for ever.
    this.rollTimer = setTimeout(() => {
      this.rollTimer = null;
      this.rolling = false;
    }, ROLLOVER_MS);
  }

  /** The summary came, or never will: the line takes turns again. */
  private endRollover(): void {
    if (this.rollTimer) clearTimeout(this.rollTimer);
    this.rollTimer = null;
    this.rolling = false;
  }

  private async replace(summary: string): Promise<void> {
    this.deps.conductor.traceLine('rolled-over', { inputTokens: this.inputTokens });
    this.carry = carriedOver(summary);
    this.shut('down');
    await this.start();
  }
}

/** Why the provider would not open a session, as the main process reported it. */
class TalkOpenError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(message);
    this.name = 'TalkOpenError';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Left for the tool's own schema to refuse.
    return { _unparsed: raw };
  }
}

/** True when a response asked for a tool: its answer comes in a later response. */
function callsTools(output: unknown): boolean {
  return (
    Array.isArray(output) &&
    (output as { type?: unknown }[]).some((item) => item?.type === 'function_call')
  );
}

/** The text of a text-only response. */
function responseText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output as { content?: unknown }[]) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content as { text?: unknown; transcript?: unknown }[]) {
      if (typeof part?.text === 'string') parts.push(part.text);
      else if (typeof part?.transcript === 'string') parts.push(part.transcript);
    }
  }
  return parts.join(' ');
}
