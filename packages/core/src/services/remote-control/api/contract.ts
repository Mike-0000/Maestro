import { defineContract, fallible, liveLog, liveModel, liveState } from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  remoteAdoptConversationInputSchema,
  remoteControlErrorSchema,
  remoteOpenAgentResultSchema,
  remoteOverviewSchema,
  remoteStartAgentInputSchema,
  remoteTerminalSizeSchema,
} from './schemas';

const conversation = z.object({ conversationId: z.string() });

/**
 * What a Maestro app offers to its paired devices beyond the workspace runtimes: the host's own
 * view of its projects, tasks and agents, and the few verbs needed to steer an agent from a
 * phone. Everything here acts on the host's own database, so an agent started or adopted
 * through it is an ordinary task in the host's window.
 */
export const remoteControlContract = defineContract({
  /** Every project and agent on the host, kept current. */
  overview: liveModel({
    key: z.void().optional(),
    states: {
      snapshot: liveState({ data: remoteOverviewSchema }),
    },
  }),

  /** Creates a task with one agent in the project directory and starts it with the prompt. */
  startAgent: fallible({
    input: remoteStartAgentInputSchema,
    data: z.object({ taskId: z.string(), conversationId: z.string() }),
    error: remoteControlErrorSchema,
  }),

  /**
   * Makes sure the agent's session is live on the host (starting or resuming it if it is not)
   * so its output can be followed. `size` is used only when the session has to be started.
   */
  openAgent: fallible({
    input: conversation.extend({ size: remoteTerminalSizeSchema.optional() }),
    data: remoteOpenAgentResultSchema,
    error: remoteControlErrorSchema,
  }),

  /** A terminal agent's output, replayed from the host's retained log and then followed live. */
  output: liveLog({ key: conversation }),

  /** Writes raw bytes to a terminal agent's input. */
  sendInput: fallible({
    input: conversation.extend({ data: z.string().max(1_000_000) }),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /** Resizes a terminal agent for every viewer, including the host's own window. */
  resize: fallible({
    input: conversation.extend(remoteTerminalSizeSchema.shape),
    data: z.void(),
    error: remoteControlErrorSchema,
  }),

  /**
   * Gives a conversation another Maestro started on this host a task in the host's own project,
   * so it shows up in the host's window like one started there. Idempotent per conversation.
   */
  adoptConversation: fallible({
    input: remoteAdoptConversationInputSchema,
    data: z.object({ taskId: z.string(), projectId: z.string() }),
    error: remoteControlErrorSchema,
  }),
});

export type RemoteControlContract = typeof remoteControlContract;

/** Mount point of {@link remoteControlContract} on a Maestro host's device endpoint. */
export const remoteDeviceWireContract = defineContract({ remote: remoteControlContract });

export type RemoteDeviceWireContract = typeof remoteDeviceWireContract;
