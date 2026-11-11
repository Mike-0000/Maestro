import { MetaLine } from '@emdash/ui/react/patterns';
import {
  Button,
  DropdownMenu,
  Input,
  Sheet,
  Switch,
  Tabs,
  Tooltip,
} from '@emdash/ui/react/primitives';
import { Ellipsis, Trash2, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import {
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import type { Automation } from '@core/primitives/automations/api';
import { useAutomationTargetAvailability, useRunAutomationNow } from '../use-automations';
import { useAutomationSettingsAutoSave } from '../useAutomationSettingsAutoSave';
import { automationScheduleLabel } from './automation-schedule';
import { AutomationSettingsFields } from './AutomationSettingsFields';
import { NextRunBanner } from './NextRunBanner';
import { RunHistory } from './RunHistory';
import { SheetHeader } from './sheet-header';

type AutomationTab = 'runs' | 'settings';

const AUTOMATION_TABS: { value: AutomationTab; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'settings', label: 'Settings' },
];

export interface AutomationDetailViewProps {
  automation: Automation;
  onClose: () => void;
  onDelete?: (automation: Automation) => void;
  onRunNow?: (automation: Automation) => void;
  onToggleEnabled?: (automation: Automation, enabled: boolean) => void;
  runNowPending?: boolean;
}

/**
 * The automation sheet: its name as the title (edited in place), one caption line with the
 * schedule, project and next run, the on / paused switch with "Run now" and the overflow menu,
 * then Runs and Settings as underline tabs over a scrolling body.
 */
export const AutomationDetailView = observer(function AutomationDetailView({
  automation,
  onClose,
  onDelete,
  onToggleEnabled,
  runNowPending: _runNowPending,
}: AutomationDetailViewProps) {
  const [activeTab, setActiveTab] = useState<AutomationTab>('runs');
  const [cronError, setCronError] = useState<string | null>(null);
  const availability = useAutomationTargetAvailability(automation.projectId);
  const runtimeAvailability = availability.data ?? {
    available: false as const,
    reason: 'Checking automation runtime…',
  };
  const canEdit = runtimeAvailability.available;

  const { formState, setCronExpr, setOnDemand, handlePromptBlur, handleNameBlur, saveError } =
    useAutomationSettingsAutoSave(automation, canEdit);
  const { name, setName } = formState;

  const runNow = useRunAutomationNow();

  const canRunNow =
    canEdit &&
    automation.enabled &&
    !!automation.projectId &&
    !!automation.conversationConfig &&
    !!automation.triggerConfig &&
    !!automation.taskConfig &&
    !runNow.isPending;

  const runNowReason =
    automation.projectId == null
      ? 'Assign a project before running'
      : !canEdit
        ? runtimeAvailability.reason
        : !automation.enabled
          ? 'Turn the automation on before running'
          : !automation.conversationConfig || !automation.triggerConfig || !automation.taskConfig
            ? 'Configure the automation before running'
            : 'Start a run now, outside the schedule';

  const projectName = automation.projectId
    ? projectDisplayName(getProjectStore(automation.projectId))
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader
        onClose={onClose}
        title={
          <>
            <Sheet.Title className="sr-only">Automation details</Sheet.Title>
            <Input
              bare
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameBlur}
              placeholder="Name this automation"
              aria-label="Automation name"
              // The title, edited in place: no field chrome at rest, the hover step and the
              // accent ring once it is being edited.
              className="-mx-1.5 h-8 rounded-md px-1.5 text-lg font-semibold text-foreground transition-colors outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"
              disabled={!canEdit}
            />
          </>
        }
        description={
          <MetaLine
            strong
            keepEndWhenNarrow
            start={[
              automationScheduleLabel(automation),
              projectName ?? (
                <span key="project" className="text-foreground-warning">
                  No project
                </span>
              ),
            ]}
            trailing={
              <NextRunBanner
                automationId={automation.id}
                projectId={automation.projectId}
                runtimeAvailable={canEdit}
              />
            }
          />
        }
      />

      <div className="flex shrink-0 flex-col gap-4 px-6 pt-4">
        {!availability.data ? (
          <p className="text-xs text-foreground-muted">Checking automation runtime…</p>
        ) : !runtimeAvailability.available ? (
          <p className="flex items-start gap-2 text-xs text-foreground-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {runtimeAvailability.reason}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-muted has-disabled:cursor-default">
            <Switch
              checked={automation.enabled}
              disabled={!canEdit}
              onCheckedChange={(checked) => onToggleEnabled?.(automation, checked)}
              aria-label={automation.enabled ? 'Pause automation' : 'Enable automation'}
            />
            {automation.enabled ? 'On' : 'Paused'}
          </label>
          <span className="flex-1" />
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  variant="text"
                  size="sm"
                  disabled={!canRunNow}
                  onClick={() =>
                    void runNow.mutateAsync({
                      projectId: automation.projectId!,
                      automationId: automation.id,
                    })
                  }
                />
              }
            >
              {runNow.isPending ? 'Starting…' : 'Run now'}
            </Tooltip.Trigger>
            <Tooltip.Content>{runNowReason}</Tooltip.Content>
          </Tooltip.Root>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" size="sm" icon aria-label="More automation actions" />
              }
            >
              <Ellipsis className="size-4" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="bottom" align="end">
              <DropdownMenu.Item variant="destructive" onClick={() => onDelete?.(automation)}>
                <Trash2 />
                Delete automation…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>

        <Tabs.Root
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as AutomationTab)}
        >
          <Tabs.List variant="underline" aria-label="Automation">
            {AUTOMATION_TABS.map(({ value, label }) => (
              <Tabs.Tab key={value} value={value} size="sm">
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
        {activeTab === 'runs' && <RunHistory automation={automation} />}
        {activeTab === 'settings' && (
          <AutomationSettingsFields
            state={formState}
            cronError={cronError}
            onCronExprChange={(expr) => {
              setCronExpr(expr);
              setCronError(null);
            }}
            onCronErrorClear={() => setCronError(null)}
            onOnDemandChange={setOnDemand}
            automationId={automation.id}
            onPromptBlur={handlePromptBlur}
            error={saveError}
            disabled={!canEdit}
          />
        )}
      </div>
    </div>
  );
});
