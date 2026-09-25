import type { NodeProps } from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  LayoutPanelTop,
  Minimize2,
  Palette,
  Shrink,
  Ungroup,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { RegionEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { REGION_COLORS, REGION_HEADER, type RegionColor } from '../../api/canvas-regions';
import { getCanvasStore } from '../../contributions/browser/app-stores';

export type RegionNodeData = { regionId: string };

/** Accent classes per region color: border, tint, header chip, and minimap fill. */
export const REGION_STYLES: Record<
  RegionColor,
  { border: string; tint: string; chip: string; fill: string }
> = {
  blue: {
    border: 'border-sky-500/45',
    tint: 'bg-sky-500/[0.045]',
    chip: 'bg-sky-500/15 text-sky-800 dark:text-sky-200',
    fill: 'rgb(14 165 233 / 0.28)',
  },
  violet: {
    border: 'border-violet-500/45',
    tint: 'bg-violet-500/[0.045]',
    chip: 'bg-violet-500/15 text-violet-800 dark:text-violet-200',
    fill: 'rgb(139 92 246 / 0.28)',
  },
  green: {
    border: 'border-emerald-500/45',
    tint: 'bg-emerald-500/[0.045]',
    chip: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
    fill: 'rgb(16 185 129 / 0.28)',
  },
  amber: {
    border: 'border-amber-500/50',
    tint: 'bg-amber-500/[0.05]',
    chip: 'bg-amber-500/20 text-amber-900 dark:text-amber-200',
    fill: 'rgb(245 158 11 / 0.3)',
  },
  rose: {
    border: 'border-rose-500/45',
    tint: 'bg-rose-500/[0.045]',
    chip: 'bg-rose-500/15 text-rose-800 dark:text-rose-200',
    fill: 'rgb(244 63 94 / 0.28)',
  },
  teal: {
    border: 'border-teal-500/45',
    tint: 'bg-teal-500/[0.045]',
    chip: 'bg-teal-500/15 text-teal-800 dark:text-teal-200',
    fill: 'rgb(20 184 166 / 0.28)',
  },
  gray: {
    border: 'border-foreground/25',
    tint: 'bg-foreground/[0.025]',
    chip: 'bg-foreground/10 text-foreground',
    fill: 'rgb(128 128 128 / 0.25)',
  },
};

export function regionStyle(color: RegionColor | undefined) {
  return REGION_STYLES[color ?? 'gray'];
}

/**
 * A region on the board: a named, tinted area whose header moves everything inside it. The body
 * never takes pointer input, so windows inside stay fully usable.
 */
export const RegionNode = observer(function RegionNode({ data, selected }: NodeProps) {
  const { regionId } = data as RegionNodeData;
  const store = getCanvasStore();
  const region = store.regionEntry(regionId);
  if (!region) return null;
  const style = regionStyle(region.color);
  const dropping = store.dropHint === regionId;
  const badges = store.listening && store.layoutSettings.showNamesWhileListening;

  return (
    <div
      className={cn(
        'pointer-events-none relative h-full w-full rounded-3xl border-2 transition-[box-shadow,border-color]',
        style.border,
        region.collapsed ? 'bg-background shadow-md' : style.tint,
        selected && 'ring-2 ring-blue-500/50',
        dropping && 'border-blue-500 shadow-[0_0_0_6px_rgb(59_130_246/0.25)]',
        region.collapsed ? 'border-solid' : 'border-dashed'
      )}
    >
      <RegionHeader region={region} />
      {badges && !region.collapsed && (
        <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
          <span
            className={cn(
              'rounded-2xl px-6 py-2 text-5xl font-bold tracking-tight shadow-lg backdrop-blur',
              style.chip
            )}
          >
            {region.name}
          </span>
        </div>
      )}
    </div>
  );
});

const RegionHeader = observer(function RegionHeader({ region }: { region: RegionEntry }) {
  const store = getCanvasStore();
  const style = regionStyle(region.color);
  const renaming = store.renamingRegionId === region.regionId;
  const run = (label: string, op: Parameters<typeof store.runLayout>[0][number]) =>
    store.runLayout([op], { source: 'pointer', label });

  return (
    <div
      className="chorus-region-handle pointer-events-auto flex cursor-grab items-center gap-2 px-3 text-xs text-foreground-muted active:cursor-grabbing"
      style={{ height: REGION_HEADER }}
      title="Drag to move this region and everything in it"
      onDoubleClick={(event) => {
        event.stopPropagation();
        store.enterStage({ kind: 'region', regionId: region.regionId });
      }}
    >
      <button
        type="button"
        aria-label={region.collapsed ? 'Expand region' : 'Collapse region'}
        title={region.collapsed ? 'Expand' : 'Collapse'}
        className="nodrag flex size-6 shrink-0 items-center justify-center rounded hover:bg-background-secondary hover:text-foreground"
        onClick={() =>
          run(region.collapsed ? `Expanded ${region.name}` : `Collapsed ${region.name}`, {
            op: 'collapseRegion',
            region: region.regionId,
            collapsed: !region.collapsed,
          })
        }
      >
        {region.collapsed ? (
          <ChevronRight className="size-4" />
        ) : (
          <ChevronDown className="size-4" />
        )}
      </button>
      {renaming ? (
        <input
          autoFocus
          defaultValue={region.name}
          aria-label="Region name"
          onFocus={(event) => event.currentTarget.select()}
          className="nodrag w-48 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none"
          onBlur={(event) => {
            const name = event.currentTarget.value.trim();
            store.setRenamingRegion(null);
            if (name && name !== region.name) {
              run(`Renamed ${region.name} to ${name}`, {
                op: 'renameRegion',
                region: region.regionId,
                name,
              });
            }
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') store.setRenamingRegion(null);
          }}
        />
      ) : (
        <button
          type="button"
          title="Double-click to rename. Say this name to address the region."
          className={cn(
            'nodrag shrink-0 truncate rounded-md px-2 py-0.5 text-sm font-semibold',
            style.chip
          )}
          onDoubleClick={(event) => {
            event.stopPropagation();
            store.setRenamingRegion(region.regionId);
          }}
        >
          {region.name}
        </button>
      )}
      <span className="shrink-0 tabular-nums">
        {region.windowCount} window{region.windowCount === 1 ? '' : 's'}
      </span>
      {region.summary && <span className="min-w-0 truncate">· {region.summary}</span>}
      {region.waiting > 0 && (
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
      )}
      <span className="flex-1" />
      <HeaderButton
        label="Open on the stage (full screen, tiled)"
        onClick={() => store.enterStage({ kind: 'region', regionId: region.regionId })}
        disabled={region.windowCount === 0}
      >
        <LayoutPanelTop className="size-3.5" />
        Stage
      </HeaderButton>
      {!region.collapsed && (
        <HeaderButton
          label="Tidy the windows inside"
          onClick={() =>
            run(`Tidied ${region.name}`, {
              op: 'arrange',
              targets: null,
              scope: region.regionId,
              layout: 'tidy',
            })
          }
        >
          <Minimize2 className="size-3.5" />
        </HeaderButton>
      )}
      {!region.collapsed && (
        <HeaderButton
          label="Shrink to fit its windows"
          onClick={() => run(`Fitted ${region.name}`, { op: 'fitRegion', region: region.regionId })}
        >
          <Shrink className="size-3.5" />
        </HeaderButton>
      )}
      <HeaderButton
        label="Change color"
        onClick={() => {
          const index = REGION_COLORS.indexOf(region.color ?? 'gray');
          const color = REGION_COLORS[(index + 1) % REGION_COLORS.length] ?? 'gray';
          run(`Recolored ${region.name}`, { op: 'recolorRegion', region: region.regionId, color });
        }}
      >
        <Palette className="size-3.5" />
      </HeaderButton>
      <HeaderButton
        label="Ungroup (windows stay where they are)"
        onClick={() =>
          run(`Ungrouped ${region.name}`, { op: 'dissolveRegion', region: region.regionId })
        }
      >
        <Ungroup className="size-3.5" />
      </HeaderButton>
    </div>
  );
});

function HeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      className="nodrag flex h-6 shrink-0 items-center gap-1 rounded px-1.5 font-medium hover:bg-background-secondary hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Outline of where a window or region would go (large voice changes preview first). */
export const GhostNode = observer(function GhostNode({ data }: NodeProps) {
  const { label, region } = data as { label: string; region: boolean };
  return (
    <div
      className={cn(
        'pointer-events-none h-full w-full rounded-2xl border-2 border-dashed border-blue-500/80 bg-blue-500/[0.07]',
        region && 'rounded-3xl bg-blue-500/[0.03]'
      )}
    >
      <span className="m-2 inline-block rounded-md bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white shadow">
        {label}
      </span>
    </div>
  );
});
