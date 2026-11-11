import { ChevronDown } from 'lucide-react';
import { getIntegrationName } from '@core/features/integrations/api/browser/integration-display';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import {
  IssueSelector,
  type IssueSelectorTriggerContext,
  ProviderLogo,
  SelectedIssueValue,
} from '@core/features/tasks/browser/components/issue-selector/issue-selector';
import { FIELD_TRIGGER_CLASS } from '@core/features/tasks/browser/task-config/field-trigger';
import type { LinkedIssue } from '@core/primitives/linked-issues/api';
import { cn } from '@core/primitives/styling/browser/cn';

interface IssueComboboxFieldProps {
  value: LinkedIssue | null;
  onValueChange: (issue: LinkedIssue | null) => void;
  projectId?: string;
  repositoryUrl?: string;
  projectPath?: string;
  disabled?: boolean;
  className?: string;
}

function ModalPlaceholder({ issueProvider }: IssueSelectorTriggerContext) {
  const { integrationById } = useIntegrationsContext();
  const issueProviderName = issueProvider
    ? getIntegrationName(integrationById, issueProvider)
    : null;

  return (
    <span className="flex h-8 min-w-0 flex-1 items-center gap-2 text-foreground-passive">
      {issueProvider && (
        <ProviderLogo provider={issueProvider} className="size-3.5 shrink-0 opacity-70" />
      )}
      <span className="truncate">
        {issueProviderName ? `Select a ${issueProviderName} issue…` : 'Select an issue…'}
      </span>
    </span>
  );
}

/** The issue picker as one field: the whole trigger is the field, its content bare. */
export function IssueComboboxField({
  value,
  onValueChange,
  projectId,
  repositoryUrl = '',
  projectPath = '',
  disabled,
  className,
}: IssueComboboxFieldProps) {
  return (
    <IssueSelector
      value={value}
      onValueChange={onValueChange}
      projectId={projectId}
      repositoryUrl={repositoryUrl}
      projectPath={projectPath}
      disabled={disabled}
      triggerClassName={cn(
        FIELD_TRIGGER_CLASS,
        value ? 'py-1.5' : 'h-8',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      renderSelectedValue={(issue) => (
        <span className="flex w-full min-w-0 items-center gap-2">
          <SelectedIssueValue issue={issue} />
        </span>
      )}
      renderPlaceholder={(ctx) => (
        <span className="flex w-full min-w-0 items-center gap-2">
          <ModalPlaceholder {...ctx} />
          <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
        </span>
      )}
    />
  );
}
