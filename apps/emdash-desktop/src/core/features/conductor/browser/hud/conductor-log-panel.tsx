import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getConductorClient } from '../../api/browser/client';
import type { ConductorTurnRecord } from '../../api/contract';

const LOG_LIMIT = 30;

/** Recent conductor turns, newest first: what was heard, what ran, and what it cost. */
export function ConductorLogPanel({ refreshKey }: { refreshKey: number }) {
  const [records, setRecords] = useState<ConductorTurnRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getConductorClient()
      .then((client) => client.readLog({ limit: LOG_LIMIT }))
      .then((next) => {
        if (!cancelled) setRecords([...next].reverse());
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (failed) return <p className="px-1 text-xs text-foreground-muted">The log is unavailable.</p>;
  if (!records) {
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-foreground-muted">
        <Loader2 className="size-3.5 animate-spin" /> Loading history…
      </p>
    );
  }
  if (records.length === 0) {
    return <p className="px-1 text-xs text-foreground-muted">No commands yet.</p>;
  }
  return (
    <ol className="max-h-72 space-y-1.5 overflow-y-auto pr-1" aria-label="Conductor history">
      {records.map((record) => (
        <li key={record.at} className="rounded-lg bg-background-secondary/60 px-2.5 py-1.5 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              “{record.utterance}”
            </span>
            <span className="shrink-0 text-[10px] text-foreground-muted tabular-nums">
              {record.route === 'grammar' ? 'instant' : record.route === 'jev' ? 'Jev' : 'Claude'} ·{' '}
              {record.latencyMs} ms
              {record.tokens ? ` · ${record.tokens.toLocaleString()} tok` : ''}
            </span>
          </div>
          {record.actions.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-foreground-muted">
              {record.actions.map((action, index) => (
                <li key={index} className="truncate font-mono text-[10.5px]">
                  {action.tool} → {action.outcome}
                </li>
              ))}
            </ul>
          )}
          {record.reply && <p className="mt-0.5 text-foreground-muted">{record.reply}</p>}
          <time className="text-[10px] text-foreground-muted/70" dateTime={record.at}>
            {new Date(record.at).toLocaleTimeString()}
          </time>
        </li>
      ))}
    </ol>
  );
}
