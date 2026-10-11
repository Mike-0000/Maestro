import { SettingsRow } from '@emdash/ui/react/patterns';
import { Button } from '@emdash/ui/react/primitives';
import { Cog, KeyRoundIcon, PlugIcon } from 'lucide-react';
import { MAESTRO_HOST_NOT_PAIRED_MESSAGE } from '@core/primitives/maestro-host/api/messages';
import type { ConnectionState, SshConfig } from '@core/primitives/ssh/api';
import type { HostAvailabilityState } from '@core/services/hosts/api';
import { maestroHostEndpointLabel } from '../maestro-host-form-model';
import { authLabel } from './machine-formatters';
import { MachineBadge } from './MachineBadge';

export function MachineConnectionRow({
  machine,
  state,
  availability,
  onEdit,
  onConnect,
  onRetry,
  onDisconnect,
  onPairAgain,
}: {
  machine: SshConfig;
  state: ConnectionState;
  availability: HostAvailabilityState | undefined;
  onEdit: () => void;
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
  /** Maestro hosts only: pair this device again after the host revoked it. */
  onPairAgain?: () => void;
}) {
  const transportActive =
    state === 'connected' || state === 'connecting' || state === 'reconnecting';
  const preparing = availability?.kind === 'preparing';
  const ready = availability?.kind === 'ready';
  const retry = availability?.kind === 'unavailable' && availability.issue !== undefined;
  const local = machine.transport === 'local';
  const maestro = machine.transport === 'maestro';
  const wsl = machine.transport === 'wsl';
  // Retrying cannot help once the host has revoked this device; only a new pairing can.
  const unpaired =
    maestro &&
    availability?.kind === 'unavailable' &&
    availability.issue?.message === MAESTRO_HOST_NOT_PAIRED_MESSAGE;

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          {local || wsl ? 'Connection' : maestro ? 'Maestro host' : 'SSH Connection'}
          <MachineBadge state={state} />
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {local
              ? `This computer, without SSH · ${machine.username} · shared with SSH clients of this computer`
              : wsl
                ? `WSL2 distro ${machine.wsl?.distro ?? ''} on this computer · projects and agents run on its Linux filesystem`
                : maestro
                  ? `${maestroHostEndpointLabel(machine)} · paired with the Maestro app on that computer${
                      machine.maestro?.cfAccessClientId ? ' · through Cloudflare Access' : ''
                    }`
                  : `${machine.host} · ${machine.username} · ${authLabel(machine)}`}
          </span>
          {maestro && availability?.kind === 'unavailable' && availability.issue ? (
            <span className="basis-full text-foreground-destructive">
              {availability.issue.message}
            </span>
          ) : null}
        </span>
      }
      control={
        <span className="flex items-center gap-2">
          {unpaired && onPairAgain ? (
            <Button type="button" variant="primary" size="xs" onClick={onPairAgain}>
              <KeyRoundIcon />
              Pair again
            </Button>
          ) : availability && !ready && !preparing ? (
            <Button type="button" variant="primary" size="xs" onClick={retry ? onRetry : onConnect}>
              <PlugIcon />
              {retry ? 'Retry' : 'Connect'}
            </Button>
          ) : null}
          {transportActive || preparing ? (
            <Button type="button" variant="destructive" size="xs" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : null}
          {local ? null : (
            <Button type="button" variant="secondary" size="xs" icon onClick={onEdit}>
              <Cog />
            </Button>
          )}
        </span>
      }
    />
  );
}
