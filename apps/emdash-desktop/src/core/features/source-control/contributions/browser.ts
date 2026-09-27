import { createPrModal } from '../browser/diff-view/changes-panel/components/pr-entry/create-pr-modal';
import { integrateWorktreeModal } from '../browser/integrate/integrate-worktree-modal';

export const sourceControlBrowserContributions = {
  modalDefs: [createPrModal, integrateWorktreeModal],
} as const;
