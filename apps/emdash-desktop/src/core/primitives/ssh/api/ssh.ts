import type { RemotePlatformSummary } from './remote-platform';

/**
 * SSH Connection Configuration
 * Used for storing SSH connection settings
 */
export interface SshConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  sshConfigAlias?: string;
  authType: 'password' | 'key' | 'agent';
  privateKeyPath?: string;
  useAgent?: boolean;
  forwardAgent?: boolean;
  proxyJump?: string;
  /**
   * Opt-in "Sync local settings" toggle: while true, this desktop mirrors its
   * local settings in this class (currently watcher exclusions) to this host.
   * Stored in connection metadata; absent means false.
   */
  syncLocalSettings?: boolean;
  /**
   * 'local' is this computer's shared Host: the desktop runs its workspace server directly, without
   * SSH, so conversations started here or from other computers over SSH appear in one place.
   * 'maestro' reaches the Maestro app on another computer over its WebSocket listener: there is
   * no SSH connection and no shell channel, so the SSH fields above are placeholders.
   * Stored in connection metadata; absent means SSH.
   */
  transport?: 'local' | 'maestro';
  /** Endpoint of a 'maestro' machine. Its device token and Cloudflare secret are never here. */
  maestro?: { url: string; hostId?: string; cfAccessClientId?: string };
}

/**
 * Connection State
 * Represents the current state of an SSH connection
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type SshHealthState = { status: 'ok' } | { status: 'degraded' };

/**
 * SSH Connection with metadata
 * Extends SshConfig with runtime connection information
 */
export interface SshConnection extends SshConfig {
  id: string;
  state: ConnectionState;
  lastError?: string;
  connectedAt?: Date;
}

export type SshConnectionUsage = Record<string, Array<{ id: string; name: string }>>;

/**
 * Command execution result
 * Returned after executing a command on a remote host
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Test connection result
 * Returned when testing an SSH connection
 */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  latency?: number;
  serverVersion?: string;
  debugLogs?: string[];
  /** The remote OS and any setup problems, when SSH succeeded and the platform check answered. */
  platform?: RemotePlatformSummary;
  /** Why the platform check failed after SSH succeeded. */
  platformError?: string;
}

/**
 * SSH Config Host entry parsed from ~/.ssh/config
 */
export interface SshConfigHost {
  host: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  identityAgent?: string;
  proxyJump?: string;
  proxyCommand?: string;
  forwardAgent?: boolean;
  forwardAgentValue?: string;
}
