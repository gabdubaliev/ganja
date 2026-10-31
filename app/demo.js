'use strict';

// Пример магазина: товары и два года продаж, чтобы посмотреть, как всё выглядит.

const DAY = 864e5;

const CATALOG = [
  ['Молочные продукты', [['Молоко 3,2% 1 л', 89, 0.78], ['Кефир 2,5% 900 г', 95, 0.76], ['Сметана 20% 300 г', 112, 0.74], ['Творог 9% 400 г', 189, 0.72], ['Сыр «Российский» 200 г', 245, 0.7], ['Йогурт питьевой 270 г', 69, 0.68], ['Масло сливочное 82,5% 180 г', 219, 0.8]]],
  ['Хлеб и выпечка', [['Хлеб «Бородинский» 400 г', 62, 0.65], ['Батон нарезной 380 г', 49, 0.64], ['Круассан с шоколадом', 95, 0.45], ['Лаваш армянский 3 шт', 79, 0.6]]],
  ['Напитки', [['Вода питьевая 0,5 л', 45, 0.4], ['Вода питьевая 1,5 л', 69, 0.45], ['Сок яблочный 1 л', 139, 0.66], ['Кола 0,5 л', 99, 0.55], ['Энергетик 0,45 л', 129, 0.52], ['Морс клюквенный 1 л', 149, 0.6], ['Чай холодный лимон 0,5 л', 89, 0.5]]],
  ['Кофе и чай', [['Кофе в зёрнах 250 г', 459, 0.62], ['Кофе растворимый 95 г', 389, 0.68], ['Чай чёрный 100 пак.', 329, 0.63], ['Кофе с собой 300 мл', 180, 0.28]]],
  ['Бакалея', [['Гречка 900 г', 119, 0.72], ['Рис круглый 900 г', 109, 0.73], ['Макароны 450 г', 89, 0.66], ['Сахар 1 кг', 99, 0.83], ['Масло подсолнечное 1 л', 149, 0.81]]],
  ['Снеки и сладкое', [['Шоколад молочный 90 г', 115, 0.58], ['Чипсы 140 г', 149, 0.55], ['Печенье овсяное 300 г', 129, 0.6], ['Орехи кешью 100 г', 249, 0.5], ['Батончик протеиновый', 119, 0.47], ['Жевательная резинка', 59, 0.45]]],
  ['Овощи и фрукты', [['Бананы 1 кг', 139, 0.7], ['Яблоки 1 кг', 149, 0.66], ['Огурцы 1 кг', 199, 0.62], ['Помидоры 1 кг', 249, 0.64]]],
  ['Заморозка', [['Пельмени 800 г', 389, 0.71], ['Мороженое пломбир', 99, 0.55], ['Вареники с картофелем 900 г', 259, 0.69]]],
  ['Хозтовары', [['Пакет-майка', 9, 0.3], ['Салфетки бумажные 100 шт', 79, 0.55], ['Губки для посуды 5 шт', 99, 0.5]]],
];

