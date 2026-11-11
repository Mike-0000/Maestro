import { Popover, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowUp, ChevronDown, ChevronUp, FileSearch } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { ContextAction, PromptContextAction } from '../context-bar/context-actions';

const EXPAND_TEXT_LENGTH = 140;

function previewStyle(expanded: boolean): CSSProperties {
  if (expanded) return {};

  return {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
  };
}

export function PromptActionsMenu({
  actions,
  disabled,
  disabledTooltip,
  actionTooltip,
  onActionClick,
}: {
  actions: PromptContextAction[];
  disabled?: boolean;
  disabledTooltip: string;
  actionTooltip: string;
  onActionClick: (action: ContextAction) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  if (actions.length === 0) return null;

  const handleActionClick = (action: ContextAction) => {
    void onActionClick(action);
    setOpen(false);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Popover.Trigger
              disabled={disabled}
              className="relative flex h-7 max-w-full items-center gap-1.5 self-center rounded-md px-2 text-xs text-foreground-muted transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-surface-hover data-popup-open:text-foreground"
            >
              <FileSearch className="size-3.5 shrink-0 text-foreground-passive" />
              <span className="max-w-72 truncate">Prompts</span>
              <ChevronDown className="size-3 shrink-0 text-foreground-passive" />
            </Popover.Trigger>
          }
        />
        <Tooltip.Content>{disabled ? disabledTooltip : actionTooltip}</Tooltip.Content>
      </Tooltip.Root>

      <Popover.Content
        align="start"
        className="max-h-[min(var(--available-height),420px,80vh)] w-[min(420px,92vw)]"
      >
        <div className="flex shrink-0 flex-col gap-0.5">
          <div className="text-sm font-semibold text-foreground">Prompts</div>
          <div className="text-xs text-foreground-muted">{actionTooltip}</div>
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {actions.map((action) => {
            const canExpand = action.prompt.prompt.length > EXPAND_TEXT_LENGTH;
            const expanded = expandedIds.has(action.id);
            return (
              <div
                key={action.id}
                className="flex items-start gap-2 rounded-md px-2 py-2 transition-colors focus-within:bg-surface-hover hover:bg-surface-hover"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => handleActionClick(action)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {action.prompt.title}
                    </span>
                    <span
                      className={
                        expanded
                          ? 'mt-0.5 block max-h-48 overflow-y-auto pr-1 text-xs leading-relaxed text-foreground-muted'
                          : 'mt-0.5 block text-xs leading-relaxed text-foreground-muted'
                      }
                      style={previewStyle(expanded)}
                    >
                      {action.prompt.prompt}
                    </span>
                  </span>
                </button>
                <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
                  {canExpand ? (
                    <button
                      type="button"
                      className="rounded-sm p-1 text-foreground-passive outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => toggleExpanded(action.id)}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${action.prompt.title}`}
                    >
                      {expanded ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded-sm p-1 text-foreground-passive outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => handleActionClick(action)}
                    aria-label={`Add ${action.prompt.title}`}
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
