import { randomBytes } from 'node:crypto';
import { createEventStreamHost } from '@emdash/wire/live';
import {
  markdownViewerContract,
  type MarkdownShowAck,
  type MarkdownShowRequest,
} from '../api/contract';

export const markdownShowEvents = createEventStreamHost(markdownViewerContract.showRequests);

/** How long an agent's tool call waits for the window to say what it did with the file. */
const ACK_TIMEOUT_MS = 8_000;

const NOT_PICKED_UP: MarkdownShowAck = {
  outcome: 'failed',
  message:
    'Maestro did not pick the file up, so nothing was shown. The window may be closed or still starting; try again in a moment.',
};

/**
 * Takes a checked file from an agent's `show_markdown` call to the window and brings back what
 * the window did with it, as the tool result. The event stream does not buffer, so a request no
 * window acknowledges is reported as not shown after a short wait.
 */
export class MarkdownShowHub {
  private readonly waiting = new Map<string, (ack: MarkdownShowAck) => void>();

  constructor(
    private readonly emit: (request: MarkdownShowRequest) => void,
    private readonly ackTimeoutMs = ACK_TIMEOUT_MS
  ) {}

  show(input: Omit<MarkdownShowRequest, 'id' | 'at'>): Promise<MarkdownShowAck> {
    const request: MarkdownShowRequest = {
      ...input,
      id: `m-${randomBytes(3).toString('hex')}`,
      at: new Date().toISOString(),
    };
    return new Promise<MarkdownShowAck>((resolve) => {
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
   * What the window did. False when the tool call already gave up waiting: the agent was told
   * nothing was shown.
   */
  acknowledge(id: string, ack: MarkdownShowAck): boolean {
    const resolve = this.waiting.get(id);
    if (!resolve) return false;
    resolve(ack);
    return true;
  }
}

export const markdownShowHub = new MarkdownShowHub((request) =>
  markdownShowEvents.emit(undefined, request)
);
