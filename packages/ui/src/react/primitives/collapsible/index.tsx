'use client';

import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { cx } from '@styles/utilities/cx';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import * as styles from './collapsible.css';

// ── Root ──────────────────────────────────────────────────────────────────────

function CollapsibleRoot({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

// ── Trigger ───────────────────────────────────────────────────────────────────

export interface CollapsibleTriggerProps extends CollapsiblePrimitive.Trigger.Props {
  /** Hide the chevron icon. @default false */
  hideChevron?: boolean;
  /**
   * - `row` (default): a full-width ghost row with a trailing chevron that
   *   flips when open.
   * - `text`: a quiet text disclosure — caption-size muted text with a small
   *   leading chevron that turns down when open; no fill, border or button chrome.
   */
  variant?: 'row' | 'text';
}

function CollapsibleTrigger({
  className,
  hideChevron = false,
  variant = 'row',
  children,
  ...props
}: CollapsibleTriggerProps) {
  if (variant === 'text') {
    return (
      <CollapsiblePrimitive.Trigger
        data-slot="collapsible-trigger"
        data-variant="text"
        className={cx(styles.triggerText, className)}
        {...props}
      >
        {!hideChevron && <ChevronRightIcon className={styles.chevronText} aria-hidden />}
        {children}
      </CollapsiblePrimitive.Trigger>
    );
  }
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cx(styles.trigger, className)}
      {...props}
    >
      {children}
      {!hideChevron && <ChevronDownIcon className={styles.chevron} aria-hidden />}
    </CollapsiblePrimitive.Trigger>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cx(styles.panel, className)}
      {...props}
    />
  );
}

export const Collapsible = {
  Root: CollapsibleRoot,
  Trigger: CollapsibleTrigger,
  Panel: CollapsiblePanel,
};
