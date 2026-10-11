/**
 * Spoken canvas layout commands: regions ("make a region called Review with Atlas and Bravo"),
 * moves ("put Cedar next to Atlas", "move these into Review"), sizes ("make the browser half the
 * screen"), arrangement ("organize by status", "tidy up", "put these four agents in quadrants"),
 * the stage ("full screen Review"), and navigation ("open Review", "switch to the new one",
 * "switch back", "next sub-canvas", "main canvas", "back", "undo"). Pure: it returns what to do, the conductor does it.
 *
 * In Canvas Pro it also takes desk commands ("new desk called Review with Atlas", "next desk",
 * "put Cedar on the Frontend desk", "bring Atlas here", "remove this desk"); "desktop" and "space"
 * are understood as desk. Only the mode switch itself ("switch to Canvas Pro") works on both
 * canvases, so on the classic one every other phrase means what it always did.
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
import type { RegionColor, WindowStatus } from '@core/features/canvas/api/canvas-regions';
import {
  createDesk,
  DESK_WORD,
  deskPhrase,
  moveToDesk,
  renameDesk,
  reorderDesk,
  resolveDesk,
  type DeskCommand,
} from './canvas-desk-ops';
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
  /** The next or previous sub-canvas beside the current one. */
  | { readonly type: 'adjacentRegion'; readonly step: 1 | -1 }
  | { readonly type: 'renameAgent'; readonly id: string; readonly name: string }
  /** Say what is in a region (or list the regions when null). */
  | { readonly type: 'describe'; readonly regionId: string | null }
  | { readonly type: 'where'; readonly ids: readonly string[] }
  /** Canvas Pro: make, switch, or change a desk, show a visitor, or switch the canvas mode. */
  | { readonly type: 'desk'; readonly command: DeskCommand };

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
  /^(?:go home|home|back to (?:the )?(?:whole |main )?(?:board|canvas|top)|take me home|(?:show me )?the whole (?:board|canvas)|(?:go (?:back )?to |take me (?:back )?to |switch (?:back )?to |return to )?(?:the )?main (?:board|canvas)|top level|leave (?:all )?(?:the )?(?:sub ?canvas(?:es)?|regions|workspaces))$/;
const SUB = '(?:region|group|area|sub ?canvas|workspace|space)';
/** Out of the sub-canvas the user is in (to its parent, or the main canvas). */
const LEAVE_REGION = new RegExp(
  `^(?:(?:leave|exit|close|get out of|step out of|zoom out of|back out of) (?:this|the|my) ${SUB}|leave|exit|get out|step out|back out)$`
);
const ADJACENT_REGION = new RegExp(
  `^(?:(?:go to|switch to|take me to|show(?: me)?|jump to|open) )?(?:the )?(next|previous|prev) ${SUB}$`
);
const SWITCH_BACK = new RegExp(
  `^(?:switch back|flip back|swap back|go back to (?:the )?(?:other|previous|last) (?:one|${SUB})|back to (?:the )?(?:other|previous|last) (?:one|${SUB}))$`
);
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
const QUADRANTS =
  /^(?:put|arrange|lay out|place|set|organi[sz]e|split|make|tile|turn|show) (.+?) (?:in|into|as) (?:(?:four )?quadrants|quarters|tiles|a tiled layout|tiled|(?:a )?(?:2|two) by (?:2|two)(?: grid)?)$/;
const TILE =
  /^(?:tile|re ?tile|auto ?tile|tile up)(?: (.+?))?(?: evenly| again| back)?$|^(?:make|let) (.+?) (?:fill|share|use) (?:the )?(?:whole |entire |all the )?(?:space|room|screen|region|sub ?canvas|workspace)$/;
const TILE_HERE =
  /^(?:it|this|here|everything|all|everything here|all of it|the windows|the space|this (?:region|group|area|sub ?canvas|workspace|space))$/;
const GIVE_ROOM =
  /^give (.+?) (more|less|a (?:bit|little) more|a (?:bit|little) less|much more|a lot more) (?:room|space)$/;

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

