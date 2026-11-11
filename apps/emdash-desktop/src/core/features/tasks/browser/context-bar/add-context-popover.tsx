import { Combobox } from '@emdash/ui/react/primitives';
import { ChevronDown, ChevronUp, MessageSquare, TextInitial } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useChordKeydown } from '@core/primitives/keybindings/browser';
import { Shortcut } from '@core/primitives/keybindings/browser/shortcut';
import { cn } from '@core/primitives/styling/browser/cn';
import { ProviderLogo } from '../components/issue-selector/issue-selector';
import { buildContextActionText, type ContextAction } from '../context-bar/context-actions';

const ADD_CONTEXT_HOTKEY = 'Mod+Shift+A';
type AddContextPopoverSide = 'top' | 'bottom';

export function ActionItemBaseRow({
  icon,
  label,
  text,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <span className="text-foreground-passive">{icon}</span>
        <div className="max-w-56 truncate text-sm">{label}</div>
      </div>
      <div className="min-w-0 truncate text-xs text-foreground-passive">{text}</div>
    </div>
  );
}

export function ActionItemRow({ action }: { action: ContextAction }) {
  switch (action.kind) {
    case 'linked-issue':
      return (
        <ActionItemBaseRow
          icon={<ProviderLogo provider={action.provider} className="h-3.5 w-3.5 shrink-0" />}
          label={action.issue.title}
          text={action.issue.identifier}
        />
      );
    case 'draft-comments':
      return (
        <ActionItemBaseRow
          icon={<MessageSquare className="size-3.5 shrink-0" />}
          label="Line comments"
          text={`${action.commentCount} comment${action.commentCount !== 1 ? 's' : ''} in ${action.fileCount} file${action.fileCount !== 1 ? 's' : ''}`}
        />
      );
    case 'prompt':
      return (
        <ActionItemBaseRow
          icon={<TextInitial className="size-3.5 shrink-0" />}
          label={action.prompt.title}
          text={action.prompt.prompt}
        />
      );
    default:
      return null;
  }
}

export interface AddContextPopoverProps {
  actions: ContextAction[];
  disabled: boolean;
  emptyMessage?: string;
  hideTrigger?: boolean;
  hotkeyEnabled?: boolean;
  isActivePane?: boolean;
  onApplyAction: (
    text: string,
    action: ContextAction,
    opts?: { andSend?: boolean }
  ) => Promise<void>;
  /** Replace the default "Add context" button with a custom trigger. */
  renderTrigger?: (ctx: { open: boolean; disabled: boolean }) => ReactNode;
  side?: AddContextPopoverSide;
}

export function AddContextPopover({
  actions,
  disabled,
  emptyMessage = 'No context found',
  hideTrigger = false,
  hotkeyEnabled,
  isActivePane = true,
  onApplyAction,
  renderTrigger,
  side = 'top',
}: AddContextPopoverProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ContextAction | null>(null);
  const [query, setQuery] = useState('');
  const ignoreOpenUntilRef = useRef(0);

  const filteredActions = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((action) => {
      switch (action.kind) {
        case 'linked-issue':
          return (
            action.issue.title.toLowerCase().includes(q) ||
            action.issue.identifier.toLowerCase().includes(q)
          );
        case 'draft-comments':
          return 'line comments'.includes(q);
        case 'prompt':
          return (
            action.prompt.title.toLowerCase().includes(q) ||
            action.prompt.prompt.toLowerCase().includes(q)
          );
      }
    });
  }, [query, actions]);

  useChordKeydown(
    ADD_CONTEXT_HOTKEY,
    (event) => {
      event.preventDefault();
      setOpen((value) => !value);
    },
    { enabled: (hotkeyEnabled ?? !disabled) && isActivePane }
  );

  const handleConfirm = (action: ContextAction | null, opts?: { andSend?: boolean }) => {
    if (!action) return;
    const text = buildContextActionText(action);
    void onApplyAction(text, action, opts);
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && Date.now() < ignoreOpenUntilRef.current) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) setQuery('');
  };

  const blockComboboxOpenForContextMenu = () => {
    ignoreOpenUntilRef.current = Date.now() + 500;
  };

  const blockSyntheticClickAfterContextMenu = (event: React.SyntheticEvent) => {
    if (Date.now() >= ignoreOpenUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Combobox.Root
      items={[{ value: 'items', items: filteredActions }]}
      value={null}
      onInputValueChange={(value) => setQuery(value ?? '')}
      inputValue={query}
      onValueChange={(action) => handleConfirm(action)}
      onItemHighlighted={(value) => setSelected(value ?? null)}
      open={open}
      onOpenChange={handleOpenChange}
      // 'always' highlights the first item on open; Base UI types narrow to boolean
      // but the runtime accepts the string literal
      autoHighlight={'always' as unknown as boolean}
    >
      <Combobox.Trigger
        disabled={disabled}
        onContextMenuCapture={() => blockComboboxOpenForContextMenu()}
        onPointerDownCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
        }}
        onMouseDownCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
        }}
        onClickCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
          blockSyntheticClickAfterContextMenu(event);
        }}
        aria-hidden={hideTrigger || undefined}
        tabIndex={hideTrigger ? -1 : undefined}
        className={cn(
          hideTrigger
            ? 'pointer-events-none absolute bottom-0 left-1/2 size-px -translate-x-1/2 overflow-hidden border-0 p-0 opacity-0'
            : renderTrigger
              ? undefined
              : 'flex h-7 items-center justify-between gap-3 rounded-md px-2 text-xs text-foreground-passive transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-surface-hover data-popup-open:text-foreground'
        )}
      >
        {hideTrigger ? null : renderTrigger ? (
          renderTrigger({ open, disabled })
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              {open ? (
                <ChevronUp className="size-3 shrink-0" />
              ) : (
                <ChevronDown className="size-3 shrink-0" />
              )}
              <span>Add context</span>
            </span>
            <Shortcut hotkey={ADD_CONTEXT_HOTKEY} variant="keycaps" />
          </>
        )}
      </Combobox.Trigger>

      <Combobox.Content
        side={side}
        align="center"
        className="flex flex-col"
        style={{ width: 'min(27rem, calc(100vw - 2rem), var(--available-width))' }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleConfirm(selected ?? filteredActions[0] ?? null, { andSend: true });
          }
        }}
      >
        <Combobox.Input showTrigger={false} placeholder="Search context…" />
        <Combobox.List className="flex-1">
          {(group: { value: string; items: ContextAction[] }) => (
            <Combobox.Group items={group.items}>
              <Combobox.Collection>
                {(action: ContextAction) => (
                  <Combobox.Item key={action.id} value={action}>
                    <ActionItemRow action={action} />
                  </Combobox.Item>
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
        <Combobox.Empty className="flex flex-1 items-center justify-center">
          {emptyMessage}
        </Combobox.Empty>
        {/* Hints in the caption role, set apart by space rather than a rule. */}
        <div className="flex items-center justify-end gap-4 px-2 pt-1 pb-1.5 text-tiny text-foreground-passive">
          <span className="flex items-center gap-1.5">
            Add to input
            <Shortcut hotkey="Enter" variant="keycaps" />
          </span>
        </div>
      </Combobox.Content>
    </Combobox.Root>
  );
}
