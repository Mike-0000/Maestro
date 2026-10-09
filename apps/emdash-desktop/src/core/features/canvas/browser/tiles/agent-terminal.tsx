import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef } from 'react';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { PaneSizingContextProvider } from '@core/features/terminals/contributions/browser/pty/pane-sizing-context';
import { PtyPane } from '@core/features/terminals/contributions/browser/pty/pty-pane';
import { mountTerminalMirror } from '@core/features/terminals/contributions/browser/pty/terminal-mirror';
import { log } from '@core/primitives/logging/browser/logger';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';
import { createConversationAttachments } from '../../api/browser/conversation-attachments';

/**
 * The agent's real terminal, mounted into a canvas tile.
 *
 * A tile never stops an agent: unmounting only moves the xterm back off-screen. When the user asks
 * to start or resume an agent that is not running, the tile hydrates its conversation exactly like
 * opening its tab would.
 */
export const AgentTerminal = observer(function AgentTerminal({
  entry,
  hydrate,
  interactive,
  autoFocus,
  onActivate,
  onReleaseFocus,
}: {
  entry: AgentTileEntry;
  /** Start or resume the agent's session (only when the user asked to). */
  hydrate: boolean;
  /** False when canvas zoom would make pointer input land on the wrong cells. */
  interactive: boolean;
  autoFocus: boolean;
  onActivate: () => void;
  /** Shift+Esc inside the terminal: give keyboard focus back to the canvas. */
  onReleaseFocus: () => void;
}) {
  const { taskId, conversationId, workspaceId, taskProvisioned } = entry;
  useEffect(() => {
    if (!hydrate || !taskProvisioned) return;
    void conversationRegistry
      .get(taskId)
      ?.hydrateConversation(conversationId)
      .catch((error: unknown) => log.warn('canvas: could not start agent', { error }));
  }, [hydrate, taskProvisioned, taskId, conversationId]);

  const sink = useMemo(() => createPaneDimensionSink(), []);
  const attachments = useMemo(
    () => createConversationAttachments(conversationId),
    [conversationId]
  );
  const terminalRef = useRef<{ focus: () => void }>(null);

  const session = conversationRegistry.get(taskId)?.sessions.get(conversationId);
  const status = session?.status;
  const pty = session?.pty;

  useEffect(() => {
    if (!pty) return;
    return pty.enableWebgl();
  }, [pty]);

  useEffect(() => {
    if (autoFocus && interactive && status === 'ready') terminalRef.current?.focus();
  }, [autoFocus, interactive, status]);

  if (!session || !workspaceId) {
    return <TerminalPlaceholder label="Preparing workspace…" />;
  }
  if (status !== 'ready' || !pty) {
    return <TerminalPlaceholder label="Attaching to agent…" />;
  }

  return (
    // At interactive zoom the terminal owns drag (text selection) and wheel (scrollback).
    <div
      className={cn('relative h-full min-h-0 bg-(--xterm-bg)', interactive && 'nodrag nowheel')}
      onKeyDownCapture={(event) => {
        // Esc belongs to the agent (it interrupts); Shift+Esc hands focus back to the canvas.
        if (event.key !== 'Escape' || !event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        onReleaseFocus();
      }}
    >
      <PaneDimensionProvider sink={sink}>
        <PaneSizingContextProvider sessionIds={[session.sessionId]}>
          <PtyPane
            ref={terminalRef}
            sessionId={session.sessionId}
            pty={pty}
            className="h-full w-full"
            inputContext="agent"
            mapShiftEnterToCtrlJ
            attachments={attachments}
            workspaceId={workspaceId}
            onInterruptPress={() =>
              conversationRegistry.get(taskId)?.conversations.get(conversationId)?.clearWorking()
            }
          />
        </PaneSizingContextProvider>
      </PaneDimensionProvider>
      {!interactive && (
        // xterm cannot map pointer coordinates under a CSS scale; clicking snaps the canvas to
        // 100 % on this tile instead of mis-selecting text.
        <button
          type="button"
          aria-label="Focus this agent"
          className="absolute inset-0 z-10 cursor-zoom-in bg-transparent"
          onClick={onActivate}
        />
      )}
    </div>
  );
});

/**
 * The same agent terminal in another multi-canvas view. The real xterm mounts in one view only, so
 * the others show a read-only terminal that follows the same output. Clicking it makes that view
 * the active one, and the real terminal moves there.
 */
export const AgentTerminalMirror = observer(function AgentTerminalMirror({
  entry,
}: {
  entry: AgentTileEntry;
}) {
  const { taskId, conversationId } = entry;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = conversationRegistry.get(taskId)?.sessions.get(conversationId);
  const pty = session?.status === 'ready' ? session.pty : null;
  const mirrored = pty?.canMirror ? pty : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!mirrored || !host) return;
    return mountTerminalMirror(mirrored, host);
  }, [mirrored]);

  if (!mirrored) return <TerminalPlaceholder label="Live in another view" />;
  return (
    <div className="relative h-full min-h-0 bg-(--xterm-bg)">
      <div ref={hostRef} className="pointer-events-none h-full w-full" />
    </div>
  );
});

export function TerminalPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-(--xterm-bg) text-xs text-foreground-muted">
      {label}
    </div>
  );
}
