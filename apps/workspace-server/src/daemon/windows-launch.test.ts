import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOutsideSessionLauncher,
  launchOutsideSessionJob,
  LAUNCH_OUTSIDE_SESSION_SCRIPT,
  type PowerShellRunner,
} from './windows-launch';

describe('createOutsideSessionLauncher', () => {
  it('passes the command line through the environment, never the script', async () => {
    const calls: Array<{ encoded: string; env: NodeJS.ProcessEnv }> = [];
    const runner: PowerShellRunner = async (encoded, env) => {
      calls.push({ encoded, env });
      return { exitCode: 0, stdout: '0 4242', stderr: '' };
    };

    const result = await createOutsideSessionLauncher(runner)(
      [
        "C:\\Users\\O'Brien Dev\\node.exe",
        'C:\\ws\\dist\\index.mjs',
        'daemonize',
        '--socket',
        'C:\\run\\workspace.sock',
      ],
      { cwd: "C:\\Users\\O'Brien Dev", env: { PATH: 'C:\\Windows' } }
    );

    expect(result).toEqual({ success: true, data: { pid: 4242 } });
    expect(Buffer.from(calls[0]?.encoded ?? '', 'base64').toString('utf16le')).toBe(
      LAUNCH_OUTSIDE_SESSION_SCRIPT
    );
    expect(calls[0]?.env).toEqual({
      PATH: 'C:\\Windows',
      EMDASH_WS_LAUNCH_COMMAND_LINE:
        '"C:\\Users\\O\'Brien Dev\\node.exe" C:\\ws\\dist\\index.mjs daemonize --socket C:\\run\\workspace.sock',
      EMDASH_WS_LAUNCH_DIRECTORY: "C:\\Users\\O'Brien Dev",
      EMDASH_WS_LAUNCH_SELF: calls[0]?.encoded,
    });
  });

  it('surfaces why an elevated caller could not start a de-elevated daemon', async () => {
    const launcher = createOutsideSessionLauncher(async () => ({
      exitCode: 0,
      stdout: '0 4242\r\nW The workspace server was started elevated: runas failed\r\n',
      stderr: '',
    }));

    expect(await launcher(['node.exe'], { cwd: 'C:\\', env: {} })).toEqual({
      success: true,
      data: { pid: 4242, warnings: ['The workspace server was started elevated: runas failed'] },
    });
  });

  it('keeps the de-elevation hop free of caller-controlled PowerShell', () => {
    // runas receives one command line: a system path plus the script's own base64 encoding.
    expect(LAUNCH_OUTSIDE_SESSION_SCRIPT).toContain("& runas.exe '/trustlevel:0x20000'");
    expect(LAUNCH_OUTSIDE_SESSION_SCRIPT).toContain("-notmatch '^[A-Za-z0-9+/=]+$'");
    expect(LAUNCH_OUTSIDE_SESSION_SCRIPT).not.toMatch(/Invoke-Expression|iex /u);
  });

  it('names Win32_Process.Create failures', async () => {
    const launcher = createOutsideSessionLauncher(async () => ({
      exitCode: 0,
      stdout: '2 0',
      stderr: '',
    }));

    expect(await launcher(['node.exe'], { cwd: 'C:\\', env: {} })).toEqual({
      success: false,
      error: 'Win32_Process.Create returned 2 (access denied)',
    });
  });

  it('reports PowerShell failures with their error output', async () => {
    const launcher = createOutsideSessionLauncher(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Get-CimClass : Access denied\r\n',
    }));

    expect(await launcher(['node.exe'], { cwd: 'C:\\', env: {} })).toEqual({
      success: false,
      error: 'WMI process creation failed (exit 1): Get-CimClass : Access denied',
    });
  });

  it('rejects unexpected launcher output', async () => {
    const launcher = createOutsideSessionLauncher(async () => ({
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
    }));

    expect(await launcher(['node.exe'], { cwd: 'C:\\', env: {} })).toMatchObject({
      success: false,
      error: expect.stringContaining('unexpected WMI launcher output'),
    });
  });
});

describe.runIf(process.platform === 'win32')('launchOutsideSessionJob on Windows', () => {
  it('starts a real process through WMI with the caller environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdash-ws-wmi-launch-'));
    const output = join(directory, "out put's.json");
    const script =
      'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), ' +
      'marker: process.env.EMDASH_WS_TEST_MARKER, argv: process.argv.slice(2) }))';

    const result = await launchOutsideSessionJob(
      [process.execPath, '-e', script, output, 'a "quoted" arg', 'trailing\\'],
      { cwd: directory, env: { ...process.env, EMDASH_WS_TEST_MARKER: 'marker value' } }
    );

    expect(result).toMatchObject({ success: true });
    const written = await waitForFile(output);
    expect(JSON.parse(written)).toEqual({
      cwd: directory,
      marker: 'marker value',
      argv: ['a "quoted" arg', 'trailing\\'],
    });
  }, 30_000);
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
