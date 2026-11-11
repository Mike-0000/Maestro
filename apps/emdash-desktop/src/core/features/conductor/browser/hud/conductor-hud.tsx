import {
  AlertTriangle,
  AudioLines,
  GitMerge,
  History,
  Loader2,
  Mic,
  MicOff,
  PlusCircle,
  SendHorizontal,
  Settings2,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useHudFootprint } from './hud-clearance';
import { useHudLayoutReserve } from './hud-reserve';
import { InvestigationCard } from './investigation-card';
import { LocalUpdateCard } from './local-update-card';
import { PendingActionCard } from './pending-action-card';
import { pendingKeyAction } from './pending-keys';
import { PlanPanel } from './plan-panel';
import { collapsePastedLines, createTypedSubmitMerger, TYPED_MERGE_WINDOW_MS } from './typed-merge';
import { VoiceSetupPanel } from './voice-setup';

/** How long a conductor reply stays on screen. */
const REPLY_VISIBLE_MS = 10_000;

/**
 * The always-available conductor surface: mic state and level, what was heard, what the
 * conductor is doing, cancellable pending actions, replies, errors, the active plan, and a typed
 * command box on the left for when talking is not an option. Typing an agent's name there (or the
 * start of it) offers to open that agent on the canvas.
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

  const listening = voice.phase === 'listening';
  const transcribing = voice.phase === 'transcribing';
  const error = voice.error ?? conductor.error;

  // Spoken-name badges on canvas windows while the mic is open.
  useEffect(() => {
    getCanvasStore().setListening(listening);
  }, [listening]);
  const showUtterance =
    (conductor.busy || replyVisible) && conductor.lastUtterance && !listening && !transcribing;
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
  // cards and panels raised here, which the reserve above deliberately does not follow.
  useHudFootprint(rootRef);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4"
    >
      <PlanPanel />
      {showLocalUpdate && <LocalUpdateCard onHide={() => setShowLocalUpdate(false)} />}
      {setupOpen && <VoiceSetupPanel onClose={() => setSetupOpen(false)} />}
      <div
        className={cn(
          'pointer-events-auto flex w-full max-w-[880px] flex-col gap-2 rounded-2xl border border-border bg-background/95 shadow-xl backdrop-blur',
          expanded ? 'p-3' : 'p-1.5'
        )}
      >
        {/* The resting bar: its height (with the collapsed padding) is the layout's reserve. */}
        <div ref={rowRef} className="flex items-center gap-2">
          <CommandBox toMaestro={typeToMaestro} disarmMaestro={() => setTypeToMaestro(false)} />
          {/* Left to right: Maestro (always Maestro), the conductor in front, dictation. */}
          <MaestroButton
            armed={typeToMaestro}
            onTypeToMaestro={() => setTypeToMaestro((armed) => !armed)}
          />
          <MicButton />
          <DictationButton />
          <LineIndicator />
          <div role="status" aria-live="polite" className="min-w-0 flex-1 overflow-hidden text-sm">
            <StatusLine />
          </div>
          <ManualListenControls />
          {!showLocalUpdate && (
            <HudIconButton
              label="Show local Maestro update"
              onClick={() => setShowLocalUpdate(true)}
            >
              <GitMerge className="size-4" />
            </HudIconButton>
          )}
          {needsSetup && !setupOpen && (
            <button
              type="button"
              onClick={() => setSetupOpen(true)}
              className="shrink-0 rounded-md bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-500/20 dark:text-blue-300"
            >
              Set up voice
            </button>
          )}
          <AudioDeviceMenu />
          <HudIconButton
            label={voice.muted ? 'Unmute spoken replies' : 'Mute spoken replies'}
            onClick={() => voice.setMuted(!voice.muted)}
          >
            {voice.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </HudIconButton>
          <HudIconButton
            label="Conductor history"
            active={showLog}
            onClick={() => setShowLog((open) => !open)}
          >
            <History className="size-4" />
          </HudIconButton>
          <HudIconButton
            label="Voice and conductor settings"
            onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
          >
            <Settings2 className="size-4" />
          </HudIconButton>
        </div>

        {showUtterance && (
          <p className="truncate px-1 text-xs text-foreground-muted italic">
            “{conductor.lastUtterance}”
          </p>
        )}

        {voice.ignoredUtterance && !conductor.busy && (
          <p className="truncate px-1 text-xs text-foreground-muted">
            Ignored “{voice.ignoredUtterance}” (no wake phrase)
          </p>
        )}

        <DictationPanel />

        <CallCard />

        <InvestigationCard />

        {conductor.pending && <PendingActionCard />}

        {replyVisible && conductor.reply && !conductor.busy && (
          <p className="px-1 text-sm text-foreground">{conductor.reply}</p>
        )}

        <LayoutUndoChip />

        {error && <ErrorCard />}

        {showLog && (
          <ConductorLogPanel
            refreshKey={conductor.logVersion}
            enabled={conductor.settings?.diagnosticHistory ?? false}
          />
        )}
      </div>
    </div>
  );
});