// ── Canvas Pro: the mode and desks ("desktop" and "space" are heard as desk) ──
const PRO_NAME = '(?:canvas pro|pro canvas)(?: mode)?';
const PRO_ON = new RegExp(
  `^(?:(?:(?:switch|change|go|move)(?: over)? to|use|turn on|enable|start|enter|open|try)(?: the)? ${PRO_NAME}|turn (?:the )?${PRO_NAME} on)$`
);
const PRO_OFF = new RegExp(
  `^(?:(?:(?:switch|change|go|move)(?: back| over)? to|use|return to|back to|turn on|enable)(?: the)? classic (?:canvas|board)(?: mode)?|(?:turn off|leave|exit|disable|quit|stop using)(?: the)? ${PRO_NAME}|turn (?:the )?${PRO_NAME} off)$`
);
/** Only once in Canvas Pro: on the classic canvas "the normal canvas" is not a mode. */
const PRO_OFF_LOOSE =
  /^(?:(?:switch|change|go|move)(?: back| over)? to|use|return to|back to)(?: the)? (?:regular|normal|old|standard|original) (?:canvas|board)$/;
const DESKS_WORD = '(?:desks|desktops|spaces)';
const LIST_DESKS = new RegExp(
  `^(?:(?:what|which) ${DESKS_WORD} (?:are there|do i have|exist|have i got)|(?:list|name|show me|what are) (?:the |my |all |all the |all my )?${DESKS_WORD}|(?:what|which) ${DESK_WORD} (?:am i on|am i in|is this)|where am i)$`
);
const WHATS_ON_DESK = /^(?:what(?:'s| is| are)|who(?:'s| is| are)) on (.+)$/;
const LEAVE_DESK = new RegExp(
  `^(?:leave|exit|get out of|step out of|back out of) (?:this|the|my) ${DESK_WORD}$`
);
const DESK_MAKE = '(?:make|create|add|start|set up|open|build|give me|i want|i need)(?: me)?';
const DESK_STAY = `( (?:and|but) (?:stay|keep me|leave me)(?: here| where i am| on this ${DESK_WORD})?)?`;
const DESK_GATHER = new RegExp(
  `^(?:${DESK_MAKE} )?(?:a |an |one |another )?(?:new )?(?:gathering |triage )?${DESK_WORD}(?: (?:called|named|titled) (.+?))? (?:for|of|that (?:shows|gathers|collects|has|holds)|to (?:show|gather|collect|hold)|showing|gathering|collecting) (.+)$`
);
const GATHER_NAMED = / (?:called|named|titled) (.+)$/;
const GATHER_SUBJECT =
  '(?:everything|anything|everyone|anyone|whatever|whoever|what|every (?:agent|window)|all(?: of)?(?: the)? (?:agents|windows)|(?:the )?(?:agents|windows|ones))';
