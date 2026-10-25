import type { SoundEvent } from '@core/primitives/agents/api';

/**
 * Plays a notification sound from the renderer, under the developer's notification settings
 * (sound on, focus mode). The host bootstrap registers the player; slices that decide on their
 * own that the developer should be called (the conductor, for a finished agent it judged to need
 * them) play through here rather than reaching into the settings slice.
 */
export type NotificationSoundPlayer = (sound: SoundEvent, dedupeKey?: string) => void;

let player: NotificationSoundPlayer | null = null;

export function setNotificationSoundPlayer(next: NotificationSoundPlayer | null): () => void {
  player = next;
  return () => {
    if (player === next) player = null;
  };
}

export function playNotificationSound(sound: SoundEvent, dedupeKey?: string): void {
  player?.(sound, dedupeKey);
}
