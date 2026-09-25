import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
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
  return (
    <BrowserSurface
      browserId={browserId}
      visible={visible}
      devServerUrls={previewServers.urls}
      onCycleTab={cycleTab}
    />
  );
});
