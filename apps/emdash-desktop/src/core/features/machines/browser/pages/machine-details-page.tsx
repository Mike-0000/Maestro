import { EmptyState, MachineStatus } from '@emdash/ui/react/components';
import {
  EntityHeader,
  getPillTabId,
  SettingsRow,
  SettingsSection,
} from '@emdash/ui/react/patterns';
import { Button, DropdownMenu, Heading, Input, Tabs, toast } from '@emdash/ui/react/primitives';
import { EllipsisIcon, KeyRoundIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { McpPanel } from '@core/features/mcp/contributions/browser/McpPanel';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { AgentsPanel } from '@core/features/settings/contributions/browser/agents-page/AgentsPanel';
import { SkillsPanel } from '@core/features/skills/contributions/browser/SkillsPanel';
import { WorkspaceDetailPage } from '@core/features/workspaces/contributions/browser/workspace-detail-page';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { maestroHostUnsupportedMessage } from '@core/primitives/maestro-host/api/unsupported';
import type { SettingsPageDetailProps } from '@core/primitives/settings/api/page-contribution';
import { cn } from '@core/primitives/styling/browser/cn';
import { isServerUsable } from '@core/services/hosts/api';
import { HostSettingsCard } from '../components/host-settings-card';
import { MachineConnectionRow } from '../components/machine-connection-card';
import { MachineConversationsList } from '../components/machine-conversations-list';
import { ResourceUtilizationRow } from '../components/machine-resources';
import { deriveMachineStatusKind } from '../components/machine-status-kind';
import { MachineSystemDependenciesCard } from '../components/machine-system-dependencies';
import { WorkspaceRuntimeRow } from '../components/workspace-server-card';
import { WorkspacesListView } from '../components/workspaces-list-view';
import { useHostServerState } from '../use-host-server-state';
import { useMachineMetrics } from '../use-machine-metrics';
import { useMachineAvailability } from '../use-machine-status-kind';

type MachineDetailsSection =
  | 'system'
  | 'workspaces'
  | 'conversations'
  | 'agents'
  | 'mcp'
  | 'skills';

const MACHINE_DETAILS_PANEL_ID = 'machine-details-panel';

/** Plain words with an underline under the one on screen, like the project page's sections. */
const machineDetailsTabs: readonly { value: MachineDetailsSection; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'agents', label: 'Agents' },
  { value: 'mcp', label: 'MCP' },
  { value: 'skills', label: 'Skills' },
];

/**
 * Machines tab child detail: path is `[connectionId, projectId]`. Lives here
 * (not in the shared workspace-detail-page) because it owns the machine
 * connection-state lookup, which core-host boundaries allow for this file.
 */
export const MachineWorkspaceDetailPage = observer(function MachineWorkspaceDetailPage(
  props: SettingsPageDetailProps
) {
  const machineId = props.path[0];
  const machine = getMachinesStore().connections.find((connection) => connection.id === machineId);
  const project = asAvailableProject(getProjectStore(props.detailId));
  if (!machineId) return null;
  return (
    <WorkspaceDetailPage
      scope={{ kind: 'machine', machineId }}
      host={project?.host}
      machineName={machine?.name}
      projectId={props.detailId}
      onDeletedAll={props.closeDetail}
    />
  );
});

