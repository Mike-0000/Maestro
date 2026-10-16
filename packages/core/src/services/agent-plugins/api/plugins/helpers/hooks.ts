import { Buffer } from 'node:buffer';
import { quoteArg } from '#primitives/exec/api';

export type HookCommandOptions = {
  platform?: NodeJS.Platform;
  stdoutJson?: Record<string, unknown>;
  /**
   * How a Windows command starts PowerShell. `cmd` (the default) chains a marker `set` and
   * PowerShell with `&&`; `powershell` starts PowerShell directly, for agents that run hook
   * commands through Windows PowerShell 5.1, which has no `&&` and fails the whole line.
   */
  windowsLauncher?: WindowsHookLauncher;
};

export type WindowsHookLauncher = 'cmd' | 'powershell';

export const EMDASH_MARKER = 'EMDASH_HOOK_PORT';
export const EMDASH_HOOK_CONFIG_VERSION = 1;
export const EMDASH_HOOK_VERSION_MARKER = `EMDASH_HOOK_CONFIG_VERSION=${EMDASH_HOOK_CONFIG_VERSION}`;
export const EMDASH_HOOK_POSIX_GUARD =
  'if [ -z "${EMDASH_HOOK_PORT:-}" ] || [ -z "${EMDASH_HOOK_NONCE:-}" ] || [ -z "${EMDASH_PTY_ID:-}" ]; then exit 0; fi';

/** Filter out emdash-managed entries from a hook array. */
export function filterUserHooks<T>(entries: T[], stringify?: (entry: T) => string): T[] {
  const toStr = stringify ?? JSON.stringify;
  return entries.filter((entry) => !isEmdashHookText(toStr(entry)));
}

const ENCODED_COMMAND = /-EncodedCommand\s+([A-Za-z0-9+/]+=*)/gi;

/**
 * Whether hook config text holds an emdash-managed command. A command that starts PowerShell
 * directly carries the marker only inside its encoded script, so that script is read too.
 */
export function isEmdashHookText(text: string): boolean {
  if (text.includes(EMDASH_MARKER)) return true;
  for (const match of text.matchAll(ENCODED_COMMAND)) {
    if (Buffer.from(match[1], 'base64').toString('utf16le').includes(EMDASH_MARKER)) return true;
  }
  return false;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type HookPostPayload = 'stdin' | { json: Record<string, string> };

function makePosixHookPostCommand(eventType: string, payload: HookPostPayload): string {
  const payloadPart =
    payload === 'stdin' ? '-d @- ' : `--data-binary '${JSON.stringify(payload.json)}' `;
  return (
    `${EMDASH_HOOK_VERSION_MARKER}; ${EMDASH_HOOK_POSIX_GUARD}; curl -sf -X POST ` +
    '-H "Content-Type: application/json" ' +
    '-H "X-Emdash-Token: $EMDASH_HOOK_NONCE" ' +
    '-H "X-Emdash-Pty-Id: $EMDASH_PTY_ID" ' +
    `-H "X-Emdash-Event-Type: ${eventType}" ` +
    payloadPart +
    '"http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true'
  );
}

function makeWindowsHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  stdoutJson?: Record<string, unknown>,
  launcher: WindowsHookLauncher = 'cmd'
): string {
  // The agent writes UTF-8, which Windows PowerShell decodes with the console code page and would
  // post as Latin-1, garbling every non-ASCII character. Encoding the text back with the code
  // page it was decoded with restores the agent's own bytes, and a byte body is posted as it is.
  const bodyLine =
    payload === 'stdin'
      ? '$payload = [Console]::InputEncoding.GetBytes([Console]::In.ReadToEnd())'
      : `$payload = ${quotePowerShellString(JSON.stringify((payload as { json: Record<string, string> }).json))}`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'if (-not $env:EMDASH_HOOK_PORT -or -not $env:EMDASH_HOOK_NONCE -or -not $env:EMDASH_PTY_ID) { exit 0 }',
    bodyLine,
    'try { Invoke-WebRequest -UseBasicParsing -Method POST ' +
      "-Uri ('http://127.0.0.1:' + $env:EMDASH_HOOK_PORT + '/hook') " +
      '-Headers @{ ' +
      "'Content-Type' = 'application/json'; " +
      "'X-Emdash-Token' = $env:EMDASH_HOOK_NONCE; " +
      "'X-Emdash-Pty-Id' = $env:EMDASH_PTY_ID; " +
      `'X-Emdash-Event-Type' = '${eventType}' ` +
      '} -Body $payload | Out-Null } catch { exit 0 }',
  ].join('; ');
  return makeWindowsPowerShellHookCommand(
    stdoutJson === undefined
      ? script
      : `try { ${script} } finally { [Console]::Out.WriteLine(${quotePowerShellString(JSON.stringify(stdoutJson))}) }`,
    launcher
  );
}

export function makeWindowsPowerShellHookCommand(
  script: string,
  launcher: WindowsHookLauncher = 'cmd'
): string {
  if (launcher === 'powershell') {
    // One plain command that every shell runs the same way: PowerShell 5.1, pwsh, cmd.exe and
    // Git Bash. The markers ride inside the encoded script, where isEmdashHookText finds them.
    const encoded = Buffer.from(`<# ${EMDASH_HOOK_VERSION_MARKER} #> ${script}`, 'utf16le');
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded.toString('base64')}`;
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // A silent `set` no-op embeds both markers so hook-config cleanup can find
  // our entries. No `>NUL`: an outer shell (Git Bash/PowerShell) parses the
  // redirect before cmd.exe and creates a real `NUL` file. No quotes either —
  // they break when the body is re-wrapped in `cmd.exe /c`. Markers go in the
  // value, not the var name, so they can't shadow EMDASH_HOOK_PORT/NONCE/PTY_ID.
  return (
    `cmd.exe /d /c set EMDASH_HOOK_MARKER=${EMDASH_HOOK_VERSION_MARKER} ${EMDASH_MARKER}&&` +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  );
}

/** Post an event with an arbitrary payload, platform-aware. */
export function makeHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  opts: HookCommandOptions
): string {
  if ((opts.platform ?? process.platform) === 'win32') {
    return makeWindowsHookPostCommand(eventType, payload, opts.stdoutJson, opts.windowsLauncher);
  }
  const command = makePosixHookPostCommand(eventType, payload);
  return opts.stdoutJson === undefined
    ? command
    : `( ${command} ) >/dev/null; printf '%s\\n' ${quoteArg(JSON.stringify(opts.stdoutJson), 'posix')}`;
}

// ── Public command builders ─────────────────────────────────────────────────

/**
 * Standard stdin-piped hook command.
 * The agent pipes the event JSON body through stdin.
 */
export function makeStdinHookCommand(eventType: string, opts: HookCommandOptions = {}): string {
  return makeHookPostCommand(eventType, 'stdin', opts);
}

/**
 * Fixed-body notification hook command.
 * Sends a JSON body with a `notification_type` key (used by Codex-style events).
 */
export function makeNotificationHookCommand(
  notificationType: 'idle_prompt' | 'permission_prompt',
  opts: HookCommandOptions = {}
): string {
  return makeHookPostCommand(
    'notification',
    { json: { notification_type: notificationType } },
    opts
  );
}
