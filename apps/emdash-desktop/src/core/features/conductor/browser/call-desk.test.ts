import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announcementDeadlineMs,
  ANNOUNCEMENT_TTL_MS,
  callUrgency,
  LATER_MS,
  MAX_WAITING_ANNOUNCEMENTS,
  nextCall,
  promptFingerprint,
  queueAnnouncement,
  SPOKEN_CALLS_PER_MINUTE,
  type Announcement,
  type Call,
  type CallMode,
} from '../api/calls';
import { CallDesk, type CallHost } from './call-desk';

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: overrides.id ?? `c-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-atlas',
    agentName: 'Atlas',
    kind: 'completion',
    text: 'Atlas finished.',
    urgency: callUrgency(overrides.kind ?? 'completion'),
    at: Date.now(),
    ...overrides,
  };
}

function news(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: overrides.id ?? `a-${Math.random().toString(36).slice(2, 8)}`,
    text: 'Atlas needs you.',
    source: 'attention',
    spoken: true,
    at: Date.now(),
    interactionId: 'trace-1',
    agents: ['conv-atlas'],
    ...overrides,
  };
}

function harness(options: { mode?: CallMode; windowMs?: number } = {}) {
  const state = {
    mode: options.mode ?? ('spoken' as CallMode),
    free: true,
    freeToAnnounce: true,
    firstAudioMs: 0,
    told: [] as string[],
    finishNews: [] as (() => void)[],
    highlighted: [] as (string | null)[],
    shown: [] as string[],
    spoken: [] as string[],
    tones: 0,
    traces: [] as string[],
    finishSpeech: [] as (() => void)[],
  };
  const host: CallHost = {
    mode: () => state.mode,
    windowMs: () => options.windowMs ?? 6_000,
    free: () => state.free,
    show: (shown) => state.shown.push(shown.text),
    speak: (said) => {
      state.spoken.push(said.text);
      return new Promise<void>((resolve) => state.finishSpeech.push(resolve));
    },
    highlight: (id) => state.highlighted.push(id),
    tone: () => state.tones++,
    trace: (traced, status) => state.traces.push(`${traced.agentName}:${status}`),
    freeToAnnounce: () => state.freeToAnnounce,
    firstAudioWaitMs: () => state.firstAudioMs,
    announce: (_announcement, text) => {
      state.told.push(text);
      return new Promise<void>((resolve) => state.finishNews.push(resolve));
    },
    traceAnnouncement: (announcement, status, detail) =>
      state.traces.push(
        `${announcement.text}:${status}${detail?.reason ? `:${String(detail.reason)}` : ''}`
      ),
  };
  const desk = new CallDesk(host);
  const endSpeech = async () => {
    state.finishSpeech.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  const endNews = async () => {
    state.finishNews.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { desk, state, endSpeech, endNews };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('call order', () => {
  it('puts the most urgent first, then the one that waited longest', () => {
    const done = call({ id: 'done', at: 1 });
    const prompt = call({ id: 'prompt', kind: 'permission', at: 2 });
    const older = call({ id: 'older', at: 0 });
    expect(nextCall([done, prompt, older])?.id).toBe('prompt');
    expect(nextCall([done, older])?.id).toBe('older');
    expect(nextCall([])).toBeNull();
  });

  it('lets a triage reading override the default for the kind', () => {
    expect(callUrgency('completion', 0.95)).toBe(0.95);
    expect(callUrgency('completion', null)).toBe(callUrgency('completion'));
    expect(callUrgency('permission')).toBeGreaterThan(callUrgency('completion'));
  });

  it('puts the agent the developer stays with first', () => {
    const prompt = call({ id: 'prompt', kind: 'permission', conversationId: 'conv-bravo' });
    const atlas = call({ id: 'atlas' });
    expect(nextCall([prompt, atlas], 'conv-atlas')?.id).toBe('atlas');
  });
});

describe('promptFingerprint', () => {
  it('ignores counters, spinners, borders and spacing, and keeps the words', () => {
    const first = promptFingerprint(
      '╭──────────╮\n│ Run git push origin main? │\n╰──────────╯\n  ⠋ waiting 12s\n1. Yes   2. No'
    );
    const redrawn = promptFingerprint(
      '╭──────────╮\n│ Run git push origin main?   │\n╰──────────╯\n  ⠙ waiting 47s\n1. Yes   2. No'
    );
    expect(redrawn).toBe(first);
    expect(first).toContain('run git push origin main?');
  });

  it('changes when the agent asks something else', () => {
    const push = promptFingerprint('Run git push origin main?\n1. Yes 2. No');
    const remove = promptFingerprint('Run rm -rf build?\n1. Yes 2. No');
    expect(remove).not.toBe(push);
  });

  it('counts every digit of the prompt itself', () => {
    const one = promptFingerprint('Run rm -rf releases/v1?\n1. Yes 2. No');
    const two = promptFingerprint('Run rm -rf releases/v2?\n1. Yes 2. No');
    expect(two).not.toBe(one);
  });

  it('ignores the numbers of a status line only', () => {
    const status = (seconds: number, tokens: string) =>
      `Run npm test?\n1. Yes 2. No\n(${seconds}s · ${tokens} tokens · esc to interrupt)`;
    expect(promptFingerprint(status(3, '1.2k'))).toBe(promptFingerprint(status(41, '9.8k')));
  });

  it('counts every line that was read, not only the last few', () => {
    const steps = Array.from({ length: 20 }, (_, index) => `  echo step ${index + 1}`);
    const prompt = (first: string) =>
      [first, ...steps, 'Do you want to proceed?', '1. Yes', '2. No'].join('\n');
    expect(promptFingerprint(prompt('  rm -rf ./build'))).not.toBe(
      promptFingerprint(prompt('  rm -rf ~/'))
    );
  });

  it('leaves out a working line whole, whatever its spinner and counters show', () => {
    const prompt = (status: string) => `Do you want to proceed?\n1. Yes\n2. No\n${status}`;
    const readings = [
      '✻ Cogitating… (59s · ↓ 950 tokens · esc to interrupt)',
      '✽ Cogitating… (1m 0s · ↓ 1.2k tokens · esc to interrupt)',
      '· Working (2s • Esc to interrupt)',
    ].map((status) => promptFingerprint(prompt(status)));
    expect(new Set(readings).size).toBe(1);
    // A line of the command that happens to mention tokens is part of the prompt.
    expect(promptFingerprint('Run cat tokens.txt?\n1. Yes')).not.toBe(
      promptFingerprint('Run rm tokens.txt?\n1. Yes')
    );
  });

  it('has no fingerprint for a terminal that could not be read', () => {
    expect(promptFingerprint('(no terminal session)')).toBeNull();
    expect(promptFingerprint('(no output yet)')).toBeNull();
    expect(promptFingerprint('(the chat transcript is not available)')).toBeNull();
    expect(promptFingerprint('  \n \n')).toBeNull();
  });
});

describe('CallDesk', () => {
  it('speaks a call, keeps it on the line for the window, then lets it lapse', async () => {
    const { desk, state, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    expect(desk.current?.state).toBe('delivering');
    expect(state.spoken).toEqual(['Atlas finished.']);
    expect(state.highlighted).toEqual(['conv-atlas']);

    await endSpeech();
    expect(desk.current?.state).toBe('on-line');
    expect(desk.canPickUp).toBe(true);

    vi.advanceTimersByTime(6_000);
    expect(desk.current).toBeNull();
    expect(state.highlighted.at(-1)).toBeNull();
    expect(state.traces).toEqual(['Atlas:offered', 'Atlas:spoken', 'Atlas:lapsed']);
  });

  it('delivers one caller at a time, most urgent first', async () => {
    const { desk, state, endSpeech } = harness();
    desk.offer(call({ id: 'a', text: 'Atlas finished.' }));
    desk.offer(
      call({ id: 'b', conversationId: 'conv-bravo', agentName: 'Bravo', text: 'Bravo finished.' })
    );
    desk.offer(
      call({
        id: 'c',
        conversationId: 'conv-cedar',
        agentName: 'Cedar',
        kind: 'permission',
        text: 'Cedar needs permission.',
      })
    );
    expect(state.spoken).toEqual(['Atlas finished.']);
    await endSpeech();
    vi.advanceTimersByTime(6_000);
    expect(state.spoken).toEqual(['Atlas finished.', 'Cedar needs permission.']);
    await endSpeech();
    vi.advanceTimersByTime(6_000);
    expect(state.spoken.at(-1)).toBe('Bravo finished.');
  });

  it('binds a pick-up to the caller and holds the line until it is released', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    desk.offer(call({ id: 'b', conversationId: 'conv-bravo', agentName: 'Bravo' }));
    await endSpeech();

    const picked = desk.pickUp();
    expect(picked?.conversationId).toBe('conv-atlas');
    expect(desk.pickedUp?.id).toBe('a');
    expect(desk.canPickUp).toBe(false);
    // The window does not run out under the developer.
    vi.advanceTimersByTime(60_000);
    expect(desk.pickedUp?.id).toBe('a');
    expect(desk.pickUp()).toBeNull();

    desk.release('a');
    expect(desk.current?.call.id).toBe('b');
  });

  it('can be picked up while it is still being said', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    expect(desk.pickUp()?.id).toBe('a');
    await endSpeech();
    expect(desk.current?.state).toBe('picked-up');
  });

  it('puts a call back on the line when the developer said nothing', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    desk.pickUp();
    desk.putBack('a');
    expect(desk.current?.state).toBe('on-line');
    vi.advanceTimersByTime(6_000);
    expect(desk.current).toBeNull();
  });

  it('waits while the developer is busy and delivers when pumped', async () => {
    const { desk, state } = harness();
    state.free = false;
    desk.offer(call({ id: 'a' }));
    expect(desk.current).toBeNull();
    expect(desk.waiting).toHaveLength(1);
    state.free = true;
    desk.pump();
    expect(desk.current?.call.id).toBe('a');
  });

  it('shows a call with a tone and no speech in quiet mode', () => {
    const { desk, state } = harness({ mode: 'quiet' });
    desk.offer(call({ id: 'a' }));
    expect(state.spoken).toEqual([]);
    expect(state.tones).toBe(1);
    expect(state.shown).toEqual(['Atlas finished.']);
    expect(desk.current?.state).toBe('on-line');
  });

  it('takes nothing when calls are off', () => {
    const { desk } = harness({ mode: 'off' });
    desk.offer(call({ id: 'a' }));
    expect(desk.current).toBeNull();
    expect(desk.waiting).toEqual([]);
  });

  it('skips, defers, holds and resumes', async () => {
    const { desk, state, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    desk.offer(call({ id: 'b', conversationId: 'conv-bravo', agentName: 'Bravo' }));
    await endSpeech();

    // Later: Atlas goes behind Bravo.
    expect(desk.later()?.id).toBe('a');
    expect(desk.current?.call.id).toBe('b');
    await endSpeech();

    expect(desk.skip()?.id).toBe('b');
    // The call that was set aside stays away for a while, then comes back by itself.
    expect(desk.current).toBeNull();
    vi.advanceTimersByTime(LATER_MS + 10);
    expect(desk.current?.call.id).toBe('a');
    await endSpeech();

    desk.hold(true);
    desk.skip();
    desk.offer(call({ id: 'c', conversationId: 'conv-cedar', agentName: 'Cedar' }));
    expect(desk.current).toBeNull();
    desk.hold(false);
    expect(desk.current?.call.id).toBe('c');
    expect(state.traces).toContain('Atlas:deferred');
  });

  it('does not redeliver a call that was just set aside when nothing else waits', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    desk.later();
    expect(desk.current).toBeNull();
    expect(desk.waiting).toHaveLength(1);
    // Whatever makes the desk look again (a turn ending, a prompt settling) leaves it aside.
    desk.pump();
    expect(desk.current).toBeNull();
    expect(desk.next()).toBe(true);
    expect(desk.current?.call.id).toBe('a');
  });

  it('brings back the calls that were set aside on "take my calls"', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    desk.later();
    desk.hold(true);
    desk.hold(false);
    expect(desk.current?.call.id).toBe('a');
  });

  it('releases only the call that is still picked up', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    desk.pickUp();
    desk.later();
    // The exchange that set it aside ends: the call is kept, not dropped.
    desk.release('a');
    expect(desk.waiting.map((waiting) => waiting.id)).toEqual(['a']);

    desk.next();
    await endSpeech();
    // On the line, not picked up: releasing it is not this exchange's to do.
    desk.release('a');
    expect(desk.current?.call.id).toBe('a');
  });

  it('replaces an older call about the same thing from the same agent', () => {
    const { desk, state } = harness();
    state.free = false;
    desk.offer(call({ id: 'a', text: 'first' }));
    desk.offer(call({ id: 'b', text: 'second' }));
    expect(desk.waiting.map((waiting) => waiting.text)).toEqual(['second']);
  });

  it('stops speaking for an agent that calls too often inside a minute', async () => {
    const { desk, state, endSpeech } = harness({ windowMs: 100 });
    for (let index = 0; index < SPOKEN_CALLS_PER_MINUTE + 1; index++) {
      desk.offer(call({ id: `a${index}`, requestId: `r${index}`, kind: 'request' }));
      await endSpeech();
      vi.advanceTimersByTime(100);
    }
    expect(state.spoken).toHaveLength(SPOKEN_CALLS_PER_MINUTE);
    expect(state.tones).toBe(1);
  });

  it('forgets an agent that left', async () => {
    const { desk, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    desk.offer(call({ id: 'a2', kind: 'permission' }));
    await endSpeech();
    desk.forget('conv-atlas');
    expect(desk.current).toBeNull();
    expect(desk.waiting).toEqual([]);
  });
});

describe('announcements', () => {
  it('keeps only the latest word on an agent, and caps what waits', () => {
    const now = Date.now();
    const atlas = news({ id: 'atlas', at: now });
    const both = news({ id: 'both', agents: ['conv-atlas', 'conv-bravo'], at: now });
    const newer = news({ id: 'newer', text: 'Atlas finished.', at: now });
    const queued = queueAnnouncement([atlas, both], newer, now);
    // The batch also names Bravo, so the newer word on Atlas alone does not cover it.
    expect(queued.waiting.map((item) => item.id)).toEqual(['both', 'newer']);
    expect(queued.dropped).toEqual([{ announcement: atlas, reason: 'replaced' }]);

    let waiting: Announcement[] = [];
    for (let index = 0; index < MAX_WAITING_ANNOUNCEMENTS + 2; index++) {
      waiting = queueAnnouncement(
        waiting,
        news({ id: `n${index}`, agents: [`c${index}`] }),
        now
      ).waiting;
    }
    expect(waiting.map((item) => item.id)).toEqual(['n2', 'n3', 'n4']);
  });

  it('keeps a question to the developer until news about the same request replaces it', () => {
    const now = Date.now();
    const question = news({ id: 'q', asks: 'r-1', at: now });
    const done = news({ id: 'done', text: 'Atlas finished.', at: now });
    expect(queueAnnouncement([question], done, now).waiting.map((item) => item.id)).toEqual([
      'q',
      'done',
    ]);
    const again = news({ id: 'again', asks: 'r-1', at: now });
    expect(queueAnnouncement([question], again, now).waiting.map((item) => item.id)).toEqual([
      'again',
    ]);
    // Over the cap, what asks nothing goes first.
    const full = [question, news({ id: 'x', agents: ['c1'] }), news({ id: 'y', agents: ['c2'] })];
    const capped = queueAnnouncement(full, news({ id: 'z', agents: ['c3'] }), now);
    expect(capped.waiting.map((item) => item.id)).toEqual(['q', 'y', 'z']);
  });

  it('waits while the developer is not free, then tells one at a time', async () => {
    const { desk, state, endNews } = harness({ mode: 'off' });
    state.freeToAnnounce = false;
    desk.announce(news({ text: 'Atlas needs you.' }));
    desk.announce(news({ text: 'Bravo finished.', agents: ['conv-bravo'] }));
    expect(state.told).toEqual([]);

    state.freeToAnnounce = true;
    desk.pump();
    expect(state.told).toEqual(['Atlas needs you.']);
    // The next one waits for the first to end, whatever else pumps the desk.
    desk.pump();
    expect(state.told).toEqual(['Atlas needs you.']);
    await endNews();
    expect(state.told).toEqual(['Atlas needs you.', 'Bravo finished.']);
    await endNews();
    expect(desk.announcements).toEqual([]);
  });

  it('drops what is old news, or no longer true, when it is about to be told', () => {
    const { desk, state } = harness({ mode: 'off' });
    state.freeToAnnounce = false;
    const now = Date.now();
    desk.announce(news({ text: 'Old.', agents: ['c1'], at: now - ANNOUNCEMENT_TTL_MS - 1 }));
    desk.announce(news({ text: 'Settled.', agents: ['c2'], current: () => null }));
    desk.announce(news({ text: 'Atlas needs permission.', current: () => 'Atlas needs you.' }));
    state.freeToAnnounce = true;
    desk.pump();
    expect(state.told).toEqual(['Atlas needs you.']);
    expect(state.traces).toContain('Old.:dropped:expired');
    expect(state.traces).toContain('Settled.:dropped:stale');
  });

  it('moves on when the end of what is being said never comes', async () => {
    const { desk, state } = harness({ mode: 'off' });
    // A cloud voice may wait this long for its first audio before it says anything.
    state.firstAudioMs = 8_000;
    desk.announce(news({ text: 'Atlas needs you.' }));
    desk.announce(news({ text: 'Bravo finished.', agents: ['conv-bravo'] }));
    expect(state.told).toEqual(['Atlas needs you.']);
    // Without that wait in the deadline, the next one would cut off a sentence about to start.
    await vi.advanceTimersByTimeAsync(announcementDeadlineMs('Atlas needs you.'));
    expect(state.told).toEqual(['Atlas needs you.']);
    // The speech's end is never reported.
    const deadline = announcementDeadlineMs('Atlas needs you.', 8_000);
    await vi.advanceTimersByTimeAsync(deadline - announcementDeadlineMs('Atlas needs you.') - 1);
    expect(state.told).toEqual(['Atlas needs you.']);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.told).toEqual(['Atlas needs you.', 'Bravo finished.']);
    expect(state.traces).toContain('Atlas needs you.:timeout');
  });

  it('never lets news replace a failure, or news only shown replace news to be said', () => {
    const now = Date.now();
    const failed = news({ id: 'f', text: 'Atlas didn’t start.', source: 'failure', at: now });
    const later = news({ id: 'n', text: 'Atlas needs you.', at: now });
    expect(queueAnnouncement([failed], later, now).waiting.map((item) => item.id)).toEqual([
      'f',
      'n',
    ]);
    const spoken = news({ id: 's', at: now });
    const shown = news({ id: 'h', spoken: false, at: now });
    expect(queueAnnouncement([spoken], shown, now).waiting.map((item) => item.id)).toEqual([
      's',
      'h',
    ]);
    // Over the cap a failure stays, and routine news goes first.
    const full = [failed, news({ id: 'x', agents: ['c1'] }), news({ id: 'y', agents: ['c2'] })];
    const capped = queueAnnouncement(full, news({ id: 'z', agents: ['c3'] }), now);
    expect(capped.waiting.map((item) => item.id)).toEqual(['f', 'y', 'z']);
  });

  it('says that “next” delivered something when it told news first', async () => {
    const { desk, state, endSpeech } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    state.free = false;
    state.freeToAnnounce = false;
    desk.announce(news({ text: 'Bravo didn’t start.', source: 'failure', agents: ['conv-b'] }));
    desk.offer(call({ id: 'b', conversationId: 'conv-cedar', agentName: 'Cedar' }));
    state.freeToAnnounce = true;
    expect(desk.next()).toBe(true);
    expect(state.told).toEqual(['Bravo didn’t start.']);
  });

  it('holds news with the calls, except that something failed', async () => {
    const { desk, state, endNews } = harness();
    desk.hold(true);
    desk.announce(news({ text: 'Atlas finished.' }));
    desk.announce(news({ text: 'Bravo didn’t start.', source: 'failure', agents: ['conv-bravo'] }));
    expect(state.told).toEqual(['Bravo didn’t start.']);
    await endNews();
    expect(state.told).toEqual(['Bravo didn’t start.']);
    desk.hold(false);
    expect(state.told).toEqual(['Bravo didn’t start.', 'Atlas finished.']);
  });

  it('clears what waits when the developer says stop', () => {
    const { desk, state } = harness({ mode: 'off' });
    state.freeToAnnounce = false;
    desk.announce(news());
    desk.clearAnnouncements();
    state.freeToAnnounce = true;
    desk.pump();
    expect(state.told).toEqual([]);
    expect(state.traces).toContain('Atlas needs you.:dropped:stopped');
  });

  it('waits behind a call on the line, and holds the next call back while it is told', async () => {
    const { desk, state, endSpeech, endNews } = harness();
    desk.offer(call({ id: 'a' }));
    await endSpeech();
    expect(desk.current?.state).toBe('on-line');
    desk.announce(news({ text: 'Bravo failed to start.', agents: ['conv-bravo'] }));
    expect(state.told).toEqual([]);

    desk.skip();
    expect(state.told).toEqual(['Bravo failed to start.']);
    desk.offer(call({ id: 'b', conversationId: 'conv-cedar', agentName: 'Cedar' }));
    expect(desk.current).toBeNull();
    await endNews();
    expect(desk.current?.call.id).toBe('b');
  });
});
