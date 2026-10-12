import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendDictation,
  AttentionBatcher,
  attentionSentence,
  detectReply,
  examplePhrases,
  formatElapsed,
  IDLE_CAPTURE,
  newlyNeedingAttention,
  reduceCapture,
  TAP_MAX_MS,
  type CaptureEffect,
  type CaptureEvent,
  type CaptureState,
} from './voice-logic';

function run(events: CaptureEvent[], from: CaptureState = IDLE_CAPTURE) {
  const effects: CaptureEffect[] = [];
  let state = from;
  for (const event of events) {
    const next = reduceCapture(state, event);
    state = next.state;
    effects.push(next.effect);
  }
  return { state, effects };
}

const begin: CaptureEvent = { type: 'begin', mode: 'hold', intent: 'command' };
const release = (heldMs: number, options: { cancel?: boolean; latch?: boolean } = {}) =>
  ({
    type: 'release',
    heldMs,
    cancel: options.cancel ?? false,
    latch: options.latch ?? true,
  }) satisfies CaptureEvent;

describe('reduceCapture', () => {
  it('opens the microphone on a press and records once it is open', () => {
    const { state, effects } = run([begin, { type: 'opened' }]);
    expect(effects).toEqual(['open', null]);
    expect(state).toEqual({ phase: 'recording', mode: 'hold', intent: 'command' });
  });

  it('sends a held utterance on release', () => {
    const { state, effects } = run([begin, { type: 'opened' }, release(1200)]);
    expect(state).toEqual(IDLE_CAPTURE);
    expect(effects.at(-1)).toBe('finish');
  });

  it('turns a quick tap into tap-to-talk that runs until finished', () => {
    const tapped = run([begin, { type: 'opened' }, release(TAP_MAX_MS - 1)]);
    expect(tapped.state).toEqual({ phase: 'recording', mode: 'tap', intent: 'command' });
    expect(tapped.effects.at(-1)).toBeNull();
    // A later release (the tap's own pointer-up arriving twice) changes nothing.
    expect(run([release(5000)], tapped.state).state).toEqual(tapped.state);
    expect(run([{ type: 'finish' }], tapped.state)).toEqual({
      state: IDLE_CAPTURE,
      effects: ['finish'],
    });
  });

  it('drops a stray key tap instead of latching', () => {
    const { state, effects } = run([begin, { type: 'opened' }, release(80, { latch: false })]);
    expect(state).toEqual(IDLE_CAPTURE);
    expect(effects.at(-1)).toBe('discard');
  });

  it('discards when released in the cancel zone, however long it was held', () => {
    const { state, effects } = run([begin, { type: 'opened' }, release(4000, { cancel: true })]);
    expect(state).toEqual(IDLE_CAPTURE);
    expect(effects.at(-1)).toBe('discard');
  });

  it('remembers a release that happens while the microphone is still opening', () => {
    const queued = run([begin, release(900)]);
    expect(queued.state).toMatchObject({ phase: 'starting', queued: 'finish' });
    expect(run([{ type: 'opened' }], queued.state)).toEqual({
      state: IDLE_CAPTURE,
      effects: ['finish'],
    });
  });

  it('latches a tap made while the microphone is still opening', () => {
    const { state } = run([begin, release(100), { type: 'opened' }]);
    expect(state).toEqual({ phase: 'recording', mode: 'tap', intent: 'command' });
  });

  it('never lets a later finish override a cancel made while opening', () => {
    const { state, effects } = run([
      begin,
      { type: 'cancel' },
      { type: 'finish' },
      { type: 'opened' },
    ]);
    expect(state).toEqual(IDLE_CAPTURE);
    expect(effects.at(-1)).toBe('discard');
  });

  it('returns to idle without touching the microphone when it fails to open', () => {
    expect(run([begin, { type: 'failed' }])).toEqual({
      state: IDLE_CAPTURE,
      effects: ['open', null],
    });
  });

  it('ignores a second press while one is in progress, and stray events when idle', () => {
    const recording = run([begin, { type: 'opened' }]);
    expect(run([begin], recording.state)).toEqual({ state: recording.state, effects: [null] });
    expect(run([release(900), { type: 'finish' }, { type: 'cancel' }, { type: 'opened' }])).toEqual(
      { state: IDLE_CAPTURE, effects: [null, null, null, null] }
    );
  });

  it('keeps a dictation running across pointer releases', () => {
    const dictating = run([
      { type: 'begin', mode: 'tap', intent: 'dictation' },
      { type: 'opened' },
      release(2000),
    ]);
    expect(dictating.state).toEqual({ phase: 'recording', mode: 'tap', intent: 'dictation' });
  });
});

