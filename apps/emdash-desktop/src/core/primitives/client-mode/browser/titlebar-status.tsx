import { useSyncExternalStore, type ComponentType } from 'react';

let registered: ComponentType | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hands the title bars the component that shows the link to the host. Only the client-mode
 * bootstrap calls it, so in a local window nothing is ever registered. Pass null to clear it.
 */
export function registerClientTitlebarStatus(component: ComponentType | null): void {
  registered = component;
  for (const listener of [...listeners]) listener();
}

/**
 * The title bars' slot for client-mode status. A seam on purpose: the title bars stay free of
 * the client-mode feature and its imports, and render nothing here unless one was registered.
 */
export function ClientTitlebarStatus() {
  const Status = useSyncExternalStore(subscribe, () => registered);
  return Status ? <Status /> : null;
}
