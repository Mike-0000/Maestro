import { defineContract, eventStream, fallible, procedure, uploadFile } from '@emdash/wire/rpc';
import { z } from 'zod';
import { chorusCredentialIdSchema } from '@core/primitives/chorus-host/api/credentials';

export const voiceDomain = 'voice' as const;

export const sttEngineIds = ['openai', 'deepgram', 'whisper-local'] as const;
export const sttEngineIdSchema = z.enum(sttEngineIds);
export type SttEngineId = z.infer<typeof sttEngineIdSchema>;

export const voiceSettingsSchema = z.object({
  engine: sttEngineIdSchema,
  /** whisper.cpp `whisper-server` base URL for the local engine. */
  whisperUrl: z.string(),
  language: z.string(),
  /** Electron accelerator for the global toggle-to-talk shortcut; empty disables it. */
  globalShortcut: z.string(),
  speakReplies: z.boolean(),
  speakAttention: z.boolean(),
  ttsVoice: z.string(),
  /** Stream audio while speaking for live partial transcripts (Deepgram only). */
  streaming: z.boolean(),
  /** Listen continuously and start on speech; only acts after the wake phrase. */
  handsFree: z.boolean(),
  /** Phrase that must start a hands-free command ("Chorus, focus Claude 1"). */
  wakePhrase: z.string(),
  /** The first-run voice setup was completed or dismissed. */
  onboarded: z.boolean(),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  engine: 'openai',
  whisperUrl: 'http://127.0.0.1:8178',
  language: 'en',
  globalShortcut: 'Control+Alt+Space',
  speakReplies: true,
  speakAttention: true,
  ttsVoice: '',
  streaming: true,
  handsFree: false,
  wakePhrase: 'chorus',
  onboarded: false,
};

export const transcriptionSchema = z.object({
  text: z.string(),
  engine: sttEngineIdSchema,
  /** Server-side transcription latency. */
  latencyMs: z.number(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

export const voiceErrorSchema = z.object({
  type: z.enum(['not-configured', 'engine-failed', 'empty-audio', 'unreachable']),
  message: z.string(),
});
export type VoiceError = z.infer<typeof voiceErrorSchema>;

export const voiceStatusSchema = z.object({
  settings: voiceSettingsSchema,
  credentials: z.record(chorusCredentialIdSchema, z.boolean()),
  globalShortcutRegistered: z.boolean(),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const voiceEventSchema = z.discriminatedUnion('type', [
  /** The global toggle-to-talk shortcut fired (the app may be unfocused). */
  z.object({ type: z.literal('global-toggle') }),
  /** Live partial transcript of an open stream. */
  z.object({ type: z.literal('partial'), streamId: z.string(), text: z.string() }),
]);
export type VoiceEvent = z.infer<typeof voiceEventSchema>;

/** Largest accepted utterance: ~5 minutes of 16 kHz 16-bit mono WAV. */
export const MAX_UTTERANCE_BYTES = 10 * 1024 * 1024;

export const voiceContract = defineContract({
  transcribe: uploadFile({
    input: z.object({
      /** Vocabulary hints: agent names, branch names, project terms. */
      vocabulary: z.array(z.string()).max(200),
    }),
    accept: ['audio/wav'],
    maxSize: MAX_UTTERANCE_BYTES,
    result: transcriptionSchema,
    error: voiceErrorSchema,
  }),
  getStatus: procedure({ input: z.void(), output: voiceStatusSchema }),
  /**
   * Opens a live transcription stream when the engine supports one (Deepgram). `supported: false`
   * means the caller should upload the finished utterance instead.
   */
  openStream: procedure({
    input: z.object({ vocabulary: z.array(z.string()).max(200) }),
    output: z.object({ supported: z.boolean(), streamId: z.string().nullable() }),
  }),
  /** Appends base64 16 kHz PCM16 audio to an open stream. */
  pushAudio: procedure({
    input: z.object({ streamId: z.string(), pcm: z.string() }),
    output: z.void(),
  }),
  closeStream: fallible({
    input: z.object({ streamId: z.string() }),
    data: transcriptionSchema,
    error: voiceErrorSchema,
  }),
  abortStream: procedure({ input: z.object({ streamId: z.string() }), output: z.void() }),
  updateSettings: procedure({
    input: voiceSettingsSchema.partial(),
    output: voiceStatusSchema,
  }),
  setCredential: procedure({
    input: z.object({ id: chorusCredentialIdSchema, value: z.string().nullable() }),
    output: voiceStatusSchema,
  }),
  /** Opens the OS microphone privacy page (when Windows blocks desktop apps from the mic). */
  openMicrophoneSettings: procedure({ input: z.void(), output: z.void() }),
  events: eventStream({ key: z.void(), event: voiceEventSchema }),
});

export type VoiceContract = typeof voiceContract;
