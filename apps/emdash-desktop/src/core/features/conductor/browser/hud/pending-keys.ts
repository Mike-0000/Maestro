/** Enter presses this soon after a pending action appears were meant for something else. */
export const CONFIRM_KEY_GRACE_MS = 400;

type KeyTarget = {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): unknown;
};

/** True when keys typed here belong to a text field or an agent terminal. */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as KeyTarget;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(element.closest?.('.xterm, [contenteditable="true"]'));
}

export type PendingKeyAction = 'confirm' | 'cancel' | null;

/**
 * What a key press does while a conductor action is pending. Escape always cancels (the safe
 * direction). Enter confirms only when it cannot have been meant for a text field or terminal,
 * is not auto-repeat, and was not pressed in the instant the action appeared.
 */
export function pendingKeyAction(
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly repeat: boolean;
    readonly isComposing?: boolean;
    readonly target: unknown;
  },
  pendingStartedAt: number,
  now: number
): PendingKeyAction {
  if (event.key === 'Escape') return 'cancel';
  if (event.key !== 'Enter' || event.shiftKey || event.repeat || event.isComposing) return null;
  if (isTextEntryTarget(event.target)) return null;
  if (now - pendingStartedAt < CONFIRM_KEY_GRACE_MS) return null;
  return 'confirm';
}
