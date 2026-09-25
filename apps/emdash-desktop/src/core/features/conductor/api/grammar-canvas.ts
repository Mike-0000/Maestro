/**
 * Spoken canvas layout commands: regions ("make a region called Review with Atlas and Bravo"),
 * moves ("put Cedar next to Atlas", "move these into Review"), sizes ("make the browser half the
 * screen"), arrangement ("organize by status", "tidy up"), the stage ("full screen Review"), and
 * navigation ("back", "undo"). Pure: it returns what to do, the conductor does it.
 *
 * It claims an utterance only when every reference resolves (or needs a clarifying question), so
 * anything it does not understand still reaches the model.
 */

import type {
  ArrangeLayout,
  Direction,
  LayoutOp,
  OrganizeBy,
  SizeSpec,
  Slot,
} from '@core/features/canvas/api/canvas-layout';
import type { RegionColor } from '@core/features/canvas/api/canvas-regions';
import {
  resolveCanvasRef,
  resolveRegionRef,
  type CanvasRefContext,
  type RefPreference,
  type RefResult,
} from './canvas-refs';

export type CanvasAction =
  | { readonly type: 'layout'; readonly ops: readonly LayoutOp[] }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'back' }
  | { readonly type: 'forward' }
  | { readonly type: 'up' }
  | { readonly type: 'home' }
  /** Open the stage for these windows or this region (null: the selection or region in view). */
  | { readonly type: 'stage'; readonly ids: readonly string[] | null; readonly immersive?: boolean }
  | { readonly type: 'leaveStage' }
  | { readonly type: 'page'; readonly delta: 1 | -1 }
  | { readonly type: 'solo'; readonly id: string }
  | { readonly type: 'goToRegion'; readonly regionId: string }
  | { readonly type: 'renameAgent'; readonly id: string; readonly name: string }
  /** Say what is in a region (or list the regions when null). */
  | { readonly type: 'describe'; readonly regionId: string | null }
  | { readonly type: 'where'; readonly ids: readonly string[] };

export type CanvasParse =
  | { readonly kind: 'canvas'; readonly action: CanvasAction }
  | { readonly kind: 'clarify'; readonly question: string };

const UNDO =
  /^(?:undo|undo that|undo it|undo (?:the )?last(?: (?:change|move|one|thing))?|put (?:it|that|them|everything) back(?: (?:how|the way) it was)?|revert(?: that| it)?|take that back|go back to how it was)$/;
const REDO = /^(?:redo|redo that|redo it|do that again|actually do it)$/;
const BACK = /^(?:go back|back|navigate back|take me back|previous view)$/;
const FORWARD = /^(?:go forward|forward|navigate forward)$/;
const UP =
  /^(?:go up|up a level|go up a level|up one level|out a level|zoom out a level|one level up)$/;
const HOME =
  /^(?:go home|home|back to (?:the )?(?:whole )?(?:board|canvas|top)|take me home|(?:show me )?the whole (?:board|canvas)|main canvas|top level)$/;
const LEAVE_STAGE =
  /^(?:(?:exit|leave|close|quit|end|stop) (?:the )?(?:stage|full ?screen|focus mode|stage mode)|exit|leave|un ?full ?screen|back to (?:the )?canvas|restore(?: (?:the )?(?:layout|view|windows))?)$/;
const PAGE_NEXT = /^(?:next|following) page$/;
const PAGE_PREVIOUS = /^(?:previous|prev|last|preceding) page$/;
const IMMERSIVE =
  /^(?:immersive(?: mode)?|hide (?:the )?(?:chrome|sidebars?|everything else|app chrome)|distraction free(?: mode)?)$/;

const ORGANIZE =
  /^(?:organi[sz]e|group|sort|arrange|cluster|lay out|layout|reorgani[sz]e|regroup)(?: (.+?))? by (task|tasks|project|projects|status|state|provider|providers|agent type|type|model|models)$/;
const WHOLE_BOARD =
  /^(?:the )?(?:board|canvas|whole (?:board|canvas)|windows|everything|agents|them|all|all (?:the )?windows|all (?:the )?agents|every(?:one| window| agent))$/;
const ORGANIZE_BARE =
  /^(?:organi[sz]e|reorgani[sz]e)(?: (?:the )?(?:board|canvas|windows|everything|agents|all))?$/;
