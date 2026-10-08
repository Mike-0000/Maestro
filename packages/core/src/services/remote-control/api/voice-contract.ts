import {
  defineContract,
  eventStream,
  fallible,
  liveModel,
  liveState,
  uploadFile,
} from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  REMOTE_MAX_UTTERANCE_BYTES,
  remoteControlErrorSchema,
  remoteTranscriptionSchema,
  remoteVoiceEventSchema,
  remoteVoiceStateSchema,
} from './schemas';

/**
 * Voice control from a paired device. The conductor runs in the host's window; a device is its
 * remote microphone, speaker, and heads-up display. Nothing here bypasses the conductor's own
 * countdowns and confirmations.
 */
export const remoteVoiceContract = defineContract({
  /** The conductor's heads-up display: what it heard, what it is doing, and what it said. */
  state: liveModel({
    key: z.void().optional(),
    states: {
      hud: liveState({ data: remoteVoiceStateSchema }),
    },
  }),

  /** Transcribes one finished recording with the host's speech-to-text engine. */
  transcribe: uploadFile({
    input: z.object({}),
    accept: ['audio/wav'],
    maxSize: REMOTE_MAX_UTTERANCE_BYTES,
    result: remoteTranscriptionSchema,
    error: remoteControlErrorSchema,
  }),

  /**
   * Opens a live transcription stream when the host's engine supports one. A null `streamId`
   * means the device should record and upload with `transcribe` instead.
   */
  openStream: fallible({
    input: z.object({}),
    data: z.object({ streamId: z.string().nullable() }),
    error: remoteControlErrorSchema,
  }),
  /** Appends base64 16 kHz PCM16 audio to an open stream. */
  pushAudio: fallible({
    input: z.object({ streamId: z.string(), pcm: z.string().max(2_000_000) }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),
  closeStream: fallible({
    input: z.object({ streamId: z.string() }),
    data: remoteTranscriptionSchema,
    error: remoteControlErrorSchema,
  }),
  abortStream: fallible({
    input: z.object({ streamId: z.string() }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /** Hands the conductor a command, spoken or typed. Its answer arrives through `state`. */
  say: fallible({
    input: z.object({ text: z.string().min(1).max(20_000) }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /** Answers what the conductor is waiting on: a countdown, a confirmation, or a plan. */
  respond: fallible({
    input: z.object({ decision: z.enum(['yes', 'no']) }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /** Synthesizes a reply on the host; audio arrives on `events`. Only when `speech` is `host`. */
  speak: fallible({
    input: z.object({ requestId: z.string().uuid(), text: z.string().min(1).max(1200) }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),
  stopSpeaking: fallible({
    input: z.object({ requestId: z.string().uuid() }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /** Partial transcripts and synthesized audio for streams and requests opened by devices. */
  events: eventStream({ key: z.void(), event: remoteVoiceEventSchema }),
});

export type RemoteVoiceContract = typeof remoteVoiceContract;
