import type { ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { Combobox } from '@emdash/ui/react/primitives';
import { ChevronDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useMemo, useState } from 'react';
import {
  canInstallAgentOption,
  isComboboxOptionDisabled,
  type AgentDisableReason,
  type AgentGroup,
  type AgentOption,
} from '@core/features/agents/api/browser/components/agent-selector/agent-selector-options';
import { useAgentAvailability } from '@core/features/agents/api/browser/components/agent-selector/use-agent-availability';
import {
  AgentHoverCard,
  isEventInsideAgentHoverCard,
  useAgentHoverCard,
} from '@core/features/agents/browser/components/agent-selector/agent-hover-card';
import { AgentCapabilityIcons } from '@core/features/agents/contributions/browser/agent-capability-icons';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { cn } from '@core/primitives/styling/browser/cn';

/**
 * The trigger faces (design brief 2.8): `field` reads like the kit Input (a form control that
 * keeps its column width); `quiet` is a borderless ghost chip for option rows such as the one
 * under the New conductor prompt, where the agent reads as part of a sentence.
 */
const TRIGGER_APPEARANCE = {
  field:
    'h-8 w-full rounded-md border border-border bg-(--em-surface-input) px-2.5 hover:border-border-1 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring data-popup-open:border-border-1 emlight:border-border-1 emlight:bg-surface-elevated emlight:hover:border-border-2',
  quiet:
    '-ml-2 h-7 max-w-full rounded-md px-2 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-surface-hover',
} as const;

interface AgentSelectorProps {
  value: AgentProviderId | null;
  onChange: (agent: AgentProviderId) => void;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  connectionId?: string;
  getDisabledReason?: AgentDisableReason;
  installable?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Trigger face: `field` (default, a form control) or `quiet` (a ghost chip in a row). */
  appearance?: keyof typeof TRIGGER_APPEARANCE;
}

export const AgentSelector: React.FC<AgentSelectorProps> = observer(
  ({
    value,
    onChange,
    disabled = false,
    className = '',
    contentClassName,
    connectionId,
    getDisabledReason,
    installable = true,
    autoFocus = false,
    placeholder = 'No agent installed',
    appearance = 'field',
  }) => {
    const [open, setOpen] = useState(false);
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
    const hoverCard = useAgentHoverCard();
    const { groups } = useAgentAvailability({
      connectionId,
      getDisabledReason,
      value,
    });
    const allOptions = useMemo(() => groups.flatMap((group) => group.items), [groups]);

    const selectedOption = value ? allOptions.find((o) => o.value === value) : null;

    function handleOpenChange(next: boolean, eventDetails: ComboboxRootChangeEventDetails) {
      if (disabled) return;
      // Clicks/focus inside the hover card register as outside presses on the combobox;
      // they must not dismiss the agent list (which would unmount the card too).
      if (!next && hoverCard.open && isEventInsideAgentHoverCard(eventDetails.event, anchorEl)) {
        eventDetails.cancel();
        return;
      }
      if (!next) hoverCard.close();
      setOpen(next);
    }

    function handleValueChange(item: AgentOption | null) {
      if (!item || disabled || item.disabled) return;
      hoverCard.close();
      onChange(item.agentId);
      setOpen(false);
    }

    return (
      <Combobox.Root
        items={groups}
        value={selectedOption ?? null}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={disabled ? undefined : handleOpenChange}
        isItemEqualToValue={(a: AgentOption, b: AgentOption) => a.value === b.value}
        filter={(item: AgentOption, query) =>
          item.label.toLowerCase().includes(query.toLowerCase())
        }
        autoHighlight
      >
        <Combobox.Trigger
          data-autofocus={autoFocus || undefined}
          disabled={disabled}
          className={cn(
            'flex min-w-0 items-center gap-2 text-left text-sm text-foreground outline-none transition-colors',
            TRIGGER_APPEARANCE[appearance],
            disabled && 'cursor-not-allowed opacity-50',
            className
          )}
        >
          {value ? (
            <>
              <AgentIcon id={value} size={16} className="rounded-xs" />
              <span
                className={cn('truncate', appearance === 'field' ? 'flex-1' : 'min-w-0 shrink')}
              >
                {selectedOption?.label ?? value}
              </span>
            </>
          ) : (
            <span
              className={cn(
                'truncate text-foreground-passive',
                appearance === 'field' ? 'flex-1' : 'min-w-0 shrink'
              )}
            >
              {placeholder}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
        </Combobox.Trigger>
        <Combobox.Content
          ref={setAnchorEl}
          width="content-at-least-trigger"
          className={cn('min-w-60', contentClassName)}
        >
          <Combobox.Input showTrigger={false} placeholder="Search agents…" />
          <Combobox.List>
            {(group: AgentGroup) => (
              <Combobox.Group key={group.value} items={group.items} className="pb-1">
                <Combobox.Label>{group.label}</Combobox.Label>
                <Combobox.Collection>
                  {(item: AgentOption) => {
                    const showInstall = canInstallAgentOption(item, installable);
                    return (
                      <Combobox.Item
                        key={item.value}
                        value={item}
                        disabled={isComboboxOptionDisabled(item)}
                        hoverableWhenDisabled={item.disabled}
                        className={cn(
                          'group/agent-row',
                          showInstall && 'data-disabled:opacity-100'
                        )}
                        {...hoverCard.getRowHoverProps(item.agentId)}
                      >
                        <AgentIcon
                          id={item.agentId}
                          size={16}
                          className={cn('rounded-xs', showInstall && 'opacity-50 grayscale')}
                        />
                        <span className="min-w-0 flex-1 py-1">
                          <span
                            className={cn(
                              'block truncate',
                              showInstall && 'text-foreground-passive'
                            )}
                          >
                            {item.label}
                          </span>
                          {item.disabledReason ? (
                            <span className="block truncate text-xs text-foreground-passive">
                              {item.disabledReason}
                            </span>
                          ) : null}
                        </span>
                        <AgentCapabilityIcons supportsChatUi={item.supportsAcp} />
                      </Combobox.Item>
                    );
                  }}
                </Combobox.Collection>
              </Combobox.Group>
            )}
          </Combobox.List>
        </Combobox.Content>
        <AgentHoverCard anchor={anchorEl} controller={hoverCard} connectionId={connectionId} />
      </Combobox.Root>
    );
  }
);
