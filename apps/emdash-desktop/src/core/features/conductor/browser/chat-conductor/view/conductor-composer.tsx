import { Button, DropdownMenu, Switch, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowUp, Ellipsis, Trash2 } from 'lucide-react';
import type { KeyboardEvent, Ref } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

export interface ConductorComposerProps {
  textareaRef: Ref<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  /** The conductor cannot run: the field is read-only. */
  disabled: boolean;
  canSend: boolean;
  onChange: (text: string) => void;
  onSend: () => void;
}

/**
 * The one field the developer writes to the conductor in. It starts as one line and grows with
 * what is typed; Enter sends, Shift+Enter starts a new line, and the send button sits inside the
 * field. Focus shows as an accent ring around the whole field.
 */
export function ConductorComposer({
  textareaRef,
  value,
  placeholder,
  disabled,
  canSend,
  onChange,
  onSend,
}: ConductorComposerProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  };
  return (
    <div
      className={cn(
        'flex items-end gap-1 rounded-lg border border-border bg-surface-emphasis pr-1.5 pl-4 transition-[border-color,box-shadow] duration-150',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25',
        disabled && 'opacity-60'
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        disabled={disabled}
        aria-label="Message the conductor"
        placeholder={placeholder}
        className="field-sizing-content max-h-60 min-w-0 flex-1 resize-none bg-transparent py-3 text-sm leading-normal text-foreground outline-none placeholder:text-foreground-passive disabled:cursor-not-allowed"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <span className="flex shrink-0 py-2">
        <Button
          type="button"
          variant={canSend ? 'primary' : 'ghost'}
          size="sm"
          icon
          aria-label="Send"
          disabled={!canSend}
          onClick={onSend}
        >
          <ArrowUp aria-hidden />
        </Button>
      </span>
    </div>
  );
}

export interface ComposerToolsProps {
  ready: boolean;
  autonomy: boolean;
  onAutonomyChange: (on: boolean) => void;
  onCatchUp: () => void;
  canClear: boolean;
  onClear: () => void;
}

/** The small controls under the composer: acting on the developer's behalf, catch-up, the menu. */
export function ComposerTools({
  ready,
  autonomy,
  onAutonomyChange,
  onCatchUp,
  canClear,
  onClear,
}: ComposerToolsProps) {
  return (
    <div className="mt-1.5 flex h-7 items-center gap-1 text-xs text-foreground-muted">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={<span className="flex h-6 items-center gap-2 rounded-md pr-1 pl-0.5" />}
        >
          <Switch
            size="sm"
            checked={autonomy}
            onCheckedChange={(on) => onAutonomyChange(on)}
            aria-label="Act on my behalf"
          />
          <span className="cursor-pointer select-none" onClick={() => onAutonomyChange(!autonomy)}>
            Act on my behalf
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" align="start" className="max-w-xs">
          On: when the agent finishes or asks something while you are away, the conductor may prompt
          it, answer it or interrupt it, within what you asked for. Off: it only tells you what
          happened and what it would do. What you ask for directly is always done.
        </Tooltip.Content>
      </Tooltip.Root>
      <Button type="button" variant="ghost" size="xs" disabled={!ready} onClick={onCatchUp}>
        Catch me up
      </Button>
      <span className="flex-1" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <Button type="button" variant="ghost" size="xs" icon aria-label="Thread options" />
          }
        >
          <Ellipsis aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" side="top" width="content">
          <DropdownMenu.Item variant="destructive" disabled={!canClear} onClick={onClear}>
            <Trash2 aria-hidden />
            Clear thread
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}
