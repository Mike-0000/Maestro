import { useState } from 'react';

/**
 * When the conductor last started working, in ms, while it still is; null while it is not. The
 * session does not keep this, so the screen notes it as `busy` turns true. A turn that was
 * already running when the screen opened counts from then.
 */
export function useBusySince(busy: boolean): number | null {
  const [since, setSince] = useState<number | null>(() => (busy ? Date.now() : null));
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    // Adjusting state while rendering, the React way to follow a prop change.
    setWasBusy(busy);
    setSince(busy ? Date.now() : null);
  }
  return since;
}
