import {
  ArrowLeft,
  BellRing,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Eye,
  Group,
  Inbox,
  Layers,
  LayoutPanelTop,
  Maximize,
  Plus,
  Redo2,
  SquareDashed,
  StickyNote,
  Undo2,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { DeskEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { GATHER_PHRASES } from '../api/canvas-desks';
import type { OrganizeBy } from '../api/canvas-layout';
import { MAX_PANES } from '../api/canvas-panes';
import { adjacentRegion } from '../api/region-tiling';
import { getCanvasStore } from '../contributions/browser/app-stores';
import { regionStyle } from './tiles/region-node';

const ORGANIZE_OPTIONS: { value: OrganizeBy | 'tidy'; label: string }[] = [
  { value: 'tidy', label: 'Tidy up' },
  { value: 'task', label: 'Group by task' },
  { value: 'project', label: 'Group by project' },
  { value: 'status', label: 'Group by status' },
  { value: 'provider', label: 'Group by agent type' },
];

const VIEW_OPTIONS = Array.from({ length: MAX_PANES }, (_, index) => index + 1);

export const CanvasToolbar = observer(function CanvasToolbar() {
  const store = getCanvasStore();
  const attention = store.attentionEntries.length;
  const hidden = store.state.hiddenConversationIds.length;
  const working = store.visibleAgentEntries.filter((entry) => entry.status === 'working').length;
  const selected = store.selection.length;
  const scope = store.currentRegion();
  const inside = store.focusedRegionId;
  const pro = store.proMode;

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 text-xs shadow-md backdrop-blur',
        // Many desks on a narrow window: the bar takes a second row rather than squeezing.
        pro && 'flex-wrap'
      )}
    >
      <ToolbarButton
        label={
          pro
            ? 'Canvas Pro: one desk at a time. Click for the classic canvas (one board)'
            : 'Switch to Canvas Pro: desks you swap between, one at a time'
        }
        onClick={() => store.setMode(pro ? 'classic' : 'pro')}
        className={pro ? 'text-violet-700 dark:text-violet-300' : 'text-foreground-muted'}
      >
        <Layers className="size-3.5" />
        {pro && 'Pro'}
      </ToolbarButton>
      {pro && <DeskStrip />}
      {pro && <VisitorSegment />}
      {/* On a desk the strip says where you are; inside one of its regions, the way back out. */}
      {inside && !(pro && inside === store.activeDeskId) && <ScopeSegment regionId={inside} />}
      {/* Canvas Pro keeps the bar to one row: the filter shows only when there is one to make. */}
      {(!pro || store.projectFilter !== null || store.projectOptions.length > 1) && (
        <select
          aria-label="Project filter"
          value={store.projectFilter ?? ''}
          onChange={(event) => store.setProjectFilter(event.currentTarget.value || null)}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
        >
          <option value="">All projects</option>
          {store.projectOptions.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      )}
      <ToolbarButton
        label={inside ? 'Fit this sub-canvas to the screen' : 'Fit all agents'}
        onClick={() => (inside ? store.refitScope() : store.requestFit())}
      >
        <Maximize className="size-3.5" />
        {!pro && 'Fit'}
      </ToolbarButton>
      <ToolbarButton label="Add a note" onClick={() => store.addNote()}>
        <StickyNote className="size-3.5" />
        {!pro && 'Note'}
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        label={store.undoLabel ? `Undo: ${store.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        onClick={() => store.undo()}
        disabled={!store.canUndo}
      >
        <Undo2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label={store.redoLabel ? `Redo: ${store.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
        onClick={() => store.redo()}
        disabled={!store.canRedo}
      >
        <Redo2 className="size-3.5" />
      </ToolbarButton>
      <select
        aria-label="Organize the board"
        title={scope ? 'Organize the windows in this region' : 'Organize the board'}
        value=""
        onChange={(event) => {
          const value = event.currentTarget.value as OrganizeBy | 'tidy' | '';
          if (!value) return;
          store.runLayout(
            [
              value === 'tidy'
                ? { op: 'arrange', targets: null, scope, layout: 'tidy' }
                : { op: 'organize', scope, by: value },
            ],
            { source: 'command', allowPreview: true }
          );
        }}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
      >
        <option value="">Organize…</option>
        {ORGANIZE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {/* Canvas Pro: an empty top-level region would be a desk, and the strip's + makes those. */}
      {(!pro || selected > 0) && (
        <ToolbarButton
          label={
            selected > 0
              ? 'Group the selected windows into a region (Ctrl+G)'
              : 'New empty region (select windows first to group them)'
          }
          onClick={() => {
            if (selected > 0) store.groupSelection();
            else {
              const result = store.runLayout([{ op: 'createRegion', members: [] }], {
                source: 'command',
              });
              const created = result.ok ? result.plan.created[0] : undefined;
              if (created) store.goToRegion(created);
              if (created) store.setRenamingRegion(created);
            }
          }}
        >
          {selected > 0 ? <Boxes className="size-3.5" /> : <SquareDashed className="size-3.5" />}
          {selected > 0 ? `Group ${selected}` : 'Region'}
        </ToolbarButton>
      )}
      <ToolbarButton
        label="Open the selection, or the region in view, on the stage (Ctrl+Enter)"
        onClick={() => store.stageSelection()}
        disabled={selected === 0 && !scope && !store.focusedTileId}
      >
        <LayoutPanelTop className="size-3.5" />
        {!pro && 'Stage'}
      </ToolbarButton>
      {!pro && (
        <select
          aria-label="Canvas views"
          title="Multi-canvas: split the canvas into side-by-side views, each with its own pan and zoom (Ctrl+Alt+1 to 4)"
          value={store.paneCount}
          onChange={(event) => store.setPaneCount(Number(event.currentTarget.value))}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
        >
          {VIEW_OPTIONS.map((count) => (
            <option key={count} value={count}>
              {count === 1 ? '1 view' : `${count} views`}
            </option>
          ))}
        </select>
      )}
      <Divider />
      <ToolbarButton
        label="Jump to the agent that has waited longest for you"
        onClick={() => store.focusNextAttention()}
        disabled={attention === 0}
        className={attention > 0 ? 'text-amber-700 dark:text-amber-300' : undefined}
      >
        <BellRing className="size-3.5" />
        {attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : 'All clear'}
      </ToolbarButton>
      <ToolbarButton
        label={store.showTaskFrames ? 'Hide task frames' : 'Show task frames'}
        onClick={() => store.setShowTaskFrames(!store.showTaskFrames)}
        className={store.showTaskFrames ? undefined : 'text-foreground-muted'}
      >
        <Group className="size-3.5" />
        {!pro && 'Frames'}
      </ToolbarButton>
      {hidden > 0 && (
        <ToolbarButton label="Show hidden agents" onClick={() => store.showAllConversations()}>
          <Eye className="size-3.5" />
          {hidden} hidden
        </ToolbarButton>
      )}
      {/* In Canvas Pro the desk strip carries the counts, desk by desk. */}
      {!pro && (
        <span className="px-2 text-foreground-muted tabular-nums">
          {store.visibleAgentEntries.length} agents · {working} working
        </span>
      )}
    </div>
  );
});

/** Canvas Pro: the desks in order. Click to swap, double-click to rename, + for a new one. */
const DeskStrip = observer(function DeskStrip() {
  const store = getCanvasStore();
  const desks = store.desks;
  return (
    <>
      <div role="tablist" aria-label="Desks" className="flex items-center gap-0.5">
        {desks.map((desk) =>
          store.renamingRegionId === desk.regionId ? (
            <DeskNameField key={desk.regionId} desk={desk} />
          ) : (
            <DeskChip key={desk.regionId} desk={desk} removable={desks.length > 1} />
          )
        )}
        <ToolbarButton
          label="New desk"
          onClick={() => {
            const created = store.createDesk();
            if (created) store.setRenamingRegion(created);
          }}
        >
          <Plus className="size-3.5" />
        </ToolbarButton>
      </div>
      <DeskPager />
      <Divider />
    </>
  );
});

/**
 * Canvas Pro: the pages of a desk that holds more windows than fit one screen comfortably. Each
 * page shows what is waiting on it, so nothing out of view goes unnoticed.
 */
const DeskPager = observer(function DeskPager() {
  const store = getCanvasStore();
  const pages = store.deskPager;
  if (pages.length < 2) return null;
  return (
    <div role="tablist" aria-label="Pages of this desk" className="flex items-center gap-0.5 pl-1">
      {pages.map((page) => {
        const status =
          page.waiting > 0
            ? 'bg-amber-500 motion-safe:animate-pulse'
            : page.failed > 0
              ? 'bg-rose-500'
              : page.working > 0
                ? 'bg-blue-500'
                : null;
        const waiting =
          page.waiting > 0 ? `, ${page.waiting} need${page.waiting === 1 ? 's' : ''} you` : '';
        return (
          <button
            key={page.index}
            type="button"
            role="tab"
            aria-selected={page.active}
            title={`Page ${page.index + 1} of ${pages.length}: ${page.windowCount} window${page.windowCount === 1 ? '' : 's'}${waiting} (Alt+PageUp / PageDown)`}
            onClick={() => store.setDeskPage(page.index)}
            className={cn(
              'flex h-7 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 tabular-nums',
              page.active
                ? 'bg-background-secondary font-medium text-foreground'
                : 'text-foreground-muted hover:bg-background-secondary hover:text-foreground'
            )}
          >
            {page.index + 1}
            {status && <span className={cn('size-1.5 shrink-0 rounded-full', status)} />}
          </button>
        );
      })}
    </div>
  );
});

function deskTitle(desk: DeskEntry): string {
  const count = `${desk.windowCount} window${desk.windowCount === 1 ? '' : 's'}`;
  const summary = desk.summary ? `, ${desk.summary}` : '';
  const gather = desk.gather ? `. Gathers agents that ${GATHER_PHRASES[desk.gather]}` : '';
  return `Desk ${desk.index + 1}: ${desk.name} (${count}${summary})${gather}`;
}

const DeskChip = observer(function DeskChip({
  desk,
  removable,
}: {
  desk: DeskEntry;
  removable: boolean;
}) {
  const store = getCanvasStore();
  const status =
    desk.waiting > 0
      ? 'bg-amber-500 motion-safe:animate-pulse'
      : desk.failed > 0
        ? 'bg-rose-500'
        : desk.working > 0
          ? 'bg-blue-500'
          : null;
  return (
    <span className="group relative flex items-center">
      <button
        type="button"
        role="tab"
        aria-selected={desk.active}
        title={deskTitle(desk)}
        onClick={() => store.switchDesk(desk.regionId)}
        onDoubleClick={() => store.setRenamingRegion(desk.regionId)}
        className={cn(
          'flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium whitespace-nowrap',
          desk.active
            ? regionStyle(desk.color).chip
            : 'text-foreground-muted hover:bg-background-secondary hover:text-foreground'
        )}
      >
        <span className="truncate">{desk.name}</span>
        {desk.gather ? (
          <Inbox className="size-3 shrink-0 opacity-70" />
        ) : (
          <span className="tabular-nums opacity-60">{desk.windowCount}</span>
        )}
        {status && <span className={cn('size-1.5 shrink-0 rounded-full', status)} />}
      </button>
      {desk.active && removable && (
        <button
          type="button"
          aria-label={`Remove the ${desk.name} desk`}
          title={`Remove ${desk.name}; its windows move to the desk before it`}
          onClick={() => store.removeDesk(desk.regionId)}
          className="absolute -top-1.5 -right-1 hidden size-3.5 items-center justify-center rounded-full border border-border bg-background text-foreground-muted group-hover:flex hover:text-foreground"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
});

function DeskNameField({ desk }: { desk: DeskEntry }) {
  const store = getCanvasStore();
  const [name, setName] = useState(desk.name);
  const commit = () => {
    const next = name.trim();
    if (next && next !== desk.name) {
      store.runLayout([{ op: 'renameRegion', region: desk.regionId, name: next }], {
        source: 'pointer',
      });
    }
    store.setRenamingRegion(null);
  };
  return (
    <input
      autoFocus
      aria-label="Desk name"
      value={name}
      maxLength={40}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setName(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') store.setRenamingRegion(null);
      }}
      className="h-7 w-32 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none"
    />
  );
}

/** Canvas Pro: windows visiting this desk from others, and what to do with them. */
const VisitorSegment = observer(function VisitorSegment() {
  const store = getCanvasStore();
  const visitors = store.visitors;
  if (visitors.length === 0) return null;
  const names = visitors.map((id) => store.windowName(id));
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` +${names.length - 2}` : '';
  return (
    <>
      <span
        className="max-w-56 shrink-0 truncate px-1 font-medium text-violet-700 dark:text-violet-300"
        title={`Visiting from other desks: ${names.join(', ')}. They go back when you switch desks.`}
      >
        Visiting: {shown}
        {more}
      </span>
      <ToolbarButton
        label="Send the visiting windows back to their own desks"
        onClick={() => store.sendBack()}
        className="shrink-0 whitespace-nowrap"
      >
        Send back
      </ToolbarButton>
      <ToolbarButton
        label="Keep the visiting windows on this desk"
        onClick={() => store.keepVisitors()}
        className="shrink-0 whitespace-nowrap"
      >
        Keep
      </ToolbarButton>
      <Divider />
    </>
  );
});

/**
 * While the user is in a sub-canvas: the way out (to its parent or the main canvas), where they
 * are, and the sub-canvases beside it.
 */
const ScopeSegment = observer(function ScopeSegment({ regionId }: { regionId: string }) {
  const store = getCanvasStore();
  const region = store.regionEntry(regionId);
  if (!region) return null;
  const parent = region.parentId ? store.regionEntry(region.parentId) : undefined;
  const layout = store.layoutState;
  const previous = adjacentRegion(layout, regionId, -1);
  const next = adjacentRegion(layout, regionId, 1);
  const nameOf = (id: string | null) => (id ? (layout.regions[id]?.name ?? 'Sub-canvas') : '');
  return (
    <>
      <ToolbarButton
        label={`Back to ${parent ? parent.name : 'the main canvas'} (Esc)`}
        onClick={() => store.up()}
        className="text-blue-700 dark:text-blue-300"
      >
        <ArrowLeft className="size-3.5" />
        {parent ? parent.name : 'Main canvas'}
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        label={
          previous
            ? `Previous sub-canvas: ${nameOf(previous)} (Ctrl+Alt+PageUp)`
            : 'No other sub-canvas here'
        }
        onClick={() => store.goToAdjacentRegion(-1)}
        disabled={!previous}
      >
        <ChevronLeft className="size-3.5" />
      </ToolbarButton>
      <span
        className="max-w-48 truncate px-1 text-sm font-semibold text-foreground"
        title={region.name}
      >
        {region.name}
      </span>
      <span className="text-foreground-muted tabular-nums">
        {region.windowCount} window{region.windowCount === 1 ? '' : 's'}
      </span>
      <ToolbarButton
        label={
          next ? `Next sub-canvas: ${nameOf(next)} (Ctrl+Alt+PageDown)` : 'No other sub-canvas here'
        }
        onClick={() => store.goToAdjacentRegion(1)}
        disabled={!next}
      >
        <ChevronRight className="size-3.5" />
      </ToolbarButton>
      <Divider />
    </>
  );
});

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" />;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-foreground hover:bg-background-secondary disabled:opacity-50 disabled:hover:bg-transparent',
        className
      )}
    >
      {children}
    </button>
  );
}
