// Shiftly service worker: makes the app installable, speeds up loading, and shows a friendly
// offline screen. API calls are never cached – data always comes live from the server.
const VERSION = 'shiftly-v3';
const OFFLINE_URL = '/offline.html';
const SHELL = '/'; // the app page (the same index.html serves every screen)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll([OFFLINE_URL, '/icons/icon-192.png', SHELL])));
  self.skipWaiting();
});

/** Fetch the app page and save it; tell open windows when a new version arrived. */
async function refreshShell(req, cache, before) {
  const res = await fetch(req);
  if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
    const text = await res.clone().text();
    await cache.put(SHELL, res.clone());
    if (before && before !== text) {
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach((w) => w.postMessage({ type: 'update-ready' }));
    }
  }
  return res;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: open instantly from the saved copy and update it in the background (the next open, or a quick
  // reload when the new version arrives right away, shows it). First visit / nothing saved: the network.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const saved = await cache.match(SHELL);
      if (saved) {
        const before = await saved.clone().text();
        event.waitUntil(refreshShell(req, cache, before).catch(() => {}));
        return saved;
      }
      return refreshShell(req, cache, null).catch(() => caches.match(OFFLINE_URL));
    })());
    return;
  }

  // Built assets have content hashes in their names, so a cached copy is always correct
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});

// ---------- push notifications ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const title = data.title || 'Shiftly';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.urgent,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); if ('navigate' in c) await c.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
