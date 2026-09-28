export type LocalWorkspaceServerTarget = {
  kind: 'local-socket';
  socketPath: string;
};

/**
 * How the desktop reaches a remote daemon's socket path: OpenSSH streamlocal forwarding on POSIX
 * hosts, or an exec-channel relay to the daemon's named pipe on Windows OpenSSH hosts, which do
 * not forward Unix sockets.
 */
export type SshWorkspaceServerChannel = 'streamlocal' | 'windows-pipe-bridge';

export type SshWorkspaceServerTarget = {
  kind: 'ssh';
  sshConnectionId: string;
  socketPath: string;
  channel: SshWorkspaceServerChannel;
};

export type WorkspaceServerTarget = LocalWorkspaceServerTarget | SshWorkspaceServerTarget;
