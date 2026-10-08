import { z } from 'zod';

/** What an agent is doing, as far as its host can tell. */
export const remoteAgentStatusSchema = z.enum([
  'idle',
  'working',
  'awaiting-input',
  'error',
  'completed',
  'unknown',
]);
export type RemoteAgentStatus = z.infer<typeof remoteAgentStatusSchema>;

export const remoteProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  /** False for projects that live on another machine reached from this host. */
  local: z.boolean(),
});
export type RemoteProject = z.infer<typeof remoteProjectSchema>;

/** One agent conversation on the host, flattened with the task and project it belongs to. */
export const remoteAgentSchema = z.object({
  conversationId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  taskName: z.string(),
  title: z.string(),
  providerId: z.string(),
  /** `terminal` agents are driven through their terminal; `chat` agents through structured turns. */
  kind: z.enum(['terminal', 'chat']),
  status: remoteAgentStatusSchema,
  /** The agent's process is alive on the host right now. */
  running: z.boolean(),
  /** The agent is blocked on a person: a permission prompt, a question, or an idle prompt. */
  needsAttention: z.boolean(),
  /** What the agent is asking for, when it needs attention. */
  message: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  /** Unix ms of the last activity the host observed, or null when it has seen none. */
  lastActivityAt: z.number().nullable(),
  archived: z.boolean(),
});
export type RemoteAgent = z.infer<typeof remoteAgentSchema>;

export const remoteProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type RemoteProvider = z.infer<typeof remoteProviderSchema>;

export const remoteOverviewSchema = z.object({
  host: z.object({
    id: z.string(),
    name: z.string(),
    appVersion: z.string(),
  }),
  projects: z.array(remoteProjectSchema),
  agents: z.array(remoteAgentSchema),
  providers: z.array(remoteProviderSchema),
  defaultProviderId: z.string().nullable(),
});
export type RemoteOverview = z.infer<typeof remoteOverviewSchema>;

export const remoteControlErrorSchema = z.object({
  type: z.enum(['not-found', 'unavailable', 'unsupported', 'failed']),
  message: z.string(),
});
export type RemoteControlError = z.infer<typeof remoteControlErrorSchema>;

export const remoteTerminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(1000),
});
export type RemoteTerminalSize = z.infer<typeof remoteTerminalSizeSchema>;

export const remoteStartAgentInputSchema = z.object({
  projectId: z.string(),
  prompt: z.string().max(100_000),
  /** Task name; derived from the prompt when absent. */
  name: z.string().max(200).optional(),
  providerId: z.string().optional(),
});
export type RemoteStartAgentInput = z.infer<typeof remoteStartAgentInputSchema>;

export const remoteOpenAgentResultSchema = z.object({
  kind: z.enum(['terminal', 'chat']),
  running: z.boolean(),
  /** The terminal's current size on the host; a viewer renders at this size unless it resizes. */
  size: remoteTerminalSizeSchema.nullable(),
});
export type RemoteOpenAgentResult = z.infer<typeof remoteOpenAgentResultSchema>;

export const remoteAdoptConversationInputSchema = z.object({
  conversationId: z.string(),
  taskName: z.string().min(1).max(200),
  /** Host path of the workspace the conversation runs in. */
  workspacePath: z.string().min(1),
});
export type RemoteAdoptConversationInput = z.infer<typeof remoteAdoptConversationInputSchema>;

/** A side effect the conductor is holding for a moment, or until it is confirmed. */
export const remoteVoicePendingSchema = z.object({
  id: z.number(),
  label: z.string(),
  /** `countdown` runs unless cancelled; `confirm` runs only when confirmed. */
  kind: z.enum(['countdown', 'confirm']),
  startedAt: z.number(),
  durationMs: z.number(),
});
export type RemoteVoicePending = z.infer<typeof remoteVoicePendingSchema>;

export const remoteVoicePlanSchema = z.object({
  goal: z.string(),
  status: z.enum(['proposed', 'running', 'done', 'cancelled']),
  subtasks: z.array(z.object({ name: z.string(), detail: z.string() })),
});
export type RemoteVoicePlan = z.infer<typeof remoteVoicePlanSchema>;

/** The host conductor's heads-up display, as a remote device shows it. */
export const remoteVoiceStateSchema = z.object({
  /** False until the host's window has reported in; nothing can be said before that. */
  available: z.boolean(),
  /** Speech-to-text is set up on the host, so recordings can be transcribed. */
  transcriptionReady: z.boolean(),
  phase: z.enum(['idle', 'thinking', 'acting']),
  activity: z.string(),
  lastUtterance: z.string(),
  reply: z.string(),
  /** Unix ms of the reply, so a repeated reply still counts as new. */
  replyAt: z.number(),
  error: z.string().nullable(),
  pending: remoteVoicePendingSchema.nullable(),
  plan: remoteVoicePlanSchema.nullable(),
  /** Spoken names of the host's agents, for display and as examples. */
  agentNames: z.array(z.string()),
  /**
   * How replies are voiced: `host` means the host synthesizes audio for `speak`; `device` means
   * the device should use its own speech synthesis.
   */
  speech: z.enum(['host', 'device']),
});
export type RemoteVoiceState = z.infer<typeof remoteVoiceStateSchema>;

export const remoteTranscriptionSchema = z.object({
  text: z.string(),
  latencyMs: z.number(),
});
export type RemoteTranscription = z.infer<typeof remoteTranscriptionSchema>;

export const remoteVoiceEventSchema = z.discriminatedUnion('type', [
  /** Live partial transcript of an open stream. */
  z.object({ type: z.literal('partial'), streamId: z.string(), text: z.string() }),
  /** Base64 mono signed 16-bit little-endian PCM of a `speak` request. */
  z.object({
    type: z.literal('speech-chunk'),
    requestId: z.string(),
    pcm: z.string(),
    sampleRate: z.number().int(),
  }),
  z.object({ type: z.literal('speech-done'), requestId: z.string() }),
  z.object({ type: z.literal('speech-error'), requestId: z.string() }),
]);
export type RemoteVoiceEvent = z.infer<typeof remoteVoiceEventSchema>;

/** Largest accepted recording: about five minutes of 16 kHz 16-bit mono WAV. */
export const REMOTE_MAX_UTTERANCE_BYTES = 10 * 1024 * 1024;
