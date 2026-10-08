import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles.css';
import { onNotificationNavigate, registerServiceWorker } from './lib/service-worker';
import { installRandomUuidFallback } from './lib/uuid';
import { AppStore } from './state/app-store';
import { PushStore } from './state/push-store';
import { parseRoute, Router } from './state/router';
import { VoiceStore } from './state/voice-store';
import { App } from './ui/App';
import { AppContext, type AppServices } from './ui/app-context';

installRandomUuidFallback();

const app = new AppStore();
const router = new Router();
const services: AppServices = {
  app,
  router,
  voice: new VoiceStore(app),
  push: new PushStore(app),
};

const container = document.getElementById('root');
if (!container) throw new Error('Maestro web client: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <AppContext.Provider value={services}>
      <App />
    </AppContext.Provider>
  </StrictMode>
);

registerServiceWorker();
onNotificationNavigate((path) => router.push(parseRoute(path)));
