'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
const { createStore, UserError } = require('./db');
const { seedDemo } = require('./demo');
const crypto = require('node:crypto');
const { createAuth, hashPassword, checkPassword } = require('./auth');
const { RIGHTS, ROLES, rightsOf, can } = require('./roles');
const { themeCss, shopCss } = require('./theme');
const { createNotifier } = require('./notify');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || 'data/shop.db');
const PUBLIC = path.join(__dirname, 'public');
const MAX_RANGE = 800 * 864e5;
// Без входа можно открыть только страницу входа и её стили.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/manifest.webmanifest', '/icon.svg', '/shop.css', '/shop.js']);
const ORDER_LIMIT = 5; // заказов с одного адреса за 10 минут — защита от спама
const orderLog = new Map(); // ip -> [время заказа]

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// Простой разбор .env: строки KEY=value, # — комментарии.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const store = createStore(DB_FILE);

// Администратор из переменных. APP_PASSWORD — пароль из прошлых версий, где вход был без email.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || '';
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 8) {
    console.error('Пароль администратора в ADMIN_PASSWORD должен быть не короче 8 символов.');
    process.exit(1);
  }
  const fingerprint = crypto.createHash('sha256').update(`${ADMIN_EMAIL.toLowerCase()}\n${ADMIN_PASSWORD}`).digest('hex');
  store.ensureAdmin(ADMIN_EMAIL, () => hashPassword(ADMIN_PASSWORD), fingerprint);
}
if (process.env.REQUIRE_PASSWORD === '1' && store.activeAdmins() === 0) {
  console.error('Задайте администратора в переменных ADMIN_EMAIL и ADMIN_PASSWORD. Без него программа на сервере не запускается.');
  process.exit(1);
}

const notifier = createNotifier(store);
const auth = createAuth(store, process.env.SESSION_SECRET || store.setting('session_secret', crypto.randomBytes(32).toString('base64url')));

// Сотрудник с правом «Сотрудники», но не администратор, не может назначать
// администраторов и менять их: иначе он выдал бы себе все права.
function guardAdmin(user, target, body) {
  if (!user || user.role === 'admin') return;
  if (target?.role === 'admin' || body.role === 'admin') throw new UserError('Администраторов назначает и меняет только администратор');
  if (target && target.id === user.id && body.rights !== undefined) throw new UserError('Свои права может поменять только администратор');
}

function password(value) {
  const s = String(value ?? '');
  if (s.length < 8) throw new UserError('Пароль должен быть не короче 8 символов');
  if (s.length > 200) throw new UserError('Слишком длинный пароль');
  return hashPassword(s);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20e6) throw new UserError('Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new UserError('Запрос не похож на JSON');
  }
}

function range(url) {
  const to = Number(url.searchParams.get('to')) || Date.now();
  const from = Number(url.searchParams.get('from')) || to - 30 * 864e5;
  if (from >= to || to - from > MAX_RANGE) throw new UserError('Неверный период');
  return { from, to };
}

