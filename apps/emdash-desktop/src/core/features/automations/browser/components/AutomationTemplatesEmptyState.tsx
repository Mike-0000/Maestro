import { EmptyState } from '@emdash/ui/react/components';
import type { BuiltinAutomationTemplate } from '../automation-template';
import { AutomationTemplateCard } from './AutomationTemplateCard';

interface AutomationTemplatesEmptyStateProps {
  templates: BuiltinAutomationTemplate[];
  onSelectTemplate: (template: BuiltinAutomationTemplate) => void;
}

/**
 * The page-level empty state for Automations (the project task list's shape): a quiet title,
 * one sentence, then the templates as a short list of ways in. Choosing one opens the create
 * sheet filled from it.
 */
export function AutomationTemplatesEmptyState({
  templates,
  onSelectTemplate,
}: AutomationTemplatesEmptyStateProps) {
  return (
    <EmptyState
      bare
      size="page"
      label="No automations yet"
      description="An automation runs an agent on a schedule. Start from a template and change anything before it runs."
      action={
        <div className="flex w-[30rem] max-w-full flex-col gap-0.5 text-left">
          {templates.map((template) => (
            <AutomationTemplateCard
              key={template.id}
              template={template}
              onSelect={onSelectTemplate}
            />
          ))}
        </div>
      }
    />
  );
}
