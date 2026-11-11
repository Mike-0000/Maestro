import type { ReactNode } from 'react';
import { AnimatedHeight } from '../animated-height';
import { Dialog } from '../dialog';
import * as styles from './modal-layout.css';

export interface ModalLayoutProps {
  /** A custom header. When omitted, `title` (and `description`) build the standard one. */
  header?: ReactNode;
  /** A custom footer. When omitted, `actions` (and `leading`) build the standard one. */
  footer?: ReactNode;
  children: ReactNode;
  /** Standard header: the dialog title (dialog-title role). */
  title?: ReactNode;
  /** Standard header: one sentence under the title, muted. */
  description?: ReactNode;
  /** Standard header: show the top-right close button. Defaults to true. */
  showCloseButton?: boolean;
  /**
   * Standard footer, right side: Cancel as `variant="ghost"` first, then the one
   * `variant="primary"` action rightmost.
   */
  actions?: ReactNode;
  /** Standard footer, left side: extra links (Learn more) as `variant="text"` buttons. */
  leading?: ReactNode;
}

/**
 * Standard modal composition (design brief 2.9): a static header and footer
 * around a middle section that height-animates as its content changes (e.g.
 * between steps or validation states). Put the form in a `Dialog.Body`. When
 * the content outgrows the window (also after the dialog opened, e.g. after a
 * fetch) the middle scrolls between the header and the footer.
 *
 * Pass `header` / `footer` for full control, or the shorthand props:
 *
 *   <ModalLayout
 *     title="Rename project"
 *     description="The folder on disk keeps its name."
 *     actions={<>
 *       <Button variant="ghost" onClick={dismiss}>Cancel</Button>
 *       <ConfirmButton variant="primary">Rename</ConfirmButton>
 *     </>}
 *   >
 *     <Dialog.Body>…</Dialog.Body>
 *   </ModalLayout>
 *
 * Width comes from the host: `size` on the app's modal definition (sm 400,
 * md 520, lg 680, xl 880) or on the kit `Dialog.Content`.
 */
export function ModalLayout({
  header,
  footer,
  children,
  title,
  description,
  showCloseButton = true,
  actions,
  leading,
}: ModalLayoutProps) {
  const resolvedHeader =
    header ??
    (title != null ? (
      <Dialog.Header showCloseButton={showCloseButton}>
        <Dialog.Title>{title}</Dialog.Title>
        {description != null && <Dialog.Description>{description}</Dialog.Description>}
      </Dialog.Header>
    ) : null);

  const resolvedFooter =
    footer ??
    (actions != null || leading != null ? (
      <Dialog.Footer>
        {leading != null && <div className={styles.leading}>{leading}</div>}
        {actions}
      </Dialog.Footer>
    ) : null);

  return (
    <>
      {resolvedHeader}
      <AnimatedHeight constrain>{children}</AnimatedHeight>
      {resolvedFooter}
    </>
  );
}
