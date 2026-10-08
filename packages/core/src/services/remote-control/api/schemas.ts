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
