import { Button, Spinner } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import { useHudClearance } from '../hud/hud-clearance';
import type { ChatConductorSession } from './session';
import { ChatHelpers } from './sub-agents';
import { composerPlaceholder } from './view/composer-placeholder';
import { ComposerTools, ConductorComposer } from './view/conductor-composer';
import { StateGlyph } from './view/status-strip';
import { ThreadBlocks } from './view/thread-blocks';
import { buildThreadView } from './view/thread-view';
import { useBusySince } from './view/use-busy-since';
import { useNow } from './view/use-now';
import { conductorVitals } from './view/vitals';
import { VitalsFooter } from './view/vitals-footer';

/**
 * The thread and the composer span the pane. Each sits in a box that keeps a scrollbar's width
 * free on both edges, so the thread's scrollbar never moves it off the composer's edges.
 */
const GUTTER = '[scrollbar-gutter:stable_both-edges]';
/**
 * Their shared column: a centred reading measure, with side padding that grows with the pane from
 * 16px in a narrow split to 48px in a wide one.
 */
const COLUMN =
  'mx-auto w-full max-w-[calc(45rem_+_2*clamp(1rem,4%,3rem))] px-[clamp(1rem,4%,3rem)]';
/** Closer to the end than this and the thread follows new entries. */
const FOLLOW_SLACK_PX = 64;

function openConductorSettings(): void {
  getNavigation().navigate(settingsViewDef({ tab: 'chorus' }));
}

/** Why the conductor cannot run, and where to fix it. */
function setupCopy(enabled: boolean): { title: string; description: string } {
  return enabled
    ? {
        title: 'The conductor needs an API key',
        description:
          "It reads this task's chats for you and can direct their agents. Add a key for the conductor in Settings, under Voice & Conductor. The Raw view works as always.",
      }
    : {
        title: 'Chat conductors are turned off',
        description:
          "A conductor reads this task's chats for you and can direct their agents. Turn it on in Settings, under Voice & Conductor. The Raw view works as always.",
      };
}

/** A centred title, one sentence and one action: the thread before anything is in it. */
function ConductorEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="flex max-w-lg flex-col items-center text-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
        <h2 className="text-2xl font-medium text-balance text-foreground">{title}</h2>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-balance text-foreground-muted">
          {description}
        </p>
        <div className="mt-6">{action}</div>
      </div>
    </div>
  );
}

export interface ChatConductorPanelProps {
  session: ChatConductorSession;
  /** Chat conductors can run a turn. */
  ready: boolean;
  /** The setting is on; with `ready` false, a key is what is missing. */
  enabled: boolean;
  /** Put the cursor in the composer when the panel shows. */
  autoFocus: boolean;
  onFocus?: () => void;
  /** Flips the chat to its Raw view. */
  onShowRaw: () => void;
  /**
   * Archives the task, which leaves its view. While a returned promise is pending, Done stays
   * disabled.
   */
  onDone: () => Promise<void> | void;
  /** Opens the merge dialog; null when the task cannot be integrated. */
  onMerge: (() => void) | null;
  /** Opens an address beside the view; only addresses `digestActions` let through reach it. */
  onOpenApp: (url: string) => void;
  /** The task's dev server origins, the addresses a report may open. */
  devServerOrigins: readonly string[];
  /** The agent of the chat on screen ("Claude"). */
  providerLabel: string | null;
  /** The Claude account that agent runs on, when there is more than one to tell apart. */
  accountLabel: string | null;
  /** The effort the conductor's turns run at. */
  conductorEffort: string | null;
  /** The task's diff size, drawn by the caller; nothing when it has none. */
  diffStat?: ReactNode;
}

/**
 * A task's thread with its conductor, as one calm reading column: the developer's words on the
 * right, the conductor's lines with the newest in large type, its reports in a fixed shape, and
 * what it did folded away. Under it one line of quiet facts and the composer.
 */
