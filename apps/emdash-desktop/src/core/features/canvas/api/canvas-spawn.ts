/**
 * Where a newly spawned window should land. Pure so spawn policy can be tested without the store.
 *
 * Precedence: a reserved region (a plan's, or the one the developer named), then the region in
 * view (user override), then the project's main sub-canvas (the default), then the board root.
 * In Canvas Pro the project's desk comes straight after a reserved region, ahead of the desk in
 * view: on Pro the user is always on some desk, so "the region in view" would catch every window.
 */

import type { CanvasLayoutSettings } from '../contributions/mementos';
import { projectDeskId } from './canvas-desks';
import type { LayoutOp } from './canvas-layout';
import {
  projectRegionId,
  regionByName,
  type LayoutState,
  type RegionState,
} from './canvas-regions';

export type NewWindowHome =
  | { readonly kind: 'reserved'; readonly name: string; readonly regionId: string | null }
  | { readonly kind: 'current'; readonly regionId: string }
  | {
      readonly kind: 'project';
      readonly regionId: string | null;
      readonly name: string;
      readonly projectId: string;
    }
  | { readonly kind: 'root' };

export function homeForNewWindow(input: {
  readonly reservedName?: string;
  readonly currentRegionId: string | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly layout: LayoutState;
  /** Canvas Pro: top-level regions are desks. */
  readonly pro?: boolean;
  readonly settings: Pick<
    CanvasLayoutSettings,
    | 'placeNewAgentsInCurrentRegion'
    | 'placeNewWindowsInProjectRegion'
    | 'placeNewWindowsOnProjectDesk'
  >;
}): NewWindowHome {
  if (input.reservedName) {
    return {
      kind: 'reserved',
      name: input.reservedName,
      regionId: regionByName(input.layout, input.reservedName),
    };
  }
  if (input.pro && input.settings.placeNewWindowsOnProjectDesk && input.projectId) {
    return {
      kind: 'project',
      regionId: projectDeskId(input.layout, input.projectId, input.projectName),
      name: input.projectName.trim() || 'Project',
      projectId: input.projectId,
    };
  }
  if (input.settings.placeNewAgentsInCurrentRegion && input.currentRegionId) {
    return { kind: 'current', regionId: input.currentRegionId };
  }
  if (input.settings.placeNewWindowsInProjectRegion && input.projectId) {
    return {
      kind: 'project',
      regionId: projectRegionId(input.layout, input.projectId, input.projectName),
      name: input.projectName.trim() || 'Project',
      projectId: input.projectId,
    };
  }
  return { kind: 'root' };
}

export function opsForNewWindowHome(home: NewWindowHome, tiles: readonly string[]): LayoutOp[] {
  if (tiles.length === 0 || home.kind === 'root') return [];
  if (home.kind === 'current') {
    return [{ op: 'move', targets: tiles, to: { kind: 'region', region: home.regionId } }];
  }
  if (home.regionId) {
    return [{ op: 'move', targets: tiles, to: { kind: 'region', region: home.regionId } }];
  }
  return [
    {
      op: 'createRegion',
      name: home.name,
      members: tiles,
      ...(home.kind === 'project' ? { auto: true, projectId: home.projectId } : {}),
    },
  ];
}

/** Stamp `projectId` on the project's main region when it was recognized by name. */
export function withProjectRegionTags(
  state: LayoutState,
  tags: readonly { readonly regionId: string; readonly projectId: string }[]
): LayoutState {
  const regions: Record<string, RegionState> = { ...state.regions };
  let changed = false;
  for (const tag of tags) {
    const region = regions[tag.regionId];
    if (!region || region.projectId === tag.projectId) continue;
    changed = true;
    regions[tag.regionId] = { ...region, projectId: tag.projectId };
  }
  return changed ? { ...state, regions } : state;
}
