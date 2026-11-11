import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { TabHost } from '@core/primitives/workbench-shell/browser/tabs/core/tab-host';
import type {
  ResolvedTab,
  TabViewContext,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import { usePaneContext } from '../pane-context';
import { DraggableTab } from './draggable-tab';
import { TabCloseButton } from './tab-close-button';
import type { TabCommand } from './tab-commands';
import { TabContextMenu } from './tab-context-menu';
import { TabTitle } from './tab-title';

/** Props for GenericTabItem — aligns with TabBarItemProps<any> for convenience. */
export interface GenericTabItemProps {
  tab: ResolvedTab;
  host: TabHost;
  ctx: TabViewContext;
  /** Plain visible text; used as the default tooltip base and rename commit basis. */
  label: string;
  /** Tooltip base when different from label (e.g. full file path); preview hint appended. */
  tooltip?: string;
  /** Leading icon slot (file icon, agent icon, spinner). */
  preSlot?: ReactNode;
  /**
   * Overrides the default `<TabTitle>{label}</TabTitle>` for non-rename custom labels
   * (e.g. diff muted suffix). While editing, the inline input is shown regardless.
   */
  labelSlot?: ReactNode;
  /** Content shown under the absolutely-positioned close X (e.g. dirty dot, status icon). */
  statusSlot?: ReactNode;
  /** Renders the title in destructive color. */
  hasError?: boolean;
  /** Extra context-menu items placed after the engine commands. */
  kindCommands?: TabCommand[];
  /** Raw editable text prefilled into the rename input (defaults to label). */
  renameValue?: string;
  /** Max character length enforced on the rename input. */
  renameMaxLength?: number;
}

/**
 * Single generic tab chip renderer. Owns:
 * - Drag wrapper, click/keyboard interaction, active underline styling
 * - Context menu wrapping
 * - Preview tooltip/italic formatting
 * - Inline rename (label → input) driven by host.renameRequest
 * - Close button with optional status indicator underneath
 *
 * Each tab kind supplies only its slot config (preSlot, labelSlot, statusSlot,
 * kindCommands) plus label/tooltip/hasError.
 */
export const GenericTabItem = observer(function GenericTabItem({
  tab,
  host,
  ctx,
  label,
  tooltip,
  preSlot,
  labelSlot,
  statusSlot,
  hasError,
  kindCommands,
  renameValue,
  renameMaxLength,
}: GenericTabItemProps) {
  const { isFocusedPane, pane } = usePaneContext();
  const [isEditing, setIsEditing] = useState(false);
  const committedRef = useRef(false);

  const startRename = useCallback(() => {
    committedRef.current = false;
    window.setTimeout(() => setIsEditing(true), 0);
  }, []);

  const renameRequested = host.renameRequest?.tabId === tab.tabId;
  useEffect(() => {
    if (!renameRequested) return;
    startRename();
    host.clearRenameRequest();
  }, [renameRequested, startRename, host]);

  const commit = useCallback(
    (value: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      let next = value.trim();
      if (renameMaxLength != null) next = next.slice(0, renameMaxLength);
      if (next && next !== (renameValue ?? label)) host.commitRename(tab.tabId, next);
      setIsEditing(false);
    },
    [host, label, renameMaxLength, renameValue, tab.tabId]
  );

  const handleSelect = () => {
    host.setActiveTab(tab.tabId);
    // Container TabBar onClick will return focus to active content for mouse clicks.
    // Keyboard-initiated selection needs an explicit call since onClick won't fire.
  };

  const base = tooltip ?? label;
  const fullTitle = tab.isPreview ? `${base} (preview — double-click to keep)` : base;

  return (
    <TabContextMenu tab={tab} host={host} ctx={ctx} kindCommands={kindCommands}>
      <DraggableTab id={tab.tabId}>
        <div
          role="button"
          tabIndex={0}
          onMouseEnter={() => host.signalActivateIntent(tab.tabId)}
          onClick={handleSelect}
          onDoubleClick={() => host.pin(tab.tabId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelect();
              // Keyboard selection doesn't bubble as a click, so return focus explicitly.
              pane.focusActiveContent();
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              host.requestCloseTab(tab.tabId);
            }
          }}
          title={fullTitle}
          data-tabid={tab.tabId}
          data-active={tab.isActive || undefined}
          className={cn(
            // The active tab is cut from the content's surface and opens into it; the rest are
            // text on the strip. In a pane without focus the active tab's text steps down.
            'group relative flex h-[33px] cursor-pointer items-center rounded-t-md text-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            tab.isActive
              ? cn(
                  'bg-(--em-surface-paper)',
                  isFocusedPane ? 'text-foreground' : 'text-foreground-muted'
                )
              : 'text-foreground-passive hover:text-foreground-muted'
          )}
        >
          <div className="flex h-full items-center pr-2 pl-3">
            {preSlot && (
              // Inactive tabs are text first: their icons sit back until hovered.
              <span
                className={cn(
                  'flex shrink-0 items-center transition-opacity',
                  !tab.isActive && 'opacity-60 group-hover:opacity-100'
                )}
              >
                {preSlot}
              </span>
            )}
            {isEditing ? (
              <input
                ref={(el) => {
                  el?.focus();
                  el?.select();
                }}
                defaultValue={renameValue ?? label}
                maxLength={renameMaxLength}
                className="h-6 max-w-30 min-w-0 rounded-sm bg-(--em-surface-sunken) px-1.5 text-sm text-foreground ring-1 ring-border-1 outline-none focus:ring-ring"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commit(e.currentTarget.value);
                  else if (e.key === 'Escape') {
                    committedRef.current = true;
                    setIsEditing(false);
                  }
                }}
              />
            ) : (
              (labelSlot ?? (
                <TabTitle
                  isActive={tab.isActive}
                  isPreview={tab.isPreview}
                  hasError={hasError}
                  className="px-1.5"
                >
                  {label}
                </TabTitle>
              ))
            )}
            <TabCloseButton
              onClose={() => host.requestCloseTab(tab.tabId)}
              ariaLabel={`Close ${label}`}
              statusIndicator={statusSlot}
            />
          </div>
        </div>
      </DraggableTab>
    </TabContextMenu>
  );
});

/**
 * Generic drag ghost for any tab kind: the tab lifted one surface step, with a hairline instead
 * of a shadow (dark draws none), at the tab's own height.
 */
export function GenericTabDragPreview({ preSlot, label }: { preSlot?: ReactNode; label: string }) {
  return (
    <div className="surface-elevated flex h-8 cursor-grabbing items-center gap-1.5 rounded-md bg-surface px-3 text-sm text-foreground ring-1 ring-border-subtle">
      {preSlot}
      <span className="max-w-50 truncate">{label}</span>
    </div>
  );
}
