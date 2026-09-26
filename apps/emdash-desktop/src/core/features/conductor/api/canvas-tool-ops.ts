/**
 * Turns the model's `arrange_canvas` steps (spoken names, as the user said them) into planner
 * layout ops. Pure: names resolve against the same canvas snapshot the grammar uses, and anything
 * that does not resolve comes back as an error the model can fix or ask about.
 */

import type { LayoutOp, SizeSpec, Slot } from '@core/features/canvas/api/canvas-layout';
import { resolveCanvasRef, type CanvasRefContext, type RefPreference } from './canvas-refs';

export const ARRANGE_OPS = [
  'group',
  'move_into',
  'place',
  'resize',
  'arrange',
  'organize',
  'swap',
  'rename_region',
  'recolor_region',
  'dissolve_region',
  'collapse_region',
  'expand_region',
  'fit_region',
] as const;

export const ARRANGE_SIZES = [
  'bigger',
  'smaller',
  'wider',
  'narrower',
  'taller',
  'shorter',
  'small',
  'medium',
  'large',
  'default',
  'half_screen',
  'third_screen',
  'quarter_screen',
  'full_screen',
] as const;

export const ARRANGE_SLOTS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;

export type ArrangeStep = {
  readonly op: (typeof ARRANGE_OPS)[number];
  readonly windows?: readonly string[];
  readonly region?: string;
  readonly name?: string;
  readonly color?: 'blue' | 'violet' | 'green' | 'amber' | 'rose' | 'teal' | 'gray';
  readonly anchor?: string;
  readonly side?: 'left' | 'right' | 'above' | 'below';
  readonly slot?: (typeof ARRANGE_SLOTS)[number];
  readonly size?: (typeof ARRANGE_SIZES)[number];
  readonly like?: string;
  readonly layout?: 'grid' | 'row' | 'column' | 'tidy' | 'tile';
  readonly by?: 'task' | 'project' | 'status' | 'provider';
};

type Ids = { ids: string[] } | { error: string };

const ROOT = /^(?:board|the board|canvas|the canvas|main board|root|none)$/i;

function resolve(reference: string, context: CanvasRefContext, prefer: RefPreference): Ids {
  const result = resolveCanvasRef(reference, context, prefer);
  if (result.kind === 'match') return { ids: [...result.ids] };
  if (result.kind === 'clarify') return { error: result.question };
  return { error: `Nothing on the canvas called "${reference}".` };
}

