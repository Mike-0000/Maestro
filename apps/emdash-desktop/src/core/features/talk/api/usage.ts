/**
 * What a realtime response cost. The Realtime API bills each response for the whole conversation
 * it was given, at separate rates for text and audio and for the part of the input the provider
 * had cached. Prices are US dollars per million tokens, from OpenAI's pricing page on 2026-10-10;
 * a model that is not listed is costed as the most expensive one, so the cap errs towards
 * stopping early.
 */

export type TalkTokens = {
  /** Input text tokens that were not served from the cache. */
  readonly textIn: number;
  readonly cachedTextIn: number;
  readonly audioIn: number;
  readonly cachedAudioIn: number;
  readonly textOut: number;
  readonly audioOut: number;
};

export const NO_TOKENS: TalkTokens = {
  textIn: 0,
  cachedTextIn: 0,
  audioIn: 0,
  cachedAudioIn: 0,
  textOut: 0,
  audioOut: 0,
};

type Prices = TalkTokens;

const PRICES: Record<string, Prices> = {
  'gpt-realtime-2.1': {
    textIn: 4,
    cachedTextIn: 0.4,
    audioIn: 32,
    cachedAudioIn: 0.4,
    textOut: 24,
    audioOut: 64,
  },
  'gpt-realtime-2.1-mini': {
    textIn: 0.6,
    cachedTextIn: 0.06,
    audioIn: 10,
    cachedAudioIn: 0.3,
    textOut: 2.4,
    audioOut: 20,
  },
  'gpt-realtime-1.5': {
    textIn: 4,
    cachedTextIn: 0.4,
    audioIn: 32,
    cachedAudioIn: 0.4,
    textOut: 16,
    audioOut: 64,
  },
};

const FALLBACK_PRICES: Prices = {
  textIn: 4,
  cachedTextIn: 0.4,
  audioIn: 32,
  cachedAudioIn: 0.4,
  textOut: 24,
  audioOut: 64,
};

/** Models offered in settings, cheapest and fastest last. */
export const TALK_MODELS = Object.keys(PRICES);

/** Dollars for one response's tokens on `model`. */
export function talkCostUsd(model: string, tokens: TalkTokens): number {
  const prices = PRICES[model] ?? FALLBACK_PRICES;
  const keys = Object.keys(prices) as (keyof TalkTokens)[];
  const total = keys.reduce((sum, key) => sum + (tokens[key] / 1_000_000) * prices[key], 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

type RealtimeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The `usage` object of a `response.done` event as billable token counts. Cached tokens are a
 * subset of the input tokens, so they are taken out of the uncached counts. Anything missing or
 * malformed counts as zero; when a response does not split its input, all of it is costed as
 * text.
 */
export function tokensFromUsage(usage: unknown): TalkTokens {
  if (!usage || typeof usage !== 'object') return NO_TOKENS;
  const raw = usage as RealtimeUsage;
  const input = raw.input_token_details ?? {};
  const cached = input.cached_tokens_details ?? {};
  const cachedText = count(cached.text_tokens);
  const cachedAudio = count(cached.audio_tokens);
  // A response that reports only a cached total: cost it as text, the common case for a feed.
  const cachedUnsplit = Math.max(0, count(input.cached_tokens) - cachedText - cachedAudio);
  const text = input.text_tokens === undefined ? count(raw.input_tokens) : count(input.text_tokens);
  const output = raw.output_token_details ?? {};
  const textOut =
    output.text_tokens === undefined && output.audio_tokens === undefined
      ? count(raw.output_tokens)
      : count(output.text_tokens);
  return {
    textIn: Math.max(0, text - cachedText - cachedUnsplit),
    cachedTextIn: cachedText + cachedUnsplit,
    audioIn: Math.max(0, count(input.audio_tokens) - cachedAudio),
    cachedAudioIn: cachedAudio,
    textOut,
    audioOut: count(output.audio_tokens),
  };
}

/** Every input token of a response, cached or not: how full the session is. */
export function inputSize(tokens: TalkTokens): number {
  return tokens.textIn + tokens.cachedTextIn + tokens.audioIn + tokens.cachedAudioIn;
}

/** The share of a response's input that came from the cache, 0 to 1. */
export function cachedShare(tokens: TalkTokens): number {
  const total = inputSize(tokens);
  return total === 0 ? 0 : (tokens.cachedTextIn + tokens.cachedAudioIn) / total;
}
