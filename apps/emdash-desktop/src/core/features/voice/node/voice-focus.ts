import { basename, dirname } from 'node:path';
import { z } from 'zod';

// Several Maestro processes can run on one computer at once: the local app and any number of
// client-mode profiles. Each would register the same global talk keys, so a hold-to-talk would
// record in all of them and the toggle shortcut would belong to whichever registered first. The
// keys act only in the Maestro window the developer focused last: each process writes a small
// marker file in the shared appData root when its window gains focus, watches it, and turns its
// own keys on or off by whether the marker names it.

/** The marker's file name beside the per-profile user-data directories. */
export function voiceFocusFileName(userDataDirName: string): string {
  return `${userDataDirName}-voice-focus.json`;
}

const markerSchema = z.object({
  pid: z.number().int().positive(),
  /** The client profile (`''` for the default client), or null for the local app. */
  profile: z.string().nullable(),
  at: z.number(),
});
export type VoiceFocusMarker = z.infer<typeof markerSchema>;

export type VoiceFocusPorts = {
  /** The file's text, or null when it does not exist or cannot be read. */
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  removeFile(path: string): void;
  /** Calls `onChange` when `fileName` in `dir` may have changed; returns a stop function. */
  watch(dir: string, fileName: string, onChange: () => void): () => void;
  isPidAlive(pid: number): boolean;
  now(): number;
};

/** Who may use the global talk keys, as seen by one process. */
export type VoiceFocusGate = {
  active(): boolean;
  /** Called with the new value whenever it changes. Returns an unsubscribe function. */
  subscribe(listener: (active: boolean) => void): () => void;
};

/**
 * Whether the process `self` may use the global talk keys: it holds the marker, or nobody holds a
 * live one and it is the local app (clients wait until their window is focused).
 */
export function holdsVoiceFocus(
  marker: VoiceFocusMarker | null,
  self: { pid: number; profile: string | null },
  isPidAlive: (pid: number) => boolean
): boolean {
  if (marker && marker.pid === self.pid) return true;
  if (marker && isPidAlive(marker.pid)) return false;
  return self.profile === null;
}

export class VoiceFocus implements VoiceFocusGate {
  private readonly listeners = new Set<(active: boolean) => void>();
  private current = false;
  private stopWatch: (() => void) | null = null;

  constructor(
    private readonly options: {
      path: string;
      pid: number;
      profile: string | null;
      ports: VoiceFocusPorts;
    }
  ) {
    this.current = this.evaluate();
  }

  /** Starts following other processes' claims. */
  start(): void {
    if (this.stopWatch) return;
    try {
      this.stopWatch = this.options.ports.watch(
        dirname(this.options.path),
        basename(this.options.path),
        () => this.refresh()
      );
    } catch {
      // Without a watcher this process still claims on focus; it just learns of others' claims
      // on its next own claim or refresh.
      this.stopWatch = null;
    }
    this.refresh();
  }

  /** This process's window gained focus. */
  claim(): void {
    const held = this.read();
    if (held !== null && held !== 'unreadable' && held.pid === this.options.pid) {
      this.set(true);
      return;
    }
    const marker: VoiceFocusMarker = {
      pid: this.options.pid,
      profile: this.options.profile,
      at: this.options.ports.now(),
    };
    try {
      this.options.ports.writeFile(this.options.path, JSON.stringify(marker));
    } catch {
      // A read-only appData still lets this process use its keys while it is focused.
    }
    this.set(true);
  }

  /** The process is quitting: hand the keys back by dropping a marker that names it. */
  release(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    const marker = this.read();
    if (marker === null || marker === 'unreadable' || marker.pid !== this.options.pid) return;
    try {
      this.options.ports.removeFile(this.options.path);
    } catch {
      // A stale marker is treated as absent once this pid is gone.
    }
  }

  active(): boolean {
    return this.current;
  }

  subscribe(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Re-reads the marker (the watcher calls this). */
  refresh(): void {
    this.set(this.evaluate());
  }

  private evaluate(): boolean {
    const marker = this.read();
    // A marker caught mid-write by another process: keep the current answer until it settles.
    if (marker === 'unreadable') return this.current;
    return holdsVoiceFocus(
      marker,
      { pid: this.options.pid, profile: this.options.profile },
      this.options.ports.isPidAlive
    );
  }

  private read(): VoiceFocusMarker | null | 'unreadable' {
    const text = this.options.ports.readFile(this.options.path);
    if (!text) return null;
    try {
      const parsed = markerSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  private set(active: boolean): void {
    if (active === this.current) return;
    this.current = active;
    for (const listener of [...this.listeners]) listener(active);
  }
}
