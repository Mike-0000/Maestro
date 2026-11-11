import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Input, Kbd, Tooltip } from '@emdash/ui/react/primitives';
import {
  AudioLines,
  GitMerge,
  History,
  Mic,
  MicOff,
  PlusCircle,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getTalkStore } from '@core/features/talk/contributions/browser/app-stores';
import {
  getDictationStore,
  getVoiceStore,
} from '@core/features/voice/contributions/browser/app-stores';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  suggestAgents,
  type AgentSuggestion,
  type SuggestableProvider,
} from '../../api/agent-suggestions';
import { getChatConductorManager, getConductorStore } from '../../contributions/browser/app-stores';
import { conductorLabel } from '../chat-conductor/front';
import { AudioDeviceMenu } from './audio-device-menu';
import { CallCard } from './call-card';
import { ConductorLogPanel } from './conductor-log-panel';
import { DictationPanel } from './dictation-panel';
import { HUD_LAYER, HudCard, LevelMeter } from './hud-card';
import { useHudFootprint } from './hud-clearance';
import { useHudLayoutReserve } from './hud-reserve';
import { useHudSpan } from './hud-span';
import { InvestigationCard } from './investigation-card';
import { LocalUpdateCard } from './local-update-card';
import { PendingActionCard } from './pending-action-card';
import { isTextEntryTarget, pendingKeyAction } from './pending-keys';
import { PlanPanel } from './plan-panel';
import { collapsePastedLines, createTypedSubmitMerger, TYPED_MERGE_WINDOW_MS } from './typed-merge';
import { VoiceSetupPanel } from './voice-setup';

/** How long a conductor reply stays on screen. */
const REPLY_VISIBLE_MS = 10_000;

/** The three round voice buttons share one shape and one focus ring. */
const HUD_ROUND =
  'relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';
/** At rest: one surface step above the bar, lifting one more on hover. */
const HUD_ROUND_REST =
  'bg-surface-hover text-foreground-muted hover:bg-surface-selected hover:text-foreground';
/**
 * Live (the microphone is open for it): the accent, the same mark the line indicator wears while
 * it hears the developer.
 */
const HUD_ROUND_LIVE = 'bg-accent text-accent-foreground';

/**
 * The always-available conductor surface. One quiet floating bar over the content area: the typed
 * command box on the left, the three voice buttons, the voice line, one status line, and quiet
 * icon buttons on the right. Everything else it has to show (the call on the line, a
 * confirmation, a code check, dictation, the reply, an error, the history, the plan, the local
 * update) is a card raised above the bar, so the bar itself never moves or grows. Typing an
 * agent's name (or the start of it) in the box offers to open that agent on the canvas.
 */
