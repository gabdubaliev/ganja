'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
// Дни, смены и выплатные периоды считаются по времени Бишкека, даже если сервер живёт в UTC.
process.env.TZ ||= 'Asia/Bishkek';
const { createStore, UserError, phone: normalizePhone } = require('./db');
const { seedDemo } = require('./demo');
const crypto = require('node:crypto');
const { createAuth, hashPassword, checkPassword } = require('./auth');
const { RIGHTS, ROLES, rightsOf, can } = require('./roles');
const { themeCss, shopCss } = require('./theme');
const { createNotifier } = require('./notify');
const { createCrm } = require('./crm');
const { createShopAuth } = require('./shop-auth');

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
const crm = createCrm(store);
// Код подтверждения, который сотрудник передаёт покупателю сам: уведомление в программу и в Telegram.
const shopAuth = createShopAuth(store, {
  onCodeRequested(c) {
    const what = c.purpose === 'reset' ? 'восстановление пароля' : 'регистрация';
    notifier.broadcast('code', { phone: c.phone, name: c.name, purpose: c.purpose }, 'customers.accounts');
    const tg = notifier.telegramSettings();
    if (tg.enabled) {
      notifier.sendTelegram(`🔑 Код для покупателя ${c.name ? c.name + ', ' : ''}+${c.phone} (${what}): ${c.code}\nПозвоните или напишите покупателю и назовите код. Действует 15 минут.`, tg)
        .catch((err) => console.error('Код в Telegram не отправлен:', err.message));
    }
  },
});
const auth = createAuth(store, process.env.SESSION_SECRET || store.setting('session_secret', crypto.randomBytes(32).toString('base64url')));

