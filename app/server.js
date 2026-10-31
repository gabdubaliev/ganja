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
const { AsyncLocalStorage } = require('node:async_hooks');
const { createAuth, hashPassword, checkPassword } = require('./auth');
const { RIGHTS, ROLES, rightsOf, can } = require('./roles');
const { themeCss, shopCss } = require('./theme');
const { createNotifier } = require('./notify');
const { createCrm } = require('./crm');
const { createShopAuth } = require('./shop-auth');
const { sendSms, PROVIDERS: SMS_PROVIDERS } = require('./sms');

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

/* ---------- Магазины (филиалы) ----------
   У каждого магазина своя база: товары, сотрудники, кассы, продажи, документы. Основной магазин — DB_FILE,
   филиалы — branch-N.db рядом с ней, список хранится в настройках основного. Каждый запрос выполняется
   в контексте своего магазина (AsyncLocalStorage), поэтому код маршрутов работает с «store» как раньше. */
const mainStore = createStore(DB_FILE);
const contexts = new Map(); // id магазина -> { id, store, notifier, crm, shopAuth }
const als = new AsyncLocalStorage();
const current = () => als.getStore() || contexts.get(1);
// store, notifier, crm, shopAuth ниже — это магазин текущего запроса.
const scoped = (key) => new Proxy({}, { get: (_, k) => { const t = current()[key]; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
const store = scoped('store');
const notifier = scoped('notifier');
const crm = scoped('crm');
const shopAuth = scoped('shopAuth');

function branchList() {
  const saved = JSON.parse(mainStore.setting('branches', '[]'));
  return [{ id: 1, name: mainStore.design().name || 'Основной магазин', address: '', main: true }, ...saved];
}

function makeContext(id, st) {
  const ctx = { id, store: st };
  ctx.notifier = createNotifier(st);
  ctx.crm = createCrm(st);
  // Код подтверждения, который сотрудник передаёт покупателю сам: уведомление в программу и в Telegram.
  ctx.shopAuth = createShopAuth(st, {
    onCodeRequested(c) {
      const what = c.purpose === 'reset' ? 'восстановление пароля' : 'регистрация';
      ctx.notifier.broadcast('code', { phone: c.phone, name: c.name, purpose: c.purpose }, 'customers.accounts');
      const tg = ctx.notifier.telegramSettings();
      if (tg.enabled) {
        ctx.notifier.sendTelegram(`🔑 Код для покупателя ${c.name ? c.name + ', ' : ''}+${c.phone} (${what}): ${c.code}\nПозвоните или напишите покупателю и назовите код. Действует 15 минут.`, tg)
          .catch((err) => console.error('Код в Telegram не отправлен:', err.message));
      }
    },
  });
  // Перемещение: товар уходит отсюда и приходит в другой магазин.
  st.setBranchLink({
    send(to, payload, user) {
      const target = contextOf(to);
      if (!target || to === id) throw new UserError('Выберите другой магазин');
      return target.store.receiveTransfer({ ...payload, fromBranch: id, fromName: branchList().find((b) => b.id === id)?.name || `Магазин №${id}` }, user);
    },
    cancel(to, docId) { contextOf(to)?.store.cancelTransfer(docId); },
  });
  contexts.set(id, ctx);
  return ctx;
}

function contextOf(id) {
  const n = Number(id) || 1;
  if (contexts.has(n)) return contexts.get(n);
  const b = branchList().find((x) => x.id === n);
  if (!b || b.main) return null;
  return makeContext(n, createStore(path.join(path.dirname(DB_FILE), b.file)));
}
makeContext(1, mainStore);
for (const b of branchList()) if (!b.main) contextOf(b.id);

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

// Сотрудники всех магазинов для входа: email ищется сначала в основном магазине, потом в филиалах.
// В cookie — «магазин-id» (у основного — просто id, как в прошлых версиях).
const staffDirectory = {
  countUsers: () => mainStore.countUsers(),
  keyOf: (u) => (u.branch && u.branch !== 1 ? `${u.branch}-${u.id}` : String(u.id)),
  findUser(key) {
    const [b, id] = String(key).includes('-') ? String(key).split('-') : [1, key];
    const ctx = contextOf(b);
    const u = ctx && ctx.store.findUser(id);
    return u ? { ...u, branch: ctx.id } : null;
  },
  findUserByEmail(email) {
    for (const b of branchList()) {
      const ctx = contextOf(b.id);
      const u = ctx?.store.findUserByEmail(email);
      if (u && !u.owner_shadow && !u.moved_to) return { ...u, branch: ctx.id };
    }
    return null;
  },
};
const auth = createAuth(staffDirectory, process.env.SESSION_SECRET || mainStore.setting('session_secret', crypto.randomBytes(32).toString('base64url')));
const isOwner = (u) => u && (u.branch || 1) === 1 && u.role === 'admin';
// В каких магазинах сотрудник может работать: владелец — во всех, остальные — в своём и отмеченных в карточке.
function allowedBranches(u) {
  const all = branchList().map((b) => b.id);
  if (!u) return [1];
  if (isOwner(u)) return all;
  const extra = u.stores ? JSON.parse(u.stores) : [];
  return [...new Set([u.branch || 1, ...extra])].filter((id) => all.includes(id));
}

// Магазин запроса: сотрудник филиала работает в своём, владелец — в выбранном (cookie shop_branch).
function branchCookie(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)shop_branch=(\d+)/);
  return m ? Number(m[1]) : null;
}
function resolveContext(req, user) {
  if (!user) return { ctx: contexts.get(1), user: null, owner: null };
  if (isOwner(user)) {
    const ctx = contextOf(branchCookie(req) || 1) || contexts.get(1);
    if (ctx.id === 1) return { ctx, user, owner: user };
    const shadow = ctx.store.ownerShadow(user);
    return { ctx, user: { ...shadow, branch: ctx.id }, owner: user };
  }
  // Сотрудник с доступом в другой магазин работает там под своей записью-копией (роль и права — из своего магазина).
  const want = branchCookie(req);
  if (want && want !== user.branch && allowedBranches(user).includes(want)) {
    const ctx = contextOf(want);
    try {
      return { ctx, user: { ...ctx.store.shadowOf(user), branch: ctx.id }, owner: null };
    } catch { /* в том магазине уже есть сотрудник с таким email — работает в своём */ }
  }
  return { ctx: contextOf(user.branch) || contexts.get(1), user, owner: null };
}

// Действие над сотрудником другого магазина (?branch=N) — только у владельца.
function inBranch(url, user, fn) {
  const b = Number(url.searchParams.get('branch')) || current().id;
  if (b === current().id) return fn();
  if (auth.enabled && !user?.owner) throw new UserError('Сотрудников других магазинов меняет владелец');
  const ctx = contextOf(b);
  if (!ctx) throw new UserError('Магазин не найден');
  return als.run(ctx, fn);
}

// Перевод в другой магазин и доступ к магазинам — только владелец.
function setEmployeeBranch(id, { home, stores }, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазин сотрудника меняет владелец');
  const from = current();
  const all = branchList().map((b) => b.id);
  const to = Number(home) || from.id;
  if (!all.includes(to)) throw new UserError('Магазин не найден');
  const extra = (stores || []).map(Number).filter((b) => all.includes(b) && b !== to);
  if (to === from.id) return store.setUserStores(id, extra);
  const src = from.store.findUser(id);
  if (!src) throw new UserError('Сотрудник не найден');
  for (const b of branchList()) {
    const other = b.id !== from.id && contextOf(b.id).store.findUserByEmail(src.email);
    if (other && b.id === to && !other.owner_shadow && !other.moved_to) throw new UserError(`В магазине «${b.name}» уже есть сотрудник с этим email`);
  }
  from.store.moveOut(id, to);
  return contextOf(to).store.moveIn({ ...src, stores: extra.length ? JSON.stringify(extra) : null });
}

// Сотрудник с правом «Сотрудники», но не администратор, не может назначать
// администраторов и менять их: иначе он выдал бы себе все права.
// Настройки SMS. Пароли и ключи на экран не отдаём — только признак, что они заданы.
const smsSettings = () => ({ enabled: false, provider: '', login: '', password: '', apiKey: '', sender: '', url: '', method: 'POST', body: '', successText: '', template: '', test: false,
  ...JSON.parse(store.setting('sms', '{}')) });
const smsPublic = (s) => ({ enabled: s.enabled, provider: s.provider, login: s.login, sender: s.sender, url: s.url, method: s.method, body: s.body,
  successText: s.successText, template: s.template, test: s.test, hasPassword: Boolean(s.password), hasApiKey: Boolean(s.apiKey), providers: SMS_PROVIDERS });

function setSms(input) {
  const cur = smsSettings();
  const str = (v, field, max = 200) => String(v ?? '').trim().slice(0, max);
  const next = {
    enabled: Boolean(input.enabled),
    provider: Object.hasOwn(SMS_PROVIDERS, input.provider) ? input.provider : '',
    login: str(input.login),
    password: input.password ? str(input.password) : cur.password,
    apiKey: input.apiKey ? str(input.apiKey) : cur.apiKey,
    sender: str(input.sender, 'Отправитель', 40),
    url: str(input.url, 'Адрес', 500),
    method: input.method === 'GET' ? 'GET' : 'POST',
    body: str(input.body, 'Тело запроса', 2000),
    successText: str(input.successText),
    template: str(input.template, 'Текст', 160),
    test: Boolean(input.test),
  };
  if (next.template && !next.template.includes('{code}')) throw new UserError('В тексте SMS должно быть {code} — туда подставится код');
  if (next.url && !/^https?:\/\//.test(next.url)) throw new UserError('Адрес провайдера должен начинаться с https://');
  if (next.enabled) {
    const need = { nikita: ['login', 'password', 'sender'], smsru: ['apiKey'], twilio: ['login', 'password', 'sender'], custom: ['url'] }[next.provider];
    if (!need) throw new UserError('Выберите провайдера SMS');
    if (need.some((k) => !next[k])) throw new UserError('Заполните данные провайдера: ' + need.map((k) => ({ login: 'логин', password: 'пароль', sender: 'отправитель', apiKey: 'API-ключ', url: 'адрес' }[k])).join(', '));
  }
  store.setSetting('sms', JSON.stringify(next));
  return next;
}

// Настройки WhatsApp для экрана: секреты не отдаём, только признак, что они заданы.
const whatsappPublic = (s) => ({ enabled: s.enabled, verifyToken: s.verifyToken, phoneNumberId: s.phoneNumberId, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken),
  otpEnabled: Boolean(s.otpEnabled), otpTemplate: s.otpTemplate || '', otpLang: s.otpLang || 'ru', webhookPath: '/webhooks/whatsapp' });

const hideStock = (user, list) => (can(user, 'stock.view') ? list : list.map((p) => ({ ...p, stock: null })));

// Право на вид документа: продажа, закупка, списание… — у каждого своё (см. DOC_KINDS в db.js).
// Остаток товара во всех магазинах, где может работать сотрудник. Товар в другом магазине
// ищется так же, как при перемещении: по штрихкоду, коду с названием или названию.
function productStores(id, user) {
  const here = current();
  const p = here.store.getProductInfo(id);
  // user — уже публичная запись: stores разобран в массив, owner — владелец ли.
  const allowed = new Set([user?.branch || 1, ...(Array.isArray(user?.stores) ? user.stores : [])]);
  return branchList().filter((b) => b.id === here.id || !auth.enabled || !user || user.owner || allowed.has(b.id)).map((b) => {
    const ctx = contextOf(b.id);
    const found = b.id === here.id
      ? (p.children.length ? { stock: p.children.reduce((s, k) => s + k.stock, 0), price: Math.min(...p.children.map((k) => k.price)), archived: Boolean(p.archived), variants: p.children.length } : { stock: p.stock, price: p.price, archived: Boolean(p.archived) })
      : ctx?.store.stockOfSame(p, p.children) ?? null;
    return { id: b.id, name: b.name, current: b.id === here.id, found: Boolean(found), ...(found || {}) };
  });
}

function docRight(user, kind) {
  const k = store.docKinds[kind];
  if (!k) throw new UserError('Неизвестный вид документа');
  if (!can(user, k.right)) throw new UserError(`У вас нет права на документы «${k.many}»`);
  return true;
}

// Новый магазин: своя база рядом с основной. По желанию — копия каталога товаров (без остатков) и категорий.
function createBranch(input, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазины заводит владелец — администратор основного магазина');
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new UserError('Название магазина');
  const list = branchList();
  if (list.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new UserError('Магазин с таким названием уже есть');
  const id = Math.max(...list.map((b) => b.id)) + 1;
  const b = { id, name, address: String(input.address ?? '').trim().slice(0, 200), phone: String(input.phone ?? '').trim().slice(0, 40), file: `branch-${id}.db`, created_at: Date.now() };
  mainStore.setSetting('branches', JSON.stringify([...list.filter((x) => !x.main), b]));
  const ctx = contextOf(id);
  ctx.store.setDesign?.({ ...mainStore.design(), name });
  if (input.copyProducts) {
    const db = ctx.store.db;
    db.exec(`ATTACH DATABASE '${path.join(path.dirname(DB_FILE), path.basename(DB_FILE)).replace(/'/g, "''")}' AS src`);
    try {
      // Товары копируются по названиям колонок; поставщики у каждого магазина свои — связь не переносится.
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
        .filter((c) => db.prepare('PRAGMA src.table_info(products)').all().some((x) => x.name === c)).join(', ');
      db.exec(`INSERT INTO categories SELECT * FROM src.categories;
        INSERT INTO images SELECT * FROM src.images WHERE id IN (SELECT image_id FROM src.categories WHERE image_id IS NOT NULL);
        INSERT INTO products (${cols}) SELECT ${cols} FROM src.products WHERE deleted = 0;
        INSERT INTO product_photos SELECT * FROM src.product_photos WHERE product_id IN (SELECT id FROM src.products WHERE deleted = 0);
        UPDATE products SET stock = 0, supplier_id = NULL;`);
    } finally {
      db.exec('DETACH DATABASE src');
    }
  }
  return { ...b, products: ctx.store.listProducts({}).length };
}

function updateBranch(id, input, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазины меняет владелец');
  const n = Number(id);
  if (n === 1) {
    mainStore.setDesign?.({ ...mainStore.design(), name: String(input.name ?? '').trim().slice(0, 80) || mainStore.design().name });
    return branchList()[0];
  }
  const list = branchList().filter((b) => !b.main);
  const b = list.find((x) => x.id === n);
  if (!b) throw new UserError('Магазин не найден');
  Object.assign(b, { name: String(input.name ?? b.name).trim().slice(0, 80) || b.name, address: String(input.address ?? b.address).trim().slice(0, 200), phone: String(input.phone ?? b.phone ?? '').trim().slice(0, 40) });
  mainStore.setSetting('branches', JSON.stringify(list));
  return b;
}

function guardAdmin(user, target, body) {
  if (!user || user.role === 'admin') return;
  if (target?.role === 'admin' || body.role === 'admin') throw new UserError('Администраторов назначает и меняет только администратор');
  if (target && target.id === user.id && body.rights !== undefined) throw new UserError('Свои права может поменять только администратор');
}

// PIN для смены кассира: 4–6 цифр; пустой — убрать PIN.
function pinHash(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!/^\d{4,6}$/.test(s)) throw new UserError('PIN-код — от 4 до 6 цифр');
  if (/^(\d)\1+$/.test(s) || '0123456789'.includes(s) || '9876543210'.includes(s)) throw new UserError('Слишком простой PIN-код, придумайте другой');
  return hashPassword(s);
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
    branch: (() => {
      const b = branchList().find((x) => x.id === current().id);
      const home = user ? staffDirectory.findUserByEmail(user.email) : null;
      const allowed = home ? allowedBranches(home) : [1];
      return { id: b.id, name: b.name, count: branchList().length, allowed: branchList().filter((x) => allowed.includes(x.id)).map((x) => ({ id: x.id, name: x.name })) };
    })(),
    can: rightsOf(user),
    roles: ROLES,
    rights: RIGHTS,
    loyalty: store.loyalty(),
    design: store.design(),
    shop: { enabled: store.shop().enabled },
    newOrders: can(user, 'orders') ? store.countNewOrders() : 0,
  }), 'any'],
  ['GET', '/api/kassa/users', () => store.kassaUsers(), 'pos'],
  ['GET', '/api/branches', (p, url, body, user) => ({
    branches: branchList().map((b) => ({ id: b.id, name: b.name, address: b.address || '', phone: b.phone || '', main: Boolean(b.main), current: b.id === current().id })),
    canManage: Boolean(user?.owner) || !auth.enabled,
  }), 'any'],
  ['POST', '/api/branches', (p, url, body, user) => createBranch(body, user), 'any'],
  ['PUT', '/api/branches/:id', (p, url, body, user) => updateBranch(p.id, body, user), 'any'],
  ['PUT', '/api/me/pin', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.setUserPin(user.id, pinHash(body.pin));
    return { ok: true };
  }, 'any'],
  ['PUT', '/api/me/password', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.updateUser(user.id, {}, password(body.password));
    return { ok: true };
  }, 'any'],

  // Без права «Видеть остатки» остаток не уходит в браузер вовсе.
  ['GET', '/api/products', (p, url, body, user) => hideStock(user, store.listProducts({ archived: url.searchParams.get('archived') === '1' })), 'any'],
  ['POST', '/api/products', (p, url, body) => store.createProduct(body), 'products'],
  ['PUT', '/api/products/:id', (p, url, body) => store.updateProduct(p.id, body), 'products'],
  ['POST', '/api/products/import', (p, url, body) => store.importProducts(body.rows, { update: Boolean(body.update) }), 'import'],
  ['PUT', '/api/products/:id/stock', (p, url, body, user) => store.setStock(p.id, body.stock, user), 'stock'],
  // Групповое изменение: удаление требует отдельного права.
  ['POST', '/api/products/bulk', (p, url, body, user) => {
    if (body.action === 'delete' && !can(user, 'products.delete')) throw new UserError('У вас нет права удалять товары');
    return store.bulkProducts(body);
  }, 'products'],
  ['DELETE', '/api/products/:id', (p) => store.bulkProducts({ ids: [Number(p.id)], action: 'delete' }), 'products.delete'],
  // mine=1 — способы, доступные вошедшему сотруднику (для кассы); all=1 — весь справочник с выключенными.
  ['GET', '/api/payment-methods', (p, url, body, user) => (url.searchParams.get('mine') === '1'
    ? store.allowedPaymentMethods(user && store.findUser(user.id))
    : { methods: store.listPaymentMethods({ all: url.searchParams.get('all') === '1' }), kinds: store.paymentKinds }), 'any'],
  ['POST', '/api/payment-methods', (p, url, body) => store.savePaymentMethod(null, body), 'settings'],
  ['PUT', '/api/payment-methods/:id', (p, url, body) => store.savePaymentMethod(p.id, body), 'settings'],
  ['PUT', '/api/payment-methods-order', (p, url, body) => store.sortPaymentMethods(body.ids), 'settings'],
  ['GET', '/api/reports/payments', (p, url) => store.reportPayments(range(url)), ['kpi', 'sales']],
  ['GET', '/api/categories', () => store.listCategories(), 'any'],
  ['POST', '/api/categories', (p, url, body) => store.createCategory(body), 'products'],
  ['PUT', '/api/categories/:id', (p, url, body) => store.renameCategory(p.id, body), 'products'],
  ['DELETE', '/api/categories/:id', (p, url) => store.deleteCategory(p.id, { moveTo: url.searchParams.get('moveTo') || '' }), 'products'],
  ['PUT', '/api/categories-order', (p, url, body) => store.sortCategories(body.ids), ['products', 'shop']],
  // Картинка категории для витрины: загрузить (mime + data) или убрать (пустое тело).
  ['PUT', '/api/categories/:id/image', (p, url, body) => store.setCategoryImage(p.id, body.data ? store.addImage(body).id : null), ['products', 'shop', 'photos']],
  ['POST', '/api/products/:id/variants', (p, url, body) => store.createVariants(p.id, body), 'products'],
  ['GET', '/api/barcode', () => ({ barcode: store.newBarcode() }), 'products'],
  ['GET', '/api/products/:id/info', (p, url, body, user) => {
    const info = store.getProductInfo(p.id);
    return can(user, 'stock.view') ? info : { ...info, stock: null, children: info.children.map((k) => ({ ...k, stock: null })) };
  }, ['products', 'dashboard', 'stock.view']],
  ['GET', '/api/products/:id/history', (p) => store.productHistory(p.id), ['products', 'dashboard', 'stock.view']],
  ['GET', '/api/products/:id/stores', (p, url, body, user) => productStores(p.id, user), 'stock.view'],
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
  // Документы: право на вид документа проверяется внутри — у каждого вида своё.
  ['GET', '/api/docs', (p, url, body, user) => {
    const kind = url.searchParams.get('kind') || '';
    if (kind) docRight(user, kind);
    const kinds = Object.keys(store.docKinds).filter((k) => can(user, store.docKinds[k].right));
    return store.listDocs({ ...range(url), kind, status: url.searchParams.get('status') || '' }).filter((d) => kinds.includes(d.kind));
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['GET', '/api/docs/:id', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.getDoc(p.id), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs', (p, url, body, user) => {
    docRight(user, body.kind);
    const doc = store.saveDoc(null, body, user);
    return body.post ? store.postDoc(doc.id, user) : doc;
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['PUT', '/api/docs/:id', (p, url, body, user) => {
    docRight(user, store.getDoc(p.id).kind);
    const doc = store.saveDoc(p.id, body, user);
    return body.post ? store.postDoc(doc.id, user) : doc;
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs/:id/post', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.postDoc(p.id, user), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs/:id/unpost', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.unpostDoc(p.id, user), 'docs.unpost'],
  ['DELETE', '/api/docs/:id', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.deleteDoc(p.id), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['GET', '/api/docs-writeoff-summary', (p, url) => store.writeoffSummary(range(url)), 'writeoff'],
  ['GET', '/api/suppliers', () => store.listSuppliers(), ['arrivals', 'transfer', 'stock', 'writeoff', 'products']],
  ['GET', '/api/finance', (p, url) => store.finance(range(url)), 'dashboard'],
  ['GET', '/api/expenses', (p, url) => ({ list: store.listExpenses(range(url)), categories: store.expenseCategories }), ['expenses', 'dashboard']],
  ['POST', '/api/expenses', (p, url, body, user) => store.addExpense(body, user), 'expenses'],
  ['DELETE', '/api/expenses/:id', (p) => store.deleteExpense(p.id), 'expenses'],
  ['GET', '/api/recurring-expenses', () => store.listRecurring(), ['expenses', 'dashboard']],
  ['POST', '/api/recurring-expenses', (p, url, body) => store.saveRecurring(null, body), 'expenses'],
  ['PUT', '/api/recurring-expenses/:id', (p, url, body) => store.saveRecurring(p.id, body), 'expenses'],
  ['DELETE', '/api/recurring-expenses/:id', (p) => store.deleteRecurring(p.id), 'expenses'],
  ['POST', '/api/suppliers', (p, url, body) => store.saveSupplier(null, body), 'arrivals'],
  ['PUT', '/api/suppliers/:id', (p, url, body) => store.saveSupplier(p.id, body), 'arrivals'],
  ['DELETE', '/api/suppliers/:id', (p) => store.deleteSupplier(p.id), 'arrivals'],
  ['GET', '/api/cash-desk', () => store.cashDesk(), ['dashboard', 'shifts']],
  ['GET', '/api/analytics', (p, url, body, user) => {
    const a = store.analytics(range(url));
    return { ...a, products: hideStock(user, a.products) };
  }, 'dashboard'],
  ['GET', '/api/kpi', (p, url) => store.kpi(range(url)), ['kpi', 'salary']],
  ['GET', '/api/reports/products', (p, url) => store.reportProducts(range(url)), 'kpi'],

  // Своя смена — у любого, кто работает на кассе; чужие смены — у права «Смены».
  ['GET', '/api/shift', (p, url, body, user) => {
    const sh = user && store.currentShift(user.id);
    return sh ? store.getShift(sh.id) : null;
  }, 'pos'],
  ['POST', '/api/shift/open', (p, url, body, user) => store.openShift(user, body.register_id), 'pos'],
  ['GET', '/api/registers', (p, url) => (url.searchParams.get('overview') === '1' ? store.registersOverview() : store.listRegisters()), 'any'],
  ['POST', '/api/registers', (p, url, body) => store.saveRegister(null, body), 'settings'],
  ['PUT', '/api/registers/:id', (p, url, body) => store.saveRegister(p.id, body), 'settings'],
  ['GET', '/api/accounts', (p, url) => ({ accounts: store.accounts(range(url)), ops: store.accountOps(range(url)) }), 'accounts'],
  ['POST', '/api/accounts/ops', (p, url, body, user) => store.addAccountOp(body, user), 'accounts'],
  ['DELETE', '/api/accounts/ops/:id', (p) => store.deleteAccountOp(p.id), 'accounts'],
  ['PUT', '/api/accounts/:id/opening', (p, url, body) => store.setOpeningBalance(p.id, body.opening), 'accounts'],
  ['POST', '/api/shift/close', (p, url, body, user) => store.closeShift(user), 'pos'],
  ['GET', '/api/shifts', (p, url) => store.listShifts(range(url)), ['shifts', 'kpi']],
  ['POST', '/api/shifts', (p, url, body, user) => store.saveShift(null, body, user), 'shifts'],
  ['PUT', '/api/shifts/:id', (p, url, body, user) => store.saveShift(p.id, body, user), 'shifts'],
  ['DELETE', '/api/shifts/:id', (p) => store.deleteShift(p.id), 'shifts'],
  ['GET', '/api/fines', (p, url) => store.listFines({ ...range(url), kind: url.searchParams.get('kind') || 'fine' }), ['fines', 'kpi', 'salary']],
  ['GET', '/api/bonuses', (p, url) => store.listFines({ ...range(url), kind: 'bonus' }), ['salary', 'kpi', 'fines']],
  ['POST', '/api/bonuses', (p, url, body, user) => store.addFine(body, user, 'bonus'), 'salary'],
  ['DELETE', '/api/bonuses/:id', (p) => store.deleteFine(p.id, 'bonus'), 'salary'],
  ['GET', '/api/timesheet', (p, url) => store.timesheet({ year: url.searchParams.get('year'), month: url.searchParams.get('month') }), 'timesheet'],
  ['GET', '/api/tasks', (p, url, body, user) => {
    // Без входа (сотрудников ещё нет) программа открыта как администратору.
    const all = url.searchParams.get('all') === '1' && can(user, 'tasks');
    return { tasks: store.listTasks({ user: user || { id: 0 }, all, status: url.searchParams.get('status') || 'active' }), counts: store.taskCounts(user || { id: 0 }, can(user, 'tasks')) };
  }, 'any'],
  ['POST', '/api/tasks', (p, url, body, user) => store.createTasks(body, user), 'tasks'],
  ['PUT', '/api/tasks/:id/done', (p, url, body, user) => store.markTask(p.id, body, user || { id: 0 }, can(user, 'tasks')), 'any'],
  ['PUT', '/api/tasks/:id/review', (p, url, body, user) => store.reviewTask(p.id, body, user), 'tasks'],
  ['DELETE', '/api/tasks/:id', (p) => store.deleteTask(p.id), 'tasks'],
  ['PUT', '/api/pay-override', (p, url, body, user) => store.setPayOverride(body, user), 'salary'],
  ['PUT', '/api/users/:id/pay', (p, url, body, user) => {
    guardAdmin(user, store.findUser(p.id), {});
    return store.setUserPay(p.id, body);
  }, 'salary'],
  ['POST', '/api/fines', (p, url, body, user) => store.addFine(body, user), 'fines'],
  ['DELETE', '/api/fines/:id', (p) => store.deleteFine(p.id), 'fines'],
  // Короткий список сотрудников для выбора в сменах и штрафах.
  ['GET', '/api/staff-list', () => store.listUsers().map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, disabled: u.disabled })), ['shifts', 'fines', 'kpi', 'staff', 'crm', 'salary', 'tasks', 'timesheet']],
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
  ['GET', '/api/settings/sms', () => smsPublic(smsSettings()), 'settings'],
  ['PUT', '/api/settings/sms', (p, url, body) => smsPublic(setSms(body)), 'settings'],
  ['POST', '/api/settings/sms/test', async (p, url, body) => {
    const s = smsSettings();
    if (!s.provider) throw new UserError('Сначала выберите провайдера и сохраните настройки');
    const to = normalizePhone(body.phone);
    try {
      await sendSms(s, to, (s.template || 'Код подтверждения: {code}. Никому не сообщайте его.').replace('{code}', '123456'));
    } catch (err) {
      throw new UserError(`Не отправлено: ${err.message}`);
    }
    return { ok: true, to };
  }, 'settings'],
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
  ['GET', '/api/customers/by-phone', (p, url) => store.findCustomerByPhone(url.searchParams.get('phone')), ['pos', 'docs.sale', 'refund']],
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

  // Сотрудники: владелец может смотреть все магазины сразу (all=1) или любой магазин (?branch=N).
  ['GET', '/api/users', (p, url, body, user) => {
    const names = Object.fromEntries(branchList().map((b) => [b.id, b.name]));
    const tag = (list, id) => list.map((u) => ({ ...u, branch: id, branchName: names[id] }));
    if (url.searchParams.get('all') === '1' && (user?.owner || !auth.enabled)) return branchList().flatMap((b) => tag(contextOf(b.id).store.listUsers(), b.id));
    return inBranch(url, user, () => tag(store.listUsers(), current().id));
  }, 'staff'],
  ['POST', '/api/users/:id/branch', (p, url, body, user) => inBranch(url, user, () => setEmployeeBranch(p.id, body, user)), 'staff'],
  ['POST', '/api/users', (p, url, body, user) => inBranch(url, user, () => {
    guardAdmin(user, null, body);
    // Email входа один на все магазины: по нему программа понимает, в какой магазин пустить.
    const email = String(body.email || '').trim().toLowerCase();
    for (const b of branchList()) {
      const other = b.id !== current().id && contextOf(b.id)?.store.findUserByEmail(email);
      if (other && !other.owner_shadow && !other.moved_to) throw new UserError(`Email ${email} уже занят сотрудником магазина «${b.name}»`);
    }
    const pin = body.pin ? pinHash(body.pin) : null;
    const made = store.createUser(body, password(body.password));
    return pin ? store.setUserPin(made.id, pin) : made;
  }), 'staff'],
  ['PUT', '/api/users/:id', (p, url, body, user) => inBranch(url, user, () => {
    guardAdmin(user, store.findUser(p.id), body);
    const pin = body.clearPin ? null : body.pin ? pinHash(body.pin) : undefined;
    const saved = store.updateUser(p.id, body, body.password ? password(body.password) : null);
    return pin === undefined ? saved : store.setUserPin(p.id, pin);
  }), 'staff'],
  ['DELETE', '/api/users/:id', (p, url, body, user) => inBranch(url, user, () => {
    if (user && Number(p.id) === user.id) throw new UserError('Нельзя удалить самого себя');
    guardAdmin(user, store.findUser(p.id), {});
    return store.deleteUser(p.id);
  }), 'staff'],

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
  'POST /api/users/:id/branch': 'Изменил магазин сотрудника',
  'PUT /api/me/password': 'Сменил свой пароль',
  'PUT /api/me/pin': 'Сменил свой PIN-код для кассы',
  'POST /api/products': 'Добавил товар',
  'PUT /api/products/:id': 'Изменил товар',
  'DELETE /api/products/:id': 'Удалил товар',
  'POST /api/products/import': 'Загрузил товары из Excel',
  'PUT /api/products/:id/stock': 'Пересчитал остаток',
  'PUT /api/products/:id/photo': 'Поменял фото товара',
  'DELETE /api/products/:id/photo': 'Удалил фото товара',
  'POST /api/products/bulk': 'Групповое изменение товаров',
  'POST /api/products/:id/variants': 'Добавил модификации',
  'POST /api/expenses': 'Внёс расход',
  'DELETE /api/expenses/:id': 'Удалил расход',
  'POST /api/recurring-expenses': 'Добавил постоянный расход',
  'PUT /api/recurring-expenses/:id': 'Изменил постоянный расход',
  'DELETE /api/recurring-expenses/:id': 'Удалил постоянный расход',
  'POST /api/categories': 'Создал категорию',
  'POST /api/payment-methods': 'Добавил способ оплаты',
  'PUT /api/payment-methods/:id': 'Изменил способ оплаты',
  'PUT /api/payment-methods-order': 'Изменил порядок способов оплаты',
  'PUT /api/categories/:id': 'Переименовал категорию',
  'DELETE /api/categories/:id': 'Удалил категорию',
  'PUT /api/categories/:id/image': 'Поменял картинку категории',
  'PUT /api/categories-order': 'Изменил порядок категорий',
  'POST /api/sales': 'Пробил чек',
  'POST /api/sales/:id/refund': 'Оформил возврат',
  'POST /api/sales/delete': 'Удалил продажи',
  'POST /api/docs': 'Создал документ',
  'PUT /api/docs/:id': 'Изменил документ',
  'POST /api/docs/:id/post': 'Провёл документ',
  'POST /api/docs/:id/unpost': 'Отменил проведение документа',
  'DELETE /api/docs/:id': 'Удалил документ',
  'POST /api/suppliers': 'Добавил поставщика',
  'POST /api/registers': 'Добавил кассу',
  'PUT /api/registers/:id': 'Изменил кассу',
  'POST /api/accounts/ops': 'Операция по счёту',
  'DELETE /api/accounts/ops/:id': 'Удалил операцию по счёту',
  'PUT /api/accounts/:id/opening': 'Изменил начальный остаток счёта',
  'PUT /api/suppliers/:id': 'Изменил поставщика',
  'DELETE /api/suppliers/:id': 'Удалил поставщика',
  'POST /api/demo': 'Загрузил пример магазина',
  'POST /api/shift/open': 'Открыл смену',
  'POST /api/shift/close': 'Закрыл смену',
  'POST /api/shifts': 'Добавил смену вручную',
  'PUT /api/shifts/:id': 'Исправил смену',
  'DELETE /api/shifts/:id': 'Удалил смену',
  'POST /api/fines': 'Выписал штраф',
  'POST /api/bonuses': 'Начислил бонус сотруднику',
  'DELETE /api/bonuses/:id': 'Отменил бонус сотруднику',
  'PUT /api/users/:id/pay': 'Изменил зарплату сотрудника',
  'PUT /api/pay-override': 'Исправил сумму в ведомости',
  'POST /api/tasks': 'Дал задание',
  'PUT /api/tasks/:id/done': 'Отметил задание',
  'PUT /api/tasks/:id/review': 'Проверил задание',
  'DELETE /api/tasks/:id': 'Удалил задание',
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
  'PUT /api/settings/sms': 'Изменил подключение SMS',
  'POST /api/settings/sms/test': 'Отправил пробное SMS',
  'POST /api/customers/codes/:id/sent': 'Передал покупателю код подтверждения',
  'POST /api/customers/:id/password': 'Выдал покупателю временный пароль',
  'PUT /api/customers/:id/login': 'Изменил доступ покупателя к витрине',
  'POST /api/settings/telegram/test': 'Отправил пробное уведомление',
};
const ORDER_NAMES = { confirmed: 'подтверждён', ready: 'собран', shipped: 'передан курьеру', done: 'выдан', cancelled: 'отменён' };

// Подробности для журнала: о чём именно речь. Пароли и токены сюда не попадают.
const docTitle = (d) => `${store.docKinds[d.kind]?.name || d.kind} №${d.number}${d.direction === 'in' ? ' (входящее)' : ''} — ${d.status === 'posted' ? 'проведён' : 'не проведён'}, ${d.items?.length ?? ''} поз., ${d.kind === 'inventory' ? `недостача ${d.shortage_cost}, излишек ${d.surplus_cost}` : `${d.total} сом`}`;

function auditDetails(key, params, body, result) {
  const r = result && typeof result === 'object' ? result : {};
  switch (key) {
    case 'PUT /api/payment-methods/:id': return `${r.name}${r.active ? '' : ' (выключен)'}`;
    case 'POST /api/sales': return `Чек №${r.id} на ${r.total} сом, ${r.payments?.length > 1 ? r.payments.map((x) => `${x.name} ${x.amount}`).join(' + ') : r.method}${r.discount ? `, скидка ${r.discount} сом (${r.discountReason})` : ''}`;
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
    case 'DELETE /api/categories/:id': return `товаров перенесено: ${r.moved}${r.to ? ` в «${r.to}»` : ', остались без категории'}`;
    case 'POST /api/products/:id/variants': return `${Array.isArray(r) ? r.length : 0} шт.`;
    case 'POST /api/expenses':
    case 'DELETE /api/expenses/:id': return `${r.category}: ${r.amount} сом${r.note ? ` (${r.note})` : ''}`;
    case 'POST /api/recurring-expenses':
    case 'PUT /api/recurring-expenses/:id':
    case 'DELETE /api/recurring-expenses/:id': return `${r.name}: ${r.amount} сом в месяц${r.active === 0 ? ' (выключен)' : ''}`;
    case 'POST /api/docs':
    case 'PUT /api/docs/:id':
    case 'POST /api/docs/:id/post':
    case 'POST /api/docs/:id/unpost':
    case 'DELETE /api/docs/:id': return docTitle(r);
    case 'POST /api/registers':
    case 'PUT /api/registers/:id': return `${r.name}${r.active === 0 ? ' (выключена)' : ''}`;
    case 'POST /api/accounts/ops': return `${({ deposit: 'Внесение', withdraw: 'Изъятие', transfer: 'Перевод' })[r.kind]}: ${r.account}${r.to ? ` → ${r.to}` : ''}, ${r.amount} сом${body.note ? ` — ${body.note}` : ''}`;
    case 'DELETE /api/accounts/ops/:id': return `${r.amount} сом — ${r.note}`;
    case 'PUT /api/accounts/:id/opening': return `${r.name}: ${r.opening} сом`;
    case 'POST /api/suppliers':
    case 'PUT /api/suppliers/:id':
    case 'DELETE /api/suppliers/:id': return r.name;
    case 'POST /api/fines': return `${store.findUser(body.user_id)?.name || ''}: ${r.amount} сом — ${r.reason}`;
    case 'DELETE /api/fines/:id': return `${r.amount} сом — ${r.reason}`;
    case 'POST /api/bonuses': return `${store.findUser(body.user_id)?.name || ''}: +${r.amount} сом — ${r.reason}`;
    case 'DELETE /api/bonuses/:id': return `${r.amount} сом — ${r.reason}`;
    case 'POST /api/tasks': return `«${r[0]?.title}» — ${r.map((t) => t.assignee).join(', ')}`;
    case 'PUT /api/tasks/:id/done': return `«${r.title}» — ${r.status === 'done' ? 'выполнено' : 'отметка снята'}${r.done_comment ? `: ${r.done_comment}` : ''}`;
    case 'PUT /api/tasks/:id/review': return `«${r.title}» (${r.assignee_name}) — ${r.status === 'approved' ? 'принято' : 'возвращено на доработку'}${r.check_comment ? `: ${r.check_comment}` : ''}`;
    case 'DELETE /api/tasks/:id': return `«${r.title}» (${r.assignee_name})`;
    case 'PUT /api/pay-override': return `${r.user}, ${({ rate: 'ставка за выход', salary: 'за смены и оклад', bonus: '% от продаж', pay: 'к выплате' })[r.field]}: ${r.amount === null ? 'возвращён расчёт' : `${r.amount} сом${r.reason ? ` — ${r.reason}` : ''}`}, период ${new Date(body.from).toLocaleDateString('ru-RU')}—${new Date(body.to - 1).toLocaleDateString('ru-RU')}`;
    case 'POST /api/users/:id/branch': return `${r.name || r.email}: ${branchList().find((b) => b.id === Number(body.home))?.name || ''}${(body.stores || []).length ? `, также ${(body.stores || []).map((id) => branchList().find((b) => b.id === Number(id))?.name).filter(Boolean).join(', ')}` : ''}`;
    case 'PUT /api/users/:id/pay': return `${r.name || r.email}: за смену ${r.shift_rate}, оклад ${r.salary}, ${r.percent}%, план ${r.plan}, бонус за план ${r.plan_bonus}`;
    case 'POST /api/customers/:id/bonus': return `${r.name || '+' + r.phone}: ${body.delta > 0 ? '+' : ''}${body.delta}${body.reason ? ` (${body.reason})` : ''}`;
    case 'PUT /api/orders/:id': return `Заказ №${params.id} ${ORDER_NAMES[body.status] || body.status}`;
    case 'PUT /api/users/:id': return `${r.name || r.email}${body.password ? ', новый пароль' : ''}${body.pin ? ', новый PIN' : body.clearPin ? ', PIN убран' : ''}${body.rights !== undefined ? ', права' : ''}`;
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
  // Смена кассира: только с кассы, где уже работает сотрудник с правом «Касса».
  if (url.pathname === '/api/switch-user' && req.method === 'POST') {
    const onTill = auth.currentUser(req);
    if (!onTill || !can(onTill, 'pos')) return sendJson(res, 403, { error: 'Смена кассира доступна только на открытой кассе' });
    const body = await readBody(req);
    const target = store.findUser(body.userId);
    if (!target || !can(target, 'pos')) return sendJson(res, 400, { error: 'Этот сотрудник не работает на кассе' });
    // Кассир выбирается в магазине, где сейчас открыта касса.
    const result = auth.switchUser(req, staffDirectory.keyOf({ ...target, branch: current().id }), String(body.code || ''));
    const who = { ip: clientIp(req), device: device(req) };
    if (!result.ok) {
      store.audit({ ...who, kind: 'login_failed', userName: target.name || target.email, action: 'Неудачная смена кассира', details: `${result.error} (на кассе был ${onTill.name || onTill.email})` });
      return sendJson(res, result.status, { error: result.error });
    }
    store.audit({ ...who, kind: 'login', user: result.user, action: 'Смена кассира', details: `после ${onTill.name || onTill.email}` });
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, { ok: true, user: store.publicUser(result.user) });
  }
  // Владелец переключается между магазинами: выбор хранится в cookie shop_branch.
  if (url.pathname === '/api/branch/switch' && req.method === 'POST') {
    const me = auth.currentUser(req);
    if (!me) return sendJson(res, 401, { error: 'Нужно войти' });
    const body = await readBody(req);
    const ctx = contextOf(body.id);
    if (!ctx) return sendJson(res, 400, { error: 'Магазин не найден' });
    if (!allowedBranches(me).includes(ctx.id)) return sendJson(res, 403, { error: 'У вас нет доступа к этому магазину. Его открывает владелец в карточке сотрудника.' });
    res.setHeader('Set-Cookie', `shop_branch=${ctx.id}; Path=/; SameSite=Lax; Max-Age=${365 * 86400}`);
    mainStore.audit({ kind: 'change', user: me, ip: clientIp(req), device: device(req), action: 'Перешёл в магазин', details: branchList().find((b) => b.id === ctx.id)?.name || '' });
    return sendJson(res, 200, { ok: true, id: ctx.id });
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
    const products = store.shopProducts();
    return sendJson(res, 200, { settings: { ...publicSettings, preview: !shop.enabled }, products, categories: store.shopCategories(products) });
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

// Каждый запрос выполняется в контексте магазина: сотрудник филиала — в своём, владелец — в выбранном.
// Интернет-витрина и вебхуки Instagram/WhatsApp — у основного магазина.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let found = null;
  try { found = auth.currentUser(req); } catch {}
  const shared = url.pathname.startsWith('/shop') || url.pathname.startsWith('/webhooks/');
  const { ctx, user, owner } = shared ? { ctx: contexts.get(1), user: found, owner: null } : resolveContext(req, found);
  return als.run(ctx, () => handleRequest(req, res, url, user, owner));
});

async function handleRequest(req, res, url, user, owner) {
  // SAMEORIGIN, а не DENY: конструктор витрины показывает её предпросмотр во фрейме.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if ((await handleAuth(req, res, url)) !== false) return;
  } catch (err) {
    return sendJson(res, err instanceof UserError ? 400 : 500, { error: err instanceof UserError ? err.message : 'Внутренняя ошибка' });
  }
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
    const result = await route.handler(route.params, url, body, user && { ...store.publicUser(user), owner: Boolean(owner) });
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
}

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
