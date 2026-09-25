import { describe, expect, it } from 'vitest';
import type { LayoutOp } from '@core/features/canvas/api/canvas-layout';
import { resolveCanvasRef, type CanvasEntity, type CanvasRefContext } from './canvas-refs';
import { stepsToOps } from './canvas-tool-ops';
import { parseCommand } from './grammar';
import { parseCanvasCommand, type CanvasParse } from './grammar-canvas';
import type { RosterAgent } from './resolver';

const entities: CanvasEntity[] = [
  {
    id: 'agent:a',
    kind: 'agent',
    name: 'Atlas',
    providerLabel: 'Claude',
    taskName: 'auth-refactor',
    status: 'working',
    parentId: 'region:review',
  },
  {
    id: 'agent:b',
    kind: 'agent',
    name: 'Bravo',
    providerLabel: 'Codex',
    taskName: 'api-tests',
    status: 'needs-you',
    parentId: 'region:review',
  },
  {
    id: 'agent:c',
    kind: 'agent',
    name: 'Cedar',
    providerLabel: 'Gemini',
    taskName: 'docs',
    status: 'idle',
    parentId: null,
  },
  {
    id: 'agent:d',
    kind: 'agent',
    name: 'Delta',
    providerLabel: 'Claude',
    taskName: 'old',
    status: 'done',
    parentId: null,
    hidden: true,
  },
  { id: 'browser:t1', kind: 'browser', name: 'auth-refactor app', taskName: 'auth-refactor' },
  { id: 'note:n1', kind: 'note', name: 'Remember the migration' },
  { id: 'region:review', kind: 'region', name: 'Review', parentId: null },
  { id: 'region:backend', kind: 'region', name: 'Backend', parentId: null },
];

function context(overrides: Partial<CanvasRefContext> = {}): CanvasRefContext {
  return {
    entities,
    selection: [],
    focusedId: null,
    recent: [],
    currentRegion: null,
    onStage: false,
    ...overrides,
  };
}

function ops(parse: CanvasParse | null): readonly LayoutOp[] | null {
  if (parse?.kind !== 'canvas' || parse.action.type !== 'layout') return null;
  return parse.action.ops;
}

function parse(text: string, overrides: Partial<CanvasRefContext> = {}) {
  return parseCanvasCommand(text, context(overrides));
}

describe('canvas references', () => {
  it('resolves names, lists, kinds, and statuses', () => {
    expect(resolveCanvasRef('Atlas', context())).toEqual({ kind: 'match', ids: ['agent:a'] });
    expect(resolveCanvasRef('Atlas and Bravo', context())).toEqual({
      kind: 'match',
      ids: ['agent:a', 'agent:b'],
    });
    expect(resolveCanvasRef('the review region', context())).toEqual({
      kind: 'match',
      ids: ['region:review'],
    });
    expect(resolveCanvasRef('the browser', context())).toEqual({
      kind: 'match',
      ids: ['browser:t1'],
    });
    expect(resolveCanvasRef("Atlas's app", context())).toEqual({
      kind: 'match',
      ids: ['browser:t1'],
    });
    expect(resolveCanvasRef('the waiting ones', context())).toEqual({
      kind: 'match',
      ids: ['agent:b'],
    });
    expect(resolveCanvasRef('at less', context())).toEqual({ kind: 'match', ids: ['agent:a'] });
  });

  it('reads pronouns from the selection, the last change, and focus', () => {
    const selected = context({ selection: ['agent:a', 'agent:c'] });
    expect(resolveCanvasRef('these', selected)).toEqual({
      kind: 'match',
      ids: ['agent:a', 'agent:c'],
    });
    expect(resolveCanvasRef('them', context({ recent: ['agent:b'] }))).toEqual({
      kind: 'match',
      ids: ['agent:b'],
    });
    expect(resolveCanvasRef('this', context({ focusedId: 'agent:c' }))).toEqual({
      kind: 'match',
      ids: ['agent:c'],
    });
    expect(resolveCanvasRef('here', context({ currentRegion: 'region:backend' }))).toEqual({
      kind: 'match',
      ids: ['region:backend'],
    });
  });

  it('never resolves something that is not there', () => {
    expect(resolveCanvasRef('the login button', context()).kind).toBe('none');
    expect(resolveCanvasRef('Atlas and the login button', context()).kind).toBe('none');
  });
});

