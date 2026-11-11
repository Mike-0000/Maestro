/**
 * Keyboard activation for elements that are buttons by role (`role="button"`)
 * rather than by tag: Enter and Space fire a click, exactly as a native button
 * would, so ChatRoot's delegated click handler and per-row onClick handlers run
 * unchanged. Repeats are ignored so holding a key does not toggle repeatedly.
 */
export function activateOnKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  if (event.repeat) return;
  (event.currentTarget as HTMLElement).click();
}
