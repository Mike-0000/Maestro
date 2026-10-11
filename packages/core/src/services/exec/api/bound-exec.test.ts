import { once } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBoundExec, ExecError } from './index';

describe('BoundExec', () => {
  it('runs a configured executable from a fixed cwd', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-'));
    const result = await createBoundExec({ file: process.execPath, cwd }).exec([
      '-e',
      'console.log(process.cwd())',
    ]);

    await expect(realpath(result.stdout.trim())).resolves.toBe(await realpath(cwd));
    expect(result.stderr).toBe('');
  });

  it('streams stdout and lets the consumer stop early', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-stream-'));
    const chunks: string[] = [];

    await createBoundExec({ file: process.execPath, cwd }).execStreaming(
      ['-e', "console.log('one'); console.log('two');"],
      (chunk) => {
        chunks.push(chunk);
        return false;
      }
    );

    expect(chunks.join('')).toContain('one');
  });

  it('opens a piped child with the bound cwd and environment', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-spawn-'));
    const child = await createBoundExec({
      file: process.execPath,
      cwd,
      env: { ...process.env, EMDASH_EXEC_TEST: 'configured' },
    }).spawn([
      '-e',
      [
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => console.log(JSON.stringify({ cwd: process.cwd(), env: process.env.EMDASH_EXEC_TEST, input })));",
      ].join(' '),
    ]);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.end('payload');

    const [exitCode] = await once(child, 'close');
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      cwd: await realpath(cwd),
      env: 'configured',
      input: 'payload',
    });
  });

  it('throws ExecError with serializable process details on non-zero exit', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-error-'));
    await expect(
      createBoundExec({ file: 'git', cwd }).exec(['rev-parse', '--not-a-real-flag'])
    ).rejects.toMatchObject({
      exitCode: 128,
      file: 'git',
      args: ['rev-parse', '--not-a-real-flag'],
    });
  });

  it('preserves the operating-system error when an executable is missing', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-missing-'));
    const file = path.join(cwd, 'missing-executable');
    try {
      await expect(createBoundExec({ file, cwd }).exec([])).rejects.toMatchObject({
        name: 'ExecError',
        exitCode: null,
        cause: { code: 'ENOENT', path: file },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the configured executable path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-bin-'));
    const executable = path.join(dir, 'tool.sh');
    const logPath = path.join(dir, 'calls.log');
    await writeFile(
      executable,
      ['#!/bin/sh', `printf '%s\\n' "$1" >> ${JSON.stringify(logPath)}`, 'exit 7', ''].join('\n'),
      'utf8'
    );
    await chmod(executable, 0o755);

    await expect(
      createBoundExec({ file: executable, cwd: dir }).exec(['hello'])
    ).rejects.toBeInstanceOf(ExecError);
    await expect(readFile(logPath, 'utf8')).resolves.toBe('hello\n');
  });

  it('uses the Windows launch planner for a bound cmd shim', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'emdash-bound-windows-'));
    const cmdWrapper = path.join(dir, 'cmd-wrapper');
    const provider = path.join(dir, 'provider.cmd');
    await writeFile(cmdWrapper, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', 'utf8');
    await chmod(cmdWrapper, 0o755);

    const result = await createBoundExec({
      file: provider,
      cwd: dir,
      env: { ComSpec: cmdWrapper, PATH: dir, PATHEXT: '.CMD' },
      platform: 'win32',
      fileExists: (candidate) => candidate === provider,
    }).exec(['hello world']);

    expect(result.stdout).toContain('/d /s /c');
    expect(result.stdout).toContain('provider.cmd');
    expect(result.stdout).toContain('hello world');
  });

  it('rejects timed-out processes with an ExecError', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-timeout-'));

    await expect(
      createBoundExec({ file: process.execPath, cwd }).exec(
        ['-e', 'setTimeout(() => {}, 10_000);'],
        { timeoutMs: 50 }
      )
    ).rejects.toMatchObject({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000);'],
      stderr: 'Timed out after 50ms',
    });
  });

  it('escalates timed-out processes that ignore SIGTERM', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-timeout-kill-'));
    const pidPath = path.join(cwd, 'child.pid');

    await expect(
      createBoundExec({ file: process.execPath, cwd }).exec(
        [
          '-e',
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
            "process.on('SIGTERM', () => {});",
            'setInterval(() => {}, 10_000);',
          ].join(' '),
        ],
        { timeoutMs: 250 }
      )
    ).rejects.toBeInstanceOf(ExecError);

    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('awaits process-group termination when cancelled', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-cancel-'));
    const pidPath = path.join(cwd, 'child.pid');
    const controller = new AbortController();
    const execution = createBoundExec({ file: process.execPath, cwd }).exec(
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000)"], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          'setInterval(() => {}, 10_000);',
        ].join(' '),
      ],
      { signal: controller.signal }
    );
    const pid = Number.parseInt(await waitForFile(pidPath), 10);

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('cleans up descendants after exceeding maxBuffer', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-buffer-tree-'));
    const pidPath = path.join(cwd, 'child.pid');
    const execution = createBoundExec({ file: process.execPath, cwd }).exec(
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          "process.stdout.write('x'.repeat(4096));",
          'setInterval(() => {}, 10_000);',
        ].join(' '),
      ],
      { maxBuffer: 128 }
    );
    const [pidText] = await Promise.all([
      waitForFile(pidPath),
      expect(execution).rejects.toMatchObject({ stderr: 'stdout exceeded maxBuffer' }),
    ]);
    const pid = Number.parseInt(pidText, 10);

    expect(isProcessAlive(pid)).toBe(false);
  });
});

