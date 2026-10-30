'use strict';

// Клиент CloudShop API (https://connect-api.cloudshop.ru).
//
// Пути и имена полей ниже не сверены с документацией Swagger: при первом
// подключении запустите `npm run check`, посмотрите, что реально отдаёт API,
// и при необходимости поправьте пути в .env или списки полей в normalize*.

function config() {
  const env = process.env;
  return {
    base: (env.CLOUDSHOP_API_URL || 'https://connect-api.cloudshop.ru/api/v4').replace(/\/$/, ''),
    token: env.CLOUDSHOP_TOKEN || '',
    productsPath: env.CLOUDSHOP_PRODUCTS_PATH || '/catalog',
    salesPath: env.CLOUDSHOP_SALES_PATH || '/sales',
    stockPath: env.CLOUDSHOP_STOCK_PATH || '',
    pageSize: Number(env.CLOUDSHOP_PAGE_SIZE) || 500,
  };
}

function isConfigured() {
  return Boolean(config().token);
}

async function request(pathname, params = {}) {
  const cfg = config();
  const url = new URL(cfg.base + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: {
      'X-AINUR-API-Access-Token': cfg.token,
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`CloudShop ответил ${res.status} на ${url.pathname}: ${body}`);
  }
  return res.json();
}

// Ответ может быть массивом или объектом с массивом внутри.
function extractList(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['data', 'items', 'result', 'rows', 'docs', 'list']) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  return [];
}

async function listAll(pathname, params = {}) {
  const { pageSize } = config();
  const all = [];
  for (let page = 0; page < 500; page++) {
    const items = extractList(await request(pathname, { ...params, limit: pageSize, skip: page * pageSize }));
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all;
}

// Первое непустое значение из списка путей вида 'group.name'.
function pick(obj, paths) {
  for (const p of paths) {
    const value = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function num(value) {
  if (typeof value === 'number') return value;
  const n = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function normalizeProduct(raw) {
  return {
    id: String(pick(raw, ['_id', 'id', 'uuid', 'code'])),
    name: String(pick(raw, ['name', 'title']) ?? 'Без названия'),
    category: String(pick(raw, ['group.name', 'category.name', 'groupName', 'categoryName', 'category']) ?? 'Без категории'),
    stock: num(pick(raw, ['stock', 'rest', 'balance', 'quantity', 'amount'])),
    price: num(pick(raw, ['price', 'sellPrice', 'retailPrice'])),
    cost: num(pick(raw, ['costPrice', 'cost', 'purchasePrice', 'buyPrice'])),
  };
}

// Один документ продажи превращается в строки чека.
function normalizeSale(raw) {
  if (/cancel|delete|отмен|удал/i.test(String(pick(raw, ['status', 'state']) ?? ''))) return [];
  const sign = /return|refund|возврат/i.test(String(pick(raw, ['type', 'operation', 'kind']) ?? '')) ? -1 : 1;
  const time = new Date(pick(raw, ['date', 'createdAt', 'created', 'time', 'datetime'])).getTime();
  if (!Number.isFinite(time)) return [];
  const receipt = String(pick(raw, ['_id', 'id', 'number', 'uuid']));
  const items = pick(raw, ['items', 'goods', 'products', 'positions', 'lines']) || [];
  return items.map((item) => {
    const qty = num(pick(item, ['quantity', 'count', 'amount', 'qty']));
    const sum = num(pick(item, ['sum', 'total', 'totalSum'])) || qty * num(pick(item, ['price']));
    const unitCost = pick(item, ['costPrice', 'cost', 'purchasePrice']);
    return {
      t: time,
      r: receipt,
      p: String(pick(item, ['product._id', 'product.id', 'productId', 'goodId', 'good', 'item', '_id', 'id'])),
      n: pick(item, ['product.name', 'name', 'title']),
      q: sign * qty,
      s: sign * sum,
      c: unitCost === undefined ? null : sign * qty * num(unitCost),
    };
  });
}

async function fetchProducts() {
  const cfg = config();
  const products = (await listAll(cfg.productsPath)).map(normalizeProduct);
  if (cfg.stockPath) {
    const stock = new Map();
    for (const row of await listAll(cfg.stockPath)) {
      const id = String(pick(row, ['product._id', 'product.id', 'productId', 'good', '_id']));
      stock.set(id, (stock.get(id) || 0) + num(pick(row, ['quantity', 'rest', 'stock', 'amount'])));
    }
    for (const p of products) if (stock.has(p.id)) p.stock = stock.get(p.id);
  }
  return products;
}

async function fetchSales(from, to) {
  const cfg = config();
  const docs = await listAll(cfg.salesPath, { from: from.toISOString(), to: to.toISOString() });
  return docs.flatMap(normalizeSale).filter((line) => line.t >= from.getTime() && line.t < to.getTime());
}

module.exports = { config, isConfigured, request, extractList, fetchProducts, fetchSales };