// Сотрудник с правом «Сотрудники», но не администратор, не может назначать
// администраторов и менять их: иначе он выдал бы себе все права.
// Настройки WhatsApp для экрана: секреты не отдаём, только признак, что они заданы.
const whatsappPublic = (s) => ({ enabled: s.enabled, verifyToken: s.verifyToken, phoneNumberId: s.phoneNumberId, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken),
  otpEnabled: Boolean(s.otpEnabled), otpTemplate: s.otpTemplate || '', otpLang: s.otpLang || 'ru', webhookPath: '/webhooks/whatsapp' });

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
  ['POST', '/api/sales/delete', (p, url, body, user) => store.deleteSales(body, user), 'sales.delete'],
  ['GET', '/api/arrivals', () => store.listArrivals(), 'arrivals'],
  ['POST', '/api/arrivals', (p, url, body) => store.createArrival(body), 'arrivals'],
  ['GET', '/api/analytics', (p, url) => store.analytics(range(url)), 'dashboard'],
  ['GET', '/api/kpi', (p, url) => store.kpi(range(url)), 'kpi'],
  ['GET', '/api/reports/products', (p, url) => store.reportProducts(range(url)), 'kpi'],

  // Своя смена — у любого, кто работает на кассе; чужие смены — у права «Смены».
  ['GET', '/api/shift', (p, url, body, user) => {
    const sh = user && store.currentShift(user.id);
    return sh ? store.getShift(sh.id) : null;
  }, 'pos'],
  ['POST', '/api/shift/open', (p, url, body, user) => store.openShift(user), 'pos'],
  ['POST', '/api/shift/close', (p, url, body, user) => store.closeShift(user), 'pos'],
  ['GET', '/api/shifts', (p, url) => store.listShifts(range(url)), ['shifts', 'kpi']],
  ['POST', '/api/shifts', (p, url, body, user) => store.saveShift(null, body, user), 'shifts'],
  ['PUT', '/api/shifts/:id', (p, url, body, user) => store.saveShift(p.id, body, user), 'shifts'],
  ['DELETE', '/api/shifts/:id', (p) => store.deleteShift(p.id), 'shifts'],
  ['GET', '/api/fines', (p, url) => store.listFines(range(url)), ['fines', 'kpi']],
  ['POST', '/api/fines', (p, url, body, user) => store.addFine(body, user), 'fines'],
  ['DELETE', '/api/fines/:id', (p) => store.deleteFine(p.id), 'fines'],
  // Короткий список сотрудников для выбора в сменах и штрафах.
  ['GET', '/api/staff-list', () => store.listUsers().map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, disabled: u.disabled })), ['shifts', 'fines', 'kpi', 'staff', 'crm']],
  // CRM. mine=1 — только мои сделки и задачи.
  ['GET', '/api/crm/leads', (p, url, body, user) => crm.list({ q: url.searchParams.get('q') || '', source: url.searchParams.get('source') || '',
    userId: url.searchParams.get('mine') === '1' && user ? user.id : null }), 'crm'],
  ['GET', '/api/crm/summary', () => crm.summary(), 'crm'],
  ['GET', '/api/crm/tasks', (p, url, body, user) => crm.tasks({ userId: url.searchParams.get('mine') === '1' && user ? user.id : null }), 'crm'],
  ['POST', '/api/crm/leads', (p, url, body, user) => crm.create(body, user), 'crm'],
  ['GET', '/api/crm/leads/:id', (p) => crm.get(p.id), 'crm'],
  ['PUT', '/api/crm/leads/:id', (p, url, body, user) => crm.update(p.id, body, user), 'crm'],
  ['DELETE', '/api/crm/leads/:id', (p) => crm.remove(p.id), 'crm'],
  ['POST', '/api/crm/leads/:id/events', (p, url, body, user) => crm.addEvent(p.id, body, user), 'crm'],
  ['POST', '/api/crm/leads/:id/read', (p) => crm.markRead(p.id), 'crm'],
  ['POST', '/api/crm/leads/:id/tasks', (p, url, body, user) => crm.addTask(p.id, body, user), 'crm'],
  ['POST', '/api/crm/tasks/:id/toggle', (p, url, body, user) => crm.toggleTask(p.id, user), 'crm'],
  ['POST', '/api/crm/leads/:id/customer', (p, url, body, user) => crm.toCustomer(p.id, user), 'crm'],
  ['POST', '/api/crm/leads/:id/instagram', (p, url, body, user) => crm.replyInstagram(p.id, body.text, user), 'crm'],
  ['POST', '/api/crm/leads/:id/whatsapp', (p, url, body, user) => crm.replyWhatsapp(p.id, body.text, user), 'crm'],
  ['GET', '/api/settings/whatsapp', () => whatsappPublic(crm.whatsappSettings()), 'settings'],
  ['PUT', '/api/settings/whatsapp', (p, url, body) => whatsappPublic(crm.setWhatsapp(body)), 'settings'],
  // Секреты Instagram наружу не отдаём: только признак, что они заданы.
  ['GET', '/api/settings/instagram', (p, url) => {
    const s = crm.instagramSettings();
    return { enabled: s.enabled, verifyToken: s.verifyToken, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken), webhookPath: '/webhooks/instagram' };
  }, 'settings'],
  ['PUT', '/api/settings/instagram', (p, url, body) => {
    const s = crm.setInstagram(body);
    return { enabled: s.enabled, verifyToken: s.verifyToken, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken), webhookPath: '/webhooks/instagram' };
  }, 'settings'],
  ['GET', '/api/audit', (p, url) => store.listAudit({ ...range(url), kind: url.searchParams.get('kind') || '', q: url.searchParams.get('q') || '' }), 'audit'],
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
  ['GET', '/api/customers/codes', () => shopAuth.pendingCodes(), 'customers.accounts'],
  ['POST', '/api/customers/codes/:id/sent', (p, url, body, user) => shopAuth.markCodeSent(p.id, user), 'customers.accounts'],
  ['POST', '/api/customers/:id/password', (p) => shopAuth.adminResetPassword(p.id), 'customers.accounts'],
  ['PUT', '/api/customers/:id/login', (p, url, body) => shopAuth.setLoginDisabled(p.id, body.disabled), 'customers.accounts'],
  ['GET', '/api/customers/:id/orders', (p) => shopAuth.myOrders(store.findCustomer(p.id) || (() => { throw new UserError('Покупатель не найден'); })()), 'customers'],
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
    if (found) return { handler, access, pattern, params: Object.fromEntries(names.map((n, i) => [n, found[i + 1]])) };
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

