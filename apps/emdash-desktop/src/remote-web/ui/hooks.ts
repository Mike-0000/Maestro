import { useEffect, useState, useSyncExternalStore } from 'react';

/** Joins class names, skipping falsy entries. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches
  );
}

/** Wide enough for the list and an agent side by side. */
export function useIsWide(): boolean {
  return useMediaQuery('(min-width: 900px)');
}

/** A keyboard this much shorter than the layout viewport is an on-screen keyboard, not a toolbar. */
const KEYBOARD_MIN_HEIGHT = 120;

/**
 * Tracks the visual viewport into CSS variables that size `.app-frame`.
 *
 * iOS never resizes the layout viewport for the on-screen keyboard: it shrinks the visual
 * viewport and scrolls the page to reveal the focused field. Pinning the app to the visual
 * viewport's box keeps the composer directly above the keyboard, with no document scroll and
 * no jump. (Android resizes the layout viewport — see the viewport meta — and lands on the
 * same numbers.)
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) return;
    let frame = 0;
    const apply = (): void => {
      frame = 0;
      root.style.setProperty('--vv-height', `${viewport.height}px`);
      root.style.setProperty('--vv-top', `${viewport.offsetTop}px`);
      const keyboardOpen = window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT;
      root.toggleAttribute('data-keyboard-open', keyboardOpen);
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-top');
      root.removeAttribute('data-keyboard-open');
    };
  }, []);
}

/** Re-renders when the system theme (and with it the token values) changes. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setVersion((current) => current + 1);
    window.addEventListener('maestro-theme-change', bump);
    return () => window.removeEventListener('maestro-theme-change', bump);
  }, []);
  return version;
}
