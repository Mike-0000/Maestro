import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type ReactNode } from 'react';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { PaneDropZone } from './tab-bar/draggable-tab';

export const TabBar = observer(function TabBar({ trailingSlot }: { trailingSlot?: ReactNode }) {
  const { paneId, pane } = usePaneContext();

  const resolvedTabs = pane.resolvedTabs;

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = pane.activeTabId;
    if (!id || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector<HTMLElement>(
      `[data-tabid="${CSS.escape(id)}"]`
    );
    el?.scrollIntoView({ behavior: 'instant', inline: 'nearest', block: 'nearest' });
  }, [pane.activeTabId]);

  return (
    // Any click in the tab bar (select, close, pin, empty space) should return
    // DOM focus to the active content. Child handlers run first; the rAF in
    // focusActiveContent() defers the focus call until after they settle.
    // The inline rename input stops propagation, so it keeps focus while editing.
    // The strip sits on the sunken chrome surface, like the title bar above it and
    // the app sidebar, with no rule under it. The active tab is a rounded tab on the
    // content's own surface, so it runs straight into the content below; the other
    // tabs are text only.
    <div
      className="task-tab-bar surface-sunken flex h-[41px] shrink-0 bg-(--em-surface)"
      onClick={() => pane.focusActiveContent()}
    >
      <div
        ref={scrollContainerRef}
        className="flex h-full w-full items-end gap-0.5 overflow-x-auto overflow-y-hidden pl-1.5"
      >
        {resolvedTabs.map((tab) => {
          if (!pane.registry.has(tab.kind)) return null;
          const def = pane.registry.get(tab.kind);
          const TabItemComponent = def.TabBarItem;
          return <TabItemComponent key={tab.tabId} tab={tab} host={pane} ctx={pane.ctx} />;
        })}
        {trailingSlot && (
          // Level with the tabs, which hang from the bottom of the strip.
          <div className="sticky right-0 z-20 flex h-[33px] shrink-0 items-center bg-(--em-surface) px-1">
            {trailingSlot}
          </div>
        )}
        <PaneDropZone paneId={paneId} />
      </div>
    </div>
  );
});
