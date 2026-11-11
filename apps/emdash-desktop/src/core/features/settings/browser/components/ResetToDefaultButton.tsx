import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { RotateCcw } from 'lucide-react';
import React from 'react';

interface ResetToDefaultButtonProps {
  /** Optional label shown in the tooltip: "Reset to default: <label>" */
  defaultLabel?: string;
  onReset: () => void;
  disabled?: boolean;
  visible?: boolean;
}

/**
 * The quiet reset next to a changed setting: a ghost icon button in the passive tone. When the
 * setting is at its default it keeps its 28px slot empty, so controls in a card stay aligned; in a
 * stacked (narrow) settings row the empty slot collapses so the control starts under the label.
 */
export const ResetToDefaultButton: React.FC<ResetToDefaultButtonProps> = ({
  defaultLabel,
  onReset,
  disabled,
  visible = true,
}) => {
  if (!visible) {
    return <span aria-hidden="true" className="size-7 shrink-0 @max-[26rem]:hidden" />;
  }

  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="shrink-0"
              onClick={onReset}
              disabled={disabled}
              aria-label="Reset to default"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          }
        />
        <Tooltip.Content side="top">
          {defaultLabel !== undefined ? `Reset to default: ${defaultLabel}` : 'Reset to default'}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};