export const ChatConductorPanel = observer(function ChatConductorPanel({
  session,
  ready,
  enabled,
  autoFocus,
  onFocus,
  onShowRaw,
  onDone,
  onMerge,
  onOpenApp,
  devServerOrigins,
  providerLabel,
  accountLabel,
  conductorEffort,
  diffStat,
}: ChatConductorPanelProps) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** The developer is reading the end of the thread, so new entries scroll into view. */
  const followingRef = useRef(true);

  const { entries, busy, activity, loaded, draft, status } = session;
  const blocks = useMemo(() => buildThreadView(entries), [entries]);
  const busySince = useBusySince(busy);
  // Running clocks move every second; ages ("6m ago") only need a slower beat.
  const nowMs = useNow(busy || status?.state === 'needs_you' ? 1_000 : 15_000);
  const canSend = ready && loaded && draft.trim().length > 0;
  /** The setup screen stands in for the thread and the composer. */
  const needsSetup = !ready && entries.length === 0;
  // What the conductor bar, or a card raised from it, covers of this panel's bottom edge. The
  // composer keeps that much under it, so it rises above them and the thread gives up the room.
  const hudClearance = useHudClearance(panel);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followingRef.current) element.scrollTop = element.scrollHeight;
  }, [entries, busy, activity, loaded]);

  // The thread gets shorter when the composer grows or rises: keep its end in view then, too.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded, needsSetup]);

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus({ preventScroll: true });
  }, [autoFocus, loaded, ready]);

  const send = () => {
    if (!canSend) return;
    followingRef.current = true;
    session.send(draft);
    session.setDraft('');
  };

  const catchUp = () => {
    followingRef.current = true;
    session.catchUp();
  };

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-foreground-passive">
        <Spinner size="md" aria-label="Loading the thread" />
      </div>
    );
  }

  if (needsSetup) {
    return (
      <div className="h-full overflow-y-auto">
        <ConductorEmpty
          {...setupCopy(enabled)}
          action={
            <Button type="button" variant="secondary" size="sm" onClick={openConductorSettings}>
              Open settings
            </Button>
          }
        />
      </div>
    );
  }

  const last = entries.at(-1) ?? null;
  const vitals = conductorVitals({
    state: status?.state ?? null,
    busy,
    activity,
    busySinceMs: busySince,
    lastEntryAt: last?.at ?? null,
    lastEntryKind: last?.kind ?? null,
    nowMs,
    providerLabel,
    accountLabel,
    conductorEffort,
  });

  return (
    <div
      ref={setPanel}
      className="@container/conductor flex h-full min-h-0 flex-col"
      onFocus={onFocus}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className={cn('h-full overflow-y-auto', GUTTER)}
          onScroll={(event) => {
            const element = event.currentTarget;
            followingRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
          }}
        >
          {entries.length === 0 ? (
            busy ? (
              <div className="flex min-h-full items-center justify-center gap-2.5 px-6 text-sm text-foreground-muted">
                <StateGlyph glyph="working" />
                <span>Catching you up…</span>
              </div>
            ) : (
              <ConductorEmpty
                title="Nothing here yet"
                description="Tell the conductor what you want from this task, or ask it to catch you up on where things stand."
                action={
                  <Button type="button" variant="secondary" size="sm" onClick={catchUp}>
                    Catch me up
                  </Button>
                }
              />
            )
          ) : (
            <div className={cn(COLUMN, 'flex flex-col gap-6 pt-8 pb-10')} aria-live="polite">
              <ThreadBlocks
                blocks={blocks}
                nowMs={nowMs}
                devServerOrigins={devServerOrigins}
                onDone={onDone}
                onMerge={onMerge}
                onOpenApp={onOpenApp}
                onShowRaw={onShowRaw}
              />
              {busy && (
                // Where the conductor's next words will appear; what it is doing is in the footer.
                <div aria-hidden className="mt-4 flex h-7 items-center">
                  <StateGlyph glyph="working" />
                </div>
              )}
            </div>
          )}
        </div>
        {/* The thread fades into the strip above and the footer below instead of being cut. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 right-2 left-0 h-5 bg-linear-to-b from-(--em-surface) to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute right-2 bottom-0 left-0 h-8 bg-linear-to-t from-(--em-surface) to-transparent"
        />
      </div>

      <div className={cn('shrink-0 overflow-hidden', GUTTER)}>
        <div
          className={cn(
            COLUMN,
            'pt-1 motion-safe:transition-[padding-bottom] motion-safe:duration-150 motion-safe:ease-out'
          )}
          style={{ paddingBottom: `max(0.75rem, ${hudClearance}px)` }}
        >
          <div className="mb-1.5">
            {ready ? (
              <VitalsFooter
                vitals={vitals}
                onStop={busy ? () => session.stop() : null}
                helpers={<ChatHelpers conversationIds={session.chatIds} />}
                diffStat={diffStat}
              />
            ) : (
              <div className="flex h-6 min-w-0 items-center gap-1.5 text-tiny text-foreground-warning">
                <span className="min-w-0 truncate">
                  {enabled
                    ? 'The conductor has no API key, so it cannot run.'
                    : 'Chat conductors are turned off, so this one is not following the task.'}
                </span>
                <button
                  type="button"
                  onClick={openConductorSettings}
                  className="shrink-0 rounded-sm text-foreground-muted underline decoration-foreground-passive/60 underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Open settings
                </button>
              </div>
            )}
          </div>
          <ConductorComposer
            textareaRef={composerRef}
            value={draft}
            placeholder={composerPlaceholder({ ready, busy, state: status?.state ?? null })}
            disabled={!ready}
            canSend={canSend}
            onChange={(text) => session.setDraft(text)}
            onSend={send}
          />
          <ComposerTools
            ready={ready}
            autonomy={session.autonomy}
            onAutonomyChange={(on) => session.setAutonomy(on)}
            onCatchUp={catchUp}
            canClear={entries.length > 0 || busy}
            onClear={() => void session.reset()}
          />
        </div>
      </div>
    </div>
  );
});
