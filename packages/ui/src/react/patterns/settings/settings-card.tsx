import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import * as styles from './settings.css';

export interface SettingsCardProps {
  children: React.ReactNode;
  className?: string;
  /**
   * `padded` (default): 16px all round, for free-form content.
   * `rows`: 16px sides and 8px top and bottom, for a stack of `SettingsRow`s,
   * which bring their own 12px vertical padding.
   */
  padding?: 'padded' | 'rows';
}

/**
 * SettingsCard — the grouped settings surface (design brief 2.8): one step up
 * from the page (the emphasis surface), rounded-lg, one subtle hairline. Its
 * contents resolve the surface cascade against the card, so inputs and quiet
 * buttons inside tint relative to it. Callers add their own header markup when
 * needed.
 */
export function SettingsCard({ children, className, padding = 'padded' }: SettingsCardProps) {
  return (
    <div
      data-slot="settings-card"
      className={cx(styles.card, padding === 'rows' && styles.cardRows, className)}
    >
      <div data-slot="settings-card-body" className={styles.body}>
        {children}
      </div>
    </div>
  );
}
