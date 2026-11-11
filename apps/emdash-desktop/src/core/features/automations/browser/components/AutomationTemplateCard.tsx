import { cn } from '@core/primitives/styling/browser/cn';
import type { BuiltinAutomationTemplate } from '../automation-template';

interface AutomationTemplateCardProps {
  template: BuiltinAutomationTemplate;
  onSelect: (template: BuiltinAutomationTemplate) => void;
  compact?: boolean;
  className?: string;
}

/**
 * One template as a quiet row (the project task list's "ways in" rows): a passive icon, the
 * name, one line of what it does, and its category in the caption role on the right. No box:
 * the hover step and the focus ring carry the interaction.
 */
export function AutomationTemplateCard({
  template,
  onSelect,
  compact = false,
  className,
}: AutomationTemplateCardProps) {
  const Icon = template.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(template)}
      className={cn(
        'group flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2 text-left transition-colors',
        'hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        className
      )}
    >
      <Icon
        className="mt-0.5 size-4 shrink-0 text-foreground-passive transition-colors group-hover:text-foreground-muted"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{template.name}</span>
        <span
          className={cn('text-xs text-foreground-muted', compact ? 'line-clamp-1' : 'line-clamp-2')}
        >
          {template.description}
        </span>
      </span>
      {!compact && (
        <span className="mt-0.5 shrink-0 text-tiny text-foreground-passive">
          {template.category}
        </span>
      )}
    </button>
  );
}
