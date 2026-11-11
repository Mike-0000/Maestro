import { useEffect, useState } from 'react';

/**
 * The time now, in ms, read again every `intervalMs`, so ages and running clocks on screen move
 * on their own. Null holds the clock still. A change of interval reads the time at once, so a
 * clock that starts ticking never shows a stale value first.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