// Устройство из заголовка браузера: «Android · Chrome», «Windows · Edge».
function device(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 60) || 'неизвестно';
}

// Что записать в журнал о каждом изменении. Ключ — «метод путь» маршрута.
const AUDIT_LABELS = {
  'PUT /api/me/password': 'Сменил свой пароль',
  'POST /api/products': 'Добавил товар',
  'PUT /api/products/:id': 'Изменил товар',
  'DELETE /api/products/:id': 'Удалил товар',
  'POST /api/products/import': 'Загрузил товары из Excel',
  'PUT /api/products/:id/stock': 'Пересчитал остаток',
  'PUT /api/products/:id/photo': 'Поменял фото товара',
  'DELETE /api/products/:id/photo': 'Удалил фото товара',
  'POST /api/products/bulk': 'Групповое изменение товаров',
  'POST /api/products/:id/variants': 'Добавил модификации',
  'POST /api/sales': 'Пробил чек',
  'POST /api/sales/:id/refund': 'Оформил возврат',
  'POST /api/sales/delete': 'Удалил продажи',
  'POST /api/arrivals': 'Провёл приход',
  'POST /api/demo': 'Загрузил пример магазина',
  'POST /api/shift/open': 'Открыл смену',
  'POST /api/shift/close': 'Закрыл смену',
  'POST /api/shifts': 'Добавил смену вручную',
  'PUT /api/shifts/:id': 'Исправил смену',
  'DELETE /api/shifts/:id': 'Удалил смену',
  'POST /api/fines': 'Выписал штраф',
  'DELETE /api/fines/:id': 'Отменил штраф',
  'POST /api/customers': 'Добавил покупателя',
  'PUT /api/customers/:id': 'Изменил покупателя',
  'POST /api/customers/:id/bonus': 'Изменил бонусы покупателя',
  'PUT /api/loyalty': 'Изменил правила бонусов и скидок',
  'POST /api/users': 'Добавил сотрудника',
  'PUT /api/users/:id': 'Изменил сотрудника',
  'DELETE /api/users/:id': 'Удалил сотрудника',
  'PUT /api/design': 'Изменил оформление',
  'POST /api/images': 'Загрузил картинку для витрины',
  'PUT /api/shop': 'Изменил витрину',
  'PUT /api/orders/:id': 'Изменил статус заказа',
  'PUT /api/settings/telegram': 'Изменил уведомления в Telegram',
  'PUT /api/settings/instagram': 'Изменил подключение Instagram',
  'POST /api/crm/leads': 'Создал сделку в CRM',
  'PUT /api/crm/leads/:id': 'Изменил сделку в CRM',
  'DELETE /api/crm/leads/:id': 'Удалил сделку в CRM',
  'POST /api/crm/leads/:id/instagram': 'Ответил клиенту в Instagram',
  'POST /api/crm/leads/:id/whatsapp': 'Ответил клиенту в WhatsApp',
  'PUT /api/settings/whatsapp': 'Изменил подключение WhatsApp',
  'POST /api/customers/codes/:id/sent': 'Передал покупателю код подтверждения',
  'POST /api/customers/:id/password': 'Выдал покупателю временный пароль',
  'PUT /api/customers/:id/login': 'Изменил доступ покупателя к витрине',
  'POST /api/settings/telegram/test': 'Отправил пробное уведомление',
};
const ORDER_NAMES = { confirmed: 'подтверждён', ready: 'собран', shipped: 'передан курьеру', done: 'выдан', cancelled: 'отменён' };