// [метод, шаблон пути, обработчик(params, url, body, user), нужное право из roles.js]
// 'any' — любому вошедшему сотруднику.
const routes = [
  ['GET', '/api/status', (p, url, body, user) => ({
    empty: store.isEmpty(), auth: auth.enabled, user,
    can: rightsOf(user),
    roles: ROLES,
    rights: RIGHTS,
    loyalty: store.loyalty(),
    design: store.design(),
    shop: { enabled: store.shop().enabled },
    newOrders: can(user, 'orders') ? store.countNewOrders() : 0,
  }), 'any'],
  ['PUT', '/api/me/password', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.updateUser(user.id, {}, password(body.password));
    return { ok: true };
  }, 'any'],

  ['GET', '/api/products', (p, url) => store.listProducts({ archived: url.searchParams.get('archived') === '1' }), 'any'],
  ['POST', '/api/products', (p, url, body) => store.createProduct(body), 'products'],
  ['PUT', '/api/products/:id', (p, url, body) => store.updateProduct(p.id, body), 'products'],
  ['POST', '/api/products/import', (p, url, body) => store.importProducts(body.rows, { update: Boolean(body.update) }), 'import'],
  ['PUT', '/api/products/:id/stock', (p, url, body) => store.setStock(p.id, body.stock), 'stock'],
  // Групповое изменение: удаление требует отдельного права.
  ['POST', '/api/products/bulk', (p, url, body, user) => {
    if (body.action === 'delete' && !can(user, 'products.delete')) throw new UserError('У вас нет права удалять товары');
    return store.bulkProducts(body);
  }, 'products'],
  ['DELETE', '/api/products/:id', (p) => store.bulkProducts({ ids: [Number(p.id)], action: 'delete' }), 'products.delete'],
  ['POST', '/api/products/:id/variants', (p, url, body) => store.createVariants(p.id, body), 'products'],
  ['GET', '/api/barcode', () => ({ barcode: store.newBarcode() }), 'products'],
  ['PUT', '/api/products/:id/photo', (p, url, body) => store.setPhoto(p.id, body), 'photos'],
  ['DELETE', '/api/products/:id/photo', (p) => store.deletePhoto(p.id), 'photos'],

  // Без права «sales» сотрудник видит только свои чеки.
  ['GET', '/api/sales', (p, url, body, user) => store.listSales({ ...range(url), userId: can(user, 'sales') ? null : user.id }), 'pos'],
  ['POST', '/api/sales', (p, url, body, user) => {
    const sale = store.createSale(body, user);
    notifier.sale(sale, user);
    return sale;
  }, 'pos'],
  ['POST', '/api/sales/:id/refund', (p, url, body, user) => store.refundSale(p.id, user), 'refund'],
  ['GET', '/api/arrivals', () => store.listArrivals(), 'arrivals'],
  ['POST', '/api/arrivals', (p, url, body) => store.createArrival(body), 'arrivals'],
  ['GET', '/api/analytics', (p, url) => store.analytics(range(url)), 'dashboard'],
  ['GET', '/api/kpi', (p, url) => store.kpi(range(url)), 'kpi'],
  ['POST', '/api/demo', () => {
    if (!store.isEmpty()) throw new UserError('Пример можно загрузить только в пустую базу');
    seedDemo(store);
    return { ok: true };
  }, 'settings'],

  // Кассир ищет покупателя по телефону и заводит нового прямо на кассе.
  ['GET', '/api/customers/by-phone', (p, url) => store.findCustomerByPhone(url.searchParams.get('phone')), 'pos'],
  ['POST', '/api/customers', (p, url, body) => store.createCustomer(body), 'pos'],
  ['GET', '/api/customers', (p, url) => store.listCustomers({ q: url.searchParams.get('q') || '' }), 'customers'],
  ['GET', '/api/customers/rating', () => store.customerRating(), 'customers'],
  ['GET', '/api/customers/:id/bonus', (p) => store.bonusHistory(p.id), 'customers'],
  ['PUT', '/api/customers/:id', (p, url, body) => store.updateCustomer(p.id, body), 'loyalty'],
  ['POST', '/api/customers/:id/bonus', (p, url, body, user) => store.adjustBonus(p.id, body, user), 'loyalty'],
  ['PUT', '/api/loyalty', (p, url, body) => store.setLoyalty(body), 'loyalty'],

  ['GET', '/api/users', () => store.listUsers(), 'staff'],
  ['POST', '/api/users', (p, url, body, user) => {
    guardAdmin(user, null, body);
    return store.createUser(body, password(body.password));
  }, 'staff'],
  ['PUT', '/api/users/:id', (p, url, body, user) => {
    guardAdmin(user, store.findUser(p.id), body);
    return store.updateUser(p.id, body, body.password ? password(body.password) : null);
  }, 'staff'],
  ['DELETE', '/api/users/:id', (p, url, body, user) => {
    if (user && Number(p.id) === user.id) throw new UserError('Нельзя удалить самого себя');
    guardAdmin(user, store.findUser(p.id), {});
    return store.deleteUser(p.id);
  }, 'staff'],

  ['PUT', '/api/design', (p, url, body) => store.setDesign(body), 'design'],
  ['POST', '/api/images', (p, url, body) => store.addImage(body), 'shop'],
  ['GET', '/api/shop', () => store.shop(), 'shop'],
  ['PUT', '/api/shop', (p, url, body) => store.setShop(body), 'shop'],
  ['GET', '/api/orders', (p, url) => store.listOrders({ status: url.searchParams.get('status') || '' }), 'orders'],
  ['PUT', '/api/orders/:id', (p, url, body, user) => {
    const order = store.setOrderStatus(p.id, body, user);
    if (body.status === 'done' && order.sale_id) notifier.sale({ ...store.getSale(order.sale_id), items: order.items, paid: order.total }, user);
    return order;
  }, 'orders'],

  // Токен бота наружу не отдаём целиком: только признак, что он задан.
  ['GET', '/api/settings/telegram', () => {
    const t = notifier.telegramSettings();
    return { enabled: t.enabled, chatId: t.chatId, hasToken: Boolean(t.token) };
  }, 'settings'],
  ['PUT', '/api/settings/telegram', (p, url, body) => {
    const current = notifier.telegramSettings();
    const next = {
      token: body.token ? String(body.token).trim() : current.token,
      chatId: String(body.chatId ?? current.chatId).trim(),
      enabled: Boolean(body.enabled),
    };
    if (next.token && !/^\d+:[\w-]{20,}$/.test(next.token)) throw new UserError('Токен бота не похож на настоящий: он выглядит как 123456789:AAE…');
    if (next.enabled && (!next.token || !next.chatId)) throw new UserError('Чтобы включить уведомления, укажите токен бота и ID чата');
    store.setSetting('telegram', JSON.stringify(next));
    return { enabled: next.enabled, chatId: next.chatId, hasToken: Boolean(next.token) };
  }, 'settings'],
  ['POST', '/api/settings/telegram/test', async () => {
    try {
      await notifier.sendTelegram('✅ Уведомления о продажах подключены');
    } catch (err) {
      throw new UserError(err.message);
    }
    return { ok: true };
  }, 'settings'],
];

