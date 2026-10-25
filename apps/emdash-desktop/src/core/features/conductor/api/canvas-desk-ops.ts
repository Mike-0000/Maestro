/**
 * Turns the model's `canvas_desks` call (spoken names, as the user said them) into what the
 * conductor runs: planner layout ops for a change to the board, or a small command for what is not
 * a layout change (switching desks, visitors, the canvas mode). Pure: names resolve against the
 * same canvas snapshot the grammar uses, and anything that does not resolve comes back as an error
 * the model can fix or ask about.
 *
 * A desk (Canvas Pro) is a top-level region shown alone, so a desk reference is a region reference
 * restricted to top-level regions, plus the words only desks have: "next", "previous", "last" (the
 * one the user was on before), "new", and a place in the order ("2", "the second").
 */

import type { CanvasMode } from '@core/features/canvas/api/canvas-desks';
import type { LayoutOp } from '@core/features/canvas/api/canvas-layout';
import type { WindowStatus } from '@core/features/canvas/api/canvas-regions';
import {
  resolveCanvasRef,
  resolveRegionRef,
  type CanvasEntity,
  type CanvasRefContext,
} from './canvas-refs';
import { normalizeSpoken } from './resolver';

export const DESK_ACTIONS = [
  'create',
  'switch',
  'rename',
  'move_windows',
  'remove',
  'reorder',
  'bring',
  'send_back',
  'keep',
  'set_mode',
] as const;

export const DESK_GATHERS = [
  'needs-you',
  'error',
  'working',
  'done',
  'idle',
] as const satisfies readonly WindowStatus[];

export const DESK_POSITIONS = ['first', 'last', 'left', 'right'] as const;

export type DeskStep = {
  readonly action: (typeof DESK_ACTIONS)[number];
  readonly desk?: string;
  readonly name?: string;
  readonly windows?: readonly string[];
  readonly follow?: boolean;
  readonly gather?: WindowStatus;
  readonly position?: (typeof DESK_POSITIONS)[number];
  readonly into?: string;
  readonly mode?: CanvasMode;
};

/**
 * One desk request with every name resolved to an id. Those that change the board carry the
 * planner ops to run; the rest are carried out by the canvas store directly.
 */
export type DeskCommand =
  | {
      readonly action: 'create';
      readonly ops: readonly LayoutOp[];
      readonly members: readonly string[];
      readonly gather: WindowStatus | null;
      /** Switch to the new desk once it exists. */
      readonly follow: boolean;
    }
  | { readonly action: 'switch'; readonly desk: string }
  | { readonly action: 'rename'; readonly ops: readonly LayoutOp[]; readonly desk: string }
  | {
      readonly action: 'move_windows';
      /** Empty when every window is there already. */
      readonly ops: readonly LayoutOp[];
      readonly desk: string;
      readonly windows: readonly string[];
      /** Windows named that are on that desk already. */
      readonly already: readonly string[];
      readonly follow: boolean;
    }
  /** The store works out the heir: the desk before it, unless `into` names one. */
  | { readonly action: 'remove'; readonly desk: string; readonly into: string | null }
  | { readonly action: 'reorder'; readonly ops: readonly LayoutOp[]; readonly desk: string }
  | { readonly action: 'bring'; readonly windows: readonly string[] }
  /** `null`: every visitor. */
  | { readonly action: 'send_back'; readonly windows: readonly string[] | null }
  | { readonly action: 'keep'; readonly windows: readonly string[] | null }
  | { readonly action: 'set_mode'; readonly mode: CanvasMode };

/** What a desk tool call gets back on the classic canvas. */
export const DESKS_NEED_PRO =
  'Desks are part of Canvas Pro, and the canvas is in classic mode. The developer can say "switch to Canvas Pro".';

/** What a gathering desk is called when no name is given. */
export const GATHER_DESK_NAMES: Record<WindowStatus, string> = {
  'needs-you': 'Triage',
  error: 'Failed',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

/** "Every window that <phrase>": what a gathering desk collects, as a clause. */
export const GATHER_PHRASES: Record<WindowStatus, string> = {
  'needs-you': 'needs you',
  error: 'failed',
  working: 'is working',
  done: 'is done',
  idle: 'is idle',
};

// ── Desk references ──────────────────────────────────────────────────────────

export type DeskRef =
  | { readonly kind: 'match'; readonly id: string }
  /** Two desks fit, or the word has nothing behind it yet ("the other desk" on the first one). */
  | { readonly kind: 'clarify'; readonly question: string }
  | { readonly kind: 'none' };

const NO_DESK: DeskRef = { kind: 'none' };

/** Words for a desk; "desktop" and "space" are what people also call one. */
export const DESK_WORD = '(?:desk|desktop|space)';
const LEADING_DESK = new RegExp(`^${DESK_WORD}\\s+(?:number\\s+|called\\s+|named\\s+)?`);
const TRAILING_DESK = new RegExp(`\\s+${DESK_WORD}$`);
const ONLY_DESK = new RegExp(`^${DESK_WORD}$`);
const MENTIONS_DESK = new RegExp(`^(?:(?:the|my|our|this|that) )?${DESK_WORD}\\b|\\b${DESK_WORD}$`);

const HERE = /^(?:this|this one|here|current|current one|one in view|one i'?m on)$/;
const NEXT = /^(?:next|next one)$/;
const PREVIOUS = /^(?:previous|prev|previous one)$/;
const LAST =
  /^(?:last|last one|other|other one|one before|one i was (?:on|in|at)(?: before)?|where i was)$/;
const NEWEST =
  /^(?:new|new one|newest|newest one|latest|latest one|one (?:i|we|you) just (?:made|created))$/;
const ORDINAL = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)(?: one)?$/;
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
};
const CARDINALS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

