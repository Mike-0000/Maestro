import { Button, Field, Input, Label, Sheet, useToast } from '@emdash/ui/react/primitives';
import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { Automation } from '@core/primitives/automations/api';
import type { ConversationConfig } from '@core/primitives/automations/api';
import { assertValidCronTrigger } from '@core/primitives/automations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { formatAutomationError } from '../automation-run-format';
import type { BuiltinAutomationTemplate } from '../automation-template';
import { useAutomationTargetAvailability, useCreateAutomation } from '../use-automations';
import { useAutomationFormState } from '../useAutomationFormState';
import { AutomationSettingsFields } from './AutomationSettingsFields';
import { UseTemplateButton } from './pickers/UseTemplateButton';
import { SheetHeader } from './sheet-header';

export interface CreateAutomationViewProps {
  onClose: () => void;
  onSaved?: (automation: Automation) => void;
  initialTemplate?: BuiltinAutomationTemplate;
}

/**
 * The create sheet: title and one sentence, then the form (name, project, schedule, prompt and
 * workspace), with "Start from a template" beside the name as a quiet way to fill it in. Cancel
 * and the one primary, Create, sit in the footer.
 */
export const CreateAutomationView = observer(function CreateAutomationView({
  onClose,
  onSaved,
  initialTemplate,
}: CreateAutomationViewProps) {
  const formState = useAutomationFormState(undefined, initialTemplate);
  const {
    name,
    setName,
    effectiveProjectId,
    prompt,
    provider,
    canSave,
    triggerConfig,
    applyTemplate,
    buildTaskConfig,
  } = formState;

  const [error, setError] = useState<string | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const create = useCreateAutomation();
  const availability = useAutomationTargetAvailability(effectiveProjectId);
  const runtimeAvailable = availability.data?.available === true;
  const canCreate = canSave && runtimeAvailable;
  const { toast } = useToast();
  const isPending = create.isPending;

  async function handleSave() {
    if (!effectiveProjectId || !provider || !canCreate) return;
    setError(null);
    const taskConfig = buildTaskConfig(effectiveProjectId);
    if (!taskConfig) return;
    try {
      assertValidCronTrigger(triggerConfig);
    } catch (validationError) {
      setCronError(formatAutomationError(validationError));
      return;
    }
    setCronError(null);
    const useChatUi = formState.initialConversation.useChatUi;
    const conversationConfig: ConversationConfig = {
      prompt: prompt.trim(),
      provider,
      autoApprove: false,
      model: formState.model ?? undefined,
      type: useChatUi ? 'acp' : 'pty',
    };
    try {
      const trimmedName = name.trim();
      const saved = await create.mutateAsync({
        name: trimmedName,
        triggerConfig,
        conversationConfig,
        taskConfig,
        projectId: effectiveProjectId,
      });
      toast('Automation created', {
        description: `"${saved.name}" is ready to go.`,
      });
      onSaved?.(saved);
    } catch (saveError) {
      setError(formatAutomationError(saveError));
    }
  }

  function handleTemplateSelect(template: BuiltinAutomationTemplate) {
    applyTemplate(template);
    setError(null);
    setCronError(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader
        onClose={onClose}
        title={<Sheet.Title>New automation</Sheet.Title>}
        description="Runs an agent on a schedule in one of your projects."
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
        <div className="flex flex-col gap-5">
          <Field.Root>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="automation-name">Name</Label>
              <UseTemplateButton
                open={templatesOpen}
                onOpenChange={setTemplatesOpen}
                onSelect={handleTemplateSelect}
              />
            </div>
            <Input
              id="automation-name"
              autoFocus={name.trim().length === 0}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily pull request review"
            />
          </Field.Root>
          <AutomationSettingsFields
            state={formState}
            cronError={cronError}
            onCronExprChange={(expr) => formState.setCronExpr(expr)}
            onCronErrorClear={() => setCronError(null)}
            onOnDemandChange={(onDemand) => formState.setOnDemand(onDemand)}
            error={error}
          />
          {availability.data?.available === false && effectiveProjectId && (
            <p className="flex items-start gap-2 text-xs text-foreground-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {availability.data.reason}
            </p>
          )}
        </div>
      </div>
      <Sheet.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton
          variant="primary"
          onClick={() => {
            void handleSave();
          }}
          disabled={!canCreate || isPending}
        >
          {isPending ? 'Creating…' : 'Create'}
        </ConfirmButton>
      </Sheet.Footer>
    </div>
  );
});
