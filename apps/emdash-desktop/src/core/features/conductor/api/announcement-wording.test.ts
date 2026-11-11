import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_OFFER,
  finishedSentence,
  waitingSentence,
  withOffer,
} from './announcement-wording';

describe('finishedSentence', () => {
  it('leads with the title, then says what the agent did in the past tense', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'TTS research',
        completionSummary: 'researched TTS models across three areas',
      })
    ).toBe('TTS research is finished. Kilo researched TTS models across three areas.');
  });

  it('names the agent as a handle when the summary is not past tense', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'TTS research',
        completionSummary: 'TTS model comparison',
      })
    ).toBe('TTS research is finished, on Kilo: TTS model comparison.');
  });

  it('does not double a title the summary already says', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'Flaky login test',
        completionSummary: 'fixed the flaky login test',
      })
    ).toBe('Kilo fixed the flaky login test.');
    // Small words in the title do not count against the guard.
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'The flaky test for login',
        completionSummary: 'fixed the flaky login test',
      })
    ).toBe('Kilo fixed the flaky login test.');
  });

  it('says an instruction title as what it was doing, and not when the summary says it', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'Fix login',
        completionSummary: 'patched the session cookie',
      })
    ).toBe('Fixing login is finished. Kilo patched the session cookie.');
    // The summary's "built" stands for the title's "Build".
    expect(
      finishedSentence({
        name: 'Zulu',
        taskName: 'Build a todo app',
        completionSummary: 'built the Express todo app and started it',
      })
    ).toBe('Zulu built the Express todo app and started it.');
  });

  it('keeps the task-name sentence when there is no summary', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'Research speech-to-text models',
        completionSummary: null,
      })
    ).toBe('Kilo finished researching speech-to-text models.');
  });

  it('keeps "is done" when there is nothing usable', () => {
    expect(finishedSentence({ name: 'Kilo', taskName: '', completionSummary: null })).toBe(
      'Kilo is done.'
    );
    // A generic task name is not a title.
    expect(finishedSentence({ name: 'Kilo', taskName: 'New task', completionSummary: null })).toBe(
      'Kilo is done.'
    );
  });

  it('keeps the summary sentence when the task name is generic', () => {
    expect(
      finishedSentence({
        name: 'Kilo',
        taskName: 'New task',
        completionSummary: 'fixed the flaky login test',
      })
    ).toBe('Kilo fixed the flaky login test.');
  });
});

describe('waitingSentence', () => {
  it('leads with the title and names the agent once as a handle', () => {
    expect(
      waitingSentence({
        name: 'Atlas',
        taskName: 'Login fix',
        phrase: 'needs permission',
        suffix: ' for something risky',
      })
    ).toBe('Login fix needs permission for something risky, on Atlas.');
  });

  it('says an instruction title as what the agent is doing', () => {
    expect(
      waitingSentence({
        name: 'Zulu',
        taskName: 'Build a todo app',
        phrase: 'needs permission',
        suffix: '',
      })
    ).toBe('Building a todo app needs permission, on Zulu.');
  });

  it('names the agent when it has no title', () => {
    expect(
      waitingSentence({ name: 'Atlas', taskName: 'New task', phrase: 'needs you', suffix: '' })
    ).toBe('Atlas needs you.');
  });
});

describe('withOffer', () => {
  it('ends with one offer only when asked and exactly one agent finished', () => {
    expect(ANNOUNCEMENT_OFFER).toBe('Want to see it?');
    expect(withOffer('Done.', 1, true)).toBe('Done. Want to see it?');
    expect(withOffer('Done.', 1, false)).toBe('Done.');
    expect(withOffer('Done.', 0, true)).toBe('Done.');
    expect(withOffer('Done.', 2, true)).toBe('Done.');
  });
});
