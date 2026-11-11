import { Button, Dialog, Field, Input, ModalLayout } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import {
  liveTransformTaskName,
  MAX_TASK_NAME_LENGTH,
  normalizeTaskName,
  taskNameCollisionKey,
} from '@core/features/tasks/api/browser/taskNames';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';

type RenameTaskModalArgs = {
  projectId: string;
  taskId: string;
  currentName: string;
};

export const RenameTaskModal = observer(function RenameTaskModal({
  projectId,
  taskId,
  currentName,
}: RenameTaskModalArgs) {
  const { complete, dismiss } = useModalController('renameTaskModal');
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { preserveNameCapitalization } = useTaskSettings();

  const taskManager = getTaskManagerStore(projectId);
  const siblingNames = new Set(
    Array.from(taskManager?.tasks.values() ?? [])
      .filter((t) => t.state !== 'unregistered' && t.data.id !== taskId)
      .map((t) => taskNameCollisionKey(t.data.name))
  );

  const normalizedName = normalizeTaskName(name, {
    preserveCapitalization: preserveNameCapitalization,
  });
  const isDuplicate = siblingNames.has(taskNameCollisionKey(normalizedName));
  const isUnchanged = normalizedName === currentName;
  const isEmpty = normalizedName.length === 0;
  const isValid = !isEmpty && !isDuplicate && !isUnchanged;

  const validationMessage = isDuplicate
    ? 'A conductor with this name already exists in this project.'
    : isEmpty
      ? 'Conductor name cannot be empty.'
      : undefined;

  const handleNameChange = useCallback(
    (value: string) => {
      setName(
        liveTransformTaskName(value, {
          preserveCapitalization: preserveNameCapitalization,
        })
      );
      setError(null);
    },
    [preserveNameCapitalization]
  );

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    const task = taskManager?.tasks.get(taskId);
    if (!task) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await task.rename(normalizedName);
      if (!result.success) {
        setError('Conductor not found.');
        setIsSubmitting(false);
        return;
      }
      complete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename conductor');
      setIsSubmitting(false);
    }
  }, [isValid, taskManager, taskId, normalizedName, complete]);

  const message = error ?? (validationMessage && !isUnchanged ? validationMessage : null);

  return (
    <ModalLayout
      title="Rename conductor"
      showCloseButton={false}
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
        <Field.Root invalid={Boolean(message)}>
          <Field.Label>Conductor name</Field.Label>
          <Input
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            maxLength={MAX_TASK_NAME_LENGTH}
            aria-invalid={Boolean(message) || undefined}
            autoFocus
          />
          {message && <p className="text-xs text-foreground-error">{message}</p>}
        </Field.Root>
      </Dialog.Body>
    </ModalLayout>
  );
});

export const renameTaskModal = defineModal<void>()({
  id: 'renameTaskModal',
  component: RenameTaskModal,
  size: 'sm',
});