function tidy(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|my|our)\s+/, '');
}

/** True when a phrase names a desk in so many words: "the Review desk", "desk 2", "this space". */
export function mentionsDesk(reference: string): boolean {
  return MENTIONS_DESK.test(tidy(reference));
}

/** The desk a window or region is on (a desk is on itself); null on the classic canvas. */
export function deskOfEntity(
  context: CanvasRefContext,
  id: string | null | undefined
): string | null {
  const desks = context.desks;
  if (!desks || !id) return null;
  const byId = new Map(context.entities.map((entity) => [entity.id, entity]));
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    if (desks.order.includes(current)) return current;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return null;
}

/** The desk the user was on before the one in view, if they have been on another. */
export function previousDesk(context: CanvasRefContext): string | null {
  const desks = context.desks;
  const before = desks?.previous && desks.order.includes(desks.previous) ? desks.previous : null;
  const previous = before ?? deskOfEntity(context, context.previousRegion);
  return previous && previous !== desks?.active ? previous : null;
}

function deskEntities(context: CanvasRefContext): CanvasEntity[] {
  const order = context.desks?.order ?? [];
  const byId = new Map(context.entities.map((entity) => [entity.id, entity]));
  return order.flatMap((id) => byId.get(id) ?? []);
}

function exactName(spoken: string, desks: readonly CanvasEntity[]): string | null {
  const target = normalizeSpoken(spoken);
  if (!target) return null;
  const found = desks.filter((desk) => normalizeSpoken(desk.name) === target);
  return found.length === 1 && found[0] ? found[0].id : null;
}

/** A place in the desk order: "2", "second", and "two" after the word desk ("desk two"). */
function placeOf(text: string, afterDeskWord: boolean): number | null {
  if (/^\d{1,2}$/.test(text)) return Number(text);
  const ordinal = ORDINAL.exec(text)?.[1];
  if (ordinal) return ORDINALS[ordinal] ?? null;
  return afterDeskWord ? (CARDINALS[text] ?? null) : null;
}

function howMany(count: number): string {
  return count === 1 ? 'There is only one desk.' : `There are only ${count} desks.`;
}

/**
 * Resolves a spoken desk: its name ("Review", "the Review desk"), "next" or "previous" in the
 * order, "last" or "the other one" (where the user was before), "new", a number, or "this".
 * Never picks between two desks.
 */
export function resolveDesk(reference: string, context: CanvasRefContext): DeskRef {
  const desks = context.desks;
  if (!desks) return NO_DESK;
  const text = tidy(reference);
  const afterDeskWord = LEADING_DESK.test(text);
  const bare = ONLY_DESK.test(text)
    ? ''
    : text.replace(LEADING_DESK, '').replace(TRAILING_DESK, '').trim();
  const entities = deskEntities(context);
  // A desk's own name wins over a keyword: a desk may be called "New" or "Last".
  const named = exactName(text, entities) ?? exactName(bare, entities);
  if (named) return { kind: 'match', id: named };

  if (!bare || HERE.test(bare)) {
    return desks.active ? { kind: 'match', id: desks.active } : NO_DESK;
  }
  const count = desks.order.length;
  if (NEXT.test(bare) || PREVIOUS.test(bare)) {
    const index = desks.active ? desks.order.indexOf(desks.active) : -1;
    if (count < 2 || index === -1) return { kind: 'clarify', question: howMany(count) };
    const step = NEXT.test(bare) ? 1 : -1;
    const id = desks.order[(index + step + count) % count];
    return id ? { kind: 'match', id } : NO_DESK;
  }
  if (LAST.test(bare)) {
    const previous = previousDesk(context);
    return previous
      ? { kind: 'match', id: previous }
      : { kind: 'clarify', question: 'You have not been on another desk yet. Which one?' };
  }
  if (NEWEST.test(bare)) {
    const newest = desks.newest;
    return newest && desks.order.includes(newest)
      ? { kind: 'match', id: newest }
      : { kind: 'clarify', question: 'No desk has been made yet. Which one do you mean?' };
  }
  const place = placeOf(bare, afterDeskWord);
  if (place !== null) {
    const id = desks.order[place - 1];
    return id ? { kind: 'match', id } : { kind: 'clarify', question: howMany(count) };
  }

  // A name, by the rules regions follow, among the desks only.
  const among = (ids: readonly string[]) => ids.filter((id) => desks.order.includes(id));
  const scoped: CanvasRefContext = {
    ...context,
    entities,
    selection: among(context.selection),
    recent: among(context.recent),
    currentRegion: desks.active,
    newestRegion: desks.newest ?? null,
    previousRegion: previousDesk(context),
  };
  for (const candidate of bare === text ? [bare] : [bare, text]) {
    const result = resolveRegionRef(candidate, scoped);
    if (result.kind === 'clarify') return result;
    const [id] = result.kind === 'match' ? result.ids : [];
    if (id) return { kind: 'match', id };
  }
  return NO_DESK;
}

