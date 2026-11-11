import { EmptyState } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { useEffect, useState } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { getConductorClient } from '../../api/browser/client';
import type { ConductorTurnRecord } from '../../api/contract';
import { HudCard, HudCardHeader } from './hud-card';

const LOG_LIMIT = 30;

/** The kit empty state, tightened for a card: no panel fill, little padding. */
const EMPTY_IN_CARD = 'px-0 pt-3 pb-1';

/**
 * Recent conductor turns, newest first: what was heard, what ran, and what it cost. A card
 * above the conductor bar; Escape or the close button puts it away.
 */
export function ConductorLogPanel({
  refreshKey,
  enabled,
  onClose,
}: {
  refreshKey: number;
  enabled: boolean;
  /** Puts the history away (the close button, and leaving for settings). */
  onClose?: () => void;
}) {
  const [records, setRecords] = useState<ConductorTurnRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setRecords(null);
    setFailed(false);
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
  }, [refreshKey, enabled]);

  const openSettings = () => {
    onClose?.();
    getNavigation().navigate(settingsViewDef({ tab: 'chorus' }));
  };

  return (
    <HudCard label="History">
      <HudCardHeader
        title="Conductor history"
        meta={records && records.length > 0 ? `Last ${records.length}` : undefined}
        onClose={onClose}
        closeLabel="Close history"
      />
      {!enabled ? (
        <EmptyState
          bare
          className={EMPTY_IN_CARD}
          label="History is off"
          description="Enable diagnostic history in Voice & Conductor settings to record commands."
          action={
            <Button type="button" variant="text" size="xs" onClick={openSettings}>
              Open settings
            </Button>
          }
        />
      ) : failed ? (
        <EmptyState bare tone="error" className={EMPTY_IN_CARD} label="The log is unavailable" />
      ) : !records ? (
        <EmptyState bare tone="loading" className={EMPTY_IN_CARD} label="Loading history…" />
      ) : records.length === 0 ? (
        <EmptyState
          bare
          className={EMPTY_IN_CARD}
          label="No commands yet"
          description="What you say or type to the conductor shows up here."
        />
      ) : (
        <ol
          className="-mx-1 mt-1.5 max-h-72 space-y-3 overflow-y-auto px-1 pb-1"
          aria-label="Conductor history"
        >
          {records.map((record) => (
            <li key={record.at}>
              <div className="flex items-baseline gap-3">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                  “{record.utterance}”
                </p>
                <span className="shrink-0 text-tiny text-foreground-passive tabular-nums">
                  {routeLabel(record.route)} · {record.latencyMs} ms
                  {record.tokens ? ` · ${record.tokens.toLocaleString()} tok` : ''}
                  {' · '}
                  <time dateTime={record.at}>{new Date(record.at).toLocaleTimeString()}</time>
                </span>
              </div>
              {record.actions.length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {record.actions.map((action, index) => (
                    <li key={index} className="truncate font-mono text-tiny text-foreground-muted">
                      {action.tool} → {action.outcome}
                    </li>
                  ))}
                </ul>
              )}
              {record.reply && (
                <p className="mt-0.5 text-xs text-foreground-muted">{record.reply}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </HudCard>
  );
}

function routeLabel(route: ConductorTurnRecord['route']): string {
  return route === 'grammar'
    ? 'instant'
    : route === 'jev'
      ? 'Jev'
      : route === 'line'
        ? 'talk line'
        : 'Claude';
}
