import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import type { HistoryEntry } from '@core/primitives/navigation/api';
import {
  getNavigation,
  getNavigationHistory,
} from '@core/primitives/navigation/browser/navigation-selectors';

export function applyHistoryEntry(entry: HistoryEntry): boolean {
  return getNavigation().applyEntry(entry);
}

/**
 * Back and forward through the view history: two passive ghost glyphs on the chrome that come
 * to full strength on hover (the kit's icon-button face). A direction with no history is
 * disabled and dims.
 */
export const NavButtons = observer(function NavButtons() {
  const { canGoBack, canGoForward } = getNavigationHistory();
  return (
    <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Go back"
              disabled={!canGoBack}
              onClick={() => getNavigationHistory().back(applyHistoryEntry)}
            />
          }
        >
          <ArrowLeft className="size-4" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          Go back
          <BoundShortcut command="app.navigateBack" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Go forward"
              disabled={!canGoForward}
              onClick={() => getNavigationHistory().forward(applyHistoryEntry)}
            />
          }
        >
          <ArrowRight className="size-4" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          Go forward
          <BoundShortcut command="app.navigateForward" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
});
