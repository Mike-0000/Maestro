import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import { Spinner } from '../../primitives/spinner';
import * as styles from './empty-state.css';

export type EmptyStateSize = 'page' | 'panel';
export type EmptyStateTone = 'default' | 'error' | 'loading';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The title: what is (or is not) here, in a few plain words. */
  label: React.ReactNode;
  /** One sentence under the title: why, or what to do next. */
  description?: React.ReactNode;
  /**
   * The one action. On a page this may be the screen's primary button;
   * otherwise a `variant="text"` or `variant="ghost"` button.
   */
  action?: React.ReactNode;
  /**
   * `panel` (default): inside a list, side panel or card — 13px title.
   * `page`: a whole view or pane — the 26px hero title (21px in a narrow pane).
   */
  size?: EmptyStateSize;
  /**
   * `error`: the error dot before the title; put "Try again" in `action` and
   * the technical detail in `details`. `loading`: a passive spinner over the
   * title, shown only after `delayMs` so fast loads never flash.
   */
  tone?: EmptyStateTone;
  /** Technical detail behind a "Show details" disclosure, in mono (error tone). */
  details?: React.ReactNode;
  /** Loading tone only: wait this long before showing anything. Default 400ms. */
  delayMs?: number;
  /**
   * Render without the panel background, for containers that paint their own
   * surface (for example `CollectionView`'s card).
   */
  bare?: boolean;
}

function useDelayedVisible(enabled: boolean, delayMs: number): boolean {
  const [visible, setVisible] = React.useState(!enabled || delayMs <= 0);
  React.useEffect(() => {
    if (!enabled || delayMs <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [enabled, delayMs]);
  return visible;
}

/**
 * EmptyState — the one pattern for empty, loading and error states (design
 * brief 2.12): centred, a quiet title, one sentence, one action. Fills its
 * container (height 100%).
 *
 *   <EmptyState size="page" label="Nothing needs you" description="…" />
 *   <EmptyState label="No servers yet" action={<Button variant="text">Add one</Button>} />
 *   <EmptyState tone="error" label="Could not load branches" details={String(error)}
 *     action={<Button variant="text" onClick={retry}>Try again</Button>} />
 *   <EmptyState tone="loading" label="Loading branches…" bare />
 */
function EmptyState({
  label,
  description,
  action,
  size = 'panel',
  tone = 'default',
  details,
  delayMs = 400,
  bare,
  className,
  ...props
}: EmptyStateProps) {
  const visible = useDelayedVisible(tone === 'loading', delayMs);
  const page = size === 'page';

  return (
    <div
      data-slot="empty-state"
      data-size={size}
      data-tone={tone}
      role={tone === 'loading' ? 'status' : undefined}
      aria-busy={tone === 'loading' || undefined}
      className={cx(styles.root, bare && styles.bare, className)}
      {...props}
    >
      {visible && (
        <div className={cx(styles.content, page && styles.contentPage)}>
          {tone === 'loading' && <Spinner size={page ? 'lg' : 'md'} className={styles.spinner} />}
          <h2 className={cx(styles.label, page && styles.labelPage)}>
            {tone === 'error' ? (
              <span className={styles.titleRow}>
                <span aria-hidden className={styles.errorDot} />
                <span>{label}</span>
              </span>
            ) : (
              label
            )}
          </h2>
          {description != null && (
            <p className={cx(styles.description, page && styles.descriptionPage)}>{description}</p>
          )}
          {action != null && (
            <div className={cx(styles.action, page && styles.actionPage)}>{action}</div>
          )}
          {details != null && (
            <details className={styles.details}>
              <summary className={styles.detailsSummary}>Show details</summary>
              <div className={styles.detailsBody}>{details}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
