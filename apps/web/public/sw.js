/* global self, caches, URL, fetch, Response */
const CACHE = 'omnihub-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/pwa-icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('omnihub-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      try { const response = await fetch(request); if (response.ok) await cache.put(request, response.clone()); return response; }
      catch { const cached = await cache.match(request); return cached ?? Response.error(); }
    }));
    return;
  }
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(request).then(async response => { if (response.ok) await (await caches.open(CACHE)).put('/', response.clone()); return response; }).catch(async () => (await caches.match('/')) ?? Response.error()));
    return;
  }
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/pwa-icon.svg') {
    event.respondWith(caches.match(request).then(cached => cached ?? fetch(request)));
  }
});