export const ConductorHud = observer(function ConductorHud() {
  const voice = getVoiceStore();
  const dictation = getDictationStore();
  const conductor = getConductorStore();
  const [showLog, setShowLog] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  /** The Maestro button armed the typed box: its next message goes to Maestro. */
  const [typeToMaestro, setTypeToMaestro] = useState(false);
  const [showLocalUpdate, setShowLocalUpdate] = useLocalStorage('chorus:show-local-update', true);
  const needsSetup = voice.settings !== null && !voice.settings.onboarded;
  const replyVisible = useRecentlyChanged(conductor.replyAt, REPLY_VISIBLE_MS);
  const span = useHudSpan();
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pending = conductor.pending;
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Enter typed into a terminal or text field must never approve an action.
      const action = pendingKeyAction(event, pending.startedAt, Date.now());
      if (action === 'confirm') conductor.confirmPending();
      else if (action === 'cancel') conductor.cancelPending();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [conductor, conductor.pending]);

  // Escape closes the history. A confirmation, dictation and a running code check own Escape
  // while they show, and a key typed into a terminal or text field, or already taken by a dialog
  // or menu, is left alone.
  useEffect(() => {
    if (!showLog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      if (isTextEntryTarget(event.target)) return;
      if (conductor.pending || dictation.active || conductor.investigation) return;
      setShowLog(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showLog, conductor, dictation]);

  const listening = voice.phase === 'listening';
  const transcribing = voice.phase === 'transcribing';
  const error = voice.error ?? conductor.error;

  // Spoken-name badges on canvas windows while the mic is open.
  useEffect(() => {
    getCanvasStore().setListening(listening);
  }, [listening]);
  const showUtterance = Boolean(
    (conductor.busy || replyVisible) && conductor.lastUtterance && !listening && !transcribing
  );
  const ignored = voice.ignoredUtterance && !conductor.busy ? voice.ignoredUtterance : null;
  const reply = replyVisible && conductor.reply && !conductor.busy ? conductor.reply : null;
  const expanded =
    listening ||
    transcribing ||
    conductor.busy ||
    conductor.pending !== null ||
    conductor.calls.current !== null ||
    conductor.investigation !== null ||
    conductor.lastInvestigation !== null ||
    (replyVisible && conductor.reply !== '') ||
    error !== null ||
    dictation.active ||
    dictation.sentTo !== null ||
    showLog;
  useHudLayoutReserve(rootRef, rowRef, expanded);
  // Views with controls at their bottom edge (a chat's Conductor composer) stay clear of the
  // cards raised here, which the reserve above deliberately does not follow.
  useHudFootprint(rootRef);

  return (
    <div
      ref={rootRef}
      // Over the content area only (never the sidebar), centred on it.
      style={{ left: span.left, right: span.right }}
      className="pointer-events-none fixed bottom-4 z-40 flex flex-col items-center gap-2 px-4"
    >
      <PlanPanel />
      {showLocalUpdate && <LocalUpdateCard onHide={() => setShowLocalUpdate(false)} />}
      {setupOpen && <VoiceSetupPanel onClose={() => setSetupOpen(false)} />}
      {showLog && (
        <ConductorLogPanel
          refreshKey={conductor.logVersion}
          enabled={conductor.settings?.diagnosticHistory ?? false}
          onClose={() => setShowLog(false)}
        />
      )}

      <InvestigationCard />

      <CallCard />

      <DictationPanel />

      {(showUtterance || ignored || reply) && (
        <HudCard>
          {showUtterance && (
            <p className="truncate text-xs text-foreground-muted">
              You said “{conductor.lastUtterance}”
            </p>
          )}
          {ignored && (
            <p className="truncate text-xs text-foreground-muted">
              Ignored “{ignored}” (no wake phrase)
            </p>
          )}
          {reply && (
            <p className={cn('text-base text-foreground', (showUtterance || ignored) && 'mt-1')}>
              {reply}
            </p>
          )}
        </HudCard>
      )}

      <LayoutUndoChip />

      {conductor.pending && <PendingActionCard />}

      {error && <ErrorCard />}

      {/* The bar: one floating layer whose padding never changes, so the resting row's height
          (with that padding) is the layout's reserve whatever is raised above it. */}
      <div className={cn(HUD_LAYER, 'w-full max-w-220 rounded-2xl p-1.5')}>
        <div ref={rowRef} className="flex items-center gap-1.5">
          <CommandBox toMaestro={typeToMaestro} disarmMaestro={() => setTypeToMaestro(false)} />
          {/* Left to right: Maestro (always Maestro), the conductor in front, dictation. */}
          <MaestroButton
            armed={typeToMaestro}
            onTypeToMaestro={() => setTypeToMaestro((armed) => !armed)}
          />
          <MicButton />
          <DictationButton />
          <LineIndicator />
          <div
            role="status"
            aria-live="polite"
            className="@container/hud-status min-w-0 flex-1 overflow-hidden pl-0.5 text-sm"
          >
            <StatusLine />
          </div>
          <ManualListenControls />
          {needsSetup && !setupOpen && (
            <Button
              type="button"
              variant="text"
              size="xs"
              className="mx-1.5 shrink-0"
              onClick={() => setSetupOpen(true)}
            >
              Set up voice
            </Button>
          )}
          <div className="flex shrink-0 items-center">
            {!showLocalUpdate && (
              <HudIconButton
                label="Show local Maestro update"
                onClick={() => setShowLocalUpdate(true)}
              >
                <GitMerge aria-hidden />
              </HudIconButton>
            )}
            <AudioDeviceMenu />
            <HudIconButton
              label={voice.muted ? 'Unmute spoken replies' : 'Mute spoken replies'}
              onClick={() => voice.setMuted(!voice.muted)}
            >
              {voice.muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
            </HudIconButton>
            <HudIconButton
              label="Conductor history"
              active={showLog}
              onClick={() => setShowLog((open) => !open)}
            >
              <History aria-hidden />
            </HudIconButton>
            <HudIconButton
              label="Voice and conductor settings"
              onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
            >
              <Settings2 aria-hidden />
            </HudIconButton>
          </div>
        </div>
      </div>
    </div>
  );
});

/** A quiet note over a HUD control (the kit tooltip, above the bar). */
function HudTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Content side="top" className="max-w-xs">
        {label}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * A halo behind a live round button that grows with the microphone level. Under reduced motion
 * it rests as a still ring, so the open microphone never depends on movement or on colour alone
 * (the live buttons also swap their glyph for a stop square).
 */
function LevelHalo({ level }: { level: number }) {
  const scale = 1 + Math.min(0.35, level * 0.5);
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-accent/30 motion-safe:transition-transform motion-safe:duration-75 motion-reduce:hidden"
        style={{ transform: `scale(${scale + 0.25})` }}
      />
      <span
        aria-hidden
        className="absolute -inset-1 rounded-full ring-2 ring-accent/50 motion-safe:hidden"
      />
    </>
  );
}

/** The live microphone's glyph: a stop square (click stops and sends), a shape cue beyond colour. */
function LiveGlyph() {
  return <Square aria-hidden className="relative size-3.5 fill-current" />;
}

const MicButton = observer(function MicButton() {
  const voice = getVoiceStore();
  const listening = voice.phase === 'listening';
  return (
    <HudTip label="Click to talk, then click Send. Or hold Right Ctrl and release to send. Hold Shift + Right Ctrl to dictate into the focused agent.">
      <button
        type="button"
        aria-label={listening ? 'Stop listening and send' : 'Start listening'}
        aria-pressed={listening}
        onClick={() => void voice.toggle()}
        className={cn(
          HUD_ROUND,
          listening
            ? HUD_ROUND_LIVE
            : voice.phase === 'error'
              ? 'bg-surface-hover text-foreground-warning hover:bg-surface-selected'
              : HUD_ROUND_REST
        )}
      >
        {listening && <LevelHalo level={voice.level} />}
        {listening ? (
          <LiveGlyph />
        ) : voice.phase === 'error' ? (
          <MicOff aria-hidden className="relative size-4" />
        ) : (
          <Mic aria-hidden className="relative size-4" />
        )}
      </button>
    </HudTip>
  );
});

/** Dictation to the open agent, transcribed on this computer. Separate from the command mic. */
const DictationButton = observer(function DictationButton() {
  const dictation = getDictationStore();
  const listening = dictation.phase === 'listening';
  return (
    <HudTip label="Dictate to the open agent. Click, or tap Right Ctrl once; click or tap again to send. Runs on this computer.">
      <button
        type="button"
        aria-label={listening ? 'Finish dictation and send' : 'Dictate to the open agent'}
        aria-pressed={dictation.active}
        disabled={dictation.phase === 'finishing'}
        onClick={() => dictation.toggle()}
        className={cn(
          HUD_ROUND,
          'disabled:opacity-50',
          listening
            ? HUD_ROUND_LIVE
            : dictation.active
              ? 'bg-surface-selected text-foreground'
              : HUD_ROUND_REST
        )}
      >
        {listening && <LevelHalo level={dictation.level} />}
        {listening ? <LiveGlyph /> : <AudioLines aria-hidden className="relative size-4" />}
      </button>
    </HudTip>
  );
});

/** How long the Maestro button is held before it opens the microphone; shorter is a click. */
const MAESTRO_HOLD_MS = 250;

/**
 * Always addresses Maestro, whatever chat conductor is in front: hold it to speak a command to
 * Maestro (release to send), click it to type the next message to Maestro.
 */
const MaestroButton = observer(function MaestroButton({
  armed,
  onTypeToMaestro,
}: {
  /** The typed box is waiting for a message to Maestro. */
  armed: boolean;
  onTypeToMaestro: () => void;
}) {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** This button opened the microphone and is still held. */
  const holdingRef = useRef(false);
  const [holding, setHolding] = useState(false);
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    []
  );
  const listening = holding && voice.phase === 'listening';

  /** The press ended: a short one was a click, a long one sends what was said. */
  const release = (click: boolean) => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      if (click) onTypeToMaestro();
      return;
    }
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    if (voice.phase === 'listening' && voice.mode === 'hold') void voice.stopListening();
  };

  return (
    <HudTip label="Talk to Maestro, whatever chat is in front. Hold to speak and release to send; click to type your next message to Maestro.">
      <button
        type="button"
        aria-label="Talk to Maestro"
        aria-pressed={listening || armed}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null;
            holdingRef.current = true;
            setHolding(true);
            void conductor.listenToMaestro('hold');
          }, MAESTRO_HOLD_MS);
        }}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        onLostPointerCapture={() => release(false)}
        onClick={(event) => {
          // Pointer presses are handled above; this is Enter or Space on the focused button.
          if (event.detail === 0) onTypeToMaestro();
        }}
        // The hairline ring sets it apart from the two microphones beside it: its target never
        // changes with what is in front. The ring firms up while the typed box is armed for it.
        className={cn(
          HUD_ROUND,
          listening
            ? HUD_ROUND_LIVE
            : armed
              ? 'bg-surface-selected text-foreground ring-1 ring-foreground/60 ring-inset'
              : `${HUD_ROUND_REST} ring-1 ring-foreground/15 ring-inset`
        )}
      >
        {listening && <LevelHalo level={voice.level} />}
        <Sparkles aria-hidden className="relative size-4" />
      </button>
    </HudTip>
  );
});

