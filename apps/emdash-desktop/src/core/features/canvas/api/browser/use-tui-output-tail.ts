import { useEffect, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { readOutputLogTail, PREVIEW_MAX_ROWS } from './terminal-tail';

/** Plan LOD: preview refreshes at ≤ 4 Hz while working, and not at all while idle. */
export const PREVIEW_REFRESH_MS = 250;

/**
 * Snapshot tail of a TUI live log without attaching a streaming replica or xterm.
 * Idle tiles take one snapshot; working tiles poll at PREVIEW_REFRESH_MS.
 */
export function startTuiOutputTail(
  conversationId: string | undefined,
  active: boolean,
  working: boolean,
  onLines: (lines: string[]) => void
): () => void {
  if (!active || !conversationId) {
    onLines([]);
    return () => {};
  }

  let cancelled = false;

  const pull = async () => {
    try {
      const client = await getConversationsClient();
      const snapshot = await client.tui.output.handle({ conversationId }).snapshot();
      if (cancelled) return;
      onLines(readOutputLogTail(snapshot.data.text, PREVIEW_MAX_ROWS));
    } catch {
      if (!cancelled) onLines([]);
    }
  };

  void pull();
  if (!working) {
    return () => {
      cancelled = true;
    };
  }

  const timer = setInterval(() => void pull(), PREVIEW_REFRESH_MS);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

export function useTuiOutputTail(
  conversationId: string | undefined,
  active: boolean,
  working: boolean
): string[] {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(
    () => startTuiOutputTail(conversationId, active, working, setLines),
    [conversationId, active, working]
  );

  return lines;
}
