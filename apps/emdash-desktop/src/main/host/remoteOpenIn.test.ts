import { describe, expect, it } from 'vitest';
import {
  buildRemoteEditorUrl,
  buildRemoteSshAuthority,
  buildRemoteSshCommand,
  buildRemoteTerminalExecArgs,
  isWindowsRemotePath,
} from './remoteOpenIn';

describe('remoteOpenIn', () => {
  describe('buildRemoteEditorUrl', () => {
    it('builds VSCodium remote SSH URLs', () => {
      expect(buildRemoteEditorUrl('vscodium', 'example.com', 'alice', '/repo')).toBe(
        'vscodium://vscode-remote/ssh-remote+7b22686f73744e616d65223a226578616d706c652e636f6d222c2275736572223a22616c696365227d/repo'
      );
    });

    it('omits ports from VS Code-style remote SSH URLs', () => {
      expect(buildRemoteEditorUrl('vscode', 'localhost', 'dev', '/repo', 2222)).toBe(
        'vscode://vscode-remote/ssh-remote+7b22686f73744e616d65223a226c6f63616c686f7374222c2275736572223a22646576227d/repo'
      );
    });

    it('builds Zed remote SSH URLs without encoding the SSH authority', () => {
      expect(buildRemoteEditorUrl('zed', 'localhost', 'dev', '/repo')).toBe(
        'zed://ssh/dev@localhost/repo'
      );
    });

    it('includes a non-default port in Zed remote SSH URLs', () => {
      expect(buildRemoteEditorUrl('zed', 'localhost', 'dev', '/repo', 2222)).toBe(
        'zed://ssh/dev@localhost:2222/repo'
      );
    });

    it('omits port 22 (the SSH default) from Zed remote SSH URLs', () => {
      expect(buildRemoteEditorUrl('zed', 'localhost', 'dev', '/repo', 22)).toBe(
        'zed://ssh/dev@localhost/repo'
      );
    });

    it('encodes remote path segments in editor URLs', () => {
      expect(buildRemoteEditorUrl('zed', 'localhost', 'dev', '/repo with space/#1')).toBe(
        'zed://ssh/dev@localhost/repo%20with%20space/%231'
      );
    });
  });

  describe('buildRemoteTerminalExecArgs', () => {
    it('builds argv tokens for terminal app SSH launchers', () => {
      const args = buildRemoteTerminalExecArgs({
        host: 'example.com',
        username: 'arne',
        port: 2222,
        targetPath: "/tmp/with 'quote'",
      });

      expect(args).toEqual([
        'ssh',
        'arne@example.com',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-p',
        '2222',
        '-t',
        "cd '/tmp/with '\\''quote'\\''' && (if command -v infocmp >/dev/null 2>&1 && [ -n \"${TERM:-}\" ] && infocmp \"${TERM}\" >/dev/null 2>&1; then :; else export TERM=xterm-256color; fi) && (exec \"${SHELL:-/bin/bash}\" || exec /bin/bash || exec /bin/sh)",
      ]);
    });
  });

  describe('Windows remote hosts', () => {
    const windowsPath = "C:\\Users\\dev\\O'Brien repo";

    it('recognizes Windows absolute paths only', () => {
      expect(isWindowsRemotePath('C:\\repo')).toBe(true);
      expect(isWindowsRemotePath('d:/repo')).toBe(true);
      expect(isWindowsRemotePath('\\\\server\\share\\repo')).toBe(true);
      expect(isWindowsRemotePath('/home/dev/C:\\x')).toBe(false);
      expect(isWindowsRemotePath('C:repo')).toBe(false);
      expect(isWindowsRemotePath('\\\\?\\C:\\repo')).toBe(true);
    });

    it('addresses Windows folders as /C:/... in editor URLs', () => {
      expect(buildRemoteEditorUrl('zed', 'win', 'dev', windowsPath)).toBe(
        "zed://ssh/dev@win/C:/Users/dev/O'Brien%20repo"
      );
      expect(buildRemoteEditorUrl('vscode', 'win', '', 'D:\\src\\#1')).toBe(
        'vscode://vscode-remote/ssh-remote+win/D:/src/%231'
      );
    });

    it('opens terminals in an encoded PowerShell session at the folder', () => {
      const args = buildRemoteTerminalExecArgs({
        host: 'win',
        username: 'dev',
        port: 22,
        targetPath: windowsPath,
      });

      const remoteCommand = args.at(-1) ?? '';
      expect(remoteCommand).toMatch(
        /^powershell\.exe -NoLogo -NoExit -OutputFormat Text -EncodedCommand [A-Za-z0-9+/=]+$/
      );
      const encoded = remoteCommand.split(' ').at(-1) ?? '';
      expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
        "Set-Location -LiteralPath 'C:\\Users\\dev\\O''Brien repo'"
      );
      expect(
        buildRemoteSshCommand({ host: 'win', username: 'dev', port: 22, targetPath: windowsPath })
      ).toContain(remoteCommand);
    });
  });

  describe('buildRemoteSshAuthority', () => {
    it('does not prepend the username when the host already includes one', () => {
      expect(buildRemoteSshAuthority('git@example.com', 'arne')).toBe('git@example.com');
    });
  });
});
