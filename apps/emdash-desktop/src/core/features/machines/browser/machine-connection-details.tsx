import { FactGrid } from '@emdash/ui/react/patterns';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SshConfigHost } from '@core/primitives/ssh/api';

/**
 * What OpenSSH resolved for the chosen host, read-only: a label / value list in one quiet well
 * (a step up from the dialog surface) so it reads apart from the fields you can edit.
 */
export function MachineConnectionDetails({
  host,
  target,
}: {
  host: SshConfigHost;
  target: string;
}) {
  return (
    <div className="rounded-lg bg-surface-emphasis px-4 py-3">
      <FactGrid labelWidth="9rem" stackBelow="narrow">
        <FactGrid.Row label="Host">
          <span className="break-all">{host?.hostname || target}</span>
        </FactGrid.Row>
        <FactGrid.Row label="Port">
          <span className="tabular-nums">{host?.port ?? 22}</span>
        </FactGrid.Row>
        <FactGrid.Row label="Username">
          <span className="break-all">{host?.user || 'Not specified'}</span>
        </FactGrid.Row>
        <CopyableConnectionDetail
          key={`jump-${host?.proxyJump}`}
          label="Jump host"
          value={host?.proxyJump}
        />
        {host?.proxyCommand && (
          <CopyableConnectionDetail
            key={host.proxyCommand}
            label="Proxy command"
            value={host.proxyCommand}
            copyOnValueClick
          />
        )}
        <FactGrid.Row label="Forward SSH agent">{host?.forwardAgent ? 'On' : 'Off'}</FactGrid.Row>
      </FactGrid>
    </div>
  );
}

function CopyableConnectionDetail({
  label,
  value,
  copyOnValueClick = false,
}: {
  label: string;
  value?: string;
  copyOnValueClick?: boolean;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyValue = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timeout = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timeout);
  }, [copyState]);
  const CopyGlyph = copyState === 'copied' ? CheckIcon : CopyIcon;
  return (
    <FactGrid.Row label={label}>
      <div className="group min-w-0">
        {value ? (
          <div className="flex min-w-0 items-center gap-1">
            {copyOnValueClick ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="group/copy relative h-auto min-w-0 flex-1 justify-start px-0 py-0 text-sm font-normal text-foreground hover:bg-transparent"
                style={{ cursor: 'pointer', userSelect: 'none' }}
                aria-label={`Copy ${label.toLowerCase()}`}
                onClick={copyValue}
              >
                <span
                  className="pointer-events-none block truncate font-mono text-xs transition-opacity group-hover/copy:opacity-30 group-focus-visible/copy:opacity-30"
                  style={{ userSelect: 'none' }}
                >
                  {value}
                </span>
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100 [@media(hover:none)]:opacity-100 ${copyState === 'copied' ? 'opacity-100' : 'opacity-0'}`}
                >
                  <span className="rounded-sm bg-surface-emphasis p-1 text-foreground-muted">
                    <CopyGlyph className="size-3" />
                  </span>
                </span>
              </Button>
            ) : (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <span
                      tabIndex={0}
                      className="min-w-0 flex-1 truncate rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    />
                  }
                >
                  {value}
                </Tooltip.Trigger>
                <Tooltip.Content>
                  <span className="break-all">{value}</span>
                </Tooltip.Content>
              </Tooltip.Root>
            )}
            {!copyOnValueClick && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      icon
                      className="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                      aria-label={`Copy ${label.toLowerCase()}`}
                      onClick={copyValue}
                    />
                  }
                >
                  <CopyGlyph className="size-3" />
                </Tooltip.Trigger>
                <Tooltip.Content>
                  {copyState === 'copied' ? 'Copied' : `Copy ${label.toLowerCase()}`}
                </Tooltip.Content>
              </Tooltip.Root>
            )}
          </div>
        ) : (
          <span className="text-foreground-muted">None</span>
        )}
        <div
          role="status"
          className={copyState === 'error' ? 'text-xs text-foreground-muted' : 'sr-only'}
        >
          {copyState === 'error'
            ? 'Could not copy. Try again.'
            : copyState === 'copied'
              ? `${label} copied to clipboard.`
              : null}
        </div>
      </div>
    </FactGrid.Row>
  );
}