describe('formatElapsed', () => {
  it('formats minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_900)).toBe('0:07');
    expect(formatElapsed(125_000)).toBe('2:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('appendDictation', () => {
  it('joins dictated text to a draft with one space', () => {
    expect(appendDictation('', ' run the tests ')).toBe('run the tests');
    expect(appendDictation('Please', 'run the tests')).toBe('Please run the tests');
    expect(appendDictation('Please\n', 'run the tests')).toBe('Please\nrun the tests');
    expect(appendDictation('Please', '   ')).toBe('Please');
  });
});

describe('detectReply', () => {
  const live = { settling: false, awaiting: false };

  it('does not speak the reply already on the display at first load', () => {
    const result = detectReply(null, { reply: 'Sent to Atlas.', replyAt: 100 }, live);
    expect(result).toEqual({ cursor: { replyAt: 100 }, fresh: false, speak: null });
  });

  it('speaks a reply whose timestamp changed', () => {
    const result = detectReply({ replyAt: 100 }, { reply: ' Done. ', replyAt: 200 }, live);
    expect(result).toEqual({ cursor: { replyAt: 200 }, fresh: true, speak: 'Done.' });
  });

  it('speaks the same words again when the conductor says them again', () => {
    expect(detectReply({ replyAt: 100 }, { reply: 'Done.', replyAt: 101 }, live).speak).toBe(
      'Done.'
    );
  });

  it('stays quiet when nothing changed, as on a resynchronised display', () => {
    const result = detectReply({ replyAt: 100 }, { reply: 'Done.', replyAt: 100 }, live);
    expect(result.fresh).toBe(false);
    expect(result.speak).toBeNull();
  });

  it('shows but does not read out a reply that turned up across a reconnect', () => {
    const result = detectReply(
      { replyAt: 100 },
      { reply: 'Done.', replyAt: 200 },
      { settling: true, awaiting: false }
    );
    expect(result).toEqual({ cursor: { replyAt: 200 }, fresh: true, speak: null });
  });

  it('reads out the answer this device was waiting for, even across a reconnect', () => {
    const result = detectReply(
      { replyAt: 100 },
      { reply: 'Done.', replyAt: 200 },
      { settling: true, awaiting: true }
    );
    expect(result.speak).toBe('Done.');
  });

  it('has nothing to say for an empty reply', () => {
    expect(detectReply({ replyAt: 100 }, { reply: '  ', replyAt: 200 }, live).speak).toBeNull();
  });
});

describe('attention notices', () => {
  const agent = (id: string, needsAttention: boolean, archived = false) => ({
    conversationId: id,
    taskName: `Task ${id}`,
    needsAttention,
    archived,
  });

  it('announces nobody on the first look', () => {
    const { waiting, names } = newlyNeedingAttention(null, [agent('a', true), agent('b', false)]);
    expect([...waiting]).toEqual(['a']);
    expect(names).toEqual([]);
  });

  it('names agents that start waiting, once', () => {
    const first = newlyNeedingAttention(new Set(['a']), [agent('a', true), agent('b', true)]);
    expect(first.names).toEqual(['Task b']);
    const second = newlyNeedingAttention(first.waiting, [agent('a', true), agent('b', true)]);
    expect(second.names).toEqual([]);
  });

  it('announces an agent again after it stopped waiting in between', () => {
    const cleared = newlyNeedingAttention(new Set(['a']), [agent('a', false)]);
    expect([...cleared.waiting]).toEqual([]);
    expect(newlyNeedingAttention(cleared.waiting, [agent('a', true)]).names).toEqual(['Task a']);
  });

  it('ignores archived agents', () => {
    expect(newlyNeedingAttention(new Set(), [agent('a', true, true)]).names).toEqual([]);
  });

  it('builds one sentence for any number of agents', () => {
    expect(attentionSentence([])).toBe('');
    expect(attentionSentence(['Fix auth'])).toBe('Fix auth needs you');
    expect(attentionSentence(['A', 'B'])).toBe('A and B need you');
    expect(attentionSentence(['A', 'B', 'C'])).toBe('A, B and C need you');
    expect(attentionSentence(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others need you');
    expect(attentionSentence(['A', ' A ', ''])).toBe('A needs you');
  });

  describe('AttentionBatcher', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('gathers agents that start waiting within a second into one sentence', () => {
      const announce = vi.fn();
      const batcher = new AttentionBatcher(announce);
      batcher.add(['A']);
      vi.advanceTimersByTime(400);
      batcher.add(['B']);
      vi.advanceTimersByTime(599);
      expect(announce).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(announce).toHaveBeenCalledExactlyOnceWith('A and B need you');
    });

    it('starts a new sentence for agents that arrive after the window', () => {
      const announce = vi.fn();
      const batcher = new AttentionBatcher(announce);
      batcher.add(['A']);
      vi.advanceTimersByTime(1000);
      batcher.add(['B']);
      vi.advanceTimersByTime(1000);
      expect(announce.mock.calls).toEqual([['A needs you'], ['B needs you']]);
    });

    it('says nothing for an empty batch or after being cleared', () => {
      const announce = vi.fn();
      const batcher = new AttentionBatcher(announce);
      batcher.add([]);
      batcher.add(['A']);
      batcher.clear();
      vi.advanceTimersByTime(5000);
      expect(announce).not.toHaveBeenCalled();
    });
  });
});

describe('examplePhrases', () => {
  it('uses real agent and project names', () => {
    expect(examplePhrases(['Atlas', 'Bravo'], ['maestro'])).toEqual([
      'Tell Atlas to run the tests',
      'What is Bravo doing',
      'Start an agent in maestro',
    ]);
  });

  it('still offers something with one agent or none', () => {
    expect(examplePhrases(['Atlas'], [])).toEqual([
      'Tell Atlas to run the tests',
      'What is Atlas doing',
      'What can I say',
    ]);
    expect(examplePhrases([], ['website'])).toEqual([
      'Start an agent in website',
      'Who needs me',
      'What can I say',
    ]);
  });
});
