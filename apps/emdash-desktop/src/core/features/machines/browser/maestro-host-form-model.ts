import { normalizeMaestroHostUrl } from '@core/primitives/maestro-host/api/endpoint';
import type { SshConfig } from '@core/primitives/ssh/api';

/** `add` pairs with a new host; `repair` pairs an existing machine again; `edit` moves it. */
export type MaestroHostFormMode = 'add' | 'repair' | 'edit';

export type MaestroHostFormValues = {
  url: string;
  code: string;
  cfAccessClientId: string;
  /** Never prefilled: saved secrets do not leave the main process. */
  cfAccessClientSecret: string;
};

export function maestroHostFormDefaults(machine?: SshConfig): MaestroHostFormValues {
  return {
    url: machine?.maestro?.url ?? '',
    code: '',
    cfAccessClientId: machine?.maestro?.cfAccessClientId ?? '',
    cfAccessClientSecret: '',
  };
}

export function maestroHostFormTitle(mode: MaestroHostFormMode): string {
  if (mode === 'repair') return 'Pair again';
  return mode === 'edit' ? 'Edit Maestro host' : 'Add Maestro host';
}

export function maestroHostSubmitLabel(mode: MaestroHostFormMode): string {
  if (mode === 'repair') return 'Pair';
  return mode === 'edit' ? 'Save' : 'Add host';
}

/**
 * The first problem that can be found without asking the host, or null. `check` validates only
 * what identifying an address needs. The main process validates again and has the final say.
 */
export function validateMaestroHostForm(
  values: MaestroHostFormValues,
  purpose: MaestroHostFormMode | 'check'
): string | null {
  if (purpose !== 'repair') {
    const url = normalizeMaestroHostUrl(values.url);
    if (!url.success) return url.error.message;
    if (values.cfAccessClientSecret.trim() && !values.cfAccessClientId.trim()) {
      return 'Enter the Cloudflare Access client ID that goes with the client secret.';
    }
  }
  if ((purpose === 'add' || purpose === 'repair') && !values.code.trim()) {
    return 'Enter the pairing code shown by the host.';
  }
  return null;
}

/** What the machine list and the connection row show in place of `user@host`. */
export function maestroHostEndpointLabel(machine: SshConfig): string {
  return machine.maestro?.url ?? machine.host;
}
