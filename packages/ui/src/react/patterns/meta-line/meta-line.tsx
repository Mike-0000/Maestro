import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import * as styles from './meta-line.css';

export interface MetaLineProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** A leading mark, typically a `StateGlyph` at size `sm`. */
  glyph?: React.ReactNode;
  /** Leading facts, joined with " · " ("Finished", "6m ago"). */
  start?: React.ReactNode | readonly React.ReactNode[];
  /** Trailing facts, right-aligned and joined with " · " ("Claude", "work account"). */
  end?: React.ReactNode | readonly React.ReactNode[];
  /** Extra trailing content after the facts (for example a diff stat). */
  trailing?: React.ReactNode;
  /** Read the leading facts a step stronger (muted instead of passive). */
  strong?: boolean;
  /** Keep the trailing facts visible in a narrow container (hidden below 34rem by default). */
  keepEndWhenNarrow?: boolean;
}

function join(facts: React.ReactNode | readonly React.ReactNode[]): React.ReactNode {
  const list = (Array.isArray(facts) ? facts : [facts]).filter(
    (fact) => fact != null && fact !== false && fact !== ''
  );
  return list.map((fact, index) => (
    <React.Fragment key={index}>
      {index > 0 && ' · '}
      {fact}
    </React.Fragment>
  ));
}

function hasFacts(facts: React.ReactNode | readonly React.ReactNode[] | undefined): boolean {
  if (facts == null || facts === false || facts === '') return false;
  return Array.isArray(facts) ? facts.some((f) => f != null && f !== false && f !== '') : true;
}

/**
 * MetaLine — the caption-role row (the conductor vitals footer shape): 11px
 * passive text with tabular figures; leading facts left, joined with " · ",
 * trailing facts right-aligned. For ages, counts, provenance and footers.
 *
 *   <MetaLine
 *     glyph={<StateGlyph state="done" size="sm" />}
 *     start={['Finished', '6m ago']}
 *     end={['Claude', 'work account', 'medium effort']}
 *   />
 */
export function MetaLine({
  glyph,
  start,
  end,
  trailing,
  strong = false,
  keepEndWhenNarrow = false,
  className,
  ...props
}: MetaLineProps) {
  const showEnd = hasFacts(end) || trailing != null;
  return (
    <div className={styles.container}>
      <div data-slot="meta-line" className={cx(styles.root, className)} {...props}>
        {(glyph != null || hasFacts(start)) && (
          <span className={styles.start}>
            {glyph}
            {hasFacts(start) && (
              <span className={cx(styles.facts, strong && styles.strong)}>{join(start)}</span>
            )}
          </span>
        )}
        {showEnd && (
          <span className={cx(styles.end, keepEndWhenNarrow && styles.endKeep)}>
            {hasFacts(end) && <span className={styles.facts}>{join(end)}</span>}
            {trailing}
          </span>
        )}
      </div>
    </div>
  );
}
