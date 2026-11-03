'use strict';

// Сервис-воркер витрины: витрина ставится на телефон как приложение и открывается даже без интернета
// (последняя загруженная версия), а без сети вообще — показывает понятное сообщение.
const CACHE = 'shop-v1';
const SHELL = ['/shop.css', '/shop.js', '/colors.js', '/shop/theme.css', '/shop/favicon'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const OFFLINE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Нет интернета</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;color:#222}
button{font:inherit;padding:12px 22px;border-radius:12px;border:0;background:#111;color:#fff;margin-top:12px}</style></head>
<body><div><div style="font-size:48px">📡</div><h1 style="font-size:20px">Нет интернета</h1><p>Проверьте подключение и попробуйте ещё раз.</p>
<button onclick="location.reload()">Обновить</button></div></body></html>`;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Данные, заказы, вход — только из сети: цены и остатки всегда свежие.
  if (url.pathname.startsWith('/shop/data') || url.pathname.startsWith('/shop/account') || url.pathname.startsWith('/shop/order') || url.pathname.startsWith('/api/')) return;
  // Страница: сначала сеть, без сети — сохранённая копия или сообщение «Нет интернета».
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('/__page', copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('/__page').then((r) => r || new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  // Стили, скрипты, фото товаров: сеть, а без сети — из кэша; фото кладём в кэш по мере просмотра.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/shop/photo/') || url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || Response.error())));
});
