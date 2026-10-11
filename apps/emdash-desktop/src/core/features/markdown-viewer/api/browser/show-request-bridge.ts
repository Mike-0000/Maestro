import { toast } from '@emdash/ui/react/primitives';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { log } from '@core/primitives/logging/browser/logger';
import type { MarkdownShowAck, MarkdownShowRequest } from '../contract';
import { placementMessage } from '../placement';
import { getMarkdownViewerClient, type MarkdownViewerClient } from './client';
import { openMarkdownDoc } from './open-markdown-doc';

/** How long an offered file stays on screen as a toast. */
const OFFER_TOAST_MS = 30_000;

/**
 * Brings agents' `show_markdown` calls from the main process to this window. A file the agent
 * presents is opened at once; any other is offered as a toast the developer can open. Either way
 * the agent's tool call is told what happened, and "opened" only once the window is showing.
 */
export class MarkdownShowBridge {
  private disposed = false;
  private unsubscribe: (() => void) | undefined;

  start(): void {
    void getMarkdownViewerClient()
      .then(async (client) => {
        const stop = await client.showRequests.subscribe(undefined, {
          onEvent: (request) => void this.receive(client, request),
        });
        if (this.disposed) stop();
        else this.unsubscribe = stop;
      })
      .catch((error: unknown) =>
        log.warn('markdown viewer: subscribing to show requests failed', { error })
      );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async receive(client: MarkdownViewerClient, request: MarkdownShowRequest): Promise<void> {
    try {
      const ack = await handleShowRequest(request);
      await client.acknowledgeShowRequest({ id: request.id, ack });
    } catch (error: unknown) {
      log.warn('markdown viewer: show request failed', { error, id: request.id });
    }
  }
}

/** Opens or offers the file, and returns what the agent is told. */
export async function handleShowRequest(request: MarkdownShowRequest): Promise<MarkdownShowAck> {
  const { doc, conversationId } = request;
  try {
    if (request.present) return await present(request);
    toast(`${getCanvasStore().spokenName(conversationId)} has a file for you`, {
      id: `markdown-offer:${doc.workspaceId}:${doc.path}`,
      description: doc.title,
      duration: OFFER_TOAST_MS,
      action: {
        label: 'Open',
        onClick: () => {
          void present(request).then((ack) => {
            if (ack.outcome === 'failed') toast.error(`Could not open ${doc.title}`);
          });
        },
      },
    });
    return {
      outcome: 'offered',
      message: `${doc.title} is offered to the developer in Maestro; they have not opened it. Call again with present: true only if they asked to see it now.`,
    };
  } catch (error: unknown) {
    log.warn('markdown viewer: showing a file failed', { error, id: request.id });
    return { outcome: 'failed', message: `Maestro could not open ${doc.title}.` };
  }
}

async function present(request: MarkdownShowRequest): Promise<MarkdownShowAck> {
  const { doc, conversationId } = request;
  const result = await openMarkdownDoc(doc, { conversationId });
  return result.opened
    ? { outcome: 'opened', message: placementMessage(doc.title, result.placement) }
    : {
        outcome: 'failed',
        message: `Maestro could not bring ${doc.title} on screen. The developer can still open it from its path in your output.`,
      };
}
