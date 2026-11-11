import { ArrowUp, ChevronDown, Square, Volume2, VolumeX, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { examplePhrases } from '../lib/voice-logic';
import type { VoiceStore } from '../state/voice-store';
import { useApp, useVoice } from './app-context';
import { IconButton, Spinner } from './controls';
import { cx, useIsWide } from './hooks';
import { StateMark, type StateMarkState } from './StatusIndicator';
import { PendingCard, PlanCard, ProblemCard } from './VoiceCards';
import { HudTalkButton, Waveform } from './VoiceMic';

/** Whether a key pressed with this element focused belongs to the page rather than a control. */
function isFreeForShortcuts(target: EventTarget | null): boolean {
  if (document.querySelector('dialog[open]')) return false;
  if (!(target instanceof Element)) return true;
  return !target.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable], [role="button"], .xterm'
  );
}

/**
 * Keyboard talking for desktop browsers: hold Space to talk when nothing that takes typing is
 * focused, and Esc to cancel. While a recording runs, Esc always cancels it and never reaches
 * the page, so it cannot land in an agent's terminal as an interrupt.
 */
function useVoiceKeys(voice: VoiceStore): void {
  useEffect(() => {
    let spaceHeld = false;
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (voice.commandActive) {
          spaceHeld = false;
          voice.cancelTalking();
          swallow(event);
        } else if (isFreeForShortcuts(event.target) && voice.hudOpen) {
          if (voice.hud?.pending) void voice.respond('no');
          else voice.closeHud();
          swallow(event);
        }
        return;
      }
      if (event.code !== 'Space') return;
      if (spaceHeld) {
        // Key repeat while holding.
        swallow(event);
        return;
      }
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!isFreeForShortcuts(event.target) || !voice.available) return;
      swallow(event);
      if (voice.commandRecording) {
        voice.finishTalking();
        return;
      }
      spaceHeld = true;
      voice.pressStart();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || !spaceHeld) return;
      spaceHeld = false;
      swallow(event);
      // A stray tap of the bar is dropped rather than left recording.
      voice.pressEnd({ latch: false });
    };
    const onBlur = (): void => {
      if (!spaceHeld) return;
      spaceHeld = false;
      voice.pressEnd({ cancel: true, latch: false });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [voice]);
}

/**
 * The conductor's heads-up display: what was heard, what it is doing, what it said, and what it
 * is waiting on. A non-modal panel, so the agents behind it stay visible and usable; it rises
 * from the bottom edge on a phone and sits in the list column on a wide screen.
 */
export const VoiceHud = observer(function VoiceHud() {
  const voice = useVoice();
  const wide = useIsWide();
  useVoiceKeys(voice);
  if (!voice.hudOpen) return null;
  return (
    <section
      role="dialog"
      aria-label="Voice"
      className={cx(
        // The desktop voice bar's floating layer: elevated, one hairline, the bar's 20px radius.
        'surface-elevated absolute z-30 flex flex-col border border-border-subtle bg-surface shadow-overlay',
        wide
          ? 'animate-pop-in bottom-3 left-3 max-h-[calc(100%-1.5rem)] w-[354px] rounded-2xl'
          : 'animate-sheet-in inset-x-0 bottom-0 max-h-[82%] rounded-t-2xl border-b-0'
      )}
    >
      <HudHeader />
      <HudBody />
      <HudFooter />
    </section>
  );
});

function statusOf(voice: VoiceStore, hostName: string): { text: string; tone: Tone } {
  const hud = voice.hud;
  if (voice.commandRecording) {
    return voice.capture.phase === 'starting'
      ? { text: 'Opening the microphone…', tone: 'busy' }
      : { text: 'Listening', tone: 'recording' };
  }
  if (voice.commandActive) {
    if (voice.stage === 'waiting-link') return { text: 'Waiting to reconnect…', tone: 'busy' };
    if (voice.stage === 'transcribing') return { text: 'Transcribing…', tone: 'busy' };
    return { text: 'Sending…', tone: 'busy' };
  }
  if (!hud) return { text: 'Connecting…', tone: 'busy' };
  if (!hud.available) return { text: 'Not ready', tone: 'idle' };
  if (hud.pending) {
    return {
      text: hud.pending.kind === 'confirm' ? 'Waiting for your answer' : 'About to act',
      tone: 'waiting',
    };
  }
  if (voice.thinking) return { text: 'Working', tone: 'busy' };
  if (voice.speaking) return { text: 'Speaking', tone: 'speaking' };
  return { text: hostName, tone: 'idle' };
}

