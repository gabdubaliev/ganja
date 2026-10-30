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
      code TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'seller',
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Базы, созданные до появления кода товара.
  if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'code')) {
    db.exec("ALTER TABLE products ADD COLUMN code TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS products_code ON products(code)');
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

const ROLES = ['admin', 'seller'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value) {
  const s = text(value, 'Email', { required: true, max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new UserError('Email указан неверно');
  return s;
}

function role(value) {
  if (!ROLES.includes(value)) throw new UserError('Неизвестная роль');
  return value;
}

// Сотрудник без хеша пароля — так он уходит в интерфейс.
const publicUser = ({ password_hash, ...u }) => ({ ...u, disabled: Boolean(u.disabled) });

function createStore(file) {
  const db = open(file);

  const productFields = (input, current = {}) => ({
    name: text(input.name ?? current.name, 'Название', { required: true }),
    category: text(input.category ?? current.category, 'Категория'),
    barcode: text(input.barcode ?? current.barcode, 'Штрихкод', { max: 64 }),
    code: text(input.code ?? current.code, 'Код товара', { max: 64 }),
    unit: text(input.unit ?? current.unit ?? 'шт', 'Единица', { max: 10 }) || 'шт',
    price: round2(number(input.price ?? current.price, 'Цена продажи')),
    cost: round2(number(input.cost ?? current.cost ?? 0, 'Себестоимость')),
  });

  function getProduct(id) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    if (!p) throw new UserError('Товар не найден');
    return p;
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
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.category, f.barcode, f.code, f.unit, f.price, f.cost, stock, Date.now());
      return getProduct(lastInsertRowid);
    },

    updateProduct(id, input) {
      const current = getProduct(id);
      const f = productFields(input, current);
      const archived = input.archived === undefined ? current.archived : input.archived ? 1 : 0;
      db.prepare(`UPDATE products SET name = ?, category = ?, barcode = ?, code = ?, unit = ?, price = ?, cost = ?, archived = ? WHERE id = ?`)
        .run(f.name, f.category, f.barcode, f.code, f.unit, f.price, f.cost, archived, current.id);
      return getProduct(current.id);
    },

    // Ручная корректировка остатка (инвентаризация).
    setStock(id, stock) {
      const p = getProduct(id);
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(number(stock, 'Остаток'), p.id);
      return getProduct(p.id);
    },

    // Импорт из таблицы. Существующий товар ищется по коду, а без кода — по паре
    // «название + штрихкод»: у разных товаров (цветов одной модели) штрихкод бывает общим.
    // Строки с ошибками пропускаются, остальные загружаются.
    importProducts(rows, { update = false } = {}) {
      if (!Array.isArray(rows) || !rows.length) throw new UserError('В файле нет товаров');
      return transaction(db, () => {
        const result = { created: 0, updated: 0, skipped: [] };
        const byCode = new Map();
        const byNameBarcode = new Map();
        const nameKey = (p) => `${p.name.toLowerCase()}\n${p.barcode}`;
        const remember = (p) => {
          if (p.code) byCode.set(p.code, p);
          byNameBarcode.set(nameKey(p), p);
        };
        db.prepare('SELECT * FROM products WHERE archived = 0').all().forEach(remember);
        const insert = db.prepare(`
          INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const change = db.prepare('UPDATE products SET name = ?, category = ?, barcode = ?, unit = ?, price = ?, cost = ?, stock = ? WHERE id = ?');

        rows.forEach((row, i) => {
          const line = row.line || i + 1;
          try {
            const f = productFields({ ...row, unit: row.unit || 'шт' });
            const stock = row.stock === '' || row.stock == null ? null : number(row.stock, 'Остаток', { min: -Infinity });
            const existing = f.code ? byCode.get(f.code) : byNameBarcode.get(nameKey(f));
            if (existing) {
              if (!update) return result.skipped.push({ line, name: f.name, reason: 'уже есть в программе' });
              const next = {
                ...existing,
                name: f.name,
                category: f.category || existing.category,
                barcode: f.barcode || existing.barcode,
                unit: row.unit ? f.unit : existing.unit,
                price: f.price,
                cost: row.cost === '' || row.cost == null ? existing.cost : f.cost,
                stock: stock ?? existing.stock,
              };
              change.run(next.name, next.category, next.barcode, next.unit, next.price, next.cost, next.stock, existing.id);
              remember(next);
              result.updated++;
            } else {
              const { lastInsertRowid } = insert.run(f.name, f.category, f.barcode, f.code, f.unit, f.price, f.cost, stock ?? 0, Date.now());
              remember({ ...f, id: Number(lastInsertRowid), stock: stock ?? 0 });
              result.created++;
            }
          } catch (err) {
            if (!(err instanceof UserError)) throw err;
            result.skipped.push({ line, name: String(row.name ?? '').trim(), reason: err.message });
          }
        });
        return result;
      });
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
      const products = db.prepare('SELECT id, name, category, code, unit, stock, price, cost FROM products WHERE archived = 0').all()
        .map((p) => ({ ...p, id: String(p.id) }));
      const sales = db.prepare(`
        SELECT s.created_at AS t, s.id AS r, si.product_id AS p, si.name AS n, si.qty AS q, si.qty * si.price AS s, si.qty * si.cost AS c
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?
        ORDER BY s.created_at`).all(from, to)
        .map((l) => ({ ...l, p: String(l.p), r: String(l.r) }));
      return { products, sales, updatedAt: Date.now() };
    },

    /* ---------- Сотрудники ---------- */
    // passwordHash готовит auth.js, хранилище пароль в открытом виде не видит.

    countUsers() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },

    findUser(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
    },

    findUserByEmail(value) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(String(value ?? '').trim()) || null;
    },

    listUsers() {
      return db.prepare('SELECT * FROM users ORDER BY role, email').all().map(publicUser);
    },

    createUser(input, passwordHash) {
      const e = email(input.email);
      if (this.findUserByEmail(e)) throw new UserError('Сотрудник с таким email уже есть');
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(e, text(input.name, 'Имя', { max: 80 }), role(input.role || 'seller'), passwordHash, Date.now());
      return publicUser(this.findUser(lastInsertRowid));
    },

    // Последнего действующего администратора нельзя понизить, отключить или удалить:
    // иначе управлять программой станет некому.
    updateUser(id, input, passwordHash = null) {
      const current = this.findUser(id);
      if (!current) throw new UserError('Сотрудник не найден');
      const next = {
        email: input.email === undefined ? current.email : email(input.email),
        name: input.name === undefined ? current.name : text(input.name, 'Имя', { max: 80 }),
        role: input.role === undefined ? current.role : role(input.role),
        disabled: input.disabled === undefined ? current.disabled : input.disabled ? 1 : 0,
      };
      const other = this.findUserByEmail(next.email);
      if (other && other.id !== current.id) throw new UserError('Сотрудник с таким email уже есть');
      if (current.role === 'admin' && !current.disabled && (next.role !== 'admin' || next.disabled) && this.activeAdmins() <= 1) {
        throw new UserError('Это единственный администратор. Сначала назначьте другого.');
      }
      db.prepare('UPDATE users SET email = ?, name = ?, role = ?, disabled = ?, password_hash = ? WHERE id = ?')
        .run(next.email, next.name, next.role, next.disabled, passwordHash || current.password_hash, current.id);
      return publicUser(this.findUser(current.id));
    },

    deleteUser(id) {
      const current = this.findUser(id);
      if (!current) throw new UserError('Сотрудник не найден');
      if (current.role === 'admin' && !current.disabled && this.activeAdmins() <= 1) {
        throw new UserError('Это единственный администратор. Сначала назначьте другого.');
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(current.id);
      return { ok: true };
    },

    activeAdmins() {
      return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
    },

    // Администратор из переменных ADMIN_EMAIL и ADMIN_PASSWORD: создаётся при запуске,
    // а если уже есть — снова получает права администратора. makeHash вызывается, только когда
    // пароль нужно записать: у нового сотрудника или если пароль в переменной сменили.
    ensureAdmin(adminEmail, makeHash, passwordMatches) {
      const e = email(adminEmail);
      const current = this.findUserByEmail(e);
      if (!current) return this.createUser({ email: e, name: 'Администратор', role: 'admin' }, makeHash());
      const hash = passwordMatches(current.password_hash) ? current.password_hash : makeHash();
      db.prepare("UPDATE users SET role = 'admin', disabled = 0, password_hash = ? WHERE id = ?").run(hash, current.id);
      return publicUser(this.findUser(current.id));
    },

    publicUser,

    setting(key, fallback) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row) return row.value;
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, fallback);
      return fallback;
    },

    transaction: (fn) => transaction(db, fn),
  };
}

module.exports = { createStore, UserError };
