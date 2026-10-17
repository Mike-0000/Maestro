import { comparer, makeAutoObservable, reaction, runInAction } from 'mobx';
import { looksLikeSttArtifact } from '@core/features/conductor/api/jev-router/trace';
import {
  wordCount,
  type ConductorTalkLine,
  type LineSpeech,
  type LineToolResult,
  type LineTurnInput,
  type LineTurnResult,
} from '@core/features/conductor/api/voice-line';
import { log } from '@core/primitives/logging/browser/logger';
import type { TalkClient } from '../api/browser/client';
import { talkLineModel, type TalkSettings, type TalkStatus } from '../api/contract';
import { isEcho, neverEcho, recentSpoken, type Spoken } from '../api/echo-guard';
import { inputSize, NO_TOKENS, tokensFromUsage, type TalkTokens } from '../api/usage';
import { lineInstructions, lineTools, ROLLOVER_INSTRUCTIONS } from '../api/voice-prompt';
import {
  CARRIED_RECORDS,
  carriedOver,
  carriedRecords,
  feedSnapshot,
  needsRollover,
} from '../api/world-feed';
import type {
  LineSessionDeps,
  RealtimeEvent,
  SessionGrant,
  SessionState,
} from './grok-voice-session';

/** What the line needs from the conductor (kept structural so it tests without one). */
export interface TalkConductorPort {
  setTalkLine(line: ConductorTalkLine | null): void;
  /** Everything the conductor knows right now, for the start of a session. */
  lineContext(): Promise<string>;
  /**
   * True while words must be read before anything answers them: the conductor is in the middle
   * of something, an action waits for a yes or a stop, or a call from an agent is on the line.
   */
  readonly lineGuarded: boolean;
  /** The line heard the developer and nothing is in the way: the conductor runs the turn. */
  speechTurn(speech: LineSpeech): Promise<void>;
  /** Words the line heard and read first. They are handled like any other transcript. */
  hearOnLine(text: string, heard: { interactionId: string; saidAt: number; key: boolean }): void;
  /** One tool call from the line's model, run behind the conductor's gates. */
  lineTool(name: string, input: unknown): Promise<LineToolResult>;
  /** Shows what the voice is saying. */
  showVoiceReply(text: string): void;
  traceLine(status: string, detail?: Record<string, string | number | boolean>): void;
  /** True while a call from an agent can be picked up. */
  readonly callOnLine: boolean;
  /** True when a code check can run, so the model may be offered that tool. */
  readonly codeChecksReady: boolean;
  /** True while project lookups are turned on, so the model may be offered find_in_project. */
  readonly projectLookupsOn: boolean;
  /**
   * The developer's standing instructions as the model reads them, '' when there are none.
   * Observable: the open session is given them again when they change.
   */
  readonly standingInstructions: string;
}

/** A capture the line takes in place of the recorder: it hears the microphone itself. */
export type LineCapture = {
  /** False when the line cannot take the capture; the recorder then does. */
  begin(interactionId: string): boolean;
  /** The developer finished. Resolves false when nothing they said was handed on. */
  end(interactionId: string): Promise<boolean>;
  cancel(): void;
};

/** What the line needs from the voice slice. */
export interface TalkVoicePort {
  /** A local voice (a reply, a read-back) is playing. */
  readonly speaking: boolean;
  /** The developer holds the microphone through a key or a click. */
  readonly capturing: boolean;
  readonly muted: boolean;
  /** Hands key and click captures to the line while it is open; null takes them back. */
  setLiveCapture(capture: LineCapture | null): void;
}

export interface SessionLike {
  readonly state: SessionState;
  open(): Promise<void>;
  send(event: RealtimeEvent): boolean;
  close(): void;
  /** Keeps what the microphone hears instead of sending it, until `releaseAudio`. */
  holdAudio(): void;
  /** Sends what was kept as if it were heard now (once open), or drops it. */
  releaseAudio(keep: boolean): void;
}

/**
 * A press of the talk key taken while the line was asleep: it is the line's capture, heard once
 * the line is open. What is said meanwhile is kept by the session and sent then.
 */
type EarlyHold = {
  interactionId: string;
  released: boolean;
  /** Settles the developer's release once the line has the words, or false if it never will. */
  settle: ((handed: boolean) => void) | null;
};