type Tone = 'idle' | 'busy' | 'recording' | 'waiting' | 'speaking';

/** The shared state marks for the conductor's status; busy moments get a passive spinner. */
const TONE_MARK: Record<Exclude<Tone, 'busy'>, StateMarkState> = {
  idle: 'idle',
  recording: 'working',
  waiting: 'needs-you',
  speaking: 'working',
};

function StatusGlyph({ tone }: { tone: Tone }) {
  if (tone === 'busy') {
    return (
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        <Spinner className="size-3 border-[1.5px] text-foreground-passive" />
      </span>
    );
  }
  return <StateMark state={TONE_MARK[tone]} />;
}

const HudHeader = observer(function HudHeader() {
  const app = useApp();
  const voice = useVoice();
  const wide = useIsWide();
  const status = statusOf(voice, app.hostName);
  return (
    <header className="shrink-0">
      {wide ? null : (
        <div aria-hidden="true" className="flex justify-center pt-2">
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>
      )}
      <div className={cx('flex items-center gap-1 pr-1.5 pl-5', wide ? 'pt-2' : 'pt-0.5')}>
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-foreground">Conductor</h2>
          <p
            role="status"
            aria-live="polite"
            className="text-detail -ml-1 flex min-w-0 items-center gap-1 text-foreground-muted"
          >
            <StatusGlyph tone={status.tone} />
            <span className="truncate">{status.text}</span>
          </p>
        </div>
        <IconButton
          label={voice.muted ? 'Speak replies' : 'Mute spoken replies'}
          aria-pressed={voice.muted}
          onClick={() => voice.setMuted(!voice.muted)}
        >
          {voice.muted ? (
            <VolumeX className="size-5" aria-hidden="true" />
          ) : (
            <Volume2 className="size-5" aria-hidden="true" />
          )}
        </IconButton>
        <IconButton label="Close voice" onClick={() => voice.closeHud()}>
          {wide ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-6" aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </header>
  );
});

const HudBody = observer(function HudBody() {
  const app = useApp();
  const voice = useVoice();
  const hud = voice.hud;
  const scrollRef = useRef<HTMLDivElement>(null);
  const reply = voice.reply;
  const pendingId = hud?.pending?.id;
  const planStatus = hud?.plan?.status;
  const noticeKind = voice.notice?.kind;

  // Whatever arrives last is what the person is waiting for; keep it in view.
  useEffect(() => {
    const area = scrollRef.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [reply, pendingId, planStatus, noticeKind, voice.thinking, voice.stage]);

  if (!hud) {
    return (
      <div className="flex items-center justify-center px-5 py-10 text-foreground-passive">
        <Spinner className="size-5" />
        <span className="sr-only">Connecting to the conductor</span>
      </div>
    );
  }

  if (!hud.available) {
    return (
      <div className="flex flex-col items-center px-8 pt-6 pb-8 text-center">
        <h3 className="text-heading font-semibold text-balance text-foreground">
          Open Maestro on {app.hostName}
        </h3>
        <p className="text-body mt-2 max-w-xs text-balance text-foreground-muted">
          The conductor runs in the Maestro window on that computer. Once the window is open, you
          can talk to it from here.
        </p>
      </div>
    );
  }

  const utterance = voice.utterance;
  const working = voice.commandActive && voice.capture.phase === 'idle';
  const quiet =
    !utterance &&
    !reply &&
    !hud.pending &&
    !hud.plan &&
    !voice.notice &&
    !voice.hostError &&
    !voice.commandActive &&
    !voice.thinking;
  // While only recording, the footer says it all; an empty body would be a blank band.
  const empty =
    !quiet &&
    !utterance &&
    !working &&
    !voice.thinking &&
    !reply &&
    !hud.pending &&
    !hud.plan &&
    !voice.notice &&
    !voice.hostError &&
    hud.transcriptionReady;
  if (empty) return null;

  return (
    <div ref={scrollRef} className="scroll-area flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-3">
      {quiet ? <Examples /> : null}

      {utterance && !quiet ? (
        <p className="text-body max-w-[88%] self-end rounded-lg bg-surface-emphasis px-3.5 py-2 break-words text-foreground">
          {utterance}
        </p>
      ) : null}

      {working ? (
        <BusyLine
          text={
            voice.stage === 'waiting-link'
              ? `Recorded. Waiting for ${app.hostName}…`
              : voice.stage === 'transcribing'
                ? 'Transcribing…'
                : 'Sending…'
          }
          action={
            <IconButton label="Cancel" onClick={() => voice.cancelTalking()}>
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          }
        />
      ) : voice.thinking && !hud.pending ? (
        <BusyLine text={hud.activity || (hud.phase === 'acting' ? 'Working…' : 'Thinking…')} />
      ) : null}

      {reply && !voice.thinking && !working ? <Reply text={reply} /> : null}

      {hud.pending ? <PendingCard pending={hud.pending} /> : null}
      {hud.plan ? <PlanCard plan={hud.plan} /> : null}

      {voice.notice ? (
        <ProblemCard
          kind={voice.notice.kind}
          title={voice.notice.title}
          body={voice.notice.body}
          onRetry={voice.notice.canRetry ? () => voice.retry() : undefined}
          onDismiss={() => voice.dismissNotice()}
        />
      ) : null}
      {voice.hostError ? (
        <ProblemCard
          kind="host"
          title="The conductor hit a problem"
          body={voice.hostError}
          onDismiss={() => voice.dismissHostError()}
        />
      ) : null}

      {!hud.transcriptionReady && !voice.notice ? (
        <p className="text-detail px-1 text-foreground-muted">
          Speech-to-text isn’t set up on {app.hostName} yet (Settings → Voice &amp; Conductor
          there). Until then, type your commands.
        </p>
      ) : null}
    </div>
  );
});

function BusyLine({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="text-detail flex min-h-11 items-center gap-2.5 pl-1 text-foreground-muted">
      <Spinner className="size-4 shrink-0 text-foreground-passive" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {action}
    </div>
  );
}

const Reply = observer(function Reply({ text }: { text: string }) {
  const voice = useVoice();
  return (
    <div className="animate-fade-in flex items-start gap-1 pl-1">
      {/* The one line that matters most, as on the desktop conductor. */}
      <p
        aria-live="polite"
        className="text-heading min-w-0 flex-1 py-2.5 break-words whitespace-pre-wrap text-foreground"
      >
        {text}
      </p>
      {voice.speaking ? (
        <IconButton label="Stop speaking" onClick={() => voice.stopSpeaking()}>
          <Square className="size-3.5 fill-current" aria-hidden="true" />
        </IconButton>
      ) : (
        <IconButton label="Read aloud" onClick={() => voice.readReplyAloud()}>
          <Volume2 className="size-4" aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
});

const Examples = observer(function Examples() {
  const app = useApp();
  const voice = useVoice();
  const phrases = examplePhrases(
    voice.hud?.agentNames ?? [],
    app.projects.map((project) => project.name)
  );
  return (
    <div className="px-1 pt-1 pb-1">
      <p className="text-caption text-foreground-passive">Try saying</p>
      <ul className="mt-1 flex flex-col">
        {phrases.map((phrase) => (
          <li key={phrase}>
            <button
              type="button"
              onClick={() => voice.setTyped(phrase)}
              className="text-body -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center rounded-md px-2 py-2 text-left text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground active:bg-surface-hover"
            >
              “{phrase}”
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

/**
 * The bottom row: a text field and the talk button, or, while recording, the level, the clock
 * and the way out. The talk button keeps its place in the tree throughout, because a hold that
 * starts on it is tracked through it until the finger lifts.
 */
const HudFooter = observer(function HudFooter() {
  const voice = useVoice();
  const [sending, setSending] = useState(false);

  if (!voice.available) return <div className="pb-safe-or-3 shrink-0" />;

  const text = voice.typed;
  const capturing = voice.commandRecording;
  const tapMode = capturing && voice.recordingMode === 'tap';
  const armed = voice.cancelArmed;
  const busy = voice.stage !== 'idle' || sending || voice.dictationKey !== null;
  const hasText = text.trim().length > 0;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!hasText || busy || capturing) return;
    setSending(true);
    const delivered = await voice.sendTyped(text);
    setSending(false);
    if (delivered) voice.setTyped('');
  };

  return (
    <footer className="hud-footer pb-safe-or-3 shrink-0 px-3 pt-2">
      {capturing && voice.partial ? (
        <p className="text-body mb-2 line-clamp-3 px-1.5 text-foreground-body italic">
          {voice.partial}
        </p>
      ) : null}
      <form onSubmit={(event) => void submit(event)} className="flex items-center gap-2">
        {tapMode ? (
          <IconButton
            key="cancel"
            label="Cancel recording"
            className="size-12 rounded-full bg-surface-emphasis"
            onClick={() => voice.cancelTalking()}
          >
            <X className="size-5" aria-hidden="true" />
          </IconButton>
        ) : null}
        {capturing ? (
          <div
            key="meter"
            className={cx(
              // The level in the accent, like the desktop bar's meter; passive once a release
              // would cancel.
              'flex h-12 min-w-0 flex-1 items-center gap-3 rounded-lg bg-surface-emphasis px-4 transition-colors duration-150',
              armed ? 'text-foreground-passive' : 'text-accent'
            )}
          >
            <Waveform className="flex-1" />
            <span className="text-body shrink-0 text-foreground tabular-nums">
              {voice.elapsedLabel}
            </span>
          </div>
        ) : (
          <div key="field" className="min-w-0 flex-1">
            <label htmlFor="voice-command" className="sr-only">
              Type a command
            </label>
            <input
              id="voice-command"
              value={text}
              onChange={(event) => voice.setTyped(event.target.value)}
              placeholder="Type instead…"
              autoComplete="off"
              autoCapitalize="sentences"
              enterKeyHint="send"
              className="field text-reading h-12 w-full rounded-lg px-3.5"
            />
          </div>
        )}
        {hasText && !capturing ? (
          <button
            key="send"
            type="submit"
            aria-label="Send"
            disabled={busy}
            // Sending must not dismiss the on-screen keyboard.
            onMouseDown={(event) => event.preventDefault()}
            className="bg-primary text-primary-foreground hover:bg-primary-hover flex size-12 shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] duration-150 disabled:opacity-40"
          >
            {sending ? (
              <Spinner />
            ) : (
              <ArrowUp className="size-5" strokeWidth={2.25} aria-hidden="true" />
            )}
          </button>
        ) : (
          <HudTalkButton key="talk" disabled={busy} />
        )}
      </form>
      {capturing ? <RecordingHint /> : null}
    </footer>
  );
});

const RecordingHint = observer(function RecordingHint() {
  const voice = useVoice();
  const armed = voice.cancelArmed;
  const keyboard = window.matchMedia('(pointer: fine)').matches;
  const hint =
    voice.capture.phase === 'starting'
      ? 'Waiting for the microphone…'
      : voice.recordingMode === 'tap'
        ? keyboard
          ? 'Send when you’re done · Esc cancels'
          : 'Tap send when you’re done'
        : armed
          ? 'Release to cancel'
          : keyboard
            ? 'Release to send · Esc cancels'
            : 'Release to send · slide away to cancel';
  return (
    <p
      aria-live="polite"
      className={cx(
        'mt-1.5 text-center text-caption',
        armed ? 'font-medium text-foreground' : 'text-foreground-muted'
      )}
    >
      {hint}
    </p>
  );
});