export const MachineDetailsPage = observer(function MachineDetailsPage({
  detailId,
  openDetail,
  closeDetail,
}: SettingsPageDetailProps) {
  const machinesStore = getMachinesStore();
  const machine = machinesStore.connections.find((connection) => connection.id === detailId);
  const openConfirm = useOpenModal('confirmActionModal');
  const openMachineModal = useOpenModal('addSshConnModal');
  const openMaestroHostModal = useOpenModal('maestroHostModal');
  const state = machine ? machinesStore.stateFor(machine.id) : 'disconnected';
  const connected = state === 'connected';
  const availability = useMachineAvailability(machine?.id);
  const [name, setName] = useState(machine?.name ?? '');
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useState<MachineDetailsSection>('system');
  const renameFieldRef = useRef<HTMLInputElement>(null);
  const workspaceServer = useHostServerState({
    machineId: machine?.id,
    enabled: !!machine,
    connected,
  });
  const machineStatus = deriveMachineStatusKind({ availability });
  const serverUsable = isServerUsable(workspaceServer.state);
  const metrics = useMachineMetrics(machine?.id, serverUsable);

  useEffect(() => {
    setName(machine?.name ?? '');
  }, [machine?.id, machine?.name]);

  useEffect(() => {
    if (isRenaming) {
      renameFieldRef.current?.focus();
      renameFieldRef.current?.select();
    }
  }, [isRenaming]);

  if (!machine) return null;

  const commitName = async (value: string) => {
    const nextName = value.trim();
    if (!nextName || nextName === machine.name) {
      setName(machine.name);
      setIsRenaming(false);
      return;
    }

    try {
      await machinesStore.renameConnection(machine.id, nextName);
      setIsRenaming(false);
    } catch (error) {
      setName(machine.name);
      toast.error('Failed to rename machine', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const connectMachine = async () => {
    try {
      await machinesStore.connect(machine.id);
    } catch {
      toast.error('Could not request a Machine connection');
    }
  };

  const retryMachine = async () => {
    try {
      await machinesStore.retry(machine.id);
    } catch {
      toast.error('Could not retry the Machine connection');
    }
  };

  const disconnectMachine = async () => {
    try {
      await machinesStore.disconnect(machine.id);
    } catch {
      toast.error('Could not disconnect the Machine');
    }
  };

  // A Maestro host has no SSH settings: its form edits the address and pairs the device.
  const maestro = machine.transport === 'maestro';
  const editConnectionSettings = () => {
    if (maestro) void openMaestroHostModal({ mode: 'edit', machine });
    else void openMachineModal({ dismissControl: 'close', initialConfig: machine });
  };
  const pairAgain = () => {
    void openMaestroHostModal({ mode: 'repair', machine });
  };

  const requestDelete = async () => {
    setDeleting(true);
    try {
      const usage = await (await getMachinesClient()).getMachineUsage(undefined);
      const projects = usage[machine.id] ?? [];

      if (projects.length > 0) {
        await openConfirm({
          title: 'Cannot delete SSH connection',
          description:
            'This SSH connection is still used by at least one project. Change those projects to another connection before deleting it.',
          confirmLabel: 'Close',
        });
        return;
      }

      const outcome = await openConfirm({
        title: 'Delete SSH connection',
        description: `This will remove "${machine.name}" and its saved credentials from this device.`,
        confirmLabel: 'Delete',
        variant: 'destructive',
      });
      if (!outcome.success) return;

      await machinesStore.deleteConnection(machine.id);
      closeDetail();
    } catch (error) {
      toast.error('Failed to delete SSH connection', { description: String(error) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 pb-16">
      <EntityHeader
        icon={<MachineStatus size="2rem" status={machineStatus} />}
        title={
          isRenaming ? (
            <Input
              bare
              ref={renameFieldRef}
              value={name}
              aria-label="Machine name"
              className="h-auto min-w-0 flex-1 px-0 text-xl"
              onChange={(e) => setName(e.target.value)}
              onBlur={(event) => void commitName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.currentTarget.value = machine.name;
                  setName(machine.name);
                  setIsRenaming(false);
                }
              }}
            />
          ) : (
            <Heading level={1} tone="default" className="min-w-0 flex-1 truncate">
              {machine.name}
            </Heading>
          )
        }
        actions={
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              render={
                <Button type="button" variant="ghost" size="sm" icon aria-label="Machine actions" />
              }
            >
              <EllipsisIcon />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onClick={() => setIsRenaming(true)} disabled={isRenaming}>
                <PencilIcon />
                Rename
              </DropdownMenu.Item>
              {maestro ? (
                <DropdownMenu.Item onClick={pairAgain}>
                  <KeyRoundIcon />
                  Pair again
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                variant="destructive"
                disabled={deleting}
                onClick={() => void requestDelete()}
              >
                <Trash2Icon />
                {deleting ? 'Deleting…' : 'Delete'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        }
      />

      <Tabs.Root
        value={section}
        onValueChange={(next) => {
          if (next != null) setSection(next as MachineDetailsSection);
        }}
      >
        <Tabs.List
          variant="underline"
          aria-label="Machine details sections"
          activateOnFocus
          className="-ml-2 flex-wrap"
        >
          {machineDetailsTabs.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              value={tab.value}
              size="sm"
              id={getPillTabId(MACHINE_DETAILS_PANEL_ID, tab.value)}
              aria-controls={MACHINE_DETAILS_PANEL_ID}
            >
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <section
        role="tabpanel"
        id={MACHINE_DETAILS_PANEL_ID}
        aria-labelledby={getPillTabId(MACHINE_DETAILS_PANEL_ID, section)}
        className="flex flex-col gap-10"
      >
        {section === 'system' && (
          <>
            <SettingsSection title="Connection">
              <MachineConnectionRow
                machine={machine}
                state={state}
                availability={availability}
                onEdit={editConnectionSettings}
                onConnect={connectMachine}
                onRetry={retryMachine}
                onDisconnect={disconnectMachine}
                onPairAgain={maestro ? pairAgain : undefined}
              />
              <NeedsConnection connected={connected}>
                {maestro ? (
                  <SettingsRow
                    label="Workspace runtime"
                    description={
                      workspaceServer.state?.version
                        ? `${maestroHostUnsupportedMessage('workspace-server-control')} · Maestro v${workspaceServer.state.version}`
                        : maestroHostUnsupportedMessage('workspace-server-control')
                    }
                    control={null}
                  />
                ) : (
                  <WorkspaceRuntimeRow
                    availability={availability}
                    connected={connected}
                    loading={workspaceServer.loading}
                    state={workspaceServer.state}
                    actions={workspaceServer}
                  />
                )}
              </NeedsConnection>
            </SettingsSection>

            <NeedsConnection connected={connected}>
              <ResourceUtilizationRow metrics={metrics} />
            </NeedsConnection>

            {serverUsable ? (
              <>
                <HostSettingsCard machineId={machine.id} />
                <MachineSystemDependenciesCard
                  machineId={machine.id}
                  machinesStore={machinesStore}
                />
              </>
            ) : (
              <SettingsSection title="Host defaults and tools">
                <ServerRequired description="Host defaults and system dependency checks appear once this machine is connected and its workspace server is running." />
              </SettingsSection>
            )}
          </>
        )}

        {section === 'workspaces' && (
          <WorkspacesListView
            scope={{ kind: 'machine', machineId: machine.id }}
            openDetail={openDetail}
            enabled={serverUsable}
          />
        )}

        {/* Reads this device's registry cache, so it stays available while the host is offline. */}
        {section === 'conversations' && (
          <MachineConversationsList
            scope={{ kind: 'remote', connectionId: machine.id }}
            hostReachable={connected}
          />
        )}

        {section === 'agents' &&
          (serverUsable ? (
            <AgentsPanel connectionId={machine.id} onManageMcp={() => setSection('mcp')} />
          ) : (
            <ServerRequired description="Agents on this machine are detected once it is connected and its workspace server is running." />
          ))}

        {section === 'mcp' &&
          (serverUsable ? (
            <McpPanel host={hostRefFromConnectionId(machine.id)} />
          ) : (
            <ServerRequired description="MCP servers on this machine appear once it is connected and its workspace server is running." />
          ))}

        {section === 'skills' &&
          (serverUsable ? (
            <SkillsPanel host={hostRefFromConnectionId(machine.id)} />
          ) : (
            <ServerRequired description="Skills on this machine appear once it is connected and its workspace server is running." />
          ))}
      </section>
    </div>
  );
});

/** Dims what only works over a live connection, and keeps it out of reach until then. */
function NeedsConnection({ connected, children }: { connected: boolean; children: ReactNode }) {
  return (
    <div aria-disabled={!connected} className={cn(!connected && 'pointer-events-none opacity-40')}>
      {children}
    </div>
  );
}

/** The quiet panel shown where a feature waits on this machine's workspace server. */
function ServerRequired({ description }: { description: string }) {
  return (
    <EmptyState
      bare
      className="min-h-40"
      label="Waiting for the workspace server"
      description={description}
    />
  );
}
