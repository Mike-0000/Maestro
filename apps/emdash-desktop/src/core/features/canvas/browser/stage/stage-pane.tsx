import { Globe, Play, SendHorizontal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { MarkdownDocView } from '@core/features/markdown-viewer/contributions/browser/markdown-doc-view';
import { log } from '@core/primitives/logging/browser/logger';
import { windowKindOf } from '../../api/canvas-regions';
import { getCanvasBrowserHost, getCanvasStore } from '../../contributions/browser/app-stores';
import { AgentAcpLive } from '../tiles/agent-acp';
import { AgentTerminal, TerminalPlaceholder } from '../tiles/agent-terminal';

/** A window's live content on the stage: always at 100 % and interactive. */
export const StagePaneContent = observer(function StagePaneContent({
  tileId,
  active,
  placement,
}: {
  tileId: string;
  active: boolean;
  /** Changes whenever the pane moves or resizes (browser surfaces follow it). */
  placement: string;
}) {
  switch (windowKindOf(tileId)) {
    case 'browser':
      return <StageBrowserPane tileId={tileId} placement={placement} />;
    case 'doc':
      return <StageDocPane tileId={tileId} />;
    case 'note':
      return <StageNotePane tileId={tileId} />;
    default:
      return <StageAgentPane tileId={tileId} active={active} />;
  }
});

const StageAgentPane = observer(function StageAgentPane({
  tileId,
  active,
}: {
  tileId: string;
  active: boolean;
}) {
  const store = getCanvasStore();
  const entry = store.entryForTile(tileId);
  if (!entry) return <TerminalPlaceholder label="This agent is gone." />;
  if (!store.shouldAttach(entry)) {
    if (store.startRequested.has(entry.conversationId)) {
      return <TerminalPlaceholder label="Starting agent…" />;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-(--xterm-bg)">
        <span className="text-xs text-foreground-muted">
          {entry.taskProvisioned ? 'This agent is not running.' : 'This task workspace is asleep.'}
        </span>
        <button
          type="button"
          onClick={() => store.resumeAgent(entry)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-secondary"
        >
          <Play className="size-3.5" />
          Resume agent
        </button>
      </div>
    );
  }
  if (entry.type === 'acp') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <AgentAcpLive entry={entry} interactive onActivate={() => undefined} />
        </div>
        <AcpReplyBox entry={entry} />
      </div>
    );
  }
  return (
    <AgentTerminal
      entry={entry}
      hydrate={!entry.sessionActive && store.startRequested.has(entry.conversationId)}
      interactive
      autoFocus={active}
      onActivate={() => undefined}
      onReleaseFocus={() => undefined}
    />
  );
});

/** A one-line prompt box under a chat agent's transcript (the full composer lives in its task). */
const AcpReplyBox = observer(function AcpReplyBox({ entry }: { entry: AgentTileEntry }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      const client = await getConversationsClient();
      const result = await client.acp.sendPrompt(
        {
          conversationId: entry.conversationId,
          promptId: crypto.randomUUID(),
          prompt: { text: prompt },
          placement: 'auto',
        },
        { timeoutMs: 0 }
      );
      if (result.success) setText('');
    } catch (error: unknown) {
      log.warn('canvas stage: prompt failed', { error });
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder={`Message ${getCanvasStore().spokenName(entry.conversationId)}…`}
        aria-label="Message this agent"
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background-secondary px-2 text-xs text-foreground outline-none focus:border-blue-500/60"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!text.trim() || sending}
        className="flex size-7 items-center justify-center rounded-md text-foreground-muted hover:bg-background-secondary hover:text-foreground disabled:opacity-40"
      >
        <SendHorizontal className="size-3.5" />
      </button>
    </form>
  );
});

/**
 * An app browser on the stage: the real webview is placed over this pane, always live. The board's
 * tile stops placing it while the stage is open.
 */
const StageBrowserPane = observer(function StageBrowserPane({
  tileId,
  placement,
}: {
  tileId: string;
  placement: string;
}) {
  const store = getCanvasStore();
  const host = getCanvasBrowserHost();
  const entry = store.browserEntries.find((candidate) => candidate.tileId === tileId);
  const browserId = entry?.browserId;
  const pageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (browserId) host.ensureAlive(browserId);
  }, [browserId, host]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!browserId || !page) return;
    const place = () => {
      const rect = page.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        host.placeSurface(browserId, null);
        return;
      }
      host.placeSurface(browserId, {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        live: true,
        holes: [],
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(page);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      host.placeSurface(browserId, null);
    };
  }, [browserId, host, placement]);

  if (!entry) return <TerminalPlaceholder label="This app browser is closed." />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-[11px] text-foreground-muted">
        <Globe className="size-3.5 shrink-0" />
        <span className="truncate">{entry.url}</span>
      </div>
      <div ref={pageRef} className="relative min-h-0 flex-1 bg-background-secondary">
        {!host.isAlive(entry.browserId) && (
          <div className="flex h-full items-center justify-center text-xs text-foreground-muted">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
});

const StageDocPane = observer(function StageDocPane({ tileId }: { tileId: string }) {
  const doc = getCanvasStore().docEntries.find((entry) => entry.tileId === tileId);
  if (!doc) return <TerminalPlaceholder label="This document is closed." />;
  return <MarkdownDocView key={`${doc.workspaceId}:${doc.path}`} doc={doc} />;
});

const StageNotePane = observer(function StageNotePane({ tileId }: { tileId: string }) {
  const store = getCanvasStore();
  const note = store.noteEntries.find((entry) => entry.tileId === tileId);
  if (!note) return null;
  return (
    <textarea
      key={note.noteId}
      className="h-full w-full resize-none bg-amber-50 p-4 text-base text-foreground outline-none dark:bg-amber-950/40"
      defaultValue={note.text}
      placeholder="Write a goal, a plan, or a prompt…"
      onBlur={(event) => store.updateNote(note.noteId, { text: event.currentTarget.value })}
    />
  );
});
