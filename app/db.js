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
  // Способы оплаты: наличные, МБАНК, Оптима и всё, что заведёт владелец. kind — тип: cash, card, transfer, qr, other.
  // У чека — ссылка на способ и его название на момент продажи (чтобы переименование не меняло историю).
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'card',
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare('SELECT COUNT(*) AS n FROM payment_methods').get().n) {
    db.prepare("INSERT INTO payment_methods (name, kind, sort, created_at) VALUES ('Наличные', 'cash', 1, ?), ('Карта', 'card', 2, ?)").run(Date.now(), Date.now());
  }
  addColumns('sales', [['method_id', 'INTEGER'], ['method_name', "TEXT NOT NULL DEFAULT ''"]]);
  // Чеки из прошлых версий: «наличными» и «картой» → первые способы этих типов.
  for (const [payment, kind] of [['cash', 'cash'], ['card', 'card']]) {
    const m = db.prepare('SELECT * FROM payment_methods WHERE kind = ? ORDER BY sort, id LIMIT 1').get(kind);
    if (m) db.prepare('UPDATE sales SET method_id = ?, method_name = ? WHERE method_id IS NULL AND payment = ?').run(m.id, m.name, payment);
  }
  // Личный список способов оплаты сотрудника (JSON id) или NULL — все включённые.
  // max_discount — сколько процентов скидки на чек может дать сотрудник (NULL — без ограничения).
  addColumns('users', [['payment_methods', 'TEXT'], ['max_discount', 'REAL']]);
  // plan_bonus — премия в сомах за выполнение месячного плана продаж.
  addColumns('users', [['plan_bonus', 'REAL NOT NULL DEFAULT 0']]);
  // Штрафы и бонусы сотрудникам — одна таблица: kind 'fine' уменьшает зарплату, 'bonus' увеличивает.
  addColumns('fines', [['kind', "TEXT NOT NULL DEFAULT 'fine'"]]);
  // Ручные исправления ведомости за конкретный период: field — 'salary' (за смены и оклад),
  // 'bonus' (% от продаж) или 'pay' (итог к выплате). Действуют, когда отчёт открыт ровно за этот период.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pay_overrides (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      period_from INTEGER NOT NULL,
      period_to INTEGER NOT NULL,
      field TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, period_from, period_to, field)
    );
  `);
  // Комиссия банка в процентах для способа оплаты (М-Банк, эквайринг…).
  addColumns('payment_methods', [['commission', 'REAL NOT NULL DEFAULT 0']]);
  // Оплата чека частями: наличные + карта и т.д. У каждой части — способ, сумма и удержанная комиссия.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_payments (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      method_id INTEGER,
      method_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'card',
      amount REAL NOT NULL,
      commission REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sale_payments_sale ON sale_payments(sale_id);
  `);
  // Чеки до смешанной оплаты: одна часть на всю сумму, оплаченную деньгами.
  db.exec(`INSERT INTO sale_payments (sale_id, method_id, method_name, kind, amount)
    SELECT s.id, s.method_id, COALESCE(NULLIF(s.method_name, ''), CASE s.payment WHEN 'cash' THEN 'Наличные' ELSE 'Карта' END),
      CASE s.payment WHEN 'cash' THEN 'cash' ELSE 'card' END, s.total - s.bonus_spent
    FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)`);

  // Справочник категорий. Товар хранит название категории, справочник — картинку и порядок на витрине.
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      image_id INTEGER,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  // Дни рождения и скидка в день рождения, оплата за смену.
  addColumns('customers', [['birthday', "TEXT NOT NULL DEFAULT ''"], ['birthday_used', 'INTEGER']]);
  addColumns('sales', [['discount', 'REAL NOT NULL DEFAULT 0'], ['discount_reason', "TEXT NOT NULL DEFAULT ''"], ['shift_id', 'INTEGER']]);
  addColumns('users', [['shift_rate', 'REAL NOT NULL DEFAULT 0']]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      note TEXT NOT NULL DEFAULT '',
      edited_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS shifts_user ON shifts(user_id, opened_at);
    CREATE TABLE IF NOT EXISTS fines (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      at INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fines_at ON fines(at);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      user_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
  `);
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
// Комиссия банков по чеку s и доля строки si в ней (по стоимости строки) — вычитается из выручки и прибыли.
const SALE_FEE = '(SELECT COALESCE(SUM(sp.commission), 0) FROM sale_payments sp WHERE sp.sale_id = s.id)';
const LINE_FEE = `(CASE WHEN s.total > 0 THEN si.qty * si.price * ${SALE_FEE} / s.total ELSE 0 END)`;

const publicUser = ({ password_hash, ...u }) => ({ ...u, disabled: Boolean(u.disabled), rights: u.rights ? JSON.parse(u.rights) : null,
  payment_methods: u.payment_methods ? JSON.parse(u.payment_methods) : null });

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

// birthdayDiscount — скидка в % в день рождения, birthdayDays — сколько дней до и после он действует.
// Скидка даётся один раз в год.
const PAYMENT_KINDS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', qr: 'QR-код', other: 'Другое' };

const LOYALTY_DEFAULTS = { enabled: true, percent: 5, maxPay: 30, birthdayDiscount: 10, birthdayDays: 3 };

// Дата рождения как ДД.ММ.ГГГГ, ДД.ММ или ГГГГ-ММ-ДД → 'ГГГГ-ММ-ДД' (год 0000, если не указан).
function birthday(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let d, m, y;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/))) [, d, m, y] = mt;
  else throw new UserError('Дата рождения указана неверно. Пример: 15.03.1990');
  d = Number(d); m = Number(m); y = y ? Number(y.length === 2 ? (Number(y) > 30 ? '19' : '20') + y : y) : 0;
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]) throw new UserError('Такой даты не бывает');
  if (y && (y < 1900 || y > new Date().getFullYear())) throw new UserError('Год рождения указан неверно');
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Сколько дней до ближайшего дня рождения (отрицательное — уже прошёл, в пределах полугода).
function daysToBirthday(bday, now = Date.now()) {
  if (!bday) return null;
  const [, m, d] = bday.split('-').map(Number);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let best = null;
  for (const year of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    // 29 февраля в невисокосный год празднуют 28-го.
    const day = new Date(year, m - 1, d);
    if (day.getMonth() !== m - 1) day.setDate(0);
    const diff = Math.round((day - today) / 864e5);
    if (best === null || Math.abs(diff) < Math.abs(best)) best = diff;
  }
  return best;
}

// Оформление программы. Цвета — #rrggbb, остальное проверяется в setDesign.
const DESIGN_DEFAULTS = { name: 'Мой магазин', accent: '#5b5bf6', bg: '', surface: '', ink: '', font: 'system', radius: 14, theme: 'auto', css: '' };

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

  // Категория по названию без учёта регистра. Сравниваем здесь, а не в SQLite: его NOCASE не знает кириллицу.
  const findCategory = (name) => {
    const key = String(name ?? '').trim().toLowerCase();
    return key ? db.prepare('SELECT * FROM categories').all().find((c) => c.name.toLowerCase() === key) || null : null;
  };
  // «бакалея» в карточке товара становится уже заведённой «Бакалеей».
  const canonicalCategory = (name) => findCategory(name)?.name ?? name;

  const productFields = (input, current = {}) => ({
    name: text(input.name ?? current.name, 'Название', { required: true }),
    category: canonicalCategory(text(input.category ?? current.category, 'Категория')),
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
      shift_rate: round2(number(input.shift_rate ?? current.shift_rate ?? 0, 'Оплата за смену')),
      salary: round2(number(input.salary ?? current.salary ?? 0, 'Оклад')),
      percent,
      plan: round2(number(input.plan ?? current.plan ?? 0, 'План продаж')),
      plan_bonus: round2(number(input.plan_bonus ?? current.plan_bonus ?? 0, 'Бонус за план')),
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

    /* ---------- Способы оплаты ---------- */

    paymentKinds: PAYMENT_KINDS,

    listPaymentMethods({ all = false } = {}) {
      return db.prepare(`SELECT * FROM payment_methods ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all().map((m) => ({ ...m, active: Boolean(m.active) }));
    },

    // Способы, которыми этот сотрудник может принимать оплату. Без входа — все включённые.
    allowedPaymentMethods(user) {
      const active = this.listPaymentMethods();
      const own = user?.payment_methods ? JSON.parse(user.payment_methods) : null;
      return Array.isArray(own) && user.role !== 'admin' ? active.filter((m) => own.includes(m.id)) : active;
    },

    // Способ оплаты для чека: по id или, для старых запросов, первый способ нужного типа.
    paymentMethodFor(methodId, payment, user) {
      const allowed = this.allowedPaymentMethods(user ? this.findUser(user.id) : null);
      const m = methodId ? allowed.find((x) => x.id === Number(methodId))
        : allowed.find((x) => (payment === 'cash' ? x.kind === 'cash' : x.kind !== 'cash'));
      if (!m) {
        const exists = methodId && db.prepare('SELECT name, active FROM payment_methods WHERE id = ?').get(Number(methodId));
        throw new UserError(exists ? (exists.active ? `У вас нет доступа к оплате «${exists.name}»` : `Способ «${exists.name}» выключен`) : 'Выберите способ оплаты');
      }
      return m;
    },

    savePaymentMethod(id, input) {
      const name = text(input.name, 'Название', { required: true, max: 60 });
      const kind = Object.hasOwn(PAYMENT_KINDS, input.kind) ? input.kind : 'card';
      const clash = db.prepare('SELECT id, name FROM payment_methods').all().find((m) => m.id !== Number(id) && m.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new UserError('Такой способ оплаты уже есть');
      if (id) {
        const cur = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(id));
        if (!cur) throw new UserError('Способ оплаты не найден');
        const active = input.active === undefined ? cur.active : input.active ? 1 : 0;
        if (!active && db.prepare('SELECT COUNT(*) AS n FROM payment_methods WHERE active = 1 AND id <> ?').get(cur.id).n === 0) {
          throw new UserError('Должен остаться хотя бы один включённый способ оплаты');
        }
        const commission = input.commission === undefined ? cur.commission : number(input.commission || 0, 'Комиссия, %');
        if (commission > 50) throw new UserError('Комиссия больше 50% — проверьте число');
        db.prepare('UPDATE payment_methods SET name = ?, kind = ?, active = ?, commission = ? WHERE id = ?').run(name, kind, active, commission, cur.id);
        return db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(cur.id);
      }
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM payment_methods').get().m ?? 0) + 1;
      const commission = number(input.commission || 0, 'Комиссия, %');
      if (commission > 50) throw new UserError('Комиссия больше 50% — проверьте число');
      const { lastInsertRowid } = db.prepare('INSERT INTO payment_methods (name, kind, sort, created_at, commission) VALUES (?, ?, ?, ?, ?)').run(name, kind, sort, Date.now(), commission);
      return db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(lastInsertRowid);
    },

    sortPaymentMethods(ids) {
      if (!Array.isArray(ids)) throw new UserError('Порядок передан неверно');
      const st = db.prepare('UPDATE payment_methods SET sort = ? WHERE id = ?');
      transaction(db, () => ids.forEach((id, i) => st.run(i + 1, Number(id))));
      return this.listPaymentMethods({ all: true });
    },

    // Сколько денег пришло каждым способом оплаты за период (без чеков с возвратом).
    // money — деньгами (без части, оплаченной бонусами), total — сумма чеков.
    reportPayments({ from, to }) {
      return db.prepare(`
        SELECT sp.method_id AS id, sp.method_name AS name, sp.kind, COUNT(DISTINCT s.id) AS receipts,
          SUM(sp.amount) AS money, SUM(sp.commission) AS commission, COALESCE(m.commission, 0) AS rate
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id LEFT JOIN payment_methods m ON m.id = sp.method_id
        WHERE s.created_at >= ? AND s.created_at < ? AND s.refunded_at IS NULL
        GROUP BY sp.method_id, sp.method_name ORDER BY money DESC`).all(from, to)
        .map((r) => ({ ...r, money: round2(r.money), commission: round2(r.commission), net: round2(r.money - r.commission) }));
    },

    /* ---------- Категории ---------- */

    // Категории из справочника плюс те, что вписаны у товаров, но ещё не заведены (досоздаются).
    listCategories() {
      const add = db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)');
      for (const { category } of db.prepare("SELECT DISTINCT category FROM products WHERE category <> '' AND deleted = 0").all()) add.run(category, Date.now());
      return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name AND p.parent_id IS NULL AND p.deleted = 0) AS count
        FROM categories c ORDER BY c.sort, c.name COLLATE NOCASE`).all();
    },

    getCategory(id) {
      const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id));
      if (!c) throw new UserError('Категория не найдена');
      return c;
    },

    createCategory(input) {
      const name = text(input.name, 'Название категории', { required: true, max: 200 });
      if (findCategory(name)) throw new UserError('Такая категория уже есть');
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM categories').get().m ?? 0) + 1;
      const { lastInsertRowid } = db.prepare('INSERT INTO categories (name, sort, created_at) VALUES (?, ?, ?)').run(name, sort, Date.now());
      return this.getCategory(lastInsertRowid);
    },

    // Переименование: товары (и модификации) и фильтр категорий витрины переходят на новое название.
    // Если такая категория уже есть — категории объединяются.
    renameCategory(id, input) {
      const cur = this.getCategory(id);
      const name = text(input.name, 'Название категории', { required: true, max: 200 });
      if (name === cur.name) return cur;
      return transaction(db, () => {
        const found = findCategory(name);
        const other = found && found.id !== cur.id ? found : null;
        db.prepare('UPDATE products SET category = ? WHERE category = ?').run(other ? other.name : name, cur.name);
        if (other) {
          if (!other.image_id && cur.image_id) db.prepare('UPDATE categories SET image_id = ? WHERE id = ?').run(cur.image_id, other.id);
          db.prepare('DELETE FROM categories WHERE id = ?').run(cur.id);
        } else {
          db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, cur.id);
        }
        this.renameShopCategory(cur.name, other ? other.name : name);
        return this.getCategory(other ? other.id : cur.id);
      });
    },

    // Удаление: товары переходят в moveTo (другую категорию) или остаются без категории.
    deleteCategory(id, { moveTo = '' } = {}) {
      const cur = this.getCategory(id);
      const target = canonicalCategory(text(moveTo, 'Куда перенести', { max: 200 }));
      if (target.toLowerCase() === cur.name.toLowerCase()) throw new UserError('Выберите другую категорию');
      return transaction(db, () => {
        if (target && !findCategory(target)) db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').run(target, Date.now());
        const { changes } = db.prepare('UPDATE products SET category = ? WHERE category = ?').run(target, cur.name);
        db.prepare('DELETE FROM categories WHERE id = ?').run(cur.id);
        this.renameShopCategory(cur.name, target);
        return { moved: changes, to: target };
      });
    },

    setCategoryImage(id, imageId) {
      const cur = this.getCategory(id);
      if (imageId && !this.getImage(imageId)) throw new UserError('Картинка не найдена');
      db.prepare('UPDATE categories SET image_id = ? WHERE id = ?').run(imageId ? Number(imageId) : null, cur.id);
      return this.getCategory(cur.id);
    },

    // Порядок категорий на витрине: ids — в нужном порядке.
    sortCategories(ids) {
      if (!Array.isArray(ids)) throw new UserError('Порядок передан неверно');
      const st = db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
      transaction(db, () => ids.forEach((id, i) => st.run(i + 1, Number(id))));
      return this.listCategories();
    },

    // Витрина показывает выбранные категории по названию — переименование и удаление переносим туда.
    renameShopCategory(from, to) {
      const shop = this.shop();
      if (!shop.categories?.length) return;
      const next = [...new Set(shop.categories.map((c) => (c === from ? to : c)).filter(Boolean))];
      this.setSetting('shop', JSON.stringify({ ...shop, categories: next }));
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
            const c = canonicalCategory(text(value, 'Категория'));
            if (c && !findCategory(c)) db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').run(c, Date.now());
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

    // Продажа.
    //   items — [{ productId, qty, discount: { type: 'pct' | 'sum', value } }] — скидка на строку;
    //   checkDiscount — { type, value } — скидка на весь чек (делится по строкам пропорционально);
    //   payments — [{ methodId, amount }] — оплата частями (наличные + карта); без неё — methodId на всю сумму;
    //   customerId, bonusSpend, birthday — программа лояльности.
    // Цены берёт сервер: из справочника, а при выдаче заказа — из заказа (trustPrices).
    // Скидки кассира требуют права «Скидки на кассе» и не больше max_discount % от чека.
    createSale({ items, payment, methodId, payments, at, customerId, bonusSpend = 0, birthday: useBirthday = false, checkDiscount }, user = null, { trustPrices = false } = {}) {
      if (!Array.isArray(items) || !items.length) throw new UserError('В чеке нет товаров');
      const staff = user ? this.findUser(user.id) : null;
      return transaction(db, () => {
        const lines = items.map((item) => {
          const p = getProduct(item.productId);
          if (p.archived) throw new UserError(`Товар «${p.name}» убран из продажи`);
          if (childrenOf(p.id).length) throw new UserError(`У товара «${p.name}» есть модификации — выберите нужную`);
          const qty = number(item.qty, 'Количество', { positive: true });
          const price = round2(trustPrices ? number(item.price ?? p.price, 'Цена') : p.price);
          return { p, qty, price, full: price, discount: item.discount };
        });
        const sum = () => round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
        // Цена со скидкой хранится с 4 знаками: 3 шт. со скидкой 100 сом дают ровно 2900, а не 2900,01.
        const r4 = (v) => Math.round(v * 1e4) / 1e4;
        const full = sum();
        const customer = customerId ? this.findCustomer(customerId) : null;
        if (customerId && !customer) throw new UserError('Покупатель не найден');
        const reasons = [];
        // Скидка именинника уменьшает цену каждой строки: так выручка и прибыль в отчётах сходятся с чеком.
        if (useBirthday && customer?.birthdayDiscount) {
          for (const l of lines) l.price = r4(l.price * (1 - customer.birthdayDiscount / 100));
          reasons.push(`день рождения ${customer.birthdayDiscount}%`);
          db.prepare('UPDATE customers SET birthday_used = ? WHERE id = ?').run(new Date().getFullYear(), customer.id);
        }
        const afterBirthday = sum();
        // Скидки кассира: сначала на строки, потом на весь чек.
        const discountOf = (d, base, what) => {
          if (!d || !Number(d.value)) return 0;
          const v = number(d.value, `Скидка на ${what}`);
          if (d.type === 'pct') {
            if (v > 100) throw new UserError('Скидка не может быть больше 100%');
            return base * v / 100;
          }
          if (v > base) throw new UserError(`Скидка на ${what} больше его суммы`);
          return v;
        };
        for (const l of lines) {
          // type 'price' — кассир указал новую цену за единицу.
          const d = l.discount?.type === 'price' && l.discount.value !== '' && l.discount.value != null
            ? { type: 'sum', value: round2((l.price - number(l.discount.value, `Цена «${l.p.name}»`, { min: 0 })) * l.qty) } : l.discount;
          if (d?.type === 'sum' && d.value < 0) throw new UserError(`Новая цена «${l.p.name}» выше обычной — поднимать цену на кассе нельзя`);
          const off = discountOf(d, l.qty * l.price, `«${l.p.name}»`);
          if (off) {
            reasons.push(`${l.p.name}: ${l.discount.type === 'price' ? `цена ${round2(l.discount.value)} вместо ${round2(l.price)}` : `−${d.type === 'pct' ? `${d.value}%` : `${round2(off)} сом`}`}`);
            l.price = r4((l.qty * l.price - off) / l.qty);
          }
        }
        const sub = sum();
        const checkOff = discountOf(checkDiscount, sub, 'чек');
        if (checkOff && sub > 0) {
          const k = (sub - checkOff) / sub;
          for (const l of lines) l.price = r4(l.price * k);
          reasons.push(`на чек −${checkDiscount.type === 'pct' ? `${checkDiscount.value}%` : `${round2(checkOff)} сом`}`);
        }
        const total = sum();
        const manual = round2(afterBirthday - total);
        if (manual > 0.009) {
          if (!can(staff, 'discount')) throw new UserError('У вас нет права давать скидку');
          const limit = staff?.max_discount;
          if (limit != null && manual > afterBirthday * limit / 100 + 0.01) {
            throw new UserError(`Скидка больше разрешённой: можно не больше ${limit}% от чека — ${round2(afterBirthday * limit / 100)} сом`);
          }
        }
        const discount = round2(full - total);

        const loyalty = this.loyalty();
        let spent = 0, earned = 0;
        if (customer && loyalty.enabled) {
          spent = round2(number(bonusSpend || 0, 'Списать бонусов'));
          const limit = Math.floor(total * loyalty.maxPay / 100);
          if (spent > customer.bonus) throw new UserError(`У покупателя только ${customer.bonus} бонусов`);
          if (spent > limit) throw new UserError(`Бонусами можно оплатить не больше ${loyalty.maxPay}% чека — ${limit} сом`);
          earned = Math.floor((total - spent) * loyalty.percent / 100);
        }
        const paid = round2(total - spent);

        // Оплата: частями или одним способом на всю сумму. Части должны сойтись с суммой к оплате.
        // Часть без суммы (amount пустой) получает остаток — так копейки округления не мешают пробить чек.
        let parts = [{ method: this.paymentMethodFor(methodId, payment, user), amount: paid }];
        if (Array.isArray(payments) && payments.length) {
          parts = payments.map((x) => ({ method: this.paymentMethodFor(x.methodId, null, user),
            amount: x.amount === null || x.amount === undefined || x.amount === '' ? null : round2(number(x.amount, 'Сумма оплаты', { min: 0 })) }));
          const open = parts.filter((x) => x.amount === null);
          if (open.length > 1) throw new UserError('Укажите сумму для всех способов, кроме одного');
          if (open.length) {
            open[0].amount = round2(paid - parts.reduce((s, x) => s + (x.amount || 0), 0));
            if (open[0].amount < 0) throw new UserError(`Части оплаты больше суммы к оплате (${paid} сом)`);
          }
          parts = parts.filter((x) => x.amount > 0);
        }
        if (!parts.length) parts.push({ method: this.paymentMethodFor(methodId, payment, user), amount: 0 });
        const given = round2(parts.reduce((s, x) => s + x.amount, 0));
        if (Math.abs(given - paid) > 0.01) throw new UserError(`Части оплаты (${given} сом) не сходятся с суммой к оплате (${paid} сом)`);
        for (const x of parts) x.commission = round2(x.amount * (x.method.commission || 0) / 100);
        const main = parts.reduce((a, x) => (x.amount > a.amount ? x : a), parts[0]);
        const names = [...new Set(parts.map((x) => x.method.name))].join(' + ');

        const { lastInsertRowid: saleId } = db.prepare(`
          INSERT INTO sales (created_at, payment, total, user_id, user_name, customer_id, bonus_spent, bonus_earned, discount, discount_reason, shift_id, method_id, method_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(at || Date.now(), parts.every((x) => x.method.kind === 'cash') ? 'cash' : 'card', total, user?.id ?? null, user ? user.name || user.email : '',
            customer?.id ?? null, spent, earned, discount, reasons.join('; '), user ? this.currentShift(user.id)?.id ?? null : null, main.method.id, names);
        const addPart = db.prepare('INSERT INTO sale_payments (sale_id, method_id, method_name, kind, amount, commission) VALUES (?, ?, ?, ?, ?, ?)');
        for (const x of parts) addPart.run(saleId, x.method.id, x.method.name, x.method.kind, x.amount, x.commission);
        const addItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)');
        const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
        for (const l of lines) {
          addItem.run(saleId, l.p.id, l.p.name, l.qty, l.price, l.p.cost);
          takeStock.run(l.qty, l.p.id);
        }
        const who = user ? user.name || user.email : '';
        if (spent) changeBonus(customer.id, -spent, `Оплата чека №${saleId}`, who, saleId);
        if (earned) changeBonus(customer.id, earned, `Начислено за чек №${saleId}`, who, saleId);
        return { id: Number(saleId), method: names, total, paid, bonusSpent: spent, bonusEarned: earned, discount, discountReason: reasons.join('; '),
          payments: parts.map((x) => ({ name: x.method.name, amount: x.amount, commission: x.commission })),
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

    // Удаление продаж: ids — выбранные чеки, from/to — все за период, all — все за всё время.
    // Бонусы по удалённому чеку отменяются (будто покупки не было), restock — вернуть товар на склад.
    // По чекам с возвратом товар уже вернулся, поэтому их остаток не трогаем. dryRun — только посчитать.
    deleteSales({ ids, from, to, all = false, restock = true, dryRun = false }, user = null) {
      let rows;
      if (Array.isArray(ids)) {
        if (!ids.length) throw new UserError('Выберите чеки');
        if (ids.length > 5000) throw new UserError('Слишком много чеков за раз');
        const get = db.prepare('SELECT * FROM sales WHERE id = ?');
        rows = ids.map((id) => get.get(Number(id))).filter(Boolean);
      } else if (all) {
        rows = db.prepare('SELECT * FROM sales').all();
      } else {
        const f = number(from, 'Начало периода'), t = number(to, 'Конец периода');
        if (f >= t) throw new UserError('Неверный период');
        rows = db.prepare('SELECT * FROM sales WHERE created_at >= ? AND created_at < ?').all(f, t);
      }
      const summary = { count: rows.length, total: round2(rows.filter((s) => !s.refunded_at).reduce((sum, s) => sum + s.total, 0)) };
      if (dryRun || !rows.length) return summary;
      const who = user ? user.name || user.email : '';
      return transaction(db, () => {
        const back = db.prepare(`UPDATE products SET stock = stock + (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = ? AND product_id = products.id)
          WHERE id IN (SELECT product_id FROM sale_items WHERE sale_id = ?)`);
        const delItems = db.prepare('DELETE FROM sale_items WHERE sale_id = ?');
        const delParts = db.prepare('DELETE FROM sale_payments WHERE sale_id = ?');
        const delSale = db.prepare('DELETE FROM sales WHERE id = ?');
        const unlinkOrder = db.prepare('UPDATE orders SET sale_id = NULL WHERE sale_id = ?');
        for (const sale of rows) {
          if (!sale.refunded_at) {
            if (restock) back.run(sale.id, sale.id);
            if (sale.customer_id && (sale.bonus_spent || sale.bonus_earned)) {
              const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
              const delta = c ? round2(Math.max(sale.bonus_spent - sale.bonus_earned, -c.bonus)) : 0;
              if (delta) changeBonus(c.id, delta, `Чек №${sale.id} удалён`, who, sale.id);
            }
          }
          delItems.run(sale.id);
          delParts.run(sale.id);
          unlinkOrder.run(sale.id);
          delSale.run(sale.id);
        }
        return summary;
      });
    },

    // userId — показать только чеки этого сотрудника.
    listSales({ from, to, limit = 200, userId = null }) {
      const sales = db.prepare(`
        SELECT s.*, c.name AS customer_name, c.phone AS customer_phone FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.created_at >= ? AND s.created_at < ? AND (? IS NULL OR s.user_id = ?)
        ORDER BY s.created_at DESC LIMIT ?`).all(from, to, userId, userId, limit);
      const items = db.prepare('SELECT product_id, name, qty, price FROM sale_items WHERE sale_id = ?');
      const parts = db.prepare('SELECT method_name AS name, kind, amount, commission FROM sale_payments WHERE sale_id = ?');
      return sales.map((s) => ({ ...s, items: items.all(s.id), payments: parts.all(s.id) }));
    },

    getSale(id) {
      return db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(id)) || null;
    },

    // Эффективность сотрудников за период. Оклад и план заданы на месяц и
    // пересчитываются на долю каждого календарного месяца в периоде: весь октябрь — ровно один оклад.
    kpi({ from, to }) {
      // Выручка — за вычетом комиссии банков: это деньги, которые реально пришли магазину.
      const months = monthsBetween(from, to);
      const rows = db.prepare(`
        SELECT s.user_id AS id,
          COUNT(CASE WHEN s.refunded_at IS NULL THEN 1 END) AS receipts,
          COALESCE(SUM(CASE WHEN s.refunded_at IS NULL THEN s.total - ${SALE_FEE} END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN s.refunded_at IS NULL THEN ${SALE_FEE} END), 0) AS commission,
          COUNT(s.refunded_at) AS refunds,
          COALESCE(SUM(CASE WHEN s.refunded_at IS NOT NULL THEN s.total END), 0) AS refunded,
          COUNT(CASE WHEN s.refunded_at IS NULL AND s.customer_id IS NOT NULL THEN 1 END) AS loyalty_receipts
        FROM sales s WHERE s.created_at >= ? AND s.created_at < ? GROUP BY s.user_id`).all(from, to);
      const profit = new Map(db.prepare(`
        SELECT s.user_id AS id, SUM(si.qty * (si.price - si.cost) - ${LINE_FEE}) AS profit, SUM(si.qty) AS items
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ? GROUP BY s.user_id`).all(from, to).map((r) => [r.id, r]));
      const byDay = db.prepare(`
        SELECT s.user_id AS id, s.created_at AS t, s.total - ${SALE_FEE} AS total FROM sales s
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`).all(from, to);
      const stats = new Map(rows.map((r) => [r.id, r]));
      // Выход на смену считается по дням: две смены в один день — один выход.
      const shiftDays = new Map();
      for (const sh of db.prepare('SELECT user_id, opened_at FROM shifts WHERE opened_at >= ? AND opened_at < ?').all(from, to)) {
        const d = new Date(sh.opened_at);
        const days = shiftDays.get(sh.user_id) || new Set();
        days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        shiftDays.set(sh.user_id, days);
      }
      const fines = new Map(db.prepare("SELECT user_id, SUM(amount) AS sum, COUNT(*) AS n FROM fines WHERE kind = 'fine' AND at >= ? AND at < ? GROUP BY user_id").all(from, to).map((r) => [r.user_id, r]));
      const extras = new Map(db.prepare("SELECT user_id, SUM(amount) AS sum, COUNT(*) AS n FROM fines WHERE kind = 'bonus' AND at >= ? AND at < ? GROUP BY user_id").all(from, to).map((r) => [r.user_id, r]));
      const users = db.prepare('SELECT * FROM users ORDER BY name, email').all();
      const result = users
        .filter((u) => stats.has(u.id) || shiftDays.has(u.id) || fines.has(u.id) || extras.has(u.id) || (!u.disabled && (can(u, 'pos') || u.shift_rate > 0 || u.salary > 0)))
        .map((u) => ({ user: publicUser(u), ...stats.get(u.id) }));
      if (stats.has(null)) result.push({ user: null, ...stats.get(null) });
      const overrides = new Map();
      for (const o of db.prepare('SELECT * FROM pay_overrides WHERE period_from = ? AND period_to = ?').all(from, to)) {
        overrides.set(`${o.user_id}:${o.field}`, o);
      }
      return {
        from, to, months,
        staff: result.map((r) => {
          const revenue = r.revenue || 0;
          const shifts = r.user ? shiftDays.get(r.user.id)?.size || 0 : 0;
          // Оклад: ставка за выход × число выходов, плюс месячный оклад (если есть) за долю месяца.
          // Сумма, исправленная вручную, заменяет расчёт; расчёт остаётся в calc для сравнения.
          // 'rate' — ставка за выход только в этом периоде.
          const fixed = (field) => (r.user ? overrides.get(`${r.user.id}:${field}`) : null);
          const rate = r.user ? (fixed('rate') ? fixed('rate').amount : r.user.shift_rate) : 0;
          const calcSalary = r.user ? round2(rate * shifts + r.user.salary * months) : 0;
          const calcBonus = r.user ? round2(revenue * r.user.percent / 100) : 0;
          const salary = fixed('salary') ? fixed('salary').amount : calcSalary;
          const bonus = fixed('bonus') ? fixed('bonus').amount : calcBonus;
          const fine = r.user ? round2(fines.get(r.user.id)?.sum || 0) : 0;
          const plan = r.user ? round2(r.user.plan * months) : 0;
          // Бонус за план: план и премия заданы на месяц и пересчитываются на период, как оклад.
          const planBonus = plan > 0 && revenue >= plan ? round2((r.user.plan_bonus || 0) * months) : 0;
          const extra = r.user ? round2(extras.get(r.user.id)?.sum || 0) : 0;
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
            shifts,
            salary,
            bonus,
            fines: fine,
            finesCount: r.user ? fines.get(r.user.id)?.n || 0 : 0,
            planBonus,
            extra,
            extraCount: r.user ? extras.get(r.user.id)?.n || 0 : 0,
            pay: fixed('pay') ? fixed('pay').amount : round2(salary + bonus + planBonus + extra - fine),
            rate,
            calc: { rate: r.user?.shift_rate || 0, salary: calcSalary, bonus: calcBonus, pay: round2(salary + bonus + planBonus + extra - fine) },
            overrides: Object.fromEntries(['rate', 'salary', 'bonus', 'pay'].filter(fixed).map((f) => [f, { amount: fixed(f).amount, reason: fixed(f).reason, by: fixed(f).created_by, at: fixed(f).created_at }])),
          };
        }),
        sales: byDay.map((x) => ({ u: x.id, t: x.t, s: x.total })),
      };
    },

    // Хиты товаров за период: сколько продано, выручка и прибыль по каждому товару.
    reportProducts({ from, to }) {
      return db.prepare(`
        SELECT si.product_id AS id, MAX(si.name) AS name, p.category, p.unit, p.parent_id,
          SUM(si.qty) AS qty, SUM(si.qty * si.price - ${LINE_FEE}) AS revenue, SUM(si.qty * (si.price - si.cost) - ${LINE_FEE}) AS profit, COUNT(DISTINCT s.id) AS receipts
        FROM sales s JOIN sale_items si ON si.sale_id = s.id LEFT JOIN products p ON p.id = si.product_id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?
        GROUP BY si.product_id ORDER BY revenue DESC`).all(from, to)
        .map((r) => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) }));
    },

    /* ---------- Смены ---------- */

    currentShift(userId) {
      return db.prepare('SELECT * FROM shifts WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1').get(Number(userId)) || null;
    },

    openShift(user) {
      if (!user) throw new UserError('Смену открывает сотрудник: сначала войдите');
      if (this.currentShift(user.id)) throw new UserError('Смена уже открыта');
      const { lastInsertRowid } = db.prepare('INSERT INTO shifts (user_id, opened_at) VALUES (?, ?)').run(user.id, Date.now());
      return this.getShift(lastInsertRowid);
    },

    closeShift(user) {
      const sh = user && this.currentShift(user.id);
      if (!sh) throw new UserError('Открытой смены нет');
      db.prepare('UPDATE shifts SET closed_at = ? WHERE id = ?').run(Date.now(), sh.id);
      return this.getShift(sh.id);
    },

    // Смена с итогами: сколько чеков и на какую сумму пробито.
    getShift(id) {
      const sh = db.prepare(`SELECT sh.*, COALESCE(u.name, u.email, '') AS user_name FROM shifts sh LEFT JOIN users u ON u.id = sh.user_id WHERE sh.id = ?`).get(Number(id));
      if (!sh) throw new UserError('Смена не найдена');
      const inShift = `s.refunded_at IS NULL AND ((s.shift_id = ?) OR (s.shift_id IS NULL AND s.user_id = ? AND s.created_at >= ? AND s.created_at < ?))`;
      const args = [sh.id, sh.user_id, sh.opened_at, sh.closed_at || Date.now()];
      const t = db.prepare(`SELECT COUNT(*) AS receipts, COALESCE(SUM(total), 0) AS revenue FROM sales s WHERE ${inShift}`).get(...args);
      // Деньги смены по способам оплаты — из частей оплаты, поэтому смешанный чек делится правильно.
      const byMethod = db.prepare(`SELECT sp.method_name AS name, sp.kind, COUNT(DISTINCT s.id) AS receipts, SUM(sp.amount) AS sum, SUM(sp.commission) AS commission
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE ${inShift}
        GROUP BY sp.method_id, sp.method_name ORDER BY sum DESC`).all(...args)
        .map((r) => ({ ...r, sum: round2(r.sum), commission: round2(r.commission) }));
      const cashSum = byMethod.filter((m) => m.kind === 'cash').reduce((a, m) => a + m.sum, 0);
      t.cash = cashSum;
      t.card = byMethod.reduce((a, m) => a + m.sum, 0) - cashSum;
      return { ...sh, receipts: t.receipts, revenue: round2(t.revenue), cash: round2(t.cash), card: round2(t.card), byMethod };
    },

    listShifts({ from, to }) {
      return db.prepare('SELECT id FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC LIMIT 1000').all(from, to).map((r) => this.getShift(r.id));
    },

    // Смена, внесённая или исправленная вручную (забыли открыть или закрыть).
    saveShift(id, input, by) {
      const opened = number(input.opened_at, 'Начало смены', { positive: true });
      const closed = input.closed_at ? number(input.closed_at, 'Конец смены', { positive: true }) : null;
      if (closed && closed <= opened) throw new UserError('Конец смены должен быть позже начала');
      if (opened > Date.now() + 864e5) throw new UserError('Смена не может начинаться в будущем');
      const who = by ? by.name || by.email : '';
      if (id) {
        const cur = this.getShift(id);
        db.prepare('UPDATE shifts SET opened_at = ?, closed_at = ?, note = ?, edited_by = ? WHERE id = ?').run(opened, closed, text(input.note, 'Комментарий'), who, cur.id);
        return this.getShift(cur.id);
      }
      const u = this.findUser(input.user_id);
      if (!u) throw new UserError('Выберите сотрудника');
      const { lastInsertRowid } = db.prepare('INSERT INTO shifts (user_id, opened_at, closed_at, note, edited_by) VALUES (?, ?, ?, ?, ?)')
        .run(u.id, opened, closed, text(input.note, 'Комментарий'), who);
      return this.getShift(lastInsertRowid);
    },

    deleteShift(id) {
      const sh = this.getShift(id);
      db.prepare('UPDATE sales SET shift_id = NULL WHERE shift_id = ?').run(sh.id);
      db.prepare('DELETE FROM shifts WHERE id = ?').run(sh.id);
      return { ok: true };
    },

    /* ---------- Штрафы ---------- */

    // Штрафы и бонусы за период; kind — 'fine' или 'bonus', без него — всё вместе.
    listFines({ from, to, kind }) {
      return db.prepare(`SELECT f.*, COALESCE(NULLIF(u.name, ''), u.email) AS user_name FROM fines f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.at >= ? AND f.at < ? ${kind ? 'AND f.kind = ?' : ''} ORDER BY f.at DESC`).all(from, to, ...(kind ? [kind] : []));
    },

    addFine(input, by, kind = 'fine') {
      const u = this.findUser(input.user_id);
      if (!u) throw new UserError('Выберите сотрудника');
      const amount = round2(number(input.amount, kind === 'bonus' ? 'Сумма бонуса' : 'Сумма штрафа', { positive: true }));
      const reason = text(input.reason, kind === 'bonus' ? 'За что' : 'Причина', { required: true, max: 300 });
      const at = input.at ? number(input.at, 'Дата', { positive: true }) : Date.now();
      const { lastInsertRowid } = db.prepare('INSERT INTO fines (user_id, at, amount, reason, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(u.id, at, amount, reason, by ? by.name || by.email : '', Date.now(), kind);
      return db.prepare('SELECT * FROM fines WHERE id = ?').get(lastInsertRowid);
    },

    deleteFine(id, kind = 'fine') {
      const f = db.prepare('SELECT * FROM fines WHERE id = ? AND kind = ?').get(Number(id), kind);
      if (!f) throw new UserError(kind === 'bonus' ? 'Бонус не найден' : 'Штраф не найден');
      db.prepare('DELETE FROM fines WHERE id = ?').run(f.id);
      return f;
    },

    /* ---------- Журнал действий ---------- */

    // kind: login — вход, login_failed — неудачная попытка, logout — выход, change — изменение.
    audit(entry) {
      db.prepare('INSERT INTO audit (at, kind, user_id, user_name, ip, device, action, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), entry.kind, entry.user?.id ?? null, entry.user ? entry.user.name || entry.user.email : entry.userName || '',
          String(entry.ip || '').slice(0, 64), String(entry.device || '').slice(0, 120), String(entry.action).slice(0, 200), String(entry.details || '').slice(0, 1000));
      // Журнал хранит последние 100 000 записей.
      if (Math.random() < 0.01) db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id) - 100000 FROM audit)').run();
    },

    listAudit({ from, to, kind = '', q = '', limit = 500 }) {
      const like = `%${String(q).trim()}%`;
      return db.prepare(`SELECT * FROM audit WHERE at >= ? AND at < ? AND (? = '' OR kind = ?)
        AND (? = '%%' OR user_name LIKE ? OR action LIKE ? OR details LIKE ? OR ip LIKE ?)
        ORDER BY at DESC, id DESC LIMIT ?`).all(from, to, kind, kind, like, like, like, like, like, limit);
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
        birthdayDiscount: number(input.birthdayDiscount ?? 0, 'Скидка в день рождения, %'),
        birthdayDays: Math.round(number(input.birthdayDays ?? 0, 'Дней до и после дня рождения')),
      };
      if (next.percent > 100 || next.maxPay > 100 || next.birthdayDiscount > 100) throw new UserError('Процент не может быть больше 100');
      if (next.birthdayDays > 30) throw new UserError('Скидка может действовать не больше 30 дней до и после дня рождения');
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
        .map((c) => ({ ...this.withBirthday(c), spent: round2(c.spent), avg: c.purchases ? round2(c.spent / c.purchases) : 0 }));
    },

    findCustomer(id) {
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
      return c ? this.withBirthday(c) : null;
    },

    // Добавляет к покупателю: дней до дня рождения и действует ли сейчас скидка именинника.
    withBirthday(c) {
      const l = this.loyalty();
      const days = daysToBirthday(c.birthday);
      const thisYear = new Date().getFullYear();
      const active = Boolean(l.birthdayDiscount > 0 && days !== null && Math.abs(days) <= l.birthdayDays && c.birthday_used !== thisYear);
      return { ...c, birthdayIn: days, birthdayDiscount: active ? l.birthdayDiscount : 0 };
    },

    findCustomerByPhone(value) {
      const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone(value));
      return c ? this.withBirthday(c) : null;
    },

    createCustomer(input) {
      const p = phone(input.phone);
      if (db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(p)) throw new UserError('Покупатель с таким телефоном уже есть');
      const { lastInsertRowid } = db.prepare('INSERT INTO customers (phone, name, birthday, created_at) VALUES (?, ?, ?, ?)')
        .run(p, text(input.name, 'Имя', { max: 80 }), birthday(input.birthday), Date.now());
      return this.findCustomer(lastInsertRowid);
    },

    updateCustomer(id, input) {
      const c = getCustomer(id);
      const p = input.phone === undefined ? c.phone : phone(input.phone);
      const other = db.prepare('SELECT id FROM customers WHERE phone = ?').get(p);
      if (other && other.id !== c.id) throw new UserError('Покупатель с таким телефоном уже есть');
      db.prepare('UPDATE customers SET phone = ?, name = ?, birthday = ? WHERE id = ?')
        .run(p, input.name === undefined ? c.name : text(input.name, 'Имя', { max: 80 }), input.birthday === undefined ? c.birthday : birthday(input.birthday), c.id);
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
        SELECT s.created_at AS t, s.id AS r, s.user_id AS u, si.product_id AS p, si.name AS n, si.qty AS q,
          si.qty * si.price - ${LINE_FEE} AS s, si.qty * si.cost AS c, ${LINE_FEE} AS f
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?
        ORDER BY s.created_at`).all(from, to)
        .map((l) => ({ ...l, p: String(l.p), r: String(l.r) }));
      // Имена сотрудников для «Топ сотрудников»; чеки без входа идут под ключом null.
      const staff = Object.fromEntries(db.prepare("SELECT id, COALESCE(NULLIF(name, ''), email) AS name, role FROM users").all().map((u) => [u.id, { name: u.name, role: u.role }]));
      return { products, sales, staff, updatedAt: Date.now() };
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
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, role, password_hash, created_at, salary, percent, plan, rights, shift_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e, text(input.name, 'Имя', { max: 80 }), role(input.role || 'cashier'), passwordHash, Date.now(), pay.salary, pay.percent, pay.plan, rightsList(input.rights ?? null), pay.shift_rate);
      db.prepare('UPDATE users SET plan_bonus = ? WHERE id = ?').run(pay.plan_bonus, lastInsertRowid);
      if (input.max_discount !== undefined && input.max_discount !== null && input.max_discount !== '') {
        db.prepare('UPDATE users SET max_discount = ? WHERE id = ?').run(Math.min(100, number(input.max_discount, 'Максимальная скидка')), lastInsertRowid);
      }
      if (Array.isArray(input.payment_methods)) {
        db.prepare('UPDATE users SET payment_methods = ? WHERE id = ?').run(JSON.stringify([...new Set(input.payment_methods.map(Number))]), lastInsertRowid);
      }
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
      const maxDiscount = input.max_discount === undefined ? current.max_discount
        : input.max_discount === null || input.max_discount === '' ? null : Math.min(100, number(input.max_discount, 'Максимальная скидка'));
      const methods = input.payment_methods === undefined ? current.payment_methods
        : input.payment_methods === null ? null : JSON.stringify([...new Set(input.payment_methods.map(Number))]);
      db.prepare('UPDATE users SET email = ?, name = ?, role = ?, disabled = ?, password_hash = ?, salary = ?, percent = ?, plan = ?, rights = ?, shift_rate = ?, payment_methods = ?, max_discount = ? WHERE id = ?')
        .run(next.email, next.name, next.role, next.disabled, passwordHash || current.password_hash, pay.salary, pay.percent, pay.plan, rights, pay.shift_rate, methods, maxDiscount, current.id);
      db.prepare('UPDATE users SET plan_bonus = ? WHERE id = ?').run(pay.plan_bonus, current.id);
      return publicUser(this.findUser(current.id));
    },

    // Исправить сумму в ведомости за период или (amount = null) вернуть расчёт.
    setPayOverride({ user_id: userId, from, to, field, amount, reason }, by) {
      const u = this.findUser(userId);
      if (!u) throw new UserError('Сотрудник не найден');
      if (!['rate', 'salary', 'bonus', 'pay'].includes(field)) throw new UserError('Неизвестная графа ведомости');
      const pf = number(from, 'Начало периода', { positive: true }), pt = number(to, 'Конец периода', { positive: true });
      if (pt <= pf) throw new UserError('Неверный период');
      if (amount === null || amount === undefined || amount === '') {
        db.prepare('DELETE FROM pay_overrides WHERE user_id = ? AND period_from = ? AND period_to = ? AND field = ?').run(u.id, pf, pt, field);
        return { user: u.name || u.email, field, amount: null };
      }
      const value = round2(number(amount, 'Сумма', { min: 0 }));
      const why = text(reason, 'Причина', { max: 300 });
      db.prepare(`INSERT INTO pay_overrides (user_id, period_from, period_to, field, amount, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, period_from, period_to, field) DO UPDATE SET amount = excluded.amount, reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`)
        .run(u.id, pf, pt, field, value, why, by ? by.name || by.email : '', Date.now());
      return { user: u.name || u.email, field, amount: value, reason: why };
    },

    // Зарплатные условия сотрудника: ставка за смену, оклад, процент, план и бонус за план.
    setUserPay(id, input) {
      const current = this.findUser(id);
      if (!current) throw new UserError('Сотрудник не найден');
      const pay = payFields(input, current);
      db.prepare('UPDATE users SET shift_rate = ?, salary = ?, percent = ?, plan = ?, plan_bonus = ? WHERE id = ?')
        .run(pay.shift_rate, pay.salary, pay.percent, pay.plan, pay.plan_bonus, current.id);
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
      const radius = number(input.radius ?? 14, 'Скругление');
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
      // Порядок категорий на витрине — как в справочнике.
      const all = db.prepare(`SELECT p.id, p.name, p.category, p.unit, p.price, p.stock, p.description, p.photo_at, p.parent_id, p.options
        FROM products p LEFT JOIN categories c ON c.name = p.category
        WHERE p.archived = 0 AND p.deleted = 0 ORDER BY p.category = '', COALESCE(c.sort, 1e9), p.category, p.name COLLATE NOCASE`).all();
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

    // Категории витрины с картинками — только те, где есть показанные товары, в порядке справочника.
    shopCategories(products) {
      const used = new Set(products.map((p) => p.category).filter(Boolean));
      return this.listCategories().filter((c) => used.has(c.name)).map((c) => ({ name: c.name, image: c.image_id ? `/img/${c.image_id}` : null }));
    },

    shopPhotoAllowed(id) {
      return this.shopProducts().some((p) => p.id === Number(id) && p.photo);
    },

    // customer — покупатель, вошедший на витрине: имя и телефон заказа берутся из его аккаунта.
    createOrder(input, customer = null) {
      if (!customer) throw new UserError('Чтобы оформить заказ, войдите или зарегистрируйтесь');
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
        const { lastInsertRowid: id } = db.prepare('INSERT INTO orders (created_at, name, phone, comment, delivery, address, total, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(Date.now(), text(input.name || customer.name, 'Имя', { required: true, max: 80 }), customer.phone, text(input.comment, 'Комментарий', { max: 1000 }), delivery, address, total, customer.id);
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

    // Статусы: new — новый, confirmed — подтверждён, ready — собран, shipped — передан курьеру,
    // done — выдан (доставлен), cancelled — отменён.
    // При выдаче заказ пробивается чеком: товар списывается, выручка идёт тому, кто выдал.
    setOrderStatus(id, { status, payment, methodId }, user = null) {
      const o = this.getOrder(id);
      if (!['new', 'confirmed', 'ready', 'shipped', 'done', 'cancelled'].includes(status)) throw new UserError('Неизвестный статус');
      if (o.status === 'done' || o.status === 'cancelled') throw new UserError('Заказ уже закрыт');
      return transaction(db, () => {
        let saleId = null;
        if (status === 'done') {
          // Покупатель с витрины попадает в программу лояльности по телефону: так его покупки видны в рейтинге.
          const customer = this.findCustomerByPhone(o.phone) || this.createCustomer({ phone: o.phone, name: o.name });
          saleId = this.createSale({ methodId, payment: payment === 'cash' ? 'cash' : 'card', customerId: customer.id, items: o.items.map((i) => ({ productId: i.product_id, qty: i.qty, price: i.price })) }, user, { trustPrices: true }).id;
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

module.exports = { createStore, UserError, text, number, phone, birthday, round2, transaction };
