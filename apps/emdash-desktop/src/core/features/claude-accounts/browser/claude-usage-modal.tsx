import { Button, Dialog } from '@emdash/ui/react/primitives';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { ClaudeUsagePanel } from './claude-usage-panel';
import { ClaudeUsageRefresh } from './claude-usage-rows';
import { useNow } from './use-now';

/** The usage pane as a dialog: what the "Show Claude Usage" command opens. */
export function ClaudeUsageModal() {
  const modal = useModalController('claudeUsageModal');
  const { navigate } = useNavigate();
  const now = useNow();

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Claude usage</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="flex flex-col gap-3 pt-0">
        <ClaudeUsageRefresh now={now} className="justify-between" />
        <ClaudeUsagePanel now={now} />
      </Dialog.Body>
      <Dialog.Footer>
        <Button
          variant="ghost"
          onClick={() => {
            modal.dismiss();
            navigate(settingsViewDef({ tab: 'claude-accounts' }));
          }}
        >
          Manage accounts
        </Button>
        <Button variant="secondary" onClick={modal.dismiss}>
          Close
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const claudeUsageModal = defineModal<void>()({
  id: 'claudeUsageModal',
  component: ClaudeUsageModal,
  size: 'sm',
});
