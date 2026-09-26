export type ShellFamily = 'posix' | 'csh' | 'windows-cmd' | 'powershell' | 'wsl';

export type Command = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export function quoteArg(value: string, family: ShellFamily): string {
  switch (family) {
    case 'posix':
    case 'wsl':
      return quotePosixArg(value);
    case 'csh':
      return quoteCshArg(value);
    case 'windows-cmd':
      return quoteCmdArg(value);
    case 'powershell':
      return quotePowerShellArg(value);
  }
}

export function formatCommandLine(
  command: Pick<Command, 'command' | 'args'>,
  family: ShellFamily
): string {
  const commandLine = [command.command, ...command.args]
    .map((value) => quoteArg(value, family))
    .join(' ');
  return family === 'powershell' ? `& ${commandLine}` : commandLine;
}

function quotePosixArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9.,_:/@=+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteCshArg(value: string): string {
  return quotePosixArg(value).replaceAll('!', '\\!');
}

/**
 * Quotes one argument for a cmd.exe command line (`cmd /c`), including one that runs a `.cmd`
 * shim which forwards `%*` to a program. The whole value stays inside double quotes, where cmd
 * treats `^ & | < > ( )` literally, so none of them are escaped: a caret would reach the program.
 * Embedded quotes become `""`, which keeps cmd's quote state balanced and which the Microsoft C
 * runtime (and so node, Bun, and most Windows programs) reads back as one literal quote;
 * backslashes before a quote or the closing quote are doubled for the same parser. `%` becomes
 * `%%cd:~,%` (a literal `%` followed by an empty substring expansion), because cmd expands
 * `%VAR%` even inside quotes and does not collapse `%%` on a command line. cmd ends a command at a
 * line break, so line breaks are flattened to spaces: callers that must keep them (multi-line
 * prompts) need another channel, such as a file.
 */
function quoteCmdArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"^&|<>()%!]/.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value.replace(/\r\n|[\r\n]/g, ' ')) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2)}""`;
    } else {
      quoted += '\\'.repeat(backslashes) + (char === '%' ? '%%cd:~,%' : char);
    }
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

function quotePowerShellArg(value: string): string {
  if (value.length === 0) return "''";
  if (!/[\s'`"$;&|<>(){}[\],]/.test(value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}
