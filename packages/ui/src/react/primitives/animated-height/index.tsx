'use client';

import { cx } from '@styles/utilities/cx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HEIGHT_TRANSITION_DURATION_MS } from './constants';
import { createHeightChangeTracker } from './height-change-tracker';
import * as styles from './animated-height.css';

export interface AnimatedHeightProps {
  children: React.ReactNode;
  className?: string;
  /** Notified when the height transition starts and when it settles. */
  onAnimatingChange?: (isAnimating: boolean) => void;
  /**
   * The box sits in a height-limited flex column (a dialog between its header
   * and footer): it may shrink below its content, and scrolls when it does,
   * instead of pushing the content under the footer. Content that grows after
   * mount (a fetch) is covered too.
   */
  constrain?: boolean;
}

/**
 * Smoothly animates its own height whenever the content's height changes
 * (e.g. a modal swapping steps). The initial mount never animates, and
 * overflow is only clipped while a transition is running so popovers and
 * menus rendered inside can escape the box at rest.
 */
export function AnimatedHeight({
  children,
  className,
  onAnimatingChange,
  constrain = false,
}: AnimatedHeightProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  // Track the last observed height in a ref so the ResizeObserver callback
  // can seed its change tracker after remounts (React StrictMode re-runs
  // effects) without re-measuring. The tracker compares ResizeObserver's
  // first callback against this baseline, so content that changes between
  // the measurement and that callback still moves the row.
  const lastHeightRef = useRef<number | undefined>(undefined);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [isAnimating, setIsAnimating] = useState(false);

  // Measure the initial height synchronously before the first paint so the
  // grid row starts at an explicit pixel value instead of `1fr`. This
  // prevents any animation on mount.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const initial = el.offsetHeight;
    lastHeightRef.current = initial;
    setHeight(initial);
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const tracker = createHeightChangeTracker(lastHeightRef.current);
    const observer = new ResizeObserver(() => {
      const next = tracker.observe(el.offsetHeight);
      if (next === null) return;
      lastHeightRef.current = next;
      setHeight(next);
      setIsAnimating(true);
      // Safety net: transitionend never fires when the element is not
      // rendered (e.g. inside a display:none subtree), which would leave
      // overflow clipped forever. (Re)arm a timer slightly past the
      // transition; transitionend clears it and settles earlier.
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(
        () => setIsAnimating(false),
        HEIGHT_TRANSITION_DURATION_MS + 50
      );
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(settleTimerRef.current);
    };
  }, []);

  // Constrained: compare the box (shrunk by its flex parent) with its content
  // and only turn on scrolling when the content does not fit, so popovers
  // rendered inline can still escape the box at rest.
  useEffect(() => {
    const root = rootRef.current;
    const el = contentRef.current;
    if (!constrain || !root || !el) return;
    const update = () => setIsOverflowing(el.offsetHeight > root.clientHeight + 1);
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [constrain]);

  useEffect(() => {
    onAnimatingChange?.(isAnimating);
  }, [isAnimating, onAnimatingChange]);

  return (
    <div
      ref={rootRef}
      data-slot="animated-height"
      data-animating={isAnimating ? '' : undefined}
      data-overflowing={constrain && isOverflowing ? '' : undefined}
      className={cx(styles.root, constrain && styles.constrained, className)}
      style={height === undefined ? undefined : { gridTemplateRows: `${height}px` }}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== 'grid-template-rows') return;
        clearTimeout(settleTimerRef.current);
        setIsAnimating(false);
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
