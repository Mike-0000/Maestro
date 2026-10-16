import { defineContract, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * The talk line: one realtime voice session between the developer and Maestro, on xAI's Grok
 * Voice. While it is open its model is the conductor: it hears the developer and acts through the
 * conductor's tools. The renderer owns the WebSocket (it has the microphone and the speaker); the
 * main process owns the API key, decides what the session is, and keeps count of what it costs.
 * The key never reaches the renderer: it gets a short-lived client secret that only opens one
 * connection, which is what xAI provides for browsers.
 */
export const talkDomain = 'talk' as const;

/** Grok Voice reasons (`high`, its default) or does not (`none`). */
export const talkEffortSchema = z.enum(['none', 'high']);

/**
 * When the line hears the developer. `key`: while the talk key is held, and for a moment after
 * Maestro speaks. `open`: all the time, with no key.
 */
export const talkListeningSchema = z.enum(['key', 'open']);

/**
 * How much the voice says. `brief`: a word or two for something done, one sentence for an
 * answer, nothing while it works. `normal`: a sentence or two, and a few words before a tool.
 */
export const talkRepliesSchema = z.enum(['brief', 'normal']);
export type TalkReplies = z.infer<typeof talkRepliesSchema>;

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
  replies: talkRepliesSchema,
  /**
   * A custom voice agent made in xAI's Voice Agent Builder (`agent_…`), or '' for none. With one,
   * the line connects to that agent instead of `model`, and the agent's own model and voice are
   * used. Maestro still sends its instructions, tools, turn-taking and audio format, which the
   * line needs to be the conductor. Any string is accepted here, because a value this schema
   * refused would reset every talk setting; `openSession` refuses one that is not an agent id.
   */
  agentId: z.string().max(100),
});
export type TalkSettings = z.infer<typeof talkSettingsSchema>;

export const DEFAULT_TALK_SETTINGS: TalkSettings = {
  enabled: false,
  // Pinned, as xAI advises for production; `grok-voice-latest` follows new releases.
  model: 'grok-voice-3.0',
  voice: 'eve',
  effort: 'high',
  listening: 'key',
  windowSec: 6,
  talkOver: false,
  dailyUsd: 5,
  transcriptionModel: 'grok-transcribe',
  replies: 'brief',
  agentId: '',
};

/** What an xAI voice agent id looks like: `agent_` and letters, digits, `_` or `-`. */
const TALK_AGENT_ID = /^agent_[A-Za-z0-9_-]{4,80}$/;

export function isTalkAgentId(value: string): boolean {
  return TALK_AGENT_ID.test(value);
}

/**
 * What the line runs on, as usage and traces name it: the custom agent when one is set, else the
 * model. Grok Voice costs the same per minute either way.
 */
export function talkLineModel(settings: Pick<TalkSettings, 'agentId' | 'model'>): string {
  const agent = settings.agentId.trim();
  return agent ? agent : settings.model;
}

/** The built-in Grok voices; a cloned voice's id works too. */
export const TALK_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'] as const;

/**
 * Settings saved for the OpenAI Realtime line name a model, voice and transcription model xAI
 * does not have, and efforts it does not take. They are moved to Grok Voice's; everything else
 * the developer chose is kept. Anything that is not a settings object is left to the schema.
 */
export function migrateTalkSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const settings = { ...(raw as Record<string, unknown>) };
  const model = settings.model;
  if (typeof model !== 'string' || !model.startsWith('grok-voice')) {
    settings.model = DEFAULT_TALK_SETTINGS.model;
    settings.voice = DEFAULT_TALK_SETTINGS.voice;
  }
  if (settings.transcriptionModel !== DEFAULT_TALK_SETTINGS.transcriptionModel) {
    settings.transcriptionModel = DEFAULT_TALK_SETTINGS.transcriptionModel;
  }
  const effort = settings.effort;
  if (effort === 'minimal' || effort === 'low') settings.effort = 'none';
  else if (effort === 'medium') settings.effort = 'high';
  return settings;
}

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
  /** Seconds a session was open: Grok Voice bills by the minute. Absent from older files. */
  seconds: z.number().min(0).default(0),
  tokens: talkTokensSchema,
});
export type TalkUsage = z.infer<typeof talkUsageSchema>;

export const talkStatusSchema = z.object({
  settings: talkSettingsSchema,
  /** An xAI key is stored or set in the environment. */
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
    'invalid-agent',
    'over-budget',
    'rejected-key',
    'rate-limited',
    'unreachable',
    'api-error',
  ]),
  message: z.string(),
});
export type TalkError = z.infer<typeof talkErrorSchema>;

/** A function the voice model may call, in the Realtime API's own shape, which xAI shares. */
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
   * Sets a session up: mints a short-lived client secret with the stored key, and returns it with
   * where to connect and the session the renderer must configure, built here from the settings
   * and the given instructions and tools.
   */
  openSession: fallible({
    input: z.object({
      instructions: z.string().min(1).max(TALK_INSTRUCTIONS_MAX_CHARS),
      tools: z.array(talkToolSchema).max(TALK_TOOLS_MAX),
    }),
    data: z.object({
      url: z.string(),
      /** Opens one connection, and expires at `expiresAt` (Unix seconds). */
      clientSecret: z.string(),
      expiresAt: z.number(),
      /** The body of the first `session.update`. */
      session: z.record(z.string(), z.unknown()),
      model: z.string(),
      voice: z.string(),
    }),
    error: talkErrorSchema,
  }),
  /**
   * Adds what the line used since it last reported (a response's tokens, the seconds it was
   * open, the text it sent) to today's count, and says whether the line may go on.
   */
  recordUsage: procedure({
    input: z.object({
      model: z.string().max(80),
      tokens: talkTokensSchema,
      seconds: z.number().min(0).max(86_400).optional(),
      textInputs: z.number().int().min(0).max(100_000).optional(),
    }),
    output: talkStatusSchema,
  }),
});
