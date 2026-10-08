import { createContext, useContext } from 'react';
import type { AppStore } from '../state/app-store';
import type { PushStore } from '../state/push-store';
import type { Router } from '../state/router';
import type { VoiceStore } from '../state/voice-store';

export type AppServices = { app: AppStore; router: Router; voice: VoiceStore; push: PushStore };

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

export function useVoice(): VoiceStore {
  return useServices().voice;
}

export function usePush(): PushStore {
  return useServices().push;
}
