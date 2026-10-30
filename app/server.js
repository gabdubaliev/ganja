'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
const { createStore, UserError } = require('./db');
const { seedDemo } = require('./demo');
const crypto = require('node:crypto');
const { createAuth, hashPassword, checkPassword } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || 'data/shop.db');
const PUBLIC = path.join(__dirname, 'public');
const MAX_RANGE = 800 * 864e5;
// Без входа можно открыть только страницу входа и её стили.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
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
  store.ensureAdmin(ADMIN_EMAIL, () => hashPassword(ADMIN_PASSWORD), (hash) => checkPassword(ADMIN_PASSWORD, hash));
}
if (process.env.REQUIRE_PASSWORD === '1' && store.activeAdmins() === 0) {
  console.error('Задайте администратора в переменных ADMIN_EMAIL и ADMIN_PASSWORD. Без него программа на сервере не запускается.');
  process.exit(1);
}

const auth = createAuth(store, process.env.SESSION_SECRET || store.setting('session_secret', crypto.randomBytes(32).toString('base64url')));

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

// [метод, шаблон пути, обработчик(params, url, body, user), кому можно]
// 'all' — любому вошедшему сотруднику, 'admin' — только администратору.
// Продавец работает на кассе и видит чеки, остальное — у администратора.
const routes = [
  ['GET', '/api/status', (p, url, body, user) => ({ empty: store.isEmpty(), auth: auth.enabled, user }), 'all'],
  ['GET', '/api/products', (p, url) => store.listProducts({ archived: url.searchParams.get('archived') === '1' }), 'all'],
  ['GET', '/api/sales', (p, url) => store.listSales(range(url)), 'all'],
  ['POST', '/api/sales', (p, url, body) => store.createSale(body), 'all'],
  ['PUT', '/api/me/password', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.updateUser(user.id, {}, password(body.password));
    return { ok: true };
  }, 'all'],
  ['GET', '/api/users', () => store.listUsers()],
  ['POST', '/api/users', (p, url, body) => store.createUser(body, password(body.password))],
  ['PUT', '/api/users/:id', (p, url, body) => store.updateUser(p.id, body, body.password ? password(body.password) : null)],
  ['DELETE', '/api/users/:id', (p, url, body, user) => {
    if (user && Number(p.id) === user.id) throw new UserError('Нельзя удалить самого себя');
    return store.deleteUser(p.id);
  }],
  ['POST', '/api/demo', () => {
    if (!store.isEmpty()) throw new UserError('Пример можно загрузить только в пустую базу');
    seedDemo(store);
    return { ok: true };
  }],
  ['POST', '/api/products', (p, url, body) => store.createProduct(body)],
  ['PUT', '/api/products/:id', (p, url, body) => store.updateProduct(p.id, body)],
  ['POST', '/api/products/import', (p, url, body) => store.importProducts(body.rows, { update: Boolean(body.update) })],
  ['PUT', '/api/products/:id/stock', (p, url, body) => store.setStock(p.id, body.stock)],
  ['POST', '/api/sales/:id/refund', (p) => store.refundSale(p.id)],
  ['GET', '/api/arrivals', () => store.listArrivals()],
  ['POST', '/api/arrivals', (p, url, body) => store.createArrival(body)],
  ['GET', '/api/analytics', (p, url) => store.analytics(range(url))],
];

function match(method, pathname) {
  for (const [m, pattern, handler, access = 'admin'] of routes) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if ((await handleAuth(req, res, url)) !== false) return;
  } catch (err) {
    return sendJson(res, err instanceof UserError ? 400 : 500, { error: err instanceof UserError ? err.message : 'Внутренняя ошибка' });
  }
  const user = auth.currentUser(req);
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
  const route = match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Не найдено' });
  // Пока сотрудников нет, программа открыта и всё можно (работа на своём компьютере).
  if (route.access === 'admin' && user && user.role !== 'admin') return sendJson(res, 403, { error: 'Это может только администратор' });
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
  server.listen(PORT, HOST, () => {
    console.log(`Программа открыта: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`База данных: ${DB_FILE}`);
    console.log(auth.enabled ? 'Вход по email и паролю включён.' : 'Вход без пароля (администратор задаётся в ADMIN_EMAIL и ADMIN_PASSWORD).');
  });
}