/**
 * The voice line, when one is wanted: whether it is open (it is the conductor then), and
 * whether it hears the developer right now. Shown only while the line is turned on; a hollow
 * ring is a line that is asleep, and an error-toned ring one shut for the day's limit.
 */
const LineIndicator = observer(function LineIndicator() {
  const talk = getTalkStore();
  if (talk.line === 'off') {
    if (!talk.asleep && !talk.overBudget) return null;
    const label = talk.overBudget
      ? "Voice conductor: today's limit is spent, so the text conductor answers. Raise the daily limit in Settings, or it opens again tomorrow"
      : 'Voice conductor: closed after a quiet spell, to save cost; pressing the talk key opens it again';
    // At rest: a ring, the same mark a finished task wears; error-toned when the day's limit
    // shut it.
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className="inline-flex size-3 shrink-0 items-center justify-center"
      >
        {talk.overBudget ? (
          <span
            aria-hidden
            className="size-2 rounded-full border-[1.5px] border-foreground-error"
          />
        ) : (
          <StateGlyph state="done" size="sm" />
        )}
      </span>
    );
  }
  const hears = talk.holding || talk.micOpen;
  const label =
    talk.line === 'open'
      ? hears
        ? 'Voice conductor: listening'
        : talk.speaking
          ? 'Voice conductor: speaking'
          : 'Voice conductor: ready (hold the talk key to speak)'
      : talk.line === 'connecting'
        ? 'Voice conductor: connecting'
        : `Voice conductor: not connected${talk.error ? ` (${talk.error})` : ''}; the text conductor answers`;
  // The glyph set of the sidebar and the conductor strip: an accent dot while the line is live
  // (haloed while it hears the developer), the small pulsing dot while it connects, and the
  // filled error dot when it is down.
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex size-3 shrink-0 items-center justify-center"
    >
      {talk.line === 'open' ? (
        <span
          aria-hidden
          className={cn('size-2 rounded-full bg-accent', hears && 'ring-2 ring-accent/35')}
        />
      ) : (
        <StateGlyph state={talk.line === 'connecting' ? 'working' : 'error'} size="sm" />
      )}
    </span>
  );
});

