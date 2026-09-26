import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planExecutableLaunch, toChildProcessLaunch } from './executable-launch';

describe('planExecutableLaunch', () => {
  it('keeps POSIX argv as a direct launch', () => {
    expect(
      planExecutableLaunch({
        platform: 'linux',
        command: 'provider',
        args: ['', 'hello world'],
        cwd: '/workspace',
      })
    ).toEqual({
      invocation: { kind: 'argv', executable: 'provider', argv: ['', 'hello world'] },
      cwd: '/workspace',
      diagnostics: [],
    });
  });

  it('resolves an npm-style cmd shim from a quoted mixed-case Path', () => {
    const provider = 'C:\\Program Files\\npm shims\\provider.CMD';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'provider',
      args: [
        '',
        'hello world',
        'embedded"quote',
        '%TOKEN%',
        'bang!',
        'caret^',
        'ampersand&',
        'pipe|',
        'less<',
        'greater>',
        '(parentheses)',
        'space trailing\\',
        'ユニコード',
        '/c',
        'x & echo injected',
      ],
      cwd: 'C:\\Work Space',
      env: {
        Path: '"C:\\Program Files\\npm shims";C:\\Windows\\System32',
        pathext: '.EXE;.CMD',
        cOmSpEc: '"C:\\Windows\\System32\\cmd.exe"',
      },
      fileExists: (candidate) => candidate === provider,
    });

    expect(plan).toEqual({
      invocation: {
        kind: 'windows-command-line',
        executable: 'C:\\Windows\\System32\\cmd.exe',
        rawArguments:
          '/d /s /c ""C:\\Program Files\\npm shims\\provider.CMD" "" "hello world" "embedded""quote" "%%cd:~,%TOKEN%%cd:~,%" "bang!" "caret^" "ampersand&" "pipe|" "less<" "greater>" "(parentheses)" "space trailing\\\\" ユニコード /c "x & echo injected""',
      },
      cwd: 'C:\\Work Space',
      diagnostics: [],
    });
  });

  it('prefers the cmd shim over an extensionless sibling for a resolved npm bin path', () => {
    const bare = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\pi';
    const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.CMD';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: bare,
      args: ['--session', 'abc'],
      cwd: 'C:\\work',
      env: { PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      fileExists: (candidate) => candidate === bare || candidate === shim,
    });

    expect(plan).toMatchObject({
      invocation: {
        kind: 'windows-command-line',
        executable: 'C:\\Windows\\System32\\cmd.exe',
        rawArguments: expect.stringContaining(shim),
      },
      diagnostics: [],
    });
  });

  it('falls back to a bare extensionless file when no PATHEXT sibling exists', () => {
    const bare = 'C:\\Tools\\provider';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: bare,
      args: ['run'],
      cwd: 'C:\\work',
      env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      fileExists: (candidate) => candidate === bare,
    });

    expect(plan).toMatchObject({
      invocation: { kind: 'argv', executable: bare, argv: ['run'] },
      diagnostics: [],
    });
  });

  it('searches PATH for commands that already have an extension', () => {
    const provider = 'C:\\Tools With Spaces\\provider.cmd';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'provider.cmd',
      args: ['run'],
      cwd: 'C:\\work',
      env: { PATH: 'C:\\Tools With Spaces', ComSpec: 'C:\\Windows\\cmd.exe' },
      fileExists: (candidate) => candidate === provider,
    });

    expect(plan.invocation).toMatchObject({
      kind: 'windows-command-line',
      executable: 'C:\\Windows\\cmd.exe',
      rawArguments: expect.stringContaining(provider),
    });
    expect(plan.diagnostics).toEqual([]);
  });

  it('resolves relative paths against the Windows cwd', () => {
    const provider = 'C:\\work\\tools\\provider.exe';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: '.\\tools\\provider.exe',
      args: ['run'],
      cwd: 'C:\\work',
      env: {},
      fileExists: (candidate) => candidate === provider,
    });

    expect(plan).toMatchObject({
      invocation: { kind: 'argv', executable: provider },
      diagnostics: [],
    });
  });

  it('runs native executables directly with exact argv', () => {
    const args = [
      '',
      '"quoted"',
      '%TOKEN%',
      'bang!',
      'caret^',
      'ampersand&',
      'pipe|',
      'less<',
      'greater>',
      '(parentheses)',
      'trailing\\',
      'ユニコード',
      '/c',
      '--flag=value',
    ];
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'C:\\Program Files\\Provider\\provider.exe',
      args,
      cwd: 'C:\\Work Space',
      env: {},
      fileExists: () => true,
    });

    expect(plan).toMatchObject({
      invocation: {
        kind: 'argv',
        executable: 'C:\\Program Files\\Provider\\provider.exe',
        argv: args,
      },
    });
  });

  it.each(['.exe', '.com'])('runs native %s files directly', (extension) => {
    const executable = `C:\\Tools\\provider${extension}`;
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: executable,
      args: ['run'],
      cwd: 'C:\\work',
      env: {},
      fileExists: (candidate) => candidate === executable,
    });

    expect(plan).toMatchObject({
      invocation: { kind: 'argv', executable, argv: ['run'] },
      diagnostics: [],
    });
  });

  it('uses the selected PowerShell profile for ps1 files', () => {
    const args = [
      '',
      '-NoProfile',
      'embedded"quote',
      '%TOKEN%',
      'bang!',
      'caret^',
      'ampersand&',
      'pipe|',
      'less<',
      'greater>',
      '(parentheses)',
      'trailing\\',
      'ユニコード',
      'x | injected',
    ];
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'C:\\Scripts\\provider.ps1',
      args,
      cwd: 'C:\\work',
      env: {},
      shellProfile: { family: 'powershell', executable: 'C:\\Program Files\\PowerShell\\pwsh.exe' },
      fileExists: () => true,
    });

    expect(plan).toMatchObject({
      invocation: {
        kind: 'argv',
        executable: 'C:\\Program Files\\PowerShell\\pwsh.exe',
        argv: [
          '-NoLogo',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'C:\\Scripts\\provider.ps1',
          ...args,
        ],
      },
    });
  });

  it('uses Windows PowerShell from SystemRoot for a ps1 file without a selected profile', () => {
    const script = 'C:\\Scripts\\provider.ps1';
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: script,
      args: ['run'],
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows' },
      fileExists: (candidate) => candidate === script || candidate === powershell,
    });

    expect(plan).toMatchObject({
      invocation: {
        kind: 'argv',
        executable: powershell,
        argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'run'],
      },
      diagnostics: [],
    });
  });

  it('preserves an unresolved command as a direct spawn failure', () => {
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'missing-provider',
      args: ['run'],
      cwd: 'C:\\work',
      env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      fileExists: () => false,
    });

    expect(plan).toMatchObject({
      invocation: { kind: 'argv', executable: 'missing-provider', argv: ['run'] },
      diagnostics: [{ type: 'command-not-found', command: 'missing-provider' }],
    });
  });

  it('uses SystemRoot for cmd when ComSpec is absent', () => {
    const plan = planExecutableLaunch({
      platform: 'win32',
      command: 'C:\\tools\\provider.bat',
      args: [],
      cwd: 'C:\\work',
      env: { SYSTEMROOT: 'C:\\Windows' },
      fileExists: () => true,
    });

    expect(plan.invocation.executable).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

// Runs a real cmd.exe and an npm-style shim that forwards %* to node, so the quoting is checked
// against cmd itself rather than against a copy of its rules.
describe.runIf(process.platform === 'win32')('planExecutableLaunch through a real cmd shim', () => {
  it('delivers every argument verbatim', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'emdash-cmd-shim-'));
    try {
      const echo = path.join(dir, 'argv.js');
      writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const shim = path.join(dir, 'provider.cmd');
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
      const args = [
        'plain',
        'Review the plan: (1) quadrants & (2) focus | stage > board < region ^ done',
        'say "hi" & echo injected',
        'x" & echo injected & "',
        '100% sure %PATH% %%x%% %~dp0 %1 %*',
        'bang! !PATH!',
        'C:\\dir name\\',
        'a\\"b',
        '',
      ];
      const plan = planExecutableLaunch({ platform: 'win32', command: shim, args, cwd: dir });
      const launch = toChildProcessLaunch(plan.invocation);
      const result = spawnSync(launch.executable, launch.args, {
        cwd: dir,
        encoding: 'utf8',
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });

      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
