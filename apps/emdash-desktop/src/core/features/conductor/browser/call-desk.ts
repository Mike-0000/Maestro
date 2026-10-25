import { makeAutoObservable } from 'mobx';
import {
  announcementDeadlineMs,
  announcementExpired,
  LATER_MS,
  nextCall,
  overSpokenLimit,
  queueAnnouncement,
  type Announcement,
  type Call,
  type CallMode,
} from '../api/calls';

/** What the call desk needs from the conductor (kept structural so it tests without one). */
export interface CallHost {
  mode(): CallMode;
  /** How long a call stays on the line after it was delivered, in ms. */
  windowMs(): number;
  /** True when nothing else has the developer's ear: no turn, pending action, or open mic. */
  free(): boolean;
  /** Shows the call's sentence. Called once, when the call is delivered. */
  show(call: Call): void;
  /** Says the call's sentence; resolves when it stopped playing, however it stopped. */
  speak(call: Call): Promise<unknown>;
  /** Marks the caller's window, or clears the mark with null. Never changes focus. */
  highlight(conversationId: string | null): void;
  /** A short sound for a call that is shown and not spoken. */
  tone(): void;
  trace(call: Call, status: string, detail?: Record<string, string | number | boolean>): void;
  /**
   * True when news may be told now: nobody is speaking or about to be answered, and nothing
   * waits for the developer's answer. Unlike `free`, the conductor may be busy with a turn
   * nobody is waiting for.
   */
  freeToAnnounce(): boolean;
  /** Shows and says an announcement (`text` is what to say now); resolves when it is over. */
  announce(announcement: Announcement, text: string): Promise<unknown>;
  /** How long the voice may wait for its first audio, which the announcement's deadline adds. */
  firstAudioWaitMs(): number;
  traceAnnouncement(
    announcement: Announcement,
    status: string,
    detail?: Record<string, string | number | boolean>
  ): void;
}

export type CallState =
  /** Maestro is saying it. */
  | 'delivering'
  /** Delivered; it can still be picked up. */
  | 'on-line'
  /** The developer picked it up: their next words are for this caller. */
  | 'picked-up';

export type CurrentCall = {
  readonly call: Call;
  readonly state: CallState;
  /** When an on-line call lapses, as a clock time; null in the other states. */
  readonly until: number | null;
  readonly spoken: boolean;
};

/**
 * Delivers calls one at a time. A call is spoken (or only shown), then stays on the line for a
 * few seconds; the developer picks it up by starting to speak with a key or a click, and the
 * conductor releases it when that exchange is over. Nothing here moves focus or sends anything:
 * the desk only decides who is on the line.
 */
export class CallDesk {
  current: CurrentCall | null = null;
  waiting: Call[] = [];
  /** "Hold my calls": nothing is delivered until the developer takes them again. */
  held = false;
  /** The agent whose calls go first ("stay with Atlas"). */
  stayWith: string | null = null;
  /** News waiting for the developer to be free, oldest first. Calls off or on, it waits here. */
  announcements: Announcement[] = [];
  /** The announcement being shown and said. */
  private announcing: Announcement | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Wakes the desk when a call that was set aside is due. */
  private wake: ReturnType<typeof setTimeout> | null = null;
  private readonly spokenAt = new Map<string, number[]>();
  private disposed = false;

  constructor(
    private readonly host: CallHost,
    private readonly now: () => number = () => Date.now()
  ) {
    makeAutoObservable<
      CallDesk,
      'host' | 'now' | 'timer' | 'wake' | 'spokenAt' | 'disposed' | 'announcing'
    >(this, {
      host: false,
      now: false,
      timer: false,
      wake: false,
      spokenAt: false,
      disposed: false,
      announcing: false,
    });
  }

  /** True while a call can be picked up. */
  get canPickUp(): boolean {
    return this.current !== null && this.current.state !== 'picked-up';
  }

  /** The call the developer picked up and has not finished with. */
  get pickedUp(): Call | null {
    return this.current?.state === 'picked-up' ? this.current.call : null;
  }

  /** Adds a call. A newer call about the same thing from the same agent replaces the older. */
  offer(call: Call): void {
    if (this.disposed || this.host.mode() === 'off') return;
    this.waiting = [
      ...this.waiting.filter(
        (other) =>
          !(
            other.conversationId === call.conversationId &&
            other.kind === call.kind &&
            other.requestId === call.requestId
          )
      ),
      call,
    ];
    this.host.trace(call, 'offered', { waiting: this.waiting.length });
    this.pump();
  }

