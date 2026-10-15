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
  it('prices an open minute at eight cents, and each text input at four tenths of a cent', () => {
    expect(talkCostUsd('grok-voice-3.0', { seconds: 60, textInputs: 0 })).toBeCloseTo(0.08, 8);
    expect(talkCostUsd('grok-voice-3.0', { seconds: 90, textInputs: 5 })).toBeCloseTo(0.14, 8);
    expect(talkCostUsd('grok-voice-latest', { seconds: 3_600, textInputs: 0 })).toBeCloseTo(4.8, 8);
  });

  it('costs a model it does not know as the most expensive one', () => {
    const used = { seconds: 120, textInputs: 3 };
    expect(talkCostUsd('some-future-model', used)).toBe(talkCostUsd('grok-voice-3.0', used));
  });

  it('never returns a negative or invalid amount', () => {
    expect(talkCostUsd('grok-voice-3.0', { seconds: 0, textInputs: 0 })).toBe(0);
    expect(talkCostUsd('grok-voice-3.0', { seconds: Number.NaN, textInputs: -2 })).toBe(0);
  });
});
