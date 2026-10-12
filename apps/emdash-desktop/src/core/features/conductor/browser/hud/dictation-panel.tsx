import { AudioLines, CheckCircle2, Download, Loader2, SendHorizontal, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { getDictationStore } from '@core/features/voice/contributions/browser/app-stores';
import { getConductorStore } from '../../contributions/browser/app-stores';

type DictationStore = ReturnType<typeof getDictationStore>;

/**
 * Dictation's own surface: the words as they are heard, where they will go, and Send. It is
 * separate from the conductor's status line because nothing here goes to the conductor.
 */
export const DictationPanel = observer(function DictationPanel() {
  const dictation = getDictationStore();
  const active = dictation.active;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dictation.cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, dictation]);

  if (!active) {
    if (!dictation.sentTo) return null;
    return (
      <p role="status" className="flex items-center gap-1.5 px-1 text-xs text-foreground-muted">
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        Dictation sent to {dictation.sentTo}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-blue-500/50 bg-blue-500/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-sm">
        <AudioLines className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          <Heading dictation={dictation} />
        </span>
        <button
          type="button"
          onClick={() => dictation.cancel()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        >
          <X className="size-3.5" />
          {dictation.phase === 'setup' ? 'Close' : 'Discard'}{' '}
          <span className="opacity-60">Esc</span>
        </button>
        {dictation.phase === 'listening' && (
          <button
            type="button"
            onClick={() => void dictation.finish()}
            className="flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90"
          >
            <SendHorizontal className="size-3.5" />
            Send <span className="opacity-60">tap Right Ctrl</span>
          </button>
        )}
        {dictation.phase === 'review' && dictation.text && (
          <button
            type="button"
            onClick={() => void dictation.send()}
            className="flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90"
          >
            <SendHorizontal className="size-3.5" />
            Send
          </button>
        )}
      </div>

      {dictation.phase === 'setup' ? (
        <ModelSetup dictation={dictation} />
      ) : (
        <LiveText text={dictation.text} listening={dictation.phase === 'listening'} />
      )}

      {dictation.error && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {dictation.error}
        </p>
      )}
    </div>
  );
});

const Heading = observer(function Heading({ dictation }: { dictation: DictationStore }) {
  const target = getConductorStore().dictationTarget();
  if (dictation.phase === 'setup') return <>Dictation runs on this computer</>;
  if (dictation.phase === 'finishing') {
    return (
      <span className="flex items-center gap-2 text-foreground-muted">
        <Loader2 className="size-3.5 animate-spin" />
        Sending{target ? ` to ${target}` : ''}…
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {dictation.phase === 'listening' && <LevelMeter level={dictation.level} />}
      {target ? (
        <>
          Dictating to <span className="font-medium">{target}</span>
        </>
      ) : (
        <span className="text-foreground-muted">No agent is open to dictate to</span>
      )}
    </span>
  );
});

/** The words so far. It follows the newest words, as a transcript does. */
function LiveText({ text, listening }: { text: string; listening: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <p
      ref={ref}
      aria-live="off"
      className="max-h-40 min-h-10 overflow-y-auto px-0.5 text-sm whitespace-pre-wrap text-foreground"
    >
      {text || (
        <span className="text-foreground-muted">{listening ? 'Listening…' : 'Nothing yet.'}</span>
      )}
    </p>
  );
}

const ModelSetup = observer(function ModelSetup({ dictation }: { dictation: DictationStore }) {
  const model = dictation.model;
  if (!model) {
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-muted">
        <Loader2 className="size-3.5 animate-spin" />
        Checking…
      </p>
    );
  }
  if (model.state === 'ready') {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <span className="min-w-0 flex-1">The speech model is ready.</span>
        <button
          type="button"
          onClick={() => {
            dictation.cancel();
            void dictation.start();
          }}
          className="rounded-md bg-foreground px-2 py-1 font-medium text-background hover:opacity-90"
        >
          Start dictating
        </button>
      </div>
    );
  }
  if (model.state === 'downloading') {
    const share = model.totalBytes > 0 ? model.receivedBytes / model.totalBytes : 0;
    return (
      <div className="space-y-1.5 text-xs text-foreground-muted">
        <div
          role="progressbar"
          aria-label="Downloading the speech model"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-background-secondary"
        >
          <div className="h-full bg-blue-600" style={{ width: `${share * 100}%` }} />
        </div>
        <p className="tabular-nums">
          Downloading the speech model: {megabytes(model.receivedBytes)} of{' '}
          {megabytes(model.totalBytes)} MB
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-xs text-foreground-muted">
      <p className="min-w-0 flex-1">
        {model.state === 'failed' && (
          <span className="text-amber-700 dark:text-amber-300">{model.message} </span>
        )}
        It needs NVIDIA’s Parakeet speech model, a one-time {megabytes(model.totalBytes)} MB
        download. After that your voice never leaves this computer.
      </p>
      <button
        type="button"
        onClick={() => void dictation.downloadModel()}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2 py-1 font-medium text-background hover:opacity-90"
      >
        <Download className="size-3.5" />
        {model.state === 'failed' ? 'Try again' : 'Download'}
      </button>
    </div>
  );
});

function megabytes(bytes: number): string {
  return Math.round(bytes / 1_000_000).toLocaleString();
}

function LevelMeter({ level }: { level: number }) {
  const bars = [0.55, 0.8, 1, 0.8, 0.55];
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {bars.map((weight, index) => (
        <span
          key={index}
          className="w-1 rounded-full bg-blue-600 transition-[height] duration-75"
          style={{ height: `${Math.max(3, Math.min(16, 3 + level * weight * 26))}px` }}
        />
      ))}
    </span>
  );
}
