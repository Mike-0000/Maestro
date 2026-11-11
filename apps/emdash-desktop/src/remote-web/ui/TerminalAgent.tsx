import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { ArrowDown, ALargeSmall, Check, Minus, Plus, RotateCw, Smartphone, X } from 'lucide-react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { agentGroupOf } from '../lib/agent-groups';
import { TERMINAL_FONT_FAMILY } from '../lib/terminal-theme';
import type { RemoteApi } from '../lib/wire-link';
import { TerminalSession } from '../state/terminal-session';
import { useApp } from './app-context';
import { Composer } from './Composer';
import { Button, IconButton, Spinner, TextAction } from './controls';
import { cx, useIsWide, useThemeVersion } from './hooks';
import { KeyBar } from './KeyBar';
import { Notice, ScreenFrame } from './ScreenFrame';
import { Sheet } from './Sheet';
import { StateMark } from './StatusIndicator';
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
          <ALargeSmall className="size-5" aria-hidden="true" />
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
          <div className="animate-delayed-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface text-foreground-muted">
            <Spinner className="size-5 text-foreground-passive" />
            <p className="text-detail">
              {agent.running ? 'Connecting to the agent…' : 'Starting the agent…'}
            </p>
          </div>
        ) : null}
        {failed ? (
          <div className="absolute inset-0 flex bg-surface">
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
              'surface-elevated animate-pop-in absolute bottom-3 flex h-11 items-center gap-1.5 rounded-full border border-border-subtle bg-surface pr-4 pl-3 text-detail font-medium text-foreground shadow-float',
              // On a phone the mic floats in the corner; sit beside it.
              wide ? 'right-3' : 'right-[4.25rem]'
            )}
          >
            <ArrowDown className="size-4" aria-hidden="true" />
            Latest
          </button>
        ) : null}
        {/* A wide screen has the mic in the list column. */}
        {wide ? null : <VoiceFab size="compact" className="right-3 bottom-3" />}
      </div>

      {/* Always laid out, so the terminal area has its final height before the session opens.
          Window chrome, like the desktop's terminal strip: the sunken surface, no rule. */}
      <div
        inert={!live}
        className={cx(
          'terminal-dock surface-sunken px-safe shrink-0 bg-surface pt-1 transition-opacity duration-200',
          !live && 'opacity-40'
        )}
      >
        {stopped ? (
          <div className="flex items-center gap-3 py-1.5 pr-3 pl-4">
            <p className="text-detail min-w-0 flex-1 text-foreground-muted">
              This agent’s session has ended.
            </p>
            <Button variant="primary" className="px-4" onClick={() => void session?.open()}>
              Resume
            </Button>
          </div>
        ) : needsAttention && agent.message ? (
          <div role="status" className="flex items-start gap-2.5 px-4 pt-2 pb-1">
            <StateMark state="needs-you" className="mt-px" />
            <p className="text-detail line-clamp-3 min-w-0 break-words text-foreground">
              {agent.message}
            </p>
          </div>
        ) : null}
        {showSmallTextHint ? (
          <div className="flex items-center gap-3 pr-1 pl-4">
            <p className="text-detail min-w-0 flex-1 text-foreground-muted">
              Small text? Pinch to zoom, or fit the terminal to this screen.
            </p>
            <TextAction className="text-detail shrink-0" onClick={() => setDisplayOpen(true)}>
              Display
            </TextAction>
            <IconButton
              label="Dismiss"
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
      <div className="flex flex-col gap-8 pb-2">
        <section aria-labelledby="display-text-size">
          <h3 id="display-text-size" className="text-body font-semibold text-foreground">
            Text size
          </h3>
          <div className="mt-3 flex items-center gap-2">
            <div className="flex h-11 flex-1 items-center rounded-md bg-surface-emphasis">
              <IconButton label="Smaller text" onClick={() => session.zoomBy(-1)} className="w-12">
                <Minus className="size-5" aria-hidden="true" />
              </IconButton>
              <output
                aria-live="polite"
                className="text-body flex-1 text-center text-foreground tabular-nums"
              >
                {Math.round(session.fontSize * 10) / 10} px
              </output>
              <IconButton label="Larger text" onClick={() => session.zoomBy(1)} className="w-12">
                <Plus className="size-5" aria-hidden="true" />
              </IconButton>
            </div>
            <Button
              variant="secondary"
              aria-pressed={fitted}
              className={cx(fitted && 'bg-surface-selected')}
              onClick={() => session.setZoom('fit')}
            >
              {fitted ? <Check className="size-4" aria-hidden="true" /> : null}
              Fit width
            </Button>
          </div>
          <p className="text-detail mt-2 text-foreground-muted">
            Fit width shows every column. Pinch the terminal to zoom, then drag sideways to pan.
          </p>
        </section>

        <section aria-labelledby="display-size">
          <h3 id="display-size" className="text-body font-semibold text-foreground">
            Terminal size
          </h3>
          <p className="text-body mt-1 text-foreground-muted">
            {grid ? (
              <>
                <span className="text-foreground tabular-nums">
                  {grid.cols} × {grid.rows}
                </span>
                , the size it has on {app.hostName}.
              </>
            ) : (
              <>Shared with {app.hostName}.</>
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
            {session.resizing ? null : <Smartphone className="size-4" aria-hidden="true" />}
            Fit to this screen
          </Button>
          <p className="text-detail mt-2 text-foreground-muted">
            Makes the text comfortable to read here by resizing the terminal itself. It changes size
            in Maestro on your computer too.
          </p>
        </section>
      </div>
    </Sheet>
  );
});
