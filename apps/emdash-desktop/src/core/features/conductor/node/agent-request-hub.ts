import { randomBytes } from 'node:crypto';
import { createEventStreamHost } from '@emdash/wire/live';
import {
  parseAgentRequestArguments,
  validateAgentRequest,
  type AgentRequest,
  type AgentRequestAck,
} from '../api/agent-requests';
import { conductorContract } from '../api/contract';

export const agentRequestEvents = createEventStreamHost(conductorContract.agentRequests);

/** How long an agent's tool call waits for the window's conductor to accept or refuse. */
const ACK_TIMEOUT_MS = 8_000;

const NOT_PICKED_UP: AgentRequestAck = {
  accepted: false,
  message:
    'The conductor did not pick the request up, so nothing was done. The Maestro window may be closed or still starting; try again in a moment.',
};

/**
 * Takes a request from an agent's MCP tool call to the conductor in the window and brings the
 * conductor's verdict back as the tool result. The sender is whatever the caller authenticated
 * (the session token's scope), never a value from the request itself. The event stream does not
 * buffer, so a request no window acknowledges is refused after a short wait instead of being
 * reported as sent.
 */
export class AgentRequestHub {
  private readonly waiting = new Map<string, (ack: AgentRequestAck) => void>();

  constructor(
    private readonly emit: (request: AgentRequest) => void,
    private readonly ackTimeoutMs = ACK_TIMEOUT_MS
  ) {}

  async submit(
    from: AgentRequest['from'],
    args: Record<string, unknown>
  ): Promise<AgentRequestAck> {
    const parsed = parseAgentRequestArguments(args);
    if (!parsed.ok) return { accepted: false, message: parsed.error };
    const request: AgentRequest = {
      id: `r-${randomBytes(3).toString('hex')}`,
      at: new Date().toISOString(),
      from: { conversationId: from.conversationId, taskId: from.taskId, projectId: from.projectId },
      kind: parsed.kind,
      payload: parsed.payload,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
    // A payload the kind's schema rejects never needs the window.
    const valid = validateAgentRequest(request);
    if (!valid.ok) return { accepted: false, message: valid.error };
    return new Promise<AgentRequestAck>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(request.id);
        resolve(NOT_PICKED_UP);
      }, this.ackTimeoutMs);
      this.waiting.set(request.id, (ack) => {
        clearTimeout(timer);
        this.waiting.delete(request.id);
        resolve(ack);
      });
      this.emit(request);
    });
  }

  /**
   * The window's verdict. False when the tool call already gave up waiting: the window must then
   * drop the request, because the agent was told nothing happened.
   */
  acknowledge(id: string, ack: AgentRequestAck): boolean {
    const resolve = this.waiting.get(id);
    if (!resolve) return false;
    resolve(ack);
    return true;
  }
}

export const agentRequestHub = new AgentRequestHub((request) =>
  agentRequestEvents.emit(undefined, request)
);
