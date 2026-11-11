import { ArrowUp, Mic, Square } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { appendDictation } from '../lib/voice-logic';
import { useVoice } from './app-context';
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
 * always adds a line (there is no Shift to hold). The mic dictates into the box: the words are
 * transcribed on the host and added to the draft, to be read over and sent by hand.
 */
export const Composer = observer(function Composer({
  placeholder,
  draftKey,
  onSubmit,
}: ComposerProps) {
  const voice = useVoice();
  const dictation = voice.dictationPhase(draftKey);
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

  // Leaving the screen ends a dictation that was meant for it.
  useEffect(() => () => voice.cancelDictation(draftKey), [draftKey, voice]);

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
      className="composer pb-safe-or-2 flex items-end gap-1.5 px-3 pt-1"
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
        placeholder={
          dictation === 'recording'
            ? 'Listening… tap the mic when you’re done'
            : dictation === 'transcribing'
              ? 'Transcribing…'
              : placeholder
        }
        autoCapitalize="sentences"
        autoComplete="off"
        enterKeyHint="enter"
        className="field no-scrollbar text-reading min-h-11 min-w-0 flex-1 resize-none rounded-lg px-3.5 py-2.5"
      />
      <DictateButton
        phase={dictation}
        level={dictation === 'recording' ? voice.level : 0}
        disabled={dictation === 'idle' && (voice.isRecording || voice.stage !== 'idle')}
        onPress={() =>
          voice.toggleDictation(draftKey, (dictated) =>
            setText((current) => appendDictation(current, dictated))
          )
        }
        onCancel={() => voice.cancelDictation(draftKey)}
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!canSend}
        // Sending must not dismiss the on-screen keyboard.
        onMouseDown={(event) => event.preventDefault()}
        className={cx(
          'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
          canSend || sending ? 'bg-primary text-primary-foreground' : 'text-foreground-passive'
        )}
      >
        {sending ? (
          <Spinner />
        ) : (
          <ArrowUp className="size-5" strokeWidth={2.25} aria-hidden="true" />
        )}
      </button>
    </form>
  );
});

function DictateButton({
  phase,
  level,
  disabled,
  onPress,
  onCancel,
}: {
  phase: 'idle' | 'starting' | 'recording' | 'transcribing';
  level: number;
  disabled: boolean;
  onPress(): void;
  onCancel(): void;
}) {
  const recording = phase === 'recording' || phase === 'starting';
  const label =
    phase === 'transcribing'
      ? 'Transcribing. Tap to cancel'
      : recording
        ? 'Finish dictating'
        : 'Dictate into the message';
  return (
    <span className="relative flex size-11 shrink-0 items-center justify-center">
      {phase === 'recording' ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-accent/25 motion-safe:transition-transform motion-safe:duration-100"
          style={{ transform: `scale(${1.08 + level * 0.4})` }}
        />
      ) : null}
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={recording}
        disabled={disabled}
        // Dictating must not dismiss the on-screen keyboard.
        onMouseDown={(event) => event.preventDefault()}
        onClick={phase === 'transcribing' ? onCancel : onPress}
        className={cx(
          'relative flex size-11 items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-40',
          recording
            ? 'bg-foreground text-foreground-inverse'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground active:bg-surface-hover'
        )}
      >
        {phase === 'transcribing' ? (
          <Spinner />
        ) : recording ? (
          <Square className="size-3.5 fill-current" aria-hidden="true" />
        ) : (
          <Mic className="size-5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
