import { SeparatedList } from '@react/primitives/separated-list';
import { Heading } from '@react/primitives/typography/Heading';
import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import { SettingsCard } from './settings-card';
import * as styles from './settings.css';

export interface SettingsSectionProps {
  /** Optional section heading rendered above the card, inset to align with card content. */
  title?: React.ReactNode;
  /** Optional one sentence under the title, muted. */
  description?: React.ReactNode;
  /**
   * Space between rows inside the card. Default: `'1.25rem'` (rows read about
   * 56–60px apart; design brief 2.5).
   */
  gap?: string;
  /**
   * Draw a subtle hairline between rows. Off by default: rows separate by space
   * (design brief 2.8). Use for long, dense lists where rows would otherwise run
   * together.
   */
  separated?: boolean;
  /**
   * When true the section renders children as-is under the heading — for
   * content that brings its own surface (a custom card, a tile grid).
   * Default: false, wrapping children in a `SettingsCard`.
   */
  bare?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * SettingsSection — the canonical settings-page section: an optional heading in
 * the section-title role (13px semibold) 12px above a `SettingsCard` whose
 * children are rows separated by space.
 *
 * Usage:
 * ```tsx
 * <SettingsSection title="Preferences">
 *   <SettingsRow label="Automatic updates" control={<Switch />} />
 *   <SettingsRow label="Telemetry" control={<Switch />} />
 * </SettingsSection>
 * ```
 *
 * Sections stack on the page with page-owned spacing (`gap-10` between
 * sections); the section only owns the heading-to-card gap and the card shell.
 */
export function SettingsSection({
  title,
  description,
  gap = '1.25rem',
  separated = false,
  bare = false,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section data-slot="settings-section" className={cx(styles.section, className)}>
      {title != null && (
        <Heading level={3} className={styles.sectionTitle}>
          {title}
        </Heading>
      )}
      {description != null && <p className={styles.sectionDescription}>{description}</p>}
      {bare ? (
        children
      ) : (
        <SettingsCard>
          {separated ? (
            <SeparatedList gap={gap} direction="column">
              {children}
            </SeparatedList>
          ) : (
            <div data-slot="settings-rows" className={styles.rows} style={{ gap }}>
              {children}
            </div>
          )}
        </SettingsCard>
      )}
    </section>
  );
}
