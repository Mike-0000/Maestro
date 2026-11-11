import { Button, DropdownMenu, Spinner, toast } from '@emdash/ui/react/primitives';
import { MoreHorizontal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { HostDependencyInstallation } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import type { AgentPayload, InstallOption, SelectedSource } from '@core/primitives/agents/api';
import { resolveActiveInstallation, sourceKey } from '@core/primitives/agents/api';
import { InstalledBadge, RecommendedBadge, UsedBadge } from './agent-status-badge';
import { buildSourceRows, provenanceLabel } from './installation-sources';

export type InstallationState = 'found' | 'not-found' | 'uninstalled' | 'checking';

export type DependencyInstallationStatusCardProps = {
  vm: HostDependencyInstallation;
  /** Full agent payload; used to detect when automatic updates are unavailable. */
  agentPayload?: AgentPayload;
  /** Platform-specific install options from the agent. */
  installOptions: InstallOption[];
  /** The currently selected source (renderer-local intent). */
  selectedSource: SelectedSource;
  /** The derived state to render. */
  state: InstallationState;
  /** Called when the user picks a different source from the menu. */
  onSelectSource: (ref: SelectedSource) => void;
};

export const DependencyInstallationStatusCard = observer(function DependencyInstallationStatusCard({
  vm,
  agentPayload,
  installOptions,
  selectedSource,
  state,
  onSelectSource,
}: DependencyInstallationStatusCardProps) {
  const { installations, refresh, fetchLatestVersion, uninstall, isUninstalling } = vm;

  const selectedInstall = resolveActiveInstallation(installations, selectedSource);
  const versionText =
    state === 'found' && selectedInstall?.version ? `v${selectedInstall.version}` : null;

  // Show the "no automatic updates" hint when the used installation is not manageable
  // for a package-manager strategy (i.e., we can't determine which PM to call).
  const updates = agentPayload?.capabilities.hostDependency.updates;
  const strategyKind = updates?.kind === 'supported' ? updates.update.kind : 'none';
  const showNoAutoUpdateHint =
    state === 'found' && !selectedInstall?.manageable && strategyKind === 'package-manager';

  const uninstallDescriptor = agentPayload?.capabilities.hostDependency.uninstall;
  const canUninstall =
    !!uninstallDescriptor && uninstallDescriptor.kind !== 'none' && state === 'found';

  const sourceRows = buildSourceRows(installOptions, installations);
  const selectedKey = sourceKey(selectedSource);
  const selectedRow = sourceRows.find((r) => sourceKey(r.ref) === selectedKey);

  // Build a human-readable label for the currently-selected source
  const selectedLabel = (() => {
    if (selectedInstall && selectedSource.kind !== 'auto') {
      const provLabel = provenanceLabel(selectedInstall.provenance);
      return selectedRow?.label ?? provLabel;
    }
    return selectedRow?.label ?? selectedSource.kind;
  })();

  // Name where the binary came from (npm, Homebrew…) rather than the "Auto" policy row.
  const installedVia =
    selectedSource.kind === 'auto' && selectedInstall
      ? provenanceLabel(selectedInstall.provenance)
      : selectedLabel;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          {state === 'checking' ? (
            <>
              <Spinner size="sm" className="shrink-0 text-foreground-passive" />
              <span className="text-foreground-muted">Checking…</span>
            </>
          ) : state === 'found' ? (
            <>
              <span className="shrink-0 text-foreground">Installed</span>
              <span className="min-w-0 truncate text-xs text-foreground-muted">
                {[versionText, installedVia === 'Unknown' ? null : `via ${installedVia}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </>
          ) : state === 'not-found' ? (
            <span className="text-foreground-muted">Not installed yet. Install it below.</span>
          ) : (
            <span className="text-foreground-muted">Uninstalled</span>
          )}
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            disabled={state === 'checking'}
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="shrink-0"
                aria-label="Installation options"
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>Change source</DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent>
                <DropdownMenu.Group>
                  <DropdownMenu.Label>Select source</DropdownMenu.Label>
                  <DropdownMenu.Separator />
                  {sourceRows.map((row) => {
                    const rowKey = sourceKey(row.ref);
                    const isCurrentSource = rowKey === selectedKey;
                    return (
                      <DropdownMenu.Item key={rowKey} onClick={() => onSelectSource(row.ref)}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{row.label}</span>
                            {row.displayPath && (
                              <span className="truncate font-mono text-xs text-foreground-muted">
                                {row.displayPath}
                              </span>
                            )}
                          </span>
                          {row.recommended && <RecommendedBadge />}
                          {/* "Installed" applies to concrete discovered binaries, never to the
                              'auto' policy row. Show it on every found installation, including
                              the currently-used one (which also says "In use"). */}
                          {row.status === 'available' && row.ref.kind !== 'auto' && (
                            <InstalledBadge />
                          )}
                          {isCurrentSource &&
                            (row.status === 'available' || selectedSource.kind !== 'auto') && (
                              <UsedBadge />
                            )}
                        </span>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Group>
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              onClick={() => {
                void toast.promise(refresh(), {
                  loading: 'Refreshing installations…',
                  success: 'Installations refreshed',
                  error: 'Failed to refresh installations',
                });
              }}
            >
              Refresh
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onClick={() => {
                void toast.promise(fetchLatestVersion(), {
                  loading: 'Checking for updates…',
                  success: 'Checked for updates',
                  error: 'Failed to check for updates',
                });
              }}
            >
              Check for updates
            </DropdownMenu.Item>
            {canUninstall && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  variant="destructive"
                  disabled={isUninstalling}
                  onClick={() => {
                    const name = agentPayload?.name ?? 'Agent';
                    void toast.promise(uninstall(), {
                      loading: `Uninstalling ${name}…`,
                      success: `${name} successfully uninstalled`,
                      error: `Failed to uninstall ${name}`,
                    });
                  }}
                >
                  Uninstall
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      {showNoAutoUpdateHint && (
        <p className="text-xs text-foreground-passive">
          Automatic updates are not available for this installation.
        </p>
      )}
    </div>
  );
});
