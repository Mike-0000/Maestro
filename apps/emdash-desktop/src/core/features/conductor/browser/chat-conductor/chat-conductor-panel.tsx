import { EmptyState, Markdown } from '@emdash/ui/react/components';
import {
  Button,
  DropdownMenu,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
} from '@emdash/ui/react/primitives';
import {
  ChevronRight,
  CircleAlert,
  CircleSlash,
  CornerDownLeft,
  Ellipsis,
  Hand,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ChatConductorEntry } from '../../api/chat-conductor/thread';
import { withoutImages } from './safe-markdown';
import type { ChatConductorSession } from './session';

/** The thread reads as a column of text, not a full-width log. */
const COLUMN = 'mx-auto w-full max-w-[46rem] px-5';
/** Closer to the end than this and the thread follows new entries. */
const FOLLOW_SLACK_PX = 64;

type ActionEntry = Extract<ChatConductorEntry, { kind: 'action' }>;

const ACTION_ICONS: Record<string, LucideIcon> = {
  send_to_agent: Send,
  interrupt_agent: Hand,
  answer_prompt: ShieldCheck,
  start_agent: Plus,
};

function entryTime(at: string): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

const ConductorMessage = observer(function ConductorMessage({ text }: { text: string }) {
  const openLink = useMarkdownLinkOpener();
  return (
    <div className="min-w-0 text-sm leading-relaxed text-foreground select-text">
      <Markdown content={withoutImages(text)} variant="compact" onOpenLink={openLink} />
    </div>
  );
});

function DeveloperMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-background-2 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">
        {text}
      </div>
    </div>
  );
}

/** What the conductor did: one quiet line, opening to the exact text it sent. */
function ActionRow({ entry }: { entry: ActionEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = entry.status === 'refused' ? CircleSlash : (ACTION_ICONS[entry.tool] ?? Send);
  const tone =
    entry.status === 'failed'
      ? 'text-foreground-error'
      : entry.status === 'refused'
        ? 'text-foreground-warning'
        : 'text-foreground-muted';
  const line = (
    <>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 text-left break-words">{entry.summary}</span>
    </>
  );
  if (!entry.detail) {
    return <div className={cn('flex items-start gap-2 text-xs', tone)}>{line}</div>;
  }
  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          '-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-background-1 focus-visible:bg-background-1',
          tone
        )}
      >
        {line}
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && (
        <pre className="mt-1 ml-[1.375rem] max-h-80 overflow-auto rounded-md border border-border bg-background-1 px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">
          {entry.detail}
        </pre>
      )}
    </div>
  );
}

function EventDivider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-foreground-passive" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ErrorRow({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-border-destructive bg-background-destructive px-3 py-2 text-sm text-foreground-destructive select-text"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{text}</span>
    </div>
  );
}

function ThreadEntry({ entry }: { entry: ChatConductorEntry }) {
  switch (entry.kind) {
    case 'conductor':
      return <ConductorMessage text={entry.text} />;
    case 'developer':
      return <DeveloperMessage text={entry.text} />;
    case 'action':
      return <ActionRow entry={entry} />;
    case 'event':
      return <EventDivider text={entry.text} />;
    case 'error':
      return <ErrorRow text={entry.text} />;
  }
}

function openConductorSettings(): void {
  getNavigation().navigate(settingsViewDef({ tab: 'chorus' }));
}

/** Why the conductor cannot run, and where to fix it. */
function setupCopy(enabled: boolean): { label: string; description: string } {
  return enabled
    ? {
        label: 'The chat conductor needs an API key',
        description:
          'It reads this chat for you and can direct the agent. Add a key for the conductor in Settings, under Voice & Conductor. The Raw view works as always.',
      }
    : {
        label: 'Chat conductors are turned off',
        description:
          'A chat conductor reads this chat for you and can direct the agent. Turn it on in Settings, under Voice & Conductor. The Raw view works as always.',
      };
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
}

/**
 * A chat's thread with its conductor: what the conductor told the developer and what it did, and
 * the composer the developer directs it from.
 */
