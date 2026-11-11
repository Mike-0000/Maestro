import { Collapsible } from '@emdash/ui/react/primitives';
import type { WorktreeSetupStep } from '@core/primitives/workspaces/api';

interface SetupStepPreviewProps {
  steps: WorktreeSetupStep[];
}

/**
 * A collapsible read-only list of the lifecycle steps that will run when the
 * workspace is provisioned — a projection of the compiled worktree git plan, carrying
 * the same step ids the Activity badge shows live. Collapsed by default: a quiet text
 * disclosure, then a numbered list in the caption role (no box, no rules).
 */
export function SetupStepPreview({ steps }: SetupStepPreviewProps) {
  if (steps.length === 0) return null;

  return (
    <Collapsible.Root className="flex flex-col">
      <Collapsible.Trigger variant="text">
        Setup steps
        <span className="text-foreground-passive tabular-nums">{steps.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none">
        <ol className="flex flex-col gap-2 pt-2 pl-4">
          {steps.map((step, i) => (
            <li key={step.id} data-step={step.id} className="flex items-start gap-2 text-xs">
              <span className="w-3 shrink-0 text-right text-foreground-passive tabular-nums">
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground">{step.title}</span>
                <span className="text-tiny text-pretty text-foreground-muted">
                  {step.description}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
