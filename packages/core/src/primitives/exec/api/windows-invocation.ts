/**
 * Builders for commands that run on Windows hosts, including over Windows OpenSSH Server.
 *
 * Windows OpenSSH hands an exec request to the account's configured default shell: `cmd.exe /c`
 * unless an administrator set `DefaultShell` to PowerShell, pwsh, or bash. Those shells disagree
 * on every quoting rule, so remote control commands never rely on any of them: each one is a
 * `powershell.exe -EncodedCommand <base64>` line whose only non-alphanumeric characters are
 * spaces, dashes, `+`, `/`, `=`, and `.`, which every one of those shells passes through
 * unchanged. Values reach the script as PowerShell single-quoted literals, never as shell text.
 */

/** cmd.exe rejects command lines longer than this many characters. */
export const WINDOWS_CMD_COMMAND_LINE_LIMIT = 8191;

/** Headroom kept below the cmd.exe limit for the shell's own `/c` wrapping. */
const ENCODED_COMMAND_LINE_BUDGET = WINDOWS_CMD_COMMAND_LINE_LIMIT - 191;

export const WINDOWS_POWERSHELL_EXECUTABLE = 'powershell.exe';

export type PowerShellCommandOptions = {
  /** Keeps the session open after the script runs (interactive terminals). */
  noExit?: boolean;
  /** Allows an interactive session; control commands stay non-interactive by default. */
  interactive?: boolean;
  /** Loads the user's PowerShell profile; only interactive terminals should want it. */
  loadProfile?: boolean;
  /**
   * Sets the process-scope execution policy to Bypass so the script can run a downloaded `.ps1`
   * file. Group Policy settings still take precedence over it.
   */
  bypassExecutionPolicy?: boolean;
};

/**
 * Formats a Windows PowerShell 5.1 invocation that runs `script` without any shell parsing of
 * the script text. Throws when the encoded line would not fit through cmd.exe.
 */
export function formatPowerShellEncodedCommand(
  script: string,
  options: PowerShellCommandOptions = {}
): string {
  const flags = ['-NoLogo'];
  if (!options.loadProfile) flags.push('-NoProfile');
  if (!options.interactive) flags.push('-NonInteractive');
  if (options.noExit) flags.push('-NoExit');
  if (options.bypassExecutionPolicy) flags.push('-ExecutionPolicy', 'Bypass');
  flags.push('-OutputFormat', 'Text', '-EncodedCommand', encodePowerShellCommand(script));
  const commandLine = [WINDOWS_POWERSHELL_EXECUTABLE, ...flags].join(' ');
  if (commandLine.length > ENCODED_COMMAND_LINE_BUDGET) {
    throw new Error(
      `PowerShell command is too long for a Windows command line ` +
        `(${commandLine.length} > ${ENCODED_COMMAND_LINE_BUDGET} characters)`
    );
  }
  return commandLine;
}

/** Base64 of the script's UTF-16LE bytes, the encoding `-EncodedCommand` expects. */
export function encodePowerShellCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index);
    bytes[index * 2] = unit & 0xff;
    bytes[index * 2 + 1] = unit >> 8;
  }
  return toBase64(bytes);
}

/**
 * A PowerShell single-quoted string literal. PowerShell also treats the typographic single
 * quotes U+2018–U+201B as quote characters, so those are doubled like `'`.
 */
export function powerShellLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/gu, (quote) => quote + quote)}'`;
}

/**
 * Quotes one argument so the Microsoft C runtime (`CommandLineToArgvW`, node, and most Windows
 * programs) reads it back unchanged. This is argv quoting for `CreateProcess`, not shell quoting:
 * never hand the result to cmd.exe.
 */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    } else {
      quoted += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

export function formatWindowsCommandLine(argv: readonly string[]): string {
  return argv.map(quoteWindowsArgument).join(' ');
}

/**
 * Script prologue for remote control scripts: stops on the first error, silences progress records,
 * and defines `Write-EmdashError`, which writes UTF-8 to stderr (PowerShell's own stderr uses the
 * OEM code page when redirected).
 */
export const POWERSHELL_SCRIPT_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'function Write-EmdashError([string]$message) {',
  '  $bytes = [Text.Encoding]::UTF8.GetBytes($message + "`n")',
  '  $stream = [Console]::OpenStandardError()',
  '  $stream.Write($bytes, 0, $bytes.Length)',
  '  $stream.Flush()',
  '}',
].join('\n');

/**
 * Wraps a script body so an uncaught error prints only its message (as UTF-8) and exits 1 instead
 * of emitting a CLIXML error record.
 */
export function wrapPowerShellScript(body: string): string {
  return [
    POWERSHELL_SCRIPT_PROLOGUE,
    'try {',
    body,
    '} catch {',
    '  Write-EmdashError $_.Exception.Message',
    '  exit 1',
    '}',
  ].join('\n');
}

/**
 * Converts `powershell.exe` stderr to plain text. With redirected output PowerShell serializes
 * progress, warning, and error records as CLIXML (`#< CLIXML` followed by `<Objs>` blocks); this
 * drops progress records, keeps error and warning text without invocation-position noise, and
 * leaves plain text untouched.
 */
export function decodePowerShellStderr(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr;
  const messages: string[] = [];
  const plain = stderr
    .replace(/#< CLIXML\r?\n?/gu, '')
    .replace(/<Objs\b[\s\S]*?<\/Objs>/gu, (block) => {
      for (const match of block.matchAll(/<S S="(Error|Warning|warning)">([\s\S]*?)<\/S>/gu)) {
        const text = decodeClixmlString(match[2] ?? '');
        messages.push(match[1] === 'Error' ? text : `WARNING: ${text}`);
      }
      return '';
    });
  const records = messages
    .join('')
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('At line:') && !trimmed.startsWith('+ ');
    })
    .join('\n');
  return [plain.trim(), records].filter((part) => part.length > 0).join('\n');
}

function decodeClixmlString(value: string): string {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/gu, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    output += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 0x3f] : '=';
  }
  return output;
}
