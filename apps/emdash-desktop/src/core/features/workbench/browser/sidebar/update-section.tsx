import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

/**
 * The right end of the sidebar's footer line: the running version as a caption, or, while an
 * update is on offer, one quiet link that says where it stands and opens Settings › General
 * (starting the download when it has not started yet).
 */
export const UpdateSection = observer(function UpdateSection() {
  const update = getUpdateStore();
  const { navigate } = useNavigate();

  if (update.hasUpdate) {
    const label =
      update.state.status === 'downloading'
        ? `Downloading update${update.progressLabel ? ` ${update.progressLabel}` : '…'}`
        : update.state.status === 'downloaded'
          ? 'Restart to update'
          : 'Update available';
    return (
      <Button
        variant="link"
        className="h-7 shrink-0 text-xs tabular-nums"
        onClick={() => {
          navigate(settingsViewDef({ tab: 'general' }));
          if (update.state.status === 'available') {
            void update.download();
          }
        }}
      >
        {label}
      </Button>
    );
  }

  return (
    <span className="inline-flex h-7 shrink-0 items-center px-2 text-tiny text-foreground-passive tabular-nums select-none">
      v{update.currentVersion}
    </span>
  );
});