export const ChatConductorPanel = observer(function ChatConductorPanel({
  session,
  ready,
  enabled,
  autoFocus,
  onFocus,
}: ChatConductorPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** The developer is reading the end of the thread, so new entries scroll into view. */
  const followingRef = useRef(true);

  const { entries, busy, activity, loaded, draft } = session;
  const canSend = ready && loaded && draft.trim().length > 0;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followingRef.current) element.scrollTop = element.scrollHeight;
  }, [entries, busy, activity, loaded]);

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus({ preventScroll: true });
  }, [autoFocus, loaded, ready]);

  const send = () => {
    if (!canSend) return;
    followingRef.current = true;
    session.send(draft);
    session.setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-foreground-muted">
        <Spinner size="md" aria-label="Loading the thread" />
      </div>
    );
  }

  if (!ready && entries.length === 0) {
    return (
      <EmptyState
        {...setupCopy(enabled)}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={openConductorSettings}>
            Open settings
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onFocus={onFocus}>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          followingRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        {entries.length === 0 && !busy ? (
          <EmptyState
            bare
            label="Nothing here yet"
            description="Write to the conductor to direct this chat's agent, or ask it to catch you up on where the chat stands."
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => session.catchUp()}>
                Catch me up
              </Button>
            }
          />
        ) : (
          <div className={cn(COLUMN, 'flex flex-col gap-4 py-5')} aria-live="polite">
            {entries.map((entry) => (
              <div key={entry.id} title={entryTime(entry.at)}>
                <ThreadEntry entry={entry} />
              </div>
            ))}
            {busy && (
              <div className="flex min-h-6 items-center gap-2 text-xs text-foreground-muted">
                <Spinner size="sm" />
                <span className="min-w-0 flex-1 truncate">{activity ?? 'Working…'}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => session.stop()}>
                  Stop
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={cn(COLUMN, 'shrink-0 pt-1 pb-3')}>
        {!ready && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border-warning bg-background-warning px-3 py-1.5 text-xs text-foreground-warning">
            <span className="min-w-0 flex-1">
              {enabled
                ? 'The conductor has no API key, so it cannot run.'
                : 'Chat conductors are turned off, so this one is not following the chat.'}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={openConductorSettings}>
              Open settings
            </Button>
          </div>
        )}
        <Textarea
          ref={composerRef}
          value={draft}
          rows={2}
          disabled={!ready}
          aria-label="Message the conductor"
          placeholder={
            busy
              ? 'Write to the conductor. It is sent when this turn ends.'
              : 'Tell the conductor what you want from this chat'
          }
          className="max-h-60 w-full resize-none text-sm"
          onChange={(event) => session.setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mt-1.5 flex items-center gap-1">
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span className="flex h-6 items-center gap-2 rounded-md px-1 text-xs text-foreground-muted" />
              }
            >
              <Switch
                size="sm"
                checked={session.autonomy}
                onCheckedChange={(on) => session.setAutonomy(on)}
                aria-label="Act on my behalf"
              />
              <span
                className="cursor-pointer select-none"
                onClick={() => session.setAutonomy(!session.autonomy)}
              >
                Act on my behalf
              </span>
            </Tooltip.Trigger>
            <Tooltip.Content side="top" align="start" className="max-w-xs">
              On: when the agent finishes or asks something while you are away, the conductor may
              prompt it, answer it or interrupt it, within what you asked for. Off: it only tells
              you what happened and what it would do. What you ask for directly is always done.
            </Tooltip.Content>
          </Tooltip.Root>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!ready}
            onClick={() => {
              followingRef.current = true;
              session.catchUp();
            }}
          >
            Catch me up
          </Button>
          <span className="flex-1" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              render={
                <Button type="button" variant="ghost" size="xs" icon aria-label="Thread options" />
              }
            >
              <Ellipsis aria-hidden />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" side="top" width="content">
              <DropdownMenu.Item
                variant="destructive"
                disabled={entries.length === 0 && !busy}
                onClick={() => void session.reset()}
              >
                <Trash2 aria-hidden />
                Clear thread
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <Button type="button" variant="primary" size="xs" disabled={!canSend} onClick={send}>
            Send
            <CornerDownLeft aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
});