const TIDY =
  /^(?:tidy|tidy up|clean up|neaten(?: up)?|straighten(?: up| out)?|declutter|sort out)(?: (.+))?$/;
const ARRANGE =
  /^(?:put|arrange|lay out|line up|place|set|show|stack|organi[sz]e) (.+?) (side by side|in a row|next to each other|in a line|in a grid|as a grid|in a column|stacked|on top of each other|in a stack|vertically|horizontally)$/;
const LINE_UP = /^(?:line up|stack) (.+)$/;

const REGION_NOUN = '(?:region|group|area|sub ?canvas|space|zone|section|workspace)';
const CREATE = new RegExp(
  `^(?:make|create|add|start|set up|open|new|build)(?: me)? (?:a |an |one )?(?:new |empty )?${REGION_NOUN}(?: (?:called|named|for|titled) (.+?))?(?: (?:with|containing|holding|for|and put|and add|that has|to hold) (.+?)(?: in it| inside)?)?$`
);
const GROUP =
  /^(?:group|gather|collect|bundle|cluster|box up|wrap)(?: up)? (.+?)(?: together)?(?: (?:in|into) (?:a |one |their own |a new )?(?:region|group|area)| together)?(?: (?:as|called|named|titled) (.+))?$/;
const PUT_IN_NEW = new RegExp(
  `^(?:put|move|place|group) (.+?) (?:in|into|inside) (?:a |one |their own |its own |a new |an? )?(?:new )?${REGION_NOUN}(?: (?:called|named|titled) (.+))?$`
);
const RENAME = /^(?:rename|retitle) (.+?) (?:to|as|into) (.+)$/;
const CALL = /^(?:call|name) (this|it|that|this region|this group|that region|here) (.+)$/;
const COLOR =
  /^(?:color|colour|make|paint|turn|tint|mark) (.+?) (blue|violet|purple|green|amber|orange|yellow|rose|red|pink|teal|cyan|gray|grey)$/;
const COLLAPSE =
  /^(?:collapse|fold(?: up)?|fold away|close up|shrink down|minimi[sz]e|tuck away|put away) (.+)$/;
const EXPAND = /^(?:expand|unfold|open up|uncollapse|unfold) (.+)$/;
const DISSOLVE =
  /^(?:dissolve|ungroup|disband|break up|unpack|delete|remove|get rid of|undo) (.+?)(?: region| group)?$/;
const UNGROUP_BARE = /^(?:ungroup|dissolve|disband|break (?:it|this|that) up)$/;
const FIT = /^(?:shrink|fit|tighten|shrink ?wrap|snug) (.+?)(?: to fit| to size| up)?$/;

const STAGE_TAIL =
  /^(?:open|show|put|bring|pull|view|display)?\s*(.+?)\s+(?:on (?:the )?stage|full ?screen|in full ?screen|in focus mode|tiled|up big|on the big screen)$/;
const STAGE_HEAD =
  /^(?:full ?screen|maximi[sz]e|stage|spotlight|focus mode(?: on| for)?|zoom in on|blow up|enter|open)\s+(.+)$/;
const STAGE_BARE =
  /^(?:full ?screen|maximi[sz]e(?: it| this)?|stage(?: it| this| mode)?|enter (?:the )?stage|go full ?screen|focus mode|show (?:it|this|them) big)$/;
const SOLO = /^(?:just|only|solo|isolate|just show|only show|show only|show just) (.+)$/;
const GO_TO =
  /^(?:go to|show(?: me)?|zoom (?:in )?(?:on|to|into)|jump to|take me to|switch to|look at|focus(?: on)?|navigate to|head to|pan to|bring up)\s+(.+)$/;
const SWAP = /^(?:swap|switch|trade|exchange|flip) (.+?) (?:and|with|for) (.+)$/;
const SWAP_BARE = /^(?:swap|switch|flip) (?:them|those|these|those two|these two|the two)$/;

