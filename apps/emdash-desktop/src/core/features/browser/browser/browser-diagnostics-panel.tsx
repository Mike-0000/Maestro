import { Button, SectionLabel } from '@emdash/ui/react/primitives';
import { AlertCircle, Info, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { browserDiagnosticsStore } from '@core/features/browser/api/browser/browser-diagnostics-store';

export const BrowserDiagnosticsPanel = observer(function BrowserDiagnosticsPanel({
  browserId,
}: {
  browserId: string;
}) {
  const entries = browserDiagnosticsStore.entriesForBrowser(browserId).slice(-50).reverse();

  if (entries.length === 0) return null;

  // A sunken strip under the page, like the drawer: a group label, a text action, and dense rows
  // where only warning and error glyphs carry colour.
  return (
    <div className="surface-sunken h-32 shrink-0 overflow-hidden bg-(--em-surface)">
      <div className="flex h-8 items-center justify-between px-3">
        <SectionLabel>Diagnostics</SectionLabel>
        <Button
          variant="text"
          size="xs"
          onClick={() => browserDiagnosticsStore.clearBrowser(browserId)}
        >
          Clear
        </Button>
      </div>
      <div className="h-24 overflow-auto px-3 pb-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="grid grid-cols-[14px_72px_1fr] items-start gap-2 py-1 text-xs"
          >
            <DiagnosticIcon level={entry.level} />
            <span className="text-foreground-passive">{entry.source}</span>
            <div className="min-w-0">
              <div className="truncate font-mono text-foreground">{entry.message}</div>
              {entry.url && <div className="truncate text-foreground-passive">{entry.url}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

function DiagnosticIcon({ level }: { level: 'info' | 'warning' | 'error' }) {
  if (level === 'error') {
    return <AlertCircle aria-label="Error" className="mt-0.5 size-3.5 text-foreground-error" />;
  }
  if (level === 'warning') {
    return (
      <TriangleAlert aria-label="Warning" className="mt-0.5 size-3.5 text-foreground-warning" />
    );
  }
  return <Info aria-label="Info" className="mt-0.5 size-3.5 text-foreground-passive" />;
}
