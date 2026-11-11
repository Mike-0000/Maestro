import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Input } from '@emdash/ui/react/primitives';
import type { NodeProps } from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  LayoutPanelTop,
  Maximize,
  Minimize2,
  Palette,
  Shrink,
  Ungroup,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { RegionEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { GATHER_PHRASES } from '../../api/canvas-desks';
import { REGION_COLORS, REGION_HEADER } from '../../api/canvas-regions';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { useCanvasPane } from '../canvas-pane-context';
import {
  FLOATING_LAYER,
  regionTint,
  SPOKEN_NAME_BADGE,
  TINT_EDGE,
  TINT_SWATCH,
  TINT_WASH,
} from '../canvas-styles';

export type RegionNodeData = { regionId: string };

/** What an empty region or desk says: a quiet title and one sentence, centred in it. */
function RegionEmpty({ title, sentence }: { title: string; sentence: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="text-lg font-medium text-balance text-foreground">{title}</span>
      <span className="max-w-sm text-sm text-balance text-foreground-muted">{sentence}</span>
    </div>
  );
}

/** The region's name over it while the conductor listens, with its colour as a swatch. */
function RegionNameBadge({ name }: { name: string }) {
  return (
    <span className={cn(SPOKEN_NAME_BADGE, 'flex items-center gap-4')}>
      <span aria-hidden className={cn(TINT_SWATCH, 'size-5')} />
      {name}
    </span>
  );
}

/**
 * A region on the board: a named area with a faint wash of its colour, whose header moves
 * everything inside it. The body never takes pointer input, so windows inside stay fully usable.
 */
export const RegionNode = observer(function RegionNode({ data, selected }: NodeProps) {
  const { regionId } = data as RegionNodeData;
  const store = getCanvasStore();
  const region = store.regionEntry(regionId);
  if (!region) return null;
  const dropping = store.dropHint === regionId;
  const badges = store.listening && store.layoutSettings.showNamesWhileListening;

  // Canvas Pro: a desk is the whole screen, not a frame on a board. It draws no border or header
  // (its name is in the desk strip); only what an empty desk says, and its name while listening.
  if (store.proMode && region.parentId === null) {
    const gather = store.desks.find((desk) => desk.regionId === regionId)?.gather ?? null;
    const visited = store.visitors.length > 0;
    // The desk's rect runs past the screen (its region chrome above, further pages below): what
    // it says is placed on the page in view.
    const page = store.deskFrame;
    return (
      <div
        className={cn(
          'pointer-events-none absolute rounded-xl border border-transparent transition-colors',
          regionTint(region.color),
          dropping && 'border-ring'
        )}
        style={
          page
            ? {
                left: page.x - region.rect.x,
                top: page.y - region.rect.y,
                width: page.w,
                height: page.h,
              }
            : { inset: 0 }
        }
      >
        {region.windowCount === 0 && !visited && (
          <RegionEmpty
            title={gather ? `${region.name} is clear` : `${region.name} is empty`}
            sentence={
              gather
                ? `Agents that ${GATHER_PHRASES[gather]} show up here, and go back to their own desks when you leave.`
                : 'Say “move Atlas to this desk”, or “bring Atlas here” to borrow it for a moment.'
            }
          />
        )}
        {badges && (
          <div className="absolute inset-x-0 top-6 flex justify-center">
            <RegionNameBadge name={region.name} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'pointer-events-none relative h-full w-full rounded-xl border transition-colors',
        regionTint(region.color),
        // A collapsed region is its header chip: a card. An open one is an area: a dashed edge
        // around a faint wash of its colour.
        region.collapsed
          ? cn(FLOATING_LAYER, TINT_EDGE)
          : cn('border-dashed', TINT_EDGE, TINT_WASH),
        selected && 'ring-1 ring-ring',
        dropping && 'border-solid border-ring'
      )}
    >
      <RegionHeader region={region} />
      {region.windowCount === 0 && !region.collapsed && (
        <RegionEmpty
          title={`${region.name} is empty`}
          sentence={`Drag windows in, or say “move Atlas to ${region.name}”.`}
        />
      )}
      {badges && !region.collapsed && (
        <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
          <RegionNameBadge name={region.name} />
        </div>
      )}
    </div>
  );
});

const RegionHeader = observer(function RegionHeader({ region }: { region: RegionEntry }) {
  const store = getCanvasStore();
  // Multi-canvas: the name field opens in the active view only (two would steal focus in turn).
  const pane = useCanvasPane();
  const renaming = store.renamingRegionId === region.regionId && store.activePane === pane;
  const run = (label: string, op: Parameters<typeof store.runLayout>[0][number]) =>
    store.runLayout([op], { source: 'pointer', label });

  return (
    <div
      className="chorus-region-handle group/region pointer-events-auto flex cursor-grab items-center gap-2 pr-2 pl-1.5 text-xs text-foreground-passive active:cursor-grabbing"
      style={{ height: REGION_HEADER }}
      title="Drag to move this sub-canvas and everything in it. Double-click to open it."
      onDoubleClick={(event) => {
        event.stopPropagation();
        store.goToRegion(region.regionId);
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon
        aria-label={region.collapsed ? 'Expand region' : 'Collapse region'}
        title={region.collapsed ? 'Expand' : 'Collapse'}
        className="nodrag"
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
      </Button>
      <span aria-hidden className={TINT_SWATCH} />
      {renaming ? (
        <Input
          autoFocus
          size="sm"
          defaultValue={region.name}
          aria-label="Region name"
          onFocus={(event) => event.currentTarget.select()}
          className="nodrag w-48 shrink-0 text-sm font-semibold"
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
          className="nodrag shrink-0 truncate rounded-sm text-sm font-semibold text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
      {region.summary && (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground-muted">
          {region.waiting > 0 ? (
            <StateGlyph state="needs-you" size="sm" />
          ) : region.failed > 0 ? (
            <StateGlyph state="error" size="sm" />
          ) : region.working > 0 ? (
            <StateGlyph state="working" size="sm" />
          ) : null}
          <span className="truncate">{region.summary}</span>
        </span>
      )}
      <span className="flex-1" />
      {/* Arranging and recolouring are occasional: they show while the header is hovered, to the
          left of Open and Stage, which stay put. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/region:opacity-100 group-hover/region:opacity-100">
        {!region.collapsed && !region.tiled && (
          <HeaderButton
            icon
            label="Tile: windows share the whole sub-canvas (four make quadrants)"
            onClick={() =>
              run(`Tiled ${region.name}`, {
                op: 'arrange',
                targets: null,
                scope: region.regionId,
                layout: 'tile',
              })
            }
          >
            <LayoutGrid className="size-3.5" />
          </HeaderButton>
        )}
        {!region.collapsed && !region.tiled && (
          <HeaderButton
            icon
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
            icon
            label={
              region.tiled && !region.parentId ? 'Fit to the screen' : 'Shrink to fit its windows'
            }
            onClick={() => {
              run(`Fitted ${region.name}`, { op: 'fitRegion', region: region.regionId });
              if (store.focusedRegionId === region.regionId) store.requestFrame(region.regionId);
            }}
          >
            <Shrink className="size-3.5" />
          </HeaderButton>
        )}
        <HeaderButton
          icon
          label="Change color"
          onClick={() => {
            const index = REGION_COLORS.indexOf(region.color ?? 'gray');
            const color = REGION_COLORS[(index + 1) % REGION_COLORS.length] ?? 'gray';
            run(`Recolored ${region.name}`, {
              op: 'recolorRegion',
              region: region.regionId,
              color,
            });
          }}
        >
          <Palette className="size-3.5" />
        </HeaderButton>
        <HeaderButton
          icon
          label="Ungroup (windows stay where they are)"
          onClick={() =>
            run(`Ungrouped ${region.name}`, { op: 'dissolveRegion', region: region.regionId })
          }
        >
          <Ungroup className="size-3.5" />
        </HeaderButton>
      </span>
      {store.focusedRegionId !== region.regionId && !region.collapsed && (
        <HeaderButton
          label="Open this sub-canvas (fills the screen)"
          onClick={() => store.goToRegion(region.regionId)}
        >
          <Maximize className="size-3.5" />
          Open
        </HeaderButton>
      )}
      <HeaderButton
        label="Open on the stage (full screen, tiled)"
        onClick={() => store.enterStage({ kind: 'region', regionId: region.regionId })}
        disabled={region.windowCount === 0}
      >
        <LayoutPanelTop className="size-3.5" />
        Stage
      </HeaderButton>
    </div>
  );
});

function HeaderButton({
  label,
  onClick,
  disabled,
  icon = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon={icon}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn('nodrag', !icon && 'gap-1 px-1.5')}
    >
      {children}
    </Button>
  );
}

/** Outline of where a window or region would go (large voice changes preview first). */
export const GhostNode = observer(function GhostNode({ data }: NodeProps) {
  const { label, region } = data as { label: string; region: boolean };
  return (
    <div
      className={cn(
        'pointer-events-none h-full w-full border border-dashed border-foreground-muted bg-foreground/4',
        region ? 'rounded-xl' : 'rounded-lg'
      )}
    >
      <span
        className={cn(
          FLOATING_LAYER,
          'm-2 inline-block rounded-md px-2 py-0.5 text-xs font-medium text-foreground'
        )}
      >
        {label}
      </span>
    </div>
  );
});
