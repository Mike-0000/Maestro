import { describe, expect, it } from 'vitest';
import {
  createDesk,
  deskCommand,
  deskOfEntity,
  deskPhrase,
  DESKS_NEED_PRO,
  mentionsDesk,
  moveToDesk,
  previousDesk,
  resolveDesk,
  spawnDestination,
} from './canvas-desk-ops';
import type { CanvasDeskContext, CanvasEntity, CanvasRefContext } from './canvas-refs';
import { stepsToOps } from './canvas-tool-ops';

// Three desks in order (Main, Review, Triage) with a region nested on Review. Review is in view.
const entities: CanvasEntity[] = [
  { id: 'agent:a', kind: 'agent', name: 'Atlas', status: 'working', parentId: 'region:review' },
  { id: 'agent:b', kind: 'agent', name: 'Bravo', status: 'needs-you', parentId: 'region:pair' },
  { id: 'agent:c', kind: 'agent', name: 'Cedar', status: 'idle', parentId: 'region:main' },
  { id: 'browser:t1', kind: 'browser', name: 'checkout app', parentId: 'region:main' },
  { id: 'region:main', kind: 'region', name: 'Main', parentId: null },
  { id: 'region:review', kind: 'region', name: 'Review', parentId: null },
  { id: 'region:triage', kind: 'region', name: 'Triage', parentId: null },
  { id: 'region:pair', kind: 'region', name: 'Pair', parentId: 'region:review' },
];

const DESKS: CanvasDeskContext = {
  order: ['region:main', 'region:review', 'region:triage'],
  active: 'region:review',
  newest: 'region:triage',
  visitors: [],
};

/** The same canvas in classic mode: no desks, only regions. */
const classic: CanvasRefContext = {
  entities,
  selection: [],
  focusedId: null,
  recent: [],
  currentRegion: 'region:review',
  onStage: false,
  previousRegion: 'region:main',
};

function context(
  overrides: Partial<CanvasRefContext> = {},
  desks: Partial<CanvasDeskContext> = {}
): CanvasRefContext {
  return { ...classic, desks: { ...DESKS, ...desks }, ...overrides };
}

const match = (id: string) => ({ kind: 'match', id });

