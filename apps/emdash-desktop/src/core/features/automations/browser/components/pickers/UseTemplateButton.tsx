import { Button, DropdownMenu } from '@emdash/ui/react/primitives';
import { ChevronDown } from 'lucide-react';
import type { BuiltinAutomationTemplate } from '../../automation-template';
import { emptyStateAutomationTemplates } from '../../builtin-catalog';

interface UseTemplateButtonProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: BuiltinAutomationTemplate) => void;
}

/**
 * "Start from a template": a quiet text action that opens the templates as a menu (name and
 * one line of what it does). Choosing one fills the form; nothing is created until Create.
 */
export function UseTemplateButton({ open, onOpenChange, onSelect }: UseTemplateButtonProps) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger render={<Button variant="text" size="sm" />}>
        Start from a template
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" width="content">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Templates</DropdownMenu.Label>
          {emptyStateAutomationTemplates.map((template) => {
            const Icon = template.icon;
            return (
              <DropdownMenu.Item
                key={template.id}
                onClick={() => onSelect(template)}
                className="h-auto items-start py-1.5"
              >
                <Icon className="mt-0.5" aria-hidden />
                <span className="flex w-64 min-w-0 flex-col">
                  <span className="truncate text-foreground">{template.name}</span>
                  <span className="line-clamp-2 text-xs text-foreground-passive">
                    {template.description}
                  </span>
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
