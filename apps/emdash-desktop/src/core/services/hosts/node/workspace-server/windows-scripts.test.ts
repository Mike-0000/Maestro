import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodePowerShellStderr,
  formatPowerShellEncodedCommand,
} from '@emdash/core/primitives/exec/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { windowsWorkspaceServerLayout, type WindowsWorkspaceServerLayout } from './layout';
import {
  buildWindowsChannelPointerScript,
  buildWindowsDaemonControlScript,
  buildWindowsInstalledVersionScript,
  buildWindowsInstallerDownloadScript,
  buildWindowsInstallerRunScript,
  buildWindowsPipeBridgeScript,
  WINDOWS_EXECUTION_POLICY_EXIT_CODE,
  WINDOWS_PIPE_BRIDGE_READY_MARKER,
} from './windows-scripts';

const HOSTILE_HOME = String.raw`C:\Users\O'Brien & Co\%USERNAME%\$(whoami) ‘q’ ^ ;`;

describe('Windows workspace-server scripts', () => {
  it('embeds caller values only as PowerShell literals', () => {
    const layout = windowsWorkspaceServerLayout(HOSTILE_HOME);
    const script = buildWindowsDaemonControlScript(layout, 'start');

    expect(script).toContain(
      String.raw`'C:\Users\O''Brien & Co\%USERNAME%\$(whoami) ‘‘q’’ ^ ;\.emdash\workspace-server\run\workspace.sock'`
    );
    expect(script).not.toContain('"C:');
  });

  it('keeps every script within the Windows command-line budget', () => {
    const layout = windowsWorkspaceServerLayout(`C:\\Users\\${'x'.repeat(200)}`);
    for (const script of [
      buildWindowsInstalledVersionScript(layout),
      buildWindowsDaemonControlScript(layout, 'status'),
      buildWindowsPipeBridgeScript(layout.socketPath),
      buildWindowsChannelPointerScript([
        'https://releases.example.test/workspace-server/channels/canary/protocol-1.json',
        'https://releases.example.test/workspace-server/channels/stable/protocol-1.json',
      ]),
      buildWindowsInstallerDownloadScript({
        scriptUrl: 'https://releases.example.test/workspace-server/1.2.3/install.ps1',
        installerPath: path.win32.join(
          layout.stagingDirectory,
          `install-1.2.3-${randomUUID()}.ps1`
        ),
      }),
      buildWindowsInstallerRunScript({
        installerPath: path.win32.join(
          layout.stagingDirectory,
          `install-1.2.3-${randomUUID()}.ps1`
        ),
        baseUrl: 'https://releases.example.test/workspace-server',
        version: '1.2.3',
        layout,
      }),
    ]) {
      expect(() =>
        formatPowerShellEncodedCommand(script, { bypassExecutionPolicy: true })
      ).not.toThrow();
    }
  });
});

type RunResult = { status: number | null; stdout: string; stderr: string };

function runScript(
  script: string,
  commandLine = formatPowerShellEncodedCommand(script)
): RunResult {
  const result = spawnSync('cmd.exe', ['/d', '/c', commandLine], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: decodePowerShellStderr(result.stderr).trim(),
  };
}

