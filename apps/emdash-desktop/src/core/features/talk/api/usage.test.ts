import { describe, expect, it } from 'vitest';
import { cachedShare, inputSize, NO_TOKENS, talkCostUsd, tokensFromUsage } from './usage';

describe('tokensFromUsage', () => {
  it('splits a response into billable counts and takes cached tokens out of the uncached ones', () => {
    const tokens = tokensFromUsage({
      input_tokens: 12_300,
      output_tokens: 260,
      input_token_details: {
        text_tokens: 12_000,
        audio_tokens: 300,
        cached_tokens: 11_100,
        cached_tokens_details: { text_tokens: 11_000, audio_tokens: 100 },
      },
      output_token_details: { text_tokens: 60, audio_tokens: 200 },
    });
    expect(tokens).toEqual({
      textIn: 1_000,
      cachedTextIn: 11_000,
      audioIn: 200,
      cachedAudioIn: 100,
      textOut: 60,
      audioOut: 200,
    });
    expect(inputSize(tokens)).toBe(12_300);
    expect(cachedShare(tokens)).toBeCloseTo(11_100 / 12_300, 6);
  });

  it('treats a cached total with no split as text', () => {
    const tokens = tokensFromUsage({
      input_token_details: { text_tokens: 1_000, audio_tokens: 0, cached_tokens: 800 },
      output_token_details: { text_tokens: 10 },
    });
    expect(tokens.cachedTextIn).toBe(800);
    expect(tokens.textIn).toBe(200);
  });

  it('counts nothing for a missing or malformed usage', () => {
    expect(tokensFromUsage(undefined)).toEqual(NO_TOKENS);
    expect(tokensFromUsage('nope')).toEqual(NO_TOKENS);
    expect(tokensFromUsage({ input_token_details: { text_tokens: -5 } })).toEqual(NO_TOKENS);
    expect(cachedShare(NO_TOKENS)).toBe(0);
  });

  it('costs an unsplit response as text', () => {
    expect(tokensFromUsage({ input_tokens: 500, output_tokens: 40 })).toMatchObject({
      textIn: 500,
      textOut: 40,
    });
  });
});

describe('talkCostUsd', () => {
  const reply = {
    textIn: 0,
    cachedTextIn: 12_000,
    audioIn: 40,
    cachedAudioIn: 0,
    textOut: 50,
    audioOut: 160,
  };

  it('prices a spoken reply at about two cents on the full model and under a cent on mini', () => {
    expect(talkCostUsd('gpt-realtime-2.1', reply)).toBeCloseTo(0.01752, 5);
    expect(talkCostUsd('gpt-realtime-2.1-mini', reply)).toBeCloseTo(0.00444, 5);
  });

  it('costs a model it does not know as the most expensive one', () => {
    expect(talkCostUsd('some-future-model', reply)).toBe(talkCostUsd('gpt-realtime-2.1', reply));
  });

  it('never returns a negative or invalid amount', () => {
    expect(talkCostUsd('gpt-realtime-2.1', NO_TOKENS)).toBe(0);
    expect(talkCostUsd('gpt-realtime-2.1', { ...NO_TOKENS, textIn: Number.NaN })).toBe(0);
  });
});
