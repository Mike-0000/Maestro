import { Button, Checkbox, Dialog } from '@emdash/ui/react/primitives';
import { useState, type ReactNode } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';

export type ConfirmActionDialogArgs = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  variant?: 'destructive' | 'default';
  /** Optional secondary choice surfaced with the confirmation. */
  checkbox?: { label: string; defaultChecked?: boolean };
};

export type ConfirmActionDialogResult = { checked: boolean } | undefined;

/**
 * The generic "are you sure?" dialog (design brief 2.9): the question as the title, what it
 * means in one muted sentence under it, an optional extra choice, then Cancel and the one move.
 * A destructive move uses the destructive button, which only appears inside its confirm dialog.
 */
export function ConfirmActionDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  variant = 'destructive',
  checkbox,
}: ConfirmActionDialogArgs) {
  const controller = useModalController('confirmActionModal');
  const [checked, setChecked] = useState(checkbox?.defaultChecked ?? false);

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>{title}</Dialog.Title>
        {typeof description === 'string' ? (
          <Dialog.Description>{description}</Dialog.Description>
        ) : (
          // Rich descriptions may hold block content, which a <p> cannot.
          <div className="text-sm text-foreground-muted">{description}</div>
        )}
      </Dialog.Header>
      {checkbox && (
        <Dialog.Body>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox checked={checked} onCheckedChange={(value) => setChecked(Boolean(value))} />
            {checkbox.label}
          </label>
        </Dialog.Body>
      )}
      <Dialog.Footer>
        <Button variant="ghost" onClick={controller.dismiss}>
          Cancel
        </Button>
        <ConfirmButton
          variant={variant === 'default' ? 'primary' : variant}
          onClick={() => controller.complete(checkbox ? { checked } : undefined)}
        >
          {confirmLabel}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
}

export const confirmActionModal = defineModal<ConfirmActionDialogResult>()({
  id: 'confirmActionModal',
  component: ConfirmActionDialog,
  size: 'sm',
});
