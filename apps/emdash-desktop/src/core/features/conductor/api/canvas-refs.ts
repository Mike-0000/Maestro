/**
 * Resolves spoken references to canvas windows and regions: names ("Atlas", "the Review region"),
 * lists ("Atlas and Bravo"), pronouns ("these" is the selection, "them" what the last change
 * touched, "this" the focused window), status groups ("the waiting ones"), and kinds ("the
 * browsers"). Pure; never guesses between two candidates.
 */

import type { WindowStatus } from '@core/features/canvas/api/canvas-regions';
import {
  editDistance,
  normalizeSpoken,
  phoneticKey,
  resolveAgent,
  type RosterAgent,
} from './resolver';

export type CanvasEntityKind = 'agent' | 'browser' | 'note' | 'region';

export type CanvasEntity = {
  /** Tile id (`agent:…`, `browser:…`, `note:…`) or region id (`region:…`). */
  readonly id: string;
  readonly kind: CanvasEntityKind;
  readonly name: string;
  readonly providerLabel?: string;
  readonly taskName?: string;
  readonly status?: WindowStatus;
  /** Region the window or region sits in. */
  readonly parentId?: string | null;
  /** Closed or filtered out: addressable, but visible windows win. */
  readonly hidden?: boolean;
};

export type CanvasRefContext = {
  readonly entities: readonly CanvasEntity[];
  /** Selected windows and regions on the board. */
  readonly selection: readonly string[];
  /** Focused window (tile id). */
  readonly focusedId: string | null;
  /** What the last layout change touched, while it is fresh ("make them bigger"). */
  readonly recent: readonly string[];
  /** The region the user is looking at (board scope or stage region). */
  readonly currentRegion: string | null;
  readonly onStage: boolean;
};

export type RefResult =
  | { readonly kind: 'match'; readonly ids: readonly string[] }
  | { readonly kind: 'clarify'; readonly question: string }
  | { readonly kind: 'none' };

export type RefPreference = 'region' | 'window' | 'any';

const NONE: RefResult = { kind: 'none' };