/** Click-to-talk records until the user sends or cancels (it does not stop on a pause). */
const ManualListenControls = observer(function ManualListenControls() {
  const voice = getVoiceStore();
  if (voice.phase !== 'listening' || voice.mode !== 'toggle' || voice.origin !== 'user') {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      <HudIconButton label="Cancel (Esc)" onClick={() => voice.cancelListening('hud-button')}>
        <X aria-hidden />
      </HudIconButton>
      <Button type="button" variant="primary" size="sm" onClick={() => void voice.stopListening()}>
        <SendHorizontal aria-hidden className="size-3.5" />
        Send
      </Button>
    </div>
  );
});

const StatusLine = observer(function StatusLine() {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  const front = getChatConductorManager().front;
  // The voice line is a conversation with Maestro: what is said on it is Maestro's.
  const talkTo = front && getTalkStore().line !== 'open' ? conductorLabel(front) : null;
  if (voice.phase === 'listening') {
    // With a chat conductor in front, say whom this capture is for; otherwise it is Maestro's.
    const heardBy = conductor.listeningFor
      ? conductorLabel(conductor.listeningFor)
      : front
        ? 'Maestro'
        : null;
    const line =
      voice.intent === 'dictation'
        ? // Into the agent in front, even with its chat's Conductor view on screen.
          `Dictating into ${conductor.dictationTarget() ?? 'the focused agent'}…`
        : voice.origin === 'hands-free'
          ? 'Listening (hands-free)…'
          : voice.mode === 'hold'
            ? `Listening${heardBy ? ` for ${heardBy}` : ''}… release to send`
            : `Listening${heardBy ? ` for ${heardBy}` : ''}… click Send when you are done`;
    return (
      <span className="flex items-center gap-2 text-foreground">
        <LevelMeter level={voice.level} />
        {voice.partial ? (
          <span className="min-w-0 truncate italic">{voice.partial}</span>
        ) : (
          // One line, whoever it is for: a long name shortens the tail, never grows the bar.
          <span className="min-w-0 truncate" title={line}>
            {line}
          </span>
        )}
      </span>
    );
  }
  if (voice.phase === 'transcribing') {
    return (
      <span className="flex items-center gap-2 text-foreground-muted">
        <StateGlyph state="working" size="sm" />
        Transcribing…
      </span>
    );
  }
  if (conductor.pending) {
    return (
      <span className="flex items-center gap-2 text-foreground">
        <StateGlyph state="needs-you" size="sm" />
        <span className="min-w-0 truncate">Waiting for your confirmation</span>
      </span>
    );
  }
  if (conductor.busy) {
    return (
      <span className="flex items-center gap-2 text-foreground-muted">
        <StateGlyph state="working" size="sm" />
        <span className="min-w-0 truncate">{conductor.activity || 'Working…'}</span>
      </span>
    );
  }
  // One fixed-height line. The hint comes first and shortens with an ellipsis only when the bar
  // itself is narrow; the readouts after it wrap onto a line that is cut off, so each shows whole
  // or not at all. The hint's wording does not change with who is in front: the typed box names
  // them, and the tooltip and screen readers get the full sentence. When the bar is too narrow for
  // even the start of the hint, it steps aside (it stays for screen readers) instead of showing a
  // stub.
  return (
    <span className="flex h-6 flex-wrap items-center gap-x-3 overflow-hidden text-xs/6 whitespace-nowrap text-foreground-muted @max-[7rem]/hud-status:sr-only">
      {voice.settings?.handsFree ? (
        <span className="max-w-full min-w-0 truncate">
          Hands-free: say “{capitalize(voice.settings.wakePhrase || 'Maestro')}, …”
        </span>
      ) : (
        <span
          className="max-w-full min-w-0 truncate"
          title={`Hold Right Ctrl to talk${talkTo ? ` to ${talkTo}` : ''}`}
        >
          Hold <Kbd className="mx-0.5 align-middle">Right Ctrl</Kbd> to talk
          {talkTo && <span className="sr-only"> to {talkTo}</span>}
        </span>
      )}
      {voice.lastLatencyMs !== null && (
        <span className="shrink-0 text-tiny text-foreground-passive tabular-nums">
          STT {voice.lastLatencyMs} ms
        </span>
      )}
      <UsageReadout />
    </span>
  );
});

