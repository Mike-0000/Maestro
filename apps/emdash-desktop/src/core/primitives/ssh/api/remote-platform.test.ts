import { spawnSync } from 'node:child_process';
import { formatPowerShellEncodedCommand } from '@emdash/core/primitives/exec/api';
import { describe, expect, it } from 'vitest';
import {
  describeRemotePlatform,
  evaluateRemotePlatform,
  isWindowsUnameKernel,
  parseWindowsPlatformProbe,
  RemotePlatformUnsupportedError,
  requireSupportedRemoteHost,
  summarizeRemotePlatform,
  WINDOWS_PLATFORM_PROBE_SCRIPT,
  type WindowsRemotePlatform,
} from './remote-platform';

const windows11: WindowsRemotePlatform = {
  os: 'windows',
  languageMode: 'FullLanguage',
  home: 'C:\\Users\\dev',
  architecture: 'AMD64',
  osVersion: '10.0.26100.0',
  osBuild: 26_100,
  powerShellVersion: '5.1.26100.2161',
  gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
};

function codes(info: WindowsRemotePlatform) {
  return evaluateRemotePlatform(info).map((issue) => [issue.severity, issue.code]);
}

describe('isWindowsUnameKernel', () => {
  it.each(['MINGW64_NT-10.0-26100', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0'])('detects %s', (kernel) => {
    expect(isWindowsUnameKernel(kernel)).toBe(true);
  });

  it.each(['Linux', 'Darwin', 'FreeBSD'])('keeps %s as POSIX', (kernel) => {
    expect(isWindowsUnameKernel(kernel)).toBe(false);
  });
});

describe('parseWindowsPlatformProbe', () => {
  it('parses every probe field', () => {
    const stdout = [
      'emdash-probe=1',
      'language=FullLanguage',
      'home=C:\\Users\\dev',
      'arch=AMD64',
      'os-version=10.0.26100.0',
      'os-build=26100',
      'ps-version=5.1.26100.2161',
      'git=C:\\Program Files\\Git\\cmd\\git.exe',
      '',
    ].join('\r\n');

    expect(parseWindowsPlatformProbe(stdout)).toEqual(windows11);
  });

  it('parses the constrained-language answer', () => {
    expect(parseWindowsPlatformProbe('emdash-probe=1\nlanguage=ConstrainedLanguage\n')).toEqual({
      os: 'windows',
      languageMode: 'ConstrainedLanguage',
    });
  });

  it('keeps values that contain = and the first occurrence of a key', () => {
    const info = parseWindowsPlatformProbe(
      'emdash-probe=1\nlanguage=FullLanguage\nhome=D:\\a=b\nhome=E:\\ignored\n'
    );
    expect(info?.home).toBe('D:\\a=b');
  });

  it('rejects output without the probe marker', () => {
    expect(parseWindowsPlatformProbe('language=FullLanguage\n')).toBeUndefined();
    expect(parseWindowsPlatformProbe("'powershell.exe' is not recognized")).toBeUndefined();
    expect(parseWindowsPlatformProbe('emdash-probe=1\n')).toBeUndefined();
  });

  it('drops a non-numeric build', () => {
    const info = parseWindowsPlatformProbe(
      'emdash-probe=1\nlanguage=FullLanguage\nos-build=unknown\n'
    );
    expect(info?.osBuild).toBeUndefined();
  });
});