/** Prints what arrived on standard input once it closes. */
const ECHO_STDIN = [
  "process.stdin.setEncoding('utf8');",
  "let input = '';",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => console.log(JSON.stringify({ input })));",
].join(' ');

describe('BoundExec input', () => {
  it('writes input to standard input and closes it', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-input-'));

    const result = await createBoundExec({ file: process.execPath, cwd }).exec(['-e', ECHO_STDIN], {
      input: 'a question\nover two lines',
      timeoutMs: 10_000,
    });

    expect(JSON.parse(result.stdout)).toEqual({ input: 'a question\nover two lines' });
  });

  it('closes standard input for an empty input', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-input-empty-'));

    // The child only exits when standard input ends; left open, this would time out.
    const result = await createBoundExec({ file: process.execPath, cwd }).exec(['-e', ECHO_STDIN], {
      input: '',
      timeoutMs: 10_000,
    });

    expect(JSON.parse(result.stdout)).toEqual({ input: '' });
  });

  it('rejects a missing executable given input, with no unhandled stream error', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-input-missing-'));
    const file = path.join(cwd, 'missing-executable');
    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);
    try {
      await expect(
        createBoundExec({ file, cwd }).exec([], { input: 'never read' })
      ).rejects.toMatchObject({
        name: 'ExecError',
        exitCode: null,
        cause: { code: 'ENOENT' },
      });
      // A stream error surfaces on a later tick than the spawn error.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('survives a child that exits without reading its input', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-input-unread-'));
    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);
    try {
      // More than a pipe buffer holds, so the write is still pending when the child is gone.
      await expect(
        createBoundExec({ file: process.execPath, cwd }).exec(['-e', 'process.exit(3)'], {
          input: 'x'.repeat(4 * 1024 * 1024),
          timeoutMs: 10_000,
        })
      ).rejects.toMatchObject({ name: 'ExecError', exitCode: 3 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * A `.cmd` shim is how several CLIs are installed on Windows. cmd.exe is then the child, and the
 * program is its grandchild: the stop has to reach the grandchild, and the call has to return.
 */
describe.skipIf(process.platform !== 'win32')('BoundExec killSignal through a .cmd shim', () => {
  const SETTLE_MS = 3_000;

  async function shim(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'emdash-shared-exec-shim-'));
    const script = path.join(dir, 'grandchild.js');
    // It ends on its own after a while, so a run where the stop fails leaves nothing behind.
    await writeFile(
      script,
      "process.stdout.write(String(process.pid) + '\\n'); setTimeout(() => {}, 30_000);\n",
      'utf8'
    );
    const wrapper = path.join(dir, 'tool.cmd');
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return wrapper;
  }

  /** Fails with a reason instead of hanging when the stop never reaches the grandchild. */
  function settled<T>(execution: Promise<T>, stop: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The call did not settle within ${SETTLE_MS}ms of ${stop}.`)),
        SETTLE_MS
      );
    });
    return Promise.race([execution, deadline]).finally(() => clearTimeout(timer));
  }

  function grandchildPid(): { read: (chunk: string) => void; pid: Promise<number> } {
    let resolve: (pid: number) => void = () => {};
    const pid = new Promise<number>((done) => {
      resolve = done;
    });
    let text = '';
    return {
      pid,
      read: (chunk) => {
        text += chunk;
        const match = /^(\d+)\r?\n/.exec(text);
        if (match) resolve(Number.parseInt(match[1] ?? '', 10));
      },
    };
  }

  it('kills the grandchild and settles after a timeout', { timeout: 15_000 }, async () => {
    const wrapper = await shim();
    const grandchild = grandchildPid();
    const timeoutMs = 1_500;
    // Observed at once, so the rejection is never unhandled while the test waits for the stop.
    const outcome = createBoundExec({ file: wrapper, cwd: path.dirname(wrapper) })
      .execStreaming([], grandchild.read, { timeoutMs, killSignal: 'SIGKILL', windowsHide: true })
      .then(
        () => 'resolved',
        (error: unknown) => error
      );
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));

    await expect(settled(outcome, 'the timeout')).resolves.toMatchObject({
      stderr: `Timed out after ${timeoutMs}ms`,
    });
    await expectGone(await grandchild.pid);
  });

  it('kills the grandchild and settles after an abort', { timeout: 15_000 }, async () => {
    const wrapper = await shim();
    const grandchild = grandchildPid();
    const controller = new AbortController();
    const outcome = createBoundExec({ file: wrapper, cwd: path.dirname(wrapper) })
      .execStreaming([], grandchild.read, {
        signal: controller.signal,
        killSignal: 'SIGKILL',
        windowsHide: true,
      })
      .then(
        () => 'resolved',
        (error: unknown) => error
      );
    const pid = await grandchild.pid;

    controller.abort();

    await expect(settled(outcome, 'the abort')).resolves.toMatchObject({ name: 'AbortError' });
    await expectGone(pid);
  });

  it(
    'kills the grandchild and settles after the stream handler returns false',
    { timeout: 15_000 },
    async () => {
      const wrapper = await shim();
      const grandchild = grandchildPid();
      const execution = createBoundExec({
        file: wrapper,
        cwd: path.dirname(wrapper),
      }).execStreaming(
        [],
        (chunk) => {
          grandchild.read(chunk);
          return false;
        },
        { killSignal: 'SIGKILL', windowsHide: true }
      );
      const pid = await grandchild.pid;

      await expect(settled(execution, 'the stream handler returning false')).resolves.toBe(
        undefined
      );
      await expectGone(pid);
    }
  );
});

/** The process table can trail the kill by a moment. */
async function expectGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isProcessAlive(pid)).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
