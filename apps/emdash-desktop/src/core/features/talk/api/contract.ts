import { defineContract, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * The talk line: one realtime voice session between the developer and Maestro. While it is open
 * its model is the conductor: it hears the developer and acts through the conductor's tools. The
 * renderer owns
 * the WebRTC connection (it has the microphone and the speaker); the main process owns the API
 * key, sets the session up, and keeps count of what it costs. No key or token ever reaches the
 * renderer: it sends its connection offer here and gets the provider's answer back.
 */
export const talkDomain = 'talk' as const;

export const talkEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);

/**
 * When the line hears the developer. `key`: while the talk key is held, and for a moment after
 * Maestro speaks. `open`: all the time, with no key.
 */
export const talkListeningSchema = z.enum(['key', 'open']);

export const talkSettingsSchema = z.object({
  /** Off: no session is ever opened and nothing here costs anything. */
  enabled: z.boolean(),
  model: z.string().min(1).max(80),
  voice: z.string().min(1).max(40),
  effort: talkEffortSchema,
  listening: talkListeningSchema,
  /**
   * With `key` listening: seconds the microphone stays open after Maestro stops speaking, so an
   * answer or a follow-up needs no key. 0 never opens it without a key.
   */
  windowSec: z.number().int().min(0).max(30),
  /**
   * Keep the microphone open while the voice is speaking, so speaking over it stops it. Needs
   * echo cancellation that holds up on this computer's speakers; off, a key stops it.
   */
  talkOver: z.boolean(),
  /** Most the line may spend in a day, in US dollars; 0 is no limit. */
  dailyUsd: z.number().min(0).max(1000),
  /** The model that writes the transcript of what the developer said. */
  transcriptionModel: z.string().min(1).max(80),
});
export type TalkSettings = z.infer<typeof talkSettingsSchema>;

export const DEFAULT_TALK_SETTINGS: TalkSettings = {
  enabled: false,
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  effort: 'low',
  listening: 'key',
  windowSec: 6,
  talkOver: false,
  dailyUsd: 5,
  transcriptionModel: 'gpt-transcribe',
};

export const talkTokensSchema = z.object({
  textIn: z.number().min(0),
  cachedTextIn: z.number().min(0),
  audioIn: z.number().min(0),
  cachedAudioIn: z.number().min(0),
  textOut: z.number().min(0),
  audioOut: z.number().min(0),
});

export const talkUsageSchema = z.object({
  /** The UTC day these counts belong to. */
  day: z.string(),
  usd: z.number(),
  responses: z.number(),
  sessions: z.number(),
  tokens: talkTokensSchema,
});
export type TalkUsage = z.infer<typeof talkUsageSchema>;

export const talkStatusSchema = z.object({
  settings: talkSettingsSchema,
  /** An OpenAI key is stored or set in the environment. */
  hasKey: z.boolean(),
  usageToday: talkUsageSchema,
  /** Today's spend has reached the daily limit. */
  overBudget: z.boolean(),
});
export type TalkStatus = z.infer<typeof talkStatusSchema>;

export const talkErrorSchema = z.object({
  type: z.enum([
    'disabled',
    'not-configured',
    'over-budget',
    'rejected-key',
    'rate-limited',
    'unreachable',
    'api-error',
  ]),
  message: z.string(),
});
export type TalkError = z.infer<typeof talkErrorSchema>;

/** A function the voice model may call, in the Realtime API's own shape. */
export const talkToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1).max(64),
  description: z.string().max(2_000),
  parameters: z.record(z.string(), z.unknown()),
});
export type TalkTool = z.infer<typeof talkToolSchema>;

/** Instructions plus tools are limited by the provider; this keeps a mistake from being sent. */
export const TALK_INSTRUCTIONS_MAX_CHARS = 32_000;
export const TALK_TOOLS_MAX = 64;

export const talkContract = defineContract({
  getStatus: procedure({ input: z.void(), output: talkStatusSchema }),
  updateSettings: procedure({ input: talkSettingsSchema.partial(), output: talkStatusSchema }),
  /**
   * Sets a session up: forwards the renderer's WebRTC offer to the provider with the stored key
   * and the session's instructions and tools, and returns the provider's answer.
   */
  openCall: fallible({
    input: z.object({
      sdp: z.string().min(1).max(200_000),
      instructions: z.string().min(1).max(TALK_INSTRUCTIONS_MAX_CHARS),
      tools: z.array(talkToolSchema).max(TALK_TOOLS_MAX),
    }),
    data: z.object({
      sdp: z.string(),
      model: z.string(),
      voice: z.string(),
    }),
    error: talkErrorSchema,
  }),
  /** Adds one response's tokens to today's count and says whether the line may go on. */
  recordUsage: procedure({
    input: z.object({ model: z.string().max(80), tokens: talkTokensSchema }),
    output: talkStatusSchema,
  }),
});
