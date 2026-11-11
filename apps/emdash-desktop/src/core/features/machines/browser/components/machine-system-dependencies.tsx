import type { InstallMethod } from '@emdash/core/services/host-dependencies/api';
import { EmptyState } from '@emdash/ui/react/components';
import { SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, SectionLabel, Spinner } from '@emdash/ui/react/primitives';
import { CheckIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { MachineSystemDependencyStatus } from '@core/features/machines/api';
import { SudoRetryPanel } from '@core/primitives/agents/browser/SudoRetryPanel';
import type { DependencyOperationFailure } from '@core/primitives/host-dependencies/browser/use-dependency-operation-failures';
import type { SystemDependenciesStore } from '../machines-store';
import { useSystemDependencies } from '../use-system-dependencies';

type MachineSystemDependenciesCardProps = {
  machineId?: string;
  machinesStore: SystemDependenciesStore;
};

/**
 * The host tools Maestro and the agents rely on, in two groups (required, recommended). Each
 * row says plainly whether the tool is installed; a missing required tool reads as a warning,
 * a missing recommended one stays quiet. One row on top installs everything installable.
 */
export function MachineSystemDependenciesCard({
  machineId,
  machinesStore,
}: MachineSystemDependenciesCardProps) {
  const {
    data,
    error,
    install,
    installAll,
    installFailures,
    dismissInstallFailure,
    installingIds,
    isInstalling,
    isLoading,
  } = useSystemDependencies(machineId, true, machinesStore);

  const dependencies = useMemo(
    () => [...(data ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [data]
  );

  const requiredDependencies = useMemo(
    () => dependencies.filter((dependency) => dependency.tier === 'required'),
    [dependencies]
  );

  const recommendedDependencies = useMemo(
    () => dependencies.filter((dependency) => dependency.tier === 'recommended'),
    [dependencies]
  );

  const installableMissingDependencies = useMemo(
    () =>
      dependencies.filter(
        (dependency) => dependency.status !== 'available' && dependency.installOptions.length > 0
      ),
    [dependencies]
  );

  const canInstallAll = installableMissingDependencies.length > 0 && !isInstalling;
  const missingCount = installableMissingDependencies.length;

  return (
    <SettingsSection
      title="System dependencies"
      description="Tools on this host that Maestro and coding agents use."
    >
      {isLoading ? (
        <EmptyState bare tone="loading" label="Checking system dependencies…" className="py-6" />
      ) : error ? (
        <EmptyState
          bare
          tone="error"
          label="Could not check system dependencies"
          details={error.message}
          className="py-6"
        />
      ) : (
        <>
          <SettingsRow
            label="Install missing tools"
            description={
              missingCount === 0
                ? 'Everything Maestro can install here is installed.'
                : `${missingCount} ${missingCount === 1 ? 'tool' : 'tools'} can be installed on this host.`
            }
            control={
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!canInstallAll}
                onClick={() => void installAll(installableMissingDependencies)}
              >
                {isInstalling ? (
                  <>
                    <Spinner size="sm" />
                    Installing…
                  </>
                ) : (
                  'Install all'
                )}
              </Button>
            }
          />
          <DependencySection
            title="Required"
            tier="required"
            dependencies={requiredDependencies}
            installingIds={installingIds}
            installFailures={installFailures}
            onInstall={install}
            onDismissFailure={dismissInstallFailure}
          />
          <DependencySection
            title="Recommended"
            tier="recommended"
            dependencies={recommendedDependencies}
            installingIds={installingIds}
            installFailures={installFailures}
            onInstall={install}
            onDismissFailure={dismissInstallFailure}
          />
        </>
      )}
    </SettingsSection>
  );
}

function DependencySection({
  title,
  tier,
  dependencies,
  installingIds,
  installFailures,
  onInstall,
  onDismissFailure,
}: {
  title: string;
  tier: 'required' | 'recommended';
  dependencies: MachineSystemDependencyStatus[];
  installingIds: Set<string>;
  installFailures: Record<string, DependencyOperationFailure>;
  onInstall: (dependencyId: string, method?: InstallMethod, elevate?: boolean) => void;
  onDismissFailure: (dependencyId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel as="h4">{title}</SectionLabel>
      {dependencies.length === 0 ? (
        <p className="py-1.5 text-xs text-foreground-muted">No {title.toLowerCase()} tools.</p>
      ) : (
        <ul className="flex flex-col">
          {dependencies.map((dependency) => (
            <SystemDependencyRow
              key={dependency.id}
              dependency={dependency}
              tier={tier}
              installing={installingIds.has(dependency.id)}
              failure={installFailures[dependency.id] ?? null}
              onInstall={() => {
                const option =
                  dependency.installOptions.find((candidate) => candidate.recommended) ??
                  dependency.installOptions[0];
                onInstall(dependency.id, option?.method);
              }}
              onRetry={(method) => onInstall(dependency.id, method, true)}
              onDismissFailure={() => onDismissFailure(dependency.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SystemDependencyRow({
  dependency,
  tier,
  installing,
  failure,
  onInstall,
  onRetry,
  onDismissFailure,
}: {
  dependency: MachineSystemDependencyStatus;
  tier: 'required' | 'recommended';
  installing: boolean;
  failure: DependencyOperationFailure | null;
  onInstall: () => void;
  onRetry: (method?: InstallMethod) => void;
  onDismissFailure: () => void;
}) {
  const available = dependency.status === 'available';
  const canInstall = !available && dependency.installOptions.length > 0;
  const missingTone = tier === 'required' ? 'text-foreground-warning' : 'text-foreground-passive';

  return (
    <li className="flex flex-col gap-2">
      <div className="flex h-9 min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{dependency.name}</span>
        {available ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
            <CheckIcon aria-hidden className="size-3.5 text-foreground-passive" />
            Installed
          </span>
        ) : canInstall ? (
          <span className="flex shrink-0 items-center gap-3">
            <span className={`text-xs ${missingTone}`}>Not installed</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={installing}
              aria-label={`Install ${dependency.name}`}
              onClick={onInstall}
            >
              {installing ? <Spinner size="sm" /> : 'Install'}
            </Button>
          </span>
        ) : (
          <span className={`shrink-0 text-xs ${missingTone}`}>Not found</span>
        )}
      </div>
      {failure ? (
        <SudoRetryPanel
          error={failure.error}
          dependencyName={dependency.name}
          isRetrying={installing}
          onRetry={() => onRetry(failure.method)}
          onDismiss={onDismissFailure}
        />
      ) : null}
    </li>
  );
}
