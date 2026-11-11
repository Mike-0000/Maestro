import { useDraggable } from '@dnd-kit/core';
import type {
  TerminalShellAvailability,
  TerminalShellId,
} from '@emdash/core/primitives/terminal-shell/api';
import { ScriptStatus, type ScriptStatusKind } from '@emdash/ui/react/components';
import { Button, DropdownMenu, Tabs, Tooltip } from '@emdash/ui/react/primitives';
import { ChevronDown, LoaderCircle, Pause, Play, Plus, RefreshCw, Terminal, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  TERMINAL_DRAWER_DRAG_TYPE,
  type TerminalDrawerDragData,
} from '@core/features/terminals/api/browser/task-terminal/terminal-drag';
import type { TerminalStore } from '@core/features/terminals/api/browser/task-terminal/terminal-manager';
import { TerminalShellOptionLabel } from '@core/features/terminals/contributions/browser/terminal-shell-option-label';
import {
  type LifecycleScriptStatus,
  type LifecycleScriptsStore,
} from '@core/features/workspaces/api/browser/lifecycle-scripts';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { cn } from '@core/primitives/styling/browser/cn';

export type TerminalDrawerMode = 'terminals' | 'scripts';

export type TerminalShellMenuState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'error'; message: string }>
  | Readonly<{ kind: 'ready'; availability: TerminalShellAvailability[] }>;

interface TerminalDrawerTabBarProps {
  isFocused: boolean;
  mode: TerminalDrawerMode;
  onModeChange: (mode: TerminalDrawerMode) => void;
  lifecycleScriptsMgr: LifecycleScriptsStore | null;
  activeScriptId: string | undefined;
  onSelectScript: (id: string) => void;
  onRunScript: (id: string) => void;
  onStopScript: (id: string) => void;
  /** Terminals shown in the drawer — the panel filters out those open in a main pane. */
  terminals: TerminalStore[];
  activeTerminalId: string | undefined;
  shellMenuState: TerminalShellMenuState;
  onShellMenuOpen: () => void;
  onRetryShellAvailability: () => void;
  onSelectTerminal: (id: string) => void;
  onAddTerminal: (shell?: TerminalShellId) => void;
  onRemoveTerminal: (id: string) => void;
  onRenameTerminal: (id: string, name: string) => void;
  onHoverTerminal?: (id: string) => void;
  projectId: string;
  liveActionsDisabled: boolean;
  className?: string;
}

const SCRIPT_STATUS_MAP: Record<LifecycleScriptStatus, ScriptStatusKind> = {
  idle: 'waiting',
  running: 'in-progress',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'cancelled',
};

