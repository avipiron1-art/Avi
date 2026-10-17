// Subscribe this device to push notifications (Web Push).
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { isIOS, isStandalone } from './install.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function usePush() {
  const [state, setState] = useState({ status: 'loading' });

  const refresh = async () => {
    if (isIOS() && !isStandalone()) return setState({ status: 'ios-install' });
    if (!supported()) return setState({ status: 'unsupported' });
    if (Notification.permission === 'denied') return setState({ status: 'denied' });
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    setState({ status: sub ? 'on' : 'off' });
  };
  useEffect(() => { refresh().catch(() => setState({ status: 'unsupported' })); }, []);

  const enable = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { await refresh(); throw new Error('לא ניתן אישור להצגת התראות. אפשר לאשר בהגדרות הדפדפן.'); }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await api.get('/notifications/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    const json = sub.toJSON();
    await api.post('/notifications/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    await refresh();
  };

  const disable = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api.post('/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    await refresh();
  };

  return { ...state, enable, disable };
}
