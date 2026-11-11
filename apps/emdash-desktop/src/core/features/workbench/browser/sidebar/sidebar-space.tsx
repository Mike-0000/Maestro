import { Toggle, Tooltip } from '@emdash/ui/react/primitives';
import { PanelLeft } from 'lucide-react';
import { NavButtons } from '@core/features/workbench/browser/nav-buttons';
import { useWorkspaceLayoutContext } from '@core/features/workbench/contributions/browser/layout-provider';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';

export function SidebarSpace() {
  const { isLeftOpen, toggleLeftSidebar } = useWorkspaceLayoutContext();
  return (
    // The window's drag strip above the sidebar, level with the title bar beside it.
    <div className="flex h-10 w-full shrink-0 items-center justify-end gap-0.5 px-2 [-webkit-app-region:drag]">
      <NavButtons />
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Toggle
              // Open is the only state this button is seen in, so it shows no pressed fill: it
              // reads like the nav arrows beside it, a passive glyph that lifts on hover.
              className="bg-transparent text-foreground-passive [-webkit-app-region:no-drag] hover:bg-surface-hover hover:text-foreground"
              size="sm"
              icon
              pressed={isLeftOpen}
              onPressedChange={() => toggleLeftSidebar()}
            />
          }
        >
          <PanelLeft className="size-4" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          Toggle left sidebar
          <BoundShortcut command="workbench.toggleLeftSidebar" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
}