export type TalkDeps = {
  client(): Promise<TalkClient>;
  conductor: TalkConductorPort;
  voice: TalkVoicePort;
  createSession(deps: LineSessionDeps): SessionLike;
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
/**
 * xAI may write the next stretch of open-microphone speech as everything said so far: words
 * already heard this recently are not a request of their own. Only long ones, since a short
 * "yes" said twice can mean it.
 */
const REPEAT_MS = 10_000;
const REPEAT_MIN_WORDS = 4;
/** A window after Maestro speaks stays open this long at most without words meant for it. */
const MAX_WINDOW_MS = 60_000;
/** A line shut for the day's limit looks again this often: the limit starts over with the day. */
const BUDGET_RECHECK_MS = 30 * 60_000;
/** A summary for a fresh session that has not come back after this long is given up. */
const ROLLOVER_MS = 30_000;
/** A short word may be let go before the provider reports hearing it: it gets this long. */
const HEAR_GRACE_MS = 400;
/** The provider gets this long to confirm the last words of a capture. */
const SEAL_MS = 1_500;
/** Nothing waits longer than this for the transcript of what was said. */
const TRANSCRIPT_WAIT_MS = 4_000;
/** A response that has not finished after this long is given up. */
const RESPONSE_MAX_MS = 60_000;
/** An open line reports the time it has been open this often: it is billed by the minute. */
const CLOCK_MS = 60_000;
/** A line that is busy when its quiet spell would be up is looked at again this much later. */
const IDLE_RECHECK_MS = 10_000;
/** A turn may go back to the model with tool results this many times. */
const MAX_ROUNDS = 12;
const RETRY_MS = 30_000;
const MAX_RETRIES = 3;

/** A response xAI cancelled the moment it was asked for is asked again this much later. */
const RETRY_CANCELLED_MS = 500;

const DROPPED_REPLY = 'The voice line dropped before that was finished.';
const NO_ANSWER_REPLY = 'The voice line did not answer.';
const TOO_MANY_STEPS_REPLY = 'I stopped after several steps. Check the canvas.';
const STOPPED_RESULT = 'The developer said stop. Nothing more was done.';
const NO_TURN_RESULT = 'Nothing was done: no request from the developer is open.';

type Saying = {
  resolve(said: boolean): void;
  timer: ReturnType<typeof setTimeout>;
  /** Ends the wait whatever happened: a lost "stopped" event must not hold the caller up. */
  maxTimer: ReturnType<typeof setTimeout>;
  started: boolean;
  /** The provider's id for the response that says it, once known. */
  responseId: string | null;
};

/** One capture the developer started with a key or a click. */
type Hold = {
  readonly interactionId: string;
  readonly startedAt: number;
  /** What the provider made of it so far: one item per stretch of speech. */
  readonly items: string[];
  /** The provider reported speech. */
  spoke: boolean;
  /** The developer let go. */
  released: boolean;
  /** The last words were sent to be committed. */
  committing: boolean;
  /** No more items will join it. */
  sealed: boolean;
};

/** One turn of the model: responses and tool calls until it has answered. */
type Turn = {
  resolve(result: LineTurnResult): void;
  readonly spoken: boolean;
  readonly said: string[];
  /** How many parts of `said` came before the response in flight. */
  saidBefore: number;
  /** Words said in responses that also called a tool. */
  leadWords: number;
  tokens: number;
  toolsRunning: number;
  /** A response of this turn is in flight, and the provider's id for it once known. */
  responding: boolean;
  responseId: string | null;
  /** Tool results were sent that the model has not answered yet. */
  owed: boolean;
  rounds: number;
  stopped: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** The items of the developer's words it answers, when the line heard them itself. */
  readonly heard: (() => readonly string[]) | null;
  /** Everything it put into the conversation: the words, the calls, their results, the answer. */
  readonly items: string[];
  /** What it came to in one line, once the conductor has said. */
  record: string | null;
  /** Its items were taken out of the conversation, and its record stands for it. */
  replaced: boolean;
  /** Asked again once already, after xAI cancelled a response the moment it was asked for. */
  retried: boolean;
};

/**
 * The talk line: a realtime voice session that is the conductor while it is open. It hears the
 * developer (while they hold the talk key, for a moment after Maestro speaks, or all the time),
 * asks its model to answer, and runs every tool the model calls through the conductor store,
 * which keeps its confirmations. Words that could be a yes or a stop to
 * something in progress are read before anything answers them. When the line is not open,
 * everything works as it does without it.
 */
export class TalkStore {
  line: LineState = 'off';
  /** The microphone is open with no key held. */
  micOpen = false;
  /** The developer holds the talk key, and the line is what hears them. */
  holding = false;
  /** The provider's voice is playing. */
  speaking = false;
  status: TalkStatus | null = null;
  error: string | null = null;
  /**
   * The provider closed the session after a quiet spell. The line stays closed, since an open
   * one is billed by the minute, until the developer next takes the talk key.
   */
  asleep = false;

  private session: SessionLike | null = null;
  private track: MediaStreamTrack | null = null;
  private remote: MediaStream | null = null;
  /** The voice is not played: the developer is speaking, or muted Maestro. */
  private hushed = false;
  private spoken: Spoken[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceTimer: ReturnType<typeof setTimeout> | null = null;
  private rollTimer: ReturnType<typeof setTimeout> | null = null;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** When something last happened on the line: a word, a press, a turn, the voice. */
  private activeAt = 0;
  private early: EarlyHold | null = null;
  /**
   * Captures whose last words were committed and not yet confirmed. xAI cancels a response
   * asked for while a commit is still being taken in, so none is asked for until it is.
   */
  private awaitingCommit = new Set<Hold>();
  /** When speech was last committed, for the trace of a response that did not complete. */
  private committedAt = 0;
  /** What the most recent turns came to, carried into a session that opens after a quiet spell. */
  private recent: string[] = [];
  /** What was heard lately with no key held, as said, so a repeat of it is not heard again. */
  private looseHeard: Spoken[] = [];
  /** When the window opened, or last heard words meant for Maestro. */
  private windowSince = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  /** The provider hears speech right now, and since when. */
  private hearing = false;
  private speechAt = 0;
  private openedAt = 0;
  /** Since when the time the line was open has not been reported; 0 while it is not open. */
  private billedSince = 0;
  /** Text inputs sent since the last report: each one is billed. */
  private textInputs = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private inputTokens = 0;
  private hold: Hold | null = null;
  /** Captures whose words are still being read: the model is not asked again until they are. */
  private readonly reading = new Set<Hold>();
  /** Speech heard with no key, by item, with when it began: read before it is answered. */
  private readonly loose = new Map<string, number>();
  /** What the provider wrote for each item it heard; null when it could not. */
  private readonly transcripts = new Map<string, string | null>();
  private readonly waiters = new Set<() => void>();
  private turn: Turn | null = null;
  /** Turns that ended and still sit in the conversation as they happened, oldest first. */
  private past: Turn[] = [];
  /** How many of them belong to an exchange that is over, and wait to be replaced. */
  private closed = 0;
  /** Where the words the line just heard sit, until the turn that answers them takes them. */
  private heard: (() => readonly string[]) | null = null;
  private itemSeq = 0;
  private saying: Saying | null = null;
  /** The responses that said a sentence as written, until they are done. */
  private readonly sayResponses = new Set<string>();
  /** What a summary for a fresh session wrote, should its response not list it. */
  private rollText = '';
  private readonly handledCalls = new Set<string>();
  /** The message that holds the conductor's state, replaced before each turn. */
  private stateItem: string | null = null;
  private stateSeq = 0;
  private rolling = false;
  /** The instructions the session in use was last given. */
  private instructed: string | null = null;
  private carry: string | null = null;
  private disposers: (() => void)[] = [];
  private readonly now: () => number;

  /** What the conductor sees of the line. */
  private readonly port: ConductorTalkLine = {
    ready: () => this.ready,
    turn: (input) => this.takeTurn(input),
    stop: () => this.stop(),
    say: (text) => this.say(text),
    note: (text) => this.note(text),
    record: (text, over) => this.record(text, over),
    spoke: (text) => this.noteSpoken(text),
  };

  /** What the voice slice sees of the line. */
  private readonly capture: LineCapture = {
    begin: (interactionId) => this.beginHold(interactionId),
    end: (interactionId) => this.endHold(interactionId),
    cancel: () => this.cancelHold(),
  };

  /**
   * The capture the voice slice sees while the line is asleep. A press wakes the line and is
   * heard by it, so it never goes to the text conductor while realtime is on.
   */
  private readonly waking: LineCapture = {
    begin: (interactionId) => this.beginEarly(interactionId),
    end: (interactionId) => this.endEarly(interactionId),
    // Once the line is open, the press is an ordinary hold.
    cancel: () => (this.early ? this.cancelEarly() : this.cancelHold()),
  };

  constructor(private readonly deps: TalkDeps) {
    this.now = deps.now ?? Date.now;
    makeAutoObservable<
      TalkStore,
      | 'deps'
      | 'session'
      | 'track'
      | 'remote'
      | 'hushed'
      | 'spoken'
      | 'windowTimer'
      | 'tailTimer'
      | 'voiceTimer'
      | 'rollTimer'
      | 'budgetTimer'
      | 'idleTimer'
      | 'activeAt'
      | 'early'
      | 'recent'
      | 'looseHeard'
      | 'awaitingCommit'
      | 'committedAt'
      | 'waking'
      | 'windowSince'
      | 'retryTimer'
      | 'retries'
      | 'hearing'
      | 'speechAt'
      | 'openedAt'
      | 'billedSince'
      | 'textInputs'
      | 'clockTimer'
      | 'inputTokens'
      | 'hold'
      | 'reading'
      | 'loose'
      | 'transcripts'
      | 'waiters'
      | 'turn'
      | 'past'
      | 'closed'
      | 'heard'
      | 'itemSeq'
      | 'saying'
      | 'sayResponses'
      | 'rollText'
      | 'handledCalls'
      | 'stateItem'
      | 'stateSeq'
      | 'rolling'
      | 'instructed'
      | 'carry'
      | 'disposers'
      | 'now'
      | 'port'
      | 'capture'
    >(this, {
      deps: false,
      session: false,
      track: false,
      remote: false,
      hushed: false,
      spoken: false,
      windowTimer: false,
      tailTimer: false,
      voiceTimer: false,
      rollTimer: false,
      budgetTimer: false,
      idleTimer: false,
      activeAt: false,
      early: false,
      recent: false,
      looseHeard: false,
      awaitingCommit: false,
      committedAt: false,
      waking: false,
      windowSince: false,
      retryTimer: false,
      retries: false,
      hearing: false,
      speechAt: false,
      openedAt: false,
      billedSince: false,
      textInputs: false,
      clockTimer: false,
      inputTokens: false,
      hold: false,
      reading: false,
      loose: false,
      transcripts: false,
      waiters: false,
      turn: false,
      past: false,
      closed: false,
      heard: false,
      itemSeq: false,
      saying: false,
      sayResponses: false,
      rollText: false,
      handledCalls: false,
      stateItem: false,
      stateSeq: false,
      rolling: false,
      instructed: false,
      carry: false,
      disposers: false,
      now: false,
      port: false,
      capture: false,
    });
  }

  get settings(): TalkSettings | null {
    return this.status?.settings ?? null;
  }

  /** The line can take a turn right now. */
  get ready(): boolean {
    return this.line === 'open' && !this.rolling && this.status?.overBudget !== true;
  }

  /** The line is turned on, but today's limit is spent: the text conductor answers. */
  get overBudget(): boolean {
    return this.status?.settings.enabled === true && this.status.overBudget;
  }

  activate(): void {
    void this.refreshStatus().then(() => this.reconcile());
    const { voice, conductor } = this.deps;
    this.disposers.push(
      // The developer took the microphone, or a local voice started: nothing of the line's plays
      // into what they say, and the open microphone never hears a read-back.
      reaction(
        () => voice.capturing || voice.speaking,
        (busy) => {
          // A press after a quiet spell opens the line again for the next one.
          if (voice.capturing && this.asleep) this.wake();
          if (busy) {
            if (voice.capturing) this.hush();
            this.closeWindow();
            return;
          }
          if (!this.speaking) this.unhush();
          this.reopen();
        }
      ),
      // A call went on the line: answering or steering it ("skip", "later") needs no key.
      reaction(
        () => conductor.callOnLine,
        (onLine) => {
          if (onLine) this.openWindowSoon();
        }
      ),
      // The developer changed how the conductor should act or how the voice should sound: the
      // session that is open follows it from its next answer, with no new connection.
      reaction(
        () => [conductor.standingInstructions, this.settings?.voiceStyle ?? ''],
        () => this.reinstruct(),
        { equals: comparer.structural }
      ),
      reaction(
        () => voice.muted,
        (muted) => {
          // Muted, Maestro still listens and acts; its answers are shown instead of said.
          if (muted) this.hush();
          else if (!voice.capturing) this.unhush();
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
    // A different model, voice, way of taking turns, or way of answering is a different session.
    const after = status.settings;
    const reshaped =
      before !== null &&
      (before.model !== after.model ||
        before.agentId !== after.agentId ||
        before.voice !== after.voice ||
        before.effort !== after.effort ||
        before.talkOver !== after.talkOver ||
        before.replies !== after.replies ||
        before.webSearch !== after.webSearch ||
        before.transcriptionModel !== after.transcriptionModel);
    runInAction(() => (this.asleep = false));
    if (reshaped && this.line !== 'off') this.shut('off');
    this.retries = 0;
    this.reconcile();
    // When the microphone is open changed: it takes effect now, not after the next sentence.
    if (!reshaped && this.line === 'open') {
      this.closeWindow();
      this.reopen();
      // So is how long it may stay quiet, timed from now.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.touch();
    }
  }

  /** Opens or closes the line to match what the settings ask for. */
  private reconcile(): void {
    const status = this.status;
    const wanted =
      status?.settings.enabled === true && status.hasKey && !status.overBudget && !this.asleep;
    if (wanted && (this.line === 'off' || this.line === 'down')) void this.start();
    else if (!wanted && this.line !== 'off') this.shut('off');
    // Wanted, and only the day's limit is in the way: the line opens again by itself.
    if (status?.settings.enabled === true && status.hasKey && status.overBudget) {
      this.recheckBudgetLater();
    }
  }

  /**
   * The provider ended the session because nothing was said for a while. Opening it again
   * straight away would bill an idle line all day, so it waits for the next press.
   */
  private sleep(): void {
    this.deps.conductor.traceLine('asleep');
    runInAction(() => (this.asleep = true));
    this.shut('off');
    // The next session hears what the recent turns came to, and the next press goes to it.
    this.carry = carriedRecords(this.recent);
    this.deps.voice.setLiveCapture(this.waking);
  }

  /**
   * The developer said "go to sleep": whatever is being said or done stops, and the line closes
   * as after a quiet spell, until the next press of the talk key.
   */
  private goToSleep(): void {
    this.deps.conductor.traceLine('told-to-sleep');
    const turn = this.turn;
    if (turn) {
      if (turn.responding) this.send({ type: 'response.cancel' });
      this.endTurn(turn, { reply: '', completed: false });
    }
    this.sleep();
  }

  private wake(): void {
    if (!this.asleep) return;
    runInAction(() => (this.asleep = false));
    this.deps.conductor.traceLine('waking');
    this.reconcile();
  }

  /** A press while the line is asleep or still opening: the line will hear it. */
  private beginEarly(interactionId: string): boolean {
    const status = this.status;
    if (!status?.settings.enabled || !status.hasKey || status.overBudget) return false;
    if (this.line !== 'connecting' && !(this.line === 'off' && this.asleep)) return false;
    this.cancelEarly();
    this.early = { interactionId, released: false, settle: null };
    this.hush();
    // A session already opening keeps what is said from now; one not opening yet is started,
    // and keeps it from the moment the microphone is ready.
    this.session?.holdAudio();
    if (this.track) this.track.enabled = true;
    runInAction(() => (this.holding = true));
    this.wake();
    return true;
  }

  private endEarly(interactionId: string): Promise<boolean> {
    const early = this.early;
    if (!early || early.interactionId !== interactionId) return this.endHold(interactionId);
    runInAction(() => (this.holding = false));
    early.released = true;
    return new Promise((resolve) => (early.settle = resolve));
  }

  private cancelEarly(): void {
    const early = this.early;
    if (!early) return;
    this.early = null;
    this.session?.releaseAudio(false);
    if (this.track && this.line !== 'open') this.track.enabled = false;
    runInAction(() => (this.holding = false));
    early.settle?.(false);
  }

  /** The line is open: the press that woke it becomes its capture, with what was said so far. */
  private takeEarly(): void {
    const early = this.early;
    const session = this.session;
    if (!early || !session) {
      session?.releaseAudio(false);
      return;
    }
    this.early = null;
    if (!this.beginHold(early.interactionId)) {
      session.releaseAudio(false);
      early.settle?.(false);
      return;
    }
    session.releaseAudio(true);
    this.deps.conductor.traceLine('woke-for-press');
    if (early.released)
      void this.endHold(early.interactionId).then((handed) => early.settle?.(handed));
  }

  /** Something happened on the line: its quiet spell starts over from now. */
  private touch(): void {
    this.activeAt = this.now();
    if (!this.idleTimer) this.armIdle(this.idleMs());
  }

  /** How long the line may stay quiet before it closes, or 0 when it stays open. */
  private idleMs(): number {
    const settings = this.settings;
    // Listening without the key wants the microphone open all the time.
    if (!settings || settings.listening === 'open') return 0;
    return settings.idleSec * 1000;
  }

  private armIdle(ms: number): void {
    if (ms <= 0 || this.line !== 'open') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.checkIdle();
    }, ms);
  }

  private checkIdle(): void {
    const limit = this.idleMs();
    if (limit <= 0 || this.line !== 'open') return;
    const busy =
      this.turn !== null ||
      this.hold !== null ||
      this.holding ||
      this.micOpen ||
      this.speaking ||
      this.saying !== null ||
      this.rolling;
    if (busy) return this.armIdle(IDLE_RECHECK_MS);
    const left = this.activeAt + limit - this.now();
    if (left > 0) return this.armIdle(left);
    this.deps.conductor.traceLine('idle', { seconds: limit / 1000 });
    this.sleep();
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
      // Nothing is heard until the developer takes the key or the microphone is opened; a press
      // that woke the line is heard from now.
      track.enabled = this.early !== null;
      this.hushed = this.deps.voice.capturing || this.deps.voice.muted;
      const session = this.deps.createSession({
        track,
        connect: () => this.connect(),
        interrupt: this.settings?.talkOver === true,
        onEvent: (event) => this.onEvent(event),
        onState: (state) => this.onSessionState(session, state),
        onRemoteStream: (stream) => {
          this.remote = stream;
          this.deps.play(stream, this.hushed);
        },
      });
      this.session = session;
      this.track = track;
      if (this.early) session.holdAudio();
      await session.open();
      if (this.session !== session) return;
      const context = await this.deps.conductor.lineContext();
      if (this.session !== session) return;
      this.openedAt = this.now();
      this.billedSince = this.openedAt;
      this.textInputs = 0;
      this.clockTimer = setInterval(() => void this.recordUsage(NO_TOKENS), CLOCK_MS);
      this.inputTokens = 0;
      this.retries = 0;
      this.setState(context);
      if (this.carry) this.sendNote(this.carry);
      this.carry = null;
      runInAction(() => (this.line = 'open'));
      this.deps.conductor.setTalkLine(this.port);
      this.deps.voice.setLiveCapture(this.capture);
      this.deps.conductor.traceLine('opened', {
        model: this.settings ? talkLineModel(this.settings) : '',
      });
      // The instructions may have changed while the session was being set up.
      this.reinstruct();
      this.reopen();
      this.touch();
      this.takeEarly();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The talk line could not open.';
      log.warn('talk: the line could not open', { error });
      if (track && this.track !== track) track.stop();
      this.shut('down', message);
      this.retryLater(error);
    }
  }

  /** Has the main process set a session up: where to connect, with what, and as whom. */
  private async connect(): Promise<SessionGrant> {
    const client = await this.deps.client();
    const instructions = this.instructions();
    this.instructed = instructions;
    const result = await client.openSession({
      instructions,
      tools: lineTools({
        codeChecks: this.deps.conductor.codeChecksReady,
        lookups: this.deps.conductor.projectLookupsOn,
      }),
    });
    if (!result.success) throw new TalkOpenError(result.error.type, result.error.message);
    const { url, clientSecret, session } = result.data;
    return { url, clientSecret, session };
  }

  /** Who the line's model is right now: the conductor, with the developer's standing instructions. */
  private instructions(): string {
    return lineInstructions(
      this.settings?.replies ?? 'brief',
      this.deps.conductor.standingInstructions,
      { webSearch: this.settings?.webSearch === true, voiceStyle: this.settings?.voiceStyle ?? '' }
    );
  }

  /**
   * Gives the open session its instructions again when they are no longer the ones it has. The
   * session keeps its conversation; the next answer follows the new text. A line that is not
   * open needs nothing: it is given the current text when it opens.
   */
  private reinstruct(): void {
    if (this.line !== 'open') return;
    const instructions = this.instructions();
    if (instructions === this.instructed) return;
    const sent = this.send({ type: 'session.update', session: { instructions } });
    if (!sent) return;
    this.instructed = instructions;
    this.deps.conductor.traceLine('instructed', { chars: instructions.length });
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
    // The time it was open is billed whatever ends it.
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // A press waiting for the line is let go: what was said is lost with the session.
    this.cancelEarly();
    if (this.billedSince > 0) void this.recordUsage(NO_TOKENS);
    this.billedSince = 0;
    const session = this.session;
    this.session = null;
    session?.close();
    this.track?.stop();
    this.track = null;
    this.remote = null;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    this.hearing = false;
    this.hold = null;
    this.awaitingCommit.clear();
    this.reading.clear();
    this.loose.clear();
    this.looseHeard = [];
    this.transcripts.clear();
    this.handledCalls.clear();
    this.sayResponses.clear();
    this.past = [];
    this.closed = 0;
    this.heard = null;
    this.stateItem = null;
    this.endRollover();
    this.finishSaying(false);
    this.deps.play(null, false);
    this.deps.voice.setLiveCapture(null);
    this.deps.conductor.setTalkLine(null);
    if (wasOpen) this.deps.conductor.traceLine(next === 'off' ? 'closed' : 'dropped');
    runInAction(() => {
      this.line = next;
      this.micOpen = false;
      this.holding = false;
      this.speaking = false;
      this.error = message;
    });
    // Whoever waits on the line (a capture, a turn) is let go.
    this.poke();
    if (this.turn) this.endTurn(this.turn, { reply: DROPPED_REPLY, completed: false });
  }

  // ── The developer holds the key ─────────────────────────────────────────────

  /** The developer took the microphone with a key or a click: the line hears them itself. */
  private beginHold(interactionId: string): boolean {
    if (!this.ready || !this.track) return false;
    this.touch();
    this.hush();
    // A capture still waiting for its last words to be confirmed is complete as it is.
    if (this.hold) this.seal(this.hold);
    // Whatever the microphone picked up before now is not part of what they are about to say.
    this.send({ type: 'input_audio_buffer.clear' });
    this.hold = {
      interactionId,
      startedAt: this.now(),
      items: [],
      spoke: false,
      released: false,
      committing: false,
      sealed: false,
    };
    this.reading.add(this.hold);
    runInAction(() => (this.holding = true));
    this.applyMic();
    return true;
  }

  /**
   * The developer let go. What they said is answered at once when nothing is in the way; when
   * it could be a yes or a stop to something, it is read first.
   */
  private async endHold(interactionId: string): Promise<boolean> {
    this.touch();
    const hold = this.hold;
    if (!hold || hold.interactionId !== interactionId || hold.released) return false;
    hold.released = true;
    runInAction(() => (this.holding = false));
    this.applyMic();
    try {
      return await this.settleHold(hold);
    } finally {
      // Read, or given to the model: a turn that waited for it goes on.
      this.reading.delete(hold);
      this.advance();
    }
  }

  private async settleHold(hold: Hold): Promise<boolean> {
    const { conductor } = this.deps;
    const nothing = () => !hold.spoke && hold.items.length === 0;
    if (nothing()) await this.waitFor(() => !nothing() || this.hold !== hold, HEAR_GRACE_MS);
    if (this.hold !== hold) return false;
    if (nothing()) {
      this.hold = null;
      this.send({ type: 'input_audio_buffer.clear' });
      conductor.traceLine('ignored', { reason: 'no-speech' });
      return false;
    }
    // The provider commits at each pause by itself; this takes what was said since the last.
    hold.committing = true;
    this.awaitingCommit.add(hold);
    this.committedAt = this.now();
    this.send({ type: 'input_audio_buffer.commit' });
    setTimeout(() => this.seal(hold), SEAL_MS);
    // Answered before the transcript exists; once it does, "go to sleep" closes the line.
    const heard = this.heardOf(hold).then((text) => {
      if (isSleepPhrase(text) && this.session) this.goToSleep();
      return text;
    });
    const discard = () => {
      for (const item of hold.items) this.forget(item);
    };
    if (!conductor.lineGuarded) {
      const items = () => hold.items;
      this.heard = items;
      void conductor.speechTurn({
        interactionId: hold.interactionId,
        saidAt: hold.startedAt,
        heard,
        discard: () => {
          if (this.heard === items) this.heard = null;
          discard();
        },
      });
      return true;
    }
    const text = await heard;
    // Read here, so the model must not answer the same words a second time.
    discard();
    if (!text || looksLikeSttArtifact(text)) {
      conductor.traceLine('ignored', { reason: text ? 'noise' : 'unread' });
      return false;
    }
    if (isSleepPhrase(text)) {
      this.goToSleep();
      return true;
    }
    conductor.hearOnLine(text, {
      interactionId: hold.interactionId,
      saidAt: hold.startedAt,
      key: true,
    });
    return true;
  }

  private cancelHold(): void {
    this.touch();
    const hold = this.hold;
    if (!hold) return;
    this.hold = null;
    this.reading.delete(hold);
    this.send({ type: 'input_audio_buffer.clear' });
    runInAction(() => (this.holding = false));
    this.applyMic();
    this.poke();
    this.advance();
  }

  /** No more speech joins this capture: later words are a capture of their own. */
  private seal(hold: Hold): void {
    if (hold.sealed) return;
    hold.sealed = true;
    if (this.hold === hold) this.hold = null;
    this.poke();
    // A response held back for this commit is asked for now.
    if (this.awaitingCommit.delete(hold)) this.advance();
  }

  /**
   * Everything a capture said, once the provider has written all of it. Part of it is not the
   * developer's words: when some never came in time, the capture counts as unread.
   */
  private async heardOf(hold: Hold): Promise<string> {
    const written = () => hold.sealed && hold.items.every((item) => this.transcripts.has(item));
    await this.waitFor(() => written() || this.session === null, TRANSCRIPT_WAIT_MS);
    if (!written() || hold.items.some((item) => this.transcripts.get(item) === null)) return '';
    return joinTranscripts(hold.items.map((item) => this.transcripts.get(item) ?? ''));
  }

  /** Resolves once `done` holds, looked at whenever something arrives, or after `ms`. */
  private waitFor(done: () => boolean, ms: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(check);
    });
  }

  private poke(): void {
    for (const check of [...this.waiters]) check();
  }

  // ── What the conductor asks of the line ─────────────────────────────────────

  /** Runs one turn of the model. Resolves when it has answered, or null if it cannot start. */
  private takeTurn(input: LineTurnInput): Promise<LineTurnResult | null> {
    if (!this.ready || this.turn) return Promise.resolve(null);
    // Whatever is over is a record by the time the model is asked about anything new.
    this.replacePast(true);
    const heard = this.heard;
    this.heard = null;
    const items: string[] = [];
    if (input.text !== undefined) {
      const id = `said_${++this.itemSeq}`;
      const sent = this.send({
        type: 'conversation.item.create',
        item: {
          id,
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: input.text }],
        },
      });
      if (!sent) return Promise.resolve(null);
      items.push(id);
    }
    this.setState(input.context);
    return new Promise<LineTurnResult | null>((resolve) => {
      this.turn = {
        resolve,
        spoken: input.spoken,
        said: [],
        saidBefore: 0,
        leadWords: 0,
        tokens: 0,
        toolsRunning: 0,
        responding: false,
        responseId: null,
        owed: false,
        rounds: 0,
        stopped: false,
        watchdog: null,
        heard,
        items,
        record: null,
        replaced: false,
        retried: false,
      };
      this.respond(this.turn);
    });
  }

  /** Asks the model for the next response of a turn. */
  private respond(turn: Turn): void {
    // One voice at a time: a sentence being said as written is finished first. And words the
    // developer is saying over the turn are read as words (a stop, a yes, a new request of its
    // own): the model is not asked again while they sit in the conversation.
    if (
      this.saying ||
      this.reading.size > 0 ||
      this.loose.size > 0 ||
      this.awaitingCommit.size > 0
    ) {
      turn.owed = true;
      return;
    }
    turn.owed = false;
    const aloud = turn.spoken && !this.deps.voice.muted;
    // Aloud is the provider's default: the voice with its transcript.
    const sent = this.send(
      aloud
        ? { type: 'response.create' }
        : { type: 'response.create', response: { modalities: ['text'] } }
    );
    if (!sent) {
      this.endTurn(turn, { reply: DROPPED_REPLY, completed: false });
      return;
    }
    turn.responding = true;
    turn.responseId = null;
    turn.saidBefore = turn.said.length;
    turn.rounds++;
    turn.watchdog = setTimeout(() => {
      turn.watchdog = null;
      if (this.turn !== turn || !turn.responding) return;
      this.send({ type: 'response.cancel' });
      this.endTurn(turn, { reply: NO_ANSWER_REPLY, completed: false });
    }, RESPONSE_MAX_MS);
  }

  /** Goes back to the model once every tool of its last response has answered. */
  private advance(): void {
    const turn = this.turn;
    if (!turn || turn.responding || turn.toolsRunning > 0 || !turn.owed) return;
    if (turn.stopped) this.endTurn(turn, { reply: '', completed: false });
    else if (turn.rounds >= MAX_ROUNDS) {
      this.endTurn(turn, { reply: TOO_MANY_STEPS_REPLY, completed: false });
    } else this.respond(turn);
  }

  private endTurn(turn: Turn, result: { reply: string; completed: boolean }): void {
    if (this.turn !== turn) return;
    this.turn = null;
    this.touch();
    if (turn.watchdog) clearTimeout(turn.watchdog);
    // It stays in the conversation as it happened until the conductor says its exchange is over.
    if (this.session) {
      turn.items.unshift(...(turn.heard?.() ?? []));
      this.past.push(turn);
    }
    turn.resolve({
      ...result,
      tokens: turn.tokens,
      rounds: turn.rounds,
      leadWords: turn.leadWords,
    });
    this.maybeRollOver();
  }

  /** The conductor says what the turn that just ended came to, and whether that closes it. */
  private record(text: string, over: boolean): void {
    const turn = this.past.at(-1);
    if (!turn || turn.record !== null) return;
    turn.record = text;
    this.recent = [...this.recent, text].slice(-CARRIED_RECORDS);
    if (over) this.closed = this.past.length;
    this.replacePast(false);
  }

  /**
   * Replaces every turn of a finished exchange by its record. What the developer asked for and
   * got is then in the conversation as something that happened, and only the exchange still
   * open is there as it was said. It waits for the voice to finish, so an answer is never taken
   * away while it is being said, unless `now`: the model is about to be asked again.
   */
  private replacePast(now: boolean): void {
    if (this.closed === 0 || (this.speaking && !now)) return;
    const turns = this.past.splice(0, this.closed);
    this.closed = 0;
    for (const turn of turns) {
      // A turn nobody described stays as it is: without a record nothing would be left of it.
      if (turn.record === null || !this.sendNote(turn.record)) continue;
      turn.replaced = true;
      for (const item of turn.items) this.forget(item);
    }
  }

  /** The developer said stop: the turn ends where it is, and the voice goes quiet. */
  private stop(): void {
    const turn = this.turn;
    if (turn) turn.stopped = true;
    if (turn?.responding) this.send({ type: 'response.cancel' });
    this.stopVoice();
    // A response in flight ends the turn when it reports back; so do tools still running.
    if (turn && !turn.responding && turn.toolsRunning === 0) {
      this.endTurn(turn, { reply: '', completed: false });
    }
  }

  /** Says one sentence as written; resolves once it has been said, or false if it was not. */
  private say(text: string): Promise<boolean> {
    const { voice } = this.deps;
    // While the developer holds the key, nothing of Maestro's may play into what they say; and
    // a sentence never talks over the model's own answer.
    if (!this.ready || this.saying || this.turn?.responding || voice.muted || voice.capturing) {
      return Promise.resolve(false);
    }
    // Grok's force message: the provider says the text itself, word for word, and the model is
    // never asked. The sentence may quote an agent, and saying it can never turn into doing
    // something. It stays in the conversation as something the voice said.
    const sent = this.send({
      type: 'conversation.item.create',
      item: {
        type: 'force_message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    });
    if (!sent) return Promise.resolve(false);
    this.noteSpoken(text);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Nothing was heard in time: stop it, and let the caller say it another way.
        if (this.saying && !this.saying.started) {
          this.cancelSaying();
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

  private cancelSaying(): void {
    const id = this.saying?.responseId;
    this.send({ type: 'response.cancel', ...(id ? { response_id: id } : {}) });
  }

  private finishSaying(said: boolean): void {
    const saying = this.saying;
    if (!saying) return;
    this.saying = null;
    clearTimeout(saying.timer);
    clearTimeout(saying.maxTimer);
    saying.resolve(said);
    // A turn that waited for the sentence goes on.
    this.advance();
  }

  /** Tells the voice model something, without making it speak. */
  private note(text: string): void {
    if (this.line === 'open') this.sendNote(text);
  }

  private sendNote(text: string): boolean {
    return this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  /** Replaces what the model was told about the agents and the canvas with how things are now. */
  private setState(context: string): void {
    const previous = this.stateItem;
    const id = `state_${++this.stateSeq}`;
    const sent = this.send({
      type: 'conversation.item.create',
      item: {
        id,
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: feedSnapshot(context, new Date(this.now())) }],
      },
    });
    if (!sent) return;
    this.stateItem = id;
    if (previous) this.forget(previous);
  }

  private send(event: RealtimeEvent): boolean {
    const sent = this.session?.send(event) ?? false;
    if (sent && isTextInput(event)) this.textInputs++;
    return sent;
  }

  // ── What the provider tells the line ────────────────────────────────────────

  private onEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.touch();
        this.hearing = true;
        this.speechAt = this.now();
        if (this.hold) this.hold.spoke = true;
        this.poke();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.hearing = false;
        // The session commits each stretch of speech as it stops.
        this.committedAt = this.now();
        break;
      case 'input_audio_buffer.committed':
        this.onCommitted(str(event.item_id));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.onTranscript(str(event.item_id), str(event.transcript));
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.onTranscript(str(event.item_id), null);
        break;
      case 'response.output_audio_transcript.done':
        this.onSaid(str(event.transcript));
        break;
      case 'response.output_text.done':
        this.onWritten(str(event.text));
        break;
      case 'response.function_call_arguments.done':
        this.claimResponse(str(event.response_id));
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
        this.onError(event.error);
        break;
      default:
        break;
    }
  }

  private onError(error: unknown): void {
    // Letting go right after a pause leaves nothing to commit: the capture is complete as it is.
    if (str((error as { code?: unknown } | null)?.code) === 'input_audio_buffer_commit_empty') {
      if (this.hold?.committing) this.seal(this.hold);
      return;
    }
    // A delete of an item xAI no longer has: nothing was asked for, so nothing is given up on.
    if (str((error as { message?: unknown } | null)?.message).startsWith('Item not found')) {
      log.debug('talk: an item to delete was already gone', { error });
      return;
    }
    log.warn('talk: the provider reported an error', { error });
    if (str((error as { code?: unknown } | null)?.code) === 'timeout') {
      this.sleep();
      return;
    }
    // Whatever was asked for may never come: a sentence that has not started is not said, and
    // a summary that was refused must not keep the line shut.
    if (this.saying && !this.saying.started) this.finishSaying(false);
    this.endRollover();
  }

  /** The provider turned a stretch of speech into an item of the conversation. */
  private onCommitted(itemId: string): void {
    if (!itemId) return;
    const hold = this.hold;
    if (hold) {
      hold.items.push(itemId);
      // The commit asked for when the developer let go: these were their last words.
      if (hold.committing) this.seal(hold);
      else this.poke();
      return;
    }
    this.loose.set(itemId, this.speechAt || this.now());
  }

  private onTranscript(itemId: string, transcript: string | null): void {
    if (!itemId) return;
    const saidAt = this.loose.get(itemId);
    if (saidAt === undefined) {
      this.transcripts.set(itemId, transcript);
      this.poke();
      return;
    }
    this.loose.delete(itemId);
    this.onHeard(itemId, transcript ?? '', saidAt);
    this.advance();
  }

  /**
   * The transcript of words heard with no key held. They are read before anything answers: an
   * echo of Maestro's own voice or noise is dropped, and the rest is the developer's turn.
   */
  private onHeard(itemId: string, transcript: string, saidAt: number): void {
    const { conductor, voice } = this.deps;
    const heard = transcript.trim();
    this.spoken = recentSpoken(this.spoken, this.now());
    const echo = !neverEcho(heard) && isEcho(heard, this.spoken, this.now());
    if (!heard || looksLikeSttArtifact(heard) || echo) {
      // Noise does not keep the microphone open: the window runs out as it would have.
      this.forget(itemId);
      conductor.traceLine('ignored', { reason: heard ? 'echo-or-noise' : 'empty' });
      return;
    }
    // The developer took the key meanwhile: what they say with it is what counts now.
    if (voice.capturing) {
      this.forget(itemId);
      return;
    }
    const fresh = this.freshWords(heard);
    if (!fresh) {
      this.forget(itemId);
      conductor.traceLine('ignored', { reason: 'repeat' });
      return;
    }
    if (isSleepPhrase(fresh)) {
      this.goToSleep();
      return;
    }
    // Words that repeat what was heard first go on as text: the model would hear the repeat in
    // the audio.
    const trimmed = fresh !== heard;
    if (trimmed) conductor.traceLine('trimmed-repeat', { dropped: heard.length - fresh.length });
    this.windowSince = this.now();
    const interactionId = crypto.randomUUID();
    conductor.traceLine('heard', { guarded: conductor.lineGuarded });
    if (conductor.lineGuarded || trimmed) {
      this.forget(itemId);
      conductor.hearOnLine(fresh, { interactionId, saidAt, key: false });
      return;
    }
    const items = () => [itemId];
    this.heard = items;
    void conductor.speechTurn({
      interactionId,
      saidAt,
      heard: Promise.resolve(heard),
      discard: () => {
        if (this.heard === items) this.heard = null;
        this.forget(itemId);
      },
    });
  }

  /**
   * What open-microphone words add to those heard just before: all of them, none when they were
   * all heard already, or only the words after what was heard when they repeat it first.
   */
  private freshWords(heard: string): string {
    const now = this.now();
    const recent = this.looseHeard.filter((entry) => now - entry.at <= REPEAT_MS);
    let fresh = heard;
    const said = comparable(heard);
    for (const entry of recent) {
      const before = comparable(entry.text);
      if (before.split(' ').length < REPEAT_MIN_WORDS) continue;
      if (before.includes(said)) {
        fresh = '';
        break;
      }
      if (said.startsWith(`${before} `)) fresh = wordsAfter(heard, before);
    }
    // The longest version stands for everything heard so far.
    const kept = recent.filter((entry) => !said.startsWith(comparable(entry.text)));
    this.looseHeard = fresh ? [...kept, { text: heard, at: now }] : recent;
    return fresh;
  }

  /** Removes an item the model must not see, or see twice. */
  private forget(itemId: string): void {
    this.transcripts.delete(itemId);
    if (itemId) this.send({ type: 'conversation.item.delete', item_id: itemId });
  }

  private onSaid(transcript: string): void {
    const said = transcript.trim();
    if (!said) return;
    this.noteSpoken(said);
    // A sentence said as written was shown by whoever asked for it.
    if (this.saying) return;
    this.onWritten(said);
  }

  /** A part of the model's own answer, said or written. */
  private onWritten(text: string): void {
    const part = text.trim();
    const turn = this.turn;
    if (part && !turn && this.rolling) this.rollText = `${this.rollText} ${part}`.trim();
    if (!part || !turn) return;
    turn.said.push(part);
    this.deps.conductor.showVoiceReply(turn.said.join(' '));
  }

  private noteSpoken(said: string): void {
    this.spoken = [...recentSpoken(this.spoken, this.now()), { text: said, at: this.now() }];
  }

  /**
   * A tool call while a turn waits on a response: its response is the turn's, whatever id the
   * turn took from `response.created`. Otherwise its done is ignored, the result is never
   * answered, and the turn waits out the watchdog.
   */
  private claimResponse(responseId: string): void {
    const turn = this.turn;
    if (!turn?.responding || !responseId || turn.responseId === responseId) return;
    if (turn.responseId) {
      this.deps.conductor.traceLine('response-reclaimed', {
        from: turn.responseId,
        to: responseId,
      });
    }
    turn.responseId = responseId;
  }

  private async onToolCall(callId: string, name: string, rawArguments: string): Promise<void> {
    if (!callId || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    const session = this.session;
    const turn = this.turn;
    let result: LineToolResult;
    if (!turn) {
      // A call that belongs to no request of the developer's: answered, so the conversation
      // stays whole, and never run.
      result = { output: NO_TURN_RESULT };
      this.deps.conductor.traceLine('refused-call', { tool: name, reason: 'no-turn' });
    } else if (turn.stopped) {
      result = { output: STOPPED_RESULT };
    } else {
      turn.toolsRunning++;
      try {
        result = await this.deps.conductor.lineTool(name, parseArguments(rawArguments));
      } catch (error) {
        result = { output: error instanceof Error ? error.message : 'That could not be done.' };
      }
      turn.toolsRunning = Math.max(0, turn.toolsRunning - 1);
    }
    // The session was replaced while the tool ran: its answer belongs to nobody. So does the
    // answer to a call whose turn is already a record.
    if (this.session !== session || turn?.replaced) return;
    const outputId = `out_${++this.itemSeq}`;
    this.send({
      type: 'conversation.item.create',
      item: {
        id: outputId,
        type: 'function_call_output',
        call_id: callId,
        output: withoutImages(result),
      },
    });
    turn?.items.push(outputId);
    if (!turn || this.turn !== turn) return;
    turn.owed = true;
    this.advance();
  }

  private onResponseCreated(response: unknown): void {
    const created = (response ?? {}) as { id?: unknown; metadata?: { purpose?: unknown } | null };
    if (typeof created.id !== 'string') return;
    const purpose = created.metadata?.purpose;
    if (purpose !== undefined && purpose !== null) return;
    // A force message carries no metadata. While a sentence waits to be said no turn asks for a
    // response, so one that starts now is the sentence.
    if (this.saying && !this.saying.responseId && !this.turn?.responding) {
      this.saying.responseId = created.id;
      this.sayResponses.add(created.id);
    } else if (this.turn?.responding && !this.turn.responseId) {
      this.turn.responseId = created.id;
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
    // The developer is speaking: nothing of Maestro's plays into it. The turn itself goes on.
    if (this.deps.voice.capturing || this.deps.voice.muted) {
      this.hush();
      return;
    }
    this.unhush();
    // Without talk-over the microphone is shut while the voice speaks, so it never hears itself.
    // With it, the microphone opens as the voice starts, so speaking over it can stop it.
    if (!this.settings?.talkOver) this.closeWindow();
    else this.openWindow();
  }

  private onVoiceStopped(responseId: string): void {
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    this.touch();
    runInAction(() => (this.speaking = false));
    this.replacePast(false);
    // Another response stopping says nothing about the sentence that was asked for.
    if (this.saying?.started && this.isSaying(responseId)) this.finishSaying(true);
    if (!this.deps.voice.capturing && !this.deps.voice.muted) this.unhush();
    this.openWindowSoon();
    this.maybeRollOver();
  }

  private onResponseDone(response: unknown): void {
    const done = (response ?? {}) as {
      id?: unknown;
      status?: unknown;
      status_details?: unknown;
      usage?: unknown;
      metadata?: { purpose?: unknown } | null;
      output?: unknown;
    };
    const id = str(done.id);
    const purpose = this.sayResponses.delete(id) ? 'say' : done.metadata?.purpose;
    const tokens = tokensFromUsage(done.usage);
    void this.recordUsage(tokens);
    if (done.status !== 'completed') this.noteIncomplete(done.status, done.status_details);
    if (purpose === 'say') {
      if (done.status !== 'completed') this.finishSaying(false);
      return;
    }
    if (purpose === 'rollover') {
      // A summary that comes after the line gave up waiting belongs to nothing: the session
      // has been taking turns again.
      if (!this.rolling) return;
      const summary = responseText(done.output) || this.rollText;
      if (done.status === 'completed') void this.replace(summary);
      else this.endRollover();
      return;
    }
    // Only a response in the conversation says how full the session is.
    this.inputTokens = inputSize(tokens);
    const turn = this.turn;
    if (!turn) return;
    // A response an earlier turn gave up on says nothing about this one.
    if (turn.responseId && id && id !== turn.responseId) {
      this.deps.conductor.traceLine('stray-response', {
        response: id,
        expected: turn.responseId,
        status: str(done.status),
      });
      return;
    }
    // xAI cancelled the response the moment it was asked for, before the model said or did
    // anything: it is asked once more, a moment later. Asking again has answered every time.
    if (!turn.retried && !turn.stopped && cancelledAtOnce(done)) {
      turn.retried = true;
      if (turn.watchdog) clearTimeout(turn.watchdog);
      turn.watchdog = null;
      turn.responding = false;
      this.deps.conductor.traceLine('retried', { afterMs: RETRY_CANCELLED_MS });
      setTimeout(() => {
        if (this.turn !== turn || turn.stopped || turn.responding) return;
        this.respond(turn);
      }, RETRY_CANCELLED_MS);
      return;
    }
    turn.items.push(...itemIds(done.output));
    if (callsTools(done.output)) {
      turn.leadWords += wordCount(turn.said.slice(turn.saidBefore).join(' '));
    }
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = null;
    turn.responding = false;
    turn.tokens += inputSize(tokens) + tokens.textOut + tokens.audioOut;
    // A response that called tools is answered in a later one, once their results are in.
    if (turn.toolsRunning > 0 || turn.owed) {
      this.advance();
      return;
    }
    // Nothing is running and nothing is owed: the turn is over, whatever the response lists
    // (a call cut off by "stop" is listed, and never arrives).
    this.endTurn(turn, {
      reply: turn.said.join(' '),
      completed: done.status === 'completed' && !callsTools(done.output),
    });
  }

  /**
   * Says why a response ended without completing, as the provider put it: in the log in full,
   * and in the trace as its status and reason, so a turn cut off at once can be told apart from
   * one the developer stopped.
   */
  private noteIncomplete(status: unknown, details: unknown): void {
    const detail = (details ?? {}) as { type?: unknown; reason?: unknown; error?: unknown };
    const error = (detail.error ?? {}) as { code?: unknown; message?: unknown };
    log.warn('talk: a response did not complete', { status, details });
    this.deps.conductor.traceLine('incomplete', {
      response: str(status) || 'unknown',
      // How long after the last commit it was asked for, and whether one was still unconfirmed.
      ...(this.committedAt > 0 ? { sinceCommitMs: this.now() - this.committedAt } : {}),
      awaitingCommit: this.awaitingCommit.size > 0,
      ...(typeof details === 'string' && details ? { reason: details } : {}),
      ...(str(detail.type) ? { type: str(detail.type) } : {}),
      ...(str(detail.reason) ? { reason: str(detail.reason) } : {}),
      ...(str(error.code) ? { code: str(error.code) } : {}),
      ...(str(error.message) ? { message: str(error.message).slice(0, 200) } : {}),
    });
  }

  /** Reports what the line used since it last did: tokens, and the time and text it is billed. */
  private async recordUsage(tokens: TalkTokens): Promise<void> {
    const model = this.settings ? talkLineModel(this.settings) : '';
    if (!model) return;
    const now = this.now();
    const seconds = this.billedSince > 0 ? Math.max(0, (now - this.billedSince) / 1000) : 0;
    if (this.billedSince > 0) this.billedSince = now;
    const textInputs = this.textInputs;
    this.textInputs = 0;
    try {
      const status = await (
        await this.deps.client()
      ).recordUsage({
        model,
        tokens,
        seconds,
        textInputs,
      });
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

  // ── The microphone ──────────────────────────────────────────────────────────

  /** The track carries sound while the developer holds the key or the microphone is open. */
  private applyMic(): void {
    if (this.track) this.track.enabled = this.holding || this.micOpen;
  }

  /**
   * Opens the microphone with no key held: for good when the line listens all the time, else
   * for a moment after Maestro speaks. It stays shut while a local capture or a local voice has
   * the room, and while the line's own voice speaks unless talking over it is allowed.
   */
  private openWindow(): void {
    const settings = this.settings;
    if (this.line !== 'open' || !this.track || !settings || this.rolling) return;
    const always = settings.listening === 'open';
    if (!always && settings.windowSec <= 0) return;
    const { voice } = this.deps;
    if (voice.capturing || voice.speaking) return;
    if (this.speaking && !settings.talkOver) return;
    if (!this.micOpen) this.windowSince = this.now();
    runInAction(() => (this.micOpen = true));
    this.applyMic();
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (!always) this.armWindow(settings.windowSec * 1000);
  }

  /** Opens the microphone once the room has had a moment to go quiet after a voice. */
  private openWindowSoon(): void {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      this.openWindow();
    }, ECHO_TAIL_MS);
  }

  /** The room is the developer's again: the microphone opens if the line listens without a key. */
  private reopen(): void {
    if (this.settings?.listening === 'open' || this.deps.conductor.callOnLine) {
      this.openWindowSoon();
    }
  }

  private armWindow(ms: number): void {
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
    if (this.micOpen) runInAction(() => (this.micOpen = false));
    this.applyMic();
    if (!this.holding) this.hearing = false;
    this.maybeRollOver();
  }

  /** Stops the voice mid-sentence. */
  private stopVoice(): void {
    if (this.saying) {
      this.cancelSaying();
      this.finishSaying(false);
    }
    if (this.speaking) this.send({ type: 'output_audio_buffer.clear' });
  }

  /**
   * The developer is speaking, or muted Maestro: its voice is cut off and not played. A turn
   * in progress keeps working; only what it says aloud is dropped, and its answer is shown.
   */
  private hush(): void {
    this.stopVoice();
    if (this.hushed) return;
    this.hushed = true;
    if (this.remote) this.deps.play(this.remote, true);
  }

  private unhush(): void {
    if (!this.hushed) return;
    this.hushed = false;
    if (this.remote) this.deps.play(this.remote, false);
  }

  // ── A long session is replaced ──────────────────────────────────────────────

  /** A long or full session is replaced by a fresh one, at a moment nobody is talking. */
  private maybeRollOver(): void {
    if (this.rolling || this.line !== 'open') return;
    if (this.turn || this.hold || this.holding || this.hearing || this.speaking) return;
    if (this.saying || this.loose.size > 0 || this.deps.voice.capturing) return;
    if (!needsRollover(this.inputTokens, this.now() - this.openedAt)) return;
    this.rolling = true;
    this.rollText = '';
    // Grok has no response outside the conversation: the summary is the session's last answer,
    // and the session is replaced right after it.
    const asked = this.send({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: ROLLOVER_INSTRUCTIONS,
        metadata: { purpose: 'rollover' },
      },
    });
    if (!asked) {
      this.rolling = false;
      return;
    }
    // A session about to be replaced takes no more words.
    this.closeWindow();
    // The line takes no turn while it waits for the summary; it must not wait for ever.
    this.rollTimer = setTimeout(() => {
      this.rollTimer = null;
      this.rolling = false;
      this.reopen();
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

/**
 * The transcripts of one capture's items as one text. xAI may write each stretch's transcript
 * as everything said so far, so a transcript that starts with what came before replaces it,
 * and one already contained in it adds nothing.
 */
export function joinTranscripts(parts: readonly string[]): string {
  let text = '';
  for (const part of parts) {
    const next = part.replace(/\s+/g, ' ').trim();
    if (!next) continue;
    const said = comparable(text);
    const adds = comparable(next);
    if (said && adds.startsWith(said)) text = next;
    else if (!said.includes(adds)) text = text ? `${text} ${next}` : next;
  }
  return text;
}

/** "Go to sleep", alone or with a word around it ("okay, go to sleep now"), and nothing else. */
const SLEEP_PHRASE =
  /^(?:(?:ok|okay|alright|all right|hey|maestro|chorus|please|now)\s+)*go to sleep(?:\s+(?:now|please|maestro|chorus))*$/;

/** True when what was said is the developer telling the line to go to sleep. */
export function isSleepPhrase(text: string): boolean {
  return SLEEP_PHRASE.test(comparable(text));
}

/** The words of `text` after those that, compared, make up `prefix`. */
function wordsAfter(text: string, prefix: string): string {
  const words = text.trim().split(/\s+/);
  for (let count = 1; count <= words.length; count++) {
    if (comparable(words.slice(0, count).join(' ')) === prefix) {
      return words.slice(count).join(' ');
    }
  }
  return text;
}

/** A transcript as compared: case, punctuation and spacing aside. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** True for an event that puts text into the conversation, which xAI bills per input. */
function isTextInput(event: RealtimeEvent): boolean {
  if (event.type !== 'conversation.item.create') return false;
  const type = (event.item as { type?: unknown } | undefined)?.type;
  return type === 'message' || type === 'force_message' || type === 'function_call_output';
}

/** A tool's result as text. Grok Voice takes no images, so it is told what it cannot see. */
function withoutImages(result: LineToolResult): string {
  const count = result.images?.length ?? 0;
  if (count === 0) return result.output;
  const images = count === 1 ? 'An image' : `${count} images`;
  return `${result.output}\n\n[${images} left out: the voice model cannot see images.]`;
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

/** The ids of the items a response added to the conversation: its calls and what it said. */
function itemIds(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  return (output as { id?: unknown }[]).flatMap((item) =>
    typeof item?.id === 'string' && item.id ? [item.id] : []
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

/** xAI ended a response as soon as it was asked for, as `unimplemented`, before any output. */
function cancelledAtOnce(done: { status?: unknown; status_details?: unknown }): boolean {
  if (done.status !== 'cancelled') return false;
  const details = done.status_details as { reason?: unknown } | string | null | undefined;
  const reason = typeof details === 'string' ? details : str(details?.reason);
  return reason === 'unimplemented';
}
