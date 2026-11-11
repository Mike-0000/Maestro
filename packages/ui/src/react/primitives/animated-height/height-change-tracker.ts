/**
 * Decides which ResizeObserver height observations should trigger an
 * animation.
 *
 * ResizeObserver fires once right after `observe()`. When that first
 * observation matches the height measured synchronously before first paint it
 * is a no-op (animating it would replay the initial mount). When it differs,
 * the content changed between the measurement and the first callback (a modal
 * swapping its loading state for the real body in that window): that is a real
 * change and must be signalled, otherwise the box stays pinned to the stale
 * initial height until some later resize happens to occur.
 */
export function createHeightChangeTracker(initialHeight: number | undefined) {
  let lastHeight = initialHeight;

  return {
    /** Returns the height to animate to, or null when nothing should happen. */
    observe(height: number): number | null {
      if (lastHeight === undefined) {
        // No baseline to animate from: adopt the observation silently.
        lastHeight = height;
        return null;
      }
      if (height === lastHeight) {
        return null;
      }
      lastHeight = height;
      return height;
    },
  };
}
