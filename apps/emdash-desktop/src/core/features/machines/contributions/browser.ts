import { addMachineModal } from '../browser/add-machine-modal';
import { linkConversationModal } from '../browser/components/link-conversation-modal';
import { maestroHostModal } from '../browser/maestro-host-modal';

export const machinesBrowserContributions = {
  modalDefs: [addMachineModal, maestroHostModal, linkConversationModal],
} as const;