const GATHER_WHAT = new RegExp(
  `^(?:${GATHER_SUBJECT}(?:'s)? )?(?:(?:that|which|who)(?:'s| is| are| has| have)? )?(?:(?:is|are|has|have) )?(?:all )?(?:the )?(.+?)(?: (?:agents|windows|ones))?$`
);
const GATHER_STATUS: readonly (readonly [RegExp, WindowStatus])[] = [
  [
    /^(?:needs? (?:me|you|my attention|attention)|waiting(?: (?:for|on) me)?|blocked|triage)$/,
    'needs-you',
  ],
  [/^(?:failed|failing|broken|errored|crashed|errors|failures)$/, 'error'],
  [/^(?:working|running|busy)$/, 'working'],
  [/^(?:done|finished|completed|complete)$/, 'done'],
  [/^(?:idle|quiet)$/, 'idle'],
];
const DESK_PREP = '(?:onto|on to|over to|to|on|in|into)';
const DESK_MOVE_NEW = new RegExp(
  `^${MOVE_VERB} (.+?) ${DESK_PREP} (?:a|an|another|its own|their own|a brand) (?:new |separate |fresh )?${DESK_WORD}(?: (?:called|named|titled) (.+?))?${DESK_STAY}$`
);
// "Open a desk" makes one; a bare "open space" does not say so.
const DESK_CREATE = new RegExp(
  `^(?:${DESK_MAKE} (?:(?:a|an|one|another) (?:new |empty |blank |fresh )?|new |one more )|new |another |a new |one more )${DESK_WORD}(?: (?:called|named|titled) (.+?))?(?: (?:with|for|containing|holding|and put|and add|and move|that has|to hold) (.+?)(?: (?:in|on|onto|to|into) it| inside| there)?)?${DESK_STAY}$`
);
const DESK_RENAME_HERE = new RegExp(
  `^(?:rename|retitle|call|name) (?:this|that|the|the current|my) ${DESK_WORD} (?:to |as )?(.+)$`
);
const DESK_REORDER = new RegExp(
  `^(?:move|shift|put|push|slide|send|make|bring) (?:(.+?) )?${DESK_WORD} (?:one )?(?:over )?(?:to the |to be |to |the )?(left|right|first|last|start|beginning|front|end)(?: one)?$`
);
const DESK_POSITIONS: Record<string, 'first' | 'last' | 'left' | 'right'> = {
  left: 'left',
  right: 'right',
  first: 'first',
  start: 'first',
  beginning: 'first',
  front: 'first',
  last: 'last',
  end: 'last',
};
const DESK_REMOVE_VERB = '(?:remove|close|delete|get rid of|drop|discard|destroy|trash|kill)';
const DESK_REMOVE = new RegExp(`^${DESK_REMOVE_VERB} (?:(.+?) )?${DESK_WORD}$`);
const DESK_REMOVE_NUMBERED = new RegExp(`^${DESK_REMOVE_VERB} (${DESK_WORD} .+)$`);
const BRING_HERE = new RegExp(
  `^(?:bring|pull|fetch|get|grab|summon|borrow|show(?: me)?) (.+?) (?:over here|in here|here|over|(?:on|onto|to) (?:this|the current) ${DESK_WORD})$`
);
const SEND_BACK = /^(?:send|return|take|put) (.+?) (?:back home|back|home)$/;
const KEEP_HERE = new RegExp(
  `^(?:keep|leave|pin|park) (.+?) (?:here|on this ${DESK_WORD}|on this one)$|^(?:let|make) (.+?) (?:stay|live)(?: here)?$`
);
const ALL_VISITORS =
  /^(?:them|them all|those|they|all|all of them|everyone|everything|everybody|both|both of them|(?:the |all (?:the )?)?visitors|(?:the |all (?:the )?)?visiting (?:ones|windows|agents))$/;
const ONE_VISITOR = /^(?:it|that|that one|this|this one|the visitor|that window|this window)$/;
const DESK_FOLLOW =
  '( and (?:follow(?: (?:it|them|along))?|take me (?:there|along|with (?:it|them))|go there|switch(?: there| over| to it)?|come along|bring me(?: there| along)?|show (?:me|it)))?';
const DESK_MOVE = new RegExp(
  `^${MOVE_VERB} (.+?) ${DESK_PREP} (?:the |my )?(.+?) ${DESK_WORD}${DESK_FOLLOW}$`
);
const DESK_MOVE_NUMBERED = new RegExp(
  `^${MOVE_VERB} (.+?) ${DESK_PREP} (${DESK_WORD} .+?)${DESK_FOLLOW}$`
);
const MOVE_HERE = /^(?:move|put|place|drop) (.+?) (?:over )?here$/;
const DESK_GO =
  '(?:(?:go|switch|swap|flip|jump|change|head|hop|move)(?: over| back)? to|take me(?: back)? to|show(?: me)?|open|bring up|give me|back to)';
const DESK_SWITCH = new RegExp(`^(?:(${DESK_GO}) )?(?:the |my )?(.+?) ${DESK_WORD}$`);
const DESK_SWITCH_NUMBERED = new RegExp(`^(?:(${DESK_GO}) )?(${DESK_WORD} .+)$`);

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
  return deskRefs(text, context) ?? fromResult(resolveCanvasRef(text, context, prefer));
}

function regionOnly(text: string, context: CanvasRefContext): Refs {
  return deskRefs(text, context) ?? fromResult(resolveRegionRef(text, context));
}

