import { createContext, useContext } from 'react';
import type { AppStore } from '../state/app-store';
import type { Router } from '../state/router';

export type AppServices = { app: AppStore; router: Router };

export const AppContext = createContext<AppServices | null>(null);

function useServices(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('AppContext is missing: render inside <AppContext.Provider>');
  return services;
}

export function useApp(): AppStore {
  return useServices().app;
}

export function useRouter(): Router {
  return useServices().router;
}
