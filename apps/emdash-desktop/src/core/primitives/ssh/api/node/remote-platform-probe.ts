import {
  decodePowerShellStderr,
  formatPowerShellEncodedCommand,
  type PowerShellCommandOptions,
} from '@emdash/core/primitives/exec/api';
import {
  isWindowsUnameKernel,
  parseWindowsPlatformProbe,
  WINDOWS_PLATFORM_PROBE_SCRIPT,
  type RemotePlatformInfo,
} from '../remote-platform';
import type { SshClientProxy, SshExecOptions, SshExecResult } from './ssh-client-proxy';

export class RemotePlatformProbeError extends Error {
  readonly name = 'RemotePlatformProbeError';
}

type ProbeProxy = Pick<SshClientProxy, 'exec' | 'execScript'>;

const unameOptions = {
  timeoutMs: 10_000,
  maxStdoutBytes: 4_096,
  maxStderrBytes: 4_096,
} as const;

// A cold powershell.exe start (profile-less, but Defender-scanned) can take several seconds.
const powerShellOptions = {
  timeoutMs: 30_000,
  maxStdoutBytes: 16 * 1_024,
  maxStderrBytes: 16 * 1_024,
} as const;

/**
 * Runs a Windows PowerShell script on a Windows OpenSSH host. The command line is shell-neutral,
 * so it behaves the same whether the account's default shell is cmd, PowerShell, or bash.
 */
export async function execPowerShell(
  proxy: Pick<SshClientProxy, 'execScript'>,
  script: string,
  options?: SshExecOptions,
  commandOptions?: PowerShellCommandOptions
): Promise<SshExecResult> {
  const result = await proxy.execScript(
    formatPowerShellEncodedCommand(script, commandOptions),
    options
  );
  return { ...result, stderr: decodePowerShellStderr(result.stderr) };
}

/**
 * Identifies the remote operating system and the facts provisioning needs. Throws
 * RemotePlatformProbeError when the host answers neither as POSIX nor as Windows.
 */
export async function probeRemotePlatform(
  proxy: ProbeProxy,
  signal?: AbortSignal
): Promise<RemotePlatformInfo> {
  const uname = await proxy.exec({ command: 'uname', args: ['-s'] }, { ...unameOptions, signal });
  const kernel = uname.stdout.trim();
  if (uname.exitCode === 0 && kernel && !isWindowsUnameKernel(kernel)) {
    return { os: 'posix', kernel, home: await probePosixHome(proxy, signal) };
  }

  const windows = await execPowerShell(proxy, WINDOWS_PLATFORM_PROBE_SCRIPT, {
    ...powerShellOptions,
    signal,
  });
  const info = parseWindowsPlatformProbe(windows.stdout);
  if (info) return info;

  if (uname.exitCode === 0 && !kernel) {
    throw new RemotePlatformProbeError('Remote platform probe returned an incomplete response');
  }
  throw new RemotePlatformProbeError(
    'Could not identify the remote operating system. `uname -s` failed ' +
      `(${describeFailure(uname)}) and Windows PowerShell did not answer ` +
      `(${describeFailure(windows)}). Maestro supports Linux and macOS hosts, and Windows 10 1809 ` +
      'or Windows Server 2019 and later with OpenSSH Server.'
  );
}

async function probePosixHome(proxy: ProbeProxy, signal?: AbortSignal): Promise<string> {
  const result = await proxy.execScript(`printf '%s\\n' "$HOME"`, { ...unameOptions, signal });
  if (result.exitCode !== 0) {
    throw new RemotePlatformProbeError(
      `Remote host probe failed: ${result.stderr.trim() || result.exitCode}`
    );
  }
  const home = result.stdout.trim();
  if (!home)
    throw new RemotePlatformProbeError('Remote host probe returned an incomplete response');
  return home;
}

function describeFailure(result: SshExecResult): string {
  const detail = result.stderr.trim().split(/\r?\n/u)[0]?.trim();
  return detail ? `exit ${result.exitCode}: ${detail.slice(0, 200)}` : `exit ${result.exitCode}`;
}