describe.runIf(process.platform === 'win32')('Windows workspace-server scripts on Windows', () => {
  let temp: string;
  let layout: WindowsWorkspaceServerLayout;

  beforeAll(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-winscripts-'));
    const home = path.join(temp, "O'Brien & Co %USERNAME% $(whoami) ‘q’ ^ ;");
    fs.mkdirSync(home);
    layout = windowsWorkspaceServerLayout(home);
  });

  afterAll(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  function installFakeVersion(version: string, entrypoint: string): void {
    const directory = layout.versionDirectory(version);
    fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
    const node = layout.versionNodeExecutable(version);
    try {
      fs.linkSync(process.execPath, node);
    } catch {
      fs.copyFileSync(process.execPath, node);
    }
    fs.writeFileSync(layout.versionEntrypoint(version), entrypoint);
  }

  function selectVersion(value: string): void {
    fs.writeFileSync(layout.currentPointer, value);
  }

  it('reports nothing before install, then the selected version', () => {
    expect(runScript(buildWindowsInstalledVersionScript(layout))).toMatchObject({
      status: 0,
      stdout: '',
    });

    installFakeVersion(
      '1.2.3',
      [
        "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');",
        "process.stderr.write('Größe warning\\n');",
        "process.exit(process.argv[2] === 'status' ? 3 : 0);",
      ].join('\n')
    );
    selectVersion('1.2.3\r\n');

    expect(runScript(buildWindowsInstalledVersionScript(layout))).toMatchObject({
      status: 0,
      stdout: '1.2.3',
    });
  });

  it('runs daemon control with the exact socket argument and exit code', () => {
    const start = runScript(buildWindowsDaemonControlScript(layout, 'start'));
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout)).toEqual(['start', '--socket', layout.socketPath]);
    expect(start.stderr).toBe('Größe warning');

    expect(runScript(buildWindowsDaemonControlScript(layout, 'status')).status).toBe(3);
  });

  it('rejects an invalid current pointer without running anything', () => {
    selectVersion('..\\..\\evil');
    const result = runScript(buildWindowsDaemonControlScript(layout, 'start'));
    expect(result.status).toBe(45);
    expect(result.stderr).toContain('current pointer is invalid');
    expect(runScript(buildWindowsInstalledVersionScript(layout)).status).toBe(45);
    selectVersion('1.2.3');
  });

  it('reports an incomplete installation', () => {
    selectVersion('9.9.9');
    fs.mkdirSync(layout.versionDirectory('9.9.9'), { recursive: true });
    const result = runScript(buildWindowsDaemonControlScript(layout, 'stop'));
    expect(result.status).toBe(46);
    expect(result.stderr).toContain('is incomplete');
    selectVersion('1.2.3');
  });

  it('reports a missing installation', () => {
    const empty = windowsWorkspaceServerLayout(fs.mkdtempSync(path.join(temp, 'empty-')));
    const result = runScript(buildWindowsDaemonControlScript(empty, 'start'));
    expect(result.status).toBe(44);
    expect(result.stderr).toBe('The workspace server is not installed.');
  });

  it('downloads the first available channel pointer', () => {
    const pointer = path.join(temp, 'stable.json');
    fs.writeFileSync(pointer, '{"artifactVersion":"1.2.3"}');
    const result = runScript(
      buildWindowsChannelPointerScript([
        pathToFileURL(path.join(temp, 'missing.json')).href,
        pathToFileURL(pointer).href,
      ])
    );
    expect(result).toMatchObject({ status: 0, stdout: '{"artifactVersion":"1.2.3"}' });

    const failure = runScript(
      buildWindowsChannelPointerScript([pathToFileURL(path.join(temp, 'missing.json')).href])
    );
    expect(failure.status).toBe(41);
    expect(failure.stderr).toContain('Could not download workspace-server metadata');
  });

  describe('installer', () => {
    const source = () => path.join(temp, 'install.ps1');
    const installerPath = () =>
      path.win32.join(layout.stagingDirectory, `install-1.2.3-${randomUUID()}.ps1`);
    const run = (target: string) =>
      buildWindowsInstallerRunScript({
        installerPath: target,
        baseUrl: "https://example.test/it's",
        version: '1.2.3',
        layout,
      });

    beforeAll(() => {
      fs.writeFileSync(
        source(),
        [
          'param([string]$BaseUrl, [string]$Version, [string]$InstallRoot)',
          "[Console]::Out.Write(($BaseUrl, $Version, $InstallRoot) -join '|')",
          'exit 42',
        ].join('\r\n')
      );
    });

    it('downloads the installer, runs it with literal parameters, and deletes it', () => {
      const target = installerPath();
      expect(
        runScript(
          buildWindowsInstallerDownloadScript({
            scriptUrl: pathToFileURL(source()).href,
            installerPath: target,
          })
        ).status
      ).toBe(0);
      expect(fs.existsSync(target)).toBe(true);

      const script = run(target);
      const result = runScript(
        script,
        formatPowerShellEncodedCommand(script, { bypassExecutionPolicy: true })
      );

      expect(result.status).toBe(42);
      expect(result.stdout).toBe(`https://example.test/it's|1.2.3|${layout.root}`);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('reports a failed download', () => {
      const missing = runScript(
        buildWindowsInstallerDownloadScript({
          scriptUrl: pathToFileURL(path.join(temp, 'missing.ps1')).href,
          installerPath: installerPath(),
        })
      );
      expect(missing.status).toBe(41);
      expect(missing.stderr).toContain('Could not download');
    });

    it('reports an execution policy that refuses the installer', () => {
      const target = installerPath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source(), target);
      const script = run(target);
      const restricted = formatPowerShellEncodedCommand(script).replace(
        '-NonInteractive',
        '-NonInteractive -ExecutionPolicy Restricted'
      );

      const result = runScript(script, restricted);

      expect(result.status).toBe(WINDOWS_EXECUTION_POLICY_EXIT_CODE);
      expect(result.stderr).toContain('execution policy');
      expect(fs.existsSync(target)).toBe(false);
    });
  });

  describe('named-pipe bridge', () => {
    it('reports a daemon that is not running', () => {
      const result = runScript(buildWindowsPipeBridgeScript(path.join(temp, 'no-record.sock')));
      expect(result.status).toBe(48);
      expect(result.stderr).toContain('not running');
    });

    it('rejects an endpoint record that names another pipe', () => {
      const record = path.join(temp, 'bad-record.sock');
      fs.writeFileSync(record, '\\\\.\\pipe\\someone-else\n');
      const result = runScript(buildWindowsPipeBridgeScript(record));
      expect(result.status).toBe(45);
      expect(result.stderr).toContain('is invalid');
    });

    it('reports a recorded pipe that nobody listens on', () => {
      const record = path.join(temp, 'stale-record.sock');
      fs.writeFileSync(record, `\\\\.\\pipe\\emdash-workspace-server-${randomUUID()}\n`);
      const result = runScript(buildWindowsPipeBridgeScript(record));
      expect(result.status).toBe(47);
      expect(result.stderr).toContain('Could not connect to the workspace server pipe');
    }, 30_000);

    it('relays bytes both ways after reporting readiness', async () => {
      const pipeName = `\\\\.\\pipe\\emdash-workspace-server-${randomUUID()}`;
      const server = net.createServer((socket) => socket.pipe(socket));
      await new Promise<void>((resolve) => server.listen(pipeName, resolve));
      const record = path.join(temp, 'workspace.sock');
      fs.writeFileSync(record, `${pipeName}\n`);

      try {
        const child = spawn(
          'cmd.exe',
          ['/d', '/c', formatPowerShellEncodedCommand(buildWindowsPipeBridgeScript(record))],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        );
        let stderr = '';
        let stdout = Buffer.alloc(0);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = Buffer.concat([stdout, chunk]);
        });
        await new Promise<void>((resolve, reject) => {
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            if (stderr.includes(WINDOWS_PIPE_BRIDGE_READY_MARKER)) resolve();
          });
          child.once('exit', (code) => reject(new Error(`bridge exited ${code}: ${stderr}`)));
        });

        const payload = Buffer.from([0, 1, 2, 0xff, 0x0d, 0x0a, 0x1a, ...Buffer.from('héllo')]);
        child.stdin.write(payload);
        await expect.poll(() => stdout.length, { timeout: 10_000 }).toBe(payload.length);
        expect(stdout.equals(payload)).toBe(true);

        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        child.stdin.end();
        await expect(exited).resolves.toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 30_000);
  });
});
