/**
 * CollapsibleCard — shared collapsible-card primitive.
 *
 * Renders a collapsible header and an arbitrary body slot, either as a quiet
 * card (`appearance="card"`, the plan) or with no box at all
 * (`appearance="bare"`, commands, whose output sits in its own well).
 *
 * Key behaviour:
 *   - Resolves `ctx.clipHeight?.() ?? height` as the root element's height so
 *     the bottom border and rounded corners remain visible throughout the
 *     collapse/expand tween (they track the animated edge, not the full height).
 *   - Wires `data-collapse-id`, `aria-expanded`, shimmer, and chevron in one
 *     place so card rows do not re-implement them.
 */

import type { RenderCtx } from '@core/define';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { JSX } from 'solid-js';
import { clipTrackedHeight } from './card-clip';
import { CardHeader } from './CardHeader';
import {
  collapsibleCard,
  collapsibleCardVars,
  type CollapsibleCardAppearance,
} from './collapsible-card.css';

export type CollapsibleCardProps = {
  /**
   * `card` (default): a quiet card for an artifact read as a whole (the plan).
   * `bare`: no box; the header is a quiet row and the body brings its own well.
   */
  appearance?: CollapsibleCardAppearance;
  /** Item id wired to data-collapse-id for ChatRoot click delegation. */
  id: string;
  /** RenderCtx from the parent def — read to obtain the animated clipHeight. */
  ctx: RenderCtx;
  /** Full measured card height (px) for the current display state. */
  height: number;
  /** Header row height in px (drives flex height). */
  headerH: number;
  /** Whether the card is currently expanded. */
  expanded: boolean;
  /** Whether body content is visible below the header. */
  bodyVisible?: boolean;
  /**
   * When true, applies the text-shimmer animation to the header label
   * (use while the item is running / streaming).
   */
  active?: boolean;
  /** When true, renders the error icon on the far right of the header. */
  error?: boolean;
  /** Native tooltip shown when hovering the error icon. */
  errorTitle?: string;
  /** When true, renders the awaiting-permission icon in the right-side status slot. */
  awaitingPermission?: boolean;
  /** Leading icon shown until the header row is hovered. */
  icon: JSX.Element;
  /** Header label content (left side of the header). */
  header: JSX.Element;
  /** Optional right-aligned content beside the error icon. */
  headerRight?: JSX.Element;
  /** Card body — rendered below the header inside the clipped shell. */
  children: JSX.Element;
};

export function CollapsibleCard(props: CollapsibleCardProps) {
  // Single source of truth for the bottom-border fix: during a tween, prefer
  // the animated content height so the bordered shell tracks the moving edge.
  const cardH = clipTrackedHeight(props.ctx, () => props.height);

  return (
    <div
      class={collapsibleCard[props.appearance ?? 'card']}
      style={assignInlineVars(collapsibleCardVars, pxTokens({ height: cardH() }))}
    >
      <CardHeader
        id={props.id}
        height={props.headerH}
        expanded={props.expanded}
        bodyVisible={props.bodyVisible !== false}
        icon={props.icon}
        title={props.header}
        active={props.active}
        error={props.error}
        errorTitle={props.errorTitle}
        awaitingPermission={props.awaitingPermission}
        right={props.headerRight}
      />
      {props.children}
    </div>
  );
}
