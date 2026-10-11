import { createController, type Controller } from '@emdash/wire/rpc';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import { markdownViewerContract } from '../api/contract';
import { MarkdownAccess } from './markdown-access';
import { markdownShowEvents, markdownShowHub } from './show-markdown-hub';

export function createMarkdownViewerWireController(options: {
  workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve' | 'resolveProject'>;
}): Controller {
  const access = new MarkdownAccess(options.workspaceIdentity);
  return createController(markdownViewerContract, {
    resolve: (input) => access.resolveDocument(input),
    read: (input) => access.readDocument(input),
    readImage: (input) => access.readImage(input),
    showRequests: markdownShowEvents,
    acknowledgeShowRequest: ({ id, ack }) => ({
      delivered: markdownShowHub.acknowledge(id, ack),
    }),
  });
}