const SELECTION =
  /^(?:these|these ones|these windows|these agents|this selection|the selection|selection|selected|the selected(?: ones| windows| agents)?|what i(?:'ve| have)? selected)$/;
const THEM = /^(?:them|those|they|those ones|those windows|those agents|both|both of them)$/;
const IT = /^(?:it|that|that one|that window|that agent)$/;
const THIS =
  /^(?:this|this one|this window|this agent|current|focused|the focused one|the current one)$/;
const HERE_REGION =
  /^(?:here|this region|this group|this area|the current region|current region|the region i'?m in)$/;
const ALL =
  /^(?:all|everything|everyone|every window|every agent|all windows|all agents|all (?:the )?(?:windows|agents)|all of them)$/;
const BROWSERS = /^(?:browsers|apps|app browsers|all (?:the )?(?:browsers|apps|app browsers))$/;
const ONE_BROWSER = /^(?:browser|app|app browser|the browser|the app)$/;
const NOTES = /^(?:notes|all (?:the )?notes|sticky notes)$/;
const ONE_NOTE = /^(?:note|the note|sticky note)$/;
const TASK_BROWSER = /^(.+?)(?:'s)? (?:app|browser|app browser)$/;
const REGION_QUALIFIED_BEFORE = /^(?:region|group|area|sub ?canvas|space|zone)\s+(.+)$/;
const REGION_QUALIFIED_AFTER = /^(.+?)\s+(?:region|group|area|sub ?canvas|space|zone)$/;

const STATUS_WORDS: Record<string, WindowStatus> = {
  waiting: 'needs-you',
  blocked: 'needs-you',
  working: 'working',
  busy: 'working',
  running: 'working',
  done: 'done',
  finished: 'done',
  completed: 'done',
  complete: 'done',
  idle: 'idle',
  quiet: 'idle',
  failed: 'error',
  broken: 'error',
  errored: 'error',
  crashed: 'error',
};
const STATUS_GROUP = new RegExp(
  `^(?:all )?(?:the )?(${Object.keys(STATUS_WORDS).join('|')})(?: ones| agents| windows)?$`
);
const NEEDS_ME =
  /^(?:(?:the )?(?:ones|agents|windows) (?:that|which|who) (?:need|needs) (?:me|you|attention|my attention)|(?:the )?(?:ones|agents) waiting(?: for me)?|needs you|needs me)$/;

function tidy(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|my|our)\s+/, '');
}

function windows(context: CanvasRefContext): CanvasEntity[] {
  return context.entities.filter((entity) => entity.kind !== 'region' && !entity.hidden);
}

function regions(context: CanvasRefContext): CanvasEntity[] {
  return context.entities.filter((entity) => entity.kind === 'region');
}

function listQuestion(names: readonly string[]): string {
  if (names.length <= 2) return `Which one: ${names.join(' or ')}?`;
  return `Which one: ${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}?`;
}

function match(ids: readonly string[]): RefResult {
  return ids.length > 0 ? { kind: 'match', ids } : NONE;
}

/**
 * Picks the one entity a name means: exact spoken name, then a unique close spelling, then a
 * unique sound-alike. Ties are a question, not a guess.
 */
export function resolveNamed(spoken: string, candidates: readonly CanvasEntity[]): RefResult {
  const target = normalizeSpoken(spoken);
  if (!target || candidates.length === 0) return NONE;
  const exact = candidates.filter((entity) => normalizeSpoken(entity.name) === target);
  if (exact.length === 1 && exact[0]) return match([exact[0].id]);
  if (exact.length > 1)
    return { kind: 'clarify', question: listQuestion(exact.map((e) => e.name)) };

  const compactTarget = target.replace(/\s+/g, '');
  const scored = candidates
    .map((entity) => {
      const name = normalizeSpoken(entity.name).replace(/\s+/g, '');
      return { entity, distance: editDistance(name, compactTarget) };
    })
    .filter(({ distance }) => distance <= Math.max(1, Math.floor(compactTarget.length / 4)))
    .sort((a, b) => a.distance - b.distance);
  const best = scored[0];
  if (best) {
    const tied = scored.filter(({ distance }) => distance === best.distance);
    if (tied.length > 1) {
      return { kind: 'clarify', question: listQuestion(tied.map(({ entity }) => entity.name)) };
    }
    return match([best.entity.id]);
  }
  if (compactTarget.replace(/[^a-z]/g, '').length < 4) return NONE;
  const key = phoneticKey(target);
  const sounding = candidates.filter((entity) => {
    const name = normalizeSpoken(entity.name);
    if (phoneticKey(name) !== key) return false;
    const compactName = name.replace(/\s+/g, '');
    const longest = Math.max(compactName.length, compactTarget.length);
    return editDistance(compactName, compactTarget) <= Math.floor(longest / 2);
  });
  if (sounding.length === 1 && sounding[0]) return match([sounding[0].id]);
  if (sounding.length > 1) {
    return { kind: 'clarify', question: listQuestion(sounding.map((e) => e.name)) };
  }
  return NONE;
}

/** A region reference only: "Review", "the Review region", "region Review", "here". */
export function resolveRegionRef(reference: string, context: CanvasRefContext): RefResult {
  const text = tidy(reference);
  if (!text) return NONE;
  if (HERE_REGION.test(text)) return match(context.currentRegion ? [context.currentRegion] : []);
  if (SELECTION.test(text) || THIS.test(text) || IT.test(text)) {
    const pool = SELECTION.test(text)
      ? context.selection
      : IT.test(text) && context.recent.length === 1
        ? context.recent
        : context.selection;
    const picked = pool.filter((id) => id.startsWith('region:'));
    if (picked.length === 1) return match(picked);
    if (IT.test(text) || THIS.test(text)) {
      return match(context.currentRegion ? [context.currentRegion] : []);
    }
    return NONE;
  }
  const qualified = REGION_QUALIFIED_BEFORE.exec(text) ?? REGION_QUALIFIED_AFTER.exec(text);
  const name = qualified?.[1] ? tidy(qualified[1]) : text;
  return resolveNamed(name, regions(context));
}

function resolveSingle(text: string, context: CanvasRefContext, prefer: RefPreference): RefResult {
  if (SELECTION.test(text)) {
    return context.selection.length > 0
      ? match(context.selection)
      : { kind: 'clarify', question: 'Select some windows on the canvas first.' };
  }
  if (THEM.test(text)) {
    if (context.recent.length > 0) return match(context.recent);
    return match(context.selection);
  }
  if (IT.test(text)) {
    if (context.recent.length === 1) return match(context.recent);
    if (context.focusedId) return match([context.focusedId]);
    if (context.selection.length === 1) return match(context.selection);
    return NONE;
  }
  if (THIS.test(text)) {
    if (prefer === 'region' && context.currentRegion) return match([context.currentRegion]);
    if (context.focusedId) return match([context.focusedId]);
    if (context.selection.length === 1) return match(context.selection);
    return NONE;
  }
  if (HERE_REGION.test(text)) return resolveRegionRef(text, context);
  if (ALL.test(text)) return match(windows(context).map((entity) => entity.id));
  if (NEEDS_ME.test(text)) {
    return match(
      windows(context)
        .filter((entity) => entity.status === 'needs-you')
        .map((entity) => entity.id)
    );
  }
  const group = STATUS_GROUP.exec(text);
  if (group?.[1]) {
    const status = STATUS_WORDS[group[1]];
    return match(
      windows(context)
        .filter((entity) => entity.status === status)
        .map((entity) => entity.id)
    );
  }
  if (BROWSERS.test(text)) {
    return match(
      windows(context)
        .filter((entity) => entity.kind === 'browser')
        .map((entity) => entity.id)
    );
  }
  if (ONE_BROWSER.test(text)) return onlyOne(windows(context), 'browser', 'app browser');
  if (NOTES.test(text)) {
    return match(
      windows(context)
        .filter((entity) => entity.kind === 'note')
        .map((entity) => entity.id)
    );
  }
  if (ONE_NOTE.test(text)) return onlyOne(windows(context), 'note', 'note');

  const qualified = REGION_QUALIFIED_BEFORE.exec(text) ?? REGION_QUALIFIED_AFTER.exec(text);
  if (qualified?.[1]) {
    const region = resolveNamed(tidy(qualified[1]), regions(context));
    if (region.kind !== 'none') return region;
  }

  const browser = TASK_BROWSER.exec(text);
  if (browser?.[1]) {
    const found = browserFor(tidy(browser[1]), context);
    if (found.kind !== 'none') return found;
  }

  // Exact names across windows and regions; a region and a window sharing a name defer to the
  // preference, else ask.
  const spoken = normalizeSpoken(text);
  const exact = context.entities.filter(
    (entity) => !entity.hidden && normalizeSpoken(entity.name) === spoken
  );
  if (exact.length === 1 && exact[0]) return match([exact[0].id]);
  if (exact.length > 1) {
    const preferred = exact.filter((entity) =>
      prefer === 'region'
        ? entity.kind === 'region'
        : prefer === 'window'
          ? entity.kind !== 'region'
          : false
    );
    if (preferred.length === 1 && preferred[0]) return match([preferred[0].id]);
    return { kind: 'clarify', question: listQuestion(exact.map((entity) => describe(entity))) };
  }

  const agent = resolveAgentRef(text, context);
  if (agent.kind !== 'none') return agent;
  const region = resolveNamed(text, regions(context));
  if (region.kind !== 'none') return region;
  return resolveNamed(
    text,
    context.entities.filter((entity) => entity.kind === 'browser' || entity.kind === 'note')
  );
}

function describe(entity: CanvasEntity): string {
  return entity.kind === 'region' ? `the ${entity.name} region` : entity.name;
}

function onlyOne(pool: readonly CanvasEntity[], kind: CanvasEntityKind, noun: string): RefResult {
  const found = pool.filter((entity) => entity.kind === kind);
  if (found.length === 1 && found[0]) return match([found[0].id]);
  if (found.length > 1) {
    return { kind: 'clarify', question: listQuestion(found.map((entity) => entity.name)) };
  }
  return { kind: 'clarify', question: `There is no ${noun} on the canvas.` };
}

/** "Atlas's app", "the checkout browser": the app browser of an agent's task or a task name. */
function browserFor(reference: string, context: CanvasRefContext): RefResult {
  const browsers = windows(context).filter((entity) => entity.kind === 'browser');
  if (browsers.length === 0) return NONE;
  const agent = resolveAgentRef(reference, context);
  if (agent.kind === 'match') {
    const task = context.entities.find((entity) => entity.id === agent.ids[0])?.taskName;
    const found = browsers.filter((entity) => entity.taskName === task);
    if (found.length === 1 && found[0]) return match([found[0].id]);
  }
  const spoken = normalizeSpoken(reference);
  const byTask = browsers.filter(
    (entity) => entity.taskName && normalizeSpoken(entity.taskName).includes(spoken)
  );
  if (byTask.length === 1 && byTask[0]) return match([byTask[0].id]);
  return NONE;
}

function resolveAgentRef(reference: string, context: CanvasRefContext): RefResult {
  const roster: RosterAgent[] = context.entities
    .filter((entity) => entity.kind === 'agent')
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      providerLabel: entity.providerLabel ?? '',
      taskName: entity.taskName ?? '',
      ...(entity.hidden ? { hidden: true } : {}),
    }));
  const resolution = resolveAgent(reference, roster, context.focusedId);
  if (resolution.kind === 'match') return match([resolution.agent.id]);
  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'clarify',
      question: listQuestion(resolution.candidates.map((agent) => agent.name)),
    };
  }
  return NONE;
}

const LIST_SPLIT = /\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+plus\s+/;

/**
 * Resolves a reference to one or more windows or regions. A list resolves only when every part
 * does ("Atlas and Bravo"); a whole phrase that names something ("search and replace") wins over
 * splitting it.
 */
export function resolveCanvasRef(
  reference: string,
  context: CanvasRefContext,
  prefer: RefPreference = 'any'
): RefResult {
  const text = tidy(reference);
  if (!text) return NONE;
  const whole = resolveSingle(text, context, prefer);
  if (whole.kind === 'match' || !LIST_SPLIT.test(text)) return whole;
  const parts = text.split(LIST_SPLIT).map(tidy).filter(Boolean);
  if (parts.length < 2) return whole;
  const ids: string[] = [];
  for (const part of parts) {
    const result = resolveSingle(part, context, prefer);
    if (result.kind !== 'match') return result.kind === 'clarify' ? result : whole;
    for (const id of result.ids) if (!ids.includes(id)) ids.push(id);
  }
  return match(ids);
}
