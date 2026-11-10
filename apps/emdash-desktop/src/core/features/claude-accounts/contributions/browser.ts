import { claudeAccountLabelModal } from '../browser/claude-account-label-modal';
import { claudeUsageModal } from '../browser/claude-usage-modal';

export const claudeAccountsBrowserContributions = {
  modalDefs: [claudeAccountLabelModal, claudeUsageModal],
} as const;
