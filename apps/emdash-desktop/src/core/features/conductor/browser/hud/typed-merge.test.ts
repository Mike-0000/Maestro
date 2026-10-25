import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapsePastedLines, createTypedSubmitMerger, TYPED_MERGE_WINDOW_MS } from './typed-merge';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createTypedSubmitMerger', () => {
  it('sends an ordinary line straight away', () => {
    const send = vi.fn();
    createTypedSubmitMerger(send).submit('open claude');
    expect(send).toHaveBeenCalledWith('open claude');
  });

  it('joins a ":" line with the submit that follows into one turn', () => {
    const send = vi.fn();
    const merger = createTypedSubmitMerger(send);
    merger.submit('Need you to complete these actions:');
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    merger.submit('1. fix the build');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Need you to complete these actions:\n1. fix the build');
  });

  it('sends the held line alone once the window passes', () => {
    const send = vi.fn();
    createTypedSubmitMerger(send).submit('Here is the list:');
    vi.advanceTimersByTime(TYPED_MERGE_WINDOW_MS);
    expect(send).toHaveBeenCalledWith('Here is the list:');
  });

  it('keeps holding when the merged text still ends in ":"', () => {
    const send = vi.fn();
    const merger = createTypedSubmitMerger(send);
    merger.submit('First:');
    merger.submit('Second:');
    expect(send).not.toHaveBeenCalled();
    merger.flush();
    expect(send).toHaveBeenCalledWith('First:\nSecond:');
  });
});

describe('control words', () => {
  it.each(['Yes', 'no.'])('sends %s first, so it still answers a pending confirmation', (word) => {
    const send = vi.fn();
    const merger = createTypedSubmitMerger(send);
    merger.submit('Here is the list:');
    merger.submit(word);
    expect(send.mock.calls).toEqual([[word], ['Here is the list:']]);
  });

  it.each(['stop', 'cancel', 'wait!'])('sends the held line first, then %s on its own', (word) => {
    const send = vi.fn();
    const merger = createTypedSubmitMerger(send);
    merger.submit('Here is the list:');
    merger.submit(word);
    expect(send.mock.calls).toEqual([['Here is the list:'], [word]]);
  });

  it('still merges a longer reply that starts with a control word', () => {
    const send = vi.fn();
    const merger = createTypedSubmitMerger(send);
    merger.submit('Do these:');
    merger.submit('stop the build');
    expect(send).toHaveBeenCalledWith('Do these:\nstop the build');
  });
});

describe('held line notice', () => {
  it('reports the held line and clears it when sent', () => {
    const held = vi.fn();
    const merger = createTypedSubmitMerger(vi.fn(), TYPED_MERGE_WINDOW_MS, held);
    merger.submit('Next steps:');
    expect(held).toHaveBeenLastCalledWith('Next steps:');
    vi.advanceTimersByTime(TYPED_MERGE_WINDOW_MS);
    expect(held).toHaveBeenLastCalledWith(null);
  });
});

describe('collapsePastedLines', () => {
  it('turns line breaks into spaces', () => {
    expect(collapsePastedLines('a:\r\n  b\nc')).toBe('a: b c');
  });
});