function seedDemo(store, { days = 760, now = Date.now() } = {}) {
  let seed = 20261030;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const weighted = (weights) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    return () => {
      let x = rnd() * sum;
      for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) <= 0) return i;
      return weights.length - 1;
    };
  };
  const { db } = store;

  store.transaction(() => {
    const insertProduct = db.prepare('INSERT INTO products (name, category, barcode, code, unit, price, cost, purchase, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)');
    const products = [];
    const weights = [];
    let n = 0;
    for (const [category, items] of CATALOG) {
      for (const [name, price, costRatio] of items) {
        n++;
        const cost = Math.round(price * costRatio * 100) / 100;
        const barcode = '460' + String(1000000000 + n * 7919).slice(-10);
        const { lastInsertRowid } = insertProduct.run(name, category, barcode, String(n).padStart(5, '0'), /кг$/.test(name) ? 'кг' : 'шт', price, cost, cost, now - days * DAY);
        products.push({ id: Number(lastInsertRowid), name, price, cost });
        // Пара товаров давно не продаётся.
        weights.push(/^(Вареники|Морс)/.test(name) ? 0 : Math.pow(1 / (1 + rnd() * 9), 1.4) * (price < 120 ? 1.6 : 1));
      }
    }
    const pickProduct = weighted(weights);
    const pickHour = weighted([0, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1, 0.9, 0.9, 1.3, 1.4, 1.1, 0.9, 1, 1.3, 1.7, 1.8, 1.4, 0.9, 0.5, 0.2]);

    const insertSale = db.prepare('INSERT INTO sales (created_at, payment, total) VALUES (?, ?, ?)');
    const insertItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost, purchase) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const sold30 = new Map();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    const from30 = now - 30 * DAY;

    for (let d = new Date(start); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
      const day = d.getTime();
      const age = (now - day) / (365 * DAY);
      const count = Math.round(62 * [1.1, 0.9, 0.92, 0.95, 1, 1.25, 1.3][d.getDay()] * (1 - age * 0.12) * (0.85 + rnd() * 0.3));
      const receipts = [];
      for (let k = 0; k < count; k++) {
        const t = day + pickHour() * 36e5 + Math.floor(rnd() * 36e5);
        if (t <= now) receipts.push(t);
      }
      receipts.sort((a, b) => a - b);
      for (const t of receipts) {
        const lines = [];
        const count = 1 + Math.floor(rnd() * rnd() * 4);
        for (let j = 0; j < count; j++) lines.push({ p: products[pickProduct()], q: rnd() < 0.82 ? 1 : 2 });
        const total = lines.reduce((s, l) => s + l.p.price * l.q, 0);
        const { lastInsertRowid } = insertSale.run(t, rnd() < 0.7 ? 'card' : 'cash', total);
        for (const l of lines) {
          insertItem.run(lastInsertRowid, l.p.id, l.p.name, l.q, l.p.price, l.p.cost, l.p.cost);
          if (t >= from30) sold30.set(l.p.id, (sold30.get(l.p.id) || 0) + l.q);
        }
      }
    }

    // Остатки: у большинства запас на 1–6 недель, у нескольких почти пусто.
    const setStock = db.prepare('UPDATE products SET stock = ? WHERE id = ?');
    for (const p of products) {
      const perDay = (sold30.get(p.id) || 0) / 30;
      const roll = rnd();
      const stock = roll < 0.08 ? 0 : roll < 0.2 ? Math.round(perDay * (1 + rnd() * 4)) : Math.round(perDay * (8 + rnd() * 35) + (perDay ? 0 : 6 + rnd() * 20));
      setStock.run(stock, p.id);
    }

    // Несколько последних закупок для истории: проведённые документы с поставщиком.
    const insertSupplier = db.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)');
    const insertDoc = db.prepare(`INSERT INTO docs (kind, number, status, doc_date, created_at, posted_at, supplier_id, supplier_name, total, total_cost)
      VALUES ('purchase', ?, 'posted', ?, ?, ?, ?, ?, ?, ?)`);
    const insertDocItem = db.prepare('INSERT INTO doc_items (doc_id, product_id, name, unit, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const setSupplier = db.prepare('UPDATE products SET supplier_id = COALESCE(supplier_id, ?) WHERE id = ?');
    let number = 0;
    for (const [daysAgo, supplier] of [[9, 'ООО «Северная бакалея»'], [5, 'ИП Сафаров'], [2, 'ООО «Молочный двор»']]) {
      const supplierId = Number(insertSupplier.run(supplier, now).lastInsertRowid);
      const lines = Array.from({ length: 4 }, () => ({ p: products[Math.floor(rnd() * products.length)], q: 10 + Math.floor(rnd() * 30) }));
      const total = Math.round(lines.reduce((s, l) => s + l.p.cost * l.q, 0) * 100) / 100;
      const at = now - daysAgo * DAY + 10 * 36e5;
      const docId = Number(insertDoc.run(++number, at, at, at, supplierId, supplier, total, total).lastInsertRowid);
      for (const l of lines) {
        insertDocItem.run(docId, l.p.id, l.p.name, 'шт', l.q, l.p.price, l.p.cost);
        setSupplier.run(supplierId, l.p.id);
      }
    }
  });
}

module.exports = { seedDemo };
