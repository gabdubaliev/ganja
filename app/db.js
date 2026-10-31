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
  // PIN-код для быстрой смены кассира на кассе (scrypt-хеш, как пароль).
  addColumns('users', [['pin_hash', 'TEXT']]);
  // owner_shadow — запись владельца в базе филиала: владелец входит один раз и работает в любом магазине.
  addColumns('users', [['owner_shadow', 'INTEGER NOT NULL DEFAULT 0']]);
  // stores — в каких ещё магазинах (id филиалов, JSON) может работать сотрудник; moved_to — переведён в другой магазин.
  addColumns('users', [['stores', 'TEXT'], ['moved_to', 'INTEGER']]);
  // Штрафы и бонусы сотрудникам — одна таблица: kind 'fine' уменьшает зарплату, 'bonus' увеличивает.
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

  // Складские документы: инвентаризация (kind 'inventory') — пересчёт остатков по факту,
  // списание (kind 'writeoff') — брак, просрочка, порча. Строки хранят снимок названия, цены и себестоимости.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_docs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      user_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      shortage_cost REAL NOT NULL DEFAULT 0,
      surplus_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS stock_docs_kind ON stock_docs(kind, created_at);
    CREATE TABLE IF NOT EXISTS stock_doc_items (
      id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES stock_docs(id),
      product_id INTEGER,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'шт',
      expected REAL,
      actual REAL,
      qty REAL NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS stock_doc_items_doc ON stock_doc_items(doc_id);
  `);

  // Документы — все движения товара. status: 'draft' — не проведён (остатки не меняются),
  // 'posted' — проведён. kind: sale (продажа через админ-панель), purchase (закупка), return (возврат продажи),
  // receipt (оприходование), writeoff (списание), inventory (инвентаризация), transfer (перемещение между магазинами).
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      doc_date INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      user_id INTEGER,
      posted_at INTEGER,
      posted_by TEXT NOT NULL DEFAULT '',
      supplier_id INTEGER,
      supplier_name TEXT NOT NULL DEFAULT '',
      customer_id INTEGER,
      method_id INTEGER,
      branch_to INTEGER,
      branch_from INTEGER,
      direction TEXT NOT NULL DEFAULT '',
      link_doc_id INTEGER,
      sale_id INTEGER,
      note TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      shortage_cost REAL NOT NULL DEFAULT 0,
      surplus_cost REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind, doc_date);
    CREATE TABLE IF NOT EXISTS doc_items (
      id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES docs(id),
      product_id INTEGER,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'шт',
      qty REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      expected REAL,
      actual REAL,
      prev_cost REAL,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS doc_items_doc ON doc_items(doc_id);
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      inn TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  // Приходы и складские документы прошлых версий переезжают в документы как проведённые — один раз.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'docs_migrated'").get()) {
    const supplierIds = new Map();
    const supplierOf = (name) => {
      if (!name) return null;
      const key = name.toLowerCase();
      if (!supplierIds.has(key)) supplierIds.set(key, Number(db.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid));
      return supplierIds.get(key);
    };
    const addDoc = db.prepare(`INSERT INTO docs (kind, number, status, doc_date, created_at, posted_at, created_by, posted_by, supplier_id, supplier_name, note, total, total_cost, shortage_cost, surplus_cost)
      VALUES (?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addItem = db.prepare('INSERT INTO doc_items (doc_id, product_id, name, unit, qty, price, cost, expected, actual, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const numbers = {};
    const next = (kind) => (numbers[kind] = (numbers[kind] || 0) + 1);
    for (const a of db.prepare('SELECT * FROM arrivals ORDER BY created_at').all()) {
      const { lastInsertRowid } = addDoc.run('purchase', next('purchase'), a.created_at, a.created_at, a.created_at, '', '', supplierOf(a.supplier), a.supplier || '', '', a.total, a.total, 0, 0);
      for (const i of db.prepare('SELECT ai.*, p.name, p.unit, p.price FROM arrival_items ai LEFT JOIN products p ON p.id = ai.product_id WHERE ai.arrival_id = ?').all(a.id)) {
        addItem.run(lastInsertRowid, i.product_id, i.name || 'Товар', i.unit || 'шт', i.qty, i.price || 0, i.cost, null, null, '');
      }
    }
    for (const d of db.prepare('SELECT * FROM stock_docs ORDER BY created_at').all()) {
      const { lastInsertRowid } = addDoc.run(d.kind, next(d.kind), d.created_at, d.created_at, d.created_at, d.user_name, d.user_name, null, '', d.note, d.total_price, d.total_cost, d.shortage_cost, d.surplus_cost);
      for (const i of db.prepare('SELECT * FROM stock_doc_items WHERE doc_id = ?').all(d.id)) {
        addItem.run(lastInsertRowid, i.product_id, i.name, i.unit, i.qty, i.price, i.cost, i.expected, i.actual, i.reason);
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('docs_migrated', '1')").run();
  }

  // Счета — это способы оплаты как места, где лежат деньги (касса наличных, МБАНК…):
  // начальный остаток + оплаты чеков − комиссия − возвраты − оплаченные закупки ± ручные операции.
  addColumns('payment_methods', [['opening_balance', 'REAL NOT NULL DEFAULT 0']]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_ops (
      id INTEGER PRIMARY KEY,
      method_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      amount REAL NOT NULL,
      kind TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      pair_id INTEGER,
      user_name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS account_ops_at ON account_ops(at);
    -- Кассы (рабочие места): смена открывается на конкретной кассе.
    CREATE TABLE IF NOT EXISTS registers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare('SELECT 1 FROM registers').get()) db.prepare("INSERT INTO registers (name, sort, created_at) VALUES ('Касса 1', 1, ?)").run(Date.now());

  // Задания сотрудникам: open — в работе, done — сотрудник отметил «Выполнено» и ждёт проверки,
  // approved — проверено и принято, returned — возвращено на доработку.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id INTEGER NOT NULL REFERENCES users(id),
      period TEXT NOT NULL DEFAULT 'day',
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      done_at INTEGER,
      done_comment TEXT NOT NULL DEFAULT '',
      checked_at INTEGER,
      checked_by TEXT NOT NULL DEFAULT '',
      check_comment TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, status);
  `);

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
  // Колонки таблиц, которые создаются выше в этой же функции: на новой базе их добавляем после создания таблиц.
  addColumns('fines', [['kind', "TEXT NOT NULL DEFAULT 'fine'"]]);
  addColumns('shifts', [['register_id', 'INTEGER']]);
  // Карточка товара: цена закупки (чистая стоимость товара у поставщика), артикул, поставщик, скидка в %.
  // Себестоимость (cost) — закупка плюс расходы на единицу: доставка, зарплата, налоги и т.д.
  addColumns('products', [['purchase', 'REAL'], ['article', "TEXT NOT NULL DEFAULT ''"], ['supplier_id', 'INTEGER'], ['discount', 'REAL NOT NULL DEFAULT 0']]);
  db.exec('UPDATE products SET purchase = cost WHERE purchase IS NULL');
  // Цена закупки в строке чека — для прибыли на главной; prev_purchase — чтобы отменить закупку.
  addColumns('sale_items', [['purchase', 'REAL']]);
  db.exec('UPDATE sale_items SET purchase = cost WHERE purchase IS NULL');
  addColumns('doc_items', [['prev_purchase', 'REAL']]);
  // Зашифрованные копии пароля и PIN, заданных владельцем или администратором (для просмотра владельцем).
  addColumns('users', [['secret_pw', 'TEXT'], ['secret_pin', 'TEXT']]);
  // Карта покупателя (номер — 8 цифр, печатается штрихкодом) и пол: 'm' — мужской, 'f' — женский.
  addColumns('customers', [['card', "TEXT NOT NULL DEFAULT ''"], ['gender', "TEXT NOT NULL DEFAULT ''"]]);
  // Подарочные сертификаты. Продажа сертификата — деньги на счёт, товар не уходит; выручка и прибыль считаются,
  // когда по сертификату покупают товар (часть оплаты чека с kind 'certificate', без счёта и комиссии).
  // status: active — действует, blocked — заблокирован (утерян). Остаток тратится частями; срок — expires_at.
  db.exec(`
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      balance REAL NOT NULL,
      customer_id INTEGER,
      sold_at INTEGER NOT NULL,
      expires_at INTEGER,
      user_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      shift_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS certificates_sold ON certificates(sold_at);
    CREATE TABLE IF NOT EXISTS certificate_payments (
      id INTEGER PRIMARY KEY,
      certificate_id INTEGER NOT NULL,
      method_id INTEGER,
      method_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'card',
      amount REAL NOT NULL,
      commission REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS certificate_ops (
      id INTEGER PRIMARY KEY,
      certificate_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      sale_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS certificate_ops_cert ON certificate_ops(certificate_id);
  `);
  addColumns('sale_payments', [['certificate_id', 'INTEGER']]);
  db.exec("CREATE INDEX IF NOT EXISTS customers_card ON customers(card)");
  db.exec(`
    CREATE INDEX IF NOT EXISTS doc_items_product ON doc_items(product_id);
    CREATE INDEX IF NOT EXISTS sale_items_product ON sale_items(product_id);
    -- Расходы магазина: аренда, доставка, налоги… Из них и зарплаты считается чистая прибыль.
    -- method_id — счёт, с которого заплатили (необязательно): тогда расход уменьшает остаток счёта.
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      method_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expenses_at ON expenses(at);
    -- Постоянные расходы, которые владелец заводит сам: аренда, таргет… Сумма в месяц делится
    -- на число дней этого месяца, и каждый день периода несёт свою долю. since — с какого дня действует.
    -- Правки табеля: день сотрудника (day — 'ГГГГ-ММ-ДД'). status: 'work' — рабочий день (выход
    -- считается, даже без открытой смены), 'off' — выходной (выход не считается), NULL — как по сменам.
    -- amount — своя сумма за день вместо расчёта (ставка + % от выручки дня), color — цвет ячейки.
    CREATE TABLE IF NOT EXISTS timesheet_marks (
      user_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      status TEXT,
      amount REAL,
      color TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      since INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  // Код товара программа присваивает сама — и товарам, заведённым до этого (или загруженным без кода).
  fillCodes(db);
  // Новые права (галочки): тем, у кого права настроены вручную, добавляем их по смыслу — один раз,
  // чтобы после обновления никто не потерял то, что уже видел.
  // Сертификаты: продавать и принимать — у кого была «Касса», список — у кого были «Покупатели».
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'rights_v5'").get()) {
    const set = db.prepare('UPDATE users SET rights = ? WHERE id = ?');
    for (const u of db.prepare('SELECT id, rights FROM users WHERE rights IS NOT NULL').all()) {
      let list;
      try { list = JSON.parse(u.rights); } catch { continue; }
      if (!Array.isArray(list)) continue;
      const add = [];
      if (list.includes('pos')) add.push('certificates.sell', 'certificates.accept');
      if (list.includes('customers')) add.push('certificates');
      if (add.length) set.run(JSON.stringify([...new Set([...list, ...add])]), u.id);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('rights_v5', '1')").run();
  }
  // Заводить покупателей на кассе — отдельная галочка: у кого была «Касса», тому она добавляется.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'rights_v4'").get()) {
    const set = db.prepare('UPDATE users SET rights = ? WHERE id = ?');
    for (const u of db.prepare('SELECT id, rights FROM users WHERE rights IS NOT NULL').all()) {
      let list;
      try { list = JSON.parse(u.rights); } catch { continue; }
      if (Array.isArray(list) && list.includes('pos') && !list.includes('customers.create')) set.run(JSON.stringify([...list, 'customers.create']), u.id);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('rights_v4', '1')").run();
  }
  // Бонусы сотрудникам — отдельная галочка: у кого была «Зарплата», тому она добавляется.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'rights_v3'").get()) {
    const set = db.prepare('UPDATE users SET rights = ? WHERE id = ?');
    for (const u of db.prepare('SELECT id, rights FROM users WHERE rights IS NOT NULL').all()) {
      let list;
      try { list = JSON.parse(u.rights); } catch { continue; }
      if (Array.isArray(list) && list.includes('salary') && !list.includes('bonuses')) set.run(JSON.stringify([...list, 'bonuses']), u.id);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('rights_v3', '1')").run();
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'rights_v2'").get()) {
    const set = db.prepare('UPDATE users SET rights = ? WHERE id = ?');
    for (const u of db.prepare('SELECT id, rights FROM users WHERE rights IS NOT NULL').all()) {
      let list;
      try { list = JSON.parse(u.rights); } catch { continue; }
      if (!Array.isArray(list)) continue;
      const add = ['mytimesheet'];
      if (list.includes('dashboard')) add.push('finance', 'abc');
      if (list.includes('kpi')) add.push('abc');
      if (list.includes('arrivals')) add.push('receive.photo');
      if (list.includes('products')) add.push('products.history');
      set.run(JSON.stringify([...new Set([...list, ...add])]), u.id);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('rights_v2', '1')").run();
  }
  return db;
}

// Следующий свободный код товара: 00001, 00002… Длинные коды (штрихкоды, вписанные как код) не учитываются.
function nextCode(db) {
  const max = db.prepare(`SELECT MAX(CAST(code AS INTEGER)) AS m FROM products
    WHERE code <> '' AND length(code) <= 8 AND code NOT GLOB '*[^0-9]*'`).get().m || 0;
  return String(max + 1).padStart(5, '0');
}

function fillCodes(db) {
  const empty = db.prepare("SELECT id FROM products WHERE code = '' ORDER BY id").all();
  if (!empty.length) return;
  transaction(db, () => {
    const set = db.prepare('UPDATE products SET code = ? WHERE id = ?');
    for (const p of empty) set.run(nextCode(db), p.id);
  });
}

// Цена продажи со скидкой товара (скидка в % из карточки).
const salePrice = (p) => (p.discount > 0 ? Math.round(p.price * (1 - p.discount / 100) * 100) / 100 : p.price);

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

// Хеши пароля и PIN-кода в браузер не уходят; вместо PIN — признак hasPin.
// Виды документов: название и право, нужное, чтобы их создавать и проводить.
// Статьи расходов, которые предлагаются при вводе (можно вписать и свою).
const EXPENSE_CATEGORIES = ['Аренда', 'Доставка', 'Налоги', 'Коммунальные услуги', 'Реклама', 'Связь и интернет', 'Хозяйственные расходы', 'Ремонт', 'Прочее'];

const DOC_KINDS = {
  sale: { name: 'Продажа', many: 'Продажи через админ-панель', right: 'docs.sale' },
  purchase: { name: 'Закупка', many: 'Закупки', right: 'arrivals' },
  return: { name: 'Возврат продажи', many: 'Возвраты продаж', right: 'refund' },
  receipt: { name: 'Оприходование', many: 'Оприходования', right: 'arrivals' },
  writeoff: { name: 'Списание', many: 'Списания', right: 'writeoff' },
  inventory: { name: 'Инвентаризация', many: 'Инвентаризации', right: 'stock' },
  transfer: { name: 'Перемещение', many: 'Перемещения', right: 'transfer' },
};

const publicUser = ({ password_hash, pin_hash, secret_pw, secret_pin, ...u }) => ({ ...u, hasPin: Boolean(pin_hash), hasPassCopy: Boolean(secret_pw), hasPinCopy: Boolean(secret_pin),
  disabled: Boolean(u.disabled), rights: u.rights ? JSON.parse(u.rights) : null,
  payment_methods: u.payment_methods ? JSON.parse(u.payment_methods) : null, stores: u.stores ? JSON.parse(u.stores) : [] });

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
// ФИО: каждое слово (и часть через дефис) — с заглавной буквы, лишние пробелы убираются.
function personName(value) {
  const s = text(value, 'ФИО', { max: 80 }).replace(/\s+/g, ' ');
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}
function customerCard(value) {
  const s = String(value ?? '').replace(/\s/g, '');
  if (!s) return '';
  if (!/^\d{8}$/.test(s)) throw new UserError('Номер карты — ровно 8 цифр');
  return s;
}
function gender(value) {
  const g = String(value ?? '').toLowerCase();
  if (['m', 'м', 'male', 'мужской'].includes(g)) return 'm';
  if (['f', 'ж', 'female', 'женский'].includes(g)) return 'f';
  return '';
}

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

// День для табеля: 'ГГГГ-ММ-ДД' по местному времени.
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayFromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const TS_COLORS = ['', 'green', 'yellow', 'red', 'blue', 'purple', 'gray'];

// Доля месяцев по календарным дням: каждый день, который задевает период, — 1/(дней в его месяце).
// Сегодняшний день считается целиком: аренда за сегодня — полная дневная доля.
function dayShare(from, to, since = null) {
  let share = 0, days = 0;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() < to; d.setDate(d.getDate() + 1)) {
    if (since && d.getTime() + 864e5 <= since) continue;
    share += 1 / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    days++;
  }
  return { share, days };
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
  let branchLink = null; // связь с другими магазинами (перемещения), задаёт сервер

  // Категория по названию без учёта регистра. Сравниваем здесь, а не в SQLite: его NOCASE не знает кириллицу.
  const findCategory = (name) => {
    const key = String(name ?? '').trim().toLowerCase();
    return key ? db.prepare('SELECT * FROM categories').all().find((c) => c.name.toLowerCase() === key) || null : null;
  };
  // «бакалея» в карточке товара становится уже заведённой «Бакалеей».
  const canonicalCategory = (name) => findCategory(name)?.name ?? name;

  // Цена закупки — без неё берётся себестоимость (старые клиенты и импорт знают только её).
  // Себестоимость — без неё равна цене закупки.
  const productFields = (input, current = {}) => {
    const given = (v) => v !== undefined && v !== null && v !== '';
    const purchase = round2(number(given(input.purchase) ? input.purchase : current.purchase ?? (given(input.cost) ? input.cost : current.cost ?? 0), 'Цена закупки'));
    let cost = round2(number(given(input.cost) ? input.cost : input.cost === '' ? 0 : current.cost ?? 0, 'Себестоимость'));
    if (!cost && purchase) cost = purchase;
    const discount = round2(number(given(input.discount) ? input.discount : input.discount === '' ? 0 : current.discount ?? 0, 'Скидка, %'));
    if (discount >= 100) throw new UserError('Скидка должна быть меньше 100%');
    const supplierId = input.supplier_id === undefined ? current.supplier_id ?? null : input.supplier_id ? Number(input.supplier_id) : null;
    if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw new UserError('Поставщик не найден');
    return {
      name: text(input.name ?? current.name, 'Название', { required: true }),
      category: canonicalCategory(text(input.category ?? current.category, 'Категория')),
      barcode: text(input.barcode ?? current.barcode, 'Штрихкод', { max: 64 }),
      code: text(input.code ?? current.code, 'Код товара', { max: 64 }),
      article: text(input.article ?? current.article, 'Артикул', { max: 64 }),
      description: text(input.description ?? current.description, 'Описание', { max: 2000 }),
      unit: text(input.unit ?? current.unit ?? 'шт', 'Единица', { max: 10 }) || 'шт',
      price: round2(number(input.price ?? current.price, 'Цена продажи')),
      cost, purchase, discount, supplier_id: supplierId,
    };
  };

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

    // received_at — дата последнего поступления (закупка, оприходование, перемещение в этот магазин).
    listProducts({ archived = false } = {}) {
      return db.prepare(`SELECT p.*, s.name AS supplier_name, (SELECT MAX(d.doc_date) FROM doc_items i JOIN docs d ON d.id = i.doc_id
          WHERE i.product_id = p.id AND d.status = 'posted' AND (d.kind IN ('purchase', 'receipt') OR (d.kind = 'transfer' AND d.direction = 'in'))) AS received_at
        FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.archived = ? AND p.deleted = 0 ORDER BY p.name COLLATE NOCASE`).all(archived ? 1 : 0);
    },

    // Тот же товар в этой базе (для перемещений и остатков по магазинам): по штрихкоду, по коду вместе
    // с названием (коды в каждом магазине присваиваются свои), по названию.
    findSameProduct(p) {
      return (p.barcode && db.prepare('SELECT * FROM products WHERE barcode = ? AND deleted = 0 ORDER BY parent_id IS NULL, id').get(p.barcode))
        || (p.code && db.prepare('SELECT * FROM products WHERE code = ? AND name = ? AND deleted = 0').get(p.code, p.name))
        || db.prepare('SELECT * FROM products WHERE name = ? AND deleted = 0').get(p.name) || null;
    },

    // Остаток товара в этой базе — для раздела «Склад» карточки. variants — модификации товара
    // из магазина, где открыта карточка: остаток основного товара — сумма остатков модификаций.
    stockOfSame(p, variants = []) {
      const one = (x) => {
        const found = this.findSameProduct(x);
        return found && !childrenOf(found.id).length ? found : null;
      };
      if (variants.length) {
        const found = variants.map(one).filter(Boolean);
        if (!found.length) return null;
        return { stock: round2(found.reduce((s, f) => s + f.stock, 0)), price: Math.min(...found.map((f) => f.price)), archived: found.every((f) => f.archived), variants: found.length };
      }
      const f = one(p);
      return f ? { stock: f.stock, price: f.price, archived: Boolean(f.archived) } : null;
    },

    getProductInfo(id) {
      const p = getProduct(id);
      const supplier = p.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(p.supplier_id)?.name ?? '' : '';
      return { ...p, supplier_name: supplier, children: childrenOf(p.id) };
    },

    // История движения товара: продажи, возвраты, закупки, оприходования, списания, инвентаризации,
    // перемещения — с датами. У товара с модификациями — по всем модификациям.
    productHistory(id) {
      const p = getProduct(id);
      const kids = childrenOf(p.id);
      const ids = [p.id, ...kids.map((k) => k.id)];
      const marks = ids.map(() => '?').join(', ');
      const events = [];
      const label = (row) => (kids.length && row.product_id !== p.id ? row.name : '');
      for (const r of db.prepare(`SELECT s.id, s.created_at, s.refunded_at, s.user_name, si.product_id, si.name, si.qty, si.price
          FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id IN (${marks}) ORDER BY s.created_at DESC LIMIT 1000`).all(...ids)) {
        events.push({ at: r.created_at, kind: 'sale', title: `Продажа, чек №${r.id}`, qty: -r.qty, price: r.price, who: r.user_name, note: '', variant: label(r) });
        if (r.refunded_at) events.push({ at: r.refunded_at, kind: 'refund', title: `Возврат по чеку №${r.id}`, qty: r.qty, price: r.price, who: '', note: '', variant: label(r) });
      }
      for (const r of db.prepare(`SELECT d.id AS doc_id, d.kind, d.number, d.doc_date, d.direction, d.branch_to, d.note, d.posted_by, d.created_by,
            COALESCE(su.name, d.supplier_name) AS supplier, i.product_id, i.name, i.qty, i.price, i.cost, i.expected, i.actual, i.reason
          FROM doc_items i JOIN docs d ON d.id = i.doc_id LEFT JOIN suppliers su ON su.id = d.supplier_id
          WHERE i.product_id IN (${marks}) AND d.status = 'posted' AND d.kind <> 'sale' ORDER BY d.doc_date DESC LIMIT 1000`).all(...ids)) {
        const sign = { purchase: 1, receipt: 1, return: 1, writeoff: -1, inventory: 1, transfer: r.direction === 'in' ? 1 : -1 }[r.kind] ?? 0;
        const name = DOC_KINDS[r.kind]?.name || r.kind;
        const note = r.kind === 'purchase' ? (r.supplier ? `Поставщик: ${r.supplier}` : '')
          : r.kind === 'writeoff' ? r.reason
          : r.kind === 'inventory' ? `было ${round2(r.expected ?? 0)}, по факту ${round2(r.actual ?? 0)}`
          : r.note;
        events.push({ at: r.doc_date, kind: r.kind, title: `${name}${r.kind === 'transfer' ? (r.direction === 'in' ? ' (приход)' : ' (отправка)') : ''} №${r.number}`,
          qty: round2(sign * r.qty), price: ['return', 'transfer'].includes(r.kind) ? r.price : r.cost, who: r.posted_by || r.created_by, note: note || '', variant: label(r), docId: r.doc_id });
      }
      events.push({ at: p.created_at, kind: 'created', title: 'Товар заведён в программе', qty: null, price: null, who: '', note: '', variant: '' });
      return events.sort((a, b) => b.at - a.at).slice(0, 1000);
    },

    createProduct(input) {
      const f = productFields(input);
      const stock = number(input.stock ?? 0, 'Остаток');
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, description, created_at, purchase, article, supplier_id, discount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.category, f.barcode, f.code || nextCode(db), f.unit, f.price, f.cost, stock, f.description, Date.now(),
        f.purchase, f.article, f.supplier_id, f.discount);
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
      return Array.isArray(own) && !['admin', 'owner'].includes(user.role) ? active.filter((m) => own.includes(m.id)) : active;
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
        WHERE s.created_at >= ? AND s.created_at < ? AND s.refunded_at IS NULL AND sp.kind <> 'certificate'
        GROUP BY sp.method_id, sp.method_name`).all(from, to)
        // Проданные сертификаты — тоже деньги, пришедшие этим способом.
        .concat(db.prepare(`SELECT cp.method_id AS id, cp.method_name AS name, cp.kind, COUNT(DISTINCT c.id) AS receipts, SUM(cp.amount) AS money, SUM(cp.commission) AS commission, COALESCE(m.commission, 0) AS rate
          FROM certificate_payments cp JOIN certificates c ON c.id = cp.certificate_id LEFT JOIN payment_methods m ON m.id = cp.method_id
          WHERE c.sold_at >= ? AND c.sold_at < ? GROUP BY cp.method_id, cp.method_name`).all(from, to))
        .reduce((acc, r) => {
          const x = acc.find((y) => y.id === r.id && y.name === r.name);
          if (x) { x.receipts += r.receipts; x.money += r.money; x.commission += r.commission; } else acc.push({ ...r });
          return acc;
        }, [])
        .map((r) => ({ ...r, money: round2(r.money), commission: round2(r.commission), net: round2(r.money - r.commission) }))
        .sort((a, b) => b.money - a.money);
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
          case 'purchase':
          case 'cost': {
            // mode: set — новая цена, percent — изменить на ±%, add — прибавить ±сомы,
            // markup — цена = цена закупки + наценка в % (только для цены).
            const n = number(value, 'Значение', { min: -Infinity });
            const calc = {
              set: () => n,
              percent: (old) => old * (1 + n / 100),
              add: (old) => old + n,
              markup: (old, p) => (p.purchase || p.cost) * (1 + n / 100),
            }[mode];
            if (!calc || (mode === 'markup' && action !== 'price')) throw new UserError('Неизвестный способ изменения цены');
            set(`UPDATE products SET ${action} = ? WHERE id = ?`, (p) => {
              const next = round2(calc(p[action] ?? 0, p));
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
      db.prepare(`UPDATE products SET name = ?, category = ?, barcode = ?, code = ?, unit = ?, price = ?, cost = ?, description = ?, archived = ?,
        purchase = ?, article = ?, supplier_id = ?, discount = ? WHERE id = ?`)
        .run(f.name, f.category, f.barcode, f.code || current.code || nextCode(db), f.unit, f.price, f.cost, f.description, archived,
          f.purchase, f.article, f.supplier_id, f.discount, current.id);
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
      db.prepare('UPDATE products SET name = ?, barcode = ?, code = ?, price = ?, cost = ?, options = ?, archived = ?, purchase = ?, article = ?, supplier_id = ?, discount = ? WHERE id = ?')
        .run(f.name, f.barcode, f.code || current.code || nextCode(db), f.price, f.cost, JSON.stringify(opts), archived, f.purchase, f.article, f.supplier_id, f.discount, current.id);
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
          INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, description, parent_id, options, archived, created_at, purchase, supplier_id, discount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const created = [];
        for (const v of variants) {
          const opts = optionsOf(v.options);
          const key = optionsKey(opts);
          if (seen.has(key)) throw new UserError(`Модификация «${Object.values(opts).join(', ')}» уже есть`);
          seen.add(key);
          const price = round2(number(v.price ?? base.price, 'Цена продажи'));
          const cost = round2(number(v.cost ?? base.cost, 'Себестоимость'));
          const purchase = round2(number(v.purchase ?? base.purchase ?? cost, 'Цена закупки'));
          const barcode = text(v.barcode, 'Штрихкод', { max: 64 }) || (barcodes ? newBarcode() : '');
          const { lastInsertRowid } = insert.run(variantName(base, opts), base.category, barcode, text(v.code, 'Код товара', { max: 64 }) || nextCode(db), base.unit,
            price, cost, number(v.stock ?? 0, 'Остаток'), base.description, base.id, JSON.stringify(opts), base.archived, Date.now(), purchase, base.supplier_id, base.discount || 0);
          created.push(getProduct(lastInsertRowid));
        }
        return created;
      });
    },

    newBarcode,

    // Ручная корректировка остатка (инвентаризация).
    // Пересчёт остатка одного товара — тоже документ: проведённая инвентаризация из одной строки.
    setStock(id, stock, user = null) {
      const p = getProduct(id);
      const doc = this.saveDoc(null, { kind: 'inventory', note: 'Пересчёт остатка из списка товаров', items: [{ productId: p.id, actual: number(stock, 'Остаток', { min: 0 }) }] }, user);
      this.postDoc(doc.id, user);
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
          INSERT INTO products (name, category, barcode, code, unit, price, cost, stock, created_at, purchase)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const change = db.prepare('UPDATE products SET name = ?, category = ?, barcode = ?, unit = ?, price = ?, cost = ?, stock = ?, purchase = ? WHERE id = ?');

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
                purchase: row.purchase === '' || row.purchase == null ? existing.purchase ?? existing.cost : f.purchase,
                stock: stock ?? existing.stock,
              };
              change.run(next.name, next.category, next.barcode, next.unit, next.price, next.cost, next.stock, next.purchase, existing.id);
              remember(next);
              result.updated++;
            } else {
              const code = f.code || nextCode(db);
              const { lastInsertRowid } = insert.run(f.name, f.category, f.barcode, code, f.unit, f.price, f.cost, stock ?? 0, Date.now(), f.purchase);
              remember({ ...f, code, id: Number(lastInsertRowid), stock: stock ?? 0 });
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
    createSale({ items, payment, methodId, payments, at, customerId, bonusSpend = 0, birthday: useBirthday = false, checkDiscount, certificate }, user = null, { trustPrices = false } = {}) {
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
        // Скидка из карточки товара — в цене справочника; в заказе и документе цена уже со скидкой.
        if (!trustPrices) {
          for (const l of lines) {
            if (!(l.p.discount > 0)) continue;
            l.price = salePrice(l.p);
            reasons.push(`${l.p.name}: скидка на товар ${l.p.discount}%`);
          }
        }
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
        const toPay = round2(total - spent);
        // Часть чека — подарочным сертификатом: деньги за него уже получены, поэтому эта часть не идёт ни на какой счёт.
        let cert = null, certAmount = 0;
        if (certificate?.number) {
          if (!can(staff, 'certificates.accept')) throw new UserError('У вас нет права принимать сертификаты в оплату');
          cert = this.usableCertificate(certificate.number);
          certAmount = round2(certificate.amount === undefined || certificate.amount === null || certificate.amount === ''
            ? Math.min(cert.balance, toPay) : number(certificate.amount, 'Сумма по сертификату', { positive: true }));
          if (certAmount > cert.balance + 0.001) throw new UserError(`На сертификате осталось только ${cert.balance} сом`);
          if (certAmount > toPay + 0.001) throw new UserError(`По сертификату можно оплатить не больше суммы чека — ${toPay} сом`);
        }
        const paid = round2(toPay - certAmount);

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
        const names = [...new Set([...(cert ? ['Сертификат'] : []), ...parts.filter((x) => x.amount > 0 || !cert).map((x) => x.method.name)])].join(' + ');

        const { lastInsertRowid: saleId } = db.prepare(`
          INSERT INTO sales (created_at, payment, total, user_id, user_name, customer_id, bonus_spent, bonus_earned, discount, discount_reason, shift_id, method_id, method_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(at || Date.now(), parts.every((x) => x.method.kind === 'cash') ? 'cash' : 'card', total, user?.id ?? null, user ? user.name || user.email : '',
            customer?.id ?? null, spent, earned, discount, reasons.join('; '), user ? this.currentShift(user.id)?.id ?? null : null, main.method.id, names);
        const addPart = db.prepare('INSERT INTO sale_payments (sale_id, method_id, method_name, kind, amount, commission) VALUES (?, ?, ?, ?, ?, ?)');
        for (const x of parts) if (x.amount > 0 || !cert) addPart.run(saleId, x.method.id, x.method.name, x.method.kind, x.amount, x.commission);
        if (cert) {
          db.prepare("INSERT INTO sale_payments (sale_id, method_id, method_name, kind, amount, commission, certificate_id) VALUES (?, NULL, 'Сертификат', 'certificate', ?, 0, ?)").run(saleId, certAmount, cert.id);
          db.prepare('UPDATE certificates SET balance = ROUND(balance - ?, 2) WHERE id = ?').run(certAmount, cert.id);
          db.prepare("INSERT INTO certificate_ops (certificate_id, at, kind, amount, sale_id, user_name) VALUES (?, ?, 'redeem', ?, ?, ?)")
            .run(cert.id, Date.now(), -certAmount, saleId, user ? user.name || user.email : '');
        }
        const addItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost, purchase) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
        for (const l of lines) {
          addItem.run(saleId, l.p.id, l.p.name, l.qty, l.price, l.p.cost, l.p.purchase ?? l.p.cost);
          takeStock.run(l.qty, l.p.id);
        }
        const who = user ? user.name || user.email : '';
        if (spent) changeBonus(customer.id, -spent, `Оплата чека №${saleId}`, who, saleId);
        if (earned) changeBonus(customer.id, earned, `Начислено за чек №${saleId}`, who, saleId);
        return { id: Number(saleId), method: names, total, paid, bonusSpent: spent, bonusEarned: earned, discount, discountReason: reasons.join('; '),
          certificate: cert ? { number: cert.number, used: certAmount, balance: round2(cert.balance - certAmount) } : null,
          payments: [...(cert ? [{ name: `Сертификат №${cert.number}`, amount: certAmount, commission: 0 }] : []), ...parts.filter((x) => x.amount > 0 || !cert).map((x) => ({ name: x.method.name, amount: x.amount, commission: x.commission }))],
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
        this.returnToCertificates(sale.id, `Возврат чека №${sale.id}`, user ? user.name || user.email : '');
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
        // Документ «Продажа», чей чек удалён, становится непроведённым.
        const unlinkDoc = db.prepare("UPDATE docs SET status = 'draft', posted_at = NULL, posted_by = '', sale_id = NULL WHERE sale_id = ?");
        const delSale = db.prepare('DELETE FROM sales WHERE id = ?');
        const unlinkOrder = db.prepare('UPDATE orders SET sale_id = NULL WHERE sale_id = ?');
        for (const sale of rows) {
          if (!sale.refunded_at) {
            this.returnToCertificates(sale.id, `Чек №${sale.id} удалён`, who);
            if (restock) back.run(sale.id, sale.id);
            if (sale.customer_id && (sale.bonus_spent || sale.bonus_earned)) {
              const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
              const delta = c ? round2(Math.max(sale.bonus_spent - sale.bonus_earned, -c.bonus)) : 0;
              if (delta) changeBonus(c.id, delta, `Чек №${sale.id} удалён`, who, sale.id);
            }
          }
          delItems.run(sale.id);
          delParts.run(sale.id);
          unlinkDoc.run(sale.id);
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
        SELECT s.user_id AS id, SUM(si.qty * (si.price - COALESCE(si.purchase, si.cost)) - ${LINE_FEE}) AS profit, SUM(si.qty) AS items
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ? GROUP BY s.user_id`).all(from, to).map((r) => [r.id, r]));
      const byDay = db.prepare(`
        SELECT s.user_id AS id, s.created_at AS t, s.total - ${SALE_FEE} AS total FROM sales s
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`).all(from, to);
      const stats = new Map(rows.map((r) => [r.id, r]));
      // Выход на смену считается по дням: две смены в один день — один выход.
      const shiftDays = new Map();
      const daysOf = (id) => { if (!shiftDays.has(id)) shiftDays.set(id, new Set()); return shiftDays.get(id); };
      for (const sh of db.prepare('SELECT user_id, opened_at FROM shifts WHERE opened_at >= ? AND opened_at < ?').all(from, to)) daysOf(sh.user_id).add(dayKey(sh.opened_at));
      // Правки табеля: рабочий день / выходной меняют число выходов, своя сумма за день заменяет расчёт дня.
      const marks = db.prepare('SELECT * FROM timesheet_marks WHERE day >= ? AND day <= ?').all(dayKey(from), dayKey(to - 1))
        .filter((mk) => { const t = dayFromKey(mk.day); return t + 864e5 > from && t < to; });
      for (const mk of marks) {
        if (mk.status === 'work') daysOf(mk.user_id).add(mk.day);
        if (mk.status === 'off') daysOf(mk.user_id).delete(mk.day);
      }
      const dayRevenue = db.prepare(`SELECT COALESCE(SUM(s.total - ${SALE_FEE}), 0) AS v FROM sales s WHERE s.user_id = ? AND s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`);
      const fixedDays = new Map();
      for (const mk of marks.filter((x) => x.amount !== null)) fixedDays.set(mk.user_id, [...(fixedDays.get(mk.user_id) || []), mk]);
      // Сколько добавить к расчёту: своя сумма дня минус то, что насчитано за этот день.
      const dayFix = (u, rate) => (fixedDays.get(u.id) || []).reduce((sum, mk) => {
        const t = dayFromKey(mk.day);
        const calc = (shiftDays.get(u.id)?.has(mk.day) ? rate : 0) + dayRevenue.get(u.id, t, t + 864e5).v * (u.percent || 0) / 100;
        return sum + mk.amount - calc;
      }, 0);
      const fines = new Map(db.prepare("SELECT user_id, SUM(amount) AS sum, COUNT(*) AS n FROM fines WHERE kind = 'fine' AND at >= ? AND at < ? GROUP BY user_id").all(from, to).map((r) => [r.user_id, r]));
      const extras = new Map(db.prepare("SELECT user_id, SUM(amount) AS sum, COUNT(*) AS n FROM fines WHERE kind = 'bonus' AND at >= ? AND at < ? GROUP BY user_id").all(from, to).map((r) => [r.user_id, r]));
      const users = db.prepare('SELECT * FROM users ORDER BY name, email').all();
      const result = users
        .filter((u) => stats.has(u.id) || shiftDays.get(u.id)?.size || fixedDays.has(u.id) || fines.has(u.id) || extras.has(u.id) || (!u.disabled && (can(u, 'pos') || u.shift_rate > 0 || u.salary > 0)))
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
          const calcSalary = r.user ? round2(rate * shifts + r.user.salary * months + dayFix(r.user, rate)) : 0;
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
          SUM(si.qty) AS qty, SUM(si.qty * si.price - ${LINE_FEE}) AS revenue, SUM(si.qty * (si.price - COALESCE(si.purchase, si.cost)) - ${LINE_FEE}) AS profit, COUNT(DISTINCT s.id) AS receipts
        FROM sales s JOIN sale_items si ON si.sale_id = s.id LEFT JOIN products p ON p.id = si.product_id
        WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?
        GROUP BY si.product_id ORDER BY revenue DESC`).all(from, to)
        .map((r) => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) }));
    },

    // Данные для ABC/XYZ-анализа: по каждому продаваемому товару — продано, выручка, прибыль (от цены закупки)
    // и количество по неделям или месяцам периода (для XYZ — насколько ровно продаётся).
    // Товары без продаж тоже возвращаются: они попадают в C/Z и видны как «не продаются».
    abcData({ from, to, bucket = 'week' }) {
      const starts = [];
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      if (bucket === 'month') d.setDate(1);
      else d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // с понедельника
      for (; d.getTime() < to; bucket === 'month' ? d.setMonth(d.getMonth() + 1) : d.setDate(d.getDate() + 7)) starts.push(d.getTime());
      const idx = (t) => { let i = starts.length - 1; while (i > 0 && starts[i] > t) i--; return i; };
      const products = new Map(db.prepare(`SELECT id, name, category, unit, stock, price, COALESCE(purchase, cost) AS purchase, created_at FROM products p
        WHERE archived = 0 AND deleted = 0 AND NOT EXISTS (SELECT 1 FROM products c WHERE c.parent_id = p.id AND c.deleted = 0)`).all()
        .map((p) => [p.id, { ...p, qty: 0, revenue: 0, profit: 0, receipts: new Set(), series: starts.map(() => 0) }]));
      for (const l of db.prepare(`SELECT s.id AS sale, s.created_at AS t, si.product_id AS id, si.name, si.qty, si.qty * si.price - ${LINE_FEE} AS revenue,
          si.qty * (si.price - COALESCE(si.purchase, si.cost)) - ${LINE_FEE} AS profit
        FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`).all(from, to)) {
        let p = products.get(l.id);
        if (!p) { p = { id: l.id, name: l.name, category: '', unit: 'шт', stock: null, price: 0, purchase: 0, gone: true, qty: 0, revenue: 0, profit: 0, receipts: new Set(), series: starts.map(() => 0) }; products.set(l.id, p); }
        p.qty += l.qty; p.revenue += l.revenue; p.profit += l.profit; p.receipts.add(l.sale);
        p.series[idx(l.t)] += l.qty;
      }
      // Конец каждого отрезка; неполные (обрезанные периодом) для XYZ не берутся.
      const ends = starts.map((t) => { const e = new Date(t); if (bucket === 'month') e.setMonth(e.getMonth() + 1); else e.setDate(e.getDate() + 7); return e.getTime(); });
      return {
        from, to, bucket, buckets: starts, ends, full: starts.map((t, i) => t >= from && ends[i] <= to),
        products: [...products.values()].map(({ receipts, ...p }) => ({ ...p, receipts: receipts.size, revenue: round2(p.revenue), profit: round2(p.profit), series: p.series.map((q) => Math.round(q * 1000) / 1000) })),
      };
    },

    /* ---------- Смены ---------- */

    currentShift(userId) {
      return db.prepare('SELECT * FROM shifts WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1').get(Number(userId)) || null;
    },

    openShift(user, registerId = null) {
      if (!user) throw new UserError('Смену открывает сотрудник: сначала войдите');
      if (this.currentShift(user.id)) throw new UserError('Смена уже открыта');
      const registers = this.listRegisters();
      const reg = registerId ? registers.find((r) => r.id === Number(registerId)) : registers.length === 1 ? registers[0] : null;
      if (!reg) throw new UserError(registerId ? 'Касса не найдена или выключена' : 'Выберите кассу');
      const { lastInsertRowid } = db.prepare('INSERT INTO shifts (user_id, opened_at, register_id) VALUES (?, ?, ?)').run(user.id, Date.now(), reg.id);
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
      const sh = db.prepare(`SELECT sh.*, COALESCE(u.name, u.email, '') AS user_name, r.name AS register_name FROM shifts sh
        LEFT JOIN users u ON u.id = sh.user_id LEFT JOIN registers r ON r.id = sh.register_id WHERE sh.id = ?`).get(Number(id));
      if (!sh) throw new UserError('Смена не найдена');
      const inShift = `s.refunded_at IS NULL AND ((s.shift_id = ?) OR (s.shift_id IS NULL AND s.user_id = ? AND s.created_at >= ? AND s.created_at < ?))`;
      const args = [sh.id, sh.user_id, sh.opened_at, sh.closed_at || Date.now()];
      const t = db.prepare(`SELECT COUNT(*) AS receipts, COALESCE(SUM(total), 0) AS revenue FROM sales s WHERE ${inShift}`).get(...args);
      // Деньги смены по способам оплаты — из частей оплаты, поэтому смешанный чек делится правильно.
      // Оплата сертификатом — не деньги смены (их получили при продаже сертификата), а проданные сертификаты — деньги.
      const byMethodRaw = db.prepare(`SELECT sp.method_name AS name, sp.kind, COUNT(DISTINCT s.id) AS receipts, SUM(sp.amount) AS sum, SUM(sp.commission) AS commission
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE ${inShift} AND sp.kind <> 'certificate'
        GROUP BY sp.method_id, sp.method_name`).all(...args);
      const certPays = db.prepare(`SELECT cp.method_name AS name, cp.kind, COUNT(DISTINCT c.id) AS receipts, SUM(cp.amount) AS sum, SUM(cp.commission) AS commission
        FROM certificate_payments cp JOIN certificates c ON c.id = cp.certificate_id
        WHERE c.shift_id = ? OR (c.shift_id IS NULL AND c.user_id = ? AND c.sold_at >= ? AND c.sold_at < ?) GROUP BY cp.method_id, cp.method_name`).all(...args);
      const merged = new Map();
      for (const r of [...byMethodRaw, ...certPays]) {
        const x = merged.get(r.name) || { name: r.name, kind: r.kind, receipts: 0, sum: 0, commission: 0 };
        x.receipts += r.receipts; x.sum += r.sum; x.commission += r.commission;
        merged.set(r.name, x);
      }
      const byMethod = [...merged.values()].map((r) => ({ ...r, sum: round2(r.sum), commission: round2(r.commission) })).sort((a, b) => b.sum - a.sum);
      const certSold = certPays.reduce((s, r) => s + r.sum, 0);
      const cashSum = byMethod.filter((m) => m.kind === 'cash').reduce((a, m) => a + m.sum, 0);
      t.cash = cashSum;
      t.card = byMethod.reduce((a, m) => a + m.sum, 0) - cashSum;
      return { ...sh, receipts: t.receipts, revenue: round2(t.revenue), cash: round2(t.cash), card: round2(t.card), byMethod, certificatesSold: round2(certSold) };
    },

    /* ---------- Табель ---------- */
    // Табель за месяц: по каждому сотруднику и дню — был ли выход, часы, выручка и заработок за день,
    // плюс итоги по выплатным периодам (1–15 и 16–конец) из расчёта зарплаты, с ручными исправлениями.
    timesheet({ year, month }) {
      const y = number(year, 'Год', { positive: true }), m = number(month, 'Месяц', { min: 1 }) - 1;
      if (m > 11) throw new UserError('Неверный месяц');
      const start = new Date(y, m, 1).getTime(), mid = new Date(y, m, 16).getTime(), end = new Date(y, m + 1, 1).getTime();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const dayOf = (t) => new Date(t).getDate();
      const halves = [this.kpi({ from: start, to: mid }), this.kpi({ from: mid, to: end })];
      const byUser = new Map();
      const row = (id) => {
        if (!byUser.has(id)) byUser.set(id, { days: {} });
        return byUser.get(id);
      };
      const cell = (id, d) => (row(id).days[d] ||= { shifts: [], revenue: 0, fines: 0, bonuses: 0, items: [] });
      for (const sh of db.prepare('SELECT user_id, opened_at, closed_at FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at').all(start, end)) {
        cell(sh.user_id, dayOf(sh.opened_at)).shifts.push({ from: sh.opened_at, to: sh.closed_at });
      }
      for (const s of db.prepare(`SELECT s.user_id, s.created_at, s.total - ${SALE_FEE} AS money FROM sales s
        WHERE s.refunded_at IS NULL AND s.user_id IS NOT NULL AND s.created_at >= ? AND s.created_at < ?`).all(start, end)) {
        cell(s.user_id, dayOf(s.created_at)).revenue += s.money;
      }
      // Штрафы и бонусы дня — с причиной и тем, кто выписал: их видят и владелец, и сам сотрудник.
      for (const f of db.prepare('SELECT user_id, at, amount, kind, reason, created_by FROM fines WHERE at >= ? AND at < ? ORDER BY at').all(start, end)) {
        const c = cell(f.user_id, dayOf(f.at));
        c[f.kind === 'bonus' ? 'bonuses' : 'fines'] += f.amount;
        c.items.push({ kind: f.kind === 'bonus' ? 'bonus' : 'fine', amount: f.amount, reason: f.reason, by: f.created_by, at: f.at });
      }
      for (const mk of db.prepare('SELECT * FROM timesheet_marks WHERE day >= ? AND day < ?').all(dayKey(start), dayKey(end))) {
        cell(mk.user_id, dayOf(dayFromKey(mk.day))).mark = { status: mk.status, amount: mk.amount, color: mk.color, note: mk.note, by: mk.updated_by, at: mk.updated_at };
      }
      const staff = new Map();
      for (const [i, h] of halves.entries()) {
        for (const r of h.staff) {
          if (!r.user) continue;
          const s = staff.get(r.user.id) || { user: r.user, halves: [null, null] };
          s.halves[i] = { shifts: r.shifts, rate: r.rate, salary: r.salary, bonus: r.bonus, planBonus: r.planBonus, extra: r.extra, fines: r.fines, pay: r.pay, revenue: r.revenue, overrides: r.overrides };
          staff.set(r.user.id, s);
        }
      }
      const rows = [...staff.values()].filter((s) => byUser.has(s.user.id) || s.halves.some((h) => h && (h.pay || h.shifts)) || !s.user.disabled).map((s) => {
        const days = byUser.get(s.user.id)?.days || {};
        for (const [d, c] of Object.entries(days)) {
          const h = s.halves[Number(d) < 16 ? 0 : 1];
          const rate = h ? h.rate : s.user.shift_rate;
          c.revenue = round2(c.revenue);
          // Отметка в табеле главнее смен: «рабочий» — выход есть, «выходной» — выхода нет.
          c.worked = c.mark?.status === 'work' || (c.mark?.status !== 'off' && c.shifts.length > 0);
          // Заработок за день: своя сумма из табеля или расчёт — ставка за выход + процент от выручки дня.
          // Оклад и бонус за план — в итогах периода.
          c.calc = round2((c.worked ? rate : 0) + c.revenue * s.user.percent / 100);
          c.earned = c.mark?.amount ?? c.calc;
        }
        return { ...s, days };
      });
      return { year: y, month: m + 1, daysInMonth, start, mid, end, today: Date.now(), rows };
    },

    /* ---------- Задания ---------- */
    listTasks({ user, all = false, status }) {
      const where = [], args = [];
      if (!all) { where.push('t.assignee_id = ?'); args.push(user.id); }
      if (status === 'active') where.push("t.status IN ('open', 'returned', 'done')");
      else if (status) { where.push('t.status = ?'); args.push(status); }
      return db.prepare(`SELECT t.*, COALESCE(NULLIF(u.name, ''), u.email) AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE t.status WHEN 'done' THEN 0 WHEN 'returned' THEN 1 WHEN 'open' THEN 2 ELSE 3 END, t.due_at, t.id DESC LIMIT 500`).all(...args);
    },

    // Сколько заданий ждут: у сотрудника — невыполненные, у проверяющего — отмеченные «Выполнено».
    taskCounts(user, reviewer) {
      return {
        mine: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status IN ('open', 'returned')").get(user.id).n,
        review: reviewer ? db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'").get().n : 0,
      };
    },

    // Задание одному или нескольким сотрудникам: каждому — своя копия, отмечают и проверяются отдельно.
    createTasks(input, by) {
      const title = text(input.title, 'Задание', { required: true, max: 200 });
      const description = text(input.description, 'Описание', { max: 2000 });
      const ids = [...new Set((Array.isArray(input.assignees) ? input.assignees : [input.assignees]).map(Number).filter(Boolean))];
      if (!ids.length) throw new UserError('Выберите сотрудников');
      const users = ids.map((id) => this.findUser(id) || (() => { throw new UserError('Сотрудник не найден'); })());
      const period = ['day', 'week', 'month', 'date'].includes(input.period) ? input.period : 'day';
      const now = new Date();
      const due = period === 'day' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
        : period === 'week' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 8 - (now.getDay() || 7)).getTime()
          : period === 'month' ? new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
            : number(input.due_at, 'Срок', { positive: true });
      if (due < Date.now() - 864e5) throw new UserError('Срок уже прошёл');
      const add = db.prepare('INSERT INTO tasks (title, description, assignee_id, period, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      return transaction(db, () => users.map((u) => {
        const { lastInsertRowid } = add.run(title, description, u.id, period, due, by ? by.name || by.email : '', Date.now());
        return { id: Number(lastInsertRowid), title, assignee: u.name || u.email, due_at: due };
      }));
    },

    getTask(id) {
      const t = db.prepare(`SELECT t.*, COALESCE(NULLIF(u.name, ''), u.email) AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?`).get(Number(id));
      if (!t) throw new UserError('Задание не найдено');
      return t;
    },

    // Сотрудник отмечает «Выполнено» (или снимает отметку, пока задание не проверено).
    markTask(id, { done = true, comment }, user, reviewer) {
      const t = this.getTask(id);
      if (t.assignee_id !== user.id && !reviewer) throw new UserError('Это задание другого сотрудника');
      if (t.status === 'approved') throw new UserError('Задание уже проверено и принято');
      if (done) {
        db.prepare("UPDATE tasks SET status = 'done', done_at = ?, done_comment = ? WHERE id = ?").run(Date.now(), text(comment, 'Комментарий', { max: 1000 }), t.id);
      } else {
        if (t.status !== 'done') throw new UserError('Задание не отмечено как выполненное');
        db.prepare("UPDATE tasks SET status = 'open', done_at = NULL, done_comment = '' WHERE id = ?").run(t.id);
      }
      return this.getTask(t.id);
    },

    // Проверка: принять или вернуть на доработку с комментарием.
    reviewTask(id, { approve, comment }, by) {
      const t = this.getTask(id);
      if (t.status !== 'done' && approve !== false) throw new UserError('Сотрудник ещё не отметил задание выполненным');
      if (t.status === 'approved' && approve) throw new UserError('Задание уже принято');
      const note = text(comment, 'Комментарий', { max: 1000 });
      if (!approve && !note) throw new UserError('Напишите, что нужно доделать');
      db.prepare('UPDATE tasks SET status = ?, checked_at = ?, checked_by = ?, check_comment = ? WHERE id = ?')
        .run(approve ? 'approved' : 'returned', Date.now(), by ? by.name || by.email : '', note, t.id);
      return this.getTask(t.id);
    },

    deleteTask(id) {
      const t = this.getTask(id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
      return t;
    },

    // Открытые сейчас смены и деньги на кассе: наличные и безнал по каждому способу оплаты,
    // плюс то же за весь сегодняшний день (включая закрытые смены и чеки без смены).
    cashDesk() {
      const shifts = db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at').all().map((r) => this.getShift(r.id));
      const sumUp = (methods) => {
        const cash = methods.filter((m) => m.kind === 'cash').reduce((s, m) => s + m.sum, 0);
        const all = methods.reduce((s, m) => s + m.sum, 0);
        return { cash: round2(cash), cashless: round2(all - cash), commission: round2(methods.reduce((s, m) => s + (m.commission || 0), 0)) };
      };
      const merged = new Map();
      for (const sh of shifts) {
        for (const m of sh.byMethod) {
          const x = merged.get(m.name) || { name: m.name, kind: m.kind, sum: 0, commission: 0 };
          x.sum = round2(x.sum + m.sum);
          x.commission = round2(x.commission + m.commission);
          merged.set(m.name, x);
        }
      }
      const open = [...merged.values()].sort((a, b) => b.sum - a.sum);
      const d = new Date();
      const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const today = this.reportPayments({ from, to: from + 864e5 }).map((r) => ({ name: r.name, kind: r.kind, sum: r.money, commission: r.commission }));
      const todayCount = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue FROM sales WHERE refunded_at IS NULL AND created_at >= ? AND created_at < ?').get(from, from + 864e5);
      return {
        shifts,
        open: { ...sumUp(open), methods: open, receipts: shifts.reduce((s, x) => s + x.receipts, 0) },
        today: { ...sumUp(today), methods: today, receipts: todayCount.n, revenue: round2(todayCount.revenue) },
      };
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

    // Поиск покупателя на кассе: по телефону (цифры), номеру карты (8 цифр, сканер) или ФИО (без учёта регистра).
    // Точное совпадение карты или телефона — первым.
    searchCustomers(q, limit = 12) {
      const s = String(q ?? '').trim();
      if (!s) return [];
      const digits = s.replace(/\D/g, '');
      const words = s.toLowerCase().split(/\s+/).filter(Boolean);
      const out = new Map();
      if (digits.length >= 3 && digits.length === s.replace(/[\s()+-]/g, '').length) {
        for (const c of db.prepare('SELECT * FROM customers WHERE card = ? OR card LIKE ? OR phone LIKE ? ORDER BY card = ? DESC, created_at DESC LIMIT ?')
          .all(digits, `${digits}%`, `%${digits}%`, digits, limit)) out.set(c.id, c);
      } else {
        // Кириллицу SQLite в нижний регистр не переводит — сравниваем в JS.
        for (const c of db.prepare("SELECT * FROM customers WHERE name <> '' ORDER BY created_at DESC").all()) {
          const n = c.name.toLowerCase();
          if (words.every((w) => n.includes(w))) out.set(c.id, c);
          if (out.size >= limit) break;
        }
      }
      return [...out.values()].map((c) => this.withBirthday(c));
    },

    // Свободный номер карты: 8 цифр, не начинается с нуля.
    newCustomerCard() {
      const taken = db.prepare('SELECT 1 FROM customers WHERE card = ?');
      for (let i = 0; i < 1000; i++) {
        const card = String(10000000 + Math.floor(Math.random() * 90000000));
        if (!taken.get(card)) return card;
      }
      throw new UserError('Не получилось подобрать номер карты');
    },

    findCustomerByPhone(value) {
      const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone(value));
      return c ? this.withBirthday(c) : null;
    },

    // Номер карты пустой — программа выдаёт свой. Пол: m / f / пусто.
    createCustomer(input) {
      const p = phone(input.phone);
      if (db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(p)) throw new UserError('Покупатель с таким телефоном уже есть');
      const card = customerCard(input.card) || this.newCustomerCard();
      if (db.prepare('SELECT 1 FROM customers WHERE card = ?').get(card)) throw new UserError(`Карта ${card} уже выдана другому покупателю`);
      const { lastInsertRowid } = db.prepare('INSERT INTO customers (phone, name, birthday, created_at, card, gender) VALUES (?, ?, ?, ?, ?, ?)')
        .run(p, personName(input.name), birthday(input.birthday), Date.now(), card, gender(input.gender));
      return this.findCustomer(lastInsertRowid);
    },

    updateCustomer(id, input) {
      const c = getCustomer(id);
      const p = input.phone === undefined ? c.phone : phone(input.phone);
      const other = db.prepare('SELECT id FROM customers WHERE phone = ?').get(p);
      if (other && other.id !== c.id) throw new UserError('Покупатель с таким телефоном уже есть');
      const card = input.card === undefined ? c.card : customerCard(input.card);
      if (card && db.prepare('SELECT 1 FROM customers WHERE card = ? AND id <> ?').get(card, c.id)) throw new UserError(`Карта ${card} уже выдана другому покупателю`);
      db.prepare('UPDATE customers SET phone = ?, name = ?, birthday = ?, card = ?, gender = ? WHERE id = ?')
        .run(p, input.name === undefined ? c.name : personName(input.name), input.birthday === undefined ? c.birthday : birthday(input.birthday),
          card, input.gender === undefined ? c.gender : gender(input.gender), c.id);
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
    /* ---------- Документы ---------- */
    docKinds: DOC_KINDS,

    listDocs({ kind, from, to, status }) {
      const where = ['d.doc_date >= ?', 'd.doc_date < ?'], args = [from, to];
      if (kind) { where.push('d.kind = ?'); args.push(kind); }
      if (status) { where.push('d.status = ?'); args.push(status); }
      return db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM doc_items i WHERE i.doc_id = d.id) AS lines,
          COALESCE(s.name, d.supplier_name) AS supplier, COALESCE(NULLIF(c.name, ''), c.phone) AS customer, m.name AS method
        FROM docs d LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN payment_methods m ON m.id = d.method_id
        WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT 500`).all(...args);
    },

    getDoc(id) {
      const d = db.prepare(`SELECT d.*, COALESCE(s.name, d.supplier_name) AS supplier, COALESCE(NULLIF(c.name, ''), c.phone) AS customer, m.name AS method
        FROM docs d LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN payment_methods m ON m.id = d.method_id
        WHERE d.id = ?`).get(Number(id));
      if (!d) throw new UserError('Документ не найден');
      return { ...d, items: db.prepare('SELECT * FROM doc_items WHERE doc_id = ? ORDER BY id').all(d.id) };
    },

    // Черновик: шапка и строки. Проведённый документ менять нельзя — сначала отменить проведение.
    saveDoc(id, input, user = null) {
      const cur = id ? this.getDoc(id) : null;
      if (cur && cur.status === 'posted') throw new UserError('Документ проведён. Чтобы изменить, сначала отметьте «Не проведён»');
      if (cur?.direction === 'in') throw new UserError('Входящее перемещение меняет магазин-отправитель');
      const kind = cur ? cur.kind : input.kind;
      if (!DOC_KINDS[kind]) throw new UserError('Неизвестный вид документа');
      const lines = (Array.isArray(input.items) ? input.items : []).map((item) => {
        const p = getProduct(item.productId);
        if (childrenOf(p.id).length) throw new UserError(`У «${p.name}» есть модификации — выберите нужную`);
        const line = { p, qty: 0, price: kind === 'sale' ? salePrice(p) : p.price, cost: ['purchase', 'receipt'].includes(kind) ? p.purchase ?? p.cost : p.cost, actual: null, reason: '' };
        if (kind === 'inventory') {
          line.actual = item.actual === null || item.actual === undefined || item.actual === '' ? null : number(item.actual, `Факт «${p.name}»`, { min: 0 });
        } else {
          line.qty = number(item.qty ?? 0, `Количество «${p.name}»`, { min: 0 });
        }
        if (['sale', 'return'].includes(kind) && item.price !== undefined) line.price = round2(number(item.price, `Цена «${p.name}»`, { min: 0 }));
        if (['purchase', 'receipt'].includes(kind) && item.cost !== undefined) line.cost = round2(number(item.cost, `Себестоимость «${p.name}»`, { min: 0 }));
        if (kind === 'writeoff') line.reason = text(item.reason, 'Причина', { max: 100 });
        return line;
      });
      const when = input.doc_date ? number(input.doc_date, 'Дата', { positive: true }) : cur?.doc_date || Date.now();
      const supplierId = input.supplier_id ? Number(input.supplier_id) : null;
      if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw new UserError('Поставщик не найден');
      const customerId = input.customer_id ? Number(input.customer_id) : null;
      if (customerId && !this.findCustomer(customerId)) throw new UserError('Покупатель не найден');
      const methodId = input.method_id ? Number(input.method_id) : null;
      const branchTo = input.branch_to ? Number(input.branch_to) : null;
      const amount = (l) => l.qty * (['sale', 'return'].includes(kind) ? l.price : l.cost);
      const total = round2(lines.reduce((s, l) => s + amount(l), 0));
      const totalCost = round2(lines.reduce((s, l) => s + l.qty * l.cost, 0));
      const note = text(input.note, 'Комментарий', { max: 500 });
      return transaction(db, () => {
        let docId = cur?.id;
        if (cur) {
          db.prepare('UPDATE docs SET doc_date = ?, supplier_id = ?, customer_id = ?, method_id = ?, branch_to = ?, note = ?, total = ?, total_cost = ? WHERE id = ?')
            .run(when, supplierId, customerId, methodId, branchTo, note, total, totalCost, docId);
          db.prepare('DELETE FROM doc_items WHERE doc_id = ?').run(docId);
        } else {
          const num = (db.prepare('SELECT MAX(number) AS n FROM docs WHERE kind = ?').get(kind).n || 0) + 1;
          docId = Number(db.prepare(`INSERT INTO docs (kind, number, status, doc_date, created_at, created_by, user_id, supplier_id, customer_id, method_id, branch_to, note, total, total_cost)
            VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, num, when, Date.now(), user ? user.name || user.email : '', user?.id ?? null,
            supplierId, customerId, methodId, branchTo, note, total, totalCost).lastInsertRowid);
        }
        const add = db.prepare('INSERT INTO doc_items (doc_id, product_id, name, unit, qty, price, cost, actual, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const l of lines) add.run(docId, l.p.id, l.p.name, l.p.unit, l.qty, l.price, l.cost, l.actual, l.reason);
        return this.getDoc(docId);
      });
    },

    // Проведение: остатки (и для продажи — чек) меняются. Отмена проведения возвращает всё как было.
    postDoc(id, user = null) {
      const d = this.getDoc(id);
      if (d.status === 'posted') throw new UserError('Документ уже проведён');
      const who = user ? user.name || user.email : '';
      const items = d.kind === 'inventory' ? d.items.filter((i) => i.actual !== null) : d.items.filter((i) => i.qty > 0);
      if (!items.length) throw new UserError(d.kind === 'inventory' ? 'Не посчитано ни одного товара' : 'В документе нет товаров с количеством');
      if (d.kind === 'transfer' && !d.branch_to) throw new UserError('Выберите магазин, куда перемещаете товар');
      if (d.kind === 'return' && !d.method_id) throw new UserError('Выберите, как вернули деньги');
      return transaction(db, () => {
        const extra = {};
        const exists = (pid) => getProduct(pid).id;
        if (d.kind === 'sale') {
          const sale = this.createSale({ items: items.map((i) => ({ productId: i.product_id, qty: i.qty, price: i.price })), methodId: d.method_id, customerId: d.customer_id, at: d.doc_date },
            user, { trustPrices: true });
          extra.sale_id = sale.id;
        } else if (d.kind === 'purchase') {
          // Цена закупки — средневзвешенная по остатку и новой партии. Себестоимость сдвигается вместе с ней:
          // расходы на единицу сверх закупки (доставка, налоги…) сохраняются.
          for (const i of items) {
            const p = getProduct(i.product_id);
            const old = Math.max(0, p.stock);
            const oldPurchase = p.purchase ?? p.cost;
            const purchase = old > 0 ? round2((old * oldPurchase + i.qty * i.cost) / (old + i.qty)) : i.cost;
            const cost = round2(purchase + Math.max(0, p.cost - oldPurchase));
            db.prepare('UPDATE doc_items SET prev_cost = ?, prev_purchase = ? WHERE id = ?').run(p.cost, oldPurchase, i.id);
            db.prepare('UPDATE products SET stock = stock + ?, cost = ?, purchase = ?, supplier_id = COALESCE(supplier_id, ?) WHERE id = ?').run(i.qty, cost, purchase, d.supplier_id, p.id);
          }
        } else if (['receipt', 'return'].includes(d.kind)) {
          for (const i of items) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(i.qty, exists(i.product_id));
        } else if (['writeoff', 'transfer'].includes(d.kind)) {
          for (const i of items) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(i.qty, exists(i.product_id));
          if (d.kind === 'transfer') {
            if (!branchLink) throw new UserError('Перемещение возможно, когда есть второй магазин');
            extra.link_doc_id = branchLink.send(d.branch_to, { fromDoc: d.id, number: d.number, note: d.note, items: items.map((i) => {
              const p = getProduct(i.product_id);
              return { qty: i.qty, product: { name: p.name, barcode: p.barcode, code: p.code, unit: p.unit, price: p.price, cost: p.cost, purchase: p.purchase, article: p.article, category: p.category } };
            }) }, user);
          }
        } else if (d.kind === 'inventory') {
          let shortage = 0, surplus = 0;
          for (const i of items) {
            const p = getProduct(i.product_id);
            const diff = round2(i.actual - p.stock);
            db.prepare('UPDATE doc_items SET expected = ?, qty = ?, cost = ?, price = ? WHERE id = ?').run(p.stock, diff, p.cost, p.price, i.id);
            db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(i.actual, p.id);
            if (diff < 0) shortage -= diff * p.cost; else surplus += diff * p.cost;
          }
          Object.assign(extra, { shortage_cost: round2(shortage), surplus_cost: round2(surplus), total_cost: round2(surplus - shortage) });
        }
        const sets = Object.keys(extra).map((k) => `${k} = ?`);
        db.prepare(`UPDATE docs SET status = 'posted', posted_at = ?, posted_by = ?${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = ?`)
          .run(Date.now(), who, ...Object.values(extra), d.id);
        return this.getDoc(d.id);
      });
    },

    unpostDoc(id, user = null) {
      const d = this.getDoc(id);
      if (d.status !== 'posted') throw new UserError('Документ и так не проведён');
      if (d.direction === 'in') throw new UserError('Входящее перемещение отменяет магазин-отправитель');
      return transaction(db, () => {
        const add = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
        const exists = (pid) => db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
        if (d.kind === 'sale') {
          if (d.sale_id && db.prepare('SELECT 1 FROM sales WHERE id = ?').get(d.sale_id)) this.deleteSales({ ids: [d.sale_id], restock: true }, user);
        } else if (d.kind === 'purchase') {
          for (const i of d.items) {
            if (!exists(i.product_id) || !(i.qty > 0)) continue;
            add.run(-i.qty, i.product_id);
            // Себестоимость возвращается, только если после этой закупки товар больше не закупали.
            const later = db.prepare(`SELECT 1 FROM docs dd JOIN doc_items ii ON ii.doc_id = dd.id WHERE dd.kind = 'purchase' AND dd.status = 'posted' AND dd.posted_at > ? AND ii.product_id = ?`).get(d.posted_at || 0, i.product_id);
            if (!later && i.prev_cost !== null) db.prepare('UPDATE products SET cost = ?, purchase = COALESCE(?, purchase) WHERE id = ?').run(i.prev_cost, i.prev_purchase, i.product_id);
          }
        } else if (['receipt', 'return'].includes(d.kind)) {
          for (const i of d.items) if (exists(i.product_id) && i.qty > 0) add.run(-i.qty, i.product_id);
        } else if (['writeoff', 'transfer'].includes(d.kind)) {
          for (const i of d.items) if (exists(i.product_id) && i.qty > 0) add.run(i.qty, i.product_id);
          if (d.kind === 'transfer' && d.link_doc_id && branchLink) branchLink.cancel(d.branch_to, d.link_doc_id);
        } else if (d.kind === 'inventory') {
          for (const i of d.items) if (exists(i.product_id) && i.actual !== null) add.run(-i.qty, i.product_id);
        }
        db.prepare("UPDATE docs SET status = 'draft', posted_at = NULL, posted_by = '', sale_id = NULL, link_doc_id = NULL WHERE id = ?").run(d.id);
        return this.getDoc(d.id);
      });
    },

    deleteDoc(id) {
      const d = this.getDoc(id);
      if (d.status === 'posted') throw new UserError('Проведённый документ не удаляется — сначала отметьте «Не проведён»');
      db.prepare('DELETE FROM doc_items WHERE doc_id = ?').run(d.id);
      db.prepare('DELETE FROM docs WHERE id = ?').run(d.id);
      return d;
    },

    // Перемещение из другого магазина: товар находится по штрихкоду, коду или названию, а если его нет — заводится.
    receiveTransfer({ fromBranch, fromName, fromDoc, number: num, note, items }, user = null) {
      return transaction(db, () => {
        const lines = items.map((i) => {
          let p = this.findSameProduct(i.product);
          if (!p) {
            const made = this.createProduct({ name: i.product.name, price: i.product.price, cost: i.product.cost, purchase: i.product.purchase, article: i.product.article,
              unit: i.product.unit, barcode: i.product.barcode, code: i.product.code, category: i.product.category, stock: 0 });
            p = getProduct(made.id);
          }
          return { p, qty: i.qty };
        });
        const num2 = (db.prepare("SELECT MAX(number) AS n FROM docs WHERE kind = 'transfer'").get().n || 0) + 1;
        const who = user ? user.name || user.email : '';
        const docId = Number(db.prepare(`INSERT INTO docs (kind, number, status, doc_date, created_at, created_by, posted_at, posted_by, branch_from, direction, link_doc_id, note, total, total_cost)
          VALUES ('transfer', ?, 'posted', ?, ?, ?, ?, ?, ?, 'in', ?, ?, ?, ?)`).run(num2, Date.now(), Date.now(), who, Date.now(), who, fromBranch, fromDoc,
          `Из «${fromName}», перемещение №${num}${note ? ' · ' + note : ''}`,
          round2(lines.reduce((s, l) => s + l.qty * l.p.price, 0)), round2(lines.reduce((s, l) => s + l.qty * l.p.cost, 0))).lastInsertRowid);
        const add = db.prepare('INSERT INTO doc_items (doc_id, product_id, name, unit, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const l of lines) {
          add.run(docId, l.p.id, l.p.name, l.p.unit, l.qty, l.p.price, l.p.cost);
          db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(l.qty, l.p.id);
        }
        return docId;
      });
    },

    cancelTransfer(docId) {
      const d = db.prepare("SELECT * FROM docs WHERE id = ? AND direction = 'in'").get(Number(docId));
      if (!d) return;
      transaction(db, () => {
        for (const i of db.prepare('SELECT * FROM doc_items WHERE doc_id = ?').all(d.id)) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(i.qty, i.product_id);
        db.prepare('DELETE FROM doc_items WHERE doc_id = ?').run(d.id);
        db.prepare('DELETE FROM docs WHERE id = ?').run(d.id);
      });
    },

    // Связь с другими магазинами для перемещений; задаёт сервер, когда магазинов больше одного.
    setBranchLink(link) { branchLink = link; },

    // Потери от списаний за период по причинам (только проведённые).
    writeoffSummary({ from, to }) {
      return db.prepare(`SELECT i.reason, COUNT(*) AS lines, SUM(i.qty * i.cost) AS cost, SUM(i.qty * i.price) AS price
        FROM doc_items i JOIN docs d ON d.id = i.doc_id WHERE d.kind = 'writeoff' AND d.status = 'posted' AND d.doc_date >= ? AND d.doc_date < ?
        GROUP BY i.reason ORDER BY cost DESC`).all(from, to).map((r) => ({ ...r, cost: round2(r.cost), price: round2(r.price) }));
    },

    /* ---------- Кассы ---------- */
    listRegisters({ all = false } = {}) {
      return db.prepare(`SELECT * FROM registers ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all().map((r) => ({ ...r, active: Boolean(r.active) }));
    },

    // Кассы с тем, кто сейчас на них работает, и выручкой за сегодня.
    registersOverview() {
      const d = new Date();
      const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return this.listRegisters({ all: true }).map((r) => {
        const open = db.prepare('SELECT id FROM shifts WHERE register_id = ? AND closed_at IS NULL ORDER BY opened_at').all(r.id).map((x) => this.getShift(x.id));
        const today = db.prepare(`SELECT COUNT(DISTINCT s.id) AS receipts, COALESCE(SUM(s.total), 0) AS revenue FROM sales s JOIN shifts sh ON sh.id = s.shift_id
          WHERE sh.register_id = ? AND s.refunded_at IS NULL AND s.created_at >= ?`).get(r.id, from);
        return { ...r, open: open.map((s) => ({ user: s.user_name, since: s.opened_at, revenue: s.revenue, cash: s.cash, card: s.card })), today: { receipts: today.receipts, revenue: round2(today.revenue) } };
      });
    },

    saveRegister(id, input) {
      const name = text(input.name, 'Название кассы', { required: true, max: 60 });
      if (id) {
        const cur = db.prepare('SELECT * FROM registers WHERE id = ?').get(Number(id));
        if (!cur) throw new UserError('Касса не найдена');
        const active = input.active === undefined ? cur.active : input.active ? 1 : 0;
        if (!active && cur.active && db.prepare('SELECT COUNT(*) AS n FROM registers WHERE active = 1').get().n <= 1) throw new UserError('Должна остаться хотя бы одна касса');
        if (!active && db.prepare('SELECT 1 FROM shifts WHERE register_id = ? AND closed_at IS NULL').get(cur.id)) throw new UserError('На этой кассе открыта смена — сначала закройте её');
        db.prepare('UPDATE registers SET name = ?, active = ? WHERE id = ?').run(name, active, cur.id);
        return db.prepare('SELECT * FROM registers WHERE id = ?').get(cur.id);
      }
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM registers').get().m || 0) + 1;
      const { lastInsertRowid } = db.prepare('INSERT INTO registers (name, sort, created_at) VALUES (?, ?, ?)').run(name, sort, Date.now());
      return db.prepare('SELECT * FROM registers WHERE id = ?').get(lastInsertRowid);
    },

    /* ---------- Счета ---------- */
    // Остаток каждого счёта и движение денег за период.
    accounts({ from, to }) {
      const sumIn = (sql, ...args) => db.prepare(sql).get(...args).v || 0;
      const methods = this.listPaymentMethods({ all: true });
      return methods.map((m) => {
        const flows = (a, b) => ({
          sales: sumIn(`SELECT SUM(sp.amount) AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE sp.method_id = ? AND s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`, m.id, a, b),
          commission: sumIn(`SELECT SUM(sp.commission) AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE sp.method_id = ? AND s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`, m.id, a, b),
          returns: sumIn(`SELECT SUM(total) AS v FROM docs WHERE kind = 'return' AND status = 'posted' AND method_id = ? AND doc_date >= ? AND doc_date < ?`, m.id, a, b),
          purchases: sumIn(`SELECT SUM(total) AS v FROM docs WHERE kind = 'purchase' AND status = 'posted' AND method_id = ? AND doc_date >= ? AND doc_date < ?`, m.id, a, b),
          ops: sumIn('SELECT SUM(amount) AS v FROM account_ops WHERE method_id = ? AND at >= ? AND at < ?', m.id, a, b),
          expenses: sumIn('SELECT SUM(amount) AS v FROM expenses WHERE method_id = ? AND at >= ? AND at < ?', m.id, a, b),
          certificates: sumIn('SELECT SUM(cp.amount - cp.commission) AS v FROM certificate_payments cp JOIN certificates c ON c.id = cp.certificate_id WHERE cp.method_id = ? AND c.sold_at >= ? AND c.sold_at < ?', m.id, a, b),
        });
        const all = flows(0, 8.64e15);
        const period = flows(from, to);
        const net = (f) => round2(f.sales - f.commission - f.returns - f.purchases - f.expenses + f.ops + f.certificates);
        return { id: m.id, name: m.name, kind: m.kind, active: m.active, commission: m.commission, opening: m.opening_balance,
          balance: round2(m.opening_balance + net(all)), period: { ...Object.fromEntries(Object.entries(period).map(([k, v]) => [k, round2(v)])), net: net(period) } };
      });
    },

    accountOps({ from, to }) {
      return db.prepare(`SELECT o.*, m.name AS account FROM account_ops o LEFT JOIN payment_methods m ON m.id = o.method_id
        WHERE o.at >= ? AND o.at < ? ORDER BY o.at DESC LIMIT 300`).all(from, to);
    },

    // Внесение, изъятие или перевод между счетами (например, инкассация из кассы на банковский счёт).
    addAccountOp({ method_id: methodId, kind, amount, to_method_id: toId, note }, user = null) {
      const m = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(methodId));
      if (!m) throw new UserError('Счёт не найден');
      if (!['deposit', 'withdraw', 'transfer'].includes(kind)) throw new UserError('Неизвестная операция');
      const sum = round2(number(amount, 'Сумма', { positive: true }));
      const why = text(note, 'Комментарий', { max: 300 });
      if (kind !== 'deposit' && !why) throw new UserError(kind === 'withdraw' ? 'Напишите, на что взяли деньги' : 'Напишите комментарий к переводу');
      const who = user ? user.name || user.email : '';
      const add = db.prepare('INSERT INTO account_ops (method_id, at, amount, kind, note, pair_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
      return transaction(db, () => {
        if (kind === 'transfer') {
          const to = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(toId));
          if (!to || to.id === m.id) throw new UserError('Выберите другой счёт, куда переводите');
          const out = Number(add.run(m.id, Date.now(), -sum, 'transfer', `→ ${to.name}${why ? ': ' + why : ''}`, null, who).lastInsertRowid);
          const inn = Number(add.run(to.id, Date.now(), sum, 'transfer', `← ${m.name}${why ? ': ' + why : ''}`, out, who).lastInsertRowid);
          db.prepare('UPDATE account_ops SET pair_id = ? WHERE id = ?').run(inn, out);
          return { account: m.name, to: to.name, amount: sum, kind };
        }
        add.run(m.id, Date.now(), kind === 'deposit' ? sum : -sum, kind, why, null, who);
        return { account: m.name, amount: sum, kind };
      });
    },

    deleteAccountOp(id) {
      const o = db.prepare('SELECT * FROM account_ops WHERE id = ?').get(Number(id));
      if (!o) throw new UserError('Операция не найдена');
      // Перевод — две записи (списание и зачисление), удаляются вместе.
      db.prepare('DELETE FROM account_ops WHERE id IN (?, ?)').run(o.id, o.pair_id ?? o.id);
      return o;
    },

    setOpeningBalance(id, amount) {
      const m = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(id));
      if (!m) throw new UserError('Счёт не найден');
      db.prepare('UPDATE payment_methods SET opening_balance = ? WHERE id = ?').run(round2(number(amount, 'Начальный остаток')), m.id);
      return { name: m.name, opening: round2(number(amount, 'Начальный остаток')) };
    },

    /* ---------- Подарочные сертификаты ---------- */
    certificateSettings() {
      return { months: Number(this.setting('cert_months', '12')) || 0 };
    },
    setCertificateSettings(input) {
      const months = Math.round(number(input.months ?? 12, 'Срок действия, месяцев'));
      if (months > 120) throw new UserError('Срок — не больше 10 лет');
      this.setSetting('cert_months', String(months));
      return this.certificateSettings();
    },

    // Свободный номер: EAN-13 с префиксом 299 — печатается штрихкодом и не путается с картами покупателей (8 цифр).
    newCertificateNumber() {
      const taken = db.prepare('SELECT 1 FROM certificates WHERE number = ?');
      for (let i = 0; i < 1000; i++) {
        const code = ean13('299' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'));
        if (!taken.get(code)) return code;
      }
      throw new UserError('Не получилось подобрать номер сертификата');
    },

    // Сертификат с покупателем и состоянием: active / used (остаток 0) / expired / blocked.
    getCertificate(numberOrId, { byId = false } = {}) {
      const c = db.prepare(`SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone, cu.card AS customer_card
        FROM certificates c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE ${byId ? 'c.id = ?' : 'c.number = ?'}`).get(byId ? Number(numberOrId) : String(numberOrId ?? '').trim());
      if (!c) return null;
      const state = c.status === 'blocked' ? 'blocked' : c.balance <= 0.004 ? 'used' : c.expires_at && c.expires_at < Date.now() ? 'expired' : 'active';
      return { ...c, state };
    },

    usableCertificate(num) {
      const c = this.getCertificate(num);
      if (!c) throw new UserError('Сертификат с таким номером не найден');
      if (c.state === 'blocked') throw new UserError(`Сертификат №${c.number} заблокирован`);
      if (c.state === 'used') throw new UserError(`Сертификат №${c.number} уже потрачен полностью`);
      if (c.state === 'expired') throw new UserError(`Срок сертификата №${c.number} истёк ${new Date(c.expires_at).toLocaleDateString('ru-RU')}`);
      return c;
    },

    // Продажа сертификата: покупатель обязателен (он появляется в «Клиентах»), деньги — способом оплаты на счёт.
    sellCertificate({ number: num, amount, customerId, methodId, payments, note }, user = null) {
      const sum = round2(number(amount, 'Сумма сертификата', { positive: true }));
      if (sum > 1e6) throw new UserError('Слишком большая сумма сертификата');
      const code = String(num ?? '').trim() || this.newCertificateNumber();
      if (!/^[0-9A-Za-z-]{4,32}$/.test(code)) throw new UserError('Номер сертификата — от 4 до 32 цифр или букв');
      if (db.prepare('SELECT 1 FROM certificates WHERE number = ?').get(code)) throw new UserError(`Сертификат №${code} уже продан`);
      const customer = customerId ? this.findCustomer(customerId) : null;
      if (!customer) throw new UserError('Выберите покупателя или заведите нового — сертификат записывается на него');
      let parts = [{ method: this.paymentMethodFor(methodId, null, user), amount: sum }];
      if (Array.isArray(payments) && payments.length) {
        parts = payments.map((x) => ({ method: this.paymentMethodFor(x.methodId, null, user), amount: x.amount === null || x.amount === undefined || x.amount === '' ? null : round2(number(x.amount, 'Сумма оплаты')) }));
        const open = parts.filter((x) => x.amount === null);
        if (open.length > 1) throw new UserError('Укажите сумму для всех способов, кроме одного');
        if (open.length) open[0].amount = round2(sum - parts.reduce((s, x) => s + (x.amount || 0), 0));
        parts = parts.filter((x) => x.amount > 0);
        if (Math.abs(parts.reduce((s, x) => s + x.amount, 0) - sum) > 0.01) throw new UserError('Части оплаты не сходятся с суммой сертификата');
      }
      const months = this.certificateSettings().months;
      const exp = months ? new Date() : null;
      if (exp) { exp.setMonth(exp.getMonth() + months); exp.setHours(23, 59, 59, 999); }
      const who = user ? user.name || user.email : '';
      return transaction(db, () => {
        const id = Number(db.prepare(`INSERT INTO certificates (number, amount, balance, customer_id, sold_at, expires_at, user_id, user_name, shift_id, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, sum, sum, customer.id, Date.now(), exp ? exp.getTime() : null, user?.id ?? null, who,
          user ? this.currentShift(user.id)?.id ?? null : null, text(note, 'Комментарий', { max: 200 })).lastInsertRowid);
        const add = db.prepare('INSERT INTO certificate_payments (certificate_id, method_id, method_name, kind, amount, commission) VALUES (?, ?, ?, ?, ?, ?)');
        for (const x of parts) add.run(id, x.method.id, x.method.name, x.method.kind, x.amount, round2(x.amount * (x.method.commission || 0) / 100));
        db.prepare("INSERT INTO certificate_ops (certificate_id, at, kind, amount, user_name, note) VALUES (?, ?, 'sale', ?, ?, ?)")
          .run(id, Date.now(), sum, who, parts.map((x) => `${x.method.name} ${x.amount}`).join(' + '));
        return this.getCertificate(id, { byId: true });
      });
    },

    // Возврат или удаление чека, оплаченного сертификатом: сумма возвращается на сертификат.
    returnToCertificates(saleId, reason, who = '') {
      for (const p of db.prepare("SELECT * FROM sale_payments WHERE sale_id = ? AND kind = 'certificate' AND certificate_id IS NOT NULL").all(saleId)) {
        db.prepare('UPDATE certificates SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(p.amount, p.certificate_id);
        db.prepare("INSERT INTO certificate_ops (certificate_id, at, kind, amount, sale_id, user_name, note) VALUES (?, ?, 'refund', ?, ?, ?, ?)")
          .run(p.certificate_id, Date.now(), p.amount, saleId, who, reason);
      }
    },

    listCertificates({ q = '', state = '' } = {}) {
      const s = String(q).trim().toLowerCase();
      const digits = s.replace(/\D/g, '');
      return db.prepare(`SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone FROM certificates c LEFT JOIN customers cu ON cu.id = c.customer_id
        ORDER BY c.sold_at DESC LIMIT 2000`).all()
        .map((c) => this.getCertificate(c.id, { byId: true }))
        .filter((c) => (!state || c.state === state) && (!s || c.number.includes(s) || (c.customer_name || '').toLowerCase().includes(s) || (digits.length >= 3 && (c.customer_phone || '').includes(digits))));
    },

    certificateHistory(id) {
      const c = this.getCertificate(id, { byId: true });
      if (!c) throw new UserError('Сертификат не найден');
      return { ...c, ops: db.prepare('SELECT * FROM certificate_ops WHERE certificate_id = ? ORDER BY at DESC, id DESC').all(c.id),
        payments: db.prepare('SELECT method_name, amount, commission FROM certificate_payments WHERE certificate_id = ?').all(c.id) };
    },

    setCertificateBlocked(id, blocked, user = null, note = '') {
      const c = this.getCertificate(id, { byId: true });
      if (!c) throw new UserError('Сертификат не найден');
      db.prepare('UPDATE certificates SET status = ? WHERE id = ?').run(blocked ? 'blocked' : 'active', c.id);
      db.prepare('INSERT INTO certificate_ops (certificate_id, at, kind, amount, user_name, note) VALUES (?, ?, ?, 0, ?, ?)')
        .run(c.id, Date.now(), blocked ? 'block' : 'unblock', user ? user.name || user.email : '', text(note, 'Причина', { max: 200 }));
      return this.getCertificate(c.id, { byId: true });
    },

    // Для главной: продано сертификатов и потрачено по ним за период, не потрачено сейчас (действующие).
    certificateStats({ from, to }) {
      const sold = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS v FROM certificates WHERE sold_at >= ? AND sold_at < ?').get(from, to);
      const redeemed = db.prepare(`SELECT COALESCE(SUM(sp.amount), 0) AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE sp.kind = 'certificate' AND s.refunded_at IS NULL AND s.created_at >= ? AND s.created_at < ?`).get(from, to).v;
      const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS v FROM certificates WHERE status = 'active' AND balance > 0 AND (expires_at IS NULL OR expires_at >= ?)").get(Date.now());
      return { soldCount: sold.n, sold: round2(sold.v), redeemed: round2(redeemed), openCount: open.n, outstanding: round2(open.v) };
    },

    /* ---------- Расходы ---------- */
    expenseCategories: EXPENSE_CATEGORIES,

    listExpenses({ from, to }) {
      return db.prepare(`SELECT e.*, m.name AS account FROM expenses e LEFT JOIN payment_methods m ON m.id = e.method_id
        WHERE e.at >= ? AND e.at < ? ORDER BY e.at DESC, e.id DESC LIMIT 500`).all(from, to);
    },

    addExpense(input, user = null) {
      const category = text(input.category, 'Статья расхода', { required: true, max: 60 });
      const amount = round2(number(input.amount, 'Сумма', { positive: true }));
      const at = input.at ? number(input.at, 'Дата', { positive: true }) : Date.now();
      const methodId = input.method_id ? Number(input.method_id) : null;
      if (methodId && !db.prepare('SELECT 1 FROM payment_methods WHERE id = ?').get(methodId)) throw new UserError('Счёт не найден');
      const { lastInsertRowid } = db.prepare('INSERT INTO expenses (at, category, amount, note, method_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(at, category, amount, text(input.note, 'Комментарий', { max: 300 }), methodId, user ? user.name || user.email : '', Date.now());
      return db.prepare('SELECT * FROM expenses WHERE id = ?').get(lastInsertRowid);
    },

    deleteExpense(id) {
      const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(id));
      if (!e) throw new UserError('Расход не найден');
      db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
      return e;
    },

    // Расходы для чистой прибыли за период: зарплата (по расчёту ведомости), внесённые расходы
    // по статьям и потери от списаний. Выручку и закупку главная считает сама по строкам продаж.
    // Зарплата — по ведомости каждого сотрудника: ставка × выходы (двое на смене — две ставки),
    // оклад за долю месяца, свой процент от продаж, бонусы минус штрафы. Период доводится до конца дня,
    // чтобы оклад за сегодня считался за целый день, как и постоянные расходы.
    finance({ from, to }) {
      const dayEnd = new Date(to - 1);
      dayEnd.setHours(24, 0, 0, 0);
      const payroll = this.kpi({ from, to: Math.max(to, dayEnd.getTime()) }).staff.filter((r) => r.user && (r.pay || r.shifts || r.salary || r.bonus));
      const staff = payroll.map((r) => ({ name: r.user.name || r.user.email, shifts: r.shifts, salary: r.salary, bonus: round2(r.bonus + r.planBonus + r.extra), fines: r.fines, pay: r.pay, percent: r.user.percent || 0 }));
      const recurring = this.listRecurring().filter((r) => r.active).map((r) => {
        const { share, days } = dayShare(from, to, r.since);
        return { id: r.id, name: r.name, monthly: r.amount, amount: round2(r.amount * share), days };
      }).filter((r) => r.amount > 0);
      const expenses = db.prepare('SELECT category, SUM(amount) AS amount, COUNT(*) AS n FROM expenses WHERE at >= ? AND at < ? GROUP BY category ORDER BY amount DESC')
        .all(from, to).map((r) => ({ ...r, amount: round2(r.amount) }));
      const writeoffs = round2(this.writeoffSummary({ from, to }).reduce((sum, r) => sum + r.cost, 0));
      const salary = round2(staff.reduce((sum, r) => sum + r.pay, 0));
      const fixed = round2(recurring.reduce((sum, r) => sum + r.amount, 0));
      const other = round2(expenses.reduce((sum, r) => sum + r.amount, 0));
      return { salary, staff, recurring, fixed, expenses, other, writeoffs, total: round2(salary + fixed + other + writeoffs), certificates: this.certificateStats({ from, to }) };
    },

    // Правка табеля для одного или многих дней сразу. cells — [{ user_id, day: 'ГГГГ-ММ-ДД' }].
    // Меняется только то, что передано: status ('work' | 'off' | '' — как по сменам), amount (число или null —
    // вернуть расчёт), color, note. clear — убрать все правки с этих дней.
    setTimesheetMarks({ cells, status, amount, color, note, clear = false }, by = null) {
      if (!Array.isArray(cells) || !cells.length) throw new UserError('Выберите дни в табеле');
      if (cells.length > 3000) throw new UserError('Слишком много дней за раз');
      if (status !== undefined && !['work', 'off', '', null].includes(status)) throw new UserError('Неизвестная отметка');
      if (color !== undefined && !TS_COLORS.includes(color || '')) throw new UserError('Неизвестный цвет');
      const sum = amount === undefined || amount === null || amount === '' ? amount === undefined ? undefined : null : round2(number(amount, 'Сумма за день'));
      const why = note === undefined ? undefined : text(note, 'Комментарий', { max: 200 });
      const who = by ? by.name || by.email : '';
      const users = new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));
      return transaction(db, () => {
        const get = db.prepare('SELECT * FROM timesheet_marks WHERE user_id = ? AND day = ?');
        const put = db.prepare(`INSERT INTO timesheet_marks (user_id, day, status, amount, color, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, day) DO UPDATE SET status = excluded.status, amount = excluded.amount, color = excluded.color, note = excluded.note,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
        const del = db.prepare('DELETE FROM timesheet_marks WHERE user_id = ? AND day = ?');
        let count = 0;
        for (const c of cells) {
          const userId = Number(c.user_id);
          const day = String(c.day || '');
          if (!users.has(userId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserError('Неверный день или сотрудник');
          count++;
          if (clear) { del.run(userId, day); continue; }
          const cur = get.get(userId, day) || { status: null, amount: null, color: '', note: '' };
          const next = {
            status: status === undefined ? cur.status : status || null,
            amount: sum === undefined ? cur.amount : sum,
            color: color === undefined ? cur.color : color || '',
            note: why === undefined ? cur.note : why,
          };
          if (!next.status && next.amount === null && !next.color && !next.note) del.run(userId, day);
          else put.run(userId, day, next.status, next.amount, next.color, next.note, who, Date.now());
        }
        return { count, status, amount: sum, color, clear };
      });
    },

    /* ---------- Приход по накладной (фото) ---------- */
    // Подбирает товар в базе к строке накладной: штрихкод, артикул, код, точное название, похожее название.
    matchInvoiceLines(lines) {
      const all = db.prepare(`SELECT id, name, code, barcode, article, unit, price, cost, COALESCE(purchase, cost) AS purchase FROM products p
        WHERE deleted = 0 AND NOT EXISTS (SELECT 1 FROM products c WHERE c.parent_id = p.id AND c.deleted = 0)`).all();
      // «95г» и «95 г», «Кофе,растворимый» и «кофе растворимый» — одно и то же.
      const norm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/(\d)([a-zа-я])/gi, '$1 $2').replace(/([a-zа-я])(\d)/gi, '$1 $2')
        .replace(/[^a-zа-я0-9%.,]+/gi, ' ').replace(/\s+/g, ' ').trim();
      // Слова без единиц измерения; «гр» = «г». Сокращение («раствор.») совпадает с началом слова.
      const UNITS = new Set(['г', 'гр', 'кг', 'л', 'мл', 'шт', 'уп', 'м', 'см', 'мм', 'pcs', 'g', 'kg', 'ml']);
      const words = (v) => new Set(norm(v).replace(/[.,]+(\s|$)/g, ' ').split(' ').filter((w) => w && !UNITS.has(w) && (w.length > 1 || /\d/.test(w))));
      const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
      const prepared = all.map((p) => ({ p, n: norm(p.name), w: words(p.name) }));
      return lines.map((l) => {
        const bc = String(l.barcode || '').replace(/\D/g, '');
        const art = norm(l.article);
        let hit = bc.length >= 8 && all.find((p) => p.barcode === bc);
        let how = hit ? 'штрихкод' : '';
        if (!hit && art) { hit = all.find((p) => (p.article && norm(p.article) === art) || (p.code && norm(p.code) === art)); how = hit ? 'артикул' : ''; }
        if (!hit) { const n = norm(l.name); hit = prepared.find((x) => x.n === n)?.p; how = hit ? 'название' : ''; }
        if (!hit) {
          // Похожее название: доля общих слов (Жаккар). Ниже 0.6 — считаем новым товаром.
          const lw = words(l.name);
          let best = null, score = 0;
          for (const x of prepared) {
            let common = 0;
            for (const w of lw) if (x.w.has(w) || [...x.w].some((w2) => same(w, w2))) common++;
            const sc = common / (lw.size + x.w.size - common || 1);
            if (sc > score) { score = sc; best = x.p; }
          }
          if (score >= 0.6) { hit = best; how = `похоже на ${Math.round(score * 100)}%`; }
        }
        return hit ? { product: hit, how } : { product: null, how: '' };
      });
    },

    // Приход по накладной: цены из валюты накладной переводятся в сомы по курсу, доп. расходы
    // (зарплата, доставка…) делятся по строкам пропорционально сумме и входят в себестоимость.
    // Новые товары заводятся, документ «Закупка» создаётся и, если post, проводится.
    // lines — [{ product_id | null, name, category, unit, barcode, article, qty, price_cur, price (продажи) }].
    receiveInvoice(input, user = null) {
      const currency = ['USD', 'KGS', 'RUB', 'CNY', 'KZT', 'EUR'].includes(input.currency) ? input.currency : 'KGS';
      const rate = currency === 'KGS' ? 1 : number(input.rate, 'Курс', { positive: true });
      const lines = Array.isArray(input.lines) ? input.lines.filter((l) => l && Number(l.qty) > 0) : [];
      if (!lines.length) throw new UserError('В накладной нет строк с количеством');
      if (lines.length > 500) throw new UserError('Слишком много строк за раз');
      const extras = (Array.isArray(input.extras) ? input.extras : [])
        .map((e) => ({ name: text(e.name, 'Расход', { max: 60 }) || 'Доп. расход', amount: round2(number(e.amount || 0, 'Сумма расхода')) }))
        .filter((e) => e.amount > 0);
      const extrasTotal = round2(extras.reduce((s, e) => s + e.amount, 0));
      const prepared = lines.map((l, i) => {
        const qty = number(l.qty, `Количество в строке ${i + 1}`, { positive: true });
        const priceCur = number(l.price_cur ?? 0, `Цена в строке ${i + 1}`);
        const purchase = round2(priceCur * rate);
        const sale = round2(number(l.price ?? 0, `Цена продажи в строке ${i + 1}`));
        const p = l.product_id ? getProduct(l.product_id) : null;
        if (p && childrenOf(p.id).length) throw new UserError(`У «${p.name}» есть модификации — выберите нужную`);
        return { l, p, qty, purchase, sale, sum: purchase * qty };
      });
      const total = prepared.reduce((s, x) => s + x.sum, 0);
      for (const x of prepared) x.extra = total > 0 ? round2(extrasTotal * (x.sum / total) / x.qty) : 0;
      const when = input.date ? number(input.date, 'Дата', { positive: true }) : Date.now();
      const num = text(input.number, 'Номер накладной', { max: 40 });
      return transaction(db, () => {
        let supplierId = input.supplier_id ? Number(input.supplier_id) : null;
        const supplierName = text(input.supplier_name, 'Поставщик', { max: 120 });
        if (!supplierId && supplierName) {
          const found = db.prepare('SELECT id, name FROM suppliers').all().find((s) => s.name.toLowerCase() === supplierName.toLowerCase());
          supplierId = found ? found.id : this.saveSupplier(null, { name: supplierName }).id;
        }
        let created = 0;
        for (const x of prepared) {
          if (x.p) continue;
          const name = text(x.l.name, 'Название товара', { required: true });
          x.p = this.createProduct({ name, category: x.l.category || '', unit: x.l.unit || 'шт', barcode: String(x.l.barcode || '').replace(/\D/g, '').slice(0, 64),
            article: x.l.article || '', purchase: x.purchase, cost: round2(x.purchase + x.extra), price: x.sale, supplier_id: supplierId, stock: 0 });
          x.isNew = true;
          created++;
        }
        const rateNote = currency === 'KGS' ? '' : `курс 1 ${currency} = ${rate} сом`;
        const note = [num ? `Накладная №${num}` : 'Приход по фото накладной', rateNote,
          extras.length ? `доп. расходы: ${extras.map((e) => `${e.name} ${e.amount}`).join(', ')}` : ''].filter(Boolean).join(' · ');
        const doc = this.saveDoc(null, { kind: 'purchase', supplier_id: supplierId, doc_date: when, note: note.slice(0, 500),
          items: prepared.map((x) => ({ productId: x.p.id, qty: x.qty, cost: x.purchase })) }, user);
        let updated = 0;
        if (input.post !== false) {
          this.postDoc(doc.id, user);
          // После проведения: себестоимость = цена закупки (средняя) + доп. расходы этой партии на единицу; цена продажи — новая.
          for (const x of prepared) {
            const p = getProduct(x.p.id);
            const price = x.isNew || input.updatePrices !== false ? (x.sale > 0 ? x.sale : p.price) : p.price;
            db.prepare('UPDATE products SET cost = ?, price = ? WHERE id = ?').run(round2((p.purchase ?? p.cost) + x.extra), price, p.id);
            if (!x.isNew && price !== p.price) updated++;
          }
        }
        if (input.recordExpenses !== false) {
          const who = supplierId ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId)?.name || '' : '';
          for (const e of extras) this.addExpense({ category: e.name, amount: e.amount, at: when, note: `${num ? `Накладная №${num}` : 'Приход по накладной'}${who ? `, ${who}` : ''}` }, user);
        }
        if (currency === 'USD') this.setSetting('usd_rate', String(rate));
        return { doc: this.getDoc(doc.id), created, updated, lines: prepared.length, total: round2(total), extras: extrasTotal, posted: input.post !== false };
      });
    },

    /* ---------- Постоянные расходы ---------- */
    listRecurring() {
      return db.prepare('SELECT * FROM recurring_expenses ORDER BY sort, id').all().map((r) => ({ ...r, active: Boolean(r.active) }));
    },

    saveRecurring(id, input) {
      const name = text(input.name, 'Название расхода', { required: true, max: 60 });
      const amount = round2(number(input.amount, 'Сумма в месяц', { positive: true }));
      const since = input.since ? number(input.since, 'Действует с', { positive: true }) : null;
      const clash = this.listRecurring().find((r) => r.id !== Number(id) && r.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new UserError(`Расход «${clash.name}» уже есть — измените его`);
      if (id) {
        const cur = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(Number(id));
        if (!cur) throw new UserError('Расход не найден');
        const active = input.active === undefined ? cur.active : input.active ? 1 : 0;
        db.prepare('UPDATE recurring_expenses SET name = ?, amount = ?, since = ?, active = ? WHERE id = ?').run(name, amount, since, active, cur.id);
        return db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(cur.id);
      }
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM recurring_expenses').get().m || 0) + 1;
      const { lastInsertRowid } = db.prepare('INSERT INTO recurring_expenses (name, amount, since, sort, created_at) VALUES (?, ?, ?, ?, ?)').run(name, amount, since, sort, Date.now());
      return db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(lastInsertRowid);
    },

    deleteRecurring(id) {
      const r = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(Number(id));
      if (!r) throw new UserError('Расход не найден');
      db.prepare('DELETE FROM recurring_expenses WHERE id = ?').run(r.id);
      return r;
    },

    /* ---------- Поставщики ---------- */
    listSuppliers() {
      return db.prepare(`SELECT s.*, COUNT(d.id) AS docs, COALESCE(SUM(d.total), 0) AS total, MAX(d.doc_date) AS last_at FROM suppliers s
        LEFT JOIN docs d ON d.supplier_id = s.id AND d.kind = 'purchase' AND d.status = 'posted' GROUP BY s.id ORDER BY s.name`).all();
    },

    saveSupplier(id, input) {
      const name = text(input.name, 'Название', { required: true, max: 120 });
      const clash = db.prepare('SELECT id, name FROM suppliers').all().find((s) => s.id !== Number(id) && s.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new UserError(`Поставщик «${clash.name}» уже есть`);
      const f = { phone: text(input.phone, 'Телефон', { max: 40 }), contact: text(input.contact, 'Контактное лицо', { max: 120 }), inn: text(input.inn, 'ИНН', { max: 20 }),
        address: text(input.address, 'Адрес', { max: 300 }), note: text(input.note, 'Заметка', { max: 1000 }) };
      if (id) {
        if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(Number(id))) throw new UserError('Поставщик не найден');
        db.prepare('UPDATE suppliers SET name = ?, phone = ?, contact = ?, inn = ?, address = ?, note = ? WHERE id = ?').run(name, f.phone, f.contact, f.inn, f.address, f.note, Number(id));
        return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(id));
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO suppliers (name, phone, contact, inn, address, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, f.phone, f.contact, f.inn, f.address, f.note, Date.now());
      return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(lastInsertRowid);
    },

    deleteSupplier(id) {
      const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(id));
      if (!s) throw new UserError('Поставщик не найден');
      if (db.prepare('SELECT 1 FROM docs WHERE supplier_id = ?').get(s.id)) throw new UserError('По этому поставщику есть документы — его нельзя удалить');
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(s.id);
      return s;
    },

    // Данные для дашборда: товары и строки продаж (без возвратов) за период.
    analytics({ from, to }) {
      const products = db.prepare(`SELECT id, name, category, code, unit, stock, price, cost, COALESCE(purchase, cost) AS purchase FROM products p WHERE archived = 0
        AND NOT EXISTS (SELECT 1 FROM products c WHERE c.parent_id = p.id AND c.deleted = 0)`).all()
        .map((p) => ({ ...p, id: String(p.id) }));
      const sales = db.prepare(`
        SELECT s.created_at AS t, s.id AS r, s.user_id AS u, si.product_id AS p, si.name AS n, si.qty AS q,
          si.qty * si.price - ${LINE_FEE} AS s, si.qty * COALESCE(si.purchase, si.cost) AS c, ${LINE_FEE} AS f
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

    // Сотрудники магазина. Записи владельца и сотрудников других магазинов и переведённые — не показываются.
    listUsers() {
      return db.prepare('SELECT * FROM users WHERE owner_shadow = 0 AND moved_to IS NULL ORDER BY role, email').all().map(publicUser);
    },

    createUser(input, passwordHash) {
      const e = email(input.email);
      const ex = this.findUserByEmail(e);
      // Старая запись того, кто отсюда переведён или приходил из другого магазина, освобождает email.
      if (ex && (ex.moved_to || ex.owner_shadow)) db.prepare('UPDATE users SET email = ?, disabled = 1 WHERE id = ?').run(`${e}#old-${ex.id}`, ex.id);
      else if (ex) throw new UserError('Сотрудник с таким email уже есть');
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
      if (current.role === 'owner' && !current.disabled && (next.role !== 'owner' || next.disabled) && this.activeOwners() <= 1) {
        throw new UserError('Это единственный владелец. Сначала назначьте владельцем другого сотрудника.');
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

    // pinHash готовит сервер (scrypt), null — убрать PIN.
    setUserPin(id, pinHash) {
      const u = this.findUser(id);
      if (!u) throw new UserError('Сотрудник не найден');
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, u.id);
      return publicUser(this.findUser(u.id));
    },

    // Запись сотрудника из другого магазина в этой базе: владелец (как администратор) или сотрудник,
    // которому открыт доступ сюда (с ролью и правами из своего магазина). Заводится и обновляется сама.
    shadowOf(src, { owner = false } = {}) {
      const cur = db.prepare('SELECT * FROM users WHERE email = ?').get(src.email);
      if (cur && !cur.owner_shadow && !cur.moved_to) throw new UserError(`В этом магазине уже есть сотрудник с email ${src.email}`);
      const f = owner ? { role: 'owner', rights: null, max_discount: null } : { role: src.role, rights: src.rights, max_discount: src.max_discount };
      if (cur) {
        db.prepare('UPDATE users SET name = ?, password_hash = ?, pin_hash = ?, role = ?, rights = ?, max_discount = ?, disabled = 0, owner_shadow = 1, moved_to = NULL WHERE id = ?')
          .run(src.name, src.password_hash, src.pin_hash ?? null, f.role, f.rights, f.max_discount, cur.id);
        return this.findUser(cur.id);
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, role, password_hash, pin_hash, rights, max_discount, created_at, owner_shadow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(src.email, src.name, f.role, src.password_hash, src.pin_hash ?? null, f.rights, f.max_discount, Date.now());
      return this.findUser(lastInsertRowid);
    },

    ownerShadow(owner) { return this.shadowOf(owner, { owner: true }); },

    // Перевод сотрудника в этот магазин: запись создаётся (или оживает, если он здесь уже работал) со всеми условиями.
    moveIn(src) {
      const cur = db.prepare('SELECT * FROM users WHERE email = ?').get(src.email);
      const fields = [src.name, src.role, src.password_hash, src.pin_hash ?? null, src.rights, src.salary, src.percent, src.plan, src.plan_bonus ?? 0, src.shift_rate, src.max_discount, src.stores];
      if (cur) {
        db.prepare(`UPDATE users SET name = ?, role = ?, password_hash = ?, pin_hash = ?, rights = ?, salary = ?, percent = ?, plan = ?, plan_bonus = ?, shift_rate = ?, max_discount = ?, stores = ?,
          disabled = 0, owner_shadow = 0, moved_to = NULL, payment_methods = NULL WHERE id = ?`).run(...fields, cur.id);
        return publicUser(this.findUser(cur.id));
      }
      const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, name, role, password_hash, pin_hash, rights, salary, percent, plan, plan_bonus, shift_rate, max_discount, stores, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(src.email, ...fields, Date.now());
      return publicUser(this.findUser(lastInsertRowid));
    },

    // Сотрудник ушёл в другой магазин: здесь он закрыт, история его продаж и смен остаётся.
    moveOut(id, to) {
      const u = this.findUser(id);
      if (!u) throw new UserError('Сотрудник не найден');
      if (this.currentShift(u.id)) throw new UserError('У сотрудника открыта смена — сначала закройте её');
      if (u.role === 'owner') throw new UserError('Владельца нельзя перевести в другой магазин — он работает во всех');
      db.prepare('UPDATE users SET disabled = 1, moved_to = ? WHERE id = ?').run(to, u.id);
      return u;
    },

    setUserStores(id, stores) {
      const u = this.findUser(id);
      if (!u) throw new UserError('Сотрудник не найден');
      const list = [...new Set((stores || []).map(Number).filter(Boolean))];
      db.prepare('UPDATE users SET stores = ? WHERE id = ?').run(list.length ? JSON.stringify(list) : null, u.id);
      return publicUser(this.findUser(u.id));
    },

    // Кто может работать на кассе — для кнопки «Сменить кассира».
    kassaUsers() {
      return db.prepare('SELECT * FROM users WHERE disabled = 0 AND owner_shadow = 0 ORDER BY name, email').all()
        .filter((u) => can(u, 'pos'))
        .map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, hasPin: Boolean(u.pin_hash) }));
    },

    deleteUser(id) {
      const current = this.findUser(id);
      if (!current) throw new UserError('Сотрудник не найден');
      if (current.role === 'owner' && !current.disabled && this.activeOwners() <= 1) {
        throw new UserError('Это единственный владелец. Сначала назначьте владельцем другого сотрудника.');
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(current.id);
      return { ok: true };
    },

    // Кто может управлять программой: владельцы и администраторы.
    activeAdmins() {
      return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('owner', 'admin') AND disabled = 0").get().n;
    },

    activeOwners() {
      return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND owner_shadow = 0").get().n;
    },

    // Основной магазин: если владельца ещё нет (базы до разделения ролей), им становится первый администратор.
    ensureOwner() {
      if (this.activeOwners() || !this.countUsers()) return null;
      const first = db.prepare("SELECT * FROM users WHERE role = 'admin' AND disabled = 0 AND owner_shadow = 0 AND moved_to IS NULL ORDER BY created_at, id LIMIT 1").get();
      if (first) db.prepare("UPDATE users SET role = 'owner', rights = NULL, name = CASE WHEN name IN ('', 'Администратор') THEN 'Владелец' ELSE name END WHERE id = ?").run(first.id);
      return first || null;
    },

    // Копия пароля и PIN, которые задал владелец или администратор, — зашифрованно, чтобы владелец мог посмотреть.
    // Пароль, который сотрудник сменил сам, не хранится: копия стирается.
    setUserSecrets(id, { password, pin } = {}, encrypt) {
      const u = this.findUser(id);
      if (!u) return;
      if (password !== undefined) db.prepare('UPDATE users SET secret_pw = ? WHERE id = ?').run(password === null ? null : encrypt(password), u.id);
      if (pin !== undefined) db.prepare('UPDATE users SET secret_pin = ? WHERE id = ?').run(pin === null ? null : encrypt(pin), u.id);
    },

    // Последний вход каждого сотрудника: когда, с какого IP и устройства.
    lastLogins() {
      return Object.fromEntries(db.prepare(`SELECT a.user_id, a.at, a.ip, a.device FROM audit a
        JOIN (SELECT user_id, MAX(at) AS at FROM audit WHERE kind = 'login' AND user_id IS NOT NULL GROUP BY user_id) m ON m.user_id = a.user_id AND m.at = a.at
        WHERE a.kind = 'login'`).all().map((r) => [r.user_id, { at: r.at, ip: r.ip, device: r.device }]));
    },

    // Владелец из переменных ADMIN_EMAIL и ADMIN_PASSWORD. Пароль записывается, когда сотрудника
    // ещё нет или когда пароль в переменной поменяли (fingerprint — отпечаток пары email и пароля):
    // так пароль, сменённый в программе, не сбрасывается при каждом перезапуске сервера.
    ensureAdmin(adminEmail, makeHash, fingerprint) {
      const e = email(adminEmail);
      const current = this.findUserByEmail(e);
      const applied = db.prepare("SELECT value FROM settings WHERE key = 'admin_env'").get()?.value;
      let user;
      if (!current) user = this.createUser({ email: e, name: 'Владелец', role: 'owner' }, makeHash());
      else {
        const hash = applied === fingerprint ? current.password_hash : makeHash();
        db.prepare("UPDATE users SET role = 'owner', rights = NULL, disabled = 0, password_hash = ?, name = CASE WHEN name IN ('', 'Администратор') THEN 'Владелец' ELSE name END WHERE id = ?").run(hash, current.id);
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
      const all = db.prepare(`SELECT p.id, p.name, p.category, p.unit, p.price, p.discount, p.stock, p.description, p.photo_at, p.parent_id, p.options
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
      return out.map(({ discount, ...p }) => ({
        ...p, price: salePrice({ price: p.price, discount }), oldPrice: discount > 0 ? p.price : null,
        options: p.options ? JSON.parse(p.options) : null, hasVariants: kids.has(p.id),
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

module.exports = { createStore, UserError, text, number, phone, birthday, gender, personName, round2, transaction };
