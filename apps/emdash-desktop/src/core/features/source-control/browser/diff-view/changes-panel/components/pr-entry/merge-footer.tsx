import { Button, Checkbox, SplitButton } from '@emdash/ui/react/primitives';
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  HelpCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { type MergeSeverity, type MergeUiState } from './merge-ui-state';

/** A selectable action for the merge split button: label plus its own callback. */
export type MergeAction = {
  value: string;
  label: string;
  description?: string;
  action: () => void;
};

// Only a block (error) and a caution (warning) take colour; ready reads in full
// strength and an unknown state stays passive. The words carry the meaning.
const severityConfig: Record<MergeSeverity, SeverityConfig> = {
  success: { icon: CheckCircle2, iconClass: 'text-foreground' },
  warning: { icon: AlertTriangle, iconClass: 'text-foreground-warning' },
  error: { icon: XCircle, iconClass: 'text-foreground-error' },
  neutral: { icon: HelpCircle, iconClass: 'text-foreground-passive' },
};

type SeverityConfig = { icon: LucideIcon; iconClass: string };

export function MergeFooter({
  uiState,
  mergeActions,
  isMerging,
  isMarkingReady,
  bypassRequirements,
  onMarkReady,
  onBypassRequirementsChange,
}: {
  uiState: MergeUiState;
  mergeActions: MergeAction[];
  isMerging: boolean;
  isMarkingReady: boolean;
  bypassRequirements: boolean;
  onMarkReady: () => void;
  onBypassRequirementsChange: (checked: boolean) => void;
}) {
  const isDraft = uiState.kind === 'draft';
  const [selectedMergeId, setSelectedMergeId] = useState<string | undefined>(undefined);
  const mergeDisabled =
    !isMerging && !uiState.canMerge && (!uiState.canBypassRequirements || !bypassRequirements);
  const bypassEnabled = uiState.canBypassRequirements && bypassRequirements;
  const { icon: MergeStatusIcon, iconClass } =
    severityConfig[bypassEnabled ? 'warning' : uiState.severity];
  const mergeStatusTitle = bypassEnabled ? 'Bypass requirements enabled' : uiState.title;
  const mergeStatusDetail = bypassEnabled
    ? 'Merging ignores the unmet requirements.'
    : uiState.detail;

  // The PR's one move sits here: Merge (or Mark ready for a draft), beside the
  // plain-words state that decides whether it is allowed.
  return (
    <div data-testid="merge-footer" className="flex shrink-0 flex-col gap-2.5 px-4 pt-3 pb-3">
      <div className="flex items-start gap-2" role="status">
        <MergeStatusIcon aria-hidden className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-medium text-foreground">{mergeStatusTitle}</p>
          {mergeStatusDetail && (
            <p className="text-xs text-foreground-muted">{mergeStatusDetail}</p>
          )}
        </div>
      </div>
      {uiState.canBypassRequirements && (
        <label className="flex cursor-pointer items-start gap-2 pl-6 text-xs leading-snug text-foreground-muted">
          <Checkbox
            className="mt-px"
            checked={bypassRequirements}
            onCheckedChange={(checked) => onBypassRequirementsChange(Boolean(checked))}
          />
          <span>Merge without waiting for requirements to be met (bypass rules)</span>
        </label>
      )}
      <div className="flex justify-end">
        {isDraft ? (
          <Button
            variant="primary"
            size="sm"
            onClick={onMarkReady}
            disabled={isMarkingReady}
            aria-label={isMarkingReady ? 'Marking ready...' : 'Mark ready'}
          >
            {isMarkingReady ? 'Marking ready…' : 'Mark ready'}
          </Button>
        ) : (
          <SplitButton
            size="sm"
            variant="primary"
            loading={isMerging}
            loadingLabel="Merging..."
            icon={<GitMerge className="size-3.5" />}
            options={mergeActions.map(({ value, label, description }) => ({
              id: value,
              label,
              description,
            }))}
            selectedId={selectedMergeId}
            onSelectedChange={setSelectedMergeId}
            commitOnSelect={false}
            onAction={(id) => mergeActions.find((a) => a.value === id)?.action()}
            disabled={mergeDisabled}
            className="min-w-0"
          />
        )}
      </div>
    </div>
  );
}
