import { BookOpenText } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type {
  ResolvedTab,
  TabBarItemProps,
  TabContentProps,
  TabEntry,
  TabProvider,
  TabResource,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import { createTabProvider } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@core/primitives/workbench-shell/browser/tabs/tab-bar/generic-tab-item';
import type { MarkdownDoc } from '../api/contract';
import { MarkdownDocView } from '../contributions/browser/markdown-doc-view';

/** A Markdown viewer tab holds nothing live of its own: the view reads and watches the file. */
class MarkdownTabResource implements TabResource {
  constructor(readonly doc: MarkdownDoc) {}

  dispose(): void {}
}

const MarkdownTabBarItem = observer(function MarkdownTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<MarkdownTabResource>) {
  const { doc } = tab.resource;
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={doc.title}
      tooltip={doc.path}
      preSlot={<BookOpenText className="size-3 shrink-0 text-foreground-muted" />}
    />
  );
});

function MarkdownTabBarItemDragPreview({ tab }: { tab: ResolvedTab<MarkdownTabResource> }) {
  return (
    <GenericTabDragPreview
      preSlot={<BookOpenText className="size-3 shrink-0 text-foreground-muted" />}
      label={tab.resource.doc.title}
    />
  );
}

const MarkdownTabContent = observer(function MarkdownTabContent({ host }: TabContentProps) {
  const active = host.resolvedTabs.find((tab) => tab.isActive);
  if (active?.kind !== 'markdown') return null;
  const { doc } = active.resource as MarkdownTabResource;
  return <MarkdownDocView key={`${doc.workspaceId}:${doc.path}`} doc={doc} />;
});

/**
 * The read-only Markdown viewer as a task-view tab. Its state names the workspace the file was
 * checked against, which may belong to another task: an agent's file opens beside whichever task
 * the developer is looking at.
 */
export const markdownTabProvider: TabProvider<
  'markdown',
  MarkdownDoc,
  MarkdownTabResource,
  MarkdownDoc
> = createTabProvider({
  kind: 'markdown',
  mount: 'single',
  resourceKey: (state: MarkdownDoc) => `${state.workspaceId}:${state.path}`,

  initialize(entry: TabEntry<MarkdownDoc>): MarkdownTabResource {
    return new MarkdownTabResource(entry.state);
  },

  dispose(_entry: TabEntry<MarkdownDoc>, resource: MarkdownTabResource): void {
    resource.dispose();
  },

  TabBarItem: MarkdownTabBarItem,
  TabBarItemDragPreview: MarkdownTabBarItemDragPreview,
  TabContent: MarkdownTabContent,
});