const MOVE_VERB = '(?:move|put|drop|send|place|shift|drag|stick|throw|slide|bring|take|push)';
const MOVE_RELATIVE = new RegExp(
  `^${MOVE_VERB} (.+?) (next to|beside|by|near|alongside|to the left of|left of|to the right of|right of|above|over|on top of|below|under|underneath|beneath) (.+)$`
);
const MOVE_SLOT = new RegExp(
  `^${MOVE_VERB} (.+?) (?:to|in|into|over to|at) the (top left|upper left|top right|upper right|bottom left|lower left|bottom right|lower right|top|bottom|left|right|middle|center|centre)(?: corner| side| edge| of the (?:screen|board|canvas|region))?$`
);
const NUDGE = new RegExp(
  `^(?:${MOVE_VERB}|nudge|scoot) (.+?) (a (?:bit|little|tad|touch)|slightly|a little bit|a lot|way|far|much|some|further|more)? ?(?:to the )?(left|right|up|down|higher|lower)(?: a (?:bit|little|tad|touch)| slightly| a lot| more)?$`
);
const MOVE_INTO = new RegExp(
  `^${MOVE_VERB} (.+?) (?:into|in|to|inside|over to|onto|under|back (?:in|into|to)) (?:the )?(.+)$`
);
const MOVE_OUT =
  /^(?:take|move|pull|get|put|bring|drag) (.+?) (?:out(?: of (?:the |its |their )?(?:region|group|.+?))?|back (?:on)?to the (?:board|canvas)|onto the (?:board|canvas)|to the (?:main )?(?:board|canvas))$/;

const RESIZE =
  /^(?:make|resize|set|turn|change) (.+?) (?:to )?(?:be )?((?:a (?:bit|little|tad|touch|little bit) |slightly |much |a lot |way |even |more )?(?:bigger|larger|smaller|wider|narrower|thinner|taller|longer|shorter)|twice as (?:big|large|wide|tall)|half (?:the |its )?size|half as (?:big|large|wide|tall)|small|medium|large|big|huge|wide|tall|normal(?: size)?|(?:the )?default(?: size)?|regular(?: size)?|standard(?: size)?)$/;
const GROW = /^(?:grow|enlarge|embiggen|widen|lengthen|heighten|shrink|narrow|shorten) (.+)$/;
const SCREEN =
  /^(?:make|resize|set) (.+?) (?:take up |fill |cover |be |to )?(half|a half|a third|one third|a quarter|one quarter|the whole|all|two thirds) (?:of )?the (?:screen|view|board|window)(?: wide| tall)?$/;