describe('desk references', () => {
  it('resolves a desk by name, however the desk is called', () => {
    for (const spoken of [
      'Review',
      'the Review desk',
      'review desktop',
      'the review space',
      'desk Review',
      'revue',
    ]) {
      expect(resolveDesk(spoken, context())).toEqual(match('region:review'));
    }
  });

  it('steps through the order, wrapping at the ends', () => {
    expect(resolveDesk('next', context())).toEqual(match('region:triage'));
    expect(resolveDesk('the previous desk', context())).toEqual(match('region:main'));
    expect(resolveDesk('next', context({}, { active: 'region:triage' }))).toEqual(
      match('region:main')
    );
    expect(resolveDesk('previous', context({}, { active: 'region:main' }))).toEqual(
      match('region:triage')
    );
    const alone = context({}, { order: ['region:review'] });
    expect(resolveDesk('next', alone)).toEqual({
      kind: 'clarify',
      question: 'There is only one desk.',
    });
  });

  it('reads "last" and "the other one" as the desk the user was on before', () => {
    expect(resolveDesk('last', context())).toEqual(match('region:main'));
    expect(resolveDesk('the other desk', context())).toEqual(match('region:main'));
    // A region on another desk counts as that desk; one on the desk in view is not "another".
    expect(previousDesk(context({ previousRegion: 'region:pair' }))).toBeNull();
    expect(resolveDesk('the other one', context({ previousRegion: 'region:pair' }))).toMatchObject({
      kind: 'clarify',
    });
    expect(resolveDesk('last', context({ previousRegion: null }))).toMatchObject({
      kind: 'clarify',
    });
  });

  it('resolves the newest desk, a place in the order, and the desk in view', () => {
    expect(resolveDesk('new', context())).toEqual(match('region:triage'));
    expect(resolveDesk('the new desk', context())).toEqual(match('region:triage'));
    expect(resolveDesk('2', context())).toEqual(match('region:review'));
    expect(resolveDesk('desk two', context())).toEqual(match('region:review'));
    expect(resolveDesk('the third desk', context())).toEqual(match('region:triage'));
    expect(resolveDesk('first', context())).toEqual(match('region:main'));
    expect(resolveDesk('desk 9', context())).toEqual({
      kind: 'clarify',
      question: 'There are only 3 desks.',
    });
    expect(resolveDesk('this desk', context())).toEqual(match('region:review'));
    expect(resolveDesk('here', context())).toEqual(match('region:review'));
    // "This desk" is the desk, even from inside one of its regions.
    expect(resolveDesk('this desk', context({ currentRegion: 'region:pair' }))).toEqual(
      match('region:review')
    );
  });

  it("lets a desk's own name win over a keyword", () => {
    const named = context({
      entities: [...entities, { id: 'region:next', kind: 'region', name: 'Next', parentId: null }],
    });
    const desks = { ...DESKS, order: [...DESKS.order, 'region:next'] };
    expect(resolveDesk('next', { ...named, desks })).toEqual(match('region:next'));
  });

  it('never resolves a region inside a desk, a window, or a name nobody has', () => {
    expect(resolveDesk('Pair', context())).toEqual({ kind: 'none' });
    expect(resolveDesk('Atlas', context())).toEqual({ kind: 'none' });
    expect(resolveDesk('the billing desk', context())).toEqual({ kind: 'none' });
    expect(resolveDesk('two', context())).toEqual({ kind: 'none' });
  });

  it('asks rather than pick between two desks that sound alike', () => {
    const alike = context({
      entities: [
        { id: 'region:x', kind: 'region', name: 'Maple', parentId: null },
        { id: 'region:y', kind: 'region', name: 'Mable', parentId: null },
      ],
    });
    const desks = { order: ['region:x', 'region:y'], active: 'region:x', visitors: [] };
    expect(resolveDesk('mavle', { ...alike, desks })).toMatchObject({ kind: 'clarify' });
  });

  it('finds the desk a window or a nested region is on', () => {
    expect(deskOfEntity(context(), 'agent:b')).toBe('region:review');
    expect(deskOfEntity(context(), 'region:pair')).toBe('region:review');
    expect(deskOfEntity(context(), 'region:main')).toBe('region:main');
    expect(deskOfEntity(classic, 'agent:b')).toBeNull();
  });

  it('has no desks on the classic canvas', () => {
    expect(resolveDesk('Review', classic)).toEqual({ kind: 'none' });
    expect(deskPhrase('the Review desk', classic)).toBeNull();
  });

  it('tells a desk phrase from any other', () => {
    expect(mentionsDesk('the Review desk')).toBe(true);
    expect(mentionsDesk('desk 2')).toBe(true);
    expect(mentionsDesk('this space')).toBe(true);
    expect(mentionsDesk('Review')).toBe(false);
    expect(mentionsDesk('the app on my desktop machine')).toBe(false);
    expect(deskPhrase('the Review desk', context())).toEqual(match('region:review'));
    expect(deskPhrase('Review', context())).toBeNull();
    // Says desk, names none: left to the usual resolver (it may be a window called that).
    expect(deskPhrase('the billing desk', context())).toBeNull();
    expect(deskPhrase('the desktop app', context())).toBeNull();
  });
});

describe('spawn destinations', () => {
  it('names a desk, the one in view, or a region by its name', () => {
    expect(spawnDestination('the Main desk', context())).toEqual({ regionId: 'region:main' });
    expect(spawnDestination('this desk', context())).toEqual({ regionId: 'region:review' });
    expect(spawnDestination('Pair', context())).toEqual({ regionId: 'region:pair' });
    expect(spawnDestination('Pair', classic)).toEqual({ regionId: 'region:pair' });
  });

  it('names a new desk after what was said, without the desk word', () => {
    expect(spawnDestination('the Frontend desk', context())).toEqual({ name: 'Frontend' });
    expect(spawnDestination('a new space', context())).toEqual({
      error: 'Say which desk to put the agent on.',
    });
    expect(spawnDestination('a new Docs desk', context())).toEqual({ name: 'Docs' });
  });

  it('never makes a desk called "here" when nothing is in view', () => {
    expect(spawnDestination('here', { ...classic, currentRegion: null })).toEqual({
      error: 'Say which desk to put the agent on.',
    });
  });
});

