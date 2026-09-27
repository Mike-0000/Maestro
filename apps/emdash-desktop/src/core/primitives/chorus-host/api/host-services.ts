import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

/**
 * Host capabilities the Chorus voice and conductor slices need from the Electron main process.
 * Injected through the controller context so the slices never import Electron directly.
 */
export type ChorusHostServices = {
  /** OS-encrypted secret storage (Electron safeStorage; DPAPI on Windows). */
  readonly secrets: SecretStore;
  /** Directory for Chorus-owned settings files inside the app profile. */
  readonly dataDir: string;
  /** Host-owned local install facts. Null means this process cannot replace a packaged install. */
  readonly delivery: {
    readonly installRoot: string | null;
    readonly installWorkerPath: string | null;
    readonly profileRoot: string;
  };
  readonly globalShortcuts: {
    /** Returns false when the OS or another app already owns the accelerator. */
    register(accelerator: string, onPress: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /**
   * System-wide key hook for global hold-to-talk. Reports only key codes (never text) and is
   * started only when the user turns global hold-to-talk on. Returns false if it cannot start.
   */
  readonly keyboardHook: {
    start(onKey: (event: { type: 'down' | 'up'; keycode: number }) => void): boolean;
    stop(): void;
  };
  /** Opens the OS microphone privacy settings (a fixed system URL, never caller-supplied). */
  openMicrophoneSettings(): Promise<void>;
};
