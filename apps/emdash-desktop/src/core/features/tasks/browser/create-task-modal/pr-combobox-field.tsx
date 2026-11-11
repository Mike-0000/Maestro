import { ChevronDown } from 'lucide-react';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import {
  PrSelector,
  SelectedPrValue,
} from '@core/features/tasks/browser/components/pr-selector/pr-selector';
import { FIELD_TRIGGER_CLASS } from '@core/features/tasks/browser/task-config/field-trigger';
import { parseRepositoryRef } from '@core/primitives/repository/api';
import { cn } from '@core/primitives/styling/browser/cn';
import type { PullRequest } from '@core/services/pull-requests/api';

interface PrComboboxFieldProps {
  value: PullRequest | null;
  onValueChange: (pr: PullRequest | null) => void;
  projectId?: string;
  repositoryUrl?: string;
  disabled?: boolean;
  className?: string;
}

/** The pull request picker as one field: the whole trigger is the field, its content bare. */
export function PrComboboxField({
  value,
  onValueChange,
  projectId,
  repositoryUrl,
  disabled,
  className,
}: PrComboboxFieldProps) {
  const repoRef = repositoryUrl ? parseRepositoryRef(repositoryUrl) : null;

  return (
    <PrSelector
      value={value}
      onValueChange={onValueChange}
      projectId={projectId}
      repositoryUrl={repositoryUrl}
      disabled={disabled}
      triggerClassName={cn(
        FIELD_TRIGGER_CLASS,
        value ? 'py-1.5' : 'h-8',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      renderSelectedValue={(pr) => (
        <span className="flex w-full min-w-0 items-center">
          <SelectedPrValue pr={pr} />
        </span>
      )}
      renderPlaceholder={() => (
        <span className="flex h-8 w-full min-w-0 items-center gap-2 text-foreground-passive">
          <IntegrationIcon provider="github" size={14} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">
            {repoRef
              ? `Select a pull request from ${repoRef.nameWithOwner}…`
              : 'Select a pull request…'}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </span>
      )}
    />
  );
}