/**
 * A phrase that says desk ("the Review desk", "this desk", "desk 2") names a desk wherever a
 * region can be named. Null on the classic canvas and when the phrase is not one, so the usual
 * resolver has a go.
 */
export function deskPhrase(
  reference: string,
  context: CanvasRefContext
): Exclude<DeskRef, { kind: 'none' }> | null {
  if (!context.desks || !mentionsDesk(reference)) return null;
  const result = resolveDesk(reference, context);
  return result.kind === 'none' ? null : result;
}

/**
 * Where a new agent was asked to go (spawn_agent's `desk`): a desk, or else a region, the canvas
 * has by that name; else a new one called that, made when the agent arrives. "This desk" is the
 * desk in view, so asking for it is how the developer keeps an agent where they are.
 */
export function spawnDestination(
  reference: string,
  context: CanvasRefContext
): { readonly regionId: string } | { readonly name: string } | { readonly error: string } {
  const desk = context.desks ? resolveDesk(reference, context) : NO_DESK;
  if (desk.kind === 'match') return { regionId: desk.id };
  if (desk.kind === 'clarify') return { error: desk.question };
  const region = resolveRegionRef(reference, context);
  if (region.kind === 'clarify') return { error: region.question };
  const [id] = region.kind === 'match' ? region.ids : [];
  if (id) return { regionId: id };
  const name = reference
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:the|my|our|a new|an|a|new)\s+/i, '')
    .replace(new RegExp(`\\s+(?:${DESK_WORD}|region|sub-canvas)$`, 'i'), '')
    .trim();
  const spoken = tidy(name);
  // A bare "desk", or "here" with nowhere in view, names nothing: it must not become a desk.
  if (!spoken || ONLY_DESK.test(spoken) || HERE.test(spoken)) {
    return { error: 'Say which desk to put the agent on.' };
  }
  return { name };
}

// ── Commands ─────────────────────────────────────────────────────────────────

type Ids = { ids: string[] } | { error: string };

function deskNames(context: CanvasRefContext): string {
  return (
    deskEntities(context)
      .map((desk) => desk.name)
      .join(', ') || 'none'
  );
}

/** The desk a step names, or the desk in view when it names none and that makes sense. */
function deskId(
  reference: string | undefined,
  context: CanvasRefContext,
  whenUnnamed: 'in-view' | 'ask'
): { id: string } | { error: string } {
  if (!reference?.trim()) {
    const active = context.desks?.active;
    return whenUnnamed === 'in-view' && active ? { id: active } : { error: 'Say which desk.' };
  }
  const result = resolveDesk(reference, context);
  if (result.kind === 'match') return { id: result.id };
  if (result.kind === 'clarify') return { error: result.question };
  return { error: `No desk called "${reference}". Desks: ${deskNames(context)}.` };
}

/**
 * Windows by spoken name. A desk is never one of them (moving a desk into another would merge the
 * two); a region inside a desk is, when `regions` allows it.
 */