/** What went wrong with the voice or the conductor, what fixes it, and Dismiss. */
const ErrorCard = observer(function ErrorCard() {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  const voiceError = voice.error;
  const error = voiceError ?? conductor.error;
  if (!error) return null;
  const needsKey = error.kind === 'not-configured';
  return (
    <HudCard className="py-2.5">
      <div className="flex items-start gap-2">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <StateGlyph state="error" size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{error.message}</p>
          {(error.kind === 'mic-permission' || needsKey) && (
            <div className="mt-1.5 flex flex-wrap gap-x-4">
              {error.kind === 'mic-permission' && (
                <Button
                  type="button"
                  variant="text"
                  size="xs"
                  onClick={() => void voice.openMicrophoneSettings()}
                >
                  Open Windows microphone privacy settings
                </Button>
              )}
              {needsKey && (
                <Button
                  type="button"
                  variant="text"
                  size="xs"
                  onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
                >
                  Open Voice & Conductor settings
                </Button>
              )}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon
          aria-label="Dismiss"
          onClick={() => (voiceError ? voice.dismissError() : conductor.dismissError())}
          className="-my-1 -mr-1.5 shrink-0"
        >
          <X aria-hidden />
        </Button>
      </div>
    </HudCard>
  );
});

/**
 * The typed side of the conductor: free text goes to the conductor like speech, and an agent name
 * (or its start, or an abbreviation like "omp") offers to open that agent on the canvas. Arrow
 * keys move through the offers, Enter picks one, and Esc drops them so Enter sends the text.
 */
const CommandBox = observer(function CommandBox({
  toMaestro,
  disarmMaestro,
}: {
  /** The Maestro button armed the box: the next message goes to Maestro. */
  toMaestro: boolean;
  disarmMaestro: () => void;
}) {
  const conductor = getConductorStore();
  const front = getChatConductorManager().front;
  /** The chat conductor the box addresses; null when it addresses Maestro. */
  const chat = toMaestro ? null : front;
  const [text, setText] = useState('');
  const [providers, setProviders] = useState<SuggestableProvider[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A typed line ending in ":" waits briefly for the rest of the message.
  const [heldLine, setHeldLine] = useState<string | null>(null);
  const merger = useMemo(
    () =>
      createTypedSubmitMerger(
        // The chat conductor in front takes the words unless they answer Maestro.
        (message) => void conductor.submitTyped(message),
        TYPED_MERGE_WINDOW_MS,
        setHeldLine
      ),
    [conductor]
  );
  useEffect(() => () => merger.flush(), [merger]);

  // Installed agents are cached for a minute; focusing the box picks up newly installed ones.
  const loadProviders = () => {
    void conductor.suggestableProviders().then(setProviders, () => {});
  };
  useEffect(() => {
    void conductor.suggestableProviders().then(setProviders, () => {});
  }, [conductor]);

  // Offers to open an agent are Maestro's; a message to a chat conductor is only a message.
  const toChat = chat !== null;
  const suggestions = useMemo(
    () => (toChat ? [] : suggestAgents(text, providers)),
    [toChat, text, providers]
  );
  const open = focused && !dismissed && suggestions.length > 0;
  const active = Math.min(highlighted, suggestions.length - 1);

  const reset = () => {
    setText('');
    setHighlighted(0);
    setDismissed(false);
  };
  const pick = (suggestion: AgentSuggestion) => {
    reset();
    void conductor.openAgent(suggestion.providerId);
    if (toMaestro) disarmMaestro();
  };

  // Armed by the Maestro button: the box takes the keyboard for that message.
  useEffect(() => {
    if (toMaestro) inputRef.current?.focus();
  }, [toMaestro]);

  // Short enough to show whole in the box at its narrowest; the example is in the tooltip.
  const placeholder = chat
    ? `Message ${conductorLabel(chat)}`
    : toMaestro
      ? 'Message Maestro'
      : 'Type a command or an agent';

  return (
    <form
      // The box is a fill one step off the bar, like the round voice buttons beside it, with no
      // edge of its own (the kit field's light-theme edge read as a box inside the bar). Focus
      // draws the accent ring around the whole box.
      className="relative min-w-52 flex-[1.2] rounded-md bg-surface-hover transition-[background-color,box-shadow] focus-within:bg-surface-hover focus-within:ring-2 focus-within:ring-ring hover:bg-surface-selected"
      onSubmit={(event) => {
        event.preventDefault();
        const chosen = open ? suggestions[active] : undefined;
        if (chosen) return pick(chosen);
        if (!text.trim()) return;
        if (toMaestro) {
          // One message, straight to Maestro: anything held for merging goes first.
          merger.flush();
          void conductor.handleUtterance(text, 'typed');
          disarmMaestro();
        } else {
          merger.submit(text);
        }
        reset();
      }}
    >
      {open && (
        <ul
          id="conductor-agent-suggestions"
          role="listbox"
          aria-label="Open an agent"
          // At least as wide as the box, wider for long agent names.
          className={cn(
            HUD_LAYER,
            'absolute bottom-full left-0 mb-2.5 w-max max-w-sm min-w-full rounded-lg p-1'
          )}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.providerId}
              id={`conductor-agent-suggestion-${suggestion.providerId}`}
              role="option"
              aria-selected={index === active}
              // Keep focus in the input so the list does not close before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => pick(suggestion)}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-foreground-muted',
                index === active && 'bg-surface-hover text-foreground'
              )}
            >
              <PlusCircle aria-hidden className="size-4 shrink-0 text-foreground-passive" />
              <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
              {index === active && <Kbd>Enter</Kbd>}
            </li>
          ))}
        </ul>
      )}
      <Input
        ref={inputRef}
        value={text}
        role="combobox"
        aria-label={chat ? `Message to ${conductorLabel(chat)}` : 'Command'}
        aria-expanded={open}
        aria-controls="conductor-agent-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={
          open ? `conductor-agent-suggestion-${suggestions[active]?.providerId}` : undefined
        }
        placeholder={placeholder}
        title={
          chat
            ? `Goes to ${conductorLabel(chat)}`
            : toMaestro
              ? 'Goes to Maestro'
              : 'Type a command for Maestro, or an agent to open, e.g. "Claude"'
        }
        // Bare: the form above draws the fill and the focus ring.
        bare
        className="h-9 px-3 text-ellipsis"
        onChange={(event) => {
          setText(event.target.value);
          setHighlighted(0);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          loadProviders();
        }}
        onBlur={() => setFocused(false)}
        onPaste={(event) => {
          // A multi-line paste is one message, never one submit per line.
          const pasted = event.clipboardData.getData('text');
          if (!/[\r\n]/.test(pasted)) return;
          event.preventDefault();
          const input = event.currentTarget;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? start;
          setText(
            input.value.slice(0, start) +
              collapsePastedLines(pasted).trim() +
              input.value.slice(end)
          );
          setHighlighted(0);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && open) {
            event.preventDefault();
            setHighlighted((active + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp' && open) {
            event.preventDefault();
            setHighlighted((active - 1 + suggestions.length) % suggestions.length);
          } else if (event.key === 'Escape') {
            if (open) setDismissed(true);
            else if (text) reset();
            else {
              if (toMaestro) disarmMaestro();
              inputRef.current?.blur();
            }
          }
        }}
      />
      {heldLine && (
        <p
          role="status"
          className={cn(
            HUD_LAYER,
            'absolute inset-x-0 bottom-full mb-2.5 truncate rounded-lg px-3 py-1.5 text-xs text-foreground-muted'
          )}
        >
          Sending… {heldLine}
        </p>
      )}
    </form>
  );
});

