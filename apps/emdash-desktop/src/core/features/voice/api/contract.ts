import { defineContract, eventStream, fallible, procedure, uploadFile } from '@emdash/wire/rpc';
import { z } from 'zod';
import { chorusCredentialIdSchema } from '@core/primitives/chorus-host/api/credentials';

export const voiceDomain = 'voice' as const;

export const sttEngineIds = ['openai', 'deepgram', 'whisper-local', 'openrouter'] as const;
export const sttEngineIdSchema = z.enum(sttEngineIds);
export type SttEngineId = z.infer<typeof sttEngineIdSchema>;

export const voiceSettingsSchema = z.object({
  engine: sttEngineIdSchema,
  /** whisper.cpp `whisper-server` base URL for the local engine. */
  whisperUrl: z.string(),
  /** Audio-input model used for speech-to-text when the engine is openrouter. */
  openrouterSttModel: z.string(),
  language: z.string(),
  /** Electron accelerator for the global toggle-to-talk shortcut; empty disables it. */
  globalShortcut: z.string(),
  /**
   * Key or chord to hold for push-to-talk anywhere in Windows (not just when Chorus is focused):
   * `off`, or `KeyboardEvent.code` values joined with `+` (see `global-keys.ts`).
   */
  globalHoldKey: z.string(),
  speakReplies: z.boolean(),
  speakAttention: z.boolean(),
  ttsVoice: z.string(),
  /** Spoken output is independent of the speech-to-text engine. */
  ttsEngine: z.enum([
    'platform',
    'kitten',
    'gemini-flash',
    'gemini-flash-lite',
    'openrouter-gemini-flash',
    'openrouter-gemini-flash-lite',
  ]),
  /** Kitten TTS Mini 0.8 English voice (runs entirely on the CPU). */
  localVoice: z.enum(['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo']),
  geminiVoice: z.enum(['Kore', 'Puck', 'Aoede', 'Zephyr']),
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
  openrouterSttModel: 'google/gemini-3.5-flash-lite',
  language: 'en',
  globalShortcut: 'Control+Alt+Space',
  globalHoldKey: 'off',
  speakReplies: true,
  speakAttention: true,
  ttsVoice: '',
  ttsEngine: 'platform',
  localVoice: 'Bella',
  geminiVoice: 'Kore',
  streaming: true,
  handsFree: false,
  wakePhrase: 'maestro',
  onboarded: false,
};

export const transcriptionSchema = z.object({
  text: z.string(),
  engine: sttEngineIdSchema,
  /** Server-side transcription latency. */
  latencyMs: z.number(),
  /** Confidence of the chosen STT alternative, only when supplied by the provider. */
  confidence: z.number().min(0).max(1).optional(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

export const voiceErrorSchema = z.object({
  type: z.enum(['not-configured', 'engine-failed', 'empty-audio', 'unreachable']),
  message: z.string(),
});
export type VoiceError = z.infer<typeof voiceErrorSchema>;

/** The on-device dictation model (NVIDIA Parakeet), fetched once on first use. */
export const dictationModelStatusSchema = z.object({
  state: z.enum(['missing', 'downloading', 'ready', 'failed']),
  receivedBytes: z.number(),
  totalBytes: z.number(),
  /** Why the last download failed. */
  message: z.string().optional(),
});
export type DictationModelStatus = z.infer<typeof dictationModelStatusSchema>;

export const dictationResultSchema = z.object({
  text: z.string(),
  /** From the end of the audio to the final text. */
  latencyMs: z.number(),
});
export type DictationResult = z.infer<typeof dictationResultSchema>;

export const voiceStatusSchema = z.object({
  settings: voiceSettingsSchema,
  credentials: z.record(chorusCredentialIdSchema, z.boolean()),
  globalShortcutRegistered: z.boolean(),
  /** The system-wide hold-to-talk hook is running. */
  globalHoldActive: z.boolean(),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const voiceEventSchema = z.discriminatedUnion('type', [
  /** The global toggle-to-talk shortcut fired (the app may be unfocused). */
  z.object({ type: z.literal('global-toggle') }),
  /** Global hold-to-talk (the key was held or released while any app was focused). */
  z.object({
    type: z.literal('global-hold'),
    /** `tap`: a single quick press. It answers a waiting call, or starts or sends dictation. */
    action: z.enum(['start', 'stop', 'cancel', 'tap']),
    intent: z.enum(['command', 'dictation']).optional(),
  }),
  /** Live partial transcript of an open stream. */
  z.object({
    type: z.literal('partial'),
    streamId: z.string(),
    text: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  /**
   * Mono signed 16-bit little-endian PCM from Gemini, OpenRouter, or the local Kitten model;
   * 24 kHz unless `sampleRate` says otherwise.
   */
  z.object({
    type: z.literal('tts-chunk'),
    requestId: z.string(),
    pcm: z.string(),
    sampleRate: z.number().int().min(8000).max(48_000).optional(),
  }),
  /** Download progress of the on-device dictation model. */
  z.object({ type: z.literal('dictation-model'), status: dictationModelStatusSchema }),
  z.object({ type: z.literal('tts-done'), requestId: z.string() }),
  z.object({ type: z.literal('tts-error'), requestId: z.string() }),
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
  getDictationModel: procedure({ input: z.void(), output: dictationModelStatusSchema }),
  /** Starts the one-time model download; progress arrives as `dictation-model` events. */
  downloadDictationModel: procedure({ input: z.void(), output: dictationModelStatusSchema }),
  /**
   * Opens an on-device dictation stream. Audio goes in through `pushAudio`, the text so far comes
   * back as `partial` events, and `abortStream` drops it.
   */
  openDictation: fallible({
    input: z.void(),
    data: z.object({ streamId: z.string() }),
    error: voiceErrorSchema,
  }),
  closeDictation: fallible({
    input: z.object({ streamId: z.string() }),
    data: dictationResultSchema,
    error: voiceErrorSchema,
  }),
  /** Starts abortable cloud or offline synthesis; audio is delivered on events. */
  startTts: procedure({
    input: z.object({ requestId: z.string().uuid(), text: z.string().min(1).max(1200) }),
    output: z.void(),
  }),
  stopTts: procedure({ input: z.object({ requestId: z.string().uuid() }), output: z.void() }),
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