describe('evaluateRemotePlatform', () => {
  it('accepts POSIX hosts', () => {
    expect(evaluateRemotePlatform({ os: 'posix', kernel: 'Linux', home: '/home/dev' })).toEqual([]);
  });

  it('accepts a supported Windows host', () => {
    expect(codes(windows11)).toEqual([]);
  });

  it('stops at constrained language mode with an actionable message', () => {
    const issues = evaluateRemotePlatform({ os: 'windows', languageMode: 'ConstrainedLanguage' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'constrained-language' });
    expect(issues[0]?.message).toContain('ConstrainedLanguage');
  });

  it('reports every blocking problem at once', () => {
    expect(
      codes({
        os: 'windows',
        languageMode: 'FullLanguage',
        architecture: 'x86',
        osBuild: 14_393,
        powerShellVersion: '5.0.10586.117',
      })
    ).toEqual([
      ['error', 'home-unavailable'],
      ['error', 'powershell-too-old'],
      ['error', 'windows-too-old'],
      ['error', 'unsupported-architecture'],
      ['warning', 'git-missing'],
    ]);
  });

  it('rejects a relative or empty profile path', () => {
    expect(codes({ ...windows11, home: 'Users\\dev' })).toEqual([['error', 'home-unavailable']]);
    expect(codes({ ...windows11, home: '\\\\server\\share\\dev' })).toEqual([]);
  });

  it('accepts newer PowerShell versions', () => {
    expect(codes({ ...windows11, powerShellVersion: '7.4.1' })).toEqual([]);
  });

  it('warns about ARM64 emulation on Windows 11 and blocks it earlier', () => {
    expect(codes({ ...windows11, architecture: 'ARM64' })).toEqual([
      ['warning', 'arm64-emulation'],
    ]);
    expect(codes({ ...windows11, architecture: 'ARM64', osBuild: 19_045 })).toEqual([
      ['error', 'arm64-emulation'],
    ]);
  });

  it('only warns when Git is missing', () => {
    expect(codes({ ...windows11, gitPath: undefined })).toEqual([['warning', 'git-missing']]);
  });
});

describe('requireSupportedRemoteHost', () => {
  it('narrows supported hosts', () => {
    expect(requireSupportedRemoteHost({ os: 'posix', kernel: 'Darwin', home: '/Users/a' })).toEqual(
      { platform: 'posix', home: '/Users/a' }
    );
    expect(requireSupportedRemoteHost({ ...windows11, architecture: 'ARM64' })).toEqual({
      platform: 'windows',
      home: 'C:\\Users\\dev',
      architecture: 'arm64',
    });
  });

  it('throws only the blocking issues', () => {
    let error: unknown;
    try {
      requireSupportedRemoteHost({ ...windows11, osBuild: 17_134, gitPath: undefined });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RemotePlatformUnsupportedError);
    expect((error as RemotePlatformUnsupportedError).issues.map((issue) => issue.code)).toEqual([
      'windows-too-old',
    ]);
    expect((error as Error).message).toContain('build 17134');
  });
});

describe('describeRemotePlatform', () => {
  it('describes each platform', () => {
    expect(describeRemotePlatform({ os: 'posix', kernel: 'Darwin', home: '/' })).toBe('macOS');
    expect(describeRemotePlatform({ os: 'posix', kernel: 'Linux', home: '/' })).toBe('Linux');
    expect(describeRemotePlatform(windows11)).toBe(
      'Windows build 26100 (AMD64) · PowerShell 5.1.26100.2161'
    );
    expect(describeRemotePlatform({ os: 'windows', languageMode: 'ConstrainedLanguage' })).toBe(
      'Windows (PowerShell ConstrainedLanguage)'
    );
  });

  it('summarizes the description with the issues', () => {
    expect(summarizeRemotePlatform({ ...windows11, gitPath: undefined })).toMatchObject({
      os: 'windows',
      issues: [{ code: 'git-missing' }],
    });
  });
});

describe.runIf(process.platform === 'win32')('Windows platform probe script', () => {
  it('identifies this Windows machine through cmd.exe', () => {
    const result = spawnSync(
      'cmd.exe',
      ['/d', '/c', formatPowerShellEncodedCommand(WINDOWS_PLATFORM_PROBE_SCRIPT)],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(0);
    const info = parseWindowsPlatformProbe(result.stdout);
    expect(info).toMatchObject({ os: 'windows', languageMode: 'FullLanguage' });
    expect(info?.home?.toLowerCase()).toBe(process.env.USERPROFILE?.toLowerCase());
    expect(info?.osBuild).toBeGreaterThan(0);
    expect(info?.powerShellVersion).toMatch(/^5\.1\./);
  });
});
