import { StateGlyph } from '@emdash/ui/react/components';
import { Button, DropdownMenu, Input, Select } from '@emdash/ui/react/primitives';
import {
  ArrowLeft,
  BellRing,
  Boxes,
  ChevronDown,
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
import { FLOATING_LAYER, regionTint, TINT_SWATCH } from './canvas-styles';

const ORGANIZE_OPTIONS: { value: OrganizeBy | 'tidy'; label: string }[] = [
  { value: 'tidy', label: 'Tidy up' },
  { value: 'task', label: 'Group by task' },
  { value: 'project', label: 'Group by project' },
  { value: 'status', label: 'Group by status' },
  { value: 'provider', label: 'Group by agent type' },
];

const VIEW_OPTIONS = Array.from({ length: MAX_PANES }, (_, index) => index + 1);
const viewsLabel = (count: number) => (count === 1 ? '1 view' : `${count} views`);

/** The state mark for a group of windows: what needs you first, then a failure, then work. */
function groupGlyph(group: { waiting: number; failed: number; working: number }) {
  if (group.waiting > 0) return <StateGlyph state="needs-you" size="sm" />;
  if (group.failed > 0) return <StateGlyph state="error" size="sm" />;
  if (group.working > 0) return <StateGlyph state="working" size="sm" />;
  return null;
}

/**
 * The board's toolbar: one calm floating bar of quiet buttons. Toggles show their state as a
 * pressed button, not a colour; the count of agents that need you uses the state mark.
 */
export const CanvasToolbar = observer(function CanvasToolbar() {
  const store = getCanvasStore();
  const attention = store.attentionEntries.length;
  const hidden = store.state.hiddenConversationIds.length;
  const working = store.visibleAgentEntries.filter((entry) => entry.status === 'working').length;
  const selected = store.selection.length;
  const scope = store.currentRegion();
  const inside = store.focusedRegionId;
  const pro = store.proMode;
  const projectName = store.projectOptions.find(
    (project) => project.id === store.projectFilter
  )?.name;

  return (
    <div
      // A narrow window (or many desks): the bar takes a second row rather than running off the
      // edge of the board.
      className={cn(FLOATING_LAYER, 'flex flex-wrap items-center gap-0.5 rounded-lg p-1')}
    >
      <ToolbarButton
        label={
          pro
            ? 'Canvas Pro: one desk at a time. Click for the classic canvas (one board)'
            : 'Switch to Canvas Pro: desks you swap between, one at a time'
        }
        onClick={() => store.setMode(pro ? 'classic' : 'pro')}
        pressed={pro}
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
        <Select.Root
          value={store.projectFilter ?? ''}
          onValueChange={(value) => store.setProjectFilter(value || null)}
        >
          <Select.Trigger size="sm" aria-label="Project filter" className="max-w-44">
            <Select.Value>{projectName ?? 'All projects'}</Select.Value>
          </Select.Trigger>
          <Select.Content align="start">
            <Select.Item value="">All projects</Select.Item>
            {store.projectOptions.map((project) => (
              <Select.Item key={project.id} value={project.id}>
                {project.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
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
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Organize the board"
              title={scope ? 'Organize the windows in this region' : 'Organize the board'}
              className="gap-1 px-2"
            />
          }
        >
          Organize
          <ChevronDown className="size-3.5" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" width="content">
          {ORGANIZE_OPTIONS.map((option) => (
            <DropdownMenu.Item
              key={option.value}
              onClick={() =>
                store.runLayout(
                  [
                    option.value === 'tidy'
                      ? { op: 'arrange', targets: null, scope, layout: 'tidy' }
                      : { op: 'organize', scope, by: option.value },
                  ],
                  { source: 'command', allowPreview: true }
                )
              }
            >
              {option.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
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
        <Select.Root
          value={store.paneCount}
          onValueChange={(value) => {
            if (value !== null) store.setPaneCount(value);
          }}
        >
          <Select.Trigger
            size="sm"
            aria-label="Canvas views"
            title="Multi-canvas: split the canvas into side-by-side views, each with its own pan and zoom (Ctrl+Alt+1 to 4)"
          >
            <Select.Value>{viewsLabel(store.paneCount)}</Select.Value>
          </Select.Trigger>
          <Select.Content align="start">
            {VIEW_OPTIONS.map((count) => (
              <Select.Item key={count} value={count}>
                {viewsLabel(count)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      )}
      <Divider />
      <ToolbarButton
        label="Jump to the agent that has waited longest for you"
        onClick={() => store.focusNextAttention()}
        disabled={attention === 0}
        className={attention > 0 ? 'text-foreground' : undefined}
      >
        {attention > 0 ? (
          <StateGlyph state="needs-you" size="sm" />
        ) : (
          <BellRing className="size-3.5" />
        )}
        {attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : 'All clear'}
      </ToolbarButton>
      <ToolbarButton
        label={store.showTaskFrames ? 'Hide task frames' : 'Show task frames'}
        onClick={() => store.setShowTaskFrames(!store.showTaskFrames)}
        pressed={store.showTaskFrames}
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
        <span className="px-2 text-xs whitespace-nowrap text-foreground-passive tabular-nums">
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
        const waiting =
          page.waiting > 0 ? `, ${page.waiting} need${page.waiting === 1 ? 's' : ''} you` : '';
        return (
          <Button
            key={page.index}
            type="button"
            variant="ghost"
            size="sm"
            role="tab"
            aria-selected={page.active}
            title={`Page ${page.index + 1} of ${pages.length}: ${page.windowCount} window${page.windowCount === 1 ? '' : 's'}${waiting} (Alt+PageUp / PageDown)`}
            onClick={() => store.setDeskPage(page.index)}
            className="min-w-7 gap-1 px-1.5 tabular-nums"
          >
            {page.index + 1}
            {groupGlyph(page)}
          </Button>
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
  return (
    <span className={cn('group/desk relative flex items-center', regionTint(desk.color))}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        role="tab"
        aria-selected={desk.active}
        title={deskTitle(desk)}
        onClick={() => store.switchDesk(desk.regionId)}
        onDoubleClick={() => store.setRenamingRegion(desk.regionId)}
        className="max-w-40 gap-1.5 px-2"
      >
        <span aria-hidden className={TINT_SWATCH} />
        <span className="truncate">{desk.name}</span>
        {desk.gather ? (
          <Inbox className="size-3 shrink-0 text-foreground-passive" />
        ) : (
          <span className="text-xs text-foreground-passive tabular-nums">{desk.windowCount}</span>
        )}
        {groupGlyph(desk)}
      </Button>
      {desk.active && removable && (
        <button
          type="button"
          aria-label={`Remove the ${desk.name} desk`}
          title={`Remove ${desk.name}; its windows move to the desk before it`}
          onClick={() => store.removeDesk(desk.regionId)}
          className={cn(
            FLOATING_LAYER,
            'absolute -top-1.5 -right-1 hidden size-4 items-center justify-center rounded-full text-foreground-muted group-hover/desk:flex hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          )}
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
    <Input
      autoFocus
      size="sm"
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
      className="w-32"
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
        className="max-w-56 shrink-0 truncate px-1.5 text-xs text-foreground"
        title={`Visiting from other desks: ${names.join(', ')}. They go back when you switch desks.`}
      >
        <span className="text-foreground-muted">Visiting:</span> {shown}
        {more}
      </span>
      <ToolbarButton
        label="Send the visiting windows back to their own desks"
        onClick={() => store.sendBack()}
        className="shrink-0"
      >
        Send back
      </ToolbarButton>
      <ToolbarButton
        label="Keep the visiting windows on this desk"
        onClick={() => store.keepVisitors()}
        className="shrink-0"
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
        className="text-foreground"
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
        className={cn('flex max-w-48 min-w-0 items-center gap-1.5 px-1', regionTint(region.color))}
        title={region.name}
      >
        <span aria-hidden className={TINT_SWATCH} />
        <span className="truncate text-sm font-medium text-foreground">{region.name}</span>
      </span>
      <span className="text-xs whitespace-nowrap text-foreground-passive tabular-nums">
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
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-subtle" />;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A toggle: shown pressed (one surface step up) while on. */
  pressed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn('gap-1.5 px-2', className)}
    >
      {children}
    </Button>
  );
}
