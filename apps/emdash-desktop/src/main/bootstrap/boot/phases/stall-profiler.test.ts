import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStallProfiler, type ProfilerSession } from './stall-profiler';

const MINUTE = 60_000;

describe('createStallProfiler', () => {
  let folder: string;
  let time: number;
  let endCapture: () => void;
  let session: {
    start: ReturnType<typeof vi.fn<ProfilerSession['start']>>;
    stop: ReturnType<typeof vi.fn<ProfilerSession['stop']>>;
    close: ReturnType<typeof vi.fn<ProfilerSession['close']>>;
  };
  let warn: ReturnType<typeof vi.fn<(message: string, details: Record<string, unknown>) => void>>;

  beforeEach(async () => {
    folder = path.join(await mkdtemp(path.join(tmpdir(), 'stall-profiler-')), 'profiles');
    time = Date.UTC(2026, 9, 31);
    endCapture = () => {};
    session = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        return { nodes: [] };
      }),
      close: vi.fn(),
    };
    warn = vi.fn();
  });

  function profiler(createSession: () => ProfilerSession = () => session) {
    return createStallProfiler({
      dir: folder,
      warn,
      createSession,
      now: () => time,
      wait: () =>
        new Promise<void>((resolve) => {
          endCapture = resolve;
        }),
    });
  }

  /** Lets the capture reach its wait, ends it, and waits until the session is closed. */
  async function finishCapture(closes = 1): Promise<void> {
    await vi.waitFor(() => expect(session.start).toHaveBeenCalled());
    await Promise.resolve();
    endCapture();
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(closes));
  }

  it('does not start for a short stall', () => {
    profiler().noteStall(1_999);

    expect(session.start).not.toHaveBeenCalled();
  });

  it('keeps the profile when another stall lands inside it', async () => {
    const stalls = profiler();
    stalls.noteStall(2_000);
    stalls.noteStall(1_200);

    await finishCapture();

    const files = await readdir(folder);
    expect(files).toEqual(['main-stall-2026-10-31T00-00-00-000Z.cpuprofile']);
    const saved = await readFile(path.join(folder, files[0] ?? ''), 'utf8');
    expect(JSON.parse(saved)).toEqual({ nodes: [] });
    expect(warn).toHaveBeenCalledWith(
      'main: saved a CPU profile of a stall',
      expect.objectContaining({ stalls: 1 })
    );
  });

  it('discards a profile with no stall in it, and waits before trying again', async () => {
    const stalls = profiler();
    stalls.noteStall(5_000);
    await finishCapture();

    await expect(readdir(folder)).rejects.toThrow();

    time += 5 * MINUTE - 1;
    stalls.noteStall(5_000);
    expect(session.start).toHaveBeenCalledTimes(1);

    time += 1;
    stalls.noteStall(5_000);
    expect(session.start).toHaveBeenCalledTimes(2);
  });

  it('waits longer after saving one', async () => {
    const stalls = profiler();
    stalls.noteStall(5_000);
    stalls.noteStall(5_000);
    await finishCapture();

    time += 30 * MINUTE - 1;
    stalls.noteStall(5_000);
    expect(session.start).toHaveBeenCalledTimes(1);

    time += 1;
    stalls.noteStall(5_000);
    expect(session.start).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest few profiles', async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'main-stall-2000.cpuprofile'), '{}');
    for (let index = 1; index <= 5; index += 1) {
      await writeFile(path.join(folder, `main-stall-2026-01-0${index}.cpuprofile`), '{}');
    }
    const stalls = profiler();
    stalls.noteStall(5_000);
    stalls.noteStall(5_000);

    await finishCapture();

    const files = await readdir(folder);
    expect(files).toHaveLength(5);
    expect(files).not.toContain('main-stall-2000.cpuprofile');
    expect(files).toContain('main-stall-2026-10-31T00-00-00-000Z.cpuprofile');
  });

  it('turns itself off when the profiler cannot run', async () => {
    const createSession = vi.fn((): ProfilerSession => {
      throw new Error('ERR_INSPECTOR_NOT_AVAILABLE');
    });
    const stalls = profiler(createSession);

    stalls.noteStall(5_000);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('main: stall profiling turned off', {
        error: expect.stringContaining('ERR_INSPECTOR_NOT_AVAILABLE'),
      })
    );
    stalls.noteStall(5_000);

    expect(createSession).toHaveBeenCalledOnce();
  });
});
