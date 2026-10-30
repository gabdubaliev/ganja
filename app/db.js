'use strict';

// Хранилище на встроенном в Node.js SQLite: один файл базы на диске.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { RIGHTS, ROLES, can } = require('./roles');

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
      role TEXT NOT NULL DEFAULT 'cashier',
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_photos (
      product_id INTEGER PRIMARY KEY REFERENCES products(id),
      mime TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      bonus REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bonus_log (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      created_at INTEGER NOT NULL,
      delta REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      sale_id INTEGER,
      user_name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS bonus_log_customer ON bonus_log(customer_id);
  `);
  // Базы, созданные до появления кода товара.
  if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'code')) {
    db.exec("ALTER TABLE products ADD COLUMN code TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS products_code ON products(code)');
  // Столбцы, появившиеся позже: кто пробил чек, покупатель и бонусы, зарплата сотрудника, фото.
  const addColumns = (table, columns) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of columns) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addColumns('sales', [['user_id', 'INTEGER'], ['user_name', "TEXT NOT NULL DEFAULT ''"], ['customer_id', 'INTEGER'],
    ['bonus_spent', 'REAL NOT NULL DEFAULT 0'], ['bonus_earned', 'REAL NOT NULL DEFAULT 0']]);
  addColumns('users', [['salary', 'REAL NOT NULL DEFAULT 0'], ['percent', 'REAL NOT NULL DEFAULT 0'], ['plan', 'REAL NOT NULL DEFAULT 0']]);
  addColumns('products', [['photo_at', 'INTEGER'], ['deleted', 'INTEGER NOT NULL DEFAULT 0'], ['description', "TEXT NOT NULL DEFAULT ''"]]);
  addColumns('users', [['rights', 'TEXT']]);
  // Модификации: parent_id — основной товар, options — {"Цвет": "Красный", "Размер": "M"}.
  addColumns('products', [['parent_id', 'INTEGER'], ['options', "TEXT NOT NULL DEFAULT ''"]]);
  db.exec('CREATE INDEX IF NOT EXISTS products_parent ON products(parent_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      delivery TEXT NOT NULL DEFAULT 'pickup',
      address TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      updated_at INTEGER,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      name TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  addColumns('orders', [['sale_id', 'INTEGER']]);
  db.exec('CREATE INDEX IF NOT EXISTS sales_user ON sales(user_id)');
  // Роль «продавец» из прошлой версии стала «кассиром».
  db.exec("UPDATE users SET role = 'cashier' WHERE role = 'seller'");
  // Прошлые версии считали номер 0700 123 456 российским и сохраняли как 70700123456.
  // Российских номеров на 70… не бывает, так что это кыргызские: 996700123456.
  db.exec("UPDATE OR IGNORE customers SET phone = '996' || substr(phone, 3) WHERE length(phone) = 11 AND phone LIKE '70%'");
  db.exec("UPDATE orders SET phone = '996' || substr(phone, 3) WHERE length(phone) = 11 AND phone LIKE '70%'");
  return db;
}

// Вложенная транзакция (например, выдача заказа пробивает чек) становится точкой сохранения.
const depth = new WeakMap();
function transaction(db, fn) {
  const level = depth.get(db) || 0;
  const name = `sp${level}`;
  db.exec(level ? `SAVEPOINT ${name}` : 'BEGIN');
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (err) {
    db.exec(level ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
    throw err;
  } finally {
    depth.set(db, level);
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value) {
  const s = text(value, 'Email', { required: true, max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new UserError('Email указан неверно');
  return s;
}

function role(value) {
  if (!Object.hasOwn(ROLES, value)) throw new UserError('Неизвестная роль');
  return value;
}

// Сотрудник без хеша пароля — так он уходит в интерфейс.
// rights — личный набор прав или null, если действуют права роли.
const publicUser = ({ password_hash, ...u }) => ({ ...u, disabled: Boolean(u.disabled), rights: u.rights ? JSON.parse(u.rights) : null });

function rightsList(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new UserError('Права переданы неверно');
  const known = new Set(RIGHTS.map((r) => r.key));
  return JSON.stringify([...new Set(value)].filter((r) => known.has(r)));
}

// Телефон покупателя: только цифры с кодом страны. Кыргызский номер приводится к виду
// 996XXXXXXXXX: 0700 123 456 и 700 123 456 — это +996 700 123 456. Российские 8… и 9… — к 7….
function phone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '996' + d.slice(1);
  else if (d.length === 9) d = '996' + d;
  else if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  if (d.length < 10 || d.length > 15) throw new UserError('Телефон указан неверно');
  return d;
}

const LOYALTY_DEFAULTS = { enabled: true, percent: 5, maxPay: 30 };

// Оформление программы. Цвета — #rrggbb, остальное проверяется в setDesign.
const DESIGN_DEFAULTS = { name: 'Мой магазин', accent: '#2a78d6', bg: '', surface: '', ink: '', font: 'system', radius: 10, theme: 'auto', css: '' };

// Интернет-витрина: всё, что меняется в конструкторе.
const SHOP_DEFAULTS = {
  enabled: false,
  created: false,
  template: 'light',
  title: 'Мой магазин',
  slogan: 'Свежие товары каждый день',
  about: '',
  phone: '',
  address: '',
  hours: '',
  whatsapp: '',
  telegram: '',
  accent: '#2a78d6',
  bg: '#ffffff',
  surface: '#f5f5f3',
  ink: '#111111',
  font: 'system',
  radius: 14,
  columns: 4,
  cardStyle: 'photo',
  showStock: false,
  hideOutOfStock: true,
  delivery: true,
  pickup: true,
  minOrder: 0,
  deliveryPrice: 0,
  categories: [],
  bannerId: null,
  logoId: null,
  css: '',
};
const FONTS = ['system', 'serif', 'rounded', 'mono', 'condensed'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function color(value, field, { optional = false } = {}) {
  const s = String(value ?? '').trim();
  if (optional && !s) return '';
  if (!COLOR_RE.test(s)) throw new UserError(`Цвет «${field}» должен быть вида #2a78d6`);
  return s.toLowerCase();
}

// Свой CSS: тег </style> и @import запрещены, чтобы стиль не тянул чужие файлы и не ломал страницу.
function css(value) {
  const s = text(value, 'Свой CSS', { max: 20000 });
  if (/<\/?\s*style|@import|javascript:|expression\s*\(/i.test(s)) throw new UserError('В своём CSS нельзя использовать @import, javascript: и теги <style>');
  return s;
}

function monthsBetween(from, to) {
  let months = 0;
  for (let t = from; t < to;) {
    const d = new Date(t);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const stop = Math.min(end, to);
    months += (stop - t) / (end - start);
    t = stop;
  }
  return months;
}

function createStore(file) {
  const db = open(file);

  const productFields = (input, current = {}) => ({
    name: text(input.name ?? current.name, 'Название', { required: true }),
    category: text(input.category ?? current.category, 'Категория'),
    barcode: text(input.barcode ?? current.barcode, 'Штрихкод', { max: 64 }),
    code: text(input.code ?? current.code, 'Код товара', { max: 64 }),
    description: text(input.description ?? current.description, 'Описание', { max: 2000 }),
    unit: text(input.unit ?? current.unit ?? 'шт', 'Единица', { max: 10 }) || 'шт',
    price: round2(number(input.price ?? current.price, 'Цена продажи')),
    cost: round2(number(input.cost ?? current.cost ?? 0, 'Себестоимость')),
  });

  // Оклад в месяц, процент от продаж и план продаж в месяц.
  const payFields = (input, current = {}) => {
    const percent = number(input.percent ?? current.percent ?? 0, 'Процент от продаж');
    if (percent > 100) throw new UserError('Процент от продаж не может быть больше 100');
    return {
      salary: round2(number(input.salary ?? current.salary ?? 0, 'Оклад')),
      percent,
      plan: round2(number(input.plan ?? current.plan ?? 0, 'План продаж')),
    };
  };

  function getCustomer(id) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
    if (!c) throw new UserError('Покупатель не найден');
    return c;
  }

  function changeBonus(customerId, delta, reason, userName, saleId = null) {
    db.prepare('UPDATE customers SET bonus = ROUND(bonus + ?, 2) WHERE id = ?').run(delta, customerId);
    db.prepare('INSERT INTO bonus_log (customer_id, created_at, delta, reason, sale_id, user_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(customerId, Date.now(), delta, reason, saleId, userName);
  }

  // Внутренний штрихкод EAN-13. Префикс 20–29 оставлен стандартом для товаров самого магазина,
  // так он не совпадёт со штрихкодом от производителя.
  function ean13(first12) {
    const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    return first12 + ((10 - (sum % 10)) % 10);
  }

  function newBarcode() {
    const taken = db.prepare('SELECT 1 FROM products WHERE barcode = ?');
    for (let i = 0; i < 1000; i++) {
      const body = '20' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
      const code = ean13(body);
      if (!taken.get(code)) return code;
    }
    throw new UserError('Не получилось подобрать свободный штрихкод');
  }

  const childrenOf = (id) => db.prepare('SELECT * FROM products WHERE parent_id = ? AND deleted = 0 ORDER BY id').all(Number(id));

  // Варианты модификации: { "Цвет": "Красный" }. Пустые значения отбрасываются.
  function optionsOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('Укажите свойства модификации');
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = text(k, 'Свойство', { max: 30 });
      const val = text(v, `Значение «${key}»`, { max: 60 });
      if (key && val) out[key] = val;
    }
    if (!Object.keys(out).length) throw new UserError('Укажите хотя бы одно свойство модификации, например цвет или размер');
    if (Object.keys(out).length > 4) throw new UserError('У модификации может быть не больше 4 свойств');
    return out;
  }

  const variantName = (base, opts) => `${base.name} · ${Object.values(opts).join(', ')}`;
  const optionsKey = (opts) => JSON.stringify(Object.entries(opts).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]).sort());

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
      return db.prepare(`SELECT * FROM products WHERE archived = ? AND deleted = 0 ORDER BY name COLLATE NOCASE`).all(archived ? 1 : 0);
    },

    createProduct(input) {
      const f = productFields(input);
      const stock = number(input.stock ?? 0, 'Остаток');
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.category, f.barcode, f.code, f.unit, f.price, f.cost, stock, f.description, Date.now());
      return getProduct(lastInsertRowid);
    },

    // Групповые действия с товарами. ids — список товаров, action — что сделать.
    // Удалённый товар пропадает из всех списков, но история продаж и приходов по нему остаётся.
    bulkProducts({ ids, action, value, mode }) {
      if (!Array.isArray(ids) || !ids.length) throw new UserError('Выберите товары');
      if (ids.length > 10000) throw new UserError('Слишком много товаров за раз');
      return transaction(db, () => {
        // Действие над основным товаром касается и всех его модификаций.
        const picked = new Map();
        for (const p of ids.map(getProduct)) {
          if (p.deleted) continue;
          picked.set(p.id, p);
          for (const k of childrenOf(p.id)) picked.set(k.id, k);
        }
        const list = [...picked.values()];
        const set = (sql, args) => {
          const st = db.prepare(sql);
          for (const p of list) st.run(...args(p), p.id);
        };
        switch (action) {
          case 'delete': {
            const used = db.prepare('SELECT 1 FROM sale_items WHERE product_id = ? UNION SELECT 1 FROM arrival_items WHERE product_id = ? UNION SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1');
            for (const p of list) {
              if (used.get(p.id, p.id, p.id)) {
                db.prepare('UPDATE products SET deleted = 1, archived = 1 WHERE id = ?').run(p.id);
              } else {
                db.prepare('DELETE FROM product_photos WHERE product_id = ?').run(p.id);
                db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
              }
            }
            break;
          }
          case 'barcodes': {
            // Штрихкоды только тем, у кого их нет, и не основным товарам с модификациями: их не продают.
            const st = db.prepare('UPDATE products SET barcode = ? WHERE id = ?');
            const groups = new Set(list.filter((p) => p.parent_id).map((p) => p.parent_id));
            const todo = list.filter((p) => !p.barcode && !groups.has(p.id) && !childrenOf(p.id).length);
            for (const p of todo) st.run(newBarcode(), p.id);
            return { count: todo.length };
          }
          case 'archive': set('UPDATE products SET archived = 1 WHERE id = ?', () => []); break;
          case 'restore': set('UPDATE products SET archived = 0 WHERE id = ?', () => []); break;
          case 'category': {
            const c = text(value, 'Категория');
            set('UPDATE products SET category = ? WHERE id = ?', () => [c]);
            break;
          }
          case 'unit': {
            const u = text(value, 'Единица', { max: 10 }) || 'шт';
            set('UPDATE products SET unit = ? WHERE id = ?', () => [u]);
            break;
          }
          case 'price':
          case 'cost': {
            // mode: set — новая цена, percent — изменить на ±%, add — прибавить ±сомы,
            // markup — цена = себестоимость + наценка в % (только для цены).
            const n = number(value, 'Значение', { min: -Infinity });
            const calc = {
              set: () => n,
              percent: (old) => old * (1 + n / 100),
              add: (old) => old + n,
              markup: (old, p) => p.cost * (1 + n / 100),
            }[mode];
            if (!calc || (mode === 'markup' && action === 'cost')) throw new UserError('Неизвестный способ изменения цены');
            set(`UPDATE products SET ${action} = ? WHERE id = ?`, (p) => {
              const next = round2(calc(p[action], p));
              if (next < 0) throw new UserError(`У товара «${p.name}» цена получится меньше нуля`);
              return [next];
            });
            break;
          }
          default: throw new UserError('Неизвестное действие');
        }
        return { count: list.length };
      });
    },

    updateProduct(id, input) {
      const current = getProduct(id);
      if (current.parent_id) return this.updateVariant(current, input);
      const f = productFields(input, current);
      const archived = input.archived === undefined ? current.archived : input.archived ? 1 : 0;
      db.prepare(`UPDATE products SET name = ?, category = ?, barcode = ?, code = ?, unit = ?, price = ?, cost = ?, description = ?, archived = ? WHERE id = ?`)
        .run(f.name, f.category, f.barcode, f.code, f.unit, f.price, f.cost, f.description, archived, current.id);
      // Модификации живут вместе с основным товаром: имя, категория, единица, описание и «в продаже».
      const kids = childrenOf(current.id);
      if (kids.length) {
        const base = getProduct(current.id);
        const st = db.prepare('UPDATE products SET name = ?, category = ?, unit = ?, description = ?, archived = ? WHERE id = ?');
        for (const k of kids) st.run(variantName(base, JSON.parse(k.options || '{}')), base.category, base.unit, base.description, base.archived, k.id);
      }
      return getProduct(current.id);
    },

    // Модификация: свои свойства, цены, штрихкод и код. Имя собирается из основного товара и свойств.
    updateVariant(current, input) {
      const base = getProduct(current.parent_id);
      const opts = input.options === undefined ? JSON.parse(current.options || '{}') : optionsOf(input.options);
      const clash = childrenOf(base.id).find((k) => k.id !== current.id && optionsKey(JSON.parse(k.options || '{}')) === optionsKey(opts));
      if (clash) throw new UserError(`Такая модификация уже есть: ${clash.name}`);
      const f = productFields({ ...input, name: variantName(base, opts), category: base.category, unit: base.unit, description: base.description }, current);
      const archived = input.archived === undefined ? current.archived : input.archived ? 1 : 0;
      db.prepare('UPDATE products SET name = ?, barcode = ?, code = ?, price = ?, cost = ?, options = ?, archived = ? WHERE id = ?')
        .run(f.name, f.barcode, f.code, f.price, f.cost, JSON.stringify(opts), archived, current.id);
      return getProduct(current.id);
    },

    // Создаёт модификации товара. variants — [{ options, price, cost, barcode, code, stock }].
    // barcodes: true — каждой модификации без штрихкода сгенерировать свой.
    // Остаток основного товара переходит в ноль: дальше остатки ведутся по модификациям.
    createVariants(id, { variants, barcodes = false }) {
      const base = getProduct(id);
      if (base.parent_id) throw new UserError('У модификации не может быть своих модификаций');
      if (!Array.isArray(variants) || !variants.length) throw new UserError('Добавьте хотя бы одну модификацию');
      if (variants.length > 300) throw new UserError('Слишком много модификаций за раз: не больше 300');
      return transaction(db, () => {
        const seen = new Set(childrenOf(base.id).map((k) => optionsKey(JSON.parse(k.options || '{}'))));
        // Основной товар больше не продаётся: его остаток и штрихкод переходят к модификациям.
        if (!seen.size) db.prepare("UPDATE products SET stock = 0, barcode = '' WHERE id = ?").run(base.id);
        const insert = db.prepare(`
          INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, description, parent_id, options, archived, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const created = [];
        for (const v of variants) {
          const opts = optionsOf(v.options);
          const key = optionsKey(opts);
          if (seen.has(key)) throw new UserError(`Модификация «${Object.values(opts).join(', ')}» уже есть`);
          seen.add(key);
          const price = round2(number(v.price ?? base.price, 'Цена продажи'));
          const cost = round2(number(v.cost ?? base.cost, 'Себестоимость'));
          const barcode = text(v.barcode, 'Штрихкод', { max: 64 }) || (barcodes ? newBarcode() : '');
          const { lastInsertRowid } = insert.run(variantName(base, opts), base.category, barcode, text(v.code, 'Код товара', { max: 64 }), base.unit,
            price, cost, number(v.stock ?? 0, 'Остаток'), base.description, base.id, JSON.stringify(opts), base.archived, Date.now());
          created.push(getProduct(lastInsertRowid));
        }
        return created;
      });
    },

    newBarcode,

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

    // user — кто пробил чек, customerId — покупатель из программы лояльности,
    // bonusSpend — сколько бонусов покупатель тратит (1 бонус = 1 сом).
    createSale({ items, payment, at, customerId, bonusSpend = 0 }, user = null) {
      if (!Array.isArray(items) || !items.length) throw new UserError('В чеке нет товаров');
      if (!['cash', 'card'].includes(payment)) throw new UserError('Выберите способ оплаты');
      return transaction(db, () => {
        const lines = items.map((item) => {
          const p = getProduct(item.productId);
          if (p.archived) throw new UserError(`Товар «${p.name}» убран из продажи`);
          if (childrenOf(p.id).length) throw new UserError(`У товара «${p.name}» есть модификации — выберите нужную`);
          const qty = number(item.qty, 'Количество', { positive: true });
          const price = round2(number(item.price ?? p.price, 'Цена'));
          return { p, qty, price };
        });
        const total = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
        const customer = customerId ? getCustomer(customerId) : null;
        const loyalty = this.loyalty();
        let spent = 0, earned = 0;
        if (customer && loyalty.enabled) {
          spent = round2(number(bonusSpend || 0, 'Списать бонусов'));
          const limit = Math.floor(total * loyalty.maxPay / 100);
          if (spent > customer.bonus) throw new UserError(`У покупателя только ${customer.bonus} бонусов`);
          if (spent > limit) throw new UserError(`Бонусами можно оплатить не больше ${loyalty.maxPay}% чека — ${limit} сом`);
          earned = Math.floor((total - spent) * loyalty.percent / 100);
        }
        const { lastInsertRowid: saleId } = db.prepare(`
          INSERT INTO sales (created_at, payment, total, user_id, user_name, customer_id, bonus_spent, bonus_earned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(at || Date.now(), payment, total, user?.id ?? null, user ? user.name || user.email : '', customer?.id ?? null, spent, earned);
        const addItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)');
        const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
        for (const l of lines) {
          addItem.run(saleId, l.p.id, l.p.name, l.qty, l.price, l.p.cost);
          takeStock.run(l.qty, l.p.id);
        }
        const who = user ? user.name || user.email : '';
        if (spent) changeBonus(customer.id, -spent, `Оплата чека №${saleId}`, who, saleId);
        if (earned) changeBonus(customer.id, earned, `Начислено за чек №${saleId}`, who, saleId);
        return { id: Number(saleId), total, paid: round2(total - spent), bonusSpent: spent, bonusEarned: earned,
          items: lines.map((l) => ({ name: l.p.name, qty: l.qty, price: l.price })), customer: customer && this.findCustomer(customer.id) };
      });
    },

    // Возврат: товар назад на склад, начисленные бонусы списываются, потраченные возвращаются.
    refundSale(id, user = null) {
      return transaction(db, () => {
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(id));
        if (!sale) throw new UserError('Чек не найден');
        if (sale.refunded_at) throw new UserError('По этому чеку уже оформлен возврат');
        db.prepare('UPDATE sales SET refunded_at = ? WHERE id = ?').run(Date.now(), sale.id);
        db.prepare(`UPDATE products SET stock = stock + (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = ? AND product_id = products.id)
                    WHERE id IN (SELECT product_id FROM sale_items WHERE sale_id = ?)`).run(sale.id, sale.id);
        if (sale.customer_id && (sale.bonus_spent || sale.bonus_earned)) {
          const c = getCustomer(sale.customer_id);
          // Если начисленные бонусы уже потрачены, баланс не уходит в минус.
          const delta = round2(Math.max(sale.bonus_spent - sale.bonus_earned, -c.bonus));
          if (delta) changeBonus(c.id, delta, `Возврат чека №${sale.id}`, user ? user.name || user.email : '', sale.id);
        }
        return { id: sale.id };
      });
    },

    // userId — показать только чеки этого сотрудника.
    listSales({ from, to, limit = 200, userId = null }) {
      const sales = db.prepare(`
        SELECT s.*, c.name AS customer_name, c.phone AS customer_phone FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.created_at >= ? AND s.created_at < ? AND (? IS NULL OR s.user_id = ?)
        ORDER BY s.created_at DESC LIMIT ?`).all(from, to, userId, userId, limit);
      const items = db.prepare('SELECT product_id, name, qty, price FROM sale_items WHERE sale_id = ?');
      return sales.map((s) => ({ ...s, items: items.all(s.id) }));
    },

    getSale(id) {
      return db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(id)) || null;
    },

    // Эффективность сотрудников за период. Оклад и план заданы на месяц и
    // пересчитываются на долю каждого календарного месяца в периоде: весь октябрь — ровно один оклад.
    kpi({ from, to }) {
      const months = monthsBetween(from, to);
      const rows = db.prepare(`
        SELECT s.user_id AS id,
          COUNT(CASE WHEN s.refunded_at IS NULL THEN 1 END) AS receipts,
          COALESCE(SUM(CASE WHEN s.refunded_at IS NULL THEN s.total END), 0) AS revenue,
          COUNT(s.refunded_at) AS refunds,
          COALESCE(SUM(CASE WHEN s.refunded_at IS NOT NULL THEN s.total END), 0) AS refunded,
          COUNT(CASE WHEN s.refunded_at IS NULL AND s.customer_id IS NOT NULL THEN 1 END) AS loyalty_receipts
        FROM sales s WHERE s.created_at >= ? AND s.created_at < ? GROUP BY s.user_id`).all(from, to);
      const profit = new Map(db.prepare(`
        SELECT s.user_id AS id, SUM(si.qty * (si.price - si.cost)) AS profit, SUM(si.qty) AS items
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ? GROUP BY s.user_id`).all(from, to).map((r) => [r.id, r]));
      const byDay = db.prepare(`
        SELECT s.user_id AS id, s.created_at AS t, s.total FROM sales s
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`).all(from, to);
      const stats = new Map(rows.map((r) => [r.id, r]));
      const users = db.prepare('SELECT * FROM users ORDER BY name, email').all();
      const result = users
        .filter((u) => stats.has(u.id) || (!u.disabled && can(u, 'pos')))
        .map((u) => ({ user: publicUser(u), ...stats.get(u.id) }));
      if (stats.has(null)) result.push({ user: null, ...stats.get(null) });
      return {
        from, to, months,
        staff: result.map((r) => {
          const revenue = r.revenue || 0;
          const salary = r.user ? round2(r.user.salary * months) : 0;
          const bonus = r.user ? round2(revenue * r.user.percent / 100) : 0;
          const plan = r.user ? round2(r.user.plan * months) : 0;
          const p = profit.get(r.user?.id ?? null);
          return {
            user: r.user,
            receipts: r.receipts || 0,
            revenue: round2(revenue),
            avg: r.receipts ? round2(revenue / r.receipts) : 0,
            profit: round2(p?.profit || 0),
            items: p?.items || 0,
            refunds: r.refunds || 0,
            refunded: round2(r.refunded || 0),
            loyaltyReceipts: r.loyalty_receipts || 0,
            plan,
            planDone: plan ? revenue / plan : null,
            salary,
            bonus,
            pay: round2(salary + bonus),
          };
        }),
        sales: byDay.map((x) => ({ u: x.id, t: x.t, s: x.total })),
      };
    },

    /* ---------- Покупатели и бонусы ---------- */

    loyalty() {
      const saved = JSON.parse(this.setting('loyalty', JSON.stringify(LOYALTY_DEFAULTS)));
      return { ...LOYALTY_DEFAULTS, ...saved };
    },

    setLoyalty(input) {
      const next = {
        enabled: Boolean(input.enabled),
        percent: number(input.percent, 'Начислять, %'),
        maxPay: number(input.maxPay, 'Оплата бонусами, %'),
      };
      if (next.percent > 100 || next.maxPay > 100) throw new UserError('Процент не может быть больше 100');
      this.setSetting('loyalty', JSON.stringify(next));
      return next;
    },

    listCustomers({ q = '', limit = 100 } = {}) {
      const digits = String(q).replace(/\D/g, '');
      const like = `%${String(q).trim()}%`;
      return db.prepare(`SELECT * FROM customers WHERE ? = '' OR name LIKE ? OR (? <> '' AND phone LIKE ?)
                         ORDER BY created_at DESC LIMIT ?`).all(String(q).trim(), like, digits, `%${digits}%`, limit);
    },

    // Рейтинг покупателей: сколько раз и на сколько покупали, когда впервые и в последний раз.
    customerRating() {
      return db.prepare(`
        SELECT c.*, COUNT(s.id) AS purchases, COALESCE(SUM(s.total), 0) AS spent,
          MIN(s.created_at) AS first_at, MAX(s.created_at) AS last_at
        FROM customers c LEFT JOIN sales s ON s.customer_id = c.id AND s.refunded_at IS NULL
        GROUP BY c.id ORDER BY spent DESC, c.created_at DESC LIMIT 5000`).all()
        .map((c) => ({ ...c, spent: round2(c.spent), avg: c.purchases ? round2(c.spent / c.purchases) : 0 }));
    },

    findCustomer(id) {
      return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id)) || null;
    },

    findCustomerByPhone(value) {
      return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone(value)) || null;
    },

    createCustomer(input) {
      const p = phone(input.phone);
      if (db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(p)) throw new UserError('Покупатель с таким телефоном уже есть');
      const { lastInsertRowid } = db.prepare('INSERT INTO customers (phone, name, created_at) VALUES (?, ?, ?)')
        .run(p, text(input.name, 'Имя', { max: 80 }), Date.now());
      return this.findCustomer(lastInsertRowid);
    },

    updateCustomer(id, input) {
      const c = getCustomer(id);
      const p = input.phone === undefined ? c.phone : phone(input.phone);
      const other = db.prepare('SELECT id FROM customers WHERE phone = ?').get(p);
      if (other && other.id !== c.id) throw new UserError('Покупатель с таким телефоном уже есть');
      db.prepare('UPDATE customers SET phone = ?, name = ? WHERE id = ?').run(p, input.name === undefined ? c.name : text(input.name, 'Имя', { max: 80 }), c.id);
      return this.findCustomer(c.id);
    },

    // Ручное изменение бонусов: delta — сколько добавить (или списать, если меньше нуля).
    adjustBonus(id, { delta, reason }, user = null) {
      const c = getCustomer(id);
      const d = round2(number(delta, 'Бонусы', { min: -Infinity }));
      if (!d) throw new UserError('Укажите, сколько бонусов добавить или списать');
      if (c.bonus + d < 0) throw new UserError(`Нельзя списать больше, чем есть: ${c.bonus}`);
      changeBonus(c.id, d, text(reason, 'Причина', { max: 200 }) || 'Изменено вручную', user ? user.name || user.email : '');
      return this.findCustomer(c.id);
    },

    bonusHistory(id) {
      getCustomer(id);
      return db.prepare('SELECT * FROM bonus_log WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(Number(id));
    },

    /* ---------- Фото товаров ---------- */

    setPhoto(id, { mime, data }) {
      const p = getProduct(id);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new UserError('Фото должно быть в формате JPEG, PNG или WebP');
      const bytes = Buffer.from(String(data || ''), 'base64');
      if (!bytes.length) throw new UserError('Файл фото пустой');
      if (bytes.length > 3e6) throw new UserError('Фото больше 3 МБ');
      db.prepare('INSERT INTO product_photos (product_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data')
        .run(p.id, mime, bytes);
      db.prepare('UPDATE products SET photo_at = ? WHERE id = ?').run(Date.now(), p.id);
      return getProduct(p.id);
    },

    getPhoto(id) {
      return db.prepare('SELECT mime, data FROM product_photos WHERE product_id = ?').get(Number(id)) || null;
    },

    deletePhoto(id) {
      const p = getProduct(id);
      db.prepare('DELETE FROM product_photos WHERE product_id = ?').run(p.id);
      db.prepare('UPDATE products SET photo_at = NULL WHERE id = ?').run(p.id);
      return getProduct(p.id);
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
      const products = db.prepare(`SELECT id, name, category, code, unit, stock, price, cost FROM products p WHERE archived = 0
        AND NOT EXISTS (SELECT 1 FROM products c WHERE c.parent_id = p.id AND c.deleted = 0)`).all()
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
      const pay = payFields(input);
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, role, password_hash, created_at, salary, percent, plan, rights) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e, text(input.name, 'Имя', { max: 80 }), role(input.role || 'cashier'), passwordHash, Date.now(), pay.salary, pay.percent, pay.plan, rightsList(input.rights ?? null));
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
      const pay = payFields(input, current);
      const other = this.findUserByEmail(next.email);
      if (other && other.id !== current.id) throw new UserError('Сотрудник с таким email уже есть');
      if (current.role === 'admin' && !current.disabled && (next.role !== 'admin' || next.disabled) && this.activeAdmins() <= 1) {
        throw new UserError('Это единственный администратор. Сначала назначьте другого.');
      }
      const rights = input.rights === undefined ? current.rights : rightsList(input.rights);
      db.prepare('UPDATE users SET email = ?, name = ?, role = ?, disabled = ?, password_hash = ?, salary = ?, percent = ?, plan = ?, rights = ? WHERE id = ?')
        .run(next.email, next.name, next.role, next.disabled, passwordHash || current.password_hash, pay.salary, pay.percent, pay.plan, rights, current.id);
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

    // Администратор из переменных ADMIN_EMAIL и ADMIN_PASSWORD. Пароль записывается, когда сотрудника
    // ещё нет или когда пароль в переменной поменяли (fingerprint — отпечаток пары email и пароля):
    // так пароль, сменённый в программе, не сбрасывается при каждом перезапуске сервера.
    ensureAdmin(adminEmail, makeHash, fingerprint) {
      const e = email(adminEmail);
      const current = this.findUserByEmail(e);
      const applied = db.prepare("SELECT value FROM settings WHERE key = 'admin_env'").get()?.value;
      let user;
      if (!current) user = this.createUser({ email: e, name: 'Администратор', role: 'admin' }, makeHash());
      else {
        const hash = applied === fingerprint ? current.password_hash : makeHash();
        db.prepare("UPDATE users SET role = 'admin', disabled = 0, password_hash = ? WHERE id = ?").run(hash, current.id);
        user = publicUser(this.findUser(current.id));
      }
      this.setSetting('admin_env', fingerprint);
      return user;
    },

    publicUser,

    /* ---------- Оформление программы ---------- */

    design() {
      return { ...DESIGN_DEFAULTS, ...JSON.parse(this.setting('design', '{}')) };
    },

    setDesign(input) {
      const radius = number(input.radius ?? 10, 'Скругление');
      const next = {
        name: text(input.name, 'Название', { max: 60 }) || DESIGN_DEFAULTS.name,
        accent: color(input.accent, 'Основной'),
        bg: color(input.bg, 'Фон', { optional: true }),
        surface: color(input.surface, 'Панели', { optional: true }),
        ink: color(input.ink, 'Текст', { optional: true }),
        font: FONTS.includes(input.font) ? input.font : 'system',
        radius: Math.min(radius, 30),
        theme: ['auto', 'light', 'dark'].includes(input.theme) ? input.theme : 'auto',
        css: css(input.css),
      };
      this.setSetting('design', JSON.stringify(next));
      return next;
    },

    /* ---------- Картинки витрины (баннер, логотип) ---------- */

    addImage({ mime, data }) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new UserError('Картинка должна быть в формате JPEG, PNG или WebP');
      const bytes = Buffer.from(String(data || ''), 'base64');
      if (!bytes.length) throw new UserError('Файл пустой');
      if (bytes.length > 4e6) throw new UserError('Картинка больше 4 МБ');
      const { lastInsertRowid } = db.prepare('INSERT INTO images (mime, data, created_at) VALUES (?, ?, ?)').run(mime, bytes, Date.now());
      return { id: Number(lastInsertRowid) };
    },

    getImage(id) {
      return db.prepare('SELECT mime, data FROM images WHERE id = ?').get(Number(id)) || null;
    },

    /* ---------- Интернет-витрина ---------- */

    shop() {
      return { ...SHOP_DEFAULTS, ...JSON.parse(this.setting('shop', '{}')) };
    },

    setShop(input) {
      const cur = this.shop();
      const v = { ...cur, ...input };
      const t = (k, f, max = 200) => text(v[k], f, { max });
      const imageId = (x) => (x ? (this.getImage(x) ? Number(x) : null) : null);
      const next = {
        enabled: Boolean(v.enabled),
        // Созданная витрина остаётся в конструкторе, даже когда её закрыли для покупателей.
        created: Boolean(cur.created || v.created || v.enabled),
        template: String(v.template || 'light').slice(0, 30),
        title: t('title', 'Название витрины', 80) || 'Мой магазин',
        slogan: t('slogan', 'Подзаголовок'),
        about: t('about', 'О магазине', 3000),
        phone: t('phone', 'Телефон', 40),
        address: t('address', 'Адрес'),
        hours: t('hours', 'Часы работы'),
        whatsapp: t('whatsapp', 'WhatsApp', 40),
        telegram: t('telegram', 'Telegram', 60).replace(/^@/, ''),
        accent: color(v.accent, 'Основной'),
        bg: color(v.bg, 'Фон'),
        surface: color(v.surface, 'Карточки'),
        ink: color(v.ink, 'Текст'),
        font: FONTS.includes(v.font) ? v.font : 'system',
        radius: Math.min(number(v.radius, 'Скругление'), 40),
        columns: Math.max(1, Math.min(6, Math.round(number(v.columns, 'Колонки', { positive: true })))),
        cardStyle: ['photo', 'compact', 'list'].includes(v.cardStyle) ? v.cardStyle : 'photo',
        showStock: Boolean(v.showStock),
        hideOutOfStock: Boolean(v.hideOutOfStock),
        delivery: Boolean(v.delivery),
        pickup: Boolean(v.pickup),
        minOrder: round2(number(v.minOrder || 0, 'Минимальный заказ')),
        deliveryPrice: round2(number(v.deliveryPrice || 0, 'Стоимость доставки')),
        categories: Array.isArray(v.categories) ? v.categories.map((c) => String(c).slice(0, 200)).slice(0, 500) : [],
        bannerId: imageId(v.bannerId),
        logoId: imageId(v.logoId),
        css: css(v.css),
      };
      if (!next.delivery && !next.pickup) throw new UserError('Включите доставку или самовывоз');
      this.setSetting('shop', JSON.stringify(next));
      return next;
    },

    // Товары для витрины: только нужные покупателю поля, без себестоимости.
    shopProducts() {
      const s = this.shop();
      const cats = new Set(s.categories);
      const all = db.prepare('SELECT id, name, category, unit, price, stock, description, photo_at, parent_id, options FROM products WHERE archived = 0 AND deleted = 0 ORDER BY category, name COLLATE NOCASE').all();
      const kids = new Map();
      for (const p of all) if (p.parent_id) kids.set(p.parent_id, [...(kids.get(p.parent_id) || []), p]);
      const shown = (p) => p.price > 0 && (!s.hideOutOfStock || p.stock > 0);
      const out = [];
      for (const p of all) {
        if (p.parent_id || (cats.size && !cats.has(p.category))) continue;
        const variants = (kids.get(p.id) || []).filter(shown);
        // Основной товар с модификациями показывается карточкой, если хоть одна модификация продаётся.
        if (kids.has(p.id) ? !variants.length : !shown(p)) continue;
        out.push(p, ...variants);
      }
      return out.map((p) => ({
        ...p, options: p.options ? JSON.parse(p.options) : null, hasVariants: kids.has(p.id),
        stock: s.showStock ? Math.max(0, p.stock) : p.stock > 0 ? 1 : 0, photo: Boolean(p.photo_at),
      }));
    },

    shopPhotoAllowed(id) {
      return this.shopProducts().some((p) => p.id === Number(id) && p.photo);
    },

    createOrder(input) {
      const s = this.shop();
      if (!s.enabled) throw new UserError('Витрина сейчас закрыта');
      const available = new Map(this.shopProducts().filter((p) => !p.hasVariants).map((p) => [p.id, p]));
      if (!Array.isArray(input.items) || !input.items.length) throw new UserError('Корзина пуста');
      if (input.items.length > 200) throw new UserError('Слишком много позиций в заказе');
      const lines = input.items.map((i) => {
        const p = available.get(Number(i.productId));
        if (!p) throw new UserError('Одного из товаров уже нет в продаже. Обновите страницу.');
        return { p, qty: number(i.qty, 'Количество', { positive: true }) };
      });
      const delivery = input.delivery === 'delivery' ? 'delivery' : 'pickup';
      if (delivery === 'delivery' ? !s.delivery : !s.pickup) throw new UserError('Этот способ получения недоступен');
      const goods = round2(lines.reduce((sum, l) => sum + l.qty * l.p.price, 0));
      if (goods < s.minOrder) throw new UserError(`Минимальная сумма заказа — ${s.minOrder} сом`);
      const total = round2(goods + (delivery === 'delivery' ? s.deliveryPrice : 0));
      const address = text(input.address, 'Адрес', { max: 300 });
      if (delivery === 'delivery' && !address) throw new UserError('Укажите адрес доставки');
      return transaction(db, () => {
        const { lastInsertRowid: id } = db.prepare('INSERT INTO orders (created_at, name, phone, comment, delivery, address, total) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(Date.now(), text(input.name, 'Имя', { required: true, max: 80 }), phone(input.phone), text(input.comment, 'Комментарий', { max: 1000 }), delivery, address, total);
        const add = db.prepare('INSERT INTO order_items (order_id, product_id, name, qty, price) VALUES (?, ?, ?, ?, ?)');
        for (const l of lines) add.run(id, l.p.id, l.p.name, l.qty, l.p.price);
        return this.getOrder(id);
      });
    },

    getOrder(id) {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
      if (!o) throw new UserError('Заказ не найден');
      return { ...o, items: db.prepare('SELECT product_id, name, qty, price FROM order_items WHERE order_id = ?').all(o.id) };
    },

    listOrders({ status = '' } = {}) {
      const rows = db.prepare(`SELECT id FROM orders WHERE ? = '' OR status = ? ORDER BY created_at DESC LIMIT 300`).all(status, status);
      return rows.map((r) => this.getOrder(r.id));
    },

    // Статусы: new — новый, confirmed — подтверждён, ready — собран, done — выдан, cancelled — отменён.
    // При выдаче заказ пробивается чеком: товар списывается, выручка идёт тому, кто выдал.
    setOrderStatus(id, { status, payment }, user = null) {
      const o = this.getOrder(id);
      if (!['new', 'confirmed', 'ready', 'done', 'cancelled'].includes(status)) throw new UserError('Неизвестный статус');
      if (o.status === 'done' || o.status === 'cancelled') throw new UserError('Заказ уже закрыт');
      return transaction(db, () => {
        let saleId = null;
        if (status === 'done') {
          // Покупатель с витрины попадает в программу лояльности по телефону: так его покупки видны в рейтинге.
          const customer = this.findCustomerByPhone(o.phone) || this.createCustomer({ phone: o.phone, name: o.name });
          saleId = this.createSale({ payment: payment === 'cash' ? 'cash' : 'card', customerId: customer.id, items: o.items.map((i) => ({ productId: i.product_id, qty: i.qty, price: i.price })) }, user).id;
        }
        db.prepare('UPDATE orders SET status = ?, updated_at = ?, updated_by = ?, sale_id = COALESCE(?, sale_id) WHERE id = ?')
          .run(status, Date.now(), user ? user.name || user.email : '', saleId, o.id);
        return this.getOrder(o.id);
      });
    },

    countNewOrders() {
      return db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").get().n;
    },

    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },

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