export const TerminalDrawerTabBar = observer(function TerminalDrawerTabBar({
  isFocused,
  mode,
  onModeChange,
  lifecycleScriptsMgr,
  activeScriptId,
  onSelectScript,
  onRunScript,
  onStopScript,
  terminals,
  activeTerminalId,
  shellMenuState,
  onShellMenuOpen,
  onRetryShellAvailability,
  onSelectTerminal,
  onAddTerminal,
  onRemoveTerminal,
  onRenameTerminal,
  onHoverTerminal,
  projectId,
  liveActionsDisabled,
  className,
}: TerminalDrawerTabBarProps) {
  const scripts = lifecycleScriptsMgr?.tabs ?? [];

  // The drawer's strip is chrome, like the main tab strip: the sunken surface with no rule, the
  // active tab cut from the terminal's paper so it opens into it, the rest plain text.
  return (
    <div
      className={cn(
        'surface-sunken flex h-9 shrink-0 items-end gap-2 overflow-hidden bg-(--em-surface) pr-2 text-sm',
        className
      )}
    >
      <div
        className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden pl-1.5"
        role="tablist"
        aria-label={mode === 'terminals' ? 'Terminals' : 'Scripts'}
      >
        {mode === 'terminals' ? (
          <>
            {terminals.map((terminal) => (
              <DrawerItemTab
                key={terminal.data.id}
                id={`terminal-drawer-${terminal.data.id}`}
                icon={<Terminal className="size-3.5" />}
                label={terminal.data.name}
                isActive={activeTerminalId === terminal.data.id}
                isFocused={isFocused}
                dragData={{
                  type: TERMINAL_DRAWER_DRAG_TYPE,
                  terminalId: terminal.data.id,
                  label: terminal.data.name,
                }}
                onSelect={() => onSelectTerminal(terminal.data.id)}
                onRename={(name) => onRenameTerminal(terminal.data.id, name)}
                onHover={onHoverTerminal ? () => onHoverTerminal(terminal.data.id) : undefined}
                action={
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      render={
                        <button
                          type="button"
                          aria-label={`Close ${terminal.data.name}`}
                          className="mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-passive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemoveTerminal(terminal.data.id);
                          }}
                        />
                      }
                    >
                      <X className="size-3.5" />
                    </Tooltip.Trigger>
                    <Tooltip.Content>Close terminal</Tooltip.Content>
                  </Tooltip.Root>
                }
              />
            ))}
            <projectAvailabilityUi.LiveActionGuard projectId={projectId}>
              <NewTerminalButton
                disabled={liveActionsDisabled}
                shellMenuState={shellMenuState}
                onShellMenuOpen={onShellMenuOpen}
                onRetryShellAvailability={onRetryShellAvailability}
                onAddTerminal={onAddTerminal}
              />
            </projectAvailabilityUi.LiveActionGuard>
          </>
        ) : (
          scripts.map((script) => (
            <DrawerItemTab
              key={script.data.id}
              id={`script-drawer-${script.data.id}`}
              icon={<ScriptStatus status={SCRIPT_STATUS_MAP[script.status]} size={14} />}
              label={script.data.label}
              isActive={activeScriptId === script.data.id}
              isFocused={isFocused}
              onSelect={() => onSelectScript(script.data.id)}
              iconAction={
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <button
                        type="button"
                        aria-label={
                          script.isRunning
                            ? `Stop ${script.data.label} script`
                            : `Run ${script.data.label} script`
                        }
                        className="flex size-3.5 items-center justify-center rounded-xs text-foreground-passive hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (script.isRunning) {
                            onStopScript(script.data.id);
                          } else {
                            onRunScript(script.data.id);
                          }
                        }}
                      />
                    }
                  >
                    {script.isRunning ? (
                      <Pause className="size-3.5" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                  </Tooltip.Trigger>
                  <Tooltip.Content>{script.isRunning ? 'Stop' : 'Run'}</Tooltip.Content>
                </Tooltip.Root>
              }
            />
          ))
        )}
      </div>
      <Tabs.Root
        className="self-center"
        value={mode}
        onValueChange={(value) => onModeChange(value as typeof mode)}
      >
        <Tabs.List variant="underline" aria-label="Drawer contents">
          <Tabs.Tab value="terminals" size="sm">
            Terminals
          </Tabs.Tab>
          <Tabs.Tab value="scripts" size="sm">
            Scripts
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
});

