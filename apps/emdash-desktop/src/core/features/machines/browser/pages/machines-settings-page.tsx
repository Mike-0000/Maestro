import { CollectionToolbar, CollectionView, PageLayout } from '@emdash/ui/react/patterns';
import { Button, toast } from '@emdash/ui/react/primitives';
import { MonitorIcon, PlusIcon, ServerIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { SettingsPageProps } from '@core/primitives/settings/api/page-contribution';
import type { ConnectionState } from '@core/primitives/ssh/api';
import { MachineListRow } from '../components/machine-list-row';
import { createMachinesListView, type MachinesListViewModel } from '../machines-list-model';

function isRecentlyUsed(state: ConnectionState): boolean {
  return state === 'connected' || state === 'connecting' || state === 'reconnecting';
}

export const MachinesSettingsPage = observer(function MachinesSettingsPage({
  openDetail,
}: SettingsPageProps) {
  const machinesStore = getMachinesStore();
  const openMachineModal = useOpenModal('addSshConnModal');
  // The machines store is MobX-observable, so the view's source getter reads it
  // directly and the list pipeline re-derives on store changes — no bridge needed.
  const [view] = useState(() =>
    createMachinesListView({
      getMachines: () => getMachinesStore().connections,
      isRecentlyUsed: (machine) => isRecentlyUsed(getMachinesStore().stateFor(machine.id)),
    })
  );

  const openCreateModal = () => {
    void openMachineModal({ dismissControl: 'close' });
  };
  const hasThisComputer = machinesStore.connections.some(
    (machine) => machine.transport === 'local'
  );
  const addThisComputer = async () => {
    try {
      const machine = await machinesStore.addThisComputer();
      openDetail(machine.id);
    } catch (error) {
      toast.error('Failed to add this computer', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-8">
      <PageLayout.Header
        sticky
        title="Machines"
        description="Manage reusable machines for remote projects."
      />
      <view.Root>
        <CollectionView
          view={view}
          renderRow={(machine) => <MachineListRow machine={machine} />}
          layout="grouped"
          toolbar={
            <MachinesToolbar
              view={view}
              onAdd={openCreateModal}
              onAddThisComputer={hasThisComputer ? undefined : () => void addThisComputer()}
            />
          }
          onItemClick={(machine) => openDetail(machine.id)}
          emptySlot={<MachinesEmptyState hasMachines={machinesStore.connections.length > 0} />}
        />
      </view.Root>
    </div>
  );
});

const MachinesToolbar = observer(function MachinesToolbar({
  view,
  onAdd,
  onAddThisComputer,
}: {
  view: MachinesListViewModel;
  onAdd: () => void;
  /** Absent once this computer is already a machine. */
  onAddThisComputer?: () => void;
}) {
  const search = view.useSearch();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        value={search.query}
        onValueChange={search.setQuery}
        placeholder="Search machines…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        {onAddThisComputer ? (
          <Button
            type="button"
            variant="secondary"
            onClick={onAddThisComputer}
            title="Run conversations on this computer's workspace server, shared with computers that connect to it over SSH"
          >
            <MonitorIcon />
            Add this computer
          </Button>
        ) : null}
        <Button type="button" variant="primary" onClick={onAdd}>
          <PlusIcon />
          Add machine
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
});

function MachinesEmptyState({ hasMachines }: { hasMachines: boolean }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center p-8 text-center">
      <ServerIcon className="mb-3 size-8 text-foreground-passive" />
      <div className="text-sm text-foreground">
        {hasMachines ? 'No machines match your search' : 'No machines'}
      </div>
      <p className="mt-1 max-w-sm text-xs text-foreground-passive">
        {hasMachines
          ? 'Try a different name, host, or username.'
          : 'Add a machine to create and manage remote projects.'}
      </p>
    </div>
  );
}
