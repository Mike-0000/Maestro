import { ArrowUp, Mic } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef, type MouseEvent, type PointerEvent } from 'react';
import { WAVEFORM_BARS } from '../state/voice-store';
import { useVoice } from './app-context';
import { cx } from './hooks';

/** Releasing this far from the middle of the mic button discards the recording. */
const CANCEL_RADIUS_PX = 84;

type Press = { centerX: number; centerY: number; finishing: boolean };

/**
 * Press handling shared by every talk button. Pressing starts recording at once; holding records
 * until the release, sliding away arms a cancel, and a quick tap leaves the recording running
 * until the next tap. The pointer is captured, so the release is seen wherever the finger ends
 * up and whatever is drawn over the button meanwhile.
 */
function useTalkPress() {
  const voice = useVoice();
  const press = useRef<Press | null>(null);

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>): void {
      if (event.button !== 0 || press.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      // A tap on the button while a tap-to-talk recording runs finishes it.
      const finishing = voice.commandRecording;
      press.current = {
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        finishing,
      };
      if (finishing) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; the click that follows still toggles.
      }
      voice.pressStart();
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>): void {
      const current = press.current;
      if (!current || current.finishing) return;
      const distance = Math.hypot(event.clientX - current.centerX, event.clientY - current.centerY);
      voice.pressArm(distance > CANCEL_RADIUS_PX);
    },
    onPointerUp(): void {
      const current = press.current;
      press.current = null;
      if (!current) return;
      if (current.finishing) voice.finishTalking();
      else voice.pressEnd({ latch: true });
    },
    onPointerCancel(): void {
      const current = press.current;
      press.current = null;
      // The system took the touch away (a gesture, a call): never send what was not released.
      if (current && !current.finishing) voice.pressEnd({ cancel: true, latch: false });
    },
    onClick(event: MouseEvent<HTMLButtonElement>): void {
      // A keyboard or assistive-technology activation arrives as a click with no pointer.
      if (event.detail === 0) voice.toggleTalk();
    },
    // Keeps focus, and with it the on-screen keyboard, where it was.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    // A long press must not open the system menu.
    onContextMenu: (event: MouseEvent) => event.preventDefault(),
  };
}

const PRESS_SURFACE = 'touch-none [-webkit-touch-callout:none] select-none';

/**
 * The floating mic: the way into voice mode from the agents list and from an agent's screen.
 * It stays mounted while the HUD is open over it, because a hold that began on it is still
 * being tracked through it.
 */
export const VoiceFab = observer(function VoiceFab({
  size = 'large',
  className,
}: {
  size?: 'large' | 'compact';
  className?: string;
}) {
  const voice = useVoice();
  const handlers = useTalkPress();
  const hidden = voice.hudOpen;
  return (
    <button
      type="button"
      aria-label="Talk to Maestro"
      title="Hold to talk, or tap"
      aria-haspopup="dialog"
      aria-expanded={voice.hudOpen}
      tabIndex={hidden ? -1 : 0}
      {...handlers}
      className={cx(
        'absolute flex items-center justify-center rounded-full border border-line-strong bg-raised text-fg shadow-lg shadow-black/30',
        'transition-[opacity,transform] duration-150 active:scale-95',
        size === 'large' ? 'size-14' : 'size-12',
        PRESS_SURFACE,
        // Hidden under the HUD, but only out of reach once no press is using it.
        hidden && 'opacity-0',
        hidden && voice.recordingMode !== 'hold' && 'pointer-events-none',
        className
      )}
    >
      <Mic className={size === 'large' ? 'size-6' : 'size-[22px]'} aria-hidden="true" />
      {voice.needsLook && !hidden ? (
        <span
          aria-hidden="true"
          className="border-raised bg-attention absolute top-0.5 right-0.5 size-3 rounded-full border-2"
        />
      ) : null}
    </button>
  );
});

/**
 * The talk button inside the HUD. It is a mic that can be held or tapped; while a tap-to-talk
 * recording runs it is the Send button, in the same place, so "tap again" needs no aim.
 */
export const HudTalkButton = observer(function HudTalkButton({ disabled }: { disabled: boolean }) {
  const voice = useVoice();
  const handlers = useTalkPress();
  const recording = voice.commandRecording;
  const tapMode = recording && voice.recordingMode === 'tap';
  const holding = recording && !tapMode;
  const armed = voice.cancelArmed;
  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center">
      {holding ? (
        <span
          aria-hidden="true"
          className={cx(
            'absolute inset-0 rounded-full transition-transform duration-100',
            armed ? 'bg-fg-passive/40' : 'bg-danger/35'
          )}
          style={{ transform: `scale(${1.12 + voice.level * 0.5})` }}
        />
      ) : null}
      <button
        type="button"
        disabled={disabled}
        aria-label={
          tapMode ? 'Send' : recording ? 'Recording. Release to send' : 'Hold to talk, or tap'
        }
        title={tapMode ? 'Send' : 'Hold to talk, or tap'}
        {...handlers}
        className={cx(
          'relative flex size-12 items-center justify-center rounded-full',
          'transition-[background-color,transform,opacity] duration-150 active:scale-95 disabled:opacity-40',
          PRESS_SURFACE,
          holding
            ? armed
              ? 'bg-surface-3 text-fg-muted'
              : 'bg-danger text-white'
            : 'bg-primary text-primary-fg'
        )}
      >
        {tapMode ? (
          <ArrowUp className="size-[22px]" strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Mic className="size-[22px]" aria-hidden="true" />
        )}
      </button>
    </span>
  );
});

/** The microphone's recent level as bars, newest on the right. */
export const Waveform = observer(function Waveform({ className }: { className?: string }) {
  const voice = useVoice();
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex h-8 min-w-0 items-center justify-end gap-[2px] overflow-hidden',
        className
      )}
    >
      {voice.levels.slice(-WAVEFORM_BARS).map((level, index) => (
        <span
          // The bars are a fixed-length window; position is their identity.
          key={index}
          className="w-[3px] shrink-0 rounded-full bg-current"
          style={{ height: `${3 + level * 27}px` }}
        />
      ))}
    </span>
  );
});
