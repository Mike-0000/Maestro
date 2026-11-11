import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { PanelLeft } from 'lucide-react';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { NavButtons } from './nav-buttons';

/**
 * Shown in the title bar while the sidebar is closed: the same three glyphs the sidebar's own
 * strip carries (show sidebar, back, forward), so closing the sidebar never strands them.
 */
export function SidebarRecoveryControls({ onShowSidebar }: { onShowSidebar: () => void }) {
  return (
    <div className="ml-2 flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Show left sidebar"
              onClick={onShowSidebar}
            />
          }
        >
          <PanelLeft className="size-4" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          Show left sidebar
          <BoundShortcut command="workbench.toggleLeftSidebar" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
      <NavButtons />
    </div>
  );
}
