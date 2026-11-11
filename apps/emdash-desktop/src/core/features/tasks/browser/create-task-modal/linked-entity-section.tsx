import { ToggleGroup } from '@emdash/ui/react/primitives';
import { DetailRow } from './detail-row';
import { IssueComboboxField } from './issue-combobox-field';
import { PrComboboxField } from './pr-combobox-field';
import type { LinkedType, CreateTaskState } from './use-create-task-state';

interface LinkedEntitySectionProps {
  state: CreateTaskState;
  hasAnyIssueIntegration: boolean;
  hasPrSupport: boolean;
  projectId?: string;
  repositoryUrl?: string;
  projectPath?: string;
}

/**
 * "Based on": an optional issue or pull request the conductor starts from. A segmented
 * choice (press the active one again to clear it), then the picker for that kind.
 */
export function LinkedEntitySection({
  state,
  hasAnyIssueIntegration,
  hasPrSupport,
  projectId,
  repositoryUrl,
  projectPath,
}: LinkedEntitySectionProps) {
  return (
    <DetailRow label="Based on">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-h-8 items-center">
          <ToggleGroup.Root
            aria-label="Based on"
            value={state.linkedType ? [state.linkedType] : []}
            onValueChange={([v]) => {
              state.setLinkedType((v as LinkedType) ?? null);
            }}
          >
            <ToggleGroup.Item
              value="issue"
              disabled={!hasAnyIssueIntegration}
              title={hasAnyIssueIntegration ? undefined : 'Connect an issue tracker first'}
            >
              Issue
            </ToggleGroup.Item>
            <ToggleGroup.Item
              value="pr"
              disabled={!hasPrSupport}
              title={hasPrSupport ? undefined : 'Needs a GitHub repository'}
            >
              Pull request
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        {state.linkedType === 'issue' && (
          <IssueComboboxField
            value={state.linkedIssue}
            onValueChange={state.setLinkedIssue}
            projectId={projectId}
            repositoryUrl={repositoryUrl}
            projectPath={projectPath}
          />
        )}
        {state.linkedType === 'pr' && (
          <PrComboboxField
            value={state.linkedPR}
            onValueChange={state.setLinkedPR}
            projectId={projectId}
            repositoryUrl={repositoryUrl}
          />
        )}
      </div>
    </DetailRow>
  );
}