/** A quiet glyph button on the bar: passive at rest, full strength on hover, pressed when on. */
function HudIconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  /** Pressed: the panel it opens is showing. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <HudTip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="base"
        icon
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
      </Button>
    </HudTip>
  );
}

/** How long a voice layout change offers a one-click undo. */
const LAYOUT_UNDO_VISIBLE_MS = 12_000;

/** "Grouped Atlas and Bravo into Review · Undo" after a spoken layout change. */
const LayoutUndoChip = observer(function LayoutUndoChip() {
  const canvas = getCanvasStore();
  const change = canvas.lastChange;
  const spoken = change !== null && (change.source === 'voice' || change.source === 'typed');
  const visible = useRecentlyChanged(spoken ? change.at : 0, LAYOUT_UNDO_VISIBLE_MS);
  if (!visible || !canvas.canUndo || canvas.undoLabel !== change?.label) return null;
  return (
    <HudCard className="flex w-auto max-w-xl items-center gap-4 rounded-lg py-2">
      <span className="min-w-0 truncate text-xs text-foreground-muted">{change.label}</span>
      <Button
        type="button"
        variant="text"
        size="xs"
        aria-label={`Undo: ${change.label}`}
        onClick={() => canvas.undo()}
      >
        Undo
      </Button>
    </HudCard>
  );
});

/** True for `durationMs` after `changedAt` (a timestamp) changes. */
function useRecentlyChanged(changedAt: number, durationMs: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!changedAt) return;
    const remaining = changedAt + durationMs - Date.now();
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [changedAt, durationMs]);
  return visible;
}

/** Today's conductor tokens against the daily budget; hidden until the conductor has been used. */
const UsageReadout = observer(function UsageReadout() {
  const status = getConductorStore().status;
  if (!status?.configured) return null;
  const used = status.usageToday.inputTokens + status.usageToday.outputTokens;
  if (used === 0) return null;
  const budget = status.settings.dailyTokenBudget;
  const share = budget > 0 ? used / budget : 0;
  return (
    <span
      className={cn(
        'shrink-0 text-tiny tabular-nums',
        share > 0.8 ? 'text-foreground-warning' : 'text-foreground-passive'
      )}
      title={
        budget > 0
          ? `${used.toLocaleString()} of ${budget.toLocaleString()} tokens today`
          : undefined
      }
    >
      {formatCompact(used)}
      {budget > 0 ? ` / ${formatCompact(budget)}` : ''} tok
    </span>
  );
});

function formatCompact(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
