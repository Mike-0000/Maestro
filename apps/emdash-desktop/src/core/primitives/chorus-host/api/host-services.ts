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
  readonly globalShortcuts: {
    /** Returns false when the OS or another app already owns the accelerator. */
    register(accelerator: string, onPress: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /** Opens the OS microphone privacy settings (a fixed system URL, never caller-supplied). */
  openMicrophoneSettings(): Promise<void>;
};
