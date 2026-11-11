import { Button, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
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
    <ModalLayout
      title="Claude usage"
      leading={
        <Button
          variant="text"
          onClick={() => {
            modal.dismiss();
            navigate(settingsViewDef({ tab: 'claude-accounts' }));
          }}
        >
          Manage accounts
        </Button>
      }
      actions={
        <Button variant="ghost" onClick={modal.dismiss}>
          Close
        </Button>
      }
    >
      <Dialog.Body className="gap-4">
        <ClaudeUsageRefresh now={now} className="-mt-2 -mr-1.5 justify-end" />
        <ClaudeUsagePanel now={now} />
      </Dialog.Body>
    </ModalLayout>
  );
}

export const claudeUsageModal = defineModal<void>()({
  id: 'claudeUsageModal',
  component: ClaudeUsageModal,
  size: 'sm',
});
