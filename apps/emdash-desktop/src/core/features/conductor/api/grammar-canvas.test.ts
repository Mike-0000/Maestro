import { describe, expect, it } from 'vitest';
import type { LayoutOp } from '@core/features/canvas/api/canvas-layout';
import {
  resolveCanvasRef,
  type CanvasDeskContext,
  type CanvasEntity,
  type CanvasRefContext,
} from './canvas-refs';
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

describe('sub-canvas voice', () => {
  const four: CanvasEntity[] = [
    ...entities.filter((entity) => entity.id !== 'agent:d'),
    { id: 'agent:e', kind: 'agent', name: 'Echo', parentId: null },
    { id: 'agent:f', kind: 'agent', name: 'Foxtrot', parentId: null },
    { id: 'agent:g', kind: 'agent', name: 'Golf', parentId: null },
  ];
  const quad = ['agent:a', 'agent:b', 'agent:c', 'agent:e'];

  it('tiles four selected agents into quadrants', () => {
    expect(
      ops(parse('put these four agents in quadrants', { entities: four, selection: quad }))
    ).toEqual([{ op: 'arrange', targets: quad, scope: null, layout: 'tile' }]);
    expect(
      ops(parse('put Atlas, Bravo, Cedar and Echo in a 2 by 2 grid', { entities: four }))
    ).toEqual([{ op: 'arrange', targets: quad, scope: null, layout: 'tile' }]);
  });

  it('asks when the count does not match what is meant', () => {
    const three = ['agent:a', 'agent:b', 'agent:c'];
    expect(
      parse('put these four agents in quadrants', { entities: four, selection: three })
    ).toMatchObject({ kind: 'clarify' });
  });

  it('tiles the sub-canvas the user is in, or a named one', () => {
    const here = { op: 'arrange', targets: null, scope: 'region:review', layout: 'tile' };
    expect(ops(parse('tile this', { currentRegion: 'region:review' }))).toEqual([here]);
    expect(ops(parse('tile', { currentRegion: 'region:review' }))).toEqual([here]);
    expect(ops(parse('tile the review region'))).toEqual([here]);
  });

  it('gives a window more room', () => {
    expect(ops(parse('give the browser more room'))).toEqual([
      {
        op: 'resize',
        targets: ['browser:t1'],
        size: { kind: 'relative', axis: 'both', factor: 'more', direction: 'grow' },
      },
    ]);
  });

  it('goes into a sub-canvas on open rather than staging it', () => {
    expect(parse('open review')).toEqual({
      kind: 'canvas',
      action: { type: 'goToRegion', regionId: 'region:review' },
    });
    expect(parse('full screen review')).toMatchObject({
      kind: 'canvas',
      action: { type: 'stage' },
    });
  });

  it('switches to the newest sub-canvas, and asks when there is none', () => {
    expect(parse('switch to the new one', { newestRegion: 'region:backend' })).toEqual({
      kind: 'canvas',
      action: { type: 'goToRegion', regionId: 'region:backend' },
    });
    expect(
      parse('switch to this new sub canvas', { newestRegion: 'region:backend' })
    ).toMatchObject({ action: { regionId: 'region:backend' } });
    expect(parse('switch to the new one')).toMatchObject({ kind: 'clarify' });
  });

  it('switches back to the previous sub-canvas, else goes back', () => {
    expect(parse('switch back', { previousRegion: 'region:review' })).toEqual({
      kind: 'canvas',
      action: { type: 'goToRegion', regionId: 'region:review' },
    });
    expect(parse('switch back')).toEqual({ kind: 'canvas', action: { type: 'back' } });
  });

  it('steps to the next and previous sub-canvas', () => {
    expect(parse('next sub canvas')).toEqual({
      kind: 'canvas',
      action: { type: 'adjacentRegion', step: 1 },
    });
    expect(parse('go to the previous workspace')).toEqual({
      kind: 'canvas',
      action: { type: 'adjacentRegion', step: -1 },
    });
  });

  it('leaves the sub-canvas, and says so on the main canvas', () => {
    expect(parse('leave this sub canvas', { currentRegion: 'region:review' })).toEqual({
      kind: 'canvas',
      action: { type: 'up' },
    });
    expect(parse('exit')).toMatchObject({ kind: 'clarify' });
    expect(parse('exit', { onStage: true })).toEqual({
      kind: 'canvas',
      action: { type: 'leaveStage' },
    });
  });

  it('goes to the main canvas', () => {
    for (const text of ['main canvas', 'back to the main canvas', 'switch to the main canvas']) {
      expect(parse(text, { currentRegion: 'region:review' })).toEqual({
        kind: 'canvas',
        action: { type: 'home' },
      });
    }
  });

  it('resolves "this one" to the sub-canvas the user is in', () => {
    expect(
      resolveCanvasRef('this sub canvas', context({ currentRegion: 'region:review' }))
    ).toEqual({ kind: 'match', ids: ['region:review'] });
  });

  it('maps the tile layout from the model tool', () => {
    expect(stepsToOps([{ op: 'arrange', region: 'Review', layout: 'tile' }], context())).toEqual({
      ops: [{ op: 'arrange', targets: null, scope: 'region:review', layout: 'tile' }],
    });
  });
});

