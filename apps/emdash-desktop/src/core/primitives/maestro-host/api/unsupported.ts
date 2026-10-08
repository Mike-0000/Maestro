/**
 * What a Maestro host cannot do because it is reached over the Maestro app's own WebSocket
 * listener: there is no SSH connection, so nothing on it can be installed, restarted, tunnelled,
 * or run through a shell channel from this computer.
 */
export type MaestroHostUnsupportedFeature =
  | 'workspace-server-control'
  | 'port-forwarding'
  | 'open-in-app'
  | 'ssh-connection'
  | 'ssh-settings';

const MESSAGES: Record<MaestroHostUnsupportedFeature, string> = {
  'workspace-server-control': 'Managed by the Maestro app on that computer',
  'port-forwarding': 'Port forwarding is not supported on Maestro hosts yet',
  'open-in-app': 'Opening a folder in another app is not supported on Maestro hosts yet',
  'ssh-connection': 'This machine is a Maestro host and has no SSH connection',
  'ssh-settings':
    'This machine is a Maestro host and connects without SSH, so it has no SSH settings to edit.',
};

export function maestroHostUnsupportedMessage(feature: MaestroHostUnsupportedFeature): string {
  return MESSAGES[feature];
}

/** Thrown instead of reaching for an SSH channel that a Maestro host does not have. */
export class MaestroHostUnsupportedError extends Error {
  readonly name = 'MaestroHostUnsupportedError';

  constructor(readonly feature: MaestroHostUnsupportedFeature) {
    super(maestroHostUnsupportedMessage(feature));
  }
}
