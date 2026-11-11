import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import { Tooltip } from '../../primitives/tooltip';
import { BrailleSpinner } from '../agent-status/braille-spinner';
import * as styles from './state-glyph.css';

export type StateGlyphState =
  | 'needs-you'
  | 'working'
  | 'unread'
  | 'done'
  | 'idle'
  | 'error'
  | 'setting-up';

/** The words that go with each mark (design brief 2.6). */
export const STATE_GLYPH_LABELS: Record<StateGlyphState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  unread: 'Finished, not looked at yet',
  done: 'Finished',
  idle: 'Idle',
  error: 'Stopped on an error',
  'setting-up': 'Setting up',
};

export interface StateGlyphProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: StateGlyphState;
  /**
   * Words for the mark. When given, the glyph is announced (`role="img"`) and
   * shows them in a tooltip; pass `true` for the default words of the state.
   * Omit it when the state is already written next to the glyph, so the mark
   * stays decorative.
   */
  label?: string | boolean;
  /** `md` (default) is a 16px slot; `sm` a 12px slot for dense meta lines. */
  size?: 'sm' | 'md';
}

/**
 * StateGlyph — the single state mark used everywhere state shows (sidebar,
 * conductor, project task list, PR / automation / machine rows, remote-web):
 *
 *   needs-you   filled near-white dot          "Needs you"
 *   working     softly pulsing accent dot      "Working"
 *   unread      bright ring                    "Finished, not looked at yet"
 *   done        passive ring                   "Finished"
 *   idle        dimmer passive ring            "Idle"
 *   error       filled error dot               "Stopped on an error"
 *   setting-up  braille wave, passive          "Setting up"
 *
 *   <StateGlyph state="working" label />           // announced, tooltip "Working"
 *   <StateGlyph state="error" label="Build failed" />
 *   <StateGlyph state="done" /> Finished · 6m ago  // decorative next to words
 */
export const StateGlyph = React.forwardRef<HTMLSpanElement, StateGlyphProps>(function StateGlyph(
  { state, label, size = 'md', className, ...props },
  ref
) {
  const words = label === true ? STATE_GLYPH_LABELS[state] : label || undefined;
  const glyph = (
    <span
      ref={ref}
      data-slot="state-glyph"
      data-state={state}
      role={words ? 'img' : undefined}
      aria-label={words}
      aria-hidden={words ? undefined : true}
      className={cx(styles.slot, styles.slotSize[size], className)}
      {...props}
    >
      {state === 'setting-up' ? (
        <BrailleSpinner variant="wave" className={styles.mark['setting-up']} />
      ) : (
        <span aria-hidden className={styles.mark[state]} />
      )}
    </span>
  );

  if (!words) return glyph;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={glyph} />
      <Tooltip.Content>{words}</Tooltip.Content>
    </Tooltip.Root>
  );
});
