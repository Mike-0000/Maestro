import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { ArrowDown, ALargeSmall, Minus, Plus, RotateCw, Smartphone, X } from 'lucide-react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { agentGroupOf } from '../lib/agent-groups';
import { TERMINAL_FONT_FAMILY } from '../lib/terminal-theme';
import type { RemoteApi } from '../lib/wire-link';
import { TerminalSession } from '../state/terminal-session';
import { useApp } from './app-context';
import { Composer } from './Composer';
import { Button, IconButton, Spinner } from './controls';
import { cx, useIsWide, useThemeVersion } from './hooks';
import { KeyBar } from './KeyBar';
import { Notice, ScreenFrame } from './ScreenFrame';
import { Sheet } from './Sheet';
import { VoiceFab } from './VoiceMic';

const FONT_LOAD_TIMEOUT_MS = 1_200;
/** Below this fitted size the text is hard to read, and the screen says what can be done. */
const SMALL_TEXT_PX = 7.5;
/** Once dismissed, the small-text hint stays away until the app is reopened. */
let smallTextHintDismissed = false;

/** Resolves once the terminal face is usable, so xterm measures the right glyphs. */
function terminalFontReady(): Promise<void> {
  const loading = document.fonts
    .load(`12px ${TERMINAL_FONT_FAMILY}`)
    .then(() => undefined)
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_LOAD_TIMEOUT_MS));
  return Promise.race([loading, timeout]);
}

/** A terminal agent: its live terminal, the keys a phone lacks, and a composer for prompts. */
export const TerminalAgent = observer(function TerminalAgent({
  agent,
  api,
}: {
  agent: RemoteAgent;
  api: RemoteApi;
}) {
  const app = useApp();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(smallTextHintDismissed);
  const themeVersion = useThemeVersion();
  const wide = useIsWide();
  const conversationId = agent.conversationId;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let active = true;
    let created: TerminalSession | null = null;
    void terminalFontReady().then(() => {
      if (!active) return;
      created = new TerminalSession({
        api,
        conversationId,
        viewport,
        onError: (message) => app.toast(message, 'error'),
      });
      setSession(created);
    });
    return () => {
      active = false;
      created?.dispose();
      setSession(null);
    };
  }, [api, app, conversationId]);

  useEffect(() => {
    session?.refreshTheme();
  }, [session, themeVersion]);

  // The desktop window can resize the shared terminal while this screen is away or offline.
  useEffect(() => {
    if (!session) return;
    const sync = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (app.agentById(conversationId)?.running) void session.syncGrid();
    };
    document.addEventListener('visibilitychange', sync);
    const stop = reaction(
      () => app.linkStatus,
      (status, previous) => {
        if (status === 'online' && previous === 'reconnecting') sync();
      }
    );
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stop();
    };
  }, [app, conversationId, session]);

  const live = session?.phase === 'live';
  const failed = session?.phase === 'failed';
  const needsAttention = agentGroupOf(agent) === 'attention';
  const stopped = live && !agent.running;
  const showSmallTextHint =
    live && !hintDismissed && session.zoom === 'fit' && session.fontSize < SMALL_TEXT_PX;

  return (
    <ScreenFrame
      title={agent.taskName}
      agent={agent}
      actions={
        <IconButton
          label="Display options"
          disabled={!live}
          onClick={() => setDisplayOpen(true)}
          aria-haspopup="dialog"
        >
          <ALargeSmall className="size-[22px]" aria-hidden="true" />
        </IconButton>
      }
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          className={cx('terminal-viewport h-full w-full', !live && 'invisible')}
          onClick={() => {
            // A mouse click focuses the terminal for typing; on touch, the composer is the input.
            if (window.matchMedia('(pointer: fine)').matches) session?.focus();
          }}
        />
        {!session || session.phase === 'opening' ? (
          <div className="bg-terminal text-fg-muted absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Spinner className="size-5" />
            <p className="text-[14px]">
              {agent.running ? 'Connecting to the agent…' : 'Starting the agent…'}
            </p>
          </div>
        ) : null}
        {failed ? (
          <div className="bg-canvas absolute inset-0 flex">
            <Notice
              title="Couldn’t open this agent"
              body={session.error ?? 'The host did not respond.'}
              action={
                <Button variant="primary" onClick={() => void session.open()}>
                  <RotateCw className="size-4" aria-hidden="true" />
                  Try again
                </Button>
              }
            />
          </div>
        ) : null}
        {live && session.scrolledBack ? (
          <button
            type="button"
            onClick={() => session.jumpToLatest()}
            className={cx(
              'animate-pop-in border-line-strong bg-raised text-fg absolute bottom-3 flex h-9 items-center gap-1.5 rounded-full border pr-3.5 pl-2.5 text-[13px] font-medium shadow-lg shadow-black/25',
              // On a phone the mic floats in the corner; sit beside it.
              wide ? 'right-3' : 'right-[4.5rem] bottom-[1.125rem]'
            )}
          >
            <ArrowDown className="size-4" aria-hidden="true" />
            Latest
          </button>
        ) : null}
        {/* A wide screen has the mic in the list column. */}
        {wide ? null : <VoiceFab size="compact" className="right-3 bottom-3" />}
      </div>

      {/* Always laid out, so the terminal area has its final height before the session opens. */}
      <div
        inert={!live}
        className={cx(
          'shrink-0 border-t border-line bg-canvas px-safe transition-opacity duration-200',
          !live && 'opacity-40'
        )}
      >
        {stopped ? (
          <div className="border-line flex items-center gap-3 border-b px-4 py-2.5">
            <p className="text-fg-muted min-w-0 flex-1 text-[13.5px]">
              This agent’s session has ended.
            </p>
            <Button
              variant="secondary"
              className="h-9 px-3.5 text-[14px]"
              onClick={() => void session?.open()}
            >
              Resume
            </Button>
          </div>
        ) : needsAttention && agent.message ? (
          <div
            role="status"
            className="border-attention-line/50 bg-attention-soft flex items-start gap-2.5 border-b px-4 py-2.5"
          >
            <span
              aria-hidden="true"
              className="bg-attention mt-[7px] size-2 shrink-0 rounded-full"
            />
            <p className="text-fg line-clamp-3 min-w-0 text-[13.5px] leading-snug">
              {agent.message}
            </p>
          </div>
        ) : null}
        {showSmallTextHint ? (
          <div className="border-line flex items-center gap-2 border-b py-1.5 pr-1.5 pl-4">
            <p className="text-fg-muted min-w-0 flex-1 text-[13px] leading-snug">
              Small text? Pinch to zoom, or fit the terminal to this screen.
            </p>
            <Button
              variant="secondary"
              className="h-8 shrink-0 rounded-lg px-3 text-[13px]"
              onClick={() => setDisplayOpen(true)}
            >
              Display
            </Button>
            <IconButton
              label="Dismiss"
              className="size-8"
              onClick={() => {
                smallTextHintDismissed = true;
                setHintDismissed(true);
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        ) : null}
        <KeyBar
          showReplies={needsAttention}
          onKey={(key) => session?.sendKey(key)}
          onText={(text) => session?.send(text)}
        />
        <Composer
          placeholder={needsAttention ? 'Reply to the agent…' : 'Message the agent…'}
          draftKey={conversationId}
          onSubmit={(text) => session?.submitPrompt(text) ?? Promise.resolve(false)}
        />
      </div>

      {displayOpen && session ? (
        <DisplaySheet session={session} onClose={() => setDisplayOpen(false)} />
      ) : null}
    </ScreenFrame>
  );
});

