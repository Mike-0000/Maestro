import { describe, expect, it } from 'vitest';
import { answersMaestro, isSubmitPhrase } from './front';

const idle = { pending: false, busy: false, clarifying: false };

describe('answersMaestro', () => {
  it('leaves everything to the chat conductor while Maestro has nothing open', () => {
    expect(answersMaestro('yes', idle)).toBe(false);
    expect(answersMaestro('stop', idle)).toBe(false);
    expect(answersMaestro('tell it to run the tests', idle)).toBe(false);
  });

  it('gives a yes, a no and a bare close to the confirmation on screen', () => {
    const pending = { ...idle, pending: true, busy: true };
    expect(answersMaestro('yes', pending)).toBe(true);
    expect(answersMaestro('go ahead', pending)).toBe(true);
    expect(answersMaestro('no', pending)).toBe(true);
    expect(answersMaestro('No, stop!', pending)).toBe(true);
    expect(answersMaestro('close it', pending)).toBe(true);
    expect(answersMaestro('ask it why the build failed', pending)).toBe(false);
  });

  it('gives a stop to a running Maestro turn, but not a yes', () => {
    const busy = { ...idle, busy: true };
    expect(answersMaestro('stop', busy)).toBe(true);
    expect(answersMaestro('cancel that', busy)).toBe(true);
    expect(answersMaestro('yes', busy)).toBe(false);
  });

  it('gives anything to an open clarification', () => {
    expect(answersMaestro('the second one', { ...idle, clarifying: true })).toBe(true);
  });
});

describe('the spoken submit', () => {
  it('is known, so it stays with Maestro and presses Enter on dictated words', () => {
    expect(isSubmitPhrase('send it')).toBe(true);
    expect(isSubmitPhrase('Press enter.')).toBe(true);
    expect(isSubmitPhrase('send it to Atlas')).toBe(false);
  });
});