// Подробности для журнала: о чём именно речь. Пароли и токены сюда не попадают.
function auditDetails(key, params, body, result) {
  const r = result && typeof result === 'object' ? result : {};
  switch (key) {
    case 'POST /api/sales': return `Чек №${r.id} на ${r.total} сом${r.discount ? `, скидка ${r.discount} сом (${r.discountReason})` : ''}`;
    case 'POST /api/sales/:id/refund': return `Чек №${params.id}`;
    case 'POST /api/customers/:id/password': return `+${r.phone}`;
    case 'PUT /api/customers/:id/login': return `${r.name || '+' + r.phone}: вход ${r.login_disabled ? 'закрыт' : 'открыт'}`;
    case 'POST /api/sales/delete': {
      const scope = Array.isArray(body.ids) ? `чеки ${body.ids.slice(0, 20).map((id) => '№' + id).join(', ')}${body.ids.length > 20 ? '…' : ''}`
        : body.all ? 'все продажи за всё время' : `все за ${new Date(Number(body.from)).toLocaleDateString('ru-RU')} — ${new Date(Number(body.to) - 1).toLocaleDateString('ru-RU')}`;
      const n = r.count % 100, k = n % 10;
      const word = n > 10 && n < 20 ? 'чеков' : k === 1 ? 'чек' : k > 1 && k < 5 ? 'чека' : 'чеков';
      return `${r.count} ${word} на ${r.total} сом (${scope}), товар ${body.restock === false ? 'на склад не возвращён' : 'возвращён на склад'}`;
    }
    case 'POST /api/products/bulk': return `${{ delete: 'удаление', archive: 'убрать из продажи', restore: 'вернуть в продажу', price: 'цена', cost: 'себестоимость', category: 'категория', unit: 'единица', barcodes: 'штрихкоды' }[body.action] || body.action}${body.value !== undefined ? ` (${body.mode ? body.mode + ' ' : ''}${body.value})` : ''}, товаров: ${r.count ?? body.ids?.length}`;
    case 'POST /api/products/import': return `создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped?.length ?? 0}`;
    case 'PUT /api/products/:id/stock': return `${r.name}: остаток ${r.stock}`;
    case 'PUT /api/products/:id': return `${r.name}: цена ${r.price}, себестоимость ${r.cost}`;
    case 'POST /api/products/:id/variants': return `${Array.isArray(r) ? r.length : 0} шт.`;
    case 'POST /api/arrivals': return `Приход №${r.id} на ${r.total} сом${body.supplier ? `, ${body.supplier}` : ''}`;
    case 'POST /api/fines': return `${store.findUser(body.user_id)?.name || ''}: ${r.amount} сом — ${r.reason}`;
    case 'DELETE /api/fines/:id': return `${r.amount} сом — ${r.reason}`;
    case 'POST /api/customers/:id/bonus': return `${r.name || '+' + r.phone}: ${body.delta > 0 ? '+' : ''}${body.delta}${body.reason ? ` (${body.reason})` : ''}`;
    case 'PUT /api/orders/:id': return `Заказ №${params.id} ${ORDER_NAMES[body.status] || body.status}`;
    case 'PUT /api/users/:id': return `${r.name || r.email}${body.password ? ', новый пароль' : ''}${body.rights !== undefined ? ', права' : ''}`;
    case 'POST /api/shift/close': return `чеков ${r.receipts} на ${r.revenue} сом`;
    case 'PUT /api/shifts/:id':
    case 'POST /api/shifts': return `${r.user_name}: ${new Date(r.opened_at).toLocaleString('ru-RU')}${r.closed_at ? ' — ' + new Date(r.closed_at).toLocaleString('ru-RU') : ''}`;
    default: return r.name || r.email || r.title || (params.id ? `№${params.id}` : '');
  }
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const result = auth.login(req, body.email || '', body.password || '');
    const who = { ip: clientIp(req), device: device(req) };
    if (!result.ok) {
      store.audit({ ...who, kind: 'login_failed', userName: String(body.email || '').slice(0, 120), action: 'Неудачная попытка входа', details: result.error });
      return sendJson(res, result.status, { error: result.error });
    }
    store.audit({ ...who, kind: 'login', user: result.user, action: 'Вход в программу' });
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, { ok: true, user: store.publicUser(result.user) });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const user = auth.currentUser(req);
    if (user) store.audit({ kind: 'logout', user, ip: clientIp(req), device: device(req), action: 'Выход из программы' });
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

