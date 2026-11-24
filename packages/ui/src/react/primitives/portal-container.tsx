import { createContext, useContext, type ReactNode } from 'react';

const PortalContainerContext = createContext<HTMLElement | null>(null);

/**
 * Where the kit's floating layers (menus, popovers, tooltips, dialogs, selects, sheets) mount
 * for the subtree below. Without a provider they mount in the page's own `document.body`.
 *
 * A subtree rendered into another window (a React portal into a child window's document) sets
 * this to an element of that window, so its menus open next to it, not in the main window.
 */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

/** The container floating layers mount in, or undefined for the default `document.body`. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
