import { MachineStatus, type MachineStatusKind } from '@emdash/ui/react/components';
import { CollectionViewCell } from '@emdash/ui/react/patterns';
import { observer } from 'mobx-react-lite';
import type { SshConfig } from '@core/primitives/ssh/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { maestroHostEndpointLabel } from '../maestro-host-form-model';
import { useMachineStatusKind } from '../use-machine-status-kind';

const STATUS_TEXT: Record<MachineStatusKind, string> = {
  successful: 'Connected',
  initializing: 'Connecting…',
  error: 'Connection issue',
  idle: 'Not connected',
};

function machineEndpoint(machine: SshConfig): string {
  if (machine.transport === 'local') return 'This computer, shared without SSH';
  if (machine.transport === 'maestro') return `Maestro host · ${maestroHostEndpointLabel(machine)}`;
  if (machine.transport === 'wsl') return `WSL2 distro · ${machine.wsl?.distro ?? 'unknown'}`;
  const host = machine.sshConfigAlias?.trim() || machine.host;
  const target = machine.username ? `${machine.username}@${host}` : host;
  return machine.port !== 22 ? `${target}:${machine.port}` : target;
}

/** Freeform row content for the Machines CollectionView; the shell owns click handling. */
export const MachineListRow = observer(function MachineListRow({
  machine,
}: {
  machine: SshConfig;
}) {
  const machineStatus = useMachineStatusKind({
    machineId: machine.id,
  });

  // The machine mark carries the state's dot; the words beside it say it, and only a
  // connection problem is coloured.
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <MachineStatus status={machineStatus} size="1.5rem" className="shrink-0" />
      <CollectionViewCell
        className="min-w-0 flex-1"
        primary={machine.name}
        secondary={machineEndpoint(machine)}
      />
      <span
        className={cn(
          'shrink-0 text-xs',
          machineStatus === 'error'
            ? 'text-foreground-error'
            : machineStatus === 'successful'
              ? 'text-foreground-muted'
              : 'text-foreground-passive'
        )}
      >
        {STATUS_TEXT[machineStatus]}
      </span>
    </div>
  );
});