// Вебхуки Meta: Instagram Direct и WhatsApp. GET — проверка адреса при подключении: вернуть
// hub.challenge, если токен совпал. POST — новые сообщения; подпись X-Hub-Signature-256 проверяется по App Secret.
const META_CHANNELS = {
  instagram: { name: 'Instagram', settings: () => crm.instagramSettings(), receive: (p) => crm.receiveInstagram(p), profile: (id) => crm.fillInstagramProfile(id) },
  whatsapp: { name: 'WhatsApp', settings: () => crm.whatsappSettings(), receive: (p) => crm.receiveWhatsapp(p), profile: async () => {} },
};

async function metaWebhook(req, res, url, channel) {
  const ch = META_CHANNELS[channel];
  const settings = ch.settings();
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === settings.verifyToken;
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(ok ? url.searchParams.get('hub.challenge') || '' : 'Неверный токен проверки');
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Только GET и POST' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) return sendJson(res, 413, { error: 'Слишком большой запрос' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!settings.enabled || !crm.verifySignature(raw, req.headers['x-hub-signature-256'], settings.appSecret)) {
    store.audit({ kind: 'denied', userName: ch.name, ip: clientIp(req), device: device(req), action: `Вебхук ${ch.name} отклонён`, details: settings.enabled ? 'неверная подпись' : `${ch.name} выключен в настройках` });
    return sendJson(res, 403, { error: 'Подпись не совпала' });
  }
  // Meta ждёт ответ быстро: отвечаем сразу, сообщения разбираем после.
  sendJson(res, 200, { ok: true });
  try {
    for (const { lead, isNew } of ch.receive(JSON.parse(raw.toString('utf8')))) {
      if (isNew) await ch.profile(lead.id);
      const fresh = crm.get(lead.id);
      notifier.broadcast('lead', { id: fresh.id, name: fresh.name, source: ch.name, text: fresh.events.at(-1)?.text || '' }, 'crm');
    }
  } catch (err) {
    console.error(`${ch.name}: не получилось разобрать сообщение:`, err.message);
  }
}

