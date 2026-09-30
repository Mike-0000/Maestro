import { describe, expect, it } from 'vitest';
import {
  assembleBody,
  endOptions,
  spanStarts,
  splitSentences,
  startOptions,
  taskNameFrom,
  tidyBody,
  WHOLE_UTTERANCE,
} from './spans';

const texts = (text: string) =>
  splitSentences(text).map((sentence) => text.slice(sentence.start, sentence.end));

describe('splitSentences', () => {
  it('splits at sentence punctuation followed by space and at line breaks', () => {
    expect(texts('Run the tests. Then fix them!  Done?\nNext line')).toEqual([
      'Run the tests.',
      'Then fix them!',
      'Done?',
      'Next line',
    ]);
  });

  it('keeps versions, decimals, and file names whole', () => {
    expect(texts('Bump it to v2.5 in package.json now. Thanks.')).toEqual([
      'Bump it to v2.5 in package.json now.',
      'Thanks.',
    ]);
  });

  it('joins the tail into the last sentence past the limit', () => {
    const text = Array.from({ length: 5 }, (_unused, i) => `Sentence ${i}.`).join(' ');
    const sentences = splitSentences(text, 3);
    expect(sentences).toHaveLength(3);
    expect(text.slice(sentences[2]?.start, sentences[2]?.end)).toBe(
      'Sentence 2. Sentence 3. Sentence 4.'
    );
  });
});

describe('span candidates', () => {
  const text = 'Tell Maple 2 to run the full test suite. Also focus it after.';
  const sentences = splitSentences(text);

  it('offers clause starts after lead-in phrases', () => {
    const starts = spanStarts(text, sentences).map((start) => text.slice(start.offset));
    expect(starts).toContain('run the full test suite. Also focus it after.');
    expect(starts[0]).toBe(text);
  });

  it('labels options uniquely with a whole-utterance and end option', () => {
    const starts = startOptions(text, sentences, spanStarts(text, sentences));
    expect(starts.has(WHOLE_UTTERANCE)).toBe(true);
    expect(new Set(starts.keys()).size).toBe(starts.size);
    const ends = endOptions(text, sentences);
    expect([...ends.values()]).toEqual([1, 0, 1]);
  });

  it('assembles the body from the chosen start and drops sentences meant for Chorus', () => {
    const three = 'Tell Tango to use Postgres. Can you focus it? Keep the old tests.';
    const parts = splitSentences(three);
    const start = spanStarts(three, parts).find((candidate) =>
      three.slice(candidate.offset).startsWith('use Postgres')
    );
    expect(start).toBeDefined();
    if (!start) return;
    expect(assembleBody(three, parts, start, 2, new Map([[1, 0.9]]))).toBe(
      'Use Postgres. Keep the old tests.'
    );
    expect(assembleBody(three, parts, start, 0, new Map())).toBe('Use Postgres.');
  });
});

describe('tidyBody and taskNameFrom', () => {
  it('strips quotes and leading punctuation', () => {
    expect(tidyBody(': "fix the login redirect"')).toBe('Fix the login redirect');
  });

  it('takes the first clause without filler, bounded to 60 characters', () => {
    expect(taskNameFrom('Please add pagination to the customer list, then test it.', 'x')).toBe(
      'Add pagination to the customer list'
    );
    expect(taskNameFrom('', 'Codex agent')).toBe('Codex agent');
    expect(taskNameFrom('a '.repeat(80), 'x').length).toBeLessThanOrEqual(60);
  });
});