function windowIds(
  references: readonly string[] | undefined,
  context: CanvasRefContext,
  regions: 'with-regions' | 'windows-only'
): Ids {
  if (!references || references.length === 0) return { error: 'Say which windows.' };
  const ids: string[] = [];
  for (const reference of references) {
    const result = resolveCanvasRef(reference, context, 'window');
    if (result.kind === 'clarify') return { error: result.question };
    if (result.kind === 'none') return { error: `Nothing on the canvas called "${reference}".` };
    for (const id of result.ids) {
      if (context.desks?.order.includes(id)) {
        return { error: `"${reference}" is a desk, not a window. Name the windows on it.` };
      }
      if (id.startsWith('region:') && regions === 'windows-only') {
        return { error: `"${reference}" is a region, not a window. Name the windows in it.` };
      }
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return { ids };
}

/** A new desk, optionally holding windows or gathering every window with a status. */
export function createDesk(input: {
  readonly name?: string;
  readonly members?: readonly string[];
  readonly gather?: WindowStatus;
  readonly follow?: boolean;
}): DeskCommand {
  const members = [...(input.members ?? [])];
  const name = input.name?.trim() || (input.gather ? GATHER_DESK_NAMES[input.gather] : '');
  return {
    action: 'create',
    ops: [
      {
        op: 'createRegion',
        parent: null,
        members,
        ...(name ? { name } : {}),
        ...(input.gather ? { gather: input.gather } : {}),
      },
    ],
    members,
    gather: input.gather ?? null,
    follow: input.follow !== false,
  };
}

/** Windows moved to a desk (or a region on one) for good; those there already are left alone. */
export function moveToDesk(
  windows: readonly string[],
  desk: string,
  follow: boolean,
  context: CanvasRefContext
): DeskCommand {
  const byId = new Map(context.entities.map((entity) => [entity.id, entity]));
  const isDesk = context.desks?.order.includes(desk) ?? false;
  // On a desk means anywhere on it: a window in one of its regions is not pulled out.
  const there = (id: string) =>
    isDesk ? deskOfEntity(context, id) === desk : (byId.get(id)?.parentId ?? null) === desk;
  const moving = windows.filter((id) => !there(id));
  return {
    action: 'move_windows',
    ops:
      moving.length > 0
        ? [{ op: 'move', targets: moving, to: { kind: 'region', region: desk } }]
        : [],
    desk,
    windows: moving,
    already: windows.filter(there),
    follow,
  };
}

export function renameDesk(desk: string, name: string): DeskCommand {
  return { action: 'rename', ops: [{ op: 'renameRegion', region: desk, name }], desk };
}

export function reorderDesk(desk: string, position: (typeof DESK_POSITIONS)[number]): DeskCommand {
  return { action: 'reorder', ops: [{ op: 'reorderDesk', region: desk, position }], desk };
}

/** One `canvas_desks` call to the command the conductor runs, or why it cannot be done. */
export function deskCommand(
  step: DeskStep,
  context: CanvasRefContext
): DeskCommand | { error: string } {
  if (step.action === 'set_mode') {
    return step.mode
      ? { action: 'set_mode', mode: step.mode }
      : { error: 'set_mode needs a mode: classic or pro.' };
  }
  if (!context.desks) return { error: DESKS_NEED_PRO };
  switch (step.action) {
    case 'create': {
      const members = step.windows?.length
        ? windowIds(step.windows, context, 'with-regions')
        : { ids: [] };
      if ('error' in members) return members;
      return createDesk({
        members: members.ids,
        ...(step.name ? { name: step.name } : {}),
        ...(step.gather ? { gather: step.gather } : {}),
        ...(step.follow === false ? { follow: false } : {}),
      });
    }
    case 'switch': {
      const desk = deskId(step.desk, context, 'ask');
      if ('error' in desk) return desk;
      return { action: 'switch', desk: desk.id };
    }
    case 'rename': {
      const name = step.name?.trim();
      if (!name) return { error: 'rename needs a name.' };
      const desk = deskId(step.desk, context, 'in-view');
      if ('error' in desk) return desk;
      return renameDesk(desk.id, name);
    }
    case 'move_windows': {
      const windows = windowIds(step.windows, context, 'with-regions');
      if ('error' in windows) return windows;
      const desk = deskId(step.desk, context, 'in-view');
      if ('error' in desk) return desk;
      return moveToDesk(windows.ids, desk.id, step.follow === true, context);
    }
    case 'remove': {
      const desk = deskId(step.desk, context, 'in-view');
      if ('error' in desk) return desk;
      if (!step.into?.trim()) return { action: 'remove', desk: desk.id, into: null };
      const into = deskId(step.into, context, 'ask');
      if ('error' in into) return into;
      if (into.id === desk.id) return { error: 'A desk cannot take its own windows.' };
      return { action: 'remove', desk: desk.id, into: into.id };
    }
    case 'reorder': {
      if (!step.position) {
        return { error: 'reorder needs a position: first, last, left, or right.' };
      }
      const desk = deskId(step.desk, context, 'in-view');
      if ('error' in desk) return desk;
      return reorderDesk(desk.id, step.position);
    }
    case 'bring': {
      const windows = windowIds(step.windows, context, 'windows-only');
      if ('error' in windows) return windows;
      return { action: 'bring', windows: windows.ids };
    }
    case 'send_back':
    case 'keep': {
      if (!step.windows?.length) return { action: step.action, windows: null };
      const windows = windowIds(step.windows, context, 'windows-only');
      if ('error' in windows) return windows;
      return { action: step.action, windows: windows.ids };
    }
  }
}