// Личный кабинет покупателя на витрине: регистрация, вход, «Забыл пароль», мои заказы.
async function shopAccount(req, res, url) {
  const action = url.pathname.slice('/shop/account/'.length);
  const ip = clientIp(req);
  const who = (c, phoneText) => ({ ip, device: device(req), userName: `Покупатель: ${c?.name ? c.name + ', ' : ''}+${c?.phone || phoneText || ''}` });
  const done = (result) => {
    if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
    const { cookie, ...rest } = result;
    return sendJson(res, 200, rest);
  };
  try {
    if (req.method === 'GET' && action === 'me') {
      const c = shopAuth.current(req);
      if (!c) return sendJson(res, 200, { customer: null });
      const full = store.findCustomer(c.id);
      return sendJson(res, 200, { customer: { ...shopAuth.publicCustomer(c), birthdayDiscount: full.birthdayDiscount }, orders: shopAuth.myOrders(c), loyalty: store.loyalty() });
    }
    if (req.method !== 'POST' && req.method !== 'PUT') return sendJson(res, 405, { error: 'Неверный запрос' });
    const body = await readBody(req);
    switch (action) {
      case 'register': {
        const r = await shopAuth.register(body, req);
        if (r.customer) store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель зарегистрировался на витрине' });
        return done(r);
      }
      case 'register/confirm': {
        const r = shopAuth.confirmRegistration(body, req);
        store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель зарегистрировался на витрине', details: 'номер подтверждён кодом' });
        return done(r);
      }
      case 'login':
        try {
          const r = shopAuth.login(body, req, ip);
          store.audit({ ...who(r.customer), kind: 'login', action: 'Покупатель вошёл на витрину' });
          return done(r);
        } catch (err) {
          let typed = String(body.phone || '').replace(/\D/g, '');
          try { typed = normalizePhone(body.phone); } catch { /* в журнал — как ввели */ }
          store.audit({ ...who(null, typed), kind: 'login_failed', action: 'Неудачный вход покупателя на витрину', details: err.message });
          throw err;
        }
      case 'logout':
        res.setHeader('Set-Cookie', shopAuth.logoutCookie(req));
        return sendJson(res, 200, { ok: true });
      case 'reset/request':
        return done(await shopAuth.requestReset(body));
      case 'reset': {
        const r = shopAuth.resetPassword(body, req);
        store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель сменил пароль по коду' });
        return done(r);
      }
      case 'me': {
        const c = shopAuth.current(req);
        if (!c) return sendJson(res, 401, { error: 'Войдите снова' });
        const fresh = shopAuth.updateProfile(c, body);
        // Если сменили пароль, старая сессия кончилась — выдаём новую.
        if (body.newPassword) res.setHeader('Set-Cookie', shopAuth.login({ phone: fresh.phone, password: body.newPassword }, req, ip).cookie);
        return sendJson(res, 200, { customer: shopAuth.publicCustomer(fresh) });
      }
      default:
        return sendJson(res, 404, { error: 'Не найдено' });
    }
  } catch (err) {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Что-то пошло не так. Попробуйте ещё раз.' });
  }
}

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
  const hook = pathname.match(/^\/webhooks\/(instagram|whatsapp)$/);
  if (hook) return metaWebhook(req, res, url, hook[1]);
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
  if (pathname.startsWith('/shop/account/')) return shopAccount(req, res, url);
  if (req.method === 'POST' && pathname === '/shop/order') {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (orderLog.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= ORDER_LIMIT) return sendJson(res, 429, { error: 'Слишком много заказов подряд. Попробуйте через несколько минут или позвоните нам.' });
    try {
      const body = await readBody(req);
      // Скрытое поле: люди его не видят и не заполняют, а боты заполняют.
      if (body.website) return sendJson(res, 200, { ok: true, id: 0 });
      const customer = shopAuth.current(req);
      if (!customer) return sendJson(res, 401, { error: 'Чтобы оформить заказ, войдите или зарегистрируйтесь' });
      const order = store.createOrder(body, customer);
      recent.push(now);
      orderLog.set(ip, recent);
      notifier.order(order);
      try {
        const lead = crm.fromOrder(order);
        notifier.broadcast('lead', { id: lead.id, name: lead.name, source: lead.source, text: `Заказ №${order.id}` }, 'crm');
      } catch (err) {
        console.error('CRM: заказ не попал в сделки:', err.message);
      }
      store.audit({ kind: 'change', userName: `Покупатель: ${order.name}`, ip, device: device(req), action: 'Новый заказ с витрины', details: `Заказ №${order.id} на ${order.total} сом` });
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
    if (!['notify', 'orders', 'crm', 'customers.accounts'].some((r) => can(user, r))) return sendJson(res, 403, { error: 'Нет доступа' });
    return notifier.subscribe(req, res, user);
  }
  const route = match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Не найдено' });
  // Пока сотрудников нет, программа открыта и всё можно (работа на своём компьютере).
  // access — право или список прав, из которых хватит любого.
  const allowed = route.access === 'any' || [route.access].flat().some((r) => can(user, r));
  if (!allowed) {
    if (req.method !== 'GET') store.audit({ kind: 'denied', user, ip: clientIp(req), device: device(req), action: 'Попытка действия без права', details: `${req.method} ${url.pathname}` });
    return sendJson(res, 403, { error: 'У вашей роли нет доступа к этому' });
  }
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await route.handler(route.params, url, body, user && store.publicUser(user));
    const key = `${req.method} ${route.pattern}`;
    // Предварительный подсчёт (dryRun) ничего не меняет — в журнал не пишем.
    if (AUDIT_LABELS[key] && !body.dryRun) {
      try {
        store.audit({ kind: 'change', user, ip: clientIp(req), device: device(req), action: AUDIT_LABELS[key], details: auditDetails(key, route.params, body, result) });
      } catch (err) {
        console.error('Журнал действий:', err.message);
      }
    }
    sendJson(res, 200, result);
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
