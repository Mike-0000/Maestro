import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Kbd, Spinner } from '@emdash/ui/react/primitives';
import { AudioLines, Download, SendHorizontal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { getDictationStore } from '@core/features/voice/contributions/browser/app-stores';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { HudCard, HudCardHeader, LevelMeter } from './hud-card';

type DictationStore = ReturnType<typeof getDictationStore>;

/**
 * Dictation's own surface: the words as they are heard, where they will go, and Send. It is
 * separate from the conductor's status line because nothing here goes to a conductor: it goes to
 * the agent in front, even when that chat's Conductor view is on screen.
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
      <HudCard role="status" className="flex w-auto items-center gap-2 rounded-lg py-2">
        <StateGlyph state="done" size="sm" />
        <span className="text-xs text-foreground-muted">
          Dictation sent to <span className="text-foreground">{dictation.sentTo}</span>
        </span>
      </HudCard>
    );
  }

  return (
    <HudCard label="Dictation">
      <HudCardHeader
        glyph={
          dictation.phase === 'finishing' ? (
            <Spinner size="sm" className="text-foreground-passive" />
          ) : (
            <AudioLines aria-hidden className="size-3.5 text-foreground-muted" />
          )
        }
        title={<Heading dictation={dictation} />}
        meta={dictation.phase === 'listening' ? <LevelMeter level={dictation.level} /> : undefined}
        actions={
          <>
            <span className="flex items-center gap-1.5">
              <Button type="button" variant="text" size="xs" onClick={() => dictation.cancel()}>
                {dictation.phase === 'setup' ? 'Close' : 'Discard'}
              </Button>
              <Kbd>Esc</Kbd>
            </span>
            {dictation.phase === 'listening' && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                title="Send: tap Right Ctrl, or press Send"
                onClick={() => void dictation.finish()}
              >
                <SendHorizontal aria-hidden className="size-3.5" />
                Send <Kbd>Right Ctrl</Kbd>
              </Button>
            )}
            {dictation.phase === 'review' && dictation.text && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void dictation.send()}
              >
                <SendHorizontal aria-hidden className="size-3.5" />
                Send
              </Button>
            )}
          </>
        }
      />

      <div className="mt-1.5 pl-6">
        {dictation.phase === 'setup' ? (
          <ModelSetup dictation={dictation} />
        ) : (
          <LiveText text={dictation.text} listening={dictation.phase === 'listening'} />
        )}

        {dictation.error && (
          <p role="alert" className="mt-1.5 text-xs text-foreground-warning">
            {dictation.error}
          </p>
        )}
      </div>
    </HudCard>
  );
});

const Heading = observer(function Heading({ dictation }: { dictation: DictationStore }) {
  const target = getConductorStore().dictationTarget();
  if (dictation.phase === 'setup') return <>Dictation runs on this computer</>;
  if (dictation.phase === 'finishing') {
    return (
      <span className="font-normal text-foreground-muted">
        Sending{target ? ` to ${target}` : ''}…
      </span>
    );
  }
  return target ? (
    <>
      <span className="font-normal">Dictating to</span> {target}
    </>
  ) : (
    <span className="font-normal text-foreground-muted">No agent is open to dictate to</span>
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
      className="max-h-40 min-h-10 overflow-y-auto text-sm whitespace-pre-wrap text-foreground"
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
        <Spinner size="sm" className="text-foreground-passive" />
        Checking…
      </p>
    );
  }
  if (model.state === 'ready') {
    return (
      <div className="flex items-center gap-3 text-xs text-foreground-muted">
        <span className="min-w-0 flex-1">The speech model is ready.</span>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            dictation.cancel();
            void dictation.start();
          }}
        >
          Start dictating
        </Button>
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
          className="h-1 overflow-hidden rounded-full bg-surface-selected"
        >
          <div
            className="h-full rounded-full bg-foreground-muted"
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <p className="tabular-nums">
          Downloading the speech model: {megabytes(model.receivedBytes)} of{' '}
          {megabytes(model.totalBytes)} MB
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 text-xs text-foreground-muted">
      <p className="min-w-0 flex-1">
        {model.state === 'failed' && (
          <span className="text-foreground-warning">{model.message} </span>
        )}
        It needs the Parakeet speech model, a one-time {megabytes(model.totalBytes)} MB download.
        After that your voice never leaves this computer.
      </p>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => void dictation.downloadModel()}
      >
        <Download aria-hidden className="size-3.5" />
        {model.state === 'failed' ? 'Try again' : 'Download'}
      </Button>
    </div>
  );
});

function megabytes(bytes: number): string {
  return Math.round(bytes / 1_000_000).toLocaleString();
}
