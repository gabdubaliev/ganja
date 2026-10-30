'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
const { createStore, UserError } = require('./db');
const { seedDemo } = require('./demo');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || 'data/shop.db');
const PUBLIC = path.join(__dirname, 'public');
const MAX_RANGE = 800 * 864e5;

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) throw new UserError('Слишком большой запрос');
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

// [метод, шаблон пути, обработчик(params, url, body)]
const routes = [
  ['GET', '/api/status', () => ({ empty: store.isEmpty() })],
  ['POST', '/api/demo', () => {
    if (!store.isEmpty()) throw new UserError('Пример можно загрузить только в пустую базу');
    seedDemo(store);
    return { ok: true };
  }],
  ['GET', '/api/products', (p, url) => store.listProducts({ archived: url.searchParams.get('archived') === '1' })],
  ['POST', '/api/products', (p, url, body) => store.createProduct(body)],
  ['PUT', '/api/products/:id', (p, url, body) => store.updateProduct(p.id, body)],
  ['PUT', '/api/products/:id/stock', (p, url, body) => store.setStock(p.id, body.stock)],
  ['GET', '/api/sales', (p, url) => store.listSales(range(url))],
  ['POST', '/api/sales', (p, url, body) => store.createSale(body)],
  ['POST', '/api/sales/:id/refund', (p) => store.refundSale(p.id)],
  ['GET', '/api/arrivals', () => store.listArrivals()],
  ['POST', '/api/arrivals', (p, url, body) => store.createArrival(body)],
  ['GET', '/api/analytics', (p, url) => store.analytics(range(url))],
];

function match(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const found = pathname.match(re);
    if (found) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(found[i + 1])])) };
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, decodeURIComponent(url.pathname));
  const route = match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Не найдено' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    sendJson(res, 200, await route.handler(route.params, url, body));
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
  });
}