  /**
   * Queues news to be told once the developer is free (see `queueAnnouncement` for what it
   * replaces), and tells it at once when they are.
   */
  announce(announcement: Announcement): void {
    if (this.disposed) return;
    const { waiting, dropped } = queueAnnouncement(this.announcements, announcement, this.now());
    for (const { announcement: old, reason } of dropped) {
      this.host.traceAnnouncement(old, 'dropped', { reason });
    }
    this.announcements = waiting;
    if (waiting.includes(announcement)) {
      this.host.traceAnnouncement(announcement, 'queued', { waiting: waiting.length });
    }
    this.pump();
  }

  /** The developer said stop: nothing that is waiting is told. */
  clearAnnouncements(): void {
    for (const announcement of this.announcements) {
      this.host.traceAnnouncement(announcement, 'dropped', { reason: 'stopped' });
    }
    this.announcements = [];
  }

  /** Tells the waiting news, and only that, when the developer is free for it. */
  pumpAnnouncements(): void {
    if (this.disposed || this.current || this.announcing) return;
    if (this.tellable() && this.host.freeToAnnounce()) void this.tellNext();
  }

  /** Delivers the next call when the developer is free. Safe to call at any time. */
  pump(): void {
    if (this.disposed || this.current || this.announcing) return;
    // News waits behind a call on the line, and goes before the next one.
    if (this.tellable() && this.host.freeToAnnounce()) {
      void this.tellNext();
      return;
    }
    if (this.held || this.waiting.length === 0) return;
    if (this.host.mode() === 'off' || !this.host.free()) return;
    const call = nextCall(this.waiting, this.stayWith, this.now());
    if (!call) {
      // Everything waiting was set aside: come back when the first of it is due.
      this.wakeForSetAside();
      return;
    }
    this.waiting = this.waiting.filter((other) => other.id !== call.id);
    void this.deliver(call);
  }

  /**
   * Whether an announcement may be told now. "Hold my calls" holds news as well, except that
   * something failed: the developer would otherwise believe it worked.
   */
  private mayTell(announcement: Announcement): boolean {
    return !this.held || announcement.source === 'failure';
  }

  private tellable(): boolean {
    return this.announcements.some((announcement) => this.mayTell(announcement));
  }

