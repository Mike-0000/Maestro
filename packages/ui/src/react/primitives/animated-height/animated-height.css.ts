import { style } from '@vanilla-extract/css';
import { HEIGHT_TRANSITION_DURATION_MS } from './constants';

/**
 * Grid-rows height animation: the single row is pinned to the measured
 * content height in pixels (inline style set by the component) and the
 * transition interpolates between pixel values. Before the first measurement
 * the row is `1fr`, which sizes to the content; the fr→px switch is not
 * interpolable, so the initial measurement never animates.
 */
export const root = style({
  display: 'grid',
  gridTemplateRows: '1fr',
  // The one column is the box's width, never the content's widest line: an
  // `auto` column grows to its item's min-content width, so one long
  // unbreakable value (a path, a URL) pushed a dialog body past its edge.
  // `minmax(0, 1fr)` pins the track and lets fields truncate inside it.
  gridTemplateColumns: 'minmax(0, 1fr)',
  // Content must keep its natural height (not stretch to the row) so the
  // ResizeObserver keeps measuring the real content size while the row is
  // pinned to the previous height during a transition.
  alignItems: 'start',
  width: '100%',
  overflow: 'visible',
  transition: `grid-template-rows ${HEIGHT_TRANSITION_DURATION_MS}ms ease-in-out`,
  selectors: {
    // Clip only while animating so popovers/menus rendered inside can escape
    // the box once the transition settles.
    '&[data-animating]': { overflow: 'hidden' },
  },
});
