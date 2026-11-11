import { Button, Dialog } from '@emdash/ui/react/primitives';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export type QuitUnsavedChangesResult = 'save-all' | 'discard';

export interface QuitUnsavedChangesDialogArgs {
  count: number;
}

export function QuitUnsavedChangesDialog({ count }: QuitUnsavedChangesDialogArgs) {
  const controller = useModalController('quitUnsavedChangesModal');
  const files = count === 1 ? '1 file has' : `${count} files have`;

  // The platform's quit-with-changes layout: the throwaway choice on its own at the left (its
  // text lined up with the title), Cancel and the one move on the right.
  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>Save changes before quitting?</Dialog.Title>
        <Dialog.Description>
          {files} changes that are not saved. Save them before Maestro quits, or discard them.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        {/* Cancel comes first in the DOM so it takes the dialog's first focus; Discard is only
            drawn first, at the left. */}
        <Button variant="ghost" onClick={controller.dismiss}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => controller.complete('save-all')}>
          Save all
        </Button>
        <Button
          variant="ghost"
          className="sm:order-first sm:mr-auto sm:-ml-3"
          onClick={() => controller.complete('discard')}
        >
          Discard
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const quitUnsavedChangesModal = defineModal<QuitUnsavedChangesResult>()({
  id: 'quitUnsavedChangesModal',
  component: QuitUnsavedChangesDialog,
  size: 'sm',
});
