import { formatCommandOutputTail } from '@emdash/core/primitives/host-dependencies/api';
import type { PermissionDeniedError } from '@emdash/core/primitives/host-dependencies/api';
import { Button } from '@emdash/ui/react/primitives';
import { TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { CommandActionButton, CommandRow } from './install-command-row';

export type SudoRetryPanelProps = {
  error: PermissionDeniedError;
  dependencyName: string;
  isRetrying: boolean;
  onRetry: () => void;
  onDismiss?: () => void;
  compact?: boolean;
};

export function SudoRetryPanel({
  error,
  dependencyName,
  isRetrying,
  onRetry,
  onDismiss,
  compact = false,
}: SudoRetryPanelProps) {
  const [showOutput, setShowOutput] = useState(false);
  const output = formatCommandOutputTail(error.output ?? '');
  const command = error.canRetryWithSudo
    ? error.elevatedCommand
    : (error.interactiveCommand ?? error.command);

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border-subtle p-3',
        compact && 'p-2.5'
      )}
      role="alert"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-foreground-warning" aria-hidden />
        <span className="text-sm font-medium text-foreground">Permission denied</span>
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon
            aria-label="Dismiss permission error"
            className="ml-auto"
            onClick={onDismiss}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>

      {error.canRetryWithSudo ? (
        <p className="text-xs text-foreground-muted">
          The command needs elevated permissions. You can retry with administrator privileges.
        </p>
      ) : (
        <p className="text-xs text-foreground-muted">
          Installing {dependencyName} needs elevated permissions and passwordless sudo isn't
          available on this host. Run this command in a terminal on this machine.
        </p>
      )}

      {command ? (
        <CommandRow
          command={command}
          action={
            error.canRetryWithSudo ? (
              <CommandActionButton disabled={isRetrying} onClick={onRetry}>
                {isRetrying ? 'Retrying…' : 'Retry with sudo'}
              </CommandActionButton>
            ) : null
          }
        />
      ) : null}

      {output ? (
        <>
          <Button
            type="button"
            variant="text"
            size="xs"
            className="self-start"
            aria-expanded={showOutput}
            onClick={() => setShowOutput((visible) => !visible)}
          >
            {showOutput ? 'Hide output' : 'Show output'}
          </Button>
          {showOutput ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-surface-emphasis p-2 font-mono text-tiny whitespace-pre-wrap text-foreground-muted">
              {output}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
