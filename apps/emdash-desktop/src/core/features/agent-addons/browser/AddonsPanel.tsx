import type { HostRef } from '@emdash/core/primitives/host/api';
import type { InstalledAddon } from '@emdash/core/runtimes/agent-config/api';
import { StateGlyph, EmptyState } from '@emdash/ui/react/components';
import { PageLayout, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Collapsible, useToast } from '@emdash/ui/react/primitives';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import type { AddonCatalogEntry, AgentAddonsError } from '@core/features/agent-addons/api/contract';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { cn } from '@core/primitives/styling/browser/cn';
import { getAgentAddonsClient } from './client';
import { useInstalledAddons } from './live-model-hooks';

type AddonsPanelProps = {
  host: HostRef;
  header?: { title: string; description: string };
};

type AddonStatus =
  | { kind: 'not-installed' }
  | { kind: 'installed'; version: number; edited: boolean; incomplete: boolean }
  | { kind: 'update'; version: number };

export function AddonsPanel({ host, header }: AddonsPanelProps) {
  const catalog = useQuery({
    queryKey: ['agentAddons', 'catalog'],
    queryFn: async () => (await getAgentAddonsClient()).catalog(),
    staleTime: Infinity,
  });
  const installed = useInstalledAddons(host);

  return (
    <div className="flex flex-col pb-16 text-foreground">
      {header && <PageLayout.Header sticky title={header.title} description={header.description} />}
      {catalog.isPending ? (
        <EmptyState tone="loading" label="Loading add-ons…" className="min-h-48" />
      ) : catalog.isError ? (
        <EmptyState
          tone="error"
          className="min-h-48"
          label="Couldn't load add-ons"
          details={catalog.error.message}
          action={
            <Button variant="text" onClick={() => void catalog.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-10">
          {(catalog.data ?? []).map((addon) => (
            <AddonSection
              key={addon.id}
              host={host}
              addon={addon}
              installed={installed.data.filter((entry) => entry.id === addon.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddonSection({
  host,
  addon,
  installed,
}: {
  host: HostRef;
  addon: AddonCatalogEntry;
  installed: InstalledAddon[];
}) {
  const { toast } = useToast();
  const openConfirm = useOpenModal('confirmActionModal');
  const status = addonStatus(addon, installed);

  const install = useMutation({
    mutationFn: async () => {
      const client = await getAgentAddonsClient();
      const first = await client.install({ host, addonId: addon.id });
      if (first.success || first.error.type !== 'conflict') return first;
      const confirmed = await openConfirm({
        title: 'Replace existing files?',
        description: (
          <div className="flex flex-col gap-2">
            <p>These already hold something other than {addon.name}, possibly your own edits:</p>
            <ul className="list-disc pl-5 font-mono text-xs">
              {first.error.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        ),
        confirmLabel: 'Replace',
      });
      if (!confirmed.success) return null;
      return client.install({ host, addonId: addon.id, replace: true });
    },
    onSuccess: (result) => {
      if (!result) return;
      if (result.success) toast(`${addon.name} installed`, { description: addon.summary });
      else toast.error('Install failed', { description: errorText(result.error) });
    },
    onError: (error) => toast.error('Install failed', { description: error.message }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const confirmed = await openConfirm({
        title: `Remove ${addon.name}?`,
        description:
          'Maestro deletes the files this add-on installed and takes its block out of your ' +
          'instructions file. Everything else in that file stays as it is.',
        confirmLabel: 'Remove',
      });
      if (!confirmed.success) return null;
      return (await getAgentAddonsClient()).remove({ host, addonId: addon.id });
    },
    onSuccess: (result) => {
      if (!result) return;
      if (result.success) toast(`${addon.name} removed`);
      else toast.error('Remove failed', { description: errorText(result.error) });
    },
    onError: (error) => toast.error('Remove failed', { description: error.message }),
  });

  const busy = install.isPending || remove.isPending;

  return (
    <SettingsSection title={addon.name}>
      <SettingsRow
        label={addon.summary}
        description={
          <>
            {addon.description}
            <StatusLine status={status} />
          </>
        }
        control={
          <div className="flex items-center gap-x-4">
            {status.kind !== 'not-installed' && (
              <Button variant="text" size="sm" disabled={busy} onClick={() => remove.mutate()}>
                Remove…
              </Button>
            )}
            {status.kind === 'installed' && !status.incomplete && (
              <Button variant="text" size="sm" disabled={busy} onClick={() => install.mutate()}>
                Reinstall
              </Button>
            )}
            {status.kind === 'not-installed' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => install.mutate()}
              >
                Install
              </Button>
            )}
            {status.kind === 'update' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => install.mutate()}
              >
                Update
              </Button>
            )}
            {status.kind === 'installed' && status.incomplete && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => install.mutate()}
              >
                Repair
              </Button>
            )}
          </div>
        }
      />
      <AddonContents addon={addon} installed={installed} />
    </SettingsSection>
  );
}

/** The add-on's state in words under its description: warnings in the warning colour, no chips. */
function StatusLine({ status }: { status: AddonStatus }) {
  if (status.kind === 'not-installed') return null;
  const warning = status.kind === 'update' || status.incomplete;
  const words =
    status.kind === 'update'
      ? 'Installed, update available'
      : status.incomplete
        ? 'Installed, but some files are missing'
        : status.edited
          ? 'Installed, with your edits'
          : 'Installed';
  return (
    <span
      className={cn(
        'mt-1 flex items-center gap-1.5',
        warning ? 'text-foreground-warning' : 'text-foreground-muted'
      )}
    >
      {warning ? (
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <StateGlyph state="done" size="sm" />
      )}
      {words}
    </span>
  );
}

function AddonContents({
  addon,
  installed,
}: {
  addon: AddonCatalogEntry;
  installed: InstalledAddon[];
}) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger type="button" variant="text">
        What it adds
      </Collapsible.Trigger>
      <Collapsible.Panel className="grid gap-4 pt-3 text-sm">
        {addon.targets.map((target) => {
          const record = installed.find((entry) => entry.providerId === target.providerId);
          const folder = record?.root ?? `${target.providerName}'s config folder`;
          return (
            <div key={target.providerId} className="grid gap-2">
              <p className="text-foreground-muted">
                For {target.providerName}, in <span className="font-mono">{folder}</span>:
              </p>
              <ul className="list-disc pl-5 font-mono text-xs">
                {target.files.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
              {target.instructions && (
                <>
                  <p className="text-foreground-muted">
                    A marked block at the end of{' '}
                    <span className="font-mono">{target.instructions.path}</span>, which Maestro
                    never touches outside that block:
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-background p-3 font-mono text-xs whitespace-pre-wrap text-foreground-body">
                    {target.instructions.content.trim()}
                  </pre>
                </>
              )}
            </div>
          );
        })}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function addonStatus(addon: AddonCatalogEntry, installed: InstalledAddon[]): AddonStatus {
  if (installed.length === 0) return { kind: 'not-installed' };
  const version = Math.min(...installed.map((entry) => entry.version));
  const missingTarget = addon.targets.some(
    (target) => !installed.some((entry) => entry.providerId === target.providerId)
  );
  if (version < addon.version || missingTarget) return { kind: 'update', version };
  const parts = installed.flatMap((entry) => [
    ...entry.files,
    ...(entry.instructions ? [entry.instructions] : []),
  ]);
  return {
    kind: 'installed',
    version,
    edited: parts.some((part) => part.state === 'edited'),
    incomplete: parts.some((part) => part.state === 'missing'),
  };
}

function errorText(error: AgentAddonsError): string {
  switch (error.type) {
    case 'conflict':
      return `Files already hold something else: ${error.paths.join(', ')}`;
    case 'unknown-provider':
      return `This computer has no ${error.providerId} provider.`;
    case 'unknown-addon':
      return `This version of Maestro has no add-on "${error.addonId}".`;
    default:
      return 'message' in error && typeof error.message === 'string' ? error.message : error.type;
  }
}
