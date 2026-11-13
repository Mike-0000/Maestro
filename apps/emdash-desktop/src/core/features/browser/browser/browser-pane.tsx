import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
import { taskBrowserControl } from '@core/features/browser/api/browser/task-browser-control';
import { BrowserSurface } from '@core/features/browser/contributions/browser/browser-surface';
import { usePreviewServers } from '@core/features/workbench/api/browser/task-composition-context';
import {
  cycleNextTabCommand,
  cyclePreviousTabCommand,
} from '@core/features/workbench/contributions/commands';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

/** Browser task tab: a `BrowserSurface` wired to its pane's tab cycling and dev servers. */
export const BrowserPane = observer(function BrowserPane({
  browserId,
  visible,
}: {
  browserId: string;
  visible: boolean;
}) {
  const { scopeInstance } = usePaneContext();
  const previewServers = usePreviewServers();
  const cycleTab = useCallback(
    (direction: 'next' | 'previous') => {
      const command = direction === 'next' ? cycleNextTabCommand : cyclePreviousTabCommand;
      void scopeInstance?.getCommand(command)?.execute(undefined, 'keybinding');
    },
    [scopeInstance]
  );
  const agentsDrive = taskBrowserControl.control(browserId) === 'agents';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {agentsDrive && (
        // While agents may drive the tab the developer always sees so, with a way to take it back.
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-1 text-xs text-foreground-muted">
          <span>This task&apos;s agents can see and use this browser (isolated profile).</span>
          <Button
            type="button"
            variant="text"
            onClick={() => taskBrowserControl.takeBack(browserId)}
          >
            Take back
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BrowserSurface
          browserId={browserId}
          visible={visible}
          devServerUrls={previewServers.urls}
          onCycleTab={cycleTab}
        />
      </div>
    </div>
  );
});
