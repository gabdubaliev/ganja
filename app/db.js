'use strict';

// Хранилище на встроенном в Node.js SQLite: один файл базы на диске.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class UserError extends Error {}

const round2 = (n) => Math.round(n * 100) / 100;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'шт',
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS products_barcode ON products(barcode);
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      payment TEXT NOT NULL,
      total REAL NOT NULL,
      refunded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at);
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      name TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL NOT NULL,
      cost REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);
    CREATE TABLE IF NOT EXISTS arrivals (
      id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      supplier TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS arrival_items (
      id INTEGER PRIMARY KEY,
      arrival_id INTEGER NOT NULL REFERENCES arrivals(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      qty REAL NOT NULL,
      cost REAL NOT NULL
    );
  `);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function text(value, field, { required = false, max = 200 } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) throw new UserError(`Заполните поле «${field}»`);
  if (s.length > max) throw new UserError(`Поле «${field}» длиннее ${max} символов`);
  return s;
}

function number(value, field, { min = 0, positive = false } = {}) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new UserError(`В поле «${field}» должно быть число`);
  if (positive ? n <= 0 : n < min) throw new UserError(`В поле «${field}» должно быть число ${positive ? 'больше 0' : `не меньше ${min}`}`);
  return n;
}

function createStore(file) {
  const db = open(file);

  const productFields = (input, current = {}) => ({
    name: text(input.name ?? current.name, 'Название', { required: true }),
    category: text(input.category ?? current.category, 'Категория'),
    barcode: text(input.barcode ?? current.barcode, 'Штрихкод', { max: 64 }),
    unit: text(input.unit ?? current.unit ?? 'шт', 'Единица', { max: 10 }) || 'шт',
    price: round2(number(input.price ?? current.price, 'Цена продажи')),
    cost: round2(number(input.cost ?? current.cost ?? 0, 'Себестоимость')),
  });

  function getProduct(id) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    if (!p) throw new UserError('Товар не найден');
    return p;
  }

  function checkBarcode(barcode, exceptId = 0) {
    if (!barcode) return;
    const other = db.prepare('SELECT name FROM products WHERE barcode = ? AND archived = 0 AND id != ?').get(barcode, exceptId);
    if (other) throw new UserError(`Штрихкод ${barcode} уже есть у товара «${other.name}»`);
  }

  return {
    db,

    isEmpty() {
      return db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0;
    },

    listProducts({ archived = false } = {}) {
      return db.prepare(`SELECT * FROM products WHERE archived = ? ORDER BY name COLLATE NOCASE`).all(archived ? 1 : 0);
    },

    createProduct(input) {
      const f = productFields(input);
      const stock = number(input.stock ?? 0, 'Остаток');
      checkBarcode(f.barcode);
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO products (name, category, barcode, unit, price, cost, stock, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.category, f.barcode, f.unit, f.price, f.cost, stock, Date.now());
      return getProduct(lastInsertRowid);
    },

    updateProduct(id, input) {
      const current = getProduct(id);
      const f = productFields(input, current);
      checkBarcode(f.barcode, current.id);
      const archived = input.archived === undefined ? current.archived : input.archived ? 1 : 0;
      db.prepare(`UPDATE products SET name = ?, category = ?, barcode = ?, unit = ?, price = ?, cost = ?, archived = ? WHERE id = ?`)
        .run(f.name, f.category, f.barcode, f.unit, f.price, f.cost, archived, current.id);
      return getProduct(current.id);
    },

    // Ручная корректировка остатка (инвентаризация).
    setStock(id, stock) {
      const p = getProduct(id);
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(number(stock, 'Остаток'), p.id);
      return getProduct(p.id);
    },

    createSale({ items, payment, at }) {
      if (!Array.isArray(items) || !items.length) throw new UserError('В чеке нет товаров');
      if (!['cash', 'card'].includes(payment)) throw new UserError('Выберите способ оплаты');
      return transaction(db, () => {
        const lines = items.map((item) => {
          const p = getProduct(item.productId);
          if (p.archived) throw new UserError(`Товар «${p.name}» убран из продажи`);
          const qty = number(item.qty, 'Количество', { positive: true });
          const price = round2(number(item.price ?? p.price, 'Цена'));
          if (qty > p.stock + 1e-9) throw new UserError(`Не хватает «${p.name}»: на складе ${p.stock} ${p.unit}, в чеке ${qty}`);
          return { p, qty, price };
        });
        const total = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
        const { lastInsertRowid: saleId } = db.prepare('INSERT INTO sales (created_at, payment, total) VALUES (?, ?, ?)')
          .run(at || Date.now(), payment, total);
        const addItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)');
        const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
        for (const l of lines) {
          addItem.run(saleId, l.p.id, l.p.name, l.qty, l.price, l.p.cost);
          takeStock.run(l.qty, l.p.id);
        }
        return { id: Number(saleId), total };
      });
    },

    refundSale(id) {
      return transaction(db, () => {
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(id));
        if (!sale) throw new UserError('Чек не найден');
        if (sale.refunded_at) throw new UserError('По этому чеку уже оформлен возврат');
        db.prepare('UPDATE sales SET refunded_at = ? WHERE id = ?').run(Date.now(), sale.id);
        db.prepare(`UPDATE products SET stock = stock + (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = ? AND product_id = products.id)
                    WHERE id IN (SELECT product_id FROM sale_items WHERE sale_id = ?)`).run(sale.id, sale.id);
        return { id: sale.id };
      });
    },

    listSales({ from, to, limit = 200 }) {
      const sales = db.prepare('SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(from, to, limit);
      const items = db.prepare('SELECT product_id, name, qty, price FROM sale_items WHERE sale_id = ?');
      return sales.map((s) => ({ ...s, items: items.all(s.id) }));
    },

    // Приход: увеличивает остаток и пересчитывает себестоимость как средневзвешенную.
    createArrival({ supplier, items, at }) {
      if (!Array.isArray(items) || !items.length) throw new UserError('В приходе нет товаров');
      return transaction(db, () => {
        const lines = items.map((item) => ({
          p: getProduct(item.productId),
          qty: number(item.qty, 'Количество', { positive: true }),
          cost: round2(number(item.cost, 'Закупочная цена')),
        }));
        const total = round2(lines.reduce((s, l) => s + l.qty * l.cost, 0));
        const { lastInsertRowid: arrivalId } = db.prepare('INSERT INTO arrivals (created_at, supplier, total) VALUES (?, ?, ?)')
          .run(at || Date.now(), text(supplier, 'Поставщик'), total);
        const addItem = db.prepare('INSERT INTO arrival_items (arrival_id, product_id, qty, cost) VALUES (?, ?, ?, ?)');
        const update = db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?');
        for (const l of lines) {
          const p = getProduct(l.p.id);
          const oldStock = Math.max(0, p.stock);
          const cost = oldStock > 0 ? round2((oldStock * p.cost + l.qty * l.cost) / (oldStock + l.qty)) : l.cost;
          addItem.run(arrivalId, p.id, l.qty, l.cost);
          update.run(p.stock + l.qty, cost, p.id);
        }
        return { id: Number(arrivalId), total };
      });
    },

    listArrivals({ limit = 100 } = {}) {
      const arrivals = db.prepare('SELECT * FROM arrivals ORDER BY created_at DESC LIMIT ?').all(limit);
      const items = db.prepare(`SELECT ai.qty, ai.cost, p.name, p.unit FROM arrival_items ai JOIN products p ON p.id = ai.product_id WHERE ai.arrival_id = ?`);
      return arrivals.map((a) => ({ ...a, items: items.all(a.id) }));
    },

    // Данные для дашборда: товары и строки продаж (без возвратов) за период.
    analytics({ from, to }) {
      const products = db.prepare('SELECT id, name, category, unit, stock, price, cost FROM products WHERE archived = 0').all()
        .map((p) => ({ ...p, id: String(p.id) }));
      const sales = db.prepare(`
        SELECT s.created_at AS t, s.id AS r, si.product_id AS p, si.name AS n, si.qty AS q, si.qty * si.price AS s, si.qty * si.cost AS c
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?
        ORDER BY s.created_at`).all(from, to)
        .map((l) => ({ ...l, p: String(l.p), r: String(l.r) }));
      return { products, sales, updatedAt: Date.now() };
    },

    transaction: (fn) => transaction(db, fn),
  };
}

module.exports = { createStore, UserError };