describe('canvas grammar', () => {
  it('groups windows into a named region', () => {
    expect(ops(parse('group Atlas and Cedar as Frontend'))).toEqual([
      { op: 'createRegion', members: ['agent:a', 'agent:c'], name: 'Frontend' },
    ]);
    expect(ops(parse('make a region called Docs with Cedar and the note'))).toEqual([
      { op: 'createRegion', members: ['agent:c', 'note:n1'], name: 'Docs' },
    ]);
    expect(ops(parse('put Atlas, Bravo and Cedar in a new group called Sprint'))).toEqual([
      { op: 'createRegion', members: ['agent:a', 'agent:b', 'agent:c'], name: 'Sprint' },
    ]);
    expect(ops(parse('create a sub canvas'))).toEqual([{ op: 'createRegion', members: [] }]);
  });

  it('moves windows into, out of, and around regions', () => {
    expect(ops(parse('move Cedar into Backend'))).toEqual([
      { op: 'move', targets: ['agent:c'], to: { kind: 'region', region: 'region:backend' } },
    ]);
    expect(ops(parse('take Atlas out of the region'))).toEqual([
      { op: 'move', targets: ['agent:a'], to: { kind: 'region', region: null } },
    ]);
    expect(ops(parse('put Cedar next to Atlas'))).toEqual([
      {
        op: 'move',
        targets: ['agent:c'],
        to: { kind: 'relative', anchor: 'agent:a', side: 'right' },
      },
    ]);
    expect(ops(parse('move the browser to the left of Bravo'))).toEqual([
      {
        op: 'move',
        targets: ['browser:t1'],
        to: { kind: 'relative', anchor: 'agent:b', side: 'left' },
      },
    ]);
    expect(ops(parse('move Bravo to the top right'))).toEqual([
      { op: 'move', targets: ['agent:b'], to: { kind: 'slot', slot: 'top-right' } },
    ]);
    expect(ops(parse('move Atlas a bit to the left'))).toEqual([
      { op: 'move', targets: ['agent:a'], to: { kind: 'nudge', direction: 'left', amount: 'bit' } },
    ]);
  });

  it('resizes', () => {
    expect(ops(parse('make Atlas bigger'))).toEqual([
      {
        op: 'resize',
        targets: ['agent:a'],
        size: { kind: 'relative', axis: 'both', factor: 'more', direction: 'grow' },
      },
    ]);
    expect(ops(parse('make the browser half the screen'))).toEqual([
      {
        op: 'resize',
        targets: ['browser:t1'],
        size: { kind: 'screen', fraction: 'half', axis: 'width' },
      },
    ]);
    expect(ops(parse('make Cedar the same size as Atlas'))).toEqual([
      { op: 'resize', targets: ['agent:c'], size: { kind: 'match', like: 'agent:a' } },
    ]);
  });

  it('organizes, tidies, and arranges', () => {
    expect(ops(parse('organize by status'))).toEqual([
      { op: 'organize', scope: null, by: 'status' },
    ]);
    expect(ops(parse('organize the review region by provider'))).toEqual([
      { op: 'organize', scope: 'region:review', by: 'provider' },
    ]);
    expect(ops(parse('tidy up', { currentRegion: 'region:backend' }))).toEqual([
      { op: 'arrange', targets: null, scope: 'region:backend', layout: 'tidy' },
    ]);
    expect(ops(parse('put Atlas and Bravo side by side'))).toEqual([
      { op: 'arrange', targets: ['agent:a', 'agent:b'], scope: null, layout: 'row' },
    ]);
    expect(ops(parse('swap Atlas and Cedar'))).toEqual([
      { op: 'swap', a: 'agent:a', b: 'agent:c' },
    ]);
  });

  it('edits regions by name', () => {
    expect(ops(parse('rename Review to QA'))).toEqual([
      { op: 'renameRegion', region: 'region:review', name: 'QA' },
    ]);
    expect(ops(parse('make Backend green'))).toEqual([
      { op: 'recolorRegion', region: 'region:backend', color: 'green' },
    ]);
    expect(ops(parse('collapse Review'))).toEqual([
      { op: 'collapseRegion', region: 'region:review', collapsed: true },
    ]);
    expect(ops(parse('ungroup Backend'))).toEqual([
      { op: 'dissolveRegion', region: 'region:backend' },
    ]);
    // Windows are not regions: collapsing or dissolving an agent is not a canvas command.
    expect(parse('collapse Atlas')).toBeNull();
    expect(parse('remove Atlas')).toBeNull();
  });

  it('renames agents', () => {
    expect(parse('rename Atlas to Apollo')).toEqual({
      kind: 'canvas',
      action: { type: 'renameAgent', id: 'agent:a', name: 'Apollo' },
    });
  });

  it('opens the stage and navigates', () => {
    expect(parse('full screen Review')).toEqual({
      kind: 'canvas',
      action: { type: 'stage', ids: ['region:review'] },
    });
    expect(parse('put Atlas and Bravo on the stage')).toEqual({
      kind: 'canvas',
      action: { type: 'stage', ids: ['agent:a', 'agent:b'] },
    });
    expect(parse('full screen')).toEqual({ kind: 'canvas', action: { type: 'stage', ids: null } });
    expect(parse('just Atlas', { onStage: true })).toEqual({
      kind: 'canvas',
      action: { type: 'solo', id: 'agent:a' },
    });
    expect(parse('exit full screen', { onStage: true })).toEqual({
      kind: 'canvas',
      action: { type: 'leaveStage' },
    });
    expect(parse('go to backend')).toEqual({
      kind: 'canvas',
      action: { type: 'goToRegion', regionId: 'region:backend' },
    });
    expect(parse('undo')).toEqual({ kind: 'canvas', action: { type: 'undo' } });
    expect(parse('go back')).toEqual({ kind: 'canvas', action: { type: 'back' } });
    expect(parse("what's in review")).toEqual({
      kind: 'canvas',
      action: { type: 'describe', regionId: 'region:review' },
    });
  });

  it('asks instead of guessing', () => {
    const twoBrowsers = context({
      entities: [
        ...entities,
        { id: 'browser:t2', kind: 'browser', name: 'api-tests app', taskName: 'api-tests' },
      ],
    });
    expect(parseCanvasCommand('make the browser bigger', twoBrowsers)?.kind).toBe('clarify');
  });

  it('leaves agent instructions and unknown targets to the model', () => {
    for (const text of [
      'move the login button next to the header',
      'put the tests in a new file',
      'make the api faster',
      'focus Atlas',
      'show me what Bravo is doing',
      'group by',
      'tidy the imports in Atlas',
    ]) {
      expect(parse(text)).toBeNull();
    }
  });
});

