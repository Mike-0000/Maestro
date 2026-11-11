import { EmptyState } from '@emdash/ui/react/components';
import { CollectionToolbar, CollectionView, PageLayout } from '@emdash/ui/react/patterns';
import { SplitButton, toast, type SplitButtonOption } from '@emdash/ui/react/primitives';
import { PlusIcon } from 'lucide-react';
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
  const openMaestroHostModal = useOpenModal('maestroHostModal');
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
  const addMaestroHost = async () => {
    const outcome = await openMaestroHostModal({ mode: 'add' });
    if (outcome.success) openDetail(outcome.data.connectionId);
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

  const addWslDistro = async () => {
    try {
      const machine = await machinesStore.addWslDistro();
      openDetail(machine.id);
    } catch (error) {
      toast.error('Failed to add a WSL distro', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-col pb-16">
      <PageLayout.Header
        sticky
        title="Machines"
        description="The computers your projects and agents can run on, over SSH or another Maestro."
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
              onAddMaestroHost={() => void addMaestroHost()}
              onAddThisComputer={hasThisComputer ? undefined : () => void addThisComputer()}
              onAddWslDistro={
                navigator.userAgent.includes('Windows') ? () => void addWslDistro() : undefined
              }
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
  onAddMaestroHost,
  onAddThisComputer,
  onAddWslDistro,
}: {
  view: MachinesListViewModel;
  onAdd: () => void;
  onAddMaestroHost: () => void;
  /** Absent once this computer is already a machine. */
  onAddThisComputer?: () => void;
  /** Windows only. */
  onAddWslDistro?: () => void;
}) {
  const search = view.useSearch();
  // One primary move (an SSH machine); the other ways to add one sit in its menu.
  const addOptions: (SplitButtonOption & { run: () => void })[] = [
    {
      id: 'ssh',
      label: 'Add machine',
      description: 'A computer you reach over SSH',
      run: onAdd,
    },
    {
      id: 'maestro',
      label: 'Add Maestro host',
      description: 'The Maestro app on another computer, without SSH',
      run: onAddMaestroHost,
    },
    ...(onAddThisComputer
      ? [
          {
            id: 'this-computer',
            label: 'Add this computer',
            description:
              "Run conversations on this computer's workspace server, shared with computers that connect to it over SSH",
            run: onAddThisComputer,
          },
        ]
      : []),
    ...(onAddWslDistro
      ? [
          {
            id: 'wsl',
            label: 'Add WSL distro',
            description:
              'Run projects and agents in the next WSL2 distro on this computer that is not a machine yet',
            run: onAddWslDistro,
          },
        ]
      : []),
  ];
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        value={search.query}
        onValueChange={search.setQuery}
        placeholder="Search machines…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <SplitButton
          size="sm"
          variant="primary"
          options={addOptions}
          selectedId="ssh"
          icon={<PlusIcon />}
          onAction={(id) => addOptions.find((option) => option.id === id)?.run()}
        />
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
});

function MachinesEmptyState({ hasMachines }: { hasMachines: boolean }) {
  return (
    <EmptyState
      bare
      className="min-h-48"
      label={hasMachines ? 'No machines match your search' : 'No machines yet'}
      description={
        hasMachines
          ? 'Try a different name, host or username.'
          : 'Add a machine to run projects and agents on another computer.'
      }
    />
  );
}
