'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
const cloudshop = require('./cloudshop');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PAGE = path.join(__dirname, 'public', 'index.html');
const CACHE_MS = 60_000;
const MAX_DAYS = 800;

// Простой разбор .env: строки KEY=value, # — комментарии.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const cache = new Map();
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function loadData(from, to) {
  const [products, sales] = await Promise.all([
    cached('products', cloudshop.fetchProducts),
    cached(`sales:${from.toISOString()}:${to.toISOString()}`, () => cloudshop.fetchSales(from, to)),
  ]);
  // Себестоимость из карточки товара, если в чеке её нет.
  const costById = new Map(products.map((p) => [p.id, p.cost]));
  for (const line of sales) if (line.c === null) line.c = line.q * (costById.get(line.p) || 0);
  return { products, sales, updatedAt: Date.now() };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(PAGE).pipe(res);
    } else if (url.pathname === '/api/status') {
      sendJson(res, 200, { mode: cloudshop.isConfigured() ? 'live' : 'demo' });
    } else if (url.pathname === '/api/data') {
      if (!cloudshop.isConfigured()) return sendJson(res, 409, { error: 'Токен CloudShop не задан' });
      const to = parseDate(url.searchParams.get('to')) || new Date();
      const from = parseDate(url.searchParams.get('from'));
      if (!from || from >= to || to - from > MAX_DAYS * 864e5) {
        return sendJson(res, 400, { error: `Нужен период from–to не длиннее ${MAX_DAYS} дней` });
      }
      sendJson(res, 200, await loadData(from, to));
    } else {
      sendJson(res, 404, { error: 'Не найдено' });
    }
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: err.message });
  }
});

// `node server.js --check` — проверить подключение и показать, что отдаёт API.
async function check() {
  if (!cloudshop.isConfigured()) {
    console.log('CLOUDSHOP_TOKEN не задан. Скопируйте .env.example в .env и впишите токен.');
    process.exit(1);
  }
  const { base, productsPath, salesPath } = cloudshop.config();
  const to = new Date();
  const from = new Date(to - 7 * 864e5);
  for (const [label, p, params] of [
    ['Товары', productsPath, { limit: 2 }],
    ['Продажи за 7 дней', salesPath, { limit: 2, from: from.toISOString(), to: to.toISOString() }],
  ]) {
    console.log(`\n=== ${label}: ${base}${p}`);
    try {
      const json = await cloudshop.request(p, params);
      console.log(JSON.stringify(cloudshop.extractList(json).length ? cloudshop.extractList(json) : json, null, 2).slice(0, 4000));
    } catch (err) {
      console.log(`Ошибка: ${err.message}`);
    }
  }
  try {
    const products = await cloudshop.fetchProducts();
    const sales = await cloudshop.fetchSales(from, to);
    console.log(`\nИтого: товаров ${products.length}, строк продаж за 7 дней ${sales.length}.`);
    console.log('Пример товара после разбора:', products[0]);
    console.log('Пример строки продажи после разбора:', sales[0]);
  } catch (err) {
    console.log(`\nНе удалось собрать данные: ${err.message}`);
  }
}

if (process.argv.includes('--check')) {
  check();
} else {
  server.listen(PORT, HOST, () => {
    const mode = cloudshop.isConfigured() ? 'данные CloudShop' : 'демо-данные (токен не задан)';
    console.log(`Дашборд: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} — ${mode}`);
  });
}
