type PasteKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * Whether a key press in the sign-in terminal should paste from the clipboard.
 *
 * Off macOS, xterm turns Ctrl+V into a literal ^V for the PTY, so the browser never pastes and a
 * copied authorization code cannot get in. A sign-in prompt has no use for ^V, so Ctrl+V,
 * Ctrl+Shift+V and Shift+Insert all paste here. On macOS Cmd+V already pastes natively.
 */
export function isLoginTerminalPasteShortcut(event: PasteKeyEvent, isMac: boolean): boolean {
  if (isMac || event.type !== 'keydown' || event.metaKey || event.altKey) return false;
  if (event.key === 'Insert') return event.shiftKey && !event.ctrlKey;
  return event.ctrlKey && event.key.toLowerCase() === 'v';
}

/**
 * Clipboard text as it should reach the sign-in prompt. Codes copied from a browser often carry a
 * trailing newline or spaces; a pasted newline would submit early or corrupt the code.
 */
export function normalizeLoginPaste(text: string): string {
  return text.trim();
}