function match(method, pathname) {
  for (const [m, pattern, handler, access] of routes) {
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const found = pathname.match(re);
    if (found) return { handler, access, params: Object.fromEntries(names.map((n, i) => [n, found[i + 1]])) };
  }
  return null;
}

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const result = auth.login(req, body.email || '', body.password || '');
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, { ok: true, user: store.publicUser(result.user) });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.logoutCookie(req));
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

function sendBytes(res, type, data, cache = 'no-cache') {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(data);
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

// Страницы и запросы без входа: оформление, интернет-витрина и её заказы.
async function handlePublic(req, res, url, user) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/theme.css') return sendBytes(res, 'text/css; charset=utf-8', themeCss(store.design()));
  if (req.method === 'GET' && pathname === '/api/brand') return sendJson(res, 200, { name: store.design().name });
  const image = req.method === 'GET' && pathname.match(/^\/img\/(\d+)$/);
  if (image) {
    const found = store.getImage(image[1]);
    if (!found) return sendJson(res, 404, { error: 'Картинки нет' });
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=31536000, immutable');
  }
  if (!pathname.startsWith('/shop')) return false;

  // Сотрудник с правом «Витрина» видит её и до открытия — чтобы настроить.
  const shop = store.shop();
  const preview = (auth.enabled ? Boolean(user) : true) && can(user, 'shop');
  const open = shop.enabled || preview;
  if (req.method === 'GET' && (pathname === '/shop' || pathname === '/shop/')) {
    if (!open) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Магазин закрыт</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">Интернет-магазин пока закрыт.</p>');
    }
    return serveStatic(res, '/shop.html');
  }
  if (req.method === 'GET' && pathname === '/shop/theme.css') return sendBytes(res, 'text/css; charset=utf-8', shopCss(shop));
  if (req.method === 'GET' && pathname === '/shop/data') {
    if (!open) return sendJson(res, 404, { error: 'Витрина закрыта' });
    const { css, ...publicSettings } = shop;
    return sendJson(res, 200, { settings: { ...publicSettings, preview: !shop.enabled }, products: store.shopProducts() });
  }
  const photo = req.method === 'GET' && pathname.match(/^\/shop\/photo\/(\d+)$/);
  if (photo) {
    if (!open || !store.shopPhotoAllowed(photo[1])) return sendJson(res, 404, { error: 'Фото нет' });
    const found = store.getPhoto(photo[1]);
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=86400');
  }
  if (req.method === 'POST' && pathname === '/shop/order') {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (orderLog.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= ORDER_LIMIT) return sendJson(res, 429, { error: 'Слишком много заказов подряд. Попробуйте через несколько минут или позвоните нам.' });
    try {
      const body = await readBody(req);
      // Скрытое поле: люди его не видят и не заполняют, а боты заполняют.
      if (body.website) return sendJson(res, 200, { ok: true, id: 0 });
      const order = store.createOrder(body);
      recent.push(now);
      orderLog.set(ip, recent);
      notifier.order(order);
      return sendJson(res, 200, { ok: true, id: order.id, total: order.total });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Не получилось оформить заказ. Попробуйте ещё раз или позвоните нам.' });
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // SAMEORIGIN, а не DENY: конструктор витрины показывает её предпросмотр во фрейме.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if ((await handleAuth(req, res, url)) !== false) return;
  } catch (err) {
    return sendJson(res, err instanceof UserError ? 400 : 500, { error: err instanceof UserError ? err.message : 'Внутренняя ошибка' });
  }
  const user = auth.currentUser(req);
  try {
    if ((await handlePublic(req, res, url, user)) !== false) return;
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Внутренняя ошибка' });
  }
  if (auth.enabled && !user && !PUBLIC_PATHS.has(url.pathname)) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Нужно войти' });
    res.writeHead(302, { Location: '/login.html' });
    return res.end();
  }
  if (!url.pathname.startsWith('/api/')) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Неверный адрес' });
    }
    return serveStatic(res, pathname);
  }
  // Фото товара отдаётся картинкой, а не JSON. Смотреть фото может любой вошедший.
  const photo = req.method === 'GET' && url.pathname.match(/^\/api\/products\/(\d+)\/photo$/);
  if (photo) {
    const found = store.getPhoto(photo[1]);
    if (!found) return sendJson(res, 404, { error: 'Фото нет' });
    res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(Buffer.from(found.data));
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!can(user, 'notify') && !can(user, 'orders')) return sendJson(res, 403, { error: 'Нет доступа' });
    return notifier.subscribe(req, res, user);
  }
  const route = match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Не найдено' });
  // Пока сотрудников нет, программа открыта и всё можно (работа на своём компьютере).
  if (route.access !== 'any' && !can(user, route.access)) return sendJson(res, 403, { error: 'У вашей роли нет доступа к этому' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    sendJson(res, 200, await route.handler(route.params, url, body, user && store.publicUser(user)));
  } catch (err) {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Внутренняя ошибка, подробности в окне программы' });
  }
});

if (process.argv.includes('--demo')) {
  if (!store.isEmpty()) {
    console.log(`В базе ${DB_FILE} уже есть товары, пример не загружен.`);
  } else {
    seedDemo(store);
    console.log('Пример магазина загружен.');
  }
} else {
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Порт ${PORT} уже занят: скорее всего, программа уже запущена в другом окне. Откройте http://localhost:${PORT} в браузере.`);
    console.error(`Чтобы перезапустить, остановите её командой: pkill -f server.js. Или запустите на другом порту: PORT=3001 npm start`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Программа открыта: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`База данных: ${DB_FILE}`);
    console.log(auth.enabled ? 'Вход по email и паролю включён.' : 'Вход без пароля (администратор задаётся в ADMIN_EMAIL и ADMIN_PASSWORD).');
  });
}