  /** Tells the oldest announcement that still holds, then whatever is next. */
  private async tellNext(): Promise<void> {
    let next: { announcement: Announcement; text: string } | null = null;
    while (!next) {
      const announcement = this.announcements.find((waiting) => this.mayTell(waiting));
      if (!announcement) break;
      this.announcements = this.announcements.filter((waiting) => waiting !== announcement);
      if (announcementExpired(announcement, this.now())) {
        this.host.traceAnnouncement(announcement, 'dropped', { reason: 'expired' });
        continue;
      }
      const text = announcement.current ? announcement.current() : announcement.text;
      if (!text) {
        this.host.traceAnnouncement(announcement, 'dropped', { reason: 'stale' });
        continue;
      }
      next = { announcement, text };
    }
    if (!next) return;
    const { announcement, text } = next;
    this.announcing = announcement;
    this.host.traceAnnouncement(announcement, 'told', {
      waitedMs: Math.max(0, this.now() - announcement.at),
      ...(text !== announcement.text ? { changed: true } : {}),
    });
    // Speech whose end never comes must not hold every announcement after it.
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'timeout'>((resolve) => {
      watchdog = setTimeout(
        () => resolve('timeout'),
        announcementDeadlineMs(text, this.host.firstAudioWaitMs())
      );
    });
    try {
      const ended = await Promise.race([this.host.announce(announcement, text), deadline]);
      if (ended === 'timeout') this.host.traceAnnouncement(announcement, 'timeout');
    } catch {
      // However it ended, it was told; what is next must not wait on it.
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    if (this.announcing !== announcement) return;
    this.announcing = null;
    this.pump();
  }

  private async deliver(call: Call): Promise<void> {
    const speak = this.host.mode() === 'spoken' && !this.overLimit(call);
    this.current = { call, state: 'delivering', until: null, spoken: speak };
    this.host.highlight(call.conversationId);
    this.host.show(call);
    if (speak) {
      this.noteSpoken(call);
      this.host.trace(call, 'spoken');
      await this.host.speak(call).catch(() => undefined);
    } else {
      this.host.trace(call, 'shown');
      this.host.tone();
    }
    // Picked up, skipped, or released while it was being said.
    if (this.current?.call.id !== call.id || this.current.state !== 'delivering') return;
    this.goOnLine(call, speak);
  }

  private goOnLine(call: Call, spoken: boolean): void {
    this.clearTimer();
    const windowMs = this.host.windowMs();
    this.current = { call, state: 'on-line', until: this.now() + windowMs, spoken };
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.current?.call.id !== call.id || this.current.state !== 'on-line') return;
      this.host.trace(call, 'lapsed');
      this.end();
    }, windowMs);
  }

  /**
   * The developer started to answer. Returns the caller their words are bound to, or null when
   * no call is on the line.
   */
  pickUp(): Call | null {
    const current = this.current;
    if (!current || current.state === 'picked-up') return null;
    this.clearTimer();
    this.current = { ...current, state: 'picked-up', until: null };
    this.host.trace(current.call, 'picked-up', { during: current.state });
    return current.call;
  }

  /**
   * The exchange that picked the call up is over. Nothing happens when the call is no longer
   * the one picked up: it was skipped or set aside in that exchange.
   */
  release(callId: string): void {
    const current = this.current;
    if (!current || current.call.id !== callId || current.state !== 'picked-up') return;
    this.host.trace(current.call, 'done');
    this.end();
  }

  /**
   * What the developer said after picking the call up was not for it (they said nothing, or
   * their words went elsewhere): the call goes back on the line.
   */
  putBack(callId: string): void {
    const current = this.current;
    if (!current || current.call.id !== callId || current.state !== 'picked-up') return;
    this.host.trace(current.call, 'put-back');
    this.goOnLine(current.call, current.spoken);
  }

  /** Drops the call on the line and moves on. */
  skip(): Call | null {
    const current = this.current;
    if (!current) return null;
    this.host.trace(current.call, 'skipped');
    this.end();
    return current.call;
  }

  /**
   * Sets the call on the line aside: it comes back after everything else that is waiting, and
   * not for a while, unless the developer asks for it ("next call", "take my calls").
   */
  later(): Call | null {
    const current = this.current;
    if (!current) return null;
    this.host.trace(current.call, 'deferred');
    const now = this.now();
    const lowest = Math.min(current.call.urgency, ...this.waiting.map((call) => call.urgency));
    this.waiting = [
      ...this.waiting,
      {
        ...current.call,
        urgency: Math.max(0, lowest - 0.01),
        at: now,
        notBefore: now + LATER_MS,
      },
    ];
    this.end();
    return current.call;
  }

  hold(on: boolean): void {
    this.held = on;
    if (on) return;
    // "Take my calls" asks for all of them, the ones set aside included.
    this.recall();
    this.pump();
  }

  /**
   * "Next call": delivers what is waiting now, including a call that was set aside. True when
   * something is being delivered: a call, or news that goes before it.
   */
  next(): boolean {
    if (this.current) this.skip();
    this.recall();
    const before = this.waiting.length;
    this.pump();
    return this.current !== null || this.announcing !== null || this.waiting.length < before;
  }

  stay(conversationId: string | null): void {
    this.stayWith = conversationId;
    this.pump();
  }

  /** Forgets everything an agent has waiting (its window was closed or it left the canvas). */
  forget(conversationId: string): void {
    this.waiting = this.waiting.filter((call) => call.conversationId !== conversationId);
    if (this.stayWith === conversationId) this.stayWith = null;
    if (this.current?.call.conversationId === conversationId) this.end();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    this.current = null;
    this.waiting = [];
    this.announcements = [];
    this.announcing = null;
  }

  /** Ends the current call and delivers the next. */
  private end(): void {
    this.clearTimer();
    this.current = null;
    this.host.highlight(null);
    this.pump();
  }

  /** Calls that were set aside may be delivered now. */
  private recall(): void {
    if (this.waiting.some((call) => call.notBefore !== undefined)) {
      this.waiting = this.waiting.map(({ notBefore: _notBefore, ...call }) => call);
    }
  }

  private wakeForSetAside(): void {
    if (this.wake) clearTimeout(this.wake);
    const due = Math.min(...this.waiting.map((call) => call.notBefore ?? 0));
    this.wake = setTimeout(
      () => {
        this.wake = null;
        this.pump();
      },
      Math.max(0, due - this.now()) + 1
    );
  }

  private overLimit(call: Call): boolean {
    return overSpokenLimit(this.spokenAt.get(call.conversationId) ?? [], this.now());
  }

  private noteSpoken(call: Call): void {
    const now = this.now();
    const recent = (this.spokenAt.get(call.conversationId) ?? []).filter((at) => now - at < 60_000);
    this.spokenAt.set(call.conversationId, [...recent, now]);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
