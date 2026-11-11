import { PageLayout } from '@emdash/ui/react/patterns';
import { useMemo } from 'react';
import { HostSettingsCard } from '../components/host-settings-card';
import { ResourceUtilizationRow } from '../components/machine-resources';
import { MachineSystemDependenciesCard } from '../components/machine-system-dependencies';
import { createSystemDependenciesStore } from '../machines-store';
import { useMachineMetrics } from '../use-machine-metrics';

export function SystemSettingsPage() {
  const metrics = useMachineMetrics(undefined, true);
  const systemDependenciesStore = useMemo(() => createSystemDependenciesStore(), []);

  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="System"
        description="This computer's resources, its defaults for workspaces, and the tools agents need."
      />
      <div className="flex flex-col gap-10">
        <ResourceUtilizationRow metrics={metrics} />
        <HostSettingsCard />
        <MachineSystemDependenciesCard machinesStore={systemDependenciesStore} />
      </div>
    </div>
  );
}
