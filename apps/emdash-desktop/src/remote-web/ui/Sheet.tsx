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
 */
export function Sheet({ title, description, onClose, children, footer }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
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
      <div className="animate-sheet-in border-line bg-surface min-[640px]:animate-pop-in flex max-h-[calc(100%-env(safe-area-inset-top,0px)-12px)] w-full flex-col rounded-t-3xl border border-b-0 shadow-2xl min-[640px]:max-h-full min-[640px]:max-w-md min-[640px]:rounded-3xl min-[640px]:border-b">
        <div aria-hidden="true" className="flex justify-center pt-2.5 min-[640px]:hidden">
          <span className="bg-line-strong h-1 w-9 rounded-full" />
        </div>
        <header className="flex items-start gap-3 px-5 pt-3 pb-2 min-[640px]:pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[19px] font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-fg-muted mt-0.5 text-[13px]">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
            <X className="size-5" aria-hidden="true" />
          </IconButton>
        </header>
        <div className="scroll-area min-h-0 flex-1 px-5 pt-2 pb-4">{children}</div>
        {footer ? (
          <footer className="border-line pb-safe-or-3 border-t px-5 pt-3 min-[640px]:pb-4">
            {footer}
          </footer>
        ) : (
          <div className="pb-safe" />
        )}
      </div>
    </dialog>
  );
}
