import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles.css';
import { registerServiceWorker } from './lib/service-worker';
import { AppStore } from './state/app-store';
import { Router } from './state/router';
import { App } from './ui/App';
import { AppContext, type AppServices } from './ui/app-context';

const services: AppServices = { app: new AppStore(), router: new Router() };

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
