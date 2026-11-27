import { type ReactNode } from 'react';
import { clientsViewDef } from '@core/features/client-profiles/contributions/views';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { ClientsPage } from './clients-page';

export function ClientsViewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** The title bar's place marker for the Clients view, in the breadcrumb's caption size. */
function ClientsBreadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center px-2 text-xs">
      <span aria-current="page" className="truncate text-foreground-muted">
        Clients
      </span>
    </nav>
  );
}

export function ClientsTitlebar() {
  return <Titlebar leftSlot={<ClientsBreadcrumb />} />;
}

export function ClientsMainPanel() {
  return <ClientsPage />;
}

export const clientsViewRuntime = defineViewRuntime(clientsViewDef, {
  slots: {
    wrap: ClientsViewWrapper,
    titlebar: ClientsTitlebar,
    main: ClientsMainPanel,
  },
});