function resolveAll(
  references: readonly string[] | undefined,
  context: CanvasRefContext,
  prefer: RefPreference = 'any'
): Ids {
  if (!references || references.length === 0) return { error: 'Say which windows.' };
  const ids: string[] = [];
  for (const reference of references) {
    const result = resolve(reference, context, prefer);
    if ('error' in result) return result;
    for (const id of result.ids) if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

function resolveOne(reference: string | undefined, context: CanvasRefContext, what: string) {
  if (!reference) return { error: `Say which ${what}.` };
  const result = resolve(reference, context, what === 'region' ? 'region' : 'window');
  if ('error' in result) return result;
  const [id] = result.ids;
  if (result.ids.length !== 1 || !id) return { error: `"${reference}" is more than one ${what}.` };
  if (what === 'region' && !id.startsWith('region:')) {
    return { error: `"${reference}" is a window, not a region.` };
  }
  return { id };
}

function sizeSpec(size: ArrangeStep['size'], like: string | undefined): SizeSpec | string | null {
  const relative = (axis: 'both' | 'width' | 'height', direction: 'grow' | 'shrink'): SizeSpec => ({
    kind: 'relative',
    axis,
    factor: 'more',
    direction,
  });
  switch (size) {
    case 'bigger':
      return relative('both', 'grow');
    case 'smaller':
      return relative('both', 'shrink');
    case 'wider':
      return relative('width', 'grow');
    case 'narrower':
      return relative('width', 'shrink');
    case 'taller':
      return relative('height', 'grow');
    case 'shorter':
      return relative('height', 'shrink');
    case 'small':
    case 'medium':
    case 'large':
    case 'default':
      return { kind: 'preset', preset: size };
    case 'half_screen':
      return { kind: 'screen', fraction: 'half', axis: 'width' };
    case 'third_screen':
      return { kind: 'screen', fraction: 'third', axis: 'width' };
    case 'quarter_screen':
      return { kind: 'screen', fraction: 'quarter', axis: 'both' };
    case 'full_screen':
      return { kind: 'screen', fraction: 'full', axis: 'both' };
    case undefined:
      return like ?? null;
  }
}

const windowsOf = (ids: readonly string[]) => ids.filter((id) => !id.startsWith('region:'));

/** One step to one op, or why it cannot be done. */
export function stepToOp(
  step: ArrangeStep,
  context: CanvasRefContext
): LayoutOp | { error: string } {
  switch (step.op) {
    case 'group': {
      const members = step.windows?.length ? resolveAll(step.windows, context) : { ids: [] };
      if ('error' in members) return members;
      return {
        op: 'createRegion',
        members: members.ids,
        ...(step.name ? { name: step.name } : {}),
        ...(step.color ? { color: step.color } : {}),
      };
    }
    case 'move_into': {
      const targets = resolveAll(step.windows, context);
      if ('error' in targets) return targets;
      if (!step.region || ROOT.test(step.region.trim())) {
        return { op: 'move', targets: targets.ids, to: { kind: 'region', region: null } };
      }
      const region = resolveOne(step.region, context, 'region');
      if ('error' in region) return region;
      return { op: 'move', targets: targets.ids, to: { kind: 'region', region: region.id } };
    }
    case 'place': {
      const targets = resolveAll(step.windows, context);
      if ('error' in targets) return targets;
      if (step.anchor) {
        const anchor = resolveOne(step.anchor, context, 'window');
        if ('error' in anchor) return anchor;
        return {
          op: 'move',
          targets: targets.ids,
          to: { kind: 'relative', anchor: anchor.id, side: step.side ?? 'right' },
        };
      }
      const slot: Slot | undefined = step.slot;
      if (!slot) return { error: 'place needs an anchor or a slot.' };
      return { op: 'move', targets: targets.ids, to: { kind: 'slot', slot } };
    }
    case 'resize': {
      const targets = resolveAll(step.windows, context, 'window');
      if ('error' in targets) return targets;
      const spec = sizeSpec(step.size, step.like);
      if (spec === null) return { error: 'resize needs a size or like.' };
      if (typeof spec === 'string') {
        const like = resolveOne(spec, context, 'window');
        if ('error' in like) return like;
        return {
          op: 'resize',
          targets: windowsOf(targets.ids),
          size: { kind: 'match', like: like.id },
        };
      }
      return { op: 'resize', targets: windowsOf(targets.ids), size: spec };
    }
    case 'arrange': {
      const layout = step.layout ?? 'tidy';
      let scope: string | null = null;
      if (step.region && !ROOT.test(step.region.trim())) {
        const region = resolveOne(step.region, context, 'region');
        if ('error' in region) return region;
        scope = region.id;
      }
      if (!step.windows?.length) return { op: 'arrange', targets: null, scope, layout };
      const targets = resolveAll(step.windows, context);
      if ('error' in targets) return targets;
      return { op: 'arrange', targets: targets.ids, scope, layout };
    }
    case 'organize': {
      let scope: string | null = null;
      if (step.region && !ROOT.test(step.region.trim())) {
        const region = resolveOne(step.region, context, 'region');
        if ('error' in region) return region;
        scope = region.id;
      }
      return { op: 'organize', scope, by: step.by ?? 'task' };
    }
    case 'swap': {
      const [first, second] = step.windows ?? [];
      const a = resolveOne(first, context, 'window');
      if ('error' in a) return a;
      const b = resolveOne(second, context, 'window');
      if ('error' in b) return b;
      return { op: 'swap', a: a.id, b: b.id };
    }
    case 'rename_region':
    case 'recolor_region':
    case 'dissolve_region':
    case 'collapse_region':
    case 'expand_region':
    case 'fit_region': {
      const region = resolveOne(step.region, context, 'region');
      if ('error' in region) return region;
      switch (step.op) {
        case 'rename_region':
          return step.name
            ? { op: 'renameRegion', region: region.id, name: step.name }
            : { error: 'rename_region needs a name.' };
        case 'recolor_region':
          return { op: 'recolorRegion', region: region.id, color: step.color ?? null };
        case 'dissolve_region':
          return { op: 'dissolveRegion', region: region.id };
        case 'collapse_region':
          return { op: 'collapseRegion', region: region.id, collapsed: true };
        case 'expand_region':
          return { op: 'collapseRegion', region: region.id, collapsed: false };
        case 'fit_region':
          return { op: 'fitRegion', region: region.id };
      }
    }
  }
}

/** All steps to ops; the first unresolvable step stops the batch (nothing applies). */
export function stepsToOps(
  steps: readonly ArrangeStep[],
  context: CanvasRefContext
): { ops: LayoutOp[] } | { error: string } {
  const ops: LayoutOp[] = [];
  for (const [index, step] of steps.entries()) {
    const op = stepToOp(step, context);
    if ('error' in op) return { error: `Step ${index + 1} (${step.op}): ${op.error}` };
    ops.push(op);
  }
  return { ops };
}
