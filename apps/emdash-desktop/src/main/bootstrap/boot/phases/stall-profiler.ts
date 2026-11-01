import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import path from 'node:path';

/** Stalls shorter than this are not worth a profile. */
const TRIGGER_STALL_MS = 2_000;
/** Long enough for the stall log's 10 s windows to say whether another stall happened. */
const CAPTURE_MS = 31_000;
const SAMPLING_INTERVAL_US = 5_000;
const COOLDOWN_AFTER_SAVE_MS = 30 * 60_000;
const COOLDOWN_AFTER_DISCARD_MS = 5 * 60_000;
const KEPT_PROFILES = 5;

export type ProfilerSession = {
  start(samplingIntervalUs: number): Promise<void>;
  stop(): Promise<unknown>;
  close(): void;
};

export type StallProfilerOptions = {
  dir: string;
  warn(message: string, details: Record<string, unknown>): void;
  createSession?: () => ProfilerSession;
  now?: () => number;
  /** How the capture waits out its length. */
  wait?: (ms: number) => Promise<void>;
};

export type StallProfiler = {
  /** The stall log saw the event loop blocked for this long. */
  noteStall(delayMs: number): void;
};

/**
 * Captures what the main thread runs during a stall. A stall can only be reported once it is over,
 * but they come in runs, so one stall starts a profile and the file is kept only if another stall
 * landed inside it. Files hold function names and script paths, not data, and stay on this machine.
 * Best-effort: any failure turns profiling off for the session and leaves the app alone.
 */
export function createStallProfiler(options: StallProfilerOptions): StallProfiler {
  const createSession = options.createSession ?? createInspectorSession;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  let capturing = false;
  let disabled = false;
  let stallsDuringCapture = 0;
  let nextCaptureAt = 0;

  const fail = (error: unknown): void => {
    disabled = true;
    options.warn('main: stall profiling turned off', { error: String(error) });
  };

  const capture = async (): Promise<void> => {
    capturing = true;
    stallsDuringCapture = 0;
    let session: ProfilerSession | undefined;
    try {
      session = createSession();
      await session.start(SAMPLING_INTERVAL_US);
      await wait(CAPTURE_MS);
      const profile = await session.stop();
      if (stallsDuringCapture === 0) {
        nextCaptureAt = now() + COOLDOWN_AFTER_DISCARD_MS;
        return;
      }
      nextCaptureAt = now() + COOLDOWN_AFTER_SAVE_MS;
      const file = await saveProfile(options.dir, profile, now());
      options.warn('main: saved a CPU profile of a stall', {
        file,
        stalls: stallsDuringCapture,
      });
    } catch (error) {
      fail(error);
    } finally {
      try {
        session?.close();
      } catch {
        // Already gone.
      }
      capturing = false;
    }
  };

  return {
    noteStall(delayMs) {
      if (disabled) return;
      if (capturing) {
        stallsDuringCapture += 1;
        return;
      }
      if (delayMs < TRIGGER_STALL_MS || now() < nextCaptureAt) return;
      void capture();
    },
  };
}

async function saveProfile(dir: string, profile: unknown, at: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = `main-stall-${new Date(at).toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(profile));
  const saved = (await readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile')).sort();
  await Promise.all(
    saved
      .slice(0, Math.max(0, saved.length - KEPT_PROFILES))
      .map((entry) => rm(path.join(dir, entry), { force: true }))
  );
  return file;
}

function createInspectorSession(): ProfilerSession {
  const session = new Session();
  session.connect();
  return {
    async start(samplingIntervalUs) {
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
      await session.post('Profiler.start');
    },
    async stop() {
      const { profile } = await session.post('Profiler.stop');
      return profile;
    },
    close() {
      session.disconnect();
    },
  };
}
