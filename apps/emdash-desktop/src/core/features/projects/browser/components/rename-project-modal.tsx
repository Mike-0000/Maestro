import { Button, Dialog, Field, Input, ModalLayout } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useId, useState } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';

type RenameProjectModalArgs = {
  projectId: string;
  currentName: string;
};

export const RenameProjectModal = observer(function RenameProjectModal({
  projectId,
  currentName,
}: RenameProjectModalArgs) {
  const { complete, dismiss } = useModalController('renameProjectModal');
  const nameId = useId();
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isEmpty = trimmedName.length === 0;
  const isUnchanged = trimmedName === currentName;
  const isValid = !isEmpty && !isUnchanged;

  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await getProjectManagerStore().renameProject(projectId, trimmedName);
      complete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename project');
      setIsSubmitting(false);
    }
  }, [isValid, isSubmitting, projectId, trimmedName, complete]);

  return (
    <ModalLayout
      title="Rename project"
      description="Only the name in Maestro changes; the folder on disk keeps its name."
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <ConfirmButton
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? 'Renaming…' : 'Rename'}
          </ConfirmButton>
        </>
      }
    >
      <Dialog.Body>
        <Field.Root invalid={isEmpty || error !== null}>
          <Field.Label htmlFor={nameId}>Project name</Field.Label>
          <Input
            id={nameId}
            value={name}
            aria-invalid={isEmpty || error !== null ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            autoFocus
          />
          {isEmpty && (
            <p role="alert" className="text-xs text-foreground-error">
              Project name cannot be empty.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-foreground-error">
              {error}
            </p>
          )}
        </Field.Root>
      </Dialog.Body>
    </ModalLayout>
  );
});

export const renameProjectModal = defineModal<void>()({
  id: 'renameProjectModal',
  component: RenameProjectModal,
  size: 'sm',
});