describe('canvas_desks calls', () => {
  it('refuses everything but the mode switch on the classic canvas', () => {
    expect(deskCommand({ action: 'create', name: 'Review' }, classic)).toEqual({
      error: DESKS_NEED_PRO,
    });
    expect(deskCommand({ action: 'switch', desk: 'next' }, classic)).toEqual({
      error: DESKS_NEED_PRO,
    });
    expect(deskCommand({ action: 'set_mode', mode: 'pro' }, classic)).toEqual({
      action: 'set_mode',
      mode: 'pro',
    });
    expect(deskCommand({ action: 'set_mode' }, context())).toMatchObject({
      error: expect.any(String),
    });
  });

  it('makes a desk as a top-level region, with windows and a name', () => {
    expect(
      deskCommand({ action: 'create', name: 'Frontend', windows: ['Atlas', 'Cedar'] }, context())
    ).toEqual({
      action: 'create',
      ops: [
        { op: 'createRegion', parent: null, members: ['agent:a', 'agent:c'], name: 'Frontend' },
      ],
      members: ['agent:a', 'agent:c'],
      gather: null,
      follow: true,
    });
    expect(deskCommand({ action: 'create', follow: false }, context())).toEqual({
      action: 'create',
      ops: [{ op: 'createRegion', parent: null, members: [] }],
      members: [],
      gather: null,
      follow: false,
    });
  });

  it('names a gathering desk for what it gathers unless told otherwise', () => {
    expect(deskCommand({ action: 'create', gather: 'needs-you' }, context())).toMatchObject({
      ops: [{ op: 'createRegion', parent: null, members: [], name: 'Triage', gather: 'needs-you' }],
      gather: 'needs-you',
    });
    expect(
      deskCommand({ action: 'create', gather: 'error', name: 'Fires' }, context())
    ).toMatchObject({ ops: [{ name: 'Fires', gather: 'error' }] });
    expect(createDesk({ gather: 'done' })).toMatchObject({ ops: [{ name: 'Done' }] });
  });

  it('never takes a desk for a window', () => {
    expect(deskCommand({ action: 'create', windows: ['Main'] }, context())).toEqual({
      error: '"Main" is a desk, not a window. Name the windows on it.',
    });
    expect(
      deskCommand({ action: 'move_windows', windows: ['Review'], desk: 'Main' }, context())
    ).toMatchObject({ error: expect.stringContaining('is a desk') });
    expect(deskCommand({ action: 'bring', windows: ['Pair'] }, context())).toMatchObject({
      error: expect.stringContaining('is a region'),
    });
    expect(deskCommand({ action: 'bring', windows: ['the login button'] }, context())).toEqual({
      error: 'Nothing on the canvas called "the login button".',
    });
  });

  it('switches by name, step, or number, and says which desks exist otherwise', () => {
    expect(deskCommand({ action: 'switch', desk: 'next' }, context())).toEqual({
      action: 'switch',
      desk: 'region:triage',
    });
    expect(deskCommand({ action: 'switch', desk: '1' }, context())).toEqual({
      action: 'switch',
      desk: 'region:main',
    });
    expect(deskCommand({ action: 'switch' }, context())).toEqual({ error: 'Say which desk.' });
    expect(deskCommand({ action: 'switch', desk: 'Billing' }, context())).toEqual({
      error: 'No desk called "Billing". Desks: Main, Review, Triage.',
    });
  });

  it('renames and reorders the desk in view by default', () => {
    expect(deskCommand({ action: 'rename', name: 'QA' }, context())).toEqual({
      action: 'rename',
      ops: [{ op: 'renameRegion', region: 'region:review', name: 'QA' }],
      desk: 'region:review',
    });
    expect(deskCommand({ action: 'rename', desk: 'Main' }, context())).toEqual({
      error: 'rename needs a name.',
    });
    expect(
      deskCommand({ action: 'reorder', desk: 'Triage', position: 'first' }, context())
    ).toEqual({
      action: 'reorder',
      ops: [{ op: 'reorderDesk', region: 'region:triage', position: 'first' }],
      desk: 'region:triage',
    });
    expect(deskCommand({ action: 'reorder' }, context())).toMatchObject({
      error: expect.stringContaining('position'),
    });
  });

  it('moves windows to a desk and leaves alone the ones already on it', () => {
    expect(
      deskCommand(
        { action: 'move_windows', windows: ['Atlas', 'Cedar'], desk: 'Main', follow: true },
        context()
      )
    ).toEqual({
      action: 'move_windows',
      ops: [{ op: 'move', targets: ['agent:a'], to: { kind: 'region', region: 'region:main' } }],
      desk: 'region:main',
      windows: ['agent:a'],
      already: ['agent:c'],
      follow: true,
    });
    // Bravo is in a region on Review: it is on that desk and is not pulled out of its region.
    expect(deskCommand({ action: 'move_windows', windows: ['Bravo'] }, context())).toEqual({
      action: 'move_windows',
      ops: [],
      desk: 'region:review',
      windows: [],
      already: ['agent:b'],
      follow: false,
    });
    // Into a region rather than a desk, only its direct members are there already.
    expect(moveToDesk(['agent:a', 'agent:b'], 'region:pair', false, context())).toMatchObject({
      windows: ['agent:a'],
      already: ['agent:b'],
    });
    expect(deskCommand({ action: 'move_windows', desk: 'Main' }, context())).toEqual({
      error: 'Say which windows.',
    });
  });

  it('removes the desk in view by default and resolves where its windows go', () => {
    expect(deskCommand({ action: 'remove' }, context())).toEqual({
      action: 'remove',
      desk: 'region:review',
      into: null,
    });
    expect(deskCommand({ action: 'remove', desk: 'Triage', into: 'Main' }, context())).toEqual({
      action: 'remove',
      desk: 'region:triage',
      into: 'region:main',
    });
    expect(deskCommand({ action: 'remove', desk: 'Main', into: 'Main' }, context())).toEqual({
      error: 'A desk cannot take its own windows.',
    });
  });

  it('brings, sends back, and keeps visitors', () => {
    expect(deskCommand({ action: 'bring', windows: ['Cedar', 'the browser'] }, context())).toEqual({
      action: 'bring',
      windows: ['agent:c', 'browser:t1'],
    });
    expect(deskCommand({ action: 'bring' }, context())).toEqual({ error: 'Say which windows.' });
    expect(deskCommand({ action: 'send_back' }, context())).toEqual({
      action: 'send_back',
      windows: null,
    });
    expect(deskCommand({ action: 'keep', windows: ['Cedar'] }, context())).toEqual({
      action: 'keep',
      windows: ['agent:c'],
    });
  });
});

describe('arrange_canvas steps in Canvas Pro', () => {
  it('reads "the Review desk" as the region a desk is', () => {
    expect(
      stepsToOps([{ op: 'arrange', region: 'the Review desk', layout: 'tile' }], context())
    ).toEqual({
      ops: [{ op: 'arrange', targets: null, scope: 'region:review', layout: 'tile' }],
    });
    expect(
      stepsToOps([{ op: 'move_into', windows: ['Cedar'], region: 'desk 3' }], context())
    ).toEqual({
      ops: [{ op: 'move', targets: ['agent:c'], to: { kind: 'region', region: 'region:triage' } }],
    });
    // On the classic canvas nothing is a desk.
    expect(
      stepsToOps([{ op: 'arrange', region: 'the Review desk', layout: 'tile' }], classic)
    ).toMatchObject({ error: expect.any(String) });
  });
});