export function NewTerminalButton({
  disabled = false,
  shellMenuState,
  onShellMenuOpen,
  onRetryShellAvailability,
  onAddTerminal,
}: {
  disabled?: boolean;
  shellMenuState: TerminalShellMenuState;
  onShellMenuOpen: () => void;
  onRetryShellAvailability: () => void;
  onAddTerminal: (shell?: TerminalShellId) => void;
}) {
  return (
    <div className="flex shrink-0 items-center self-center pl-1">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              disabled={disabled}
              variant="ghost"
              size="xs"
              icon
              className="rounded-r-none"
              aria-label="New terminal"
              onClick={() => onAddTerminal()}
            />
          }
        >
          <Plus className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          New terminal <BoundShortcut command="task.newTerminal" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
      <DropdownMenu.Root onOpenChange={(open) => open && onShellMenuOpen()}>
        <DropdownMenu.Trigger
          render={
            <Button
              disabled={disabled}
              variant="ghost"
              size="xs"
              icon
              className="w-4 rounded-l-none"
              aria-label="New terminal with shell"
            />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" width="content">
          {shellMenuState.kind === 'loading' ? (
            <DropdownMenu.Item disabled>
              <LoaderCircle className="animate-spin" />
              Loading shells…
            </DropdownMenu.Item>
          ) : shellMenuState.kind === 'error' ? (
            <DropdownMenu.Item title={shellMenuState.message} onClick={onRetryShellAvailability}>
              <RefreshCw />
              Failed to load shells
            </DropdownMenu.Item>
          ) : shellMenuState.availability.length === 0 ? (
            <DropdownMenu.Item disabled>No shells found</DropdownMenu.Item>
          ) : (
            shellMenuState.availability.map((entry) => (
              <DropdownMenu.Item
                key={entry.id}
                disabled={!entry.available}
                title={entry.reason}
                onClick={() => onAddTerminal(entry.id)}
              >
                <TerminalShellOptionLabel entry={entry} />
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}

interface DrawerItemTabProps {
  id: string;
  icon: ReactNode;
  label: string;
  isActive: boolean;
  isFocused: boolean;
  onSelect: () => void;
  onRename?: (name: string) => void;
  onHover?: () => void;
  iconAction?: ReactNode;
  action?: ReactNode;
  dragData?: TerminalDrawerDragData;
}

function DrawerItemTab({
  id,
  icon,
  label,
  isActive,
  isFocused,
  onSelect,
  onRename,
  onHover,
  iconAction,
  action,
  dragData,
}: DrawerItemTabProps) {
  const [isEditing, setIsEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id,
    data: dragData,
    disabled: !dragData,
  });

  return (
    <div
      ref={setDragRef}
      className={cn(
        'group relative flex h-[30px] max-w-48 shrink-0 items-center rounded-t-md transition-colors',
        // Like the main tab strip: the active tab is the terminal's paper; in a drawer without
        // focus its text steps down. The others are text on the chrome.
        isActive
          ? cn('bg-(--em-surface-paper)', isFocused ? 'text-foreground' : 'text-foreground-muted')
          : 'text-foreground-passive hover:text-foreground-muted',
        isDragging && 'opacity-50'
      )}
    >
      {isEditing && onRename ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
          <span className="shrink-0">{icon}</span>
          <InlineRenameInput
            initialValue={label}
            onConfirm={(name) => {
              setIsEditing(false);
              if (name && name !== label) onRename(name);
            }}
            onCancel={() => setIsEditing(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          {...attributes}
          {...listeners}
          role="tab"
          aria-selected={isActive}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-md px-3 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            dragData && 'cursor-grab active:cursor-grabbing'
          )}
          onClick={onSelect}
          onMouseEnter={onHover}
          onDoubleClick={(event) => {
            if (!onRename) return;
            event.stopPropagation();
            setIsEditing(true);
          }}
        >
          <span
            className={cn(
              'flex shrink-0 items-center transition-opacity',
              !isActive && 'opacity-60 group-hover:opacity-100',
              iconAction && 'group-hover:opacity-0 group-focus-within:opacity-0'
            )}
          >
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </button>
      )}
      {!isEditing && iconAction && (
        <span className="absolute top-1/2 left-3 z-10 flex size-3.5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {iconAction}
        </span>
      )}
      {!isEditing && action}
    </div>
  );
}

function InlineRenameInput({
  initialValue,
  onConfirm,
  onCancel,
}: {
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="h-6 min-w-0 flex-1 rounded-sm bg-(--em-surface-sunken) px-1.5 text-sm text-foreground ring-1 ring-border-1 outline-none focus:ring-ring"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onConfirm(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onConfirm(value);
        if (event.key === 'Escape') onCancel();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}
