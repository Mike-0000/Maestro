import { Button, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
import { useEffect } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export type ConflictDialogArgs = {
  filePath: string;
};

export function ConflictDialog({ filePath }: ConflictDialogArgs) {
  const { complete, setCloseGuard } = useModalController('conflictDialog');
  const shortPath = filePath.split('/').slice(-2).join('/');

  useEffect(() => {
    setCloseGuard(true);
    return () => setCloseGuard(false);
  }, [setCloseGuard]);

  // `complete(true)` takes the version on disk, `complete(false)` keeps the open edits.
  return (
    <ModalLayout
      title="File changed on disk"
      showCloseButton={false}
      actions={
        <>
          <Button variant="ghost" onClick={() => complete(false)}>
            Keep my edits
          </Button>
          <Button variant="primary" onClick={() => complete(true)}>
            Load from disk
          </Button>
        </>
      }
    >
      <Dialog.Body>
        <Dialog.Description>
          <code className="rounded-xs bg-surface-emphasis px-1 font-mono text-xs text-foreground">
            {shortPath}
          </code>{' '}
          changed outside the editor while you have unsaved edits. Keep your edits, or load the
          version on disk?
        </Dialog.Description>
      </Dialog.Body>
    </ModalLayout>
  );
}

export const conflictDialog = defineModal<boolean>()({
  id: 'conflictDialog',
  component: ConflictDialog,
  size: 'sm',
});