describe('parseCommand with a canvas', () => {
  const roster: RosterAgent[] = [
    { id: 'agent:a', name: 'Atlas', providerLabel: 'Claude', taskName: 'auth-refactor' },
    { id: 'agent:b', name: 'Bravo', providerLabel: 'Codex', taskName: 'api-tests' },
  ];

  it('runs layout commands ahead of window commands', () => {
    expect(parseCommand('please group Atlas and Bravo as Review', roster, null, context())).toEqual(
      {
        kind: 'canvas',
        action: {
          type: 'layout',
          ops: [{ op: 'createRegion', members: ['agent:a', 'agent:b'], name: 'Review' }],
        },
      }
    );
    expect(parseCommand('close Atlas', roster, null, context())?.kind).toBe('close');
    expect(parseCommand('focus Atlas', roster, null, context())?.kind).toBe('focus');
  });

  it('keeps the old grammar when no canvas is given', () => {
    expect(parseCommand('undo', roster, null)?.kind).toBe('reopen');
  });
});

describe('arrange_canvas steps', () => {
  it('turns spoken names into ops', () => {
    expect(
      stepsToOps(
        [
          { op: 'group', windows: ['Atlas', 'Bravo'], name: 'Review' },
          { op: 'place', windows: ['Cedar'], anchor: 'Atlas', side: 'below' },
          { op: 'resize', windows: ['the browser'], size: 'half_screen' },
          { op: 'move_into', windows: ['Cedar'], region: 'board' },
        ],
        context()
      )
    ).toEqual({
      ops: [
        { op: 'createRegion', members: ['agent:a', 'agent:b'], name: 'Review' },
        {
          op: 'move',
          targets: ['agent:c'],
          to: { kind: 'relative', anchor: 'agent:a', side: 'below' },
        },
        {
          op: 'resize',
          targets: ['browser:t1'],
          size: { kind: 'screen', fraction: 'half', axis: 'width' },
        },
        { op: 'move', targets: ['agent:c'], to: { kind: 'region', region: null } },
      ],
    });
  });

  it('stops the batch on a name it cannot resolve', () => {
    const result = stepsToOps(
      [
        { op: 'group', windows: ['Atlas'] },
        { op: 'dissolve_region', region: 'Atlas' },
      ],
      context()
    );
    expect(result).toEqual({ error: expect.stringContaining('Step 2') });
  });
});
