/**
 * What the talk line costs. Grok Voice bills a session by the minute, plus a small charge for
 * each text input; prices are US dollars, from xAI's pricing page on 2026-10-14. xAI does not say
 * whether a minute is one of connection or of audio, so the line counts every second a session
 * is open, which errs towards stopping early. A model that is not listed is costed as the most
 * expensive one, for the same reason.
 *
 * Responses still report tokens. They cost nothing on their own, but they say how full the
 * session is, which decides when it is replaced by a fresh one.
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

/** What a stretch of the line used that is billed. */
export type TalkBilled = {
  /** Seconds a session was open. */
  readonly seconds: number;
  /** Text messages sent into the conversation: notes, state, typed requests, set sentences. */
  readonly textInputs: number;
};

type Prices = { readonly perMinute: number; readonly perTextInput: number };

const GROK_VOICE_PRICES: Prices = { perMinute: 0.08, perTextInput: 0.004 };

const PRICES: Record<string, Prices> = {
  'grok-voice-3.0': GROK_VOICE_PRICES,
  'grok-voice-latest': GROK_VOICE_PRICES,
};

const FALLBACK_PRICES: Prices = GROK_VOICE_PRICES;

/** Models offered in settings: the pinned release first, then the alias that follows releases. */
export const TALK_MODELS = Object.keys(PRICES);

function amount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Dollars for what the line used on `model`. */
export function talkCostUsd(model: string, billed: TalkBilled): number {
  const prices = PRICES[model] ?? FALLBACK_PRICES;
  const total =
    (amount(billed.seconds) / 60) * prices.perMinute +
    Math.floor(amount(billed.textInputs)) * prices.perTextInput;
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
 * The `usage` object of a `response.done` event as token counts. Grok Voice reports only input
 * and output totals, which count as text; a fuller split is read when one is there. Cached
 * tokens are a subset of the input tokens, so they are taken out of the uncached counts.
 * Anything missing or malformed counts as zero.
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
