import {
  ArrowBigUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  CornerDownLeft,
} from 'lucide-react';
import { useEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { TerminalKey } from '../lib/terminal-keys';
import { cx } from './hooks';

type KeyBarProps = {
  /** Offer one-tap answers (y / n / 1 / 2 / 3) while the agent is waiting on a prompt. */
  showReplies: boolean;
  onKey(key: TerminalKey): void;
  onText(text: string): void;
};

const QUICK_REPLIES = ['y', 'n', '1', '2', '3'] as const;

const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 75;

/**
 * The keys a phone keyboard does not have. Tapping one never takes focus from the composer,
 * so the on-screen keyboard stays exactly as it was.
 */
export function KeyBar({ showReplies, onKey, onText }: KeyBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-3 pt-2 pb-1.5"
    >
      {showReplies ? (
        <>
          {QUICK_REPLIES.map((reply) => (
            <KeyButton
              key={reply}
              label={`Send ${reply}`}
              tone="reply"
              onPress={() => onText(reply)}
            >
              {reply}
            </KeyButton>
          ))}
          <span aria-hidden="true" className="bg-line-strong mx-0.5 h-5 w-px shrink-0" />
        </>
      ) : null}
      <KeyButton label="Escape" onPress={() => onKey('escape')}>
        esc
      </KeyButton>
      <KeyButton label="Enter" onPress={() => onKey('enter')}>
        <CornerDownLeft className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Tab" onPress={() => onKey('tab')}>
        <ArrowRightToLine className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Shift Tab" onPress={() => onKey('shift-tab')}>
        <ArrowBigUp className="size-4" aria-hidden="true" />
        <ArrowRightToLine className="-ml-0.5 size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Up arrow" repeat onPress={() => onKey('up')}>
        <ArrowUp className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Down arrow" repeat onPress={() => onKey('down')}>
        <ArrowDown className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Left arrow" repeat onPress={() => onKey('left')}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Right arrow" repeat onPress={() => onKey('right')}>
        <ArrowRight className="size-4" aria-hidden="true" />
      </KeyButton>
      <KeyButton label="Control C, interrupt" tone="danger" onPress={() => onKey('ctrl-c')}>
        ctrl c
      </KeyButton>
    </div>
  );
}

type KeyButtonProps = {
  label: string;
  tone?: 'key' | 'reply' | 'danger';
  /** Holding the key repeats it, like a hardware keyboard. */
  repeat?: boolean;
  onPress(): void;
  children: ReactNode;
};

const KEY_TONES: Record<NonNullable<KeyButtonProps['tone']>, string> = {
  key: 'border-line-strong bg-surface text-fg',
  reply: 'border-attention-line bg-attention-soft text-attention',
  danger: 'border-line-strong bg-surface text-danger',
};

function tick(): void {
  try {
    navigator.vibrate?.(6);
  } catch {
    // Haptics are a nicety.
  }
}

function KeyButton({ label, tone = 'key', repeat = false, onPress, children }: KeyButtonProps) {
  const timers = useRef<{ delay?: number; interval?: number; repeated: boolean }>({
    repeated: false,
  });
  const pressRef = useRef(onPress);
  pressRef.current = onPress;

  const stop = (): void => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.interval);
  };
  useEffect(() => stop, []);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!repeat || event.button !== 0) return;
    stop();
    timers.current.repeated = false;
    timers.current.delay = window.setTimeout(() => {
      timers.current.repeated = true;
      pressRef.current();
      timers.current.interval = window.setInterval(() => pressRef.current(), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };

  const onClick = (): void => {
    // A hold already sent its keys; the click that ends it must not send one more.
    if (timers.current.repeated) {
      timers.current.repeated = false;
      return;
    }
    tick();
    onPress();
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Keeps focus (and the on-screen keyboard) where it is.
      onMouseDown={(event: MouseEvent) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      onClick={onClick}
      className={cx(
        'inline-flex h-9 min-w-10 shrink-0 items-center justify-center rounded-[10px] border px-2.5 font-mono text-[13px] font-medium',
        'transition-[background-color,transform] duration-100 active:scale-95 active:bg-surface-3',
        KEY_TONES[tone]
      )}
    >
      {children}
    </button>
  );
}
