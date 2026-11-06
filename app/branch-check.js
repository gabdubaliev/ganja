'use strict';

// Проверка магазинов на сервере (только чтение, ничего не меняет):
//   node /opt/shop/app/branch-check.js            — папка баз /var/lib/shop
//   node /opt/shop/app/branch-check.js <папка>
// Показывает список магазинов, что лежит в базе каждого (сотрудники, кассы, смены, чеки, документы, остатки),
// перемещения из основного магазина в каждый и копии удалённых магазинов. Так видно, не попало ли во «второй»
// магазин что-то от удалённого (например, старые смены или чеки раньше дня его создания).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = process.argv[2] || process.env.SHOP_DATA_DIR || '/var/lib/shop';
const open = (file) => new DatabaseSync(path.join(dir, file), { readOnly: true });
const day = (t) => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const one = (db, sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
const all = (db, sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };

const main = open('shop.db');
const branches = JSON.parse(one(main, "SELECT value FROM settings WHERE key = 'branches'")?.value || '[]');
const mainName = (() => { try { return JSON.parse(one(main, "SELECT value FROM settings WHERE key = 'design'")?.value || '{}').name; } catch { return ''; } })() || 'Основной';
console.log(`Папка баз: ${dir}`);
console.log(`Магазины: 1 — ${mainName} (shop.db)${branches.map((b) => `; ${b.id} — ${b.name} (${b.file}, создан ${day(b.created_at)})`).join('')}`);

function report(file, title, createdAt) {
  let db;
  try { db = open(file); } catch (err) { return console.log(`\n${title}: не открылась — ${err.message}`); }
  console.log(`\n=== ${title} (${file}) ===`);
  const users = all(db, 'SELECT name, email, role, owner_shadow, disabled FROM users ORDER BY id');
  console.log(`Сотрудники: ${users.map((u) => `${u.name || u.email} (${u.role}${u.owner_shadow ? ', гость' : ''}${u.disabled ? ', отключён' : ''})`).join(', ') || 'нет'}`);
  console.log(`Кассы: ${all(db, 'SELECT name, active, deleted FROM registers').map((r) => `${r.name}${r.deleted ? ' (удалена)' : r.active ? '' : ' (откл.)'}`).join(', ') || 'нет'}`);
  const sh = one(db, 'SELECT COUNT(*) AS n, MIN(opened_at) AS a, MAX(opened_at) AS b FROM shifts');
  console.log(`Смены: ${sh?.n || 0}${sh?.n ? ` (с ${day(sh.a)} по ${day(sh.b)})` : ''}`);
  const s = one(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS sum, MIN(created_at) AS a, MAX(created_at) AS b FROM sales WHERE refunded_at IS NULL');
  console.log(`Чеки: ${s?.n || 0} на ${Math.round(s?.sum || 0)} сом${s?.n ? ` (с ${day(s.a)} по ${day(s.b)})` : ''}`);
  const docs = all(db, 'SELECT kind, status, COUNT(*) AS n, MIN(doc_date) AS a FROM docs GROUP BY kind, status');
  console.log(`Документы: ${docs.map((d) => `${d.kind}/${d.status === 'posted' ? 'проведён' : 'черновик'}: ${d.n} (с ${day(d.a)})`).join('; ') || 'нет'}`);
  const st = one(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(stock), 0) AS q FROM products WHERE deleted = 0 AND stock <> 0');
  const pr = one(db, 'SELECT COUNT(*) AS n FROM products WHERE deleted = 0');
  console.log(`Товаров в справочнике: ${pr?.n || 0}; с остатком: ${st?.n || 0} (всего ${st?.q || 0} шт.)`);
  if (createdAt) {
    const early = [
      ['смен', one(db, 'SELECT COUNT(*) AS n FROM shifts WHERE opened_at < ?', createdAt)?.n],
      ['чеков', one(db, 'SELECT COUNT(*) AS n FROM sales WHERE created_at < ?', createdAt)?.n],
      ['документов', one(db, 'SELECT COUNT(*) AS n FROM docs WHERE created_at < ?', createdAt)?.n],
    ].filter(([, n]) => n);
    console.log(early.length ? `⚠️ Раньше дня создания магазина: ${early.map(([w, n]) => `${n} ${w}`).join(', ')} — похоже на данные другого магазина` : '✓ Записей раньше дня создания магазина нет');
  }
  db.close();
}

report('shop.db', mainName);
for (const b of branches) {
  report(b.file, b.name, b.created_at);
  const tr = all(main, "SELECT number, status, doc_date FROM docs WHERE kind = 'transfer' AND branch_to = ?", b.id);
  console.log(`Перемещения из «${mainName}» в магазин №${b.id}: ${tr.length ? tr.map((d) => `№${d.number} ${d.status === 'posted' ? 'проведено' : 'черновик'} ${day(d.doc_date)}`).join('; ') : 'нет'}`);
}
const ids = branches.map((b) => b.id);
const lost = all(main, "SELECT number, status, doc_date, branch_to FROM docs WHERE kind = 'transfer' AND branch_to IS NOT NULL").filter((d) => !ids.includes(d.branch_to));
console.log(`\nПеремещения в удалённые магазины: ${lost.length ? lost.map((d) => `№${d.number} в магазин №${d.branch_to} ${d.status === 'posted' ? 'проведено' : 'черновик'} ${day(d.doc_date)}`).join('; ') : 'нет'}`);
// Студия: съёмки и файлы по магазинам, и кто их удалял (журнал действий основного магазина и филиалов).
try {
  const st = open('studio.db');
  const ss = all(st, 'SELECT branch_id, COUNT(*) AS n, MAX(updated_at) AS last FROM studio_sessions GROUP BY branch_id');
  const as = one(st, 'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM studio_assets') || one(st, 'SELECT COUNT(*) AS n FROM studio_assets');
  console.log(`\nСтудия: съёмок ${ss.reduce((a, x) => a + x.n, 0)}${ss.length ? ` (${ss.map((x) => `магазин №${x.branch_id}: ${x.n}, последняя ${day(x.last)}`).join('; ')})` : ''}; файлов ${as?.n || 0}${as?.bytes ? ` (${(as.bytes / 1048576).toFixed(1)} МБ)` : ''}; размер базы ${(fs.statSync(path.join(dir, 'studio.db')).size / 1048576).toFixed(1)} МБ, из них пустого места после удалений ${((one(st, 'PRAGMA freelist_count')?.freelist_count || 0) * (one(st, 'PRAGMA page_size')?.page_size || 0) / 1048576).toFixed(1)} МБ`);
  st.close();
} catch (err) { console.log(`\nСтудия: не открылась — ${err.message}`); }
for (const [file, name] of [['shop.db', mainName], ...branches.map((b) => [b.file, b.name])]) {
  let db; try { db = open(file); } catch { continue; }
  const rows = all(db, "SELECT at, user_name, action, details FROM audit WHERE action LIKE '%Studio%' AND (action LIKE '%удал%') ORDER BY at DESC LIMIT 15");
  if (rows.length) console.log(`Удаления в Студии (журнал «${name}»): ${rows.map((r) => `${day(r.at)} ${r.user_name || '—'}: ${r.action}${r.details ? ` (${r.details})` : ''}`).join('; ')}`);
  db.close();
}
const deleted = fs.readdirSync(dir).filter((f) => /\.deleted-.*\.db$/.test(f));
console.log(`\nКопии удалённых магазинов: ${deleted.length ? deleted.map((f) => `${f} (${(fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1)} МБ)`).join(', ') : 'нет'}`);
main.close();