const DisplaySheet = observer(function DisplaySheet({
  session,
  onClose,
}: {
  session: TerminalSession;
  onClose(): void;
}) {
  const app = useApp();
  const fitted = session.zoom === 'fit';
  const grid = session.grid;
  return (
    <Sheet title="Display" onClose={onClose}>
      <div className="flex flex-col gap-6 pb-2">
        <section aria-labelledby="display-text-size">
          <h3 id="display-text-size" className="text-fg-muted text-[13px] font-medium">
            Text size
          </h3>
          <div className="mt-2 flex items-center gap-2">
            <div className="bg-surface-2 flex h-11 flex-1 items-center rounded-xl">
              <IconButton
                label="Smaller text"
                onClick={() => session.zoomBy(-1)}
                className="h-11 w-12 rounded-xl"
              >
                <Minus className="size-5" aria-hidden="true" />
              </IconButton>
              <output
                aria-live="polite"
                className="flex-1 text-center text-[15px] font-medium tabular-nums"
              >
                {Math.round(session.fontSize * 10) / 10} px
              </output>
              <IconButton
                label="Larger text"
                onClick={() => session.zoomBy(1)}
                className="h-11 w-12 rounded-xl"
              >
                <Plus className="size-5" aria-hidden="true" />
              </IconButton>
            </div>
            <Button
              variant={fitted ? 'primary' : 'secondary'}
              aria-pressed={fitted}
              onClick={() => session.setZoom('fit')}
            >
              Fit width
            </Button>
          </div>
          <p className="text-fg-passive mt-2 text-[13px] leading-snug">
            Fit width shows every column. Pinch the terminal to zoom, then drag sideways to pan.
          </p>
        </section>

        <section aria-labelledby="display-size">
          <h3 id="display-size" className="text-fg-muted text-[13px] font-medium">
            Terminal size
          </h3>
          <div className="border-line bg-canvas mt-2 rounded-2xl border p-4">
            <p className="text-[14.5px]">
              {grid ? (
                <>
                  <span className="font-semibold tabular-nums">
                    {grid.cols} × {grid.rows}
                  </span>{' '}
                  <span className="text-fg-muted">— the size it has on {app.hostName}.</span>
                </>
              ) : (
                <span className="text-fg-muted">Shared with {app.hostName}.</span>
              )}
            </p>
            <Button
              variant="secondary"
              block
              busy={session.resizing}
              className="mt-3"
              onClick={() => {
                void session.fitToScreen().then((done) => {
                  if (done) onClose();
                });
              }}
            >
              {session.resizing ? null : <Smartphone className="size-[18px]" aria-hidden="true" />}
              Fit to this screen
            </Button>
            <p className="text-fg-passive mt-2.5 text-[13px] leading-snug">
              Makes the text comfortable to read here by resizing the terminal itself. It changes
              size in Maestro on your computer too.
            </p>
          </div>
        </section>
      </div>
    </Sheet>
  );
});
