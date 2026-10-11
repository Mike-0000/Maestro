import {
  contributeScopedStore,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { seedMarkdownLinkOpener } from '../../api/browser/markdown-link-seam';
import { openAgentMarkdownLink } from '../../api/browser/open-markdown-doc';
import { MarkdownShowBridge } from '../../api/browser/show-request-bridge';

const markdownShowBridgeToken = scopedStoreToken<MarkdownShowBridge>('markdownViewer.showBridge');

// The bridge reaches the canvas and navigation stores when a request arrives; register after both.
export const markdownViewerAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: markdownShowBridgeToken,
    create: () => {
      // Markdown links in agents' terminals and chats open in the viewer from here on.
      seedMarkdownLinkOpener(openAgentMarkdownLink);
      const bridge = new MarkdownShowBridge();
      bridge.start();
      return bridge;
    },
    dispose: (bridge) => {
      seedMarkdownLinkOpener(undefined);
      bridge.dispose();
    },
  }),
];
