import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './controls';

type SheetProps = {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  /** Pinned below the scrolling content: the sheet's primary action. */
  footer?: ReactNode;
};

/**
 * A modal sheet: slides up from the bottom edge on a phone, sits centered on a wide screen.
 * Built on the native <dialog>, which supplies the focus trap, Escape handling and inertness
 * of everything behind it. The dialog element spans the visual viewport (not the layout
 * viewport), so the sheet stays above the on-screen keyboard.
 *
 * Drawn like the desktop's dialogs: the elevated surface with one hairline, the overlay shadow
 * and scrim, a title and one sentence, no rules between header, body and footer.
 */
export function Sheet({ title, description, onClose, children, footer }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // showModal() moves focus into the dialog after React has already focused a field that
    // asked for it; hand focus back to that field.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed top-(--vv-top,0px) left-0 m-0 flex h-(--vv-height,100dvh) max-h-none w-full max-w-none items-end justify-center bg-transparent p-0 min-[640px]:items-center min-[640px]:p-6"
    >
      <div className="surface-elevated animate-sheet-in min-[640px]:animate-pop-in flex max-h-[calc(100%-env(safe-area-inset-top,0px)-12px)] w-full flex-col rounded-t-xl border border-b-0 border-border-subtle bg-surface shadow-overlay min-[640px]:max-h-full min-[640px]:max-w-[32.5rem] min-[640px]:rounded-xl min-[640px]:border-b">
        <div aria-hidden="true" className="flex justify-center pt-2 min-[640px]:hidden">
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>
        <header className="flex items-start gap-3 pt-3 pr-3 pb-1 pl-5 min-[640px]:pt-5">
          <div className="min-w-0 flex-1 pt-2.5">
            <h2 id={titleId} className="text-heading font-semibold text-foreground">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-detail mt-0.5 text-foreground-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </IconButton>
        </header>
        <div className="scroll-area min-h-0 flex-1 px-5 pt-4 pb-5">{children}</div>
        {footer ? (
          <footer className="pb-safe-or-3 px-5 pt-1 min-[640px]:pb-5">{footer}</footer>
        ) : (
          <div className="pb-safe" />
        )}
      </div>
    </dialog>
  );
}