const MicButton = observer(function MicButton() {
  const voice = getVoiceStore();
  const listening = voice.phase === 'listening';
  const scale = listening ? 1 + Math.min(0.35, voice.level * 0.5) : 1;
  return (
    <button
      type="button"
      aria-label={listening ? 'Stop listening and send' : 'Start listening'}
      aria-pressed={listening}
      title="Click to talk, then click Send. Or hold Right Ctrl and release to send. Hold Shift + Right Ctrl to dictate into the focused agent."
      onClick={() => void voice.toggle()}
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
        listening
          ? 'bg-red-500 text-white'
          : voice.phase === 'error'
            ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
            : 'bg-background-secondary text-foreground hover:bg-background-tertiary'
      )}
    >
      {listening && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-red-500/40 transition-transform duration-75"
          style={{ transform: `scale(${scale + 0.25})` }}
        />
      )}
      {voice.phase === 'error' ? (
        <MicOff className="relative size-4" />
      ) : (
        <Mic className="relative size-4" />
      )}
    </button>
  );
});

/** Dictation to the open agent, transcribed on this computer. Separate from the command mic. */
const DictationButton = observer(function DictationButton() {
  const dictation = getDictationStore();
  const listening = dictation.phase === 'listening';
  const scale = listening ? 1 + Math.min(0.35, dictation.level * 0.5) : 1;
  return (
    <button
      type="button"
      aria-label={listening ? 'Finish dictation and send' : 'Dictate to the open agent'}
      aria-pressed={dictation.active}
      title="Dictate to the open agent. Click, or tap Right Ctrl once; click or tap again to send. Runs on this computer."
      disabled={dictation.phase === 'finishing'}
      onClick={() => dictation.toggle()}
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
        listening
          ? 'bg-blue-600 text-white'
          : dictation.active
            ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300'
            : 'bg-background-secondary text-foreground hover:bg-background-tertiary'
      )}
    >
      {listening && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-blue-600/40 transition-transform duration-75"
          style={{ transform: `scale(${scale + 0.25})` }}
        />
      )}
      <AudioLines className="relative size-4" />
    </button>
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
  const scale = listening ? 1 + Math.min(0.35, voice.level * 0.5) : 1;

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
    <button
      type="button"
      aria-label="Talk to Maestro"
      aria-pressed={listening || armed}
      title="Talk to Maestro, whatever chat is in front. Hold to speak and release to send; click to type your next message to Maestro."
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
        'relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
        listening
          ? 'bg-red-500 text-white'
          : armed
            ? 'bg-background-tertiary text-foreground ring-1 ring-foreground/60 ring-inset'
            : 'bg-background-secondary text-foreground ring-1 ring-foreground/15 ring-inset hover:bg-background-tertiary'
      )}
    >
      {listening && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-red-500/40 transition-transform duration-75"
          style={{ transform: `scale(${scale + 0.25})` }}
        />
      )}
      <Sparkles className="relative size-4" />
    </button>
  );
});

/**
 * The voice line, when one is wanted: whether it is open (it is the conductor then), and
 * whether it hears the developer right now. Shown only while the line is turned on; a hollow
 * dot is a line that is asleep (green) or shut for the day's limit (red).
 */
const LineIndicator = observer(function LineIndicator() {
  const talk = getTalkStore();
  if (talk.line === 'off') {
    if (!talk.asleep && !talk.overBudget) return null;
    const label = talk.overBudget
      ? "Voice conductor: today's limit is spent, so the text conductor answers. Raise the daily limit in Settings, or it opens again tomorrow"
      : 'Voice conductor: closed after a quiet spell, to save cost; pressing the talk key opens it again';
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={cn(
          'size-2.5 shrink-0 rounded-full border',
          talk.overBudget ? 'border-red-500/70' : 'border-emerald-500/70'
        )}
      />
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
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        talk.line === 'open'
          ? hears
            ? 'bg-emerald-500 ring-2 ring-emerald-500/40'
            : 'bg-emerald-500/70'
          : talk.line === 'connecting'
            ? 'animate-pulse bg-amber-500'
            : 'bg-red-500/70'
      )}
    />
  );
});

