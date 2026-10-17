import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './lib/toast.jsx';
import { BrandingProvider } from './lib/branding.jsx';
import './styles.css';
import { registerServiceWorker } from './lib/install.js';

registerServiceWorker();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <BrandingProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrandingProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
