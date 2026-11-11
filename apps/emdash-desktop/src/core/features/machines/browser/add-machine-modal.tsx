import { Button, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
import { ArrowLeftIcon } from 'lucide-react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import type { SshConfig } from '@core/primitives/ssh/api';
import { MachineFormFields } from './machine-form';
import { MachineFormActions } from './machine-form-actions';
import { useMachineForm } from './use-machine-form';

export interface AddMachineModalProps {
  initialConfig?: SshConfig;
  dismissControl?: 'back' | 'close';
}

const MACHINE_MODAL_FORM_ID = 'add-ssh-conn-form';

export function AddMachineModal({ initialConfig, dismissControl = 'back' }: AddMachineModalProps) {
  const modal = useModalController('addSshConnModal');
  const showBackButton = dismissControl === 'back';
  const controller = useMachineForm({
    initialConfig,
    onSaved: (connectionId) => modal.complete({ connectionId }),
  });
  const title = controller.isEditing ? 'Edit SSH connection' : 'Add SSH connection';

  return (
    <ModalLayout
      header={
        showBackButton ? (
          <Dialog.Header showCloseButton={false}>
            <div className="-ml-2 flex items-center gap-1">
              <Button variant="ghost" size="sm" icon aria-label="Back" onClick={modal.dismiss}>
                <ArrowLeftIcon aria-hidden />
              </Button>
              <Dialog.Title>{title}</Dialog.Title>
            </div>
          </Dialog.Header>
        ) : (
          <Dialog.Header showCloseButton>
            <Dialog.Title>{title}</Dialog.Title>
          </Dialog.Header>
        )
      }
      footer={
        <Dialog.Footer>
          <MachineFormActions
            actions={controller.actions}
            resolution={controller.config.resolution}
            isEditing={controller.isEditing}
            formId={MACHINE_MODAL_FORM_ID}
            cancelAction={
              !showBackButton ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={modal.dismiss}
                  disabled={controller.isSaving}
                >
                  Cancel
                </Button>
              ) : undefined
            }
          />
        </Dialog.Footer>
      }
    >
      <Dialog.Body className="max-h-[calc(100dvh-12rem)] overflow-y-auto">
        <MachineFormFields controller={controller} formId={MACHINE_MODAL_FORM_ID} />
      </Dialog.Body>
    </ModalLayout>
  );
}

// md (520), the default form width: the fields are full width and the resolved settings stay
// label-beside-value (FactGrid stacks only under 24rem).
export const addMachineModal = defineModal<{ connectionId: string }>()({
  id: 'addSshConnModal',
  component: AddMachineModal,
  size: 'md',
});