const MATCH = /^(?:make|resize) (.+?) (?:the )?same size as (.+)$/;
const DESCRIBE_REGION = /^(?:what(?:'s| is| are)|who(?:'s| is| are)) (?:in|inside) (.+)$/;
const WHERE = /^where(?:'s| is| are| did) (.+?)(?: go| end up)?$/;
const LIST_REGIONS =
  /^(?:what|which) (?:regions|groups|areas) (?:are there|do i have|exist|have i got)|^(?:list|name|show me) (?:the |my |all )?(?:regions|groups|areas)$|^(?:describe|summari[sz]e) (?:the )?(?:canvas|board|layout)$/;

const COLORS: Record<string, RegionColor> = {
  blue: 'blue',
  violet: 'violet',
  purple: 'violet',
  green: 'green',
  amber: 'amber',
  orange: 'amber',
  yellow: 'amber',
  rose: 'rose',
  red: 'rose',
  pink: 'rose',
  teal: 'teal',
  cyan: 'teal',
  gray: 'gray',
  grey: 'gray',
};

const SLOTS: Record<string, Slot> = {
  'top left': 'top-left',
  'upper left': 'top-left',
  'top right': 'top-right',
  'upper right': 'top-right',
  'bottom left': 'bottom-left',
  'lower left': 'bottom-left',
  'bottom right': 'bottom-right',
  'lower right': 'bottom-right',
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  middle: 'center',
  center: 'center',
  centre: 'center',
};

const ORGANIZE_BY: Record<string, OrganizeBy> = {
  task: 'task',
  tasks: 'task',
  project: 'project',
  projects: 'project',
  status: 'status',
  state: 'status',
  provider: 'provider',
  providers: 'provider',
  'agent type': 'provider',
  type: 'provider',
  model: 'provider',
  models: 'provider',
};

type Refs = { readonly ids: readonly string[] } | { readonly question: string } | null;

function refs(text: string, context: CanvasRefContext, prefer: RefPreference = 'any'): Refs {
  return fromResult(resolveCanvasRef(text, context, prefer));
}

function regionOnly(text: string, context: CanvasRefContext): Refs {
  return fromResult(resolveRegionRef(text, context));
}

function fromResult(result: RefResult): Refs {
  if (result.kind === 'match') return { ids: result.ids };
  if (result.kind === 'clarify') return { question: result.question };
  return null;
}

const layout = (...ops: LayoutOp[]): CanvasParse => ({
  kind: 'canvas',
  action: { type: 'layout', ops },
});
const act = (action: CanvasAction): CanvasParse => ({ kind: 'canvas', action });
const ask = (question: string): CanvasParse => ({ kind: 'clarify', question });

const isRegion = (id: string) => id.startsWith('region:');

/** Lower-cased; commas become "and" so "Atlas, Bravo and Cedar" stays a list. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s*,\s*(?:and\s+)?/g, ' and ')
    .replace(/[;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A name as the user said it: taken from the original utterance so "QA" stays "QA", with words
 * capitalized when the transcript had none.
 */
function title(name: string, original: string): string {
  const trimmed = name.trim().replace(/^(?:the|a|an)\s+/i, '');
  const at = original.toLowerCase().lastIndexOf(trimmed);
  const cased = at >= 0 ? original.slice(at, at + trimmed.length) : trimmed;
  if (/[A-Z]/.test(cased)) return cased;
  return cased.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Region scope for board-wide commands: an explicit region, else the region in view. */
function scopeOf(reference: string | undefined, context: CanvasRefContext): Refs {
  if (!reference) return { ids: context.currentRegion ? [context.currentRegion] : [] };
  const text = reference.trim().replace(/^(?:in|inside|within|everything in|the windows in) /, '');
  if (WHOLE_BOARD.test(text)) return { ids: [] };
  return regionOnly(text, context);
}

function sizeFromWord(word: string): SizeSpec | null {
  const factor = /\b(?:a (?:bit|little|tad|touch|little bit)|slightly)\b/.test(word)
    ? 'bit'
    : /\b(?:much|a lot|way)\b/.test(word)
      ? 'much'
      : 'more';
  const grow = (axis: 'both' | 'width' | 'height'): SizeSpec => ({
    kind: 'relative',
    axis,
    factor,
    direction: 'grow',
  });
  const shrink = (axis: 'both' | 'width' | 'height'): SizeSpec => ({
    kind: 'relative',
    axis,
    factor,
    direction: 'shrink',
  });
  if (/bigger|larger/.test(word)) return grow('both');
  if (/smaller/.test(word)) return shrink('both');
  if (/wider/.test(word)) return grow('width');
  if (/narrower|thinner/.test(word)) return shrink('width');
  if (/taller|longer/.test(word)) return grow('height');
  if (/shorter/.test(word)) return shrink('height');
  if (/^twice as (?:big|large)$/.test(word)) {
    return { kind: 'relative', axis: 'both', factor: 'double', direction: 'grow' };
  }
  if (/^twice as wide$/.test(word)) {
    return { kind: 'relative', axis: 'width', factor: 'double', direction: 'grow' };
  }
  if (/^twice as tall$/.test(word)) {
    return { kind: 'relative', axis: 'height', factor: 'double', direction: 'grow' };
  }
  if (/^half/.test(word)) {
    const axis = /wide/.test(word) ? 'width' : /tall/.test(word) ? 'height' : 'both';
    return { kind: 'relative', axis, factor: 'half', direction: 'shrink' };
  }
  if (word === 'small') return { kind: 'preset', preset: 'small' };
  if (word === 'medium') return { kind: 'preset', preset: 'medium' };
  if (word === 'large' || word === 'big' || word === 'huge') {
    return { kind: 'preset', preset: 'large' };
  }
  if (word === 'wide') return { kind: 'preset', preset: 'wide' };
  if (word === 'tall') return { kind: 'preset', preset: 'tall' };
  if (/normal|default|regular|standard/.test(word)) return { kind: 'preset', preset: 'default' };
  return null;
}

function growVerb(verb: string): SizeSpec {
  switch (verb) {
    case 'widen':
      return { kind: 'relative', axis: 'width', factor: 'more', direction: 'grow' };
    case 'lengthen':
    case 'heighten':
      return { kind: 'relative', axis: 'height', factor: 'more', direction: 'grow' };
    case 'narrow':
      return { kind: 'relative', axis: 'width', factor: 'more', direction: 'shrink' };
    case 'shorten':
      return { kind: 'relative', axis: 'height', factor: 'more', direction: 'shrink' };
    case 'shrink':
      return { kind: 'relative', axis: 'both', factor: 'more', direction: 'shrink' };
    default:
      return { kind: 'relative', axis: 'both', factor: 'more', direction: 'grow' };
  }
}

function screenFraction(word: string): 'half' | 'third' | 'quarter' | 'full' | null {
  if (/half/.test(word)) return 'half';
  if (/third/.test(word)) return word.includes('two') ? 'full' : 'third';
  if (/quarter/.test(word)) return 'quarter';
  if (/whole|all/.test(word)) return 'full';
  return null;
}

function nudgeAmount(qualifier: string | undefined): 'bit' | 'some' | 'far' {
  if (!qualifier) return 'some';
  if (/bit|little|tad|touch|slightly/.test(qualifier)) return 'bit';
  if (/lot|way|far|much/.test(qualifier)) return 'far';
  return 'some';
}

function windowsOnly(ids: readonly string[]): string[] {
  return ids.filter((id) => !isRegion(id));
}

/**
 * Parses a canvas layout command from a cleaned utterance (fillers and politeness removed).
 * Returns null when it is not one, so other grammar and the model get a turn.
 */
export function parseCanvasCommand(
  utterance: string,
  context: CanvasRefContext
): CanvasParse | null {
  const text = normalize(utterance);
  if (!text) return null;
  const original = utterance.replace(/[.!?]+$/, '');
  const named = (name: string) => title(name, original);

  // ── History and navigation ──
  if (UNDO.test(text)) return act({ type: 'undo' });
  if (REDO.test(text)) return act({ type: 'redo' });
  if (BACK.test(text)) return act({ type: 'back' });
  if (FORWARD.test(text)) return act({ type: 'forward' });
  if (UP.test(text)) return act({ type: 'up' });
  if (HOME.test(text)) return act({ type: 'home' });
  if (context.onStage && LEAVE_STAGE.test(text)) return act({ type: 'leaveStage' });
  if (context.onStage && PAGE_NEXT.test(text)) return act({ type: 'page', delta: 1 });
  if (context.onStage && PAGE_PREVIOUS.test(text)) return act({ type: 'page', delta: -1 });
  if (IMMERSIVE.test(text)) return act({ type: 'stage', ids: null, immersive: true });
  if (LIST_REGIONS.test(text)) return act({ type: 'describe', regionId: null });

  // ── Organize and tidy ──
  const organize = ORGANIZE.exec(text);
  if (organize?.[2]) {
    const by = ORGANIZE_BY[organize[2]];
    const scope = scopeOf(organize[1], context);
    if (!by || !scope) return null;
    if ('question' in scope) return ask(scope.question);
    return layout({ op: 'organize', scope: scope.ids[0] ?? null, by });
  }
  if (ORGANIZE_BARE.test(text)) {
    return layout({ op: 'organize', scope: context.currentRegion, by: 'task' });
  }
  const tidy = TIDY.exec(text);
  if (tidy) {
    const target = tidy[1]?.replace(/^up\s+/, '');
    const scope = scopeOf(target && target !== 'up' ? target : undefined, context);
    if (!scope) {
      const windows = target ? refs(target, context, 'window') : null;
      if (!windows) return null;
      if ('question' in windows) return ask(windows.question);
      return layout({ op: 'arrange', targets: windows.ids, scope: null, layout: 'tidy' });
    }
    if ('question' in scope) return ask(scope.question);
    return layout({ op: 'arrange', targets: null, scope: scope.ids[0] ?? null, layout: 'tidy' });
  }

  // ── Regions ──
  const create = CREATE.exec(text);
  if (create) {
    const name = create[1] ? named(create[1]) : undefined;
    if (!create[2]) {
      const members = context.selection.length > 1 && !name ? [...context.selection] : [];
      return layout({ op: 'createRegion', members, ...(name ? { name } : {}) });
    }
    const members = refs(create[2], context);
    if (!members) return null;
    if ('question' in members) return ask(members.question);
    return layout({ op: 'createRegion', members: members.ids, ...(name ? { name } : {}) });
  }
  const putInNew = PUT_IN_NEW.exec(text);
  if (putInNew?.[1]) {
    const members = refs(putInNew[1], context);
    if (!members) return null;
    if ('question' in members) return ask(members.question);
    const name = putInNew[2] ? named(putInNew[2]) : undefined;
    return layout({ op: 'createRegion', members: members.ids, ...(name ? { name } : {}) });
  }
  if (!/^(?:group|sort|cluster) (?:by|them by)\b/.test(text)) {
    const group = GROUP.exec(text);
    if (group?.[1]) {
      const members = refs(group[1], context);
      if (members) {
        if ('question' in members) return ask(members.question);
        const name = group[2] ? named(group[2]) : undefined;
        return layout({ op: 'createRegion', members: members.ids, ...(name ? { name } : {}) });
      }
    }
  }
  const rename = RENAME.exec(text);
  if (rename?.[1] && rename[2]) {
    const target = refs(rename[1], context, 'region');
    if (target && 'question' in target) return ask(target.question);
    const [id] = target?.ids ?? [];
    if (target?.ids.length === 1 && id) {
      const name = named(rename[2]);
      if (isRegion(id)) return layout({ op: 'renameRegion', region: id, name });
      if (id.startsWith('agent:')) return act({ type: 'renameAgent', id, name });
    }
    return null;
  }
  const call = CALL.exec(text);
  if (call?.[1] && call[2]) {
    const region = regionOnly(call[1], context);
    if (region && 'ids' in region && region.ids[0]) {
      return layout({ op: 'renameRegion', region: region.ids[0], name: named(call[2]) });
    }
    return null;
  }
  const color = COLOR.exec(text);
  if (color?.[1] && color[2]) {
    const region = regionOnly(color[1], context);
    const value = COLORS[color[2]];
    if (region && 'question' in region) return ask(region.question);
    if (region?.ids[0] && value) {
      return layout({ op: 'recolorRegion', region: region.ids[0], color: value });
    }
    return null;
  }
  const collapse = COLLAPSE.exec(text);
  if (collapse?.[1]) {
    const regions = refs(collapse[1], context, 'region');
    if (regions && 'ids' in regions && regions.ids.length > 0 && regions.ids.every(isRegion)) {
      return layout(
        ...regions.ids.map(
          (region): LayoutOp => ({ op: 'collapseRegion', region, collapsed: true })
        )
      );
    }
  }
  const expand = EXPAND.exec(text);
  if (expand?.[1]) {
    const target = refs(expand[1], context, 'region');
    if (target && 'question' in target) return ask(target.question);
    if (target && target.ids.length > 0) {
      if (target.ids.every(isRegion)) {
        return layout(
          ...target.ids.map(
            (region): LayoutOp => ({ op: 'collapseRegion', region, collapsed: false })
          )
        );
      }
      return layout({
        op: 'resize',
        targets: windowsOnly(target.ids),
        size: { kind: 'relative', axis: 'both', factor: 'more', direction: 'grow' },
      });
    }
    return null;
  }
  if (UNGROUP_BARE.test(text)) {
    const selected = context.selection.filter(isRegion);
    const region = selected.length === 1 ? selected[0] : context.currentRegion;
    if (!region) return ask('Which region?');
    return layout({ op: 'dissolveRegion', region });
  }
  const dissolve = DISSOLVE.exec(text);
  if (dissolve?.[1] && !UNDO.test(text)) {
    const regions = refs(dissolve[1], context, 'region');
    if (regions && 'ids' in regions && regions.ids.length > 0 && regions.ids.every(isRegion)) {
      return layout(...regions.ids.map((region): LayoutOp => ({ op: 'dissolveRegion', region })));
    }
  }
  const fit = FIT.exec(text);
  if (fit?.[1]) {
    const target = refs(fit[1], context, 'region');
    if (target && 'question' in target) return ask(target.question);
    if (target && target.ids.length > 0) {
      if (target.ids.every(isRegion)) {
        return layout(...target.ids.map((region): LayoutOp => ({ op: 'fitRegion', region })));
      }
      return layout({
        op: 'resize',
        targets: windowsOnly(target.ids),
        size: { kind: 'relative', axis: 'both', factor: 'more', direction: 'shrink' },
      });
    }
    return null;
  }

  // ── Stage ──
  if (STAGE_BARE.test(text)) return act({ type: 'stage', ids: null });
  const stage = STAGE_TAIL.exec(text) ?? STAGE_HEAD.exec(text);
  if (stage?.[1]) {
    const verbIsOpen = /^(?:open|enter)\s/.test(text) && !STAGE_TAIL.test(text);
    const target = verbIsOpen ? regionOnly(stage[1], context) : refs(stage[1], context, 'region');
    if (target && 'question' in target) return ask(target.question);
    if (target && target.ids.length > 0) return act({ type: 'stage', ids: target.ids });
    if (!verbIsOpen) return null;
  }
  const solo = SOLO.exec(text);
  if (solo?.[1]) {
    const target = refs(solo[1], context, 'window');
    if (target && 'question' in target) return ask(target.question);
    const [id] = target?.ids ?? [];
    if (target?.ids.length === 1 && id && !isRegion(id)) {
      return context.onStage ? act({ type: 'solo', id }) : act({ type: 'stage', ids: [id] });
    }
    if (target && target.ids.length > 1) return act({ type: 'stage', ids: target.ids });
    return null;
  }

  // ── Arrangement ──
  const arrange = ARRANGE.exec(text);
  if (arrange?.[1] && arrange[2]) {
    const target = refs(arrange[1], context, 'window');
    if (!target) return null;
    if ('question' in target) return ask(target.question);
    const style: ArrangeLayout = /grid/.test(arrange[2])
      ? 'grid'
      : /column|stack|top of each other|vertical/.test(arrange[2])
        ? 'column'
        : 'row';
    return layout({ op: 'arrange', targets: target.ids, scope: null, layout: style });
  }
  const lineUp = LINE_UP.exec(text);
  if (lineUp?.[1]) {
    const target = refs(lineUp[1], context, 'window');
    if (target && 'ids' in target && target.ids.length > 1) {
      const style: ArrangeLayout = text.startsWith('stack') ? 'column' : 'row';
      return layout({ op: 'arrange', targets: target.ids, scope: null, layout: style });
    }
  }

  // ── Swap ──
  if (SWAP_BARE.test(text)) {
    const pool = context.selection.length === 2 ? context.selection : context.recent;
    const [a, b] = pool;
    if (pool.length === 2 && a && b) return layout({ op: 'swap', a, b });
    return ask('Which two should I swap?');
  }
  const swap = SWAP.exec(text);
  if (swap?.[1] && swap[2] && !/^switch to\b/.test(text)) {
    const a = refs(swap[1], context);
    const b = refs(swap[2], context);
    if (a && 'question' in a) return ask(a.question);
    if (b && 'question' in b) return ask(b.question);
    if (a?.ids.length === 1 && b?.ids.length === 1 && a.ids[0] && b.ids[0]) {
      return layout({ op: 'swap', a: a.ids[0], b: b.ids[0] });
    }
    return null;
  }

  // ── Moves ──
  const relative = MOVE_RELATIVE.exec(text);
  if (relative?.[1] && relative[2] && relative[3]) {
    const targets = refs(relative[1], context);
    const anchor = refs(relative[3], context, 'window');
    if (targets && 'question' in targets) return ask(targets.question);
    if (anchor && 'question' in anchor) return ask(anchor.question);
    if (targets && anchor && anchor.ids.length === 1 && anchor.ids[0]) {
      const word = relative[2];
      const side = /left/.test(word)
        ? 'left'
        : /above|over|top/.test(word)
          ? 'above'
          : /below|under|beneath/.test(word)
            ? 'below'
            : 'right';
      return layout({
        op: 'move',
        targets: targets.ids,
        to: { kind: 'relative', anchor: anchor.ids[0], side },
      });
    }
  }
  const slot = MOVE_SLOT.exec(text);
  if (slot?.[1] && slot[2]) {
    const targets = refs(slot[1], context);
    const where = SLOTS[slot[2]];
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets && where)
      return layout({ op: 'move', targets: targets.ids, to: { kind: 'slot', slot: where } });
  }
  const nudge = NUDGE.exec(text);
  if (nudge?.[1] && nudge[3]) {
    const targets = refs(nudge[1], context);
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets) {
      const raw = nudge[3];
      const direction: Direction =
        raw === 'higher' ? 'up' : raw === 'lower' ? 'down' : (raw as Direction);
      const qualifier =
        nudge[2] ?? /(a (?:bit|little|tad|touch)|slightly|a lot|more)$/.exec(text)?.[1];
      return layout({
        op: 'move',
        targets: targets.ids,
        to: { kind: 'nudge', direction, amount: nudgeAmount(qualifier) },
      });
    }
  }
  const out = MOVE_OUT.exec(text);
  if (out?.[1]) {
    const targets = refs(out[1], context);
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets) {
      return layout({ op: 'move', targets: targets.ids, to: { kind: 'region', region: null } });
    }
  }
  const into = MOVE_INTO.exec(text);
  if (into?.[1] && into[2]) {
    const destination = into[2].replace(/\s+(?:region|group|area|with (?:the )?others)$/, '');
    const root = /^(?:board|canvas|main (?:board|canvas)|top level|root)$/.test(destination);
    const region = root ? { ids: [] } : regionOnly(destination, context);
    if (region) {
      if ('question' in region) return ask(region.question);
      const targets = refs(into[1], context);
      if (targets && 'question' in targets) return ask(targets.question);
      if (targets) {
        return layout({
          op: 'move',
          targets: targets.ids,
          to: { kind: 'region', region: region.ids[0] ?? null },
        });
      }
    }
  }

  // ── Sizes ──
  const match = MATCH.exec(text);
  if (match?.[1] && match[2]) {
    const targets = refs(match[1], context, 'window');
    const like = refs(match[2], context, 'window');
    if (targets && 'question' in targets) return ask(targets.question);
    if (like && 'question' in like) return ask(like.question);
    if (targets && like?.ids.length === 1 && like.ids[0]) {
      return layout({
        op: 'resize',
        targets: windowsOnly(targets.ids),
        size: { kind: 'match', like: like.ids[0] },
      });
    }
  }
  const screen = SCREEN.exec(text);
  if (screen?.[1] && screen[2]) {
    const targets = refs(screen[1], context, 'window');
    const fraction = screenFraction(screen[2]);
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets && fraction) {
      const axis = /tall$/.test(text) ? 'height' : fraction === 'quarter' ? 'both' : 'width';
      return layout({
        op: 'resize',
        targets: windowsOnly(targets.ids),
        size: { kind: 'screen', fraction, axis: fraction === 'full' ? 'both' : axis },
      });
    }
  }
  const resize = RESIZE.exec(text);
  if (resize?.[1] && resize[2]) {
    const targets = refs(resize[1], context, 'window');
    const size = sizeFromWord(resize[2]);
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets && size && windowsOnly(targets.ids).length > 0) {
      return layout({ op: 'resize', targets: windowsOnly(targets.ids), size });
    }
  }
  const grow = GROW.exec(text);
  if (grow?.[1]) {
    const verb = text.split(' ')[0] ?? 'grow';
    const targets = refs(grow[1], context, 'window');
    if (targets && 'ids' in targets && windowsOnly(targets.ids).length > 0) {
      return layout({ op: 'resize', targets: windowsOnly(targets.ids), size: growVerb(verb) });
    }
  }

  // ── Looking around ──
  const goTo = GO_TO.exec(text);
  if (goTo?.[1]) {
    const region = regionOnly(goTo[1], context);
    if (region && 'ids' in region && region.ids[0]) {
      return act({ type: 'goToRegion', regionId: region.ids[0] });
    }
  }
  const describe = DESCRIBE_REGION.exec(text);
  if (describe?.[1]) {
    const region = regionOnly(describe[1], context);
    if (region && 'question' in region) return ask(region.question);
    if (region?.ids[0]) return act({ type: 'describe', regionId: region.ids[0] });
  }
  const where = WHERE.exec(text);
  if (where?.[1]) {
    const target = refs(where[1], context);
    if (target && 'ids' in target && target.ids.length > 0) {
      return act({ type: 'where', ids: target.ids });
    }
  }
  return null;
}

/** Utterances that look like layout talk: skip Jev routing and go straight to the model. */
export const LAYOUT_CUES =
  /\b(?:region|regions|group|groups|sub ?canvas|stage|full ?screen|side by side|tidy|organi[sz]e|arrange|layout|lay out|move|put|drag|resize|bigger|smaller|wider|narrower|taller|shorter|swap|collapse|expand|ungroup|dissolve|corner|next to|beside|above|below|left of|right of)\b/i;
