import { Field, Label, Switch } from '@emdash/ui/react/primitives';
import { CronPicker } from '@core/features/automations/browser/CronPicker';
import { ProjectSelector } from '@core/features/tasks/contributions/browser/project-selector';
import { ConversationField } from '@core/features/tasks/contributions/browser/task-config/conversation-field';
import { TaskConfigProvider } from '@core/features/tasks/contributions/browser/task-config/task-config-context';
import { TaskConfigPanel } from '@core/features/tasks/contributions/browser/task-config/task-config-panel';
import { TaskStateProvider } from '@core/features/tasks/contributions/browser/task-config/task-state-context';
import { WorkspaceSettingsSection } from '@core/features/tasks/contributions/browser/task-config/workspace-settings-section';
import type { AutomationFormState } from '../useAutomationFormState';

interface AutomationSettingsFieldsProps {
  state: AutomationFormState;
  cronError: string | null;
  onCronExprChange: (expr: string) => void;
  onCronErrorClear: () => void;
  onOnDemandChange: (onDemand: boolean) => void;
  /** Shown for a saved on-demand automation: the id a trigger gateway config refers to. */
  automationId?: string;
  onPromptBlur?: () => void;
  error?: string | null;
  disabled?: boolean;
}

export function AutomationSettingsFields({
  state,
  cronError,
  onCronExprChange,
  onCronErrorClear,
  onOnDemandChange,
  automationId,
  onPromptBlur,
  error,
  disabled = false,
}: AutomationSettingsFieldsProps) {
  const {
    initialConversation,
    cronExpr,
    onDemand,
    workspaceConfig,
    effectiveProjectId,
    isUnborn,
    hasRepository,
    setProjectId,
  } = state;

  return (
    <fieldset disabled={disabled} className="contents">
      <Field.Group>
        <Field.Root>
          <Label>Project</Label>
          <ProjectSelector
            value={effectiveProjectId}
            onChange={(nextProjectId) => setProjectId(nextProjectId)}
          />
        </Field.Root>
        <Field.Root>
          <div className="flex items-center justify-between gap-3">
            <Label>{onDemand ? 'Trigger' : 'Schedule'}</Label>
            <label className="flex items-center gap-2 text-xs text-foreground-muted">
              On demand
              <Switch
                checked={onDemand}
                onCheckedChange={(checked) => onOnDemandChange(checked)}
                aria-label="Run on demand instead of on a schedule"
              />
            </label>
          </div>
          {onDemand ? (
            <p className="text-xs text-foreground-muted">
              Runs only when requested. Each request is added to the prompt below, runs without
              permission prompts in a new worktree, and ends as a pull request for review.
              {automationId && (
                <>
                  {' '}
                  Automation id for the trigger gateway:{' '}
                  <code className="select-all">{automationId}</code>
                </>
              )}
            </p>
          ) : (
            <CronPicker
              value={cronExpr}
              onChange={(nextCronExpr) => {
                onCronExprChange(nextCronExpr);
                onCronErrorClear();
              }}
            />
          )}
          {cronError && <Field.Error match>{cronError}</Field.Error>}
        </Field.Root>
        <TaskStateProvider
          workspaceConfig={workspaceConfig}
          initialConversation={initialConversation}
          projectId={effectiveProjectId}
          isUnborn={isUnborn}
          hasRepository={hasRepository}
          hasPR={false}
          includeIssueContextByDefault={false}
        >
          <TaskConfigProvider showPrPresets={false} autoBranchName={true}>
            <TaskConfigPanel
              tabs={[
                {
                  value: 'prompt',
                  label: 'Prompt',
                  content: (
                    <ConversationField
                      onPromptBlur={onPromptBlur}
                      textareaClassName="min-h-40"
                      placeholder="Add a prompt to the automation..."
                      showAutoApproveToggle={false}
                      requirePromptDelivery={true}
                    />
                  ),
                },
                {
                  value: 'workspace',
                  label: 'Workspace Settings',
                  content: <WorkspaceSettingsSection defaultOpen={true} />,
                },
              ]}
            />
          </TaskConfigProvider>
        </TaskStateProvider>
      </Field.Group>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </fieldset>
  );
}