describe('Canvas Pro desks', () => {
  // Three desks in order (Main, Review, Frontend); Main is in view.
  const onDesks: CanvasEntity[] = [
    { id: 'agent:a', kind: 'agent', name: 'Atlas', status: 'working', parentId: 'region:review' },
    { id: 'agent:b', kind: 'agent', name: 'Bravo', status: 'needs-you', parentId: 'region:review' },
    { id: 'agent:c', kind: 'agent', name: 'Cedar', status: 'idle', parentId: 'region:main' },
    { id: 'region:main', kind: 'region', name: 'Main', parentId: null },
    { id: 'region:review', kind: 'region', name: 'Review', parentId: null },
    { id: 'region:frontend', kind: 'region', name: 'Frontend', parentId: null },
  ];
  const DESKS: CanvasDeskContext = {
    order: ['region:main', 'region:review', 'region:frontend'],
    active: 'region:main',
    newest: 'region:frontend',
    visitors: [],
  };
  const pro = (
    overrides: Partial<CanvasRefContext> = {},
    desks: Partial<CanvasDeskContext> = {}
  ): CanvasRefContext =>
    context({
      entities: onDesks,
      currentRegion: 'region:main',
      desks: { ...DESKS, ...desks },
      ...overrides,
    });
  /** The desk command an utterance becomes; anything else comes back as parsed. */
  const desk = (text: string, on: CanvasRefContext = pro()) => {
    const parsed = parseCanvasCommand(text, on);
    return parsed?.kind === 'canvas' && parsed.action.type === 'desk'
      ? parsed.action.command
      : parsed;
  };
  const switchTo = (id: string) => ({ action: 'switch', desk: id });
  const moveTo = (targets: string[], region: string) => ({
    op: 'move',
    targets,
    to: { kind: 'region', region },
  });

  it('makes desks, named and filled', () => {
    expect(desk('new desk')).toEqual({
      action: 'create',
      ops: [{ op: 'createRegion', parent: null, members: [] }],
      members: [],
      gather: null,
      follow: true,
    });
    expect(desk('new desk called QA with Atlas and Bravo')).toMatchObject({
      action: 'create',
      ops: [{ op: 'createRegion', parent: null, members: ['agent:a', 'agent:b'], name: 'QA' }],
      follow: true,
    });
    expect(desk('create a desktop named Docs')).toMatchObject({ ops: [{ name: 'Docs' }] });
    expect(desk('make a space called Research and stay here')).toMatchObject({
      ops: [{ name: 'Research' }],
      follow: false,
    });
    expect(desk('put Atlas and Bravo on a new desk called Pairing')).toMatchObject({
      action: 'create',
      ops: [{ parent: null, members: ['agent:a', 'agent:b'], name: 'Pairing' }],
    });
  });

  it('makes gathering desks, called Triage unless named', () => {
    for (const text of [
      'make a desk for everything that needs me',
      'create a desk for agents that need me',
      'new desk for everything waiting on me',
    ]) {
      expect(desk(text)).toMatchObject({
        action: 'create',
        ops: [{ parent: null, members: [], name: 'Triage', gather: 'needs-you' }],
        gather: 'needs-you',
      });
    }
    expect(desk('make a desk for the failed ones')).toMatchObject({
      ops: [{ name: 'Failed', gather: 'error' }],
    });
    expect(desk('create a desk for everything that is working')).toMatchObject({
      ops: [{ name: 'Working', gather: 'working' }],
    });
    expect(desk('make a desk for agents that are done')).toMatchObject({
      ops: [{ name: 'Done', gather: 'done' }],
    });
    expect(desk('make a desk called Inbox for everything that needs me')).toMatchObject({
      ops: [{ name: 'Inbox', gather: 'needs-you' }],
    });
    // "For" followed by windows fills the desk instead.
    expect(desk('new desk for Atlas and Bravo')).toMatchObject({
      ops: [{ members: ['agent:a', 'agent:b'] }],
      gather: null,
    });
  });

  it('switches by name, step, number, and recency', () => {
    expect(desk('switch to the Review desk')).toEqual(switchTo('region:review'));
    expect(desk('go to the review desktop')).toEqual(switchTo('region:review'));
    expect(desk('take me to the frontend space')).toEqual(switchTo('region:frontend'));
    expect(desk('next desk')).toEqual(switchTo('region:review'));
    expect(desk('previous desk')).toEqual(switchTo('region:frontend'));
    expect(desk('desk 3')).toEqual(switchTo('region:frontend'));
    expect(desk('switch to desk two')).toEqual(switchTo('region:review'));
    expect(desk('the second desk')).toEqual(switchTo('region:review'));
    expect(desk('the new desk')).toEqual(switchTo('region:frontend'));
    expect(desk('the other desk', pro({ previousRegion: 'region:review' }))).toEqual(
      switchTo('region:review')
    );
    expect(desk('the other desk')).toMatchObject({ kind: 'clarify' });
    expect(desk('next desk', pro({}, { order: ['region:main'] }))).toEqual({
      kind: 'clarify',
      question: 'There is only one desk.',
    });
  });

  it('goes to a desk named without the word, as it goes into any region', () => {
    for (const text of ['open Review', 'go to Review', 'switch to Review']) {
      expect(parseCanvasCommand(text, pro())).toEqual({
        kind: 'canvas',
        action: { type: 'goToRegion', regionId: 'region:review' },
      });
    }
  });

  it('moves windows to a desk for good, following when asked', () => {
    expect(desk('put Cedar on the Frontend desk')).toEqual({
      action: 'move_windows',
      ops: [moveTo(['agent:c'], 'region:frontend')],
      desk: 'region:frontend',
      windows: ['agent:c'],
      already: [],
      follow: false,
    });
    expect(desk('move Cedar to the Review desk and follow')).toMatchObject({
      desk: 'region:review',
      windows: ['agent:c'],
      follow: true,
    });
    expect(desk('send Atlas and Bravo onto desk 3 and take me there')).toMatchObject({
      ops: [moveTo(['agent:a', 'agent:b'], 'region:frontend')],
      follow: true,
    });
    expect(desk('move Atlas here')).toMatchObject({
      ops: [moveTo(['agent:a'], 'region:main')],
      desk: 'region:main',
    });
    // Already there: nothing to move, and the reply says so.
    expect(desk('move Cedar to the Main desk')).toMatchObject({
      ops: [],
      windows: [],
      already: ['agent:c'],
    });
  });

  it('renames, reorders, and removes desks', () => {
    expect(desk('rename this desk to Home')).toEqual({
      action: 'rename',
      ops: [{ op: 'renameRegion', region: 'region:main', name: 'Home' }],
      desk: 'region:main',
    });
    expect(desk('call this desk Home')).toMatchObject({ ops: [{ name: 'Home' }] });
    expect(ops(parseCanvasCommand('rename the Review desk to QA', pro()))).toEqual([
      { op: 'renameRegion', region: 'region:review', name: 'QA' },
    ]);
    expect(desk('move this desk right')).toEqual({
      action: 'reorder',
      ops: [{ op: 'reorderDesk', region: 'region:main', position: 'right' }],
      desk: 'region:main',
    });
    expect(desk('move the Review desk to the left')).toMatchObject({
      ops: [{ op: 'reorderDesk', region: 'region:review', position: 'left' }],
    });
    expect(desk('make this desk last')).toMatchObject({ ops: [{ position: 'last' }] });
    expect(desk('put the Frontend desk first')).toMatchObject({
      ops: [{ region: 'region:frontend', position: 'first' }],
    });
    expect(desk('remove the Review desk')).toEqual({
      action: 'remove',
      desk: 'region:review',
      into: null,
    });
    expect(desk('close this desk')).toMatchObject({ action: 'remove', desk: 'region:main' });
    expect(desk('delete desk 3')).toMatchObject({ action: 'remove', desk: 'region:frontend' });
  });

  it('brings visitors, sends them back, and keeps them', () => {
    expect(desk('bring Atlas here')).toEqual({ action: 'bring', windows: ['agent:a'] });
    expect(desk('bring Atlas and Bravo over')).toEqual({
      action: 'bring',
      windows: ['agent:a', 'agent:b'],
    });
    const one = pro({ focusedId: 'agent:a' }, { visitors: ['agent:a'] });
    expect(desk('send it back', one)).toEqual({ action: 'send_back', windows: ['agent:a'] });
    expect(desk('keep it here', one)).toEqual({ action: 'keep', windows: ['agent:a'] });
    expect(desk('send Atlas back', one)).toEqual({ action: 'send_back', windows: ['agent:a'] });
    const two = pro({}, { visitors: ['agent:a', 'agent:b'] });
    expect(desk('send them back', two)).toEqual({ action: 'send_back', windows: null });
    expect(desk('keep them here', two)).toEqual({ action: 'keep', windows: null });
    // Two visiting and neither focused: "it" is a question, not a pick.
    expect(desk('send it back', two)).toMatchObject({ kind: 'clarify' });
    // Nobody visiting: the phrase is not about desks.
    expect(desk('send it back')).toBeNull();
    expect(desk('keep it here')).toBeNull();
    // "Put it back" stays undo, and "bring Atlas back" stays reopen (not a canvas command).
    expect(parseCanvasCommand('put it back', one)).toEqual({
      kind: 'canvas',
      action: { type: 'undo' },
    });
    expect(parseCanvasCommand('bring Atlas back', one)).toBeNull();
  });

  it('switches the canvas mode from either canvas', () => {
    for (const on of [context(), pro()]) {
      for (const text of ['switch to canvas pro', 'use canvas pro', 'turn on canvas pro']) {
        expect(desk(text, on)).toEqual({ action: 'set_mode', mode: 'pro' });
      }
      for (const text of [
        'switch to the classic canvas',
        'use the classic canvas',
        'go back to the classic canvas',
      ]) {
        expect(desk(text, on)).toEqual({ action: 'set_mode', mode: 'classic' });
      }
    }
  });

  it('reads a desk phrase wherever a region can be named', () => {
    expect(ops(parseCanvasCommand('tile the Review desk', pro()))).toEqual([
      { op: 'arrange', targets: null, scope: 'region:review', layout: 'tile' },
    ]);
    expect(ops(parseCanvasCommand('clean up my desk', pro()))).toEqual([
      { op: 'arrange', targets: null, scope: 'region:main', layout: 'tidy' },
    ]);
    expect(parseCanvasCommand("what's on the Review desk", pro())).toEqual({
      kind: 'canvas',
      action: { type: 'describe', regionId: 'region:review' },
    });
    expect(parseCanvasCommand('list desks', pro())).toEqual({
      kind: 'canvas',
      action: { type: 'describe', regionId: null },
    });
    expect(parseCanvasCommand('leave this desk', pro())).toEqual({
      kind: 'canvas',
      action: { type: 'up' },
    });
  });

  it('never guesses a desk or a window', () => {
    for (const text of [
      'switch to the billing desk',
      'put Atlas on the billing desk',
      'move Atlas to the billing desk',
      'put the login button on the Review desk',
      'remove the billing desk',
      'bring the login button here',
      'new desk with the login button',
      'this desk',
    ]) {
      expect(parseCanvasCommand(text, pro())).toBeNull();
    }
  });

  it('claims nothing about desks on the classic canvas', () => {
    for (const text of [
      'new desk called Review',
      'next desk',
      'switch to the Review desk',
      'put Cedar on the Review desk',
      'bring Atlas here',
      'move Atlas here',
      'remove this desk',
      'list desks',
    ]) {
      expect(parse(text)).toBeNull();
    }
    // "Space" keeps meaning a region there, and becomes a desk only in Canvas Pro.
    expect(ops(parse('make a space called Docs'))).toEqual([
      { op: 'createRegion', members: [], name: 'Docs' },
    ]);
    expect(desk('make a space called Docs')).toMatchObject({ action: 'create' });
  });

  it('takes desk commands through the main grammar, polite forms and all', () => {
    const roster: RosterAgent[] = [
      { id: 'agent:a', name: 'Atlas', providerLabel: 'Claude', taskName: 'auth-refactor' },
    ];
    expect(parseCommand('Can you switch to the Review desk, please?', roster, null, pro())).toEqual(
      { kind: 'canvas', action: { type: 'desk', command: switchTo('region:review') } }
    );
    expect(parseCommand('okay, next desk', roster, null, pro())).toEqual({
      kind: 'canvas',
      action: { type: 'desk', command: switchTo('region:review') },
    });
    // An agent still wins its own commands.
    expect(parseCommand('focus Atlas', roster, null, pro())?.kind).toBe('focus');
    expect(parseCommand('tell Atlas to clean up the desktop', roster, null, pro())?.kind).toBe(
      'send'
    );
  });
});