/**
 * Canvas Pro: a phrase that says desk ("the Review desk", "this desk", "desk 2") names a desk
 * wherever a region can be named. Undefined when it is not one, so the usual resolver has a go.
 */
function deskRefs(text: string, context: CanvasRefContext): Refs | undefined {
  const desk = deskPhrase(text, context);
  if (!desk) return undefined;
  return desk.kind === 'match' ? { ids: [desk.id] } : { question: desk.question };
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

/** "Everything that needs me", "the failed ones", "agents that are done": the status meant. */
function gatherStatus(what: string): WindowStatus | null {
  const said = GATHER_WHAT.exec(what.trim())?.[1];
  if (!said) return null;
  return GATHER_STATUS.find(([pattern]) => pattern.test(said))?.[1] ?? null;
}

/** Windows (and regions on a desk) for a desk command; a desk itself is never one of them. */
function deskWindows(text: string, context: CanvasRefContext): Refs {
  const found = refs(text, context, 'window');
  if (!found || 'question' in found) return found;
  const desks = context.desks?.order ?? [];
  return found.ids.length > 0 && !found.ids.some((id) => desks.includes(id)) ? found : null;
}

/**
 * Who "send it back" or "keep them here" means among the windows visiting the desk in view:
 * `ids: null` is all of them. "It" with several visiting and none focused is a question.
 */
function visitorRefs(
  who: string,
  context: CanvasRefContext
): { readonly ids: readonly string[] | null } | { readonly question: string } | null {
  const visitors = context.desks?.visitors ?? [];
  if (ALL_VISITORS.test(who)) return { ids: null };
  if (ONE_VISITOR.test(who)) {
    const [only] = visitors;
    if (context.focusedId && visitors.includes(context.focusedId)) {
      return { ids: [context.focusedId] };
    }
    if (visitors.length === 1 && only) return { ids: [only] };
    const names = visitors.map(
      (id) => context.entities.find((entity) => entity.id === id)?.name ?? 'a window'
    );
    return { question: `Which one: ${names.join(' or ')}? Or say "all of them".` };
  }
  const found = refs(who, context, 'window');
  if (!found || 'question' in found) return found;
  const ids = windowsOnly(found.ids);
  return ids.length > 0 ? { ids } : null;
}

/**
 * Canvas Pro. Switching the mode works on either canvas; everything else needs desks, so on the
 * classic canvas this claims nothing more. Null when the utterance is not about desks (or names
 * something that does not resolve), so the rest of the grammar and the model get a turn.
 */
function parseDeskCommand(
  text: string,
  context: CanvasRefContext,
  named: (name: string) => string
): CanvasParse | null {
  const desk = (command: DeskCommand): CanvasParse => act({ type: 'desk', command });
  if (PRO_ON.test(text)) return desk({ action: 'set_mode', mode: 'pro' });
  if (PRO_OFF.test(text) || (context.desks && PRO_OFF_LOOSE.test(text))) {
    return desk({ action: 'set_mode', mode: 'classic' });
  }
  const desks = context.desks;
  if (!desks) return null;

  // ── Looking around ──
  if (LIST_DESKS.test(text)) return act({ type: 'describe', regionId: null });
  if (LEAVE_DESK.test(text)) return act({ type: 'up' });
  const whatsOn = WHATS_ON_DESK.exec(text);
  if (whatsOn?.[1]) {
    const target = resolveDesk(whatsOn[1], context);
    if (target.kind === 'match') return act({ type: 'describe', regionId: target.id });
  }

  // ── New desks ──
  const gather = DESK_GATHER.exec(text);
  if (gather?.[2]) {
    const tail = GATHER_NAMED.exec(gather[2]);
    const status = gatherStatus(tail ? gather[2].slice(0, tail.index) : gather[2]);
    const name = gather[1] ?? tail?.[1];
    if (status) return desk(createDesk({ gather: status, ...(name ? { name: named(name) } : {}) }));
  }
  const moveNew = DESK_MOVE_NEW.exec(text);
  if (moveNew?.[1]) {
    const members = deskWindows(moveNew[1], context);
    if (members && 'question' in members) return ask(members.question);
    if (members) {
      return desk(
        createDesk({
          members: members.ids,
          ...(moveNew[2] ? { name: named(moveNew[2]) } : {}),
          ...(moveNew[3] ? { follow: false } : {}),
        })
      );
    }
  }
  const create = DESK_CREATE.exec(text);
  if (create) {
    const options = {
      ...(create[1] ? { name: named(create[1]) } : {}),
      ...(create[3] ? { follow: false } : {}),
    };
    if (!create[2]) return desk(createDesk(options));
    const members = deskWindows(create[2], context);
    if (members && 'question' in members) return ask(members.question);
    if (!members) return null;
    return desk(createDesk({ ...options, members: members.ids }));
  }

  // ── Changing a desk ──
  const renameHere = DESK_RENAME_HERE.exec(text);
  if (renameHere?.[1] && desks.active) {
    return desk(renameDesk(desks.active, named(renameHere[1])));
  }
  const reorder = DESK_REORDER.exec(text);
  const position = reorder?.[2] ? DESK_POSITIONS[reorder[2]] : undefined;
  if (reorder && position) {
    const target = resolveDesk(`${reorder[1] ?? 'this'} desk`, context);
    if (target.kind === 'clarify') return ask(target.question);
    if (target.kind === 'match') return desk(reorderDesk(target.id, position));
  }
  const remove = DESK_REMOVE.exec(text);
  const removed = remove ? `${remove[1] ?? 'this'} desk` : DESK_REMOVE_NUMBERED.exec(text)?.[1];
  if (removed) {
    const target = resolveDesk(removed, context);
    if (target.kind === 'clarify') return ask(target.question);
    if (target.kind === 'match') return desk({ action: 'remove', desk: target.id, into: null });
  }

  // ── Visitors: a window from another desk shown here without moving it ──
  const bring = BRING_HERE.exec(text);
  if (bring?.[1]) {
    const windows = refs(bring[1], context, 'window');
    if (windows && 'question' in windows) return ask(windows.question);
    const ids = windows ? windowsOnly(windows.ids) : [];
    if (ids.length > 0) return desk({ action: 'bring', windows: ids });
  }
  // With nobody visiting, "send it back" is not about desks.
  if (desks.visitors.length > 0) {
    const back = SEND_BACK.exec(text);
    const keep = back ? null : KEEP_HERE.exec(text);
    const who = back?.[1] ?? keep?.[1] ?? keep?.[2];
    if (who) {
      const visitors = visitorRefs(who, context);
      if (visitors && 'question' in visitors) return ask(visitors.question);
      if (visitors) return desk({ action: back ? 'send_back' : 'keep', windows: visitors.ids });
    }
  }

  // ── Windows to a desk, for good ──
  const move = DESK_MOVE.exec(text);
  const moveNumbered = move ? null : DESK_MOVE_NUMBERED.exec(text);
  const destination = move ? `${move[2]} desk` : moveNumbered?.[2];
  const moved = move?.[1] ?? moveNumbered?.[1];
  if (destination && moved) {
    const target = resolveDesk(destination, context);
    if (target.kind === 'clarify') return ask(target.question);
    if (target.kind === 'match') {
      const windows = deskWindows(moved, context);
      if (windows && 'question' in windows) return ask(windows.question);
      const follow = Boolean((move ?? moveNumbered)?.[3]);
      if (windows) return desk(moveToDesk(windows.ids, target.id, follow, context));
    }
  }
  const here = MOVE_HERE.exec(text);
  const place = context.currentRegion ?? desks.active;
  if (here?.[1] && place) {
    const windows = deskWindows(here[1], context);
    if (windows && 'question' in windows) return ask(windows.question);
    if (windows) return desk(moveToDesk(windows.ids, place, false, context));
  }

  // ── Switching ──
  const go = DESK_SWITCH.exec(text);
  const goNumbered = go ? null : DESK_SWITCH_NUMBERED.exec(text);
  const wanted = go ? `${go[2]} desk` : goNumbered?.[2];
  if (wanted) {
    const target = resolveDesk(wanted, context);
    if (target.kind === 'clarify') return ask(target.question);
    // Without a verb, "this desk" is not a request to go anywhere.
    const asked = Boolean((go ?? goNumbered)?.[1]);
    if (target.kind === 'match' && (asked || target.id !== desks.active)) {
      return desk({ action: 'switch', desk: target.id });
    }
  }
  return null;
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
  // Before the region forms: in Canvas Pro "next space" is a desk, and "close this desk" removes it.
  const deskCommand = parseDeskCommand(text, context, named);
  if (deskCommand) return deskCommand;
  if (!context.onStage && LEAVE_REGION.test(text)) {
    return context.currentRegion ? act({ type: 'up' }) : ask("You're on the main canvas already.");
  }
  const adjacent = ADJACENT_REGION.exec(text);
  if (adjacent?.[1]) return act({ type: 'adjacentRegion', step: adjacent[1] === 'next' ? 1 : -1 });
  if (SWITCH_BACK.test(text)) {
    const previous = context.previousRegion;
    if (previous && context.entities.some((entity) => entity.id === previous)) {
      return act({ type: 'goToRegion', regionId: previous });
    }
    return act({ type: 'back' });
  }
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
    // "Open Review" / "enter the new one" goes into the sub-canvas (it fills the screen); the
    // stage is for "full screen", "stage", "maximize".
    const verbIsOpen = /^(?:open|enter)\s/.test(text) && !STAGE_TAIL.test(text);
    const target = verbIsOpen ? regionOnly(stage[1], context) : refs(stage[1], context, 'region');
    if (target && 'question' in target) return ask(target.question);
    const [first] = target?.ids ?? [];
    if (verbIsOpen && first) return act({ type: 'goToRegion', regionId: first });
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

  // ── Tiling: windows share a sub-canvas as a weighted split (four make quadrants) ──
  const quadrants = QUADRANTS.exec(text);
  const tile = quadrants ? null : TILE.exec(text);
  if (quadrants || tile) {
    const target = (quadrants?.[1] ?? tile?.[1] ?? tile?.[2])?.trim();
    if (!target || TILE_HERE.test(target)) {
      return layout({ op: 'arrange', targets: null, scope: context.currentRegion, layout: 'tile' });
    }
    const found = refs(target, context);
    if (found && 'question' in found) return ask(found.question);
    const [only] = found?.ids ?? [];
    if (found?.ids.length === 1 && only && isRegion(only)) {
      return layout({ op: 'arrange', targets: null, scope: only, layout: 'tile' });
    }
    if (found && windowsOnly(found.ids).length > 0) {
      return layout({
        op: 'arrange',
        targets: windowsOnly(found.ids),
        scope: null,
        layout: 'tile',
      });
    }
    if (quadrants) return null;
  }
  const room = GIVE_ROOM.exec(text);
  if (room?.[1] && room[2]) {
    const targets = refs(room[1], context, 'window');
    if (targets && 'question' in targets) return ask(targets.question);
    if (targets && windowsOnly(targets.ids).length > 0) {
      const amount = room[2];
      return layout({
        op: 'resize',
        targets: windowsOnly(targets.ids),
        size: {
          kind: 'relative',
          axis: 'both',
          factor: /bit|little/.test(amount) ? 'bit' : /much|lot/.test(amount) ? 'much' : 'more',
          direction: /less/.test(amount) ? 'shrink' : 'grow',
        },
      });
    }
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
    // "Switch to the new one" with none made yet: say so rather than guess.
    if (region && 'question' in region && /\b(?:new|newest|other|previous|last)\b/.test(goTo[1])) {
      return ask(region.question);
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
  /\b(?:region|regions|group|groups|sub ?canvas|sub ?canvases|workspace|desks?|canvas pro|classic canvas|quadrants?|tile|tiled|stage|full ?screen|side by side|tidy|organi[sz]e|arrange|layout|lay out|move|put|drag|resize|bigger|smaller|wider|narrower|taller|shorter|swap|collapse|expand|ungroup|dissolve|corner|next to|beside|above|below|left of|right of)\b/i;
