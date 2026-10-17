// "Install the app" support: Android / desktop Chrome & Edge use the native prompt,
// iPhone / iPad need manual "Add to Home Screen" instructions.
import { useEffect, useState } from 'react';

let deferred = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
}

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const fn = () => force((n) => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
  const installed = isStandalone();
  return {
    installed,
    canPrompt: !!deferred && !installed,
    ios: isIOS() && !installed,
    async prompt() {
      if (!deferred) return false;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      emit();
      return outcome === 'accepted';
    },
  };
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