/** Click-to-talk records until the user sends or cancels (it does not stop on a pause). */
const ManualListenControls = observer(function ManualListenControls() {
  const voice = getVoiceStore();
  if (voice.phase !== 'listening' || voice.mode !== 'toggle' || voice.origin !== 'user') {
    return null;
  }
  return (
    <>
      <HudIconButton label="Cancel (Esc)" onClick={() => voice.cancelListening('hud-button')}>
        <X className="size-4" />
      </HudIconButton>
      <button
        type="button"
        onClick={() => void voice.stopListening()}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background hover:opacity-90"
      >
        <SendHorizontal className="size-3.5" />
        Send
      </button>
    </>
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
        <Loader2 className="size-3.5 animate-spin" />
        Transcribing…
      </span>
    );
  }
  if (conductor.pending) {
    return <span className="px-1 text-foreground">Waiting for your confirmation</span>;
  }
  if (conductor.busy) {
    return (
      <span className="flex items-center gap-2 text-foreground-muted">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 truncate">{conductor.activity || 'Working…'}</span>
      </span>
    );
  }
  // One fixed-height line. The hint comes first and shortens with an ellipsis only when the bar
  // itself is narrow; the readouts after it wrap onto a line that is cut off, so each shows whole
  // or not at all. The hint's wording does not change with who is in front: the typed box names
  // them, and the tooltip and screen readers get the full sentence.
  return (
    <span className="flex h-6 flex-wrap items-center gap-x-2 overflow-hidden px-1 text-xs/6 whitespace-nowrap text-foreground-muted">
      {voice.settings?.handsFree ? (
        <span className="max-w-full min-w-0 truncate">
          Hands-free: say “{capitalize(voice.settings.wakePhrase || 'Maestro')}, …”
        </span>
      ) : (
        <span
          className="max-w-full min-w-0 truncate"
          title={`Hold Right Ctrl to talk${talkTo ? ` to ${talkTo}` : ''}`}
        >
          Hold <Key>Right Ctrl</Key> to talk
          {talkTo && <span className="sr-only"> to {talkTo}</span>}
        </span>
      )}
      {voice.lastLatencyMs !== null && (
        <span className="shrink-0 tabular-nums opacity-70">STT {voice.lastLatencyMs} ms</span>
      )}
      <UsageReadout />
    </span>
  );
});

function LevelMeter({ level }: { level: number }) {
  const bars = [0.55, 0.8, 1, 0.8, 0.55];
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {bars.map((weight, index) => (
        <span
          key={index}
          className="w-1 rounded-full bg-red-500 transition-[height] duration-75"
          style={{ height: `${Math.max(3, Math.min(16, 3 + level * weight * 26))}px` }}
        />
      ))}
    </span>
  );
}

const ErrorCard = observer(function ErrorCard() {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  const voiceError = voice.error;
  const error = voiceError ?? conductor.error;
  if (!error) return null;
  const needsKey = error.kind === 'not-configured';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p>{error.message}</p>
        {error.kind === 'mic-permission' && (
          <button
            type="button"
            className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            onClick={() => void voice.openMicrophoneSettings()}
          >
            Open Windows microphone privacy settings
          </button>
        )}
        {needsKey && (
          <button
            type="button"
            className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
          >
            Open Voice & Conductor settings
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => (voiceError ? voice.dismissError() : conductor.dismissError())}
        className="text-foreground-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
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

  const placeholder = chat
    ? `Message ${conductorLabel(chat)}`
    : toMaestro
      ? 'Message Maestro'
      : 'Type a command or an agent, e.g. "Claude"';

  return (
    <form
      className="relative min-w-[200px] flex-[1.2]"
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
          className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-xl"
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
                'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-foreground',
                index === active && 'bg-background-secondary'
              )}
            >
              <PlusCircle className="size-3.5 shrink-0 text-foreground-muted" />
              <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
              {index === active && <Key>Enter</Key>}
            </li>
          ))}
        </ul>
      )}
      <input
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
        title={chat ? `Goes to ${conductorLabel(chat)}` : toMaestro ? 'Goes to Maestro' : undefined}
        className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-foreground-muted focus:border-blue-500"
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
          className="absolute inset-x-0 top-full mt-1 truncate px-1 text-xs text-foreground-muted"
        >
          sending… {heldLine}
        </p>
      )}
    </form>
  );
});

function HudIconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-muted hover:bg-background-secondary hover:text-foreground',
        active && 'bg-background-secondary text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-background-secondary px-1 py-px font-sans text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

/** True for `durationMs` after `changedAt` (a timestamp) changes. */
/** How long a voice layout change offers a one-click undo. */
const LAYOUT_UNDO_VISIBLE_MS = 12_000;

/** "Undo: Grouped Atlas and Bravo into Review" after a spoken layout change. */
const LayoutUndoChip = observer(function LayoutUndoChip() {
  const canvas = getCanvasStore();
  const change = canvas.lastChange;
  const spoken = change !== null && (change.source === 'voice' || change.source === 'typed');
  const visible = useRecentlyChanged(spoken ? change.at : 0, LAYOUT_UNDO_VISIBLE_MS);
  if (!visible || !canvas.canUndo || canvas.undoLabel !== change?.label) return null;
  return (
    <button
      type="button"
      onClick={() => canvas.undo()}
      className="flex items-center gap-1.5 self-start rounded-md px-1 text-xs text-foreground-muted hover:text-foreground"
    >
      <Undo2 className="size-3.5 shrink-0" />
      <span className="truncate">Undo: {change.label}</span>
    </button>
  );
});

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
        'shrink-0 tabular-nums opacity-70',
        share > 0.8 && 'text-amber-600 opacity-100'
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
