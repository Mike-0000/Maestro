import { describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  projectRegionId,
  type LayoutState,
  type RegionState,
} from './canvas-regions';
import { homeForNewWindow, opsForNewWindowHome, withProjectRegionTags } from './canvas-spawn';

const settings = {
  placeNewAgentsInCurrentRegion: true,
  placeNewWindowsInProjectRegion: true,
};

function region(name: string, extra: Partial<RegionState> = {}): RegionState {
  return {
    name,
    parentId: null,
    rect: { x: 0, y: 0, w: 800, h: 600 },
    collapsed: false,
    createdAt: 1,
    ...extra,
  };
}

describe('projectRegionId', () => {
  it('prefers a region tagged with the project id, even after a rename', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: {
        'region:main': region('Renamed', { auto: true, projectId: 'p1' }),
        'region:other': region('Emdash', { auto: true }),
      },
    };
    expect(projectRegionId(state, 'p1', 'Emdash')).toBe('region:main');
  });

  it('falls back to an auto root region named after the project', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: {
        'region:auto': region('Emdash', { auto: true }),
        'region:user': region('Emdash group'),
      },
    };
    expect(projectRegionId(state, 'p1', 'Emdash')).toBe('region:auto');
  });

  it('ignores a user-made region that only shares the project name', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: { 'region:user': region('Emdash') },
    };
    expect(projectRegionId(state, 'p1', 'Emdash')).toBeNull();
  });

  it('ignores a nested auto region with the project name', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: {
        'region:parent': region('Review'),
        'region:child': region('Emdash', { auto: true, parentId: 'region:parent' }),
      },
    };
    expect(projectRegionId(state, 'p1', 'Emdash')).toBeNull();
  });
});

describe('homeForNewWindow', () => {
  const layout: LayoutState = {
    ...EMPTY_LAYOUT,
    regions: { 'region:view': region('Review'), 'region:proj': region('Emdash', { auto: true }) },
  };

  it('uses a reserved plan region first', () => {
    expect(
      homeForNewWindow({
        reservedName: 'Auth plan',
        currentRegionId: 'region:view',
        projectId: 'p1',
        projectName: 'Emdash',
        layout,
        settings,
      })
    ).toEqual({ kind: 'reserved', name: 'Auth plan', regionId: null });
  });

  it('uses the region in view when that override is on', () => {
    expect(
      homeForNewWindow({
        currentRegionId: 'region:view',
        projectId: 'p1',
        projectName: 'Emdash',
        layout,
        settings,
      })
    ).toEqual({ kind: 'current', regionId: 'region:view' });
  });

  it('uses the project sub-canvas when not viewing a region', () => {
    expect(
      homeForNewWindow({
        currentRegionId: null,
        projectId: 'p1',
        projectName: 'Emdash',
        layout,
        settings,
      })
    ).toEqual({
      kind: 'project',
      regionId: 'region:proj',
      name: 'Emdash',
      projectId: 'p1',
    });
  });

  it('creates a project sub-canvas when none exists', () => {
    expect(
      homeForNewWindow({
        currentRegionId: null,
        projectId: 'p1',
        projectName: 'Emdash',
        layout: EMPTY_LAYOUT,
        settings,
      })
    ).toEqual({ kind: 'project', regionId: null, name: 'Emdash', projectId: 'p1' });
  });

  it('stays on the board when the user turns the default off', () => {
    expect(
      homeForNewWindow({
        currentRegionId: null,
        projectId: 'p1',
        projectName: 'Emdash',
        layout,
        settings: { ...settings, placeNewWindowsInProjectRegion: false },
      })
    ).toEqual({ kind: 'root' });
  });
});

describe('opsForNewWindowHome', () => {
  it('creates an auto project region when none exists', () => {
    expect(
      opsForNewWindowHome({ kind: 'project', regionId: null, name: 'Emdash', projectId: 'p1' }, [
        'agent:a',
      ])
    ).toEqual([
      {
        op: 'createRegion',
        name: 'Emdash',
        members: ['agent:a'],
        auto: true,
        projectId: 'p1',
      },
    ]);
  });

  it('moves into an existing project region', () => {
    expect(
      opsForNewWindowHome(
        { kind: 'project', regionId: 'region:proj', name: 'Emdash', projectId: 'p1' },
        ['agent:b']
      )
    ).toEqual([
      { op: 'move', targets: ['agent:b'], to: { kind: 'region', region: 'region:proj' } },
    ]);
  });

  it('does not emit ops for the board root', () => {
    expect(opsForNewWindowHome({ kind: 'root' }, ['agent:a'])).toEqual([]);
  });
});

describe('withProjectRegionTags', () => {
  it('stamps projectId without moving windows', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: { 'region:auto': region('Emdash', { auto: true }) },
      membership: { 'agent:old': 'region:auto' },
    };
    const next = withProjectRegionTags(state, [{ regionId: 'region:auto', projectId: 'p1' }]);
    expect(next.regions['region:auto']?.projectId).toBe('p1');
    expect(next.membership).toEqual(state.membership);
  });
});
