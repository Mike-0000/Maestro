import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  decodePowerShellStderr,
  encodePowerShellCommand,
  formatPowerShellEncodedCommand,
  formatWindowsCommandLine,
  powerShellLiteral,
  quoteWindowsArgument,
  WINDOWS_CMD_COMMAND_LINE_LIMIT,
  wrapPowerShellScript,
} from './windows-invocation';

const ENCODED_LINE =
  /^powershell\.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand [A-Za-z0-9+/=]+$/;

describe('encodePowerShellCommand', () => {
  it('encodes UTF-16LE base64 like PowerShell expects', () => {
    expect(encodePowerShellCommand('exit 0')).toBe(
      Buffer.from('exit 0', 'utf16le').toString('base64')
    );
    const unicode = "Write-Output 'José – 日本 🚀'";
    expect(encodePowerShellCommand(unicode)).toBe(
      Buffer.from(unicode, 'utf16le').toString('base64')
    );
  });

  it('pads every remainder length', () => {
    for (const script of ['', 'a', 'ab', 'abc', 'abcd']) {
      expect(encodePowerShellCommand(script)).toBe(
        Buffer.from(script, 'utf16le').toString('base64')
      );
    }
  });
});

describe('formatPowerShellEncodedCommand', () => {
  it('uses only characters every Windows default shell passes through', () => {
    const line = formatPowerShellEncodedCommand(
      `& 'C:\\Program Files\\x' "$env:USERPROFILE" | %{$_}`
    );

    expect(line).toMatch(ENCODED_LINE);
  });

  it('adds -NoExit for interactive sessions', () => {
    expect(
      formatPowerShellEncodedCommand('Set-Location C:\\', { noExit: true, interactive: true })
    ).toMatch(/^powershell\.exe -NoLogo -NoProfile -NoExit -OutputFormat Text -EncodedCommand /);
  });

  it('can load the user profile for interactive terminals', () => {
    expect(
      formatPowerShellEncodedCommand('exit 0', {
        noExit: true,
        interactive: true,
        loadProfile: true,
      })
    ).toMatch(/^powershell\.exe -NoLogo -NoExit -OutputFormat Text -EncodedCommand /);
  });

  it('can bypass the process-scope execution policy', () => {
    expect(formatPowerShellEncodedCommand('exit 0', { bypassExecutionPolicy: true })).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand [A-Za-z0-9+/=]+$/
    );
  });

  it('refuses scripts that would overflow the cmd.exe command line', () => {
    expect(() => formatPowerShellEncodedCommand('x'.repeat(4000))).toThrow('too long');
    expect(formatPowerShellEncodedCommand('x'.repeat(2800)).length).toBeLessThan(
      WINDOWS_CMD_COMMAND_LINE_LIMIT
    );
  });
});

describe('powerShellLiteral', () => {
  it('doubles ASCII and typographic single quotes', () => {
    expect(powerShellLiteral('')).toBe("''");
    expect(powerShellLiteral("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(powerShellLiteral('a\u2019b\u2018c')).toBe("'a\u2019\u2019b\u2018\u2018c'");
    expect(powerShellLiteral('$(evil) `n "x"')).toBe('\'$(evil) `n "x"\'');
  });
});

describe('quoteWindowsArgument', () => {
  it('follows the Microsoft C runtime rules', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain');
    expect(quoteWindowsArgument('C:\\no-space\\')).toBe('C:\\no-space\\');
    expect(quoteWindowsArgument('')).toBe('""');
    expect(quoteWindowsArgument('C:\\Program Files\\node.exe')).toBe(
      '"C:\\Program Files\\node.exe"'
    );
    expect(quoteWindowsArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it.runIf(process.platform === 'win32')('round-trips through a real Windows process', () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const args = ['plain', '', 'C:\\dir with space\\', 'say "hi"', 'a\\"b', 'tab\there', '%PATH%'];

    const result = spawnSync(
      process.execPath,
      [formatWindowsCommandLine(['-e', script, ...args])],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});

describe('decodePowerShellStderr', () => {
  it('leaves plain stderr untouched', () => {
    expect(decodePowerShellStderr('plain failure\n')).toBe('plain failure\n');
  });

  it('drops progress records and keeps error text without invocation noise', () => {
    const stderr = [
      '#< CLIXML',
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
        '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
        '</TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV>' +
        '</PR></MS></Obj>' +
        '<S S="Error">Cannot find path &apos;C:\\x&lt;1&gt;&apos;_x000D__x000A_</S>' +
        '<S S="Error">At line:1 char:1_x000D__x000A_</S>' +
        '<S S="Error">+ Get-Item x_x000D__x000A_</S>' +
        '<S S="warning">careful_x000A_</S></Objs>',
    ].join('\r\n');

    expect(decodePowerShellStderr(stderr)).toBe("Cannot find path 'C:\\x<1>'\nWARNING: careful");
  });

  it('keeps plain text that precedes the CLIXML block', () => {
    const stderr = 'native tool failed\r\n#< CLIXML\r\n<Objs Version="1.1.0.1"></Objs>';
    expect(decodePowerShellStderr(stderr)).toBe('native tool failed');
  });
});

describe.runIf(process.platform === 'win32')('Windows PowerShell execution', () => {
  it('reports wrapped script failures as plain UTF-8 text with exit 1', () => {
    const line = formatPowerShellEncodedCommand(
      wrapPowerShellScript("throw 'Größe kaputt'; exit 0")
    );

    const result = spawnSync('cmd.exe', ['/d', '/c', line], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(decodePowerShellStderr(result.stderr).trim()).toBe('Größe kaputt');
  });

  it('preserves explicit exit codes from wrapped scripts', () => {
    const line = formatPowerShellEncodedCommand(
      wrapPowerShellScript("Write-EmdashError 'missing'; exit 44")
    );

    const result = spawnSync('cmd.exe', ['/d', '/c', line], { encoding: 'utf8' });

    expect(result.status).toBe(44);
    expect(result.stderr.trim()).toBe('missing');
  });

  it('runs an encoded script through cmd.exe with hostile literals intact', () => {
    const value = 'C:\\Users\\O\'Brien & Co\\%USERNAME%\\\u2019"$(whoami)" ^ | < >';
    const line = formatPowerShellEncodedCommand(
      `[Console]::Out.Write(${powerShellLiteral(value)}.Length); exit 7`
    );

    const result = runThroughCmd(line);

    expect(result.status).toBe(7);
    expect(result.stdout.trim()).toBe(String(value.length));
  });
});

function runThroughCmd(line: string): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync('cmd.exe', ['/d', '/c', line], { encoding: 'utf8' }),
    };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { status: failure.status, stdout: failure.stdout };
  }
}
