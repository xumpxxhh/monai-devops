import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import { routerBasename } from './config/env';
import { applyTheme, readStoredTheme } from './shared/theme/theme';
import { Toaster } from './shared/ui/Toast';
import './index.css';
import App from './App.tsx';

applyTheme(readStoredTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <App />
      <Toaster />
    </BrowserRouter>
  </StrictMode>,
);
