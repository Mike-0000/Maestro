import { ArrowUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Spinner } from './controls';
import { cx } from './hooks';

type ComposerProps = {
  placeholder: string;
  /** Drafts are kept per key for the life of the page, so switching agents does not lose one. */
  draftKey: string;
  /** Resolves true when the text was delivered; the draft is kept otherwise. */
  onSubmit(text: string): Promise<boolean>;
};

const MAX_HEIGHT_PX = 148;
const drafts = new Map<string, string>();

/**
 * The prompt box. Multi-line, grows with its content, and sends with the button; on a
 * hardware keyboard Enter sends and Shift+Enter adds a line, while a phone's Return key
 * always adds a line (there is no Shift to hold).
 */
export function Composer({ placeholder, draftKey, onSubmit }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 && !sending;

  useEffect(() => {
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const send = async (): Promise<void> => {
    if (!canSend) return;
    setSending(true);
    const delivered = await onSubmit(text);
    setSending(false);
    if (delivered) setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    const hardwareKeyboard = window.matchMedia('(pointer: fine)').matches;
    if (!hardwareKeyboard && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void send();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="composer pb-safe-or-2 flex items-end gap-2 px-3 pt-1"
    >
      <label className="sr-only" htmlFor={`composer-${draftKey}`}>
        Message the agent
      </label>
      <textarea
        id={`composer-${draftKey}`}
        ref={fieldRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={placeholder}
        autoCapitalize="sentences"
        autoComplete="off"
        enterKeyHint="enter"
        className="no-scrollbar border-line-strong bg-surface text-fg placeholder:text-fg-passive focus:border-focus focus:ring-focus/25 min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border px-4 py-[10px] leading-[22px] outline-none focus:ring-2"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!canSend}
        // Sending must not dismiss the on-screen keyboard.
        onMouseDown={(event) => event.preventDefault()}
        className={cx(
          'flex size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,transform,opacity] duration-150 active:scale-95',
          canSend || sending ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-fg-passive'
        )}
      >
        {sending ? (
          <Spinner />
        ) : (
          <ArrowUp className="size-5" strokeWidth={2.5} aria-hidden="true" />
        )}
      </button>
    </form>
  );
}
