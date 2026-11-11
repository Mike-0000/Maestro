import type { WorkspacePanelProps } from './new-worktree-panel';
import { SetupStepPreview } from './setup-step-preview';

export function CheckoutPrPanel({ workspaceConfig }: WorkspacePanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-pretty text-foreground-muted">
        The pull request's branch is fetched and checked out in its own worktree. No new branch is
        created.
      </p>
      <SetupStepPreview steps={workspaceConfig.setupSteps} />
    </div>
  );
}
