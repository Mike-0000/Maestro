import { Button, Dialog } from '@emdash/ui/react/primitives';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export type UnsavedChangesDialogResult = 'save' | 'discard';

export type UnsavedChangesDialogArgs = {
  fileName: string;
};

export function UnsavedChangesDialog({ fileName }: UnsavedChangesDialogArgs) {
  const controller = useModalController('unsavedChangesModal');
  // Callers may pass a full path: name the file, keep the path on hover.
  const displayName = fileName.split(/[\\/]/).pop() || fileName;

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>Save your changes?</Dialog.Title>
        <Dialog.Description>
          <span className="font-medium break-all text-foreground" title={fileName}>
            {displayName}
          </span>{' '}
          has changes that are not saved. Discarding them cannot be undone.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="ghost" onClick={() => controller.complete('discard')}>
          Discard
        </Button>
        <Button variant="primary" onClick={() => controller.complete('save')}>
          Save
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const unsavedChangesModal = defineModal<UnsavedChangesDialogResult>()({
  id: 'unsavedChangesModal',
  component: UnsavedChangesDialog,
  size: 'sm',
});
