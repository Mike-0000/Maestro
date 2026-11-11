import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import * as styles from './fact-grid.css';

type FactGridSize = 'ui' | 'reading';

const FactGridSizeContext = React.createContext<FactGridSize>('ui');

export interface FactGridProps extends React.HTMLAttributes<HTMLDListElement> {
  /** Width of the label column. Default `6rem`. */
  labelWidth?: string;
  /** `ui` (default): 13px values. `reading`: 14px values, for threads and reports. */
  size?: FactGridSize;
  /**
   * Width under which each label / value pair stacks: `default` 34rem, `narrow`
   * 24rem (dialogs and other narrow containers with short values), `never`.
   */
  stackBelow?: 'default' | 'narrow' | 'never';
  children: React.ReactNode;
}

export interface FactGridRowProps {
  label: React.ReactNode;
  children: React.ReactNode;
  /** The value that matters most ("Your move"): semibold, full strength. */
  emphasis?: boolean;
  className?: string;
}

/**
 * FactGrid — a label / value list (`dl`) for details: machine, workspace,
 * automation, PR and agent facts, or a report's "You asked / Where it is /
 * Your move". Labels are 12px muted in a fixed column; values sit beside them
 * on the first baseline and wrap. Below 34rem of width each pair stacks (see `stackBelow`).
 *
 *   <FactGrid>
 *     <FactGrid.Row label="Branch">fix/hang-up, pushed</FactGrid.Row>
 *     <FactGrid.Row label="Your move" emphasis>Try it in Katana Dev</FactGrid.Row>
 *   </FactGrid>
 */
function FactGridRoot({
  labelWidth,
  size = 'ui',
  stackBelow = 'default',
  className,
  style,
  children,
  ...props
}: FactGridProps) {
  return (
    <div className={styles.container}>
      <dl
        data-slot="fact-grid"
        data-stack={stackBelow}
        className={cx(styles.grid, className)}
        style={
          labelWidth
            ? ({ '--fact-grid-label-width': labelWidth, ...style } as React.CSSProperties)
            : style
        }
        {...props}
      >
        <FactGridSizeContext.Provider value={size}>{children}</FactGridSizeContext.Provider>
      </dl>
    </div>
  );
}

function FactGridRow({ label, children, emphasis = false, className }: FactGridRowProps) {
  const size = React.useContext(FactGridSizeContext);
  return (
    <>
      <dt className={cx(styles.label, className)}>{label}</dt>
      <dd
        className={cx(
          styles.value,
          size === 'reading' && styles.valueReading,
          emphasis && styles.valueEmphasis
        )}
      >
        {children}
      </dd>
    </>
  );
}

export const FactGrid = Object.assign(FactGridRoot, { Row: FactGridRow });
