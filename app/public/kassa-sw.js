'use strict';

// Сервис-воркер окна кассы: без интернета касса открывается из памяти устройства, со справочником товаров,
// способами оплаты и сменой — такими, какими они были при последней связи. Чеки без связи копит kassa-offline.js.
const CACHE = 'kassa-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kassa-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Эти ответы сервера нужны, чтобы касса работала без связи (последняя версия из памяти).
const API_KEEP = /^\/api\/(status|products|shift|registers|payment-methods|kassa\/users|loyalty|print-designs|design|categories|shift\/info|tasks)/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/api/events') return; // поток уведомлений — только живой
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && !API_KEEP.test(url.pathname)) return;
  // Сначала сеть (свежие цены и остатки), без сети — сохранённая копия.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (req.mode === 'navigate' || isApi || /\.(js|css|svg|png|jpg|jpeg|webp|woff2?|webmanifest)$/.test(url.pathname) || url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(isApi ? req : new Request(url.pathname), copy)).catch(() => {});
    }
    return res;
  }).catch(async () => {
    const c = await caches.open(CACHE);
    const hit = (await c.match(isApi ? req : new Request(url.pathname))) || (await c.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (req.mode === 'navigate') return (await c.match(new Request('/kassa.html'))) || Response.error();
    if (isApi) return new Response(JSON.stringify({ error: 'Нет интернета' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    return Response.error();
  }));
});
