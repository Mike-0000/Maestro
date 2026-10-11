import { describe, expect, it } from 'vitest';
import { isPureStop, meansStop } from './stop-words';

describe('isPureStop', () => {
  it('is true for stop and no, however they are said', () => {
    for (const said of [
      'no',
      'No.',
      'nope',
      'stop',
      'No, stop!',
      'stop it',
      'stop that',
      'cancel that',
      'no no no',
      "no, don't send that",
      'Don’t do that',
      'stop everything',
      'no wait',
      'wait wait wait',
      'hang on',
      'hold on a second',
      'never mind',
      'nevermind',
      'oh, forget it',
      'scratch that',
      'no thanks',
    ]) {
      expect(isPureStop(said), said).toBe(true);
    }
  });

  it('is false as soon as the words name something', () => {
    for (const said of [
      'stop Atlas',
      'wait for the tests to finish',
      'no tests failed',
      'cancel the plan and start over',
      "don't forget to rebase",
      'not now',
      'yes',
      'later',
      'tell it to stop',
      '',
    ]) {
      expect(isPureStop(said), said).toBe(false);
    }
  });
});

describe('meansStop', () => {
  it('tells a stop from a no', () => {
    for (const said of ['stop', 'No, stop!', 'cancel that', 'wait', "no, don't", 'never mind']) {
      expect(meansStop(said), said).toBe(true);
    }
    for (const said of ['no', 'nope', 'no no no', 'no thanks', 'deny']) {
      expect(meansStop(said), said).toBe(false);
    }
  });

  it('gives the same answer every time it is asked', () => {
    expect(meansStop('hang on')).toBe(true);
    expect(meansStop('hang on')).toBe(true);
    expect(meansStop('no')).toBe(false);
  });
});
