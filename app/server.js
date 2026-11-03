'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));
// Дни, смены и выплатные периоды считаются по времени Бишкека, даже если сервер живёт в UTC.
process.env.TZ ||= 'Asia/Bishkek';
const { createStore, useFontsFrom, UserError, phone: normalizePhone, round2 } = require('./db');
const { seedDemo } = require('./demo');
const invoice = require('./invoice');
const { createStudio } = require('./studio');
const studioPrompts = require('./studio-prompts');
const studioAi = require('./studio-ai');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createAuth, hashPassword, checkPassword } = require('./auth');
const { RIGHTS, ROLES, rightsOf, can } = require('./roles');
const { themeCss, shopCss } = require('./theme');
const { createNotifier, TG_EVENTS } = require('./notify');
const { createCrm } = require('./crm');
const { createShopAuth } = require('./shop-auth');
const { createIgPrice } = require('./ig-price');
const { sendSms, PROVIDERS: SMS_PROVIDERS } = require('./sms');
const captcha = require('./captcha');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || 'data/shop.db');
const PUBLIC = path.join(__dirname, 'public');
const MAX_RANGE = 800 * 864e5;
// Без входа можно открыть только страницу входа и её стили.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/manifest.webmanifest', '/icon.svg', '/shop.css', '/shop.js', '/colors.js']);
const ORDER_LIMIT = 5; // заказов с одного адреса за 10 минут — защита от спама
const orderLog = new Map(); // ip -> [время заказа]

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// Простой разбор .env: строки KEY=value, # — комментарии.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

/* ---------- Магазины (филиалы) ----------
   У каждого магазина своя база: товары, сотрудники, кассы, продажи, документы. Основной магазин — DB_FILE,
   филиалы — branch-N.db рядом с ней, список хранится в настройках основного. Каждый запрос выполняется
   в контексте своего магазина (AsyncLocalStorage), поэтому код маршрутов работает с «store» как раньше. */
const mainStore = createStore(DB_FILE);
useFontsFrom(mainStore);
// MONT AI Studio — своя база studio.db рядом с основной (исходники и черновики много весят).
const studio = createStudio(path.join(path.dirname(DB_FILE), 'studio.db'), { UserError });
const contexts = new Map(); // id магазина -> { id, store, notifier, crm, shopAuth }
const als = new AsyncLocalStorage();
const current = () => als.getStore() || contexts.get(1);
// store, notifier, crm, shopAuth ниже — это магазин текущего запроса.
const scoped = (key) => new Proxy({}, { get: (_, k) => { const t = current()[key]; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
const store = scoped('store');
const notifier = scoped('notifier');
const crm = scoped('crm');
const shopAuth = scoped('shopAuth');
const igPrice = scoped('igPrice');

function branchList() {
  const saved = JSON.parse(mainStore.setting('branches', '[]'));
  return [{ id: 1, name: mainStore.design().name || 'Основной магазин', address: '', main: true }, ...saved];
}

function makeContext(id, st) {
  // Филиал: бонусы, сертификаты и правила программы лояльности — общие, в основной базе.
  if (id !== 1) st.useBank(mainStore, id);
  // Журнал движения товара: один раз заполняется прошлым из чеков и документов.
  const filled = st.backfillStockMoves();
  if (filled) console.log(`Журнал движения товара заполнен: ${filled} записей`);
  const ctx = { id, store: st };
  ctx.notifier = createNotifier(st);
  ctx.crm = createCrm(st);
  ctx.igPrice = createIgPrice({ store: st, crm: ctx.crm, notifier: ctx.notifier });
  // Код подтверждения, который сотрудник передаёт покупателю сам: уведомление в программу и в Telegram.
  ctx.shopAuth = createShopAuth(st, {
    onCodeRequested(c) {
      const what = c.purpose === 'reset' ? 'восстановление пароля' : 'регистрация';
      ctx.notifier.broadcast('code', { phone: c.phone, name: c.name, purpose: c.purpose }, 'customers.accounts');
      const tg = ctx.notifier.tgFor('codes');
      if (tg) {
        ctx.notifier.sendTelegram(`🔑 Код для покупателя ${c.name ? c.name + ', ' : ''}+${c.phone} (${what}): ${c.code}\nПозвоните или напишите покупателю и назовите код. Действует 15 минут.`, tg)
          .catch((err) => console.error('Код в Telegram не отправлен:', err.message));
      }
    },
  });
  // Перемещение: товар уходит отсюда и приходит в другой магазин.
  st.setBranchLink({
    send(to, payload, user) {
      const target = contextOf(to);
      if (!target || to === id) throw new UserError('Выберите другой магазин');
      return target.store.receiveTransfer({ ...payload, fromBranch: id, fromName: branchList().find((b) => b.id === id)?.name || `Магазин №${id}` }, user);
    },
    cancel(to, docId) { contextOf(to)?.store.cancelTransfer(docId); },
  });
  contexts.set(id, ctx);
  return ctx;
}

function contextOf(id) {
  const n = Number(id) || 1;
  if (contexts.has(n)) return contexts.get(n);
  const b = branchList().find((x) => x.id === n);
  if (!b || b.main) return null;
  return makeContext(n, createStore(path.join(path.dirname(DB_FILE), b.file)));
}

/* ---------- MONT AI Studio: товары берутся из базы своего магазина, не копируются ---------- */
function studioProduct(branchId, id) {
  const ctx = contextOf(branchId);
  if (!ctx) throw new UserError('Магазин не найден');
  const p = ctx.store.db.prepare('SELECT id, name, category, description, parent_id, options, price, discount, deleted, photo_at FROM products WHERE id = ?').get(Number(id));
  if (!p || p.deleted) throw new UserError('Товар не найден или удалён');
  return p;
}
const variantLabel = (v) => { try { return Object.values(JSON.parse(v.options || '{}')).join(', ') || v.name; } catch { return v.name; } };
function studioVariant(branchId, base, id) {
  const v = studioProduct(branchId, id);
  if (v.parent_id !== base.id) throw new UserError('Модификация не от этого товара');
  return v;
}
function studioBranchProducts(branchId, base) {
  const ctx = contextOf(branchId);
  const kids = ctx.store.db.prepare('SELECT id, name, options, photo_at, price, discount FROM products WHERE parent_id = ? AND deleted = 0 ORDER BY id').all(base.id);
  const counts = ctx.store.galleryCounts();
  return { kids, counts };
}
// Расцветки товара: свойство «Цвет» (по названию) и его значения. Для каждого цвета — модификации всех размеров
// и «хранитель» фото: модификация этого цвета, у которой уже есть галерея (или основное фото), иначе первая.
// Витрина показывает галерею любой модификации того же цвета для всех его размеров.
const STUDIO_SIZES = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
function studioSizeSort(values) {
  const rank = (v) => { const u = String(v).toUpperCase().replace(/\s/g, ''); const i = STUDIO_SIZES.indexOf(u === '2XL' ? 'XXL' : u === 'XXXL' ? '3XL' : u); if (i >= 0) return i; const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? 100 + n : null; };
  return values.every((v) => rank(v) !== null) ? [...values].sort((a, b) => rank(a) - rank(b)) : values;
}
const STUDIO_COLOR_RE = /цвет|расцв|оттен|окрас|^тон$|colou?r/i;
function studioColors(branchId, base) {
  const { kids, counts } = studioBranchProducts(branchId, base);
  const opts = (k) => { try { return JSON.parse(k.options || '{}'); } catch { return {}; } };
  const name = [...new Set(kids.flatMap((k) => Object.keys(opts(k))))].find((n) => STUDIO_COLOR_RE.test(n.trim()));
  if (!name) return { name: null, list: [] };
  const groups = new Map();
  for (const k of kids) {
    const c = opts(k)[name];
    if (!c) continue;
    const g = groups.get(c) || { color: c, ids: [], sizes: [], kids: [] };
    g.ids.push(k.id);
    g.kids.push(k);
    g.sizes.push(Object.entries(opts(k)).filter(([n]) => n !== name).map(([, v]) => v).join(', '));
    groups.set(c, g);
  }
  const list = [...groups.values()].map((g) => {
    const holder = g.kids.find((k) => counts[k.id]) || g.kids.find((k) => k.photo_at) || g.kids[0];
    return { color: g.color, ids: g.ids, sizes: studioSizeSort(g.sizes.filter(Boolean)), rep: holder.id, gallery: counts[holder.id] || 0, photoAt: holder.photo_at };
  });
  return { name, list };
}
function studioColorPick(branchId, base, color) {
  const c = studioColors(branchId, base).list.find((x) => x.color === color);
  if (!c) throw new UserError(`Расцветка «${color}» у этого товара не найдена`);
  return { variant: studioVariant(branchId, base, c.rep), color: c.color };
}

function studioProductBrief(s) {
  try {
    const p = studioProduct(s.branch_id, s.product_id);
    const v = s.variant_id ? studioProduct(s.branch_id, s.variant_id) : null;
    return { id: p.id, name: p.name, category: p.category, photoAt: p.photo_at, variant: v && { id: v.id, label: s.color || variantLabel(v), photoAt: v.photo_at } };
  } catch {
    return { id: s.product_id, name: 'Товар удалён', deleted: true };
  }
}
function studioSessionOut(s) {
  let product;
  try {
    const p = studioProduct(s.branch_id, s.product_id);
    const { kids, counts } = studioBranchProducts(s.branch_id, p);
    const price = (x) => (x.discount > 0 ? Math.round(x.price * (1 - x.discount / 100) * 100) / 100 : x.price);
    product = {
      id: p.id, name: p.name, category: p.category, description: p.description, photoAt: p.photo_at, price: price(p), gallery: counts[p.id] || 0,
      variants: kids.map((k) => ({ id: k.id, label: variantLabel(k), photoAt: k.photo_at, price: price(k), gallery: counts[k.id] || 0 })),
      colors: studioColors(s.branch_id, p).list,
    };
  } catch {
    product = { id: s.product_id, name: 'Товар удалён', deleted: true, variants: [] };
  }
  return { ...s, product };
}
// Данные товара для текста задания: название, категория, описание и свойства выбранной модификации.
// Картинки для Claude из браузера: [{ id, data (base64 JPEG/PNG/WebP) }], только файлы из allowed, не больше max.
function studioAiImages(list, allowed, max) {
  const byId = new Map(allowed.filter(Boolean).map((a) => [a.id, a]));
  const out = [];
  for (const im of Array.isArray(list) ? list : []) {
    const a = byId.get(Number(im?.id));
    if (!a || typeof im.data !== 'string' || !im.data) continue;
    if (im.data.length > 7e6) throw new UserError('Фото для проверки слишком большое — обновите страницу и попробуйте ещё раз');
    const head = Buffer.from(im.data.slice(0, 24), 'base64');
    const mime = head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : head[0] === 0x89 && head[1] === 0x50 ? 'image/png' : head.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new UserError('Фото для проверки не похоже на картинку');
    out.push({ id: a.id, role: a.role, mime, data: im.data });
    if (out.length >= max) break;
  }
  if (!out.length) throw new UserError('Нет фото для проверки');
  return out;
}

function studioFacts(s) {
  const p = studioProduct(s.branch_id, s.product_id);
  let options = {};
  if (s.variant_id) { try { options = JSON.parse(studioProduct(s.branch_id, s.variant_id).options || '{}'); } catch { options = {}; } }
  // Съёмка по расцветке — в задание идёт только цвет, без размера.
  if (s.color) { const name = studioColors(s.branch_id, p).name; options = name ? { [name]: s.color } : {}; }
  return { name: p.name, category: p.category, description: p.description, options };
}
makeContext(1, mainStore);
for (const b of branchList()) if (!b.main) contextOf(b.id);
// Один раз: бонусы и сертификаты филиалов переезжают в основную базу и становятся общими.
if (mainStore.setting('shared_wallet', '0') !== '1') {
  mainStore.hideAdminBonusRows();
  for (const b of branchList()) if (!b.main) mainStore.absorbBranchWallet(contextOf(b.id).store, b.id);
  mainStore.setSetting('shared_wallet', '1');
  console.log('Бонусы и сертификаты всех магазинов объединены');
}
// Один раз: покупатели филиалов переезжают в общую базу — у всех магазинов одни клиенты.
if (mainStore.setting('shared_customers', '0') !== '1') {
  for (const b of branchList()) if (!b.main) console.log(`Покупатели «${b.name}» в общей базе: ${mainStore.absorbBranchCustomers(contextOf(b.id).store)}`);
  mainStore.setSetting('shared_customers', '1');
}
// Аккаунты покупателей витрины — только у основного магазина (покупатели общие).
const mainShopAuth = () => contextOf(1).shopAuth;
// Один раз: предоплата по QR-коду владельца (assets/pay-qr.jpg), самовывоз выключен.
try {
  const qrFile = path.join(__dirname, 'assets', 'pay-qr.jpg');
  mainStore.setupPrepay(fs.existsSync(qrFile) ? fs.readFileSync(qrFile) : null);
} catch (err) {
  console.error('Не получилось настроить оплату по QR:', err.message);
}
// Деньги в кассе не сошлись при открытии или закрытии смены — владельцу в Telegram.
function cashAlert(sh, when) {
  const diff = when === 'открытии' ? sh.open_diff : sh.close_diff;
  if (diff) {
    const tg = notifier.telegramSettings();
    const text = `⚠️ Деньги в кассе не сошлись при ${when} смены №${sh.id}${sh.register_name ? ` (${sh.register_name})` : ''}\n`
      + `Кассир: ${sh.user_name}\n${diff < 0 ? 'Недостача' : 'Излишек'}: ${Math.abs(diff)} сом`
      + `\nДолжно быть: ${when === 'открытии' ? sh.open_expected : sh.close_expected} сом, насчитано: ${when === 'открытии' ? sh.open_cash : sh.close_counted} сом`
      + `\nПричина: ${(when === 'открытии' ? sh.open_note : sh.close_note) || '—'}`;
    if (tg.enabled && notifier.eventOn('cash_diff')) notifier.sendTelegram(text, tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }
  return sh;
}
// Смена в Telegram: при открытии — кто, когда и сколько денег в кассе; при закрытии последним — подробный отчёт дня.
const tgMoney = (n) => `${Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} сом`;
const tgTime = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const tgHm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function shiftReportText(r, title = '📊 Отчёт по смене') {
  const L = [];
  const shop = store.design?.()?.name || '';
  L.push(`${title}${shop ? ` · ${shop}` : ''}`, `${tgTime(r.from)} — ${r.open ? 'смена ещё идёт' : tgTime(r.to)}`, '');
  L.push(`👥 Сотрудников на смене: ${r.people}`);
  for (const x of r.staff) L.push(`• ${x.user}${x.register ? ` (${x.register})` : ''}: открыл ${tgHm(x.opened)}, ${x.closed ? `закрыл ${tgHm(x.closed)}` : 'ещё на смене'} · ${x.receipts} чек. на ${tgMoney(x.revenue)}`);
  L.push('', '💵 Деньги в кассе (наличные)');
  L.push(`На начало смены: ${r.cash.open === null ? '—' : tgMoney(r.cash.open)}${r.cash.openDiff ? ` (расхождение ${tgMoney(r.cash.openDiff)})` : ''}`);
  L.push(`+ продажи наличными: ${tgMoney(r.cash.sales)}`);
  if (r.cash.changeKept) L.push(`+ сдача, оставленная в кассе: ${tgMoney(r.cash.changeKept)} (${r.kept.length} раз)`);
  if (r.cash.chef) L.push(`+ сдача от шефа (ваши деньги в кассе): ${tgMoney(r.cash.chef)} (${r.chef.length} раз)`);
  if (r.cash.expenses) L.push(`− расходы из кассы: ${tgMoney(r.cash.expenses)}`);
  for (const e of r.cashExpenses) L.push(`   · ${e.category}: ${tgMoney(e.amount)}${e.note ? ` — ${e.note}` : ''}${e.user_name ? ` (${e.user_name})` : ''}`);
  if (r.cash.ops) L.push(`± внесения/изъятия: ${tgMoney(r.cash.ops)}`);
  L.push(`= должно быть в кассе: ${tgMoney(r.cash.expected)}`);
  if (r.cash.counted !== null) {
    L.push(`Насчитано при закрытии: ${tgMoney(r.cash.counted)}${r.cash.closeDiff ? ` (${r.cash.closeDiff < 0 ? 'недостача' : 'излишек'} ${tgMoney(Math.abs(r.cash.closeDiff))})` : ' — сходится'}`);
    if (r.cash.deposited) L.push(`Сдано на счёт: ${tgMoney(r.cash.deposited)}`);
    L.push(`Оставлено в кассе: ${tgMoney(r.cash.left)}`);
  }
  L.push('', '💳 Оплаты по способам');
  for (const m of r.byMethod) L.push(`• ${m.name}: ${tgMoney(m.sum)} (${m.receipts} чек.)${m.commission ? `, комиссия −${tgMoney(m.commission)}` : ''}`);
  if (!r.byMethod.length) L.push('• оплат не было');
  const s = r.sales;
  L.push('', '🧾 Продажи');
  L.push(`Чеков: ${s.receipts} · товаров продано: ${s.items} шт.`, `Средний чек: ${tgMoney(s.avg)}`);
  if (s.discount) L.push(`Скидки: ${tgMoney(s.discount)}`);
  if (s.bonus) L.push(`Оплачено бонусами: ${tgMoney(s.bonus)}`);
  if (s.refunds) L.push(`Возвраты: ${s.refunds} на ${tgMoney(s.refunded)}`);
  if (s.certificates) L.push(`Продано сертификатов: ${tgMoney(s.certificates)}`);
  L.push('', '📈 Выручка и прибыль');
  L.push(`Выручка: ${tgMoney(s.gross)}`);
  if (s.commission) L.push(`− комиссия банков: ${tgMoney(s.commission)}`);
  L.push(`− себестоимость проданного: ${tgMoney(s.cost)}`, `= валовая прибыль: ${tgMoney(s.grossProfit)}`);
  const f = r.finance;
  L.push(`− зарплата: ${tgMoney(f.salary)}`);
  for (const w of f.staff) L.push(`   · ${w.name}: ${tgMoney(w.pay)}${w.shifts ? ` (${w.shifts} вых.` : ' ('}${w.bonus ? `, % и бонусы ${tgMoney(w.bonus)}` : ''}${w.fines ? `, штрафы −${tgMoney(w.fines)}` : ''})`);
  if (f.staff.length > 1) L.push(`   Итого зарплата: ${tgMoney(f.salary)}`);
  if (f.other) { L.push(`− расходы: ${tgMoney(f.other)}`); for (const e of f.expenses) L.push(`   · ${e.category}: ${tgMoney(e.amount)}`); }
  if (f.fixed) L.push(`− постоянные расходы (доля за день): ${tgMoney(f.fixed)}`);
  if (f.writeoffs) L.push(`− списания: ${tgMoney(f.writeoffs)}`);
  if (r.cash.changeKept) L.push(`+ сдача, оставленная покупателями: ${tgMoney(r.cash.changeKept)}`);
  L.push(`= ЧИСТАЯ ПРИБЫЛЬ: ${tgMoney(r.net)}`);
  const sp = r.split;
  L.push('', '🏦 Куда разложить деньги дня');
  L.push(`• Оборот (вернуть в товар): ${tgMoney(sp.turnover)}`, `• Зарплата: ${tgMoney(sp.salary)}`);
  if (sp.expenses) L.push(`• Расходы (уже потрачено): ${tgMoney(sp.expenses)}`);
  if (sp.fixed) L.push(`• Отложить на постоянные расходы: ${tgMoney(sp.fixed)}`);
  L.push(`• На счёт прибыли: ${tgMoney(sp.profit)}`);
  return L.join('\n');
}
function shiftTelegram(sh, kind, user) {
  const tg = notifier.telegramSettings();
  if (!tg.enabled || !notifier.eventOn(kind === 'open' ? 'shift_open' : 'shift_close')) return;
  let text;
  try {
    if (kind === 'open') {
      const r = store.shiftSession();
      const first = r && r.staff[0]?.id === sh.id;
      text = `🟢 Смена открыта: ${sh.user_name}${sh.register_name ? ` (${sh.register_name})` : ''} в ${tgHm(sh.opened_at)}\n`
        + (sh.open_cash !== null && sh.open_cash !== undefined
          ? `Деньги в кассе на начало: ${tgMoney(sh.open_cash)}${sh.open_expected !== null && sh.open_expected !== undefined ? ` (должно было быть ${tgMoney(sh.open_expected)}${sh.open_diff ? `, ${sh.open_diff < 0 ? 'недостача' : 'излишек'} ${tgMoney(Math.abs(sh.open_diff))}: ${sh.open_note}` : ' — сходится'})` : ''}`
          : `Присоединился к смене${r && !first ? ` (кассу открыл${r.staff[0] ? ` ${r.staff[0].user}` : ''} в ${tgHm(r.from)}, на начало ${tgMoney(r.cash.open)})` : ''} — деньги не пересчитывал.`)
        + (r ? `\nСейчас на смене: ${r.staff.filter((x) => !x.closed).map((x) => x.user).join(', ')}` : '');
    } else {
      const r = store.shiftSession();
      const still = r ? r.staff.filter((x) => !x.closed) : [];
      if (r && still.length) {
        text = `🔴 ${sh.user_name} закрыл(а) смену в ${tgHm(sh.closed_at)} · ${sh.receipts} чек. на ${tgMoney(sh.revenue)}`
          + `${sh.byMethod.length ? '\n' + sh.byMethod.map((m) => `${m.name}: ${tgMoney(m.sum)}`).join(' · ') : ''}`
          + `\nНа смене остаётся: ${still.map((x) => x.user).join(', ')}. Подробный отчёт придёт, когда закроет последний.`;
      } else if (r) {
        text = shiftReportText(r, '🔴 Смена закрыта — отчёт дня');
      }
    }
  } catch (err) {
    console.error('Отчёт смены для Telegram не собран:', err.message);
    return;
  }
  if (text) notifier.sendTelegram(text.slice(0, 4000), tg).catch((err) => console.error('Уведомление о смене в Telegram не отправлено:', err.message));
}
// Каждое движение денег и товара — владельцу в Telegram: документы (закупка, оприходование, списание,
// инвентаризация, перемещение, возврат, продажа через админку), возврат чека, расходы, внесения/изъятия,
// переводы между счетами, приход по фото накладной, сертификаты. Продажи на кассе шлёт notifier.sale.
const DOC_ICON = { purchase: '📦', receipt: '➕', writeoff: '🗑️', inventory: '📋', transfer: '🚚', return: '↩️', sale: '🧾' };
function docTelegramText(d, what, who) {
  const kind = store.docKinds[d.kind]?.name || d.kind;
  const L = [`${DOC_ICON[d.kind] || '📄'} ${kind} №${d.number} — ${what}`, `Кто: ${who}`];
  if (d.supplier) L.push(`Поставщик: ${d.supplier}`);
  if (d.customer) L.push(`Покупатель: ${d.customer}`);
  if (d.method) L.push(`Счёт: ${d.method}`);
  if (d.kind === 'transfer') L.push(d.direction === 'in' ? 'Входящее перемещение' : 'Исходящее перемещение');
  const items = d.items || [];
  const lineSum = (i) => (['purchase', 'receipt', 'writeoff', 'transfer'].includes(d.kind) ? i.cost : i.price);
  for (const i of items.slice(0, 20)) {
    if (d.kind === 'inventory') {
      const diff = i.actual === null || i.actual === undefined ? null : round2(i.actual - (i.expected || 0));
      L.push(`• ${i.name}: было ${i.expected ?? '—'}, факт ${i.actual ?? '—'}${diff ? ` (${diff > 0 ? '+' : ''}${diff})` : ''}`);
    } else {
      L.push(`• ${i.name} × ${i.qty} = ${tgMoney(i.qty * lineSum(i))}${i.reason ? ` — ${i.reason}` : ''}`);
    }
  }
  if (items.length > 20) L.push(`…и ещё ${items.length - 20} строк`);
  if (d.kind !== 'inventory') {
    const qty = items.reduce((a, i) => a + Number(i.qty || 0), 0);
    L.push(`Итого: ${Math.round(qty * 1000) / 1000} шт. на ${tgMoney(d.total || items.reduce((a, i) => a + i.qty * lineSum(i), 0))}${d.total_cost && ['sale', 'return'].includes(d.kind) ? ` (себестоимость ${tgMoney(d.total_cost)})` : ''}`);
  }
  if (d.note) L.push(`Комментарий: ${d.note}`);
  return L.join('\n');
}
const ACC_KIND = { deposit: '➕ Внесение', withdraw: '➖ Изъятие', transfer: '🔁 Перевод' };
function moveTelegram(key, params, body, result, user) {
  const tg = notifier.telegramSettings();
  if (!tg.enabled || !result) return;
  const who = user ? user.name || user.email : 'без входа';
  let text = '';
  let ev = '';
  try {
    if ((key === 'POST /api/docs' || key === 'PUT /api/docs/:id') && body.post) text = docTelegramText(result, 'проведено', who);
    else if (key === 'POST /api/docs/:id/post') text = docTelegramText(result, 'проведено', who);
    else if (key === 'POST /api/docs/:id/unpost') text = `⚠️ ${docTelegramText(result, 'ОТМЕНЕНО проведение (товар и деньги вернулись как было)', who)}`;
    else if (key === 'POST /api/sales/:id/refund') {
      const sale = store.getSale(result.id);
      const items = store.db.prepare('SELECT name, qty, price FROM sale_items WHERE sale_id = ?').all(result.id);
      const pays = store.db.prepare('SELECT method_name, amount FROM sale_payments WHERE sale_id = ?').all(result.id);
      text = `↩️ Возврат чека №${result.id}${sale ? ` на ${tgMoney(sale.total)}` : ''}\nКто: ${who}`
        + (pays.length ? `\nВернули: ${pays.map((x) => `${x.method_name} ${tgMoney(x.amount)}`).join(' + ')}` : '')
        + (items.length ? '\n' + items.slice(0, 15).map((i) => `• ${i.name} × ${i.qty} = ${tgMoney(i.qty * i.price)}`).join('\n') : '');
    } else if (key === 'POST /api/expenses' || key === 'POST /api/kassa/expense') {
      const acc = result.method_id ? store.listPaymentMethods({ all: true }).find((m) => m.id === result.method_id)?.name : '';
      text = `💸 Расход ${tgMoney(result.amount)} — ${result.category}${acc ? `\nСо счёта: ${acc}` : ''}\nКто: ${who}${result.note ? `\nПричина: ${result.note}` : ''}`;
    } else if (key === 'DELETE /api/expenses/:id') text = `⚠️ Удалён расход ${tgMoney(result.amount)} — ${result.category}${result.note ? ` (${result.note})` : ''}\nКто удалил: ${who}`;
    else if (key === 'POST /api/accounts/ops') text = `${ACC_KIND[result.kind] || result.kind} ${tgMoney(result.amount)}: ${result.account}${result.to ? ` → ${result.to}` : ''}\nКто: ${who}${body.note ? `\nКомментарий: ${body.note}` : ''}`;
    else if (key === 'DELETE /api/accounts/ops/:id') text = `⚠️ Удалена операция по счёту: ${tgMoney(result.amount)} (${result.note || result.kind})\nКто удалил: ${who}`;
    else if (key === 'POST /api/invoice/receive' && result.doc) text = docTelegramText(result.doc, `${result.posted ? 'проведено' : 'черновик'} по фото накладной (новых товаров: ${result.created || 0})`, who);
    else if ((key === 'POST /api/certificates' || key === 'POST /api/certificates/issue') && result.number) text = `🎁 Сертификат №${result.number} на ${tgMoney(result.amount)}${body.free ? ' — выдан бесплатно' : ' — продан'}\nКто: ${who}`;
    else if (key === 'DELETE /api/certificates/:id') text = `⚠️ Удалён сертификат${result.number ? ` №${result.number}` : ''}\nКто: ${who}`;
  } catch (err) {
    console.error('Уведомление о движении для Telegram не собрано:', err.message);
    return;
  }
  // Вид уведомления — по тому, что произошло; выключенный вид не отправляется.
  if (!ev) {
    if (key === 'POST /api/docs/:id/unpost') ev = 'doc_unpost';
    else if (/\/api\/docs/.test(key)) ev = `doc_${result.kind}`;
    else if (key === 'POST /api/sales/:id/refund') ev = 'refund';
    else if (key === 'POST /api/kassa/expense') ev = 'expense_cash';
    else if (key === 'POST /api/expenses') ev = 'expense';
    else if (key.startsWith('DELETE /api/expenses') || key.startsWith('DELETE /api/accounts')) ev = 'deleted';
    else if (key === 'POST /api/accounts/ops') ev = 'account';
    else if (key === 'POST /api/invoice/receive') ev = 'invoice';
    else if (key.includes('/api/certificates')) ev = 'certificate';
  }
  if (text && (!ev || notifier.eventOn(ev))) notifier.sendTelegram(text.slice(0, 4000), tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
}
/* ---------- Автоматика: отчёты и уценка по расписанию, без участия владельца ---------- */
const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvOf = (head, rows) => '\ufeff' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
const rubs = (n) => `${Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} сом`;
const dayStr = (t) => new Date(t).toLocaleDateString('ru-RU');
const optText = (o) => { try { return Object.values(JSON.parse(o || '{}')).filter(Boolean).join(' · '); } catch { return ''; } };

async function deliver(ctx, { title, text, file, csv }) {
  const tg = ctx.notifier.telegramSettings();
  if (!tg.enabled) return false;
  try {
    await ctx.notifier.sendTelegram(text, tg);
    if (csv) await ctx.notifier.sendTelegramFile(file, csv, title, tg);
    return true;
  } catch (err) {
    console.error(`Автоотчёт «${title}» не отправлен в Telegram:`, err.message);
    return false;
  }
}

// job: weekly (неликвиды), monthly (товарный отчёт за прошлый месяц), markdown (автоуценка).
async function runJob(ctx, job, { manual = false } = {}) {
  const st = ctx.store;
  const shop = branchList().find((b) => b.id === ctx.id)?.name || '';
  const cfg = st.automation();
  if (job === 'weekly') {
    const r = st.deadStock({ days: cfg.weekly.days });
    const stageLine = r.stages.filter((x) => x.count).map((x) => `${x.days}+ дн.: ${x.count} тов., ${rubs(x.frozen)}`).join('\n') || 'нет';
    const title = `Неликвиды «${shop}» на ${dayStr(Date.now())}`;
    const share = r.stockValue ? Math.round((r.totals.frozen / r.stockValue) * 100) : 0;
    const text = `🐌 ${title}\nНе продаются ${r.days}+ дней: ${r.totals.count} товаров, ${r.totals.qty} шт.\nЗаморожено: ${rubs(r.totals.frozen)} по закупке (${share}% склада), в рознице ${rubs(r.totals.retail)}.\n\n${stageLine}\n\n`
      + `Больше всего денег лежит в:\n${r.list.slice(0, 10).map((x) => `• ${x.name}${optText(x.options) ? ` (${optText(x.options)})` : ''} — ${x.stock} ${x.unit}, ${x.idle} дн., ${rubs(x.frozen)}`).join('\n') || '—'}\n\n`
      + `Автоуценка: ${cfg.markdown.on ? `включена (${cfg.markdown.stages.map((s) => `${s.days} дн. → −${s.discount}%`).join(', ')})` : 'выключена'}.\nПолный список — в файле и в программе: Отчёты → Неликвиды.`;
    const csv = csvOf(['Товар', 'Модификация', 'Категория', 'Код', 'Штрихкод', 'Остаток', 'Дней без продаж', 'Последняя продажа', 'Закупка за шт', 'Заморожено', 'Цена', 'Скидка %', 'В рознице'],
      r.list.map((x) => [x.name, optText(x.options), x.category, x.code, x.barcode, x.stock, x.idle, x.lastSale ? dayStr(x.lastSale) : 'не было', x.cost, x.frozen, x.price, x.discount || 0, x.retail]));
    st.addAutoReport({ kind: 'weekly', title, summary: `${r.totals.count} товаров, заморожено ${rubs(r.totals.frozen)}`, data: r });
    const sent = await deliver(ctx, { title, text, file: `nelikvidy-${new Date().toISOString().slice(0, 10)}.csv`, csv });
    return { title, sent, count: r.totals.count };
  }
  if (job === 'monthly') {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const r = st.stockReport({ from, to });
    const month = new Date(from).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const t = r.totals;
    const title = `Товарный отчёт «${shop}» за ${month}`;
    const text = `📦 ${title}\nНа начало: ${t.open} шт · ${rubs(t.openCost)}\nПриход: +${t.in} шт · ${rubs(t.inCost)}\nРасход: −${t.out} шт · ${rubs(t.outCost)}`
      + `${t.inv ? `\nИнвентаризация: ${t.inv > 0 ? '+' : ''}${t.inv} шт` : ''}${t.other ? `\nПрочее: ${t.other > 0 ? '+' : ''}${t.other} шт` : ''}\nНа конец: ${t.close} шт · ${rubs(t.closeCost)} (в рознице ${rubs(t.closeRetail)})\n\nПо каждому товару — в файле и в программе: Отчёты → Товарный отчёт.`;
    const csv = csvOf(['Товар', 'Категория', 'Код', 'На начало', 'Приход', 'Расход', 'Инвентаризация', 'Прочее', 'На конец', 'Закупка за шт', 'На конец по закупке', 'На конец в рознице'],
      r.list.map((x) => [x.name, x.category, x.code, x.open, x.in, x.out, x.inv, x.other, x.close, x.cost, x.closeCost, x.closeRetail]));
    st.addAutoReport({ kind: 'monthly', title, summary: `на конец ${t.close} шт, ${rubs(t.closeCost)}`, data: { from, to, totals: t, list: r.list.slice(0, 3000) } });
    const sent = await deliver(ctx, { title, text, file: `tovarnyj-otchet-${new Date(from).toISOString().slice(0, 7)}.csv`, csv });
    // Итоги месяца по деньгам: прибыль и движение денег.
    try {
      const pr = st.profitByMonth({ from, to })[0];
      const cf = st.cashFlow({ from, to }).months[0];
      if (pr && cf) {
        const ftitle = `Итоги ${month} «${shop}»`;
        const ftext = `💹 ${ftitle}\nВыручка: ${rubs(pr.revenue)} (${pr.receipts} чеков)\nЦена закупки: −${rubs(pr.cost)}\nВаловая прибыль: ${rubs(pr.gross)}`
          + `\nЗарплата: −${rubs(pr.salary)}\nРасходы и списания: −${rubs(pr.costs - pr.salary)}\nЧистая прибыль: ${rubs(pr.net)}${pr.revenue ? ` (${Math.round((pr.net / pr.revenue) * 100)}% от выручки)` : ''}`
          + `\n\nДеньги на счетах: было ${rubs(cf.start)}, пришло +${rubs(cf.inflow)}, ушло −${rubs(cf.outflow)}, стало ${rubs(cf.end)}.\nПодробно: Отчёты → ДДС и прибыль.`;
        st.addAutoReport({ kind: 'money', title: ftitle, summary: `чистая прибыль ${rubs(pr.net)}, на счетах ${rubs(cf.end)}`, data: { profit: pr, cash: cf } });
        await deliver(ctx, { title: ftitle, text: ftext });
      }
    } catch (err) {
      console.error('Итоги месяца:', err.message);
    }
    return { title, sent };
  }
  if (job === 'markdown') {
    if (!cfg.markdown.on && !manual) return { skipped: true };
    const changes = st.autoMarkdown();
    if (!changes.length) return { count: 0 };
    const title = `Автоуценка «${shop}» ${dayStr(Date.now())}`;
    const text = `🏷️ ${title}: ${changes.length} товаров получили скидку.\n${changes.slice(0, 15).map((c) => `• ${c.name} — ${c.idle} дн. без продаж, скидка ${c.from}% → ${c.to}%, цена ${rubs(c.newPrice)}`).join('\n')}${changes.length > 15 ? `\n…и ещё ${changes.length - 15}` : ''}`
      + '\n\nРаспечатайте новые ценники: Отчёты → Неликвиды → «Ценники уценённых».';
    st.addAutoReport({ kind: 'markdown', title, summary: `${changes.length} товаров уценено`, data: { changes } });
    st.audit({ kind: 'change', userName: 'Автоматика', action: 'Автоуценка неликвидов', details: changes.slice(0, 30).map((c) => `${c.name}: ${c.from}% → ${c.to}%`).join('; ') });
    const sent = await deliver(ctx, { title, text, file: `avtoucenka-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: csvOf(['Товар', 'Категория', 'Дней без продаж', 'Остаток', 'Скидка была %', 'Скидка стала %', 'Цена', 'Цена со скидкой'], changes.map((c) => [c.name, c.category, c.idle, c.stock, c.from, c.to, c.price, c.newPrice])) });
    return { title, sent, count: changes.length };
  }
  throw new UserError('Неизвестная задача');
}

// Раз в 5 минут: что пора сделать в каждом магазине. Последний запуск — в настройках магазина (auto_last_*).
async function automationTick() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const b of branchList()) {
    const ctx = contextOf(b.id);
    if (!ctx) continue;
    const cfg = ctx.store.automation();
    // Первый раз (сразу после обновления) задачи не запускаются задним числом — ждут своего времени.
    const last = (k) => Number(ctx.store.setting(`auto_last_${k}`, String(Date.now()))) || 0;
    const mark = (k) => ctx.store.setSetting(`auto_last_${k}`, String(Date.now()));
    const due = [];
    if (cfg.markdown.on && now.getHours() >= cfg.markdown.hour && last('markdown') < today) due.push('markdown');
    if (cfg.weekly.on && now.getDay() === cfg.weekly.weekday && now.getHours() >= cfg.weekly.hour && last('weekly') < today) due.push('weekly');
    const monthDue = new Date(now.getFullYear(), now.getMonth(), cfg.monthly.day).getTime();
    if (cfg.monthly.on && now.getTime() >= monthDue + cfg.monthly.hour * 36e5 && last('monthly') < monthDue) due.push('monthly');
    for (const job of due) {
      try {
        mark(job);
        await als.run(ctx, () => runJob(ctx, job));
      } catch (err) {
        console.error(`Автоматика (${job}, ${b.name}):`, err.message);
      }
    }
  }
}
setTimeout(() => automationTick().catch((e) => console.error('Автоматика:', e.message)), 30_000).unref?.();
setInterval(() => automationTick().catch((e) => console.error('Автоматика:', e.message)), 5 * 60_000).unref?.();
// Маркер Instagram живёт 60 дней — продлеваем заранее (проверка раз в 6 часов).
const igRefresh = () => {
  for (const b of branchList()) {
    const ctx = contextOf(b.id);
    ctx?.crm.refreshInstagramToken().catch((e) => ctx.store.audit({ kind: 'change', userName: 'Instagram', action: 'Маркер Instagram не продлён', details: String(e.message).slice(0, 300) }));
  }
};
setInterval(igRefresh, 6 * 3600e3).unref?.();
setTimeout(igRefresh, 60_000).unref?.();

// Место на диске сервера: меньше 1,5 ГБ или меньше 15% — уведомление в Telegram (не чаще раза в сутки, пока места мало).
const DISK_LOW_BYTES = 1.5 * 1024 ** 3;
const gb = (b) => (b / 1024 ** 3).toFixed(1).replace('.', ',');
async function diskCheck() {
  let st;
  try { st = fs.statfsSync(path.dirname(DB_FILE)); } catch { return; }
  const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
  const low = free < DISK_LOW_BYTES || free / total < 0.15;
  const last = Number(mainStore.setting('disk_alert_at', '0')) || 0;
  if (!low) { if (last) mainStore.setSetting('disk_alert_at', '0'); return; }
  if (Date.now() - last < 24 * 3600e3) return;
  const ctx = contextOf(1);
  const tg = ctx?.notifier.tgFor('disk_low');
  if (!tg) return;
  const text = `💾 На сервере заканчивается место\nСвободно ${gb(free)} ГБ из ${gb(total)} ГБ (${Math.round((free / total) * 100)}%).\nКогда место кончится, программа не сможет сохранять продажи. Напишите разработчику — подскажет, что безопасно удалить.`;
  try {
    await ctx.notifier.sendTelegram(text, tg);
    mainStore.setSetting('disk_alert_at', String(Date.now()));
  } catch (err) {
    console.error('Уведомление о месте на диске не отправлено:', err.message);
  }
}
setInterval(() => diskCheck().catch(() => {}), 6 * 3600e3).unref?.();
setTimeout(() => diskCheck().catch(() => {}), 2 * 60_000).unref?.();

const storeName = (id) => branchList().find((b) => b.id === (id || 1))?.name || '';

// Администратор из переменных. APP_PASSWORD — пароль из прошлых версий, где вход был без email.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || '';
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 8) {
    console.error('Пароль администратора в ADMIN_PASSWORD должен быть не короче 8 символов.');
    process.exit(1);
  }
  const fingerprint = crypto.createHash('sha256').update(`${ADMIN_EMAIL.toLowerCase()}\n${ADMIN_PASSWORD}`).digest('hex');
  store.ensureAdmin(ADMIN_EMAIL, () => hashPassword(ADMIN_PASSWORD), fingerprint);
}
// Владелец — отдельная роль. В базах до разделения ролей им становится первый администратор.
const madeOwner = mainStore.ensureOwner();
if (madeOwner) console.log(`Владельцем назначен ${madeOwner.email}`);

// Копии паролей и PIN, заданных владельцем или администратором, шифруются (AES-256-GCM) своим ключом.
const SECRETS_KEY = crypto.createHash('sha256').update(mainStore.setting('secrets_key', crypto.randomBytes(32).toString('base64url'))).digest();
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRETS_KEY, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}
function decryptSecret(value) {
  try {
    const [v, iv, tag, data] = String(value || '').split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', SECRETS_KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

if (process.env.REQUIRE_PASSWORD === '1' && store.activeAdmins() === 0) {
  console.error('Задайте администратора в переменных ADMIN_EMAIL и ADMIN_PASSWORD. Без него программа на сервере не запускается.');
  process.exit(1);
}

// Сотрудники всех магазинов для входа: email ищется сначала в основном магазине, потом в филиалах.
// В cookie — «магазин-id» (у основного — просто id, как в прошлых версиях).
const staffDirectory = {
  countUsers: () => mainStore.countUsers(),
  keyOf: (u) => (u.branch && u.branch !== 1 ? `${u.branch}-${u.id}` : String(u.id)),
  findUser(key) {
    const [b, id] = String(key).includes('-') ? String(key).split('-') : [1, key];
    const ctx = contextOf(b);
    const u = ctx && ctx.store.findUser(id);
    return u ? { ...u, branch: ctx.id } : null;
  },
  findUserByEmail(email) {
    for (const b of branchList()) {
      const ctx = contextOf(b.id);
      const u = ctx?.store.findUserByEmail(email);
      if (u && !u.owner_shadow && !u.moved_to) return { ...u, branch: ctx.id };
    }
    return null;
  },
};
const auth = createAuth(staffDirectory, process.env.SESSION_SECRET || mainStore.setting('session_secret', crypto.randomBytes(32).toString('base64url')));
const isOwner = (u) => u && (u.branch || 1) === 1 && u.role === 'owner';
// В каких магазинах сотрудник может работать: владелец — во всех, остальные — в своём и отмеченных в карточке.
function allowedBranches(u) {
  const all = branchList().map((b) => b.id);
  if (!u) return [1];
  if (isOwner(u)) return all;
  const extra = u.stores ? JSON.parse(u.stores) : [];
  return [...new Set([u.branch || 1, ...extra])].filter((id) => all.includes(id));
}

// Магазин запроса: сотрудник филиала работает в своём, владелец — в выбранном (cookie shop_branch).
function branchCookie(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)shop_branch=(\d+)/);
  return m ? Number(m[1]) : null;
}
function resolveContext(req, user) {
  if (!user) return { ctx: contexts.get(1), user: null, owner: null };
  if (isOwner(user)) {
    const ctx = contextOf(branchCookie(req) || 1) || contexts.get(1);
    if (ctx.id === 1) return { ctx, user, owner: user };
    const shadow = ctx.store.ownerShadow(user);
    return { ctx, user: { ...shadow, branch: ctx.id }, owner: user };
  }
  // Сотрудник с доступом в другой магазин работает там под своей записью-копией (роль и права — из своего магазина).
  const want = branchCookie(req);
  if (want && want !== user.branch && allowedBranches(user).includes(want)) {
    const ctx = contextOf(want);
    try {
      return { ctx, user: { ...ctx.store.shadowOf(user), branch: ctx.id }, owner: null };
    } catch { /* в том магазине уже есть сотрудник с таким email — работает в своём */ }
  }
  return { ctx: contextOf(user.branch) || contexts.get(1), user, owner: null };
}

// Действие над сотрудником другого магазина (?branch=N) — только у владельца.
function inBranch(url, user, fn) {
  const b = Number(url.searchParams.get('branch')) || current().id;
  if (b === current().id) return fn();
  if (auth.enabled && !user?.owner) throw new UserError('Сотрудников других магазинов меняет владелец');
  const ctx = contextOf(b);
  if (!ctx) throw new UserError('Магазин не найден');
  return als.run(ctx, fn);
}

// Перевод в другой магазин и доступ к магазинам — только владелец.
function setEmployeeBranch(id, { home, stores }, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазин сотрудника меняет владелец');
  const from = current();
  const all = branchList().map((b) => b.id);
  const to = Number(home) || from.id;
  if (!all.includes(to)) throw new UserError('Магазин не найден');
  const extra = (stores || []).map(Number).filter((b) => all.includes(b) && b !== to);
  if (to === from.id) return store.setUserStores(id, extra);
  const src = from.store.findUser(id);
  if (!src) throw new UserError('Сотрудник не найден');
  for (const b of branchList()) {
    const other = b.id !== from.id && contextOf(b.id).store.findUserByEmail(src.email);
    if (other && b.id === to && !other.owner_shadow && !other.moved_to) throw new UserError(`В магазине «${b.name}» уже есть сотрудник с этим email`);
  }
  from.store.moveOut(id, to);
  return contextOf(to).store.moveIn({ ...src, stores: extra.length ? JSON.stringify(extra) : null });
}

// Сотрудник с правом «Сотрудники», но не администратор, не может назначать
// администраторов и менять их: иначе он выдал бы себе все права.
// Настройки SMS. Пароли и ключи на экран не отдаём — только признак, что они заданы.
const smsSettings = () => ({ enabled: false, provider: '', login: '', password: '', apiKey: '', sender: '', url: '', method: 'POST', body: '', successText: '', template: '', test: false,
  ...JSON.parse(store.setting('sms', '{}')) });
const smsPublic = (s) => ({ enabled: s.enabled, provider: s.provider, login: s.login, sender: s.sender, url: s.url, method: s.method, body: s.body,
  successText: s.successText, template: s.template, test: s.test, hasPassword: Boolean(s.password), hasApiKey: Boolean(s.apiKey), providers: SMS_PROVIDERS });

function setSms(input) {
  const cur = smsSettings();
  const str = (v, field, max = 200) => String(v ?? '').trim().slice(0, max);
  const next = {
    enabled: Boolean(input.enabled),
    provider: Object.hasOwn(SMS_PROVIDERS, input.provider) ? input.provider : '',
    login: str(input.login),
    password: input.password ? str(input.password) : cur.password,
    apiKey: input.apiKey ? str(input.apiKey) : cur.apiKey,
    sender: str(input.sender, 'Отправитель', 40),
    url: str(input.url, 'Адрес', 500),
    method: input.method === 'GET' ? 'GET' : 'POST',
    body: str(input.body, 'Тело запроса', 2000),
    successText: str(input.successText),
    template: str(input.template, 'Текст', 160),
    test: Boolean(input.test),
  };
  if (next.template && !next.template.includes('{code}')) throw new UserError('В тексте SMS должно быть {code} — туда подставится код');
  if (next.url && !/^https?:\/\//.test(next.url)) throw new UserError('Адрес провайдера должен начинаться с https://');
  if (next.enabled) {
    const need = { nikita: ['login', 'password', 'sender'], smsru: ['apiKey'], twilio: ['login', 'password', 'sender'], custom: ['url'] }[next.provider];
    if (!need) throw new UserError('Выберите провайдера SMS');
    if (need.some((k) => !next[k])) throw new UserError('Заполните данные провайдера: ' + need.map((k) => ({ login: 'логин', password: 'пароль', sender: 'отправитель', apiKey: 'API-ключ', url: 'адрес' }[k])).join(', '));
  }
  store.setSetting('sms', JSON.stringify(next));
  return next;
}

// Настройки WhatsApp для экрана: секреты не отдаём, только признак, что они заданы.
const whatsappPublic = (s) => ({ enabled: s.enabled, verifyToken: s.verifyToken, phoneNumberId: s.phoneNumberId, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken),
  otpEnabled: Boolean(s.otpEnabled), otpTemplate: s.otpTemplate || '', otpLang: s.otpLang || 'ru', webhookPath: '/webhooks/whatsapp' });

// Закупочная цена, себестоимость и поставщик — только тем, кому они нужны для работы (кассиру — нет).
const COST_RIGHTS = ['products.cost', 'arrivals', 'stock', 'writeoff', 'transfer', 'docs.sale', 'abc', 'finance', 'reports.stock', 'reports.money', 'kpi', 'receive.photo'];
const canCost = (user) => COST_RIGHTS.some((r) => can(user, r));
// Без права на закупку цены закупки и себестоимость из запроса не принимаются (не затираются нулями).
const stripCost = (user, body) => { if (body && !canCost(user)) { delete body.cost; delete body.purchase; } return body; };
const hideStock = (user, list) => {
  const stock = can(user, 'stock.view');
  const cost = COST_RIGHTS.some((r) => can(user, r));
  if (stock && cost) return list;
  return list.map((p) => {
    const x = { ...p };
    if (!stock) x.stock = null;
    if (!cost) { delete x.cost; delete x.purchase; delete x.supplier_id; delete x.supplier; }
    return x;
  });
};

// Право на вид документа: продажа, закупка, списание… — у каждого своё (см. DOC_KINDS в db.js).
// Остаток товара во всех магазинах, где может работать сотрудник. Товар в другом магазине
// ищется так же, как при перемещении: по штрихкоду, коду с названием или названию.
function productStores(id, user) {
  const here = current();
  const p = here.store.getProductInfo(id);
  // user — уже публичная запись: stores разобран в массив, owner — владелец ли.
  const allowed = new Set([user?.branch || 1, ...(Array.isArray(user?.stores) ? user.stores : [])]);
  return branchList().filter((b) => b.id === here.id || !auth.enabled || !user || user.owner || allowed.has(b.id)).map((b) => {
    const ctx = contextOf(b.id);
    const found = b.id === here.id
      ? (p.children.length ? { stock: p.children.reduce((s, k) => s + k.stock, 0), price: Math.min(...p.children.map((k) => k.price)), archived: Boolean(p.archived), variants: p.children.length } : { stock: p.stock, price: p.price, archived: Boolean(p.archived) })
      : ctx?.store.stockOfSame(p, p.children) ?? null;
    return { id: b.id, name: b.name, current: b.id === here.id, found: Boolean(found), ...(found || {}) };
  });
}

// Расположение: названия, значки, скрытые разделы, порядок, закреплённые в верхнем меню, блоки главной.
function readLayout() {
  try { return JSON.parse(mainStore.setting('layout', '{}')) || {}; } catch { return {}; }
}
function saveLayout(input) {
  const key = (k) => typeof k === 'string' && /^[a-z.:_-]{1,40}$/i.test(k);
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const out = { sections: {}, order: {}, pinned: [], home: { order: [], hidden: [] } };
  for (const [k, v] of Object.entries(input?.sections || {})) {
    if (!key(k) || !v || typeof v !== 'object') continue;
    const s = {};
    if (str(v.name, 60)) s.name = str(v.name, 60);
    if (str(v.icon, 8)) s.icon = str(v.icon, 8);
    if (v.hidden) s.hidden = true;
    if (Object.keys(s).length) out.sections[k] = s;
  }
  for (const [g, list] of Object.entries(input?.order || {})) if (Array.isArray(list)) out.order[str(g, 40)] = list.filter(key).slice(0, 60);
  out.pinned = (Array.isArray(input?.pinned) ? input.pinned : []).filter(key).slice(0, 8);
  out.home.order = (Array.isArray(input?.home?.order) ? input.home.order : []).filter(key).slice(0, 20);
  out.home.hidden = (Array.isArray(input?.home?.hidden) ? input.home.hidden : []).filter(key).slice(0, 20);
  mainStore.setSetting('layout', JSON.stringify(out));
  return out;
}

function docRight(user, kind) {
  const k = store.docKinds[kind];
  if (!k) throw new UserError('Неизвестный вид документа');
  if (!can(user, k.right)) throw new UserError(`У вас нет права на документы «${k.many}»`);
  return true;
}

// Новый магазин: своя база рядом с основной. По желанию — копия каталога товаров (без остатков) и категорий.
function createBranch(input, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазины заводит владелец — администратор основного магазина');
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new UserError('Название магазина');
  const list = branchList();
  if (list.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new UserError('Магазин с таким названием уже есть');
  const id = Math.max(...list.map((b) => b.id)) + 1;
  const b = { id, name, address: String(input.address ?? '').trim().slice(0, 200), phone: String(input.phone ?? '').trim().slice(0, 40), file: `branch-${id}.db`, created_at: Date.now() };
  mainStore.setSetting('branches', JSON.stringify([...list.filter((x) => !x.main), b]));
  const ctx = contextOf(id);
  ctx.store.setDesign?.({ ...mainStore.design(), name });
  if (input.copyProducts) {
    const db = ctx.store.db;
    db.exec(`ATTACH DATABASE '${path.join(path.dirname(DB_FILE), path.basename(DB_FILE)).replace(/'/g, "''")}' AS src`);
    try {
      // Товары копируются по названиям колонок; поставщики у каждого магазина свои — связь не переносится.
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
        .filter((c) => db.prepare('PRAGMA src.table_info(products)').all().some((x) => x.name === c)).join(', ');
      db.exec(`INSERT INTO categories SELECT * FROM src.categories;
        INSERT INTO images SELECT * FROM src.images WHERE id IN (SELECT image_id FROM src.categories WHERE image_id IS NOT NULL);
        INSERT INTO products (${cols}) SELECT ${cols} FROM src.products WHERE deleted = 0;
        INSERT INTO product_photos SELECT * FROM src.product_photos WHERE product_id IN (SELECT id FROM src.products WHERE deleted = 0);
        INSERT INTO product_images (id, product_id, mime, data, position, created_at) SELECT id, product_id, mime, data, position, created_at FROM src.product_images WHERE product_id IN (SELECT id FROM src.products WHERE deleted = 0);
        UPDATE products SET stock = 0, supplier_id = NULL;`);
    } finally {
      db.exec('DETACH DATABASE src');
    }
  }
  return { ...b, products: ctx.store.listProducts({}).length };
}

function updateBranch(id, input, user) {
  if (auth.enabled && !user?.owner) throw new UserError('Магазины меняет владелец');
  const n = Number(id);
  if (n === 1) {
    mainStore.setDesign?.({ ...mainStore.design(), name: String(input.name ?? '').trim().slice(0, 80) || mainStore.design().name });
    return branchList()[0];
  }
  const list = branchList().filter((b) => !b.main);
  const b = list.find((x) => x.id === n);
  if (!b) throw new UserError('Магазин не найден');
  Object.assign(b, { name: String(input.name ?? b.name).trim().slice(0, 80) || b.name, address: String(input.address ?? b.address).trim().slice(0, 200), phone: String(input.phone ?? b.phone ?? '').trim().slice(0, 40) });
  mainStore.setSetting('branches', JSON.stringify(list));
  return b;
}

// Владельца и администраторов назначает и меняет только владелец. Администратор не даёт прав, которых нет у него самого,
// и не меняет свои права.
// Что из цен видно в переносе из CloudShop: у владельца и админа — всё, остальным — по галочкам.
const migSee = (user) => ({ purchase: can(user, 'migrate.purchase'), cost: can(user, 'migrate.cost'), markup: can(user, 'migrate.markup'), margin: can(user, 'migrate.margin') });
function migOut(user, it) {
  const see = migSee(user);
  const d = it.data;
  const buy = Number(d.purchase) || 0, price = Number(d.price) || 0;
  const calc = { markup: see.markup && buy > 0 ? ((price - buy) / buy) * 100 : null, margin: see.margin && buy > 0 && price > 0 ? ((price - buy) / price) * 100 : null };
  const cut = (x) => {
    const o = { ...x };
    if (!see.purchase) delete o.purchase;
    if (!see.cost) delete o.cost;
    if (!see.markup) delete o.markup;
    if (!see.margin) delete o.margin;
    return o;
  };
  return { ...it, data: { ...cut(d), calc }, sources: it.sources.map(cut) };
}
function accessOut() {
  const users = store.listUsers().filter((u) => u.role !== 'owner' && !u.owner_shadow);
  const groups = [];
  for (const r of RIGHTS) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push(g = { name: r.group, rights: [] });
    g.rights.push({ key: r.key, label: r.label });
  }
  return {
    groups, roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.name])),
    users: users.map((u) => ({ id: u.id, name: u.name || u.email, email: u.email, role: u.role, disabled: u.disabled, custom: Array.isArray(u.rights), rights: rightsOf({ ...u, rights: u.rights }) })),
  };
}
function guardAdmin(user, target, body) {
  if (!user || user.role === 'owner') return;
  const high = (r) => r === 'owner' || r === 'admin';
  if (high(target?.role) || high(body.role)) throw new UserError('Администраторов и владельца назначает и меняет только владелец');
  if (target && target.id === user.id && body.rights !== undefined) throw new UserError('Свои права может поменять только владелец');
  if (Array.isArray(body.rights)) {
    const mine = rightsOf(user);
    const extra = body.rights.filter((r) => !mine.includes(r));
    if (extra.length) throw new UserError('Нельзя дать сотруднику права, которых нет у вас самого');
  }
}
const seesSecrets = (user) => !auth.enabled || user?.role === 'owner' || can(user, 'staff.passwords');

// Актуальная копия пароля или PIN сотрудника для владельца: пишется, когда сотрудник меняет их сам
// и при входе (так становятся видны и пароли, заданные до этой функции). Пароль владельца не хранится.
function keepSecret(u, field, value) {
  if (!u || u.role === 'owner' || u.owner_shadow || !value) return;
  const st = contextOf(u.branch || 1)?.store || store;
  const row = st.findUser(u.id);
  if (!row) return;
  if (decryptSecret(field === 'pin' ? row.secret_pin : row.secret_pw) === String(value)) return;
  st.setUserSecrets(u.id, { [field]: String(value) }, encryptSecret);
}

// PIN для смены кассира: 4–6 цифр; пустой — убрать PIN.
function pinHash(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!/^\d{4,6}$/.test(s)) throw new UserError('PIN-код — от 4 до 6 цифр');
  if (/^(\d)\1+$/.test(s) || '0123456789'.includes(s) || '9876543210'.includes(s)) throw new UserError('Слишком простой PIN-код, придумайте другой');
  return hashPassword(s);
}

function password(value) {
  const s = String(value ?? '');
  if (s.length < 8) throw new UserError('Пароль должен быть не короче 8 символов');
  if (s.length > 200) throw new UserError('Слишком длинный пароль');
  return hashPassword(s);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// limit — сколько байт можно прислать: публичным адресам (вход, витрина) — немного, сотрудникам — до 20 МБ (фото).
async function readBody(req, limit = 20e6) {
  if (Number(req.headers['content-length']) > limit) throw new UserError('Слишком большой запрос');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError('Слишком большой запрос');
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

// [метод, шаблон пути, обработчик(params, url, body, user), нужное право из roles.js]
// 'any' — любому вошедшему сотруднику.
const routes = [
  ['GET', '/api/status', (p, url, body, user) => ({
    empty: store.isEmpty(), auth: auth.enabled, user,
    branch: (() => {
      const b = branchList().find((x) => x.id === current().id);
      const home = user ? staffDirectory.findUserByEmail(user.email) : null;
      const allowed = home ? allowedBranches(home) : [1];
      return { id: b.id, name: b.name, count: branchList().length, allowed: branchList().filter((x) => allowed.includes(x.id)).map((x) => ({ id: x.id, name: x.name })) };
    })(),
    can: rightsOf(user),
    roles: ROLES,
    rights: RIGHTS,
    loyalty: store.loyalty(),
    design: store.design(),
    // Расположение разделов и блоков главной — настраивает владелец, одно на все магазины.
    layout: readLayout(),
    shop: { enabled: store.shop().enabled },
    newOrders: can(user, 'orders') ? store.countNewOrders() : 0,
  }), 'any'],
  ['GET', '/api/kassa/users', () => store.kassaUsers(), 'pos'],
  ['GET', '/api/branches', (p, url, body, user) => ({
    branches: branchList().map((b) => ({ id: b.id, name: b.name, address: b.address || '', phone: b.phone || '', main: Boolean(b.main), current: b.id === current().id })),
    canManage: Boolean(user?.owner) || !auth.enabled,
  }), 'any'],
  ['POST', '/api/branches', (p, url, body, user) => createBranch(body, user), 'any'],
  ['PUT', '/api/branches/:id', (p, url, body, user) => updateBranch(p.id, body, user), 'any'],
  ['PUT', '/api/me/pin', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.setUserPin(user.id, pinHash(body.pin));
    const pinText = String(body.pin ?? '').trim();
    if (pinText) keepSecret({ ...user, branch: current().id }, 'pin', pinText); // владелец видит актуальный PIN
    else store.setUserSecrets(user.id, { pin: null }, encryptSecret); // PIN убран
    return { ok: true };
  }, 'any'],
  ['PUT', '/api/me/password', (p, url, body, user) => {
    if (!user) throw new UserError('Сначала заведите сотрудников');
    if (!checkPassword(body.current, store.findUser(user.id).password_hash)) throw new UserError('Текущий пароль указан неверно');
    store.updateUser(user.id, {}, password(body.password));
    keepSecret({ ...user, branch: current().id }, 'password', body.password); // владелец видит актуальный пароль
    return { ok: true };
  }, 'any'],

  // Без права «Видеть остатки» остаток не уходит в браузер вовсе.
  ['GET', '/api/products', (p, url, body, user) => hideStock(user, store.listProducts({ archived: url.searchParams.get('archived') === '1' })), 'any'],
  ['POST', '/api/products', (p, url, body, user) => store.createProduct(stripCost(user, body)), 'products'],
  ['PUT', '/api/products/:id', (p, url, body, user) => store.updateProduct(p.id, stripCost(user, body)), 'products'],
  // Перенос из CloudShop (раздел на время переноса; право «Импорт»).
  // Перенос из CloudShop: закупка, себестоимость, наценка и маржа — каждая по своему праву. Наценку и маржу сервер
  // считает сам (от закупки), поэтому их можно показать, не показывая закупку.
  ['GET', '/api/migrate', (p, url, body, user) => ({ items: store.migrateList().map((it) => migOut(user, it)), see: migSee(user) }), ['migrate', 'migrate.view']],
  ['POST', '/api/migrate/upload', (p, url, body) => store.migrateUpload(body.rows), 'migrate'],
  ['PUT', '/api/migrate/:id', (p, url, body, user) => {
    const see = migSee(user);
    const patch = { ...body };
    if (!see.purchase) delete patch.purchase;
    if (!see.cost) delete patch.cost;
    // Сменили закупку, себестоимость не трогали и она «следовала» за закупкой — себестоимость = закупка + добавка.
    if (patch.purchase !== undefined && patch.cost === undefined) {
      const cur = store.migrateGet(p.id).data;
      const extra = store.costExtra();
      if (!cur.cost || cur.cost === cur.purchase || Math.abs(cur.cost - cur.purchase - extra) < 0.01) patch.cost = Math.round((Number(String(patch.purchase).replace(',', '.')) + extra) * 100) / 100;
    }
    // Наценка → цена продажи от закупки (закупку знает сервер).
    if (patch.markupPct !== undefined) {
      if (!see.markup) throw new UserError('Нет права менять наценку');
      const m = Number(String(patch.markupPct).replace(',', '.'));
      const buy = store.migrateGet(p.id).data.purchase;
      if (!Number.isFinite(m) || !(buy > 0)) throw new UserError('Наценка считается от цены закупки — у товара её нет');
      patch.price = Math.round(buy * (1 + m / 100));
      delete patch.markupPct;
    }
    return migOut(user, store.migrateUpdate(p.id, patch));
  }, 'migrate'],
  ['POST', '/api/migrate/bulk', (p, url, body, user) => {
    const see = migSee(user);
    const patch = { ...(body.patch || {}) };
    if (!see.purchase) delete patch.purchase;
    if (!see.cost) delete patch.cost;
    return store.migrateBulk(body.ids, patch);
  }, 'migrate'],
  ['POST', '/api/migrate/merge', (p, url, body) => store.migrateMerge(body.ids), 'migrate'],
  ['POST', '/api/migrate/:id/split', (p) => store.migrateSplit(p.id), 'migrate'],
  ['POST', '/api/migrate/import', (p, url, body) => store.migrateImport(body.ids), 'migrate'],
  ['DELETE', '/api/migrate', () => store.migrateClear(), 'migrate'],
  ['POST', '/api/products/import', (p, url, body) => store.importProducts(body.rows, { update: Boolean(body.update) }), 'import'],
  ['PUT', '/api/products/:id/stock', (p, url, body, user) => store.setStock(p.id, body.stock, user), 'stock'],
  // Групповое изменение: удаление требует отдельного права.
  ['POST', '/api/products/bulk', (p, url, body, user) => {
    if (body.action === 'delete' && !can(user, 'products.delete')) throw new UserError('У вас нет права удалять товары');
    if (['purchase', 'cost'].includes(body.action) && !canCost(user)) throw new UserError('У вас нет права менять цену закупки');
    return store.bulkProducts(body);
  }, 'products'],
  ['DELETE', '/api/products/:id', (p) => store.bulkProducts({ ids: [Number(p.id)], action: 'delete' }), 'products.delete'],
  // mine=1 — способы, доступные вошедшему сотруднику (для кассы); all=1 — весь справочник с выключенными.
  ['GET', '/api/payment-methods', (p, url, body, user) => (url.searchParams.get('mine') === '1'
    ? store.allowedPaymentMethods(user && store.findUser(user.id))
    : { methods: store.listPaymentMethods({ all: url.searchParams.get('all') === '1' }), kinds: store.paymentKinds }), 'any'],
  ['POST', '/api/payment-methods', (p, url, body) => store.savePaymentMethod(null, body), ['settings', 'accounts']],
  ['PUT', '/api/payment-methods/:id', (p, url, body) => store.savePaymentMethod(p.id, body), 'settings'],
  ['PUT', '/api/payment-methods-order', (p, url, body) => store.sortPaymentMethods(body.ids), 'settings'],
  ['GET', '/api/reports/payments', (p, url) => store.reportPayments(range(url)), ['kpi', 'sales']],
  ['GET', '/api/categories', () => store.listCategories(), 'any'],
  ['POST', '/api/categories', (p, url, body) => store.createCategory(body), ['products', 'categories']],
  ['PUT', '/api/categories/:id', (p, url, body) => store.renameCategory(p.id, body), ['products', 'categories']],
  ['DELETE', '/api/categories/:id', (p, url) => store.deleteCategory(p.id, { moveTo: url.searchParams.get('moveTo') || '' }), ['products', 'categories']],
  ['PUT', '/api/categories-order', (p, url, body) => store.sortCategories(body.ids), ['products', 'shop', 'categories']],
  // Картинка категории для витрины: загрузить (mime + data) или убрать (пустое тело).
  ['PUT', '/api/categories/:id/image', (p, url, body) => store.setCategoryImage(p.id, body.data ? store.addImage(body).id : null), ['products', 'shop', 'photos', 'categories']],
  ['POST', '/api/products/:id/variants', (p, url, body, user) => store.createVariants(p.id, { ...body, variants: Array.isArray(body.variants) ? body.variants.map((v) => stripCost(user, { ...v })) : body.variants }), 'products'],
  ['GET', '/api/barcode', () => ({ barcode: store.newBarcode() }), 'products'],
  ['GET', '/api/products/:id/info', (p, url, body, user) => {
    const info = store.getProductInfo(p.id);
    return can(user, 'stock.view') ? info : { ...info, stock: null, children: info.children.map((k) => ({ ...k, stock: null })) };
  }, ['products', 'dashboard', 'stock.view']],
  ['GET', '/api/products/:id/history', (p) => store.productHistory(p.id), 'products.history'],
  ['GET', '/api/products/:id/stores', (p, url, body, user) => productStores(p.id, user), 'stock.view'],
  ['PUT', '/api/products/:id/photo', (p, url, body) => store.setPhoto(p.id, body), 'photos'],
  ['DELETE', '/api/products/:id/photo', (p) => store.deletePhoto(p.id), 'photos'],
  ['GET', '/api/products/gallery-counts', () => store.galleryCounts(), 'photos'],
  /* ---------- MONT AI Studio (без платных API: задания для ChatGPT вручную + локальная обработка) ---------- */
  ['GET', '/api/studio/meta', (p, url, body, user) => ({
    operations: studioPrompts.OPERATIONS, roles: studioPrompts.ROLES, details: studioPrompts.DETAILS, backgrounds: studioPrompts.BACKGROUNDS, aspects: studioPrompts.ASPECTS,
    genders: studioPrompts.GENDERS, ages: studioPrompts.AGES, builds: studioPrompts.BUILDS, poses: studioPrompts.POSES, framings: studioPrompts.FRAMINGS,
    settings: studioPrompts.SETTINGS, platforms: studioPrompts.PLATFORMS, adStyles: studioPrompts.AD_STYLES, checklist: studio.CHECKLIST, canAttach: can(user, 'photos'),
    required: studioAi.REQUIRED, ai: Boolean(invoice.apiKey(mainStore)), canDescribe: can(user, 'products'),
  }), 'studio'],
  ['GET', '/api/studio/sessions', (p, url) => studio.listSessions(current().id, { status: url.searchParams.get('status') || 'open' }).map((s) => ({ ...s, product: studioProductBrief(s) })), 'studio'],
  ['POST', '/api/studio/sessions', (p, url, body, user) => {
    let product = studioProduct(current().id, body.productId);
    let variant = null;
    if (product.parent_id) { variant = product; product = studioProduct(current().id, product.parent_id); }
    if (body.variantId) variant = studioVariant(current().id, product, body.variantId);
    let color = '';
    if (body.color) ({ variant, color } = studioColorPick(current().id, product, String(body.color)));
    return studioSessionOut(studio.createSession({ branchId: current().id, product, variant: variant && { id: variant.id, label: color || variantLabel(variant) }, color, title: body.title }, user));
  }, 'studio'],
  ['GET', '/api/studio/sessions/:id', (p) => studioSessionOut(studio.getSession(p.id, current().id)), 'studio'],
  ['DELETE', '/api/studio/sessions/:id', (p, url, body, user) => studio.deleteSession(p.id, current().id, user), 'studio'],
  ['PUT', '/api/studio/sessions/:id', (p, url, body, user) => {
    const s = studio.getSession(p.id, current().id);
    let variant = null;
    if (body.variantId) variant = studioVariant(s.branch_id, studioProduct(s.branch_id, s.product_id), body.variantId);
    let color = '';
    if (body.color) { ({ variant, color } = studioColorPick(s.branch_id, studioProduct(s.branch_id, s.product_id), String(body.color))); body.variantId = variant.id; }
    return studioSessionOut(studio.updateSession(p.id, current().id, body, user, { variant: variant && { id: variant.id, label: color || variantLabel(variant) }, color }));
  }, 'studio'],
  ['POST', '/api/studio/sessions/:id/assets', (p, url, body, user) => studio.addAsset(p.id, current().id, body, user), 'studio'],
  ['PUT', '/api/studio/assets/:id', (p, url, body, user) => studio.setRole(p.id, current().id, body.role, user), 'studio'],
  ['DELETE', '/api/studio/assets/:id', (p, url, body, user) => studio.deleteAsset(p.id, current().id, user), 'studio'],
  ['POST', '/api/studio/sessions/:id/tasks', (p, url, body, user) => {
    const s = studio.getSession(p.id, current().id);
    // Обязательный набор исходников: спереди, сзади, деталь, бирка или логотип.
    const miss = studioAi.missingRoles(s.assets.filter((a) => a.kind === 'source'));
    if (miss.length) throw new UserError(`Не хватает исходных фото: ${miss.map((m) => m.label).join(', ')}. Загрузите их и укажите, что на фото`);
    // Claude нашёл проблемы с исходниками — задание только после пересъёмки или если сотрудник явно решил продолжить.
    if (s.ai && s.ai.ready === false && !body.force) throw new UserError(`Claude: исходники надо поправить — ${s.ai.summary || 'см. замечания к фото'}. Переснимите или нажмите «Всё равно продолжить»`, { aiNotReady: true });
    return studio.createTask(s.id, current().id, body, studioFacts(s), user);
  }, 'studio'],
  // Claude проверяет исходники: набор, резкость, кадр, свет — и описывает вещь. Фото присылает браузер, уменьшенные
  // до 1568 px (так их видит Claude); номера проверяются — только фото этой съёмки.
  ['POST', '/api/studio/sessions/:id/ai-sources', async (p, url, body, user) => {
    const s = studio.getSession(p.id, current().id);
    const sources = s.assets.filter((a) => a.kind === 'source');
    const images = studioAiImages(body.images, sources, 12);
    const { data, usage } = await studioAi.checkSources(current().store, { facts: studioFacts(s), images }, UserError);
    data.missing = studioAi.missingRoles(sources).map((m) => m.label);
    if (data.missing.length) data.ready = false;
    studio.setSessionAi(s.id, current().id, { ...data, photoIds: images.map((i) => i.id), usage }, user, data.summary);
    return studioSessionOut(studio.getSession(s.id, current().id));
  }, 'studio'],
  // Claude сравнивает результат с оригиналами задания и отмечает пункты проверки.
  ['POST', '/api/studio/assets/:id/ai-check', async (p, url, body, user) => {
    const a = studio.assetData(p.id, current().id);
    if (a.kind === 'source') throw new UserError('Исходник сравнивать не с чем');
    const s = studio.getSession(a.sessionId, current().id);
    const task = s.tasks.find((t) => t.id === a.taskId);
    const allowed = s.assets.filter((x) => x.kind !== 'result' && (!task || task.sourceIds.includes(x.id)));
    const originals = studioAiImages(body.originals, allowed.length ? allowed : s.assets.filter((x) => x.kind === 'source'), 6);
    const [result] = studioAiImages([body.result], [s.assets.find((x) => x.id === a.id)], 1);
    const { data, usage } = await studioAi.checkResult(current().store, { facts: studioFacts(s), task, checklist: studio.CHECKLIST, result, originals }, UserError);
    studio.setAssetAi(a.id, current().id, { ...data, usage }, user, data.summary);
    return studioSessionOut(studio.getSession(s.id, current().id));
  }, 'studio'],
  ['PUT', '/api/studio/tasks/:id', (p, url, body, user) => studio.updateTask(p.id, current().id, body, user), 'studio'],
  ['POST', '/api/studio/assets/:id/review', (p, url, body, user) => studio.review(p.id, current().id, body, user), 'studio'],
  ['POST', '/api/studio/assets/:id/retry', (p, url, body, user) => studio.retry(p.id, current().id, user), 'studio'],
  // В галерею товара: только одобренное фото, только этот товар или его модификация, только в конец галереи.
  // Основное фото и остальные фото товара не меняются. Нужно ещё право «Фото».
  ['POST', '/api/studio/assets/:id/attach', (p, url, body, user) => {
    if (!can(user, 'photos')) throw new UserError('Добавлять фото в галерею товара может сотрудник с правом «Фото»');
    const { session: s } = studio.attachable(p.id, current().id);
    const base = studioProduct(s.branch_id, s.product_id);
    // Расцветка (body.color или цвет съёмки) — фото в галерею «хранителя» этого цвета: его видят все размеры цвета.
    const color = body.color !== undefined ? String(body.color || '') : body.productId ? '' : s.color;
    const targetId = color ? studioColorPick(s.branch_id, base, color).variant.id : Number(body.productId || s.variant_id || s.product_id);
    const target = targetId === base.id ? base : studioVariant(s.branch_id, base, targetId);
    const added = contextOf(s.branch_id).store.appendGalleryImage(target.id, { data: body.data });
    const label = `${base.name}${color ? ` · ${color} (все размеры)` : target !== base ? ` · ${variantLabel(target)}` : ''}: фото №${added.imageId}, ${added.count}-е в галерее`;
    return { ...studio.markAttached(p.id, { branchId: s.branch_id, productId: target.id, imageId: added.imageId }, user, label), gallery: added };
  }, 'studio'],
  ['GET', '/api/products/:id/gallery', (p) => store.listGallery(p.id), 'photos'],
  ['PUT', '/api/products/:id/gallery', (p, url, body) => store.saveGallery(p.id, body), 'photos'],

  // Без права «sales» сотрудник видит только свои чеки.
  ['GET', '/api/sales', (p, url, body, user) => store.listSales({ ...range(url), userId: can(user, 'sales') ? null : user.id }), 'pos'],
  ['POST', '/api/sales', (p, url, body, user) => {
    // Номер чека с кассы: тот же чек (повтор после обрыва связи, очередь без интернета) второй раз не пробивается.
    const clientId = typeof body.clientId === 'string' && /^[\w-]{8,64}$/.test(body.clientId) ? body.clientId : null;
    if (clientId) {
      const dup = store.db.prepare('SELECT id, total, created_at FROM sales WHERE client_id = ?').get(clientId);
      if (dup) return { ...dup, duplicate: true, payments: [], items: [] };
    }
    // Время продажи задаёт только чек из очереди без интернета: не позже «сейчас» и не раньше 7 дней назад.
    let at;
    const off = Number(body.offlineAt);
    if (clientId && off && off <= Date.now() + 60_000 && off > Date.now() - 7 * 864e5) at = Math.min(off, Date.now());
    // Сотрудник продаёт только в открытой смене (владелец и право «Продавать без открытой смены» — без этого).
    // Чек из очереди без интернета проверяется на смену в момент продажи.
    if (auth.enabled && user && user.role !== 'owner' && !can(user, 'pos.noshift') && !(at ? store.shiftAt(user.id, at) : store.currentShift(user.id))) {
      throw new UserError('Сначала откройте смену — без неё продавать нельзя');
    }
    const sale = store.createSale({ ...body, at }, user);
    if (clientId) store.db.prepare('UPDATE sales SET client_id = ?, offline_at = ? WHERE id = ?').run(clientId, at ? Math.round(off) : null, sale.id);
    if (at) sale.offlineAt = at;
    // Сколько наличных дал покупатель — для уведомления (сдача).
    const given = Number(body.cashGiven);
    const cashPart = (sale.payments || []).filter((x) => x.kind === 'cash').reduce((a, x) => a + x.amount, 0);
    if (given > 0 && cashPart > 0 && given >= cashPart && given < cashPart + 100000) { sale.cashGiven = given; sale.cashPart = cashPart; }
    // Сдачу не выдали — записываем в кассу (если запись не удалась, чек всё равно пробит).
    if (Number(body.changeKept) > 0) {
      try { sale.changeKept = store.keepChange(sale.id, body.changeKept, user); } catch (err) { sale.changeError = err.message; }
    }
    // «Сдача от шефа»: записать в кассу и сразу написать шефу, сколько и куда перевести.
    if (body.chefChange && Number(body.chefChange.amount) > 0) {
      try {
        if (auth.enabled && !can(user, 'pos.chefchange')) throw new UserError('Нет права «Сдача от шефа»');
        sale.chefChange = store.chefChange(sale.id, body.chefChange, user);
        const tg = notifier.tgFor('chef_change');
        if (tg) {
          const given = Number(body.chefChange.given) || 0;
          notifier.sendTelegram(`🤝 Сдача от шефа: переведите клиенту ${tgMoney(sale.chefChange)}`
            + `\nЧек №${sale.id} на ${tgMoney(sale.total)}${given ? `, клиент дал ${tgMoney(given)} наличными` : ''}`
            + `${body.chefChange.to ? `\nКуда перевести: ${String(body.chefChange.to).slice(0, 120)}` : ''}`
            + `\nКассир: ${user ? user.name || user.email : '—'}`
            + `\nЭти ${tgMoney(sale.chefChange)} наличными остались в кассе — это ваши деньги, их ждут при пересчёте.`, tg)
            .catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
        }
      } catch (err) { sale.changeError = err.message; }
    }
    notifier.sale(sale, user);
    return sale;
  }, 'pos'],
  ['POST', '/api/sales/:id/refund', (p, url, body, user) => store.refundSale(p.id, user), 'refund'],
  ['POST', '/api/sales/delete', (p, url, body, user) => store.deleteSales(body, user), 'sales.delete'],
  // Документы: право на вид документа проверяется внутри — у каждого вида своё.
  ['GET', '/api/docs', (p, url, body, user) => {
    const kind = url.searchParams.get('kind') || '';
    if (kind) docRight(user, kind);
    const kinds = Object.keys(store.docKinds).filter((k) => can(user, store.docKinds[k].right));
    return store.listDocs({ ...range(url), kind, status: url.searchParams.get('status') || '' }).filter((d) => kinds.includes(d.kind));
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['GET', '/api/docs/:id', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.getDoc(p.id), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs', (p, url, body, user) => {
    docRight(user, body.kind);
    const doc = store.saveDoc(null, body, user);
    return body.post ? store.postDoc(doc.id, user) : doc;
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['PUT', '/api/docs/:id', (p, url, body, user) => {
    docRight(user, store.getDoc(p.id).kind);
    const doc = store.saveDoc(p.id, body, user);
    return body.post ? store.postDoc(doc.id, user) : doc;
  }, ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs/:id/post', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.postDoc(p.id, user), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['POST', '/api/docs/:id/unpost', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.unpostDoc(p.id, user), 'docs.unpost'],
  ['DELETE', '/api/docs/:id', (p, url, body, user) => docRight(user, store.getDoc(p.id).kind) && store.deleteDoc(p.id), ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer']],
  ['GET', '/api/docs-writeoff-summary', (p, url) => store.writeoffSummary(range(url)), 'writeoff'],
  // Курс доллара (сом за 1 $): задаёт владелец в «Настройках»; им же пересчитываются цены из $ в карточке товара
  // и по нему по умолчанию считается приход по фото накладной в долларах.
  ['GET', '/api/settings/currency', () => ({ usdRate: Number(store.setting('usd_rate', '0')) || null, costExtra: store.costExtra() }), ['products', 'settings', 'currency', 'arrivals', 'receive.photo', 'migrate', 'migrate.view']],
  ['PUT', '/api/settings/currency', (p, url, body) => {
    const rate = body.usdRate === '' || body.usdRate === null ? 0 : Number(String(body.usdRate).replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) throw new UserError('Курс доллара: укажите число, например 87,5');
    store.setSetting('usd_rate', rate ? String(Math.round(rate * 10000) / 10000) : '0');
    if (body.costExtra !== undefined) {
      const extra = body.costExtra === '' || body.costExtra === null ? 0 : Number(String(body.costExtra).replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(extra) || extra < 0 || extra > 1e6) throw new UserError('Добавка к себестоимости: укажите число сом, например 500');
      store.setSetting('cost_extra', String(Math.round(extra * 100) / 100));
    }
    return { usdRate: rate || null, costExtra: store.costExtra() };
  }, 'currency'],
  ['GET', '/api/suppliers', () => store.listSuppliers(), ['arrivals', 'transfer', 'stock', 'writeoff', 'products']],
  // Приход по фото накладной: распознать, подобрать товары, провести.
  ['GET', '/api/invoice/status', () => ({ configured: Boolean(invoice.apiKey(mainStore)), fromEnv: Boolean(process.env.ANTHROPIC_API_KEY), model: invoice.MODEL,
    rate: Number(store.setting('usd_rate', '0')) || null }), ['receive.photo', 'settings']],
  ['PUT', '/api/invoice/key', (p, url, body) => {
    const key = String(body.key ?? '').trim();
    if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw new UserError('Ключ Claude API начинается с sk-ant-');
    mainStore.setSetting('anthropic_api_key', key);
    return { configured: Boolean(invoice.apiKey(mainStore)) };
  }, 'settings'],
  ['POST', '/api/invoice/recognize', async (p, url, body) => {
    const r = await invoice.recognize(mainStore, body.images, UserError);
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const matches = store.matchInvoiceLines(lines);
    const supplier = r.supplier ? store.listSuppliers().find((s) => s.name.toLowerCase() === String(r.supplier).toLowerCase().trim()) : null;
    return { ...r, supplier_id: supplier?.id ?? null, lines: lines.map((l, i) => ({ ...l, match: matches[i].product, how: matches[i].how })) };
  }, 'receive.photo'],
  ['POST', '/api/invoice/match', (p, url, body) => store.matchInvoiceLines(Array.isArray(body.lines) ? body.lines : []), 'receive.photo'],
  ['POST', '/api/invoice/receive', (p, url, body, user) => store.receiveInvoice(body, user), 'receive.photo'],
  ['GET', '/api/finance', (p, url) => store.finance(range(url)), 'finance'],
  ['GET', '/api/expenses', (p, url) => ({ list: store.listExpenses(range(url)), categories: store.expenseCategories }), ['expenses', 'finance']],
  ['POST', '/api/expenses', (p, url, body, user) => store.addExpense(body, user), 'expenses'],
  ['DELETE', '/api/expenses/:id', (p) => store.deleteExpense(p.id), 'expenses'],
  ['GET', '/api/recurring-expenses', () => store.listRecurring(), ['expenses', 'finance']],
  ['POST', '/api/recurring-expenses', (p, url, body) => store.saveRecurring(null, body), 'expenses'],
  ['PUT', '/api/recurring-expenses/:id', (p, url, body) => store.saveRecurring(p.id, body), 'expenses'],
  ['DELETE', '/api/recurring-expenses/:id', (p) => store.deleteRecurring(p.id), 'expenses'],
  ['POST', '/api/suppliers', (p, url, body) => store.saveSupplier(null, body), 'arrivals'],
  ['PUT', '/api/suppliers/:id', (p, url, body) => store.saveSupplier(p.id, body), 'arrivals'],
  ['DELETE', '/api/suppliers/:id', (p) => store.deleteSupplier(p.id), 'arrivals'],
  ['GET', '/api/cash-desk', () => store.cashDesk(), ['dashboard', 'shifts']],
  ['GET', '/api/analytics', (p, url, body, user) => {
    const a = store.analytics(range(url));
    return { ...a, products: hideStock(user, a.products) };
  }, 'dashboard'],
  ['GET', '/api/kpi', (p, url) => store.kpi(range(url)), ['kpi', 'salary']],
  ['GET', '/api/reports/abc', (p, url, body, user) => {
    const r = store.abcData({ ...range(url), bucket: url.searchParams.get('bucket') === 'month' ? 'month' : 'week' });
    return can(user, 'stock.view') ? r : { ...r, products: r.products.map((x) => ({ ...x, stock: null })) };
  }, 'abc'],
  ['GET', '/api/reports/products', (p, url) => store.reportProducts(range(url)), 'kpi'],

  // Своя смена — у любого, кто работает на кассе; чужие смены — у права «Смены».
  ['GET', '/api/shift', (p, url, body, user) => {
    const sh = user && store.currentShift(user.id);
    return sh ? store.getShift(sh.id) : null;
  }, 'pos'],
  ['POST', '/api/shift/open', (p, url, body, user) => {
    const sh = cashAlert(store.openShift(user, body.register_id, { cash: body.cash, note: body.note }), 'открытии');
    shiftTelegram(sh, 'open', user);
    // Сотрудник вышел на смену — сделки без ответственного раздаются по очереди (если так настроено в воронке).
    try { crm.autoAssignFree(); } catch (err) { console.error('CRM: раздача сделок не удалась:', err.message); }
    return sh;
  }, 'pos'],
  // Конструктор чеков и этикеток: настройки нужны всем, кто печатает; менять — право «Конструктор чеков и этикеток».
  // Товарный отчёт, неликвиды, автоматика.
  ['GET', '/api/reports/stock', (p, url) => store.stockReport({ ...range(url), category: url.searchParams.get('category') || '', q: url.searchParams.get('q') || '' }), 'reports.stock'],
  ['GET', '/api/reports/profit', (p, url) => store.profitByMonth(range(url)), 'reports.money'],
  ['GET', '/api/reports/cashflow', (p, url) => store.cashFlow({ ...range(url), methodId: url.searchParams.get('account') || null }), 'reports.money'],
  ['GET', '/api/reports/dead', (p, url) => store.deadStock({ days: Number(url.searchParams.get('days')) || 30 }), 'reports.stock'],
  ['POST', '/api/reports/dead/discount', (p, url, body) => store.setDiscountBulk(body.ids, body.discount), 'products'],
  ['GET', '/api/automation', () => ({ settings: store.automation(), preview: store.autoMarkdown({ dryRun: true }), telegram: notifier.telegramSettings().enabled }), 'automation'],
  ['PUT', '/api/automation', (p, url, body) => store.setAutomation(body), 'automation'],
  ['POST', '/api/automation/run', async (p, url, body) => runJob(current(), body.job, { manual: true }), 'automation'],
  ['GET', '/api/auto-reports', () => store.listAutoReports(), ['reports.stock', 'automation']],
  ['GET', '/api/auto-reports/:id', (p) => store.getAutoReport(p.id), ['reports.stock', 'automation']],
  ['GET', '/api/print-designs', () => store.printDesigns(), 'any'],
  ['PUT', '/api/print-designs/:kind', (p, url, body) => store.setPrintDesign(p.kind, body), 'print.design'],
  ['GET', '/api/sales/:id/receipt', (p) => store.receiptData(p.id), ['pos', 'sales']],
  ['GET', '/api/shift/info', (p, url, body, user) => store.shiftInfo(user), 'pos'],
  ['GET', '/api/registers', (p, url) => (url.searchParams.get('overview') === '1' ? store.registersOverview() : store.listRegisters()), 'any'],
  ['POST', '/api/registers', (p, url, body) => store.saveRegister(null, body), 'settings'],
  // Один денежный ящик на все кассы: второй сотрудник на смене деньги не пересчитывает.
  ['GET', '/api/cash-drawer', () => ({ one: store.setting('cash_one_drawer', '1') !== '0', registers: store.listRegisters().length }), ['settings', 'shifts', 'dashboard']],
  ['PUT', '/api/cash-drawer', (p, url, body) => { store.setSetting('cash_one_drawer', body.one ? '1' : '0'); return { one: Boolean(body.one) }; }, 'settings'],
  ['PUT', '/api/registers/:id', (p, url, body) => store.saveRegister(p.id, body), 'settings'],
  ['GET', '/api/accounts', (p, url) => ({ accounts: store.accounts(range(url)), ops: store.accountOps(range(url)) }), 'accounts'],
  ['POST', '/api/accounts/ops', (p, url, body, user) => store.addAccountOp(body, user), 'accounts'],
  ['DELETE', '/api/accounts/ops/:id', (p) => store.deleteAccountOp(p.id), 'accounts'],
  ['PUT', '/api/accounts/:id/opening', (p, url, body) => store.setOpeningBalance(p.id, body.opening), 'accounts'],
  ['POST', '/api/shift/close', (p, url, body, user) => {
    const sh = cashAlert(store.closeShift(user, body), 'закрытии');
    shiftTelegram(sh, 'close', user);
    return sh;
  }, 'pos'],
  // Табло смены на главной: подробный отчёт по текущему (или выбранному) дню.
  ['GET', '/api/shift-session', (p, url) => store.shiftSession(url.searchParams.get('id') || null), ['dashboard', 'shifts']],
  ['POST', '/api/shift-session/telegram', (p, url, body, user) => {
    if (auth.enabled && !isOwner(user)) throw new UserError('Отчёт смены уходит в Telegram сам при закрытии смены; вручную отправляет только владелец');
    const r = store.shiftSession(body.id || null);
    if (!r) throw new UserError('Смен ещё не было');
    const tg = notifier.telegramSettings();
    if (!tg.enabled) throw new UserError('Telegram не подключён: Настройки → Уведомления в Telegram');
    return notifier.sendTelegram(shiftReportText(r).slice(0, 4000), tg).then(() => ({ ok: true }));
  }, ['dashboard', 'shifts']],
  // Расход из кассы (только наличные) — кассир: сумма и причина обязательны.
  ['POST', '/api/kassa/expense', (p, url, body, user) => store.addCashExpense(body, user), 'expenses.cash'],
  ['GET', '/api/shifts', (p, url) => store.listShifts(range(url)), ['shifts', 'kpi']],
  ['POST', '/api/shifts', (p, url, body, user) => store.saveShift(null, body, user), 'shifts'],
  ['PUT', '/api/shifts/:id', (p, url, body, user) => store.saveShift(p.id, body, user), 'shifts'],
  ['DELETE', '/api/shifts/:id', (p) => store.deleteShift(p.id), 'shifts'],
  ['GET', '/api/fines', (p, url) => store.listFines({ ...range(url), kind: url.searchParams.get('kind') || 'fine' }), ['fines', 'kpi', 'salary']],
  ['GET', '/api/bonuses', (p, url) => store.listFines({ ...range(url), kind: 'bonus' }), ['bonuses', 'salary', 'kpi', 'fines']],
  ['POST', '/api/bonuses', (p, url, body, user) => store.addFine(body, user, 'bonus'), ['bonuses', 'salary']],
  ['DELETE', '/api/bonuses/:id', (p) => store.deleteFine(p.id, 'bonus'), ['bonuses', 'salary']],
  ['GET', '/api/timesheet', (p, url) => store.timesheet({ year: url.searchParams.get('year'), month: url.searchParams.get('month') }), ['timesheet', 'timesheet.edit']],
  // Свой табель сотрудника — только просмотр, только своя строка (окно кассы).
  ['GET', '/api/my-timesheet', (p, url, body, user) => {
    if (!user) throw new UserError('Свой табель видят сотрудники, которые вошли под своим email');
    const t = store.timesheet({ year: url.searchParams.get('year'), month: url.searchParams.get('month') });
    const row = t.rows.find((r) => r.user.id === user.id) || null;
    if (row) for (const c of Object.values(row.days)) if (c.mark) c.mark = { status: c.mark.status, amount: c.mark.amount, color: c.mark.color, note: c.mark.note };
    return { year: t.year, month: t.month, daysInMonth: t.daysInMonth, today: t.today, user: { id: user.id, name: user.name || user.email, shift_rate: user.shift_rate, percent: user.percent, salary: user.salary }, row };
  }, 'mytimesheet'],
  ['PUT', '/api/timesheet/marks', (p, url, body, user) => store.setTimesheetMarks(body, user), 'timesheet.edit'],
  ['GET', '/api/tasks', (p, url, body, user) => {
    // Без входа (сотрудников ещё нет) программа открыта как администратору.
    const all = url.searchParams.get('all') === '1' && can(user, 'tasks');
    return { tasks: store.listTasks({ user: user || { id: 0 }, all, status: url.searchParams.get('status') || 'active' }), counts: store.taskCounts(user || { id: 0 }, can(user, 'tasks')) };
  }, 'any'],
  ['POST', '/api/tasks', (p, url, body, user) => store.createTasks(body, user), 'tasks'],
  ['PUT', '/api/tasks/:id/done', (p, url, body, user) => store.markTask(p.id, body, user || { id: 0 }, can(user, 'tasks')), 'any'],
  ['PUT', '/api/tasks/:id/review', (p, url, body, user) => store.reviewTask(p.id, body, user), 'tasks'],
  ['DELETE', '/api/tasks/:id', (p) => store.deleteTask(p.id), 'tasks'],
  ['PUT', '/api/pay-override', (p, url, body, user) => store.setPayOverride(body, user), 'salary'],
  ['PUT', '/api/users/:id/pay', (p, url, body, user) => {
    guardAdmin(user, store.findUser(p.id), {});
    return store.setUserPay(p.id, body);
  }, 'salary'],
  ['POST', '/api/fines', (p, url, body, user) => store.addFine(body, user), 'fines'],
  ['DELETE', '/api/fines/:id', (p) => store.deleteFine(p.id), 'fines'],
  // Короткий список сотрудников для выбора в сменах и штрафах.
  ['GET', '/api/staff-list', () => store.listUsers().map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, disabled: u.disabled })), ['shifts', 'fines', 'kpi', 'staff', 'crm', 'salary', 'tasks', 'timesheet', 'bonuses']],
  // CRM. mine=1 — только мои сделки и задачи.
  ['GET', '/api/crm/leads', (p, url, body, user) => crm.list({ q: url.searchParams.get('q') || '', source: url.searchParams.get('source') || '',
    userId: url.searchParams.get('mine') === '1' && user ? user.id : null }), 'crm'],
  ['GET', '/api/crm/summary', () => crm.summary(), 'crm'],
  // Воронка: этапы и раздача новых сделок по очереди тем, кто на смене.
  ['GET', '/api/crm/funnel', () => crm.funnel(), 'crm'],
  ['PUT', '/api/crm/funnel', (p, url, body, user) => crm.setFunnel(body, user), 'crm.settings'],
  ['POST', '/api/crm/assign-free', (p, url, body, user) => crm.assignFree(user), 'crm.settings'],
  ['GET', '/api/crm/tasks', (p, url, body, user) => crm.tasks({ userId: url.searchParams.get('mine') === '1' && user ? user.id : null }), 'crm'],
  ['POST', '/api/crm/leads', (p, url, body, user) => crm.create(body, user), 'crm'],
  ['GET', '/api/crm/leads/:id', (p) => crm.get(p.id), 'crm'],
  ['PUT', '/api/crm/leads/:id', (p, url, body, user) => crm.update(p.id, body, user), 'crm'],
  ['DELETE', '/api/crm/leads/:id', (p) => crm.remove(p.id), 'crm'],
  ['POST', '/api/crm/leads/:id/events', (p, url, body, user) => crm.addEvent(p.id, body, user), 'crm'],
  ['POST', '/api/crm/leads/:id/read', (p) => crm.markRead(p.id), 'crm'],
  ['POST', '/api/crm/leads/:id/tasks', (p, url, body, user) => crm.addTask(p.id, body, user), 'crm'],
  ['POST', '/api/crm/tasks/:id/toggle', (p, url, body, user) => crm.toggleTask(p.id, user), 'crm'],
  ['POST', '/api/crm/leads/:id/customer', (p, url, body, user) => crm.toCustomer(p.id, user), 'crm'],
  ['POST', '/api/crm/leads/:id/instagram', (p, url, body, user) => crm.replyInstagram(p.id, body.text, user), 'crm'],
  ['GET', '/api/settings/sms', () => smsPublic(smsSettings()), 'settings'],
  ['PUT', '/api/settings/sms', (p, url, body) => smsPublic(setSms(body)), 'settings'],
  ['POST', '/api/settings/sms/test', async (p, url, body) => {
    const s = smsSettings();
    if (!s.provider) throw new UserError('Сначала выберите провайдера и сохраните настройки');
    const to = normalizePhone(body.phone);
    try {
      await sendSms(s, to, (s.template || 'Код подтверждения: {code}. Никому не сообщайте его.').replace('{code}', '123456'));
    } catch (err) {
      throw new UserError(`Не отправлено: ${err.message}`);
    }
    return { ok: true, to };
  }, 'settings'],
  // Ответ ценой по артикулам, которые кассир увидел на фото/скриншоте клиента.
  ['GET', '/api/crm/stories', () => igPrice.stories(), 'crm'],
  ['PUT', '/api/crm/stories/:id', (p, url, body) => igPrice.setStory(p.id, body.text), 'crm'],
  ['POST', '/api/crm/leads/:id/price-preview', (p, url, body) => { crm.get(p.id); return igPrice.priceForLinks(body.articles); }, 'crm'],
  ['POST', '/api/crm/leads/:id/price-reply', async (p, url, body, user) => {
    const lead = crm.get(p.id);
    const r = await igPrice.priceForLinks(body.articles);
    if (!r.products.length) throw new UserError(r.notFound.length ? `Не нашёл в базе: ${r.notFound.join(', ')}` : 'Впишите артикул');
    const via = body.channel === 'whatsapp' || (!lead.ig_user_id && lead.wa_id) ? 'whatsapp' : 'instagram';
    await (via === 'whatsapp' ? crm.replyWhatsapp(p.id, r.text, user) : crm.replyInstagram(p.id, r.text, user));
    if (!Number(lead.amount) && r.amount) crm.update(p.id, { amount: r.amount }, user);
    // Клиент спросил про сторис — запоминаем артикулы для неё: следующим, кто ответит на эту сторис, бот ответит сам.
    if (body.storyId) await igPrice.setStory(String(body.storyId).slice(0, 60), body.articles).catch(() => {});
    return { lead: crm.get(p.id), notFound: r.notFound, sent: r.products.length };
  }, 'crm'],
  ['POST', '/api/crm/leads/:id/whatsapp', (p, url, body, user) => crm.replyWhatsapp(p.id, body.text, user), 'crm'],
  ['GET', '/api/settings/whatsapp', () => whatsappPublic(crm.whatsappSettings()), 'settings'],
  ['PUT', '/api/settings/whatsapp', (p, url, body) => whatsappPublic(crm.setWhatsapp(body)), 'settings'],
  // Секреты Instagram наружу не отдаём: только признак, что они заданы.
  ['GET', '/api/settings/instagram', () => igSettingsOut(crm.instagramSettings()), 'settings'],
  // Автоответ ценой: настройки, проверка ответа по артикулу и журнал отправленных ответов.
  ['PUT', '/api/settings/instagram/auto', (p, url, body) => igAutoPublic(crm.setInstagramAuto(body)), 'settings'],
  ['POST', '/api/settings/instagram/preview', (p, url, body) => {
    const r = igPrice.preview(body.article, body.template);
    if (!r.found) throw new UserError(`Товара с артикулом «${String(body.article || '').trim()}» нет в базе (или он в архиве)`);
    return r;
  }, 'settings'],
  ['GET', '/api/instagram/auto-log', (p, url) => ({ items: igPrice.log({ limit: url.searchParams.get('limit') }), week: igPrice.stats(7) }), 'settings'],
  ['PUT', '/api/settings/instagram', async (p, url, body) => {
    const s = crm.setInstagram(body);
    // Маркер Meta (EAA…): продлить и найти страницу со связанным Instagram.
    if (body.accessToken && /^EAA/.test(String(body.accessToken).trim())) await crm.resolveFacebookToken().catch((e) => console.error('Instagram:', e.message));
    return igSettingsOut(body.accessToken ? crm.instagramSettings() : s);
  }, 'settings'],
  ['POST', '/api/settings/instagram/check', () => crm.checkInstagram(), 'settings'],
  ['POST', '/api/settings/instagram/diagnose', () => crm.diagnoseInstagram(), 'settings'],
  ['POST', '/api/settings/instagram/subscribe', (p, url) => crm.subscribeInstagramMessages(url.host), 'settings'],
  // Отмена действия сотрудника из журнала: dryRun — показать, что изменится и что мешает.
  // С правом «Журнал» — отмена любых действий; с правом «Свои действия» — только своих.
  ['POST', '/api/audit/:id/undo', (p, url, body, user) => store.undoActions(p.id, { scope: body.scope === 'after' ? 'after' : 'one', dryRun: Boolean(body.dryRun), onlyUser: can(user, 'audit') ? null : user }, user, reqMeta), ['audit', 'undo.own']],
  ['GET', '/api/audit', (p, url, body, user) => store.listAudit({ ...range(url), kind: url.searchParams.get('kind') || '', q: url.searchParams.get('q') || '', userId: can(user, 'audit') ? null : user?.id ?? -1 }), ['audit', 'undo.own']],
  ['POST', '/api/demo', () => {
    if (!store.isEmpty()) throw new UserError('Пример можно загрузить только в пустую базу');
    seedDemo(store);
    return { ok: true };
  }, 'settings'],

  // Кассир ищет покупателя по телефону и заводит нового прямо на кассе.
  ['GET', '/api/customers/by-phone', (p, url) => store.findCustomerByPhone(url.searchParams.get('phone')), ['pos', 'docs.sale', 'refund']],
  // Подарочные сертификаты.
  ['GET', '/api/certificates/new-number', () => ({ number: store.newCertificateNumber() }), ['certificates.sell', 'certificates', 'certificates.manage']],
  ['GET', '/api/certificates/lookup', (p, url) => {
    const c = store.getCertificate(url.searchParams.get('number'));
    if (!c) throw new UserError('Сертификат с таким номером не найден');
    return c;
  }, ['certificates.accept', 'certificates.sell', 'certificates']],
  ['POST', '/api/certificates', (p, url, body, user) => store.sellCertificate(body, user), 'certificates.sell'],
  ['GET', '/api/certificates', (p, url) => ({ list: store.listCertificates({ q: url.searchParams.get('q') || '', state: url.searchParams.get('state') || '' }), settings: store.certificateSettings() }), 'certificates'],
  ['GET', '/api/certificates/:id', (p) => store.certificateHistory(p.id), 'certificates'],
  ['PUT', '/api/certificates/:id/block', (p, url, body, user) => store.setCertificateBlocked(p.id, Boolean(body.blocked), user, body.note), 'certificates'],
  ['POST', '/api/certificates/issue', (p, url, body, user) => store.sellCertificate({ ...body, free: Boolean(body.free) }, user), 'certificates.manage'],
  ['PUT', '/api/certificates/:id', (p, url, body, user) => store.updateCertificate(p.id, body, user), 'certificates.manage'],
  ['DELETE', '/api/certificates/:id', (p, url, body, user) => store.deleteCertificate(p.id, user, url.searchParams.get('note') || ''), 'certificates.manage'],
  ['PUT', '/api/certificates-settings', (p, url, body) => store.setCertificateSettings(body), 'certificates'],
  ['GET', '/api/customers/search', (p, url) => store.searchCustomers(url.searchParams.get('q')), ['pos', 'customers.create', 'docs.sale', 'refund', 'customers', 'certificates.manage']],
  ['GET', '/api/customers/new-card', () => ({ card: store.newCustomerCard() }), ['customers.create', 'loyalty']],
  ['POST', '/api/customers', (p, url, body) => store.createCustomer(body), ['customers.create', 'loyalty', 'certificates.manage']],
  ['GET', '/api/customers', (p, url) => store.listCustomers({ q: url.searchParams.get('q') || '' }), 'customers'],
  ['GET', '/api/customers/rating', () => store.customerRating(), 'customers'],
  ['GET', '/api/customers/codes', () => mainShopAuth().pendingCodes(), 'customers.accounts'],
  ['POST', '/api/customers/codes/:id/sent', (p, url, body, user) => mainShopAuth().markCodeSent(p.id, user), 'customers.accounts'],
  ['POST', '/api/customers/:id/password', (p) => mainShopAuth().adminResetPassword(p.id), 'customers.accounts'],
  ['PUT', '/api/customers/:id/login', (p, url, body) => mainShopAuth().setLoginDisabled(p.id, body.disabled), 'customers.accounts'],
  ['GET', '/api/customers/:id/orders', (p) => mainShopAuth().myOrders(store.findCustomer(p.id) || (() => { throw new UserError('Покупатель не найден'); })()), 'customers'],
  ['GET', '/api/customers/:id/bonus', (p) => store.bonusHistory(p.id).map((b) => ({ ...b, store: storeName(b.store_id) })), 'customers'],
  // Действующие сертификаты покупателя — на кассе предлагаются вместе с бонусами.
  ['GET', '/api/customers/:id/certificates', (p) => store.customerCertificates(p.id), ['pos', 'certificates.accept', 'customers']],
  ['PUT', '/api/customers/:id', (p, url, body) => store.updateCustomer(p.id, body), 'loyalty'],
  ['POST', '/api/customers/:id/bonus', (p, url, body, user) => store.adjustBonus(p.id, body, user), 'loyalty'],
  ['PUT', '/api/loyalty', (p, url, body) => store.setLoyalty(body), 'loyalty'],

  // Сотрудники: владелец может смотреть все магазины сразу (all=1) или любой магазин (?branch=N).
  ['GET', '/api/users', (p, url, body, user) => {
    const names = Object.fromEntries(branchList().map((b) => [b.id, b.name]));
    const tag = (list, id) => list.map((u) => ({ ...u, branch: id, branchName: names[id] }));
    // Последний вход (время, IP, устройство) — владельцу и тем, кому он дал галочку.
    const withLogin = (list, st) => {
      if (!seesSecrets(user) && !can(user, 'audit')) return list;
      const last = st.lastLogins();
      return list.map((u) => ({ ...u, lastLogin: last[u.id] || null }));
    };
    if (url.searchParams.get('all') === '1' && (user?.owner || !auth.enabled)) return branchList().flatMap((b) => tag(withLogin(contextOf(b.id).store.listUsers(), contextOf(b.id).store), b.id));
    return inBranch(url, user, () => tag(withLogin(store.listUsers(), store), current().id));
  }, 'staff'],
  // Пароль и PIN сотрудника — владельцу и тем, у кого галочка «Видеть пароли». Просмотр пишется в журнал.
  ['GET', '/api/users/:id/secrets', (p, url, body, user) => inBranch(url, user, () => {
    if (!seesSecrets(user)) throw new UserError('Пароли сотрудников видит владелец и тот, кому он дал это право');
    const u = store.findUser(p.id);
    if (!u) throw new UserError('Сотрудник не найден');
    if (u.role === 'owner' && user?.role !== 'owner') throw new UserError('Пароль владельца не показывается');
    return { id: u.id, name: u.name || u.email, email: u.email, password: decryptSecret(u.secret_pw), pin: decryptSecret(u.secret_pin), hasPin: Boolean(u.pin_hash) };
  }), 'staff'],
  ['POST', '/api/users/:id/branch', (p, url, body, user) => inBranch(url, user, () => setEmployeeBranch(p.id, body, user)), 'staff'],
  ['POST', '/api/users', (p, url, body, user) => inBranch(url, user, () => {
    guardAdmin(user, null, body);
    // Email входа один на все магазины: по нему программа понимает, в какой магазин пустить.
    const email = String(body.email || '').trim().toLowerCase();
    for (const b of branchList()) {
      const other = b.id !== current().id && contextOf(b.id)?.store.findUserByEmail(email);
      if (other && !other.owner_shadow && !other.moved_to) throw new UserError(`Email ${email} уже занят сотрудником магазина «${b.name}»`);
    }
    const pin = body.pin ? pinHash(body.pin) : null;
    const made = store.createUser(body, password(body.password));
    if (made.role !== 'owner') store.setUserSecrets(made.id, { password: String(body.password), pin: body.pin ? String(body.pin).trim() : undefined }, encryptSecret);
    return pin ? store.setUserPin(made.id, pin) : made;
  }), 'staff'],
  // «Права и доступ»: все сотрудники магазина и их действующие права одной таблицей; изменения сразу многим.
  ['GET', '/api/access', (p, url, body, user) => inBranch(url, user, () => accessOut()), 'staff'],
  ['POST', '/api/access', (p, url, body, user) => inBranch(url, user, () => {
    const ids = (Array.isArray(body.userIds) ? body.userIds : []).map(Number);
    if (!ids.length) throw new UserError('Выберите сотрудников');
    const add = Array.isArray(body.add) ? body.add.map(String) : [];
    const remove = new Set(Array.isArray(body.remove) ? body.remove.map(String) : []);
    let changed = 0;
    for (const id of ids) {
      const target = store.findUser(id);
      if (!target || target.role === 'owner') continue;
      const next = body.reset ? null : [...new Set([...rightsOf(target), ...add])].filter((r) => !remove.has(r));
      guardAdmin(user, target, { rights: next });
      store.updateUser(id, { rights: next });
      changed++;
    }
    return { ...accessOut(), changed };
  }), 'staff'],
  ['PUT', '/api/users/:id', (p, url, body, user) => inBranch(url, user, () => {
    guardAdmin(user, store.findUser(p.id), body);
    const pin = body.clearPin ? null : body.pin ? pinHash(body.pin) : undefined;
    const saved = store.updateUser(p.id, body, body.password ? password(body.password) : null);
    // Копия для просмотра: что задал владелец или администратор. Пароль владельца не хранится.
    if (saved.role !== 'owner') {
      store.setUserSecrets(p.id, { password: body.password ? String(body.password) : undefined, pin: body.clearPin ? null : body.pin ? String(body.pin).trim() : undefined }, encryptSecret);
    } else store.setUserSecrets(p.id, { password: null, pin: null }, encryptSecret);
    return pin === undefined ? saved : store.setUserPin(p.id, pin);
  }), 'staff'],
  ['DELETE', '/api/users/:id', (p, url, body, user) => inBranch(url, user, () => {
    if (user && Number(p.id) === user.id) throw new UserError('Нельзя удалить самого себя');
    guardAdmin(user, store.findUser(p.id), {});
    return store.deleteUser(p.id);
  }), 'staff'],

  ['GET', '/api/design', () => store.design(), 'design'],
  ['PUT', '/api/design', (p, url, body) => store.setDesign(body), 'design'],
  ['GET', '/api/fonts', () => mainStore.listFonts(), 'any'],
  ['POST', '/api/fonts', (p, url, body) => mainStore.addFont(body), ['design', 'shop', 'print.design']],
  ['PUT', '/api/fonts/:id', (p, url, body) => mainStore.updateFont(p.id, body), ['design', 'shop']],
  ['DELETE', '/api/fonts/:id', (p) => mainStore.deleteFont(p.id), ['design', 'shop']],
  // Предпросмотр: та же тема, что отдаёт /theme.css, но из несохранённого черновика.
  // Свой CSS сотрудник с этим правом и так может писать, поэтому строки идут как есть.
  ['POST', '/api/design/preview', (p, url, body) => ({ css: themeCss({ ...store.design(), ...Object.fromEntries(Object.entries(body || {}).map(([k, v]) => [k, typeof v === 'number' ? v : String(v ?? '').replace(/[<>{};]/g, k === 'css' ? (c) => c : '')])) }, mainStore.listFonts()) }), 'design'],
  ['PUT', '/api/layout', (p, url, body, user) => {
    if (auth.enabled && user?.role !== 'owner') throw new UserError('Расположение разделов меняет владелец');
    return saveLayout(body);
  }, 'any'],
  ['POST', '/api/images', (p, url, body) => store.addImage(body), ['shop', 'print.design']],
  ['GET', '/api/shop', () => store.shop(), 'shop'],
  ['PUT', '/api/shop', (p, url, body) => store.setShop(body), 'shop'],
  ['GET', '/api/orders', (p, url) => store.listOrders({ status: url.searchParams.get('status') || '' }), 'orders'],
  // Чек об оплате, который прикрепил покупатель, — картинкой или PDF.
  ['GET', '/api/orders/:id/receipts/:rid', (p) => ({ __file: store.getOrderReceipt(p.id, p.rid) }), ['orders', 'orders.payment']],
  ['PUT', '/api/orders/:id', (p, url, body, user) => {
    const before = store.getOrder(p.id);
    const order = store.setOrderStatus(p.id, body, user, { canPay: !auth.enabled || can(user, 'orders.payment') });
    // Оплата подтверждена — сообщаем покупателю: SMS (если подключены), а на витрине он увидит уведомление сам.
    if (!before.paid_at && order.paid_at) {
      const sms = smsSettings();
      if (sms.enabled && sms.provider) {
        const site = store.shop().title || store.design().name || 'Магазин';
        sendSms(sms, order.phone, `${site}: оплата заказа №${order.id} на ${order.total} сом подтверждена. Упаковываем и передадим курьеру.`)
          .then(() => store.audit({ kind: 'change', userName: 'SMS', action: 'Покупателю отправлено SMS об оплате', details: `Заказ №${order.id}, +${order.phone}` }))
          .catch((err) => store.audit({ kind: 'denied', userName: 'SMS', action: 'SMS об оплате не отправлено', details: `Заказ №${order.id}, +${order.phone}: ${err.message}` }));
        return { ...order, notified: 'sms' };
      }
    }
    if (body.status === 'done' && order.sale_id) notifier.sale({ ...store.getSale(order.sale_id), items: order.items, paid: order.total }, user);
    return order;
  }, 'orders'],

  // Токен бота наружу не отдаём целиком: только признак, что он задан.
  ['GET', '/api/settings/telegram', () => {
    const t = notifier.telegramSettings();
    return { enabled: t.enabled, chatId: t.chatId, hasToken: Boolean(t.token) };
  }, 'settings'],
  ['PUT', '/api/settings/telegram', (p, url, body) => {
    const current = notifier.telegramSettings();
    const next = {
      token: body.token ? String(body.token).trim() : current.token,
      chatId: String(body.chatId ?? current.chatId).trim(),
      enabled: Boolean(body.enabled),
    };
    if (next.token && !/^\d+:[\w-]{20,}$/.test(next.token)) throw new UserError('Токен бота не похож на настоящий: он выглядит как 123456789:AAE…');
    if (next.enabled && (!next.token || !next.chatId)) throw new UserError('Чтобы включить уведомления, укажите токен бота и ID чата');
    store.setSetting('telegram', JSON.stringify(next));
    return { enabled: next.enabled, chatId: next.chatId, hasToken: Boolean(next.token) };
  }, 'settings'],
  // Какие уведомления присылать: каждое включается и выключается отдельно.
  ['GET', '/api/settings/telegram/events', () => ({ groups: TG_EVENTS, on: notifier.events() }), 'settings'],
  ['PUT', '/api/settings/telegram/events', (p, url, body) => ({ groups: TG_EVENTS, on: notifier.setEvents(body.on || {}) }), 'settings'],
  ['POST', '/api/settings/telegram/test', async () => {
    try {
      await notifier.sendTelegram('✅ Уведомления о продажах подключены');
    } catch (err) {
      throw new UserError(err.message);
    }
    return { ok: true };
  }, 'settings'],
];

function match(method, pathname) {
  for (const [m, pattern, handler, access] of routes) {
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const found = pathname.match(re);
    if (found) return { handler, access, pattern, params: Object.fromEntries(names.map((n, i) => [n, found[i + 1]])) };
  }
  return null;
}

const clientErrors = { at: 0, n: 0 };
// transform(html) — правка страницы перед отдачей (например, версия значка вкладки).
function serveStatic(res, pathname, transform = null) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': stat.mtime.toUTCString() };
  // Страницы: к своим скриптам и стилям дописываем ?v=<время изменения файла>, чтобы браузер
  // (особенно на iPhone) не взял старую копию shop.js/colors.js после обновления программы.
  if (path.extname(file) === '.html') {
    headers['Cache-Control'] = 'no-store';
    delete headers.ETag; delete headers['Last-Modified'];
    const html = fs.readFileSync(file, 'utf8').replace(/(<script[^>]*\ssrc|<link[^>]*\shref)="(\/?[\w.\/-]+\.(?:js|css))"/g, (all, attr, url) => {
      const asset = path.join(PUBLIC, url);
      if (!asset.startsWith(PUBLIC + path.sep) || !fs.existsSync(asset)) return all;
      return `${attr}="${url}?v=${Math.floor(fs.statSync(asset).mtimeMs).toString(36)}"`;
    });
    res.writeHead(200, headers);
    return res.end(transform ? transform(html) : html);
  }
  if (res.req?.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

// Устройство из заголовка браузера: «Android · Chrome», «Windows · Edge».
function device(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 60) || 'неизвестно';
}

// Что записать в журнал о каждом изменении. Ключ — «метод путь» маршрута.
const AUDIT_LABELS = {
  'POST /api/users/:id/branch': 'Изменил магазин сотрудника',
  'PUT /api/me/password': 'Сменил свой пароль',
  'PUT /api/me/pin': 'Сменил свой PIN-код для кассы',
  'POST /api/products': 'Добавил товар',
  'PUT /api/products/:id': 'Изменил товар',
  'DELETE /api/products/:id': 'Удалил товар',
  'POST /api/products/import': 'Загрузил товары из Excel',
  'POST /api/migrate/upload': 'Перенос из CloudShop: загрузил выгрузку',
  'POST /api/migrate/import': 'Перенос из CloudShop: перенёс товары',
  'POST /api/migrate/merge': 'Перенос из CloudShop: объединил строки в товар',
  'POST /api/migrate/:id/split': 'Перенос из CloudShop: разделил товар на строки',
  'DELETE /api/migrate': 'Перенос из CloudShop: начал заново (черновик удалён)',
  'PUT /api/products/:id/stock': 'Пересчитал остаток',
  'PUT /api/products/:id/photo': 'Поменял фото товара',
  'DELETE /api/products/:id/photo': 'Удалил фото товара',
  'PUT /api/products/:id/gallery': 'Изменил галерею фото товара',
  'POST /api/studio/sessions': 'AI Studio: новая съёмка',
  'POST /api/studio/sessions/:id/tasks': 'AI Studio: задание для ChatGPT',
  'POST /api/studio/assets/:id/review': 'AI Studio: согласование фото',
  'POST /api/studio/assets/:id/retry': 'AI Studio: повторная генерация',
  'POST /api/studio/assets/:id/attach': 'AI Studio: фото добавлено в галерею товара',
  'DELETE /api/studio/assets/:id': 'AI Studio: удалён файл съёмки',
  'DELETE /api/studio/sessions/:id': 'AI Studio: съёмка удалена навсегда',
  'POST /api/products/bulk': 'Групповое изменение товаров',
  'POST /api/products/:id/variants': 'Добавил модификации',
  'POST /api/expenses': 'Внёс расход',
  'DELETE /api/expenses/:id': 'Удалил расход',
  'PUT /api/timesheet/marks': 'Изменил табель',
  'POST /api/certificates': 'Продал подарочный сертификат',
  'PUT /api/certificates/:id/block': 'Изменил сертификат',
  'PUT /api/certificates-settings': 'Изменил срок сертификатов',
  'POST /api/certificates/issue': 'Выдал сертификат',
  'PUT /api/certificates/:id': 'Изменил сумму или срок сертификата',
  'DELETE /api/certificates/:id': 'Удалил сертификат',
  'POST /api/invoice/receive': 'Оприходовал накладную по фото',
  'PUT /api/invoice/key': 'Изменил ключ распознавания накладных',
  'POST /api/recurring-expenses': 'Добавил постоянный расход',
  'PUT /api/recurring-expenses/:id': 'Изменил постоянный расход',
  'DELETE /api/recurring-expenses/:id': 'Удалил постоянный расход',
  'POST /api/categories': 'Создал категорию',
  'POST /api/payment-methods': 'Добавил способ оплаты',
  'PUT /api/payment-methods/:id': 'Изменил способ оплаты',
  'PUT /api/payment-methods-order': 'Изменил порядок способов оплаты',
  'PUT /api/categories/:id': 'Переименовал категорию',
  'DELETE /api/categories/:id': 'Удалил категорию',
  'PUT /api/categories/:id/image': 'Поменял картинку категории',
  'PUT /api/categories-order': 'Изменил порядок категорий',
  'POST /api/sales': 'Пробил чек',
  'POST /api/sales/:id/refund': 'Оформил возврат',
  'POST /api/sales/delete': 'Удалил продажи',
  'POST /api/docs': 'Создал документ',
  'PUT /api/docs/:id': 'Изменил документ',
  'POST /api/docs/:id/post': 'Провёл документ',
  'POST /api/docs/:id/unpost': 'Отменил проведение документа',
  'DELETE /api/docs/:id': 'Удалил документ',
  'POST /api/suppliers': 'Добавил поставщика',
  'POST /api/registers': 'Добавил кассу',
  'PUT /api/registers/:id': 'Изменил кассу',
  'POST /api/accounts/ops': 'Операция по счёту',
  'DELETE /api/accounts/ops/:id': 'Удалил операцию по счёту',
  'PUT /api/accounts/:id/opening': 'Изменил начальный остаток счёта',
  'PUT /api/suppliers/:id': 'Изменил поставщика',
  'DELETE /api/suppliers/:id': 'Удалил поставщика',
  'POST /api/demo': 'Загрузил пример магазина',
  'POST /api/shift/open': 'Открыл смену',
  'PUT /api/print-designs/:kind': 'Изменил шаблон чека или этикетки',
  'POST /api/reports/dead/discount': 'Уценил неликвиды',
  'PUT /api/automation': 'Изменил настройки автоматики',
  'POST /api/automation/run': 'Запустил автоматику вручную',
  'POST /api/shift/close': 'Закрыл смену',
  'POST /api/shifts': 'Добавил смену вручную',
  'PUT /api/shifts/:id': 'Исправил смену',
  'DELETE /api/shifts/:id': 'Удалил смену',
  'POST /api/fines': 'Выписал штраф',
  'POST /api/bonuses': 'Начислил бонус сотруднику',
  'DELETE /api/bonuses/:id': 'Отменил бонус сотруднику',
  'PUT /api/users/:id/pay': 'Изменил зарплату сотрудника',
  'PUT /api/pay-override': 'Исправил сумму в ведомости',
  'POST /api/tasks': 'Дал задание',
  'PUT /api/tasks/:id/done': 'Отметил задание',
  'PUT /api/tasks/:id/review': 'Проверил задание',
  'DELETE /api/tasks/:id': 'Удалил задание',
  'DELETE /api/fines/:id': 'Отменил штраф',
  'POST /api/customers': 'Добавил покупателя',
  'PUT /api/customers/:id': 'Изменил покупателя',
  'POST /api/customers/:id/bonus': 'Изменил бонусы покупателя',
  'PUT /api/loyalty': 'Изменил правила бонусов и скидок',
  'POST /api/users': 'Добавил сотрудника',
  'GET /api/users/:id/secrets': 'Посмотрел пароль и PIN сотрудника',
  'PUT /api/users/:id': 'Изменил сотрудника',
  'DELETE /api/users/:id': 'Удалил сотрудника',
  'PUT /api/design': 'Изменил оформление',
  'POST /api/fonts': 'Загрузил шрифт',
  'PUT /api/fonts/:id': 'Изменил шрифт',
  'DELETE /api/fonts/:id': 'Удалил шрифт',
  'PUT /api/layout': 'Изменил расположение разделов',
  'POST /api/images': 'Загрузил картинку для витрины',
  'PUT /api/shop': 'Изменил витрину',
  'PUT /api/orders/:id': 'Изменил статус заказа',
  'PUT /api/settings/telegram': 'Изменил уведомления в Telegram',
  'PUT /api/settings/instagram': 'Изменил подключение Instagram',
  'PUT /api/settings/instagram/auto': 'Изменил автоответ ценой в Instagram',
  'POST /api/crm/leads': 'Создал сделку в CRM',
  'PUT /api/crm/leads/:id': 'Изменил сделку в CRM',
  'POST /api/crm/leads/:id/price-reply': 'Отправил клиенту цену по артикулу',
  'PUT /api/crm/stories/:id': 'Привязал артикулы к сторис',
  'POST /api/settings/instagram/subscribe': 'Подписал Instagram на сообщения Direct',
  'PUT /api/crm/funnel': 'Изменил воронку CRM',
  'POST /api/kassa/expense': 'Расход из кассы',
  'POST /api/access': 'Изменил права сотрудников (Права и доступ)',
  'POST /api/payment-methods': 'Создал счёт / способ оплаты',
  'PUT /api/cash-drawer': 'Изменил настройку «Один денежный ящик на все кассы»',
  'POST /api/crm/assign-free': 'Раздал свободные сделки CRM',
  'DELETE /api/crm/leads/:id': 'Удалил сделку в CRM',
  'POST /api/crm/leads/:id/instagram': 'Ответил клиенту в Instagram',
  'POST /api/crm/leads/:id/whatsapp': 'Ответил клиенту в WhatsApp',
  'PUT /api/settings/whatsapp': 'Изменил подключение WhatsApp',
  'PUT /api/settings/sms': 'Изменил подключение SMS',
  'POST /api/settings/sms/test': 'Отправил пробное SMS',
  'POST /api/customers/codes/:id/sent': 'Передал покупателю код подтверждения',
  'POST /api/customers/:id/password': 'Выдал покупателю временный пароль',
  'PUT /api/customers/:id/login': 'Изменил доступ покупателя к витрине',
  'PUT /api/settings/telegram/events': 'Изменил, какие уведомления приходят в Telegram',
  'POST /api/settings/telegram/test': 'Отправил пробное уведомление',
};
// Действия, которые можно отменить из журнала (меняют только товары, категории, поставщиков, документы склада и расходы).
// Продажи, возвраты, сертификаты, деньги на счетах, сотрудники и настройки не отменяются.
const UNDO_KEYS = new Set([
  'POST /api/products', 'PUT /api/products/:id', 'DELETE /api/products/:id', 'POST /api/products/import', 'POST /api/migrate/import', 'POST /api/migrate/merge', 'POST /api/migrate/:id/split', 'DELETE /api/migrate', 'PUT /api/products/:id/stock',
  'POST /api/products/bulk', 'POST /api/products/:id/variants', 'POST /api/expenses', 'DELETE /api/expenses/:id', 'POST /api/invoice/receive',
  'POST /api/recurring-expenses', 'PUT /api/recurring-expenses/:id', 'DELETE /api/recurring-expenses/:id',
  'POST /api/categories', 'PUT /api/categories/:id', 'DELETE /api/categories/:id', 'PUT /api/categories-order',
  'POST /api/docs', 'PUT /api/docs/:id', 'POST /api/docs/:id/post', 'POST /api/docs/:id/unpost', 'DELETE /api/docs/:id',
  'POST /api/suppliers', 'PUT /api/suppliers/:id', 'DELETE /api/suppliers/:id', 'POST /api/reports/dead/discount',
]);
// IP и устройство текущего запроса — для записей, которые делает сам обработчик (отмена действий).
let reqMeta = {};
const ORDER_NAMES = { unpaid: '— оплата не найдена', checking: '— на проверке оплаты', confirmed: 'подтверждён (оплата подтверждена)', ready: 'собран', shipped: 'передан курьеру', done: 'выдан', cancelled: 'отменён' };

// Подробности для журнала: о чём именно речь. Пароли и токены сюда не попадают.
const docTitle = (d) => `${store.docKinds[d.kind]?.name || d.kind} №${d.number}${d.direction === 'in' ? ' (входящее)' : ''} — ${d.status === 'posted' ? 'проведён' : 'не проведён'}, ${d.items?.length ?? ''} поз., ${d.kind === 'inventory' ? `недостача ${d.shortage_cost}, излишек ${d.surplus_cost}` : `${d.total} сом`}`;

function auditDetails(key, params, body, result) {
  const r = result && typeof result === 'object' ? result : {};
  switch (key) {
    case 'PUT /api/settings/instagram/auto': return r.autoPrice ? 'включён' : 'выключен';
    case 'PUT /api/payment-methods/:id': return `${r.name}${r.active ? '' : ' (выключен)'}`;
    case 'POST /api/sales': return `Чек №${r.id} на ${r.total} сом, ${r.payments?.length > 1 ? r.payments.map((x) => `${x.name} ${x.amount}`).join(' + ') : r.method}${r.discount ? `, скидка ${r.discount} сом (${r.discountReason})` : ''}`;
    case 'POST /api/sales/:id/refund': return `Чек №${params.id}`;
    case 'POST /api/customers/:id/password': return `+${r.phone}`;
    case 'PUT /api/customers/:id/login': return `${r.name || '+' + r.phone}: вход ${r.login_disabled ? 'закрыт' : 'открыт'}`;
    case 'POST /api/sales/delete': {
      const scope = Array.isArray(body.ids) ? `чеки ${body.ids.slice(0, 20).map((id) => '№' + id).join(', ')}${body.ids.length > 20 ? '…' : ''}`
        : body.all ? 'все продажи за всё время' : `все за ${new Date(Number(body.from)).toLocaleDateString('ru-RU')} — ${new Date(Number(body.to) - 1).toLocaleDateString('ru-RU')}`;
      const n = r.count % 100, k = n % 10;
      const word = n > 10 && n < 20 ? 'чеков' : k === 1 ? 'чек' : k > 1 && k < 5 ? 'чека' : 'чеков';
      return `${r.count} ${word} на ${r.total} сом (${scope}), товар ${body.restock === false ? 'на склад не возвращён' : 'возвращён на склад'}`;
    }
    case 'POST /api/products/bulk': return `${{ delete: 'удаление', archive: 'убрать из продажи', restore: 'вернуть в продажу', price: 'цена', cost: 'себестоимость', category: 'категория', unit: 'единица', barcodes: 'штрихкоды' }[body.action] || body.action}${body.value !== undefined ? ` (${body.mode ? body.mode + ' ' : ''}${body.value})` : ''}, товаров: ${r.count ?? body.ids?.length}`;
    case 'POST /api/migrate/upload': return `строк ${r.rows}, карточек ${r.items}, собрано в товары с модификациями: ${r.grouped}`;
    case 'POST /api/migrate/import': return `перенесено ${r.done} (товаров ${r.products}, модификаций ${r.variants})${r.failed?.length ? `, не перенесено ${r.failed.length}` : ''}`;
    case 'POST /api/products/import': return `создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped?.length ?? 0}`;
    case 'PUT /api/products/:id/stock': return `${r.name}: остаток ${r.stock}`;
    case 'PUT /api/products/:id': return `${r.name}: цена ${r.price}, себестоимость ${r.cost}`;
    case 'DELETE /api/categories/:id': return `товаров перенесено: ${r.moved}${r.to ? ` в «${r.to}»` : ', остались без категории'}`;
    case 'POST /api/products/:id/variants': return `${Array.isArray(r) ? r.length : 0} шт.`;
    case 'POST /api/expenses':
    case 'DELETE /api/expenses/:id': return `${r.category}: ${r.amount} сом${r.note ? ` (${r.note})` : ''}`;
    case 'POST /api/invoice/receive': return `закупка №${r.doc?.number}, строк ${r.lines}, новых товаров ${r.created}, на ${r.total} сом${r.extras ? `, доп. расходы ${r.extras}` : ''}${r.posted ? '' : ', не проведена'}`;
    case 'PUT /api/invoice/key': return r.configured ? 'ключ задан' : 'ключ убран';
    case 'POST /api/certificates': return `№${r.number} на ${r.amount} сом, покупатель ${r.customer_name || r.customer_phone || ''}`;
    case 'PUT /api/certificates/:id/block': return `№${r.number}: ${r.status === 'blocked' ? 'заблокирован' : 'разблокирован'}${body.note ? ` — ${body.note}` : ''}`;
    case 'PUT /api/certificates-settings': return `срок ${r.months} мес.`;
    case 'POST /api/certificates/issue': return `№${r.number} на ${r.amount} сом, ${r.free ? 'бесплатно' : 'за деньги'}, покупатель ${r.customer_name || r.customer_phone || ''}`;
    case 'PUT /api/certificates/:id': return `№${r.number}: остаток ${r.balance} сом, ${r.expires_at ? `до ${new Date(r.expires_at).toLocaleDateString('ru-RU')}` : 'без срока'}${body.note ? ` — ${body.note}` : ''}`;
    case 'DELETE /api/certificates/:id': return `№${r.number} (остаток был ${r.balance} сом, покупатель ${r.customer_name || r.customer_phone || ''})`;
    case 'PUT /api/timesheet/marks': return `дней: ${r.count}${r.clear ? ', правки сняты' : ''}${r.status !== undefined ? `, ${{ work: 'рабочий', off: 'выходной' }[r.status] || 'по сменам'}` : ''}${r.amount !== undefined ? `, сумма ${r.amount ?? 'по расчёту'}` : ''}${r.color !== undefined ? `, цвет ${r.color || 'без цвета'}` : ''}`;
    case 'POST /api/recurring-expenses':
    case 'PUT /api/recurring-expenses/:id':
    case 'DELETE /api/recurring-expenses/:id': return `${r.name}: ${r.amount} сом в месяц${r.active === 0 ? ' (выключен)' : ''}`;
    case 'POST /api/docs':
    case 'PUT /api/docs/:id':
    case 'POST /api/docs/:id/post':
    case 'POST /api/docs/:id/unpost':
    case 'DELETE /api/docs/:id': return docTitle(r);
    case 'POST /api/registers':
    case 'PUT /api/registers/:id': return `${r.name}${r.active === 0 ? ' (выключена)' : ''}`;
    case 'POST /api/accounts/ops': return `${({ deposit: 'Внесение', withdraw: 'Изъятие', transfer: 'Перевод' })[r.kind]}: ${r.account}${r.to ? ` → ${r.to}` : ''}, ${r.amount} сом${body.note ? ` — ${body.note}` : ''}`;
    case 'DELETE /api/accounts/ops/:id': return `${r.amount} сом — ${r.note}`;
    case 'PUT /api/accounts/:id/opening': return `${r.name}: ${r.opening} сом`;
    case 'POST /api/suppliers':
    case 'PUT /api/suppliers/:id':
    case 'DELETE /api/suppliers/:id': return r.name;
    case 'POST /api/fines': return `${store.findUser(body.user_id)?.name || ''}: ${r.amount} сом — ${r.reason}`;
    case 'DELETE /api/fines/:id': return `${r.amount} сом — ${r.reason}`;
    case 'POST /api/bonuses': return `${store.findUser(body.user_id)?.name || ''}: +${r.amount} сом — ${r.reason}`;
    case 'DELETE /api/bonuses/:id': return `${r.amount} сом — ${r.reason}`;
    case 'POST /api/tasks': return `«${r[0]?.title}» — ${r.map((t) => t.assignee).join(', ')}`;
    case 'PUT /api/tasks/:id/done': return `«${r.title}» — ${r.status === 'done' ? 'выполнено' : 'отметка снята'}${r.done_comment ? `: ${r.done_comment}` : ''}`;
    case 'PUT /api/tasks/:id/review': return `«${r.title}» (${r.assignee_name}) — ${r.status === 'approved' ? 'принято' : 'возвращено на доработку'}${r.check_comment ? `: ${r.check_comment}` : ''}`;
    case 'DELETE /api/tasks/:id': return `«${r.title}» (${r.assignee_name})`;
    case 'PUT /api/pay-override': return `${r.user}, ${({ rate: 'ставка за выход', salary: 'за смены и оклад', bonus: '% от продаж', pay: 'к выплате' })[r.field]}: ${r.amount === null ? 'возвращён расчёт' : `${r.amount} сом${r.reason ? ` — ${r.reason}` : ''}`}, период ${new Date(body.from).toLocaleDateString('ru-RU')}—${new Date(body.to - 1).toLocaleDateString('ru-RU')}`;
    case 'POST /api/users/:id/branch': return `${r.name || r.email}: ${branchList().find((b) => b.id === Number(body.home))?.name || ''}${(body.stores || []).length ? `, также ${(body.stores || []).map((id) => branchList().find((b) => b.id === Number(id))?.name).filter(Boolean).join(', ')}` : ''}`;
    case 'PUT /api/users/:id/pay': return `${r.name || r.email}: за смену ${r.shift_rate}, оклад ${r.salary}, ${r.percent}%, план ${r.plan}, бонус за план ${r.plan_bonus}`;
    case 'POST /api/customers/:id/bonus': return `${r.name || '+' + r.phone}: ${body.delta > 0 ? '+' : ''}${body.delta}${body.reason ? ` (${body.reason})` : ''}`;
    case 'PUT /api/orders/:id': return `Заказ №${params.id} ${ORDER_NAMES[body.status] || body.status}`;
    case 'GET /api/users/:id/secrets': return `${r.name}${r.email ? ` (${r.email})` : ''}`;
    case 'PUT /api/users/:id': return `${r.name || r.email}${body.password ? ', новый пароль' : ''}${body.pin ? ', новый PIN' : body.clearPin ? ', PIN убран' : ''}${body.rights !== undefined ? ', права' : ''}`;
    case 'POST /api/shift/open': return r.open_cash === null || r.open_cash === undefined ? 'касса уже открыта другим сотрудником' : `в кассе ${r.open_cash} сом${r.open_diff ? `, ${r.open_diff < 0 ? 'недостача' : 'излишек'} ${Math.abs(r.open_diff)} сом: ${r.open_note}` : ''}`;
    case 'POST /api/shift/close': return `чеков ${r.receipts} на ${r.revenue} сом${r.close_counted !== null && r.close_counted !== undefined ? `; насчитано ${r.close_counted}, сдано ${r.deposited || 0}, оставлено ${r.left_cash} сом${r.close_diff ? `, ${r.close_diff < 0 ? 'недостача' : 'излишек'} ${Math.abs(r.close_diff)} сом: ${r.close_note}` : ''}` : ''}`;
    case 'PUT /api/shifts/:id':
    case 'POST /api/shifts': return `${r.user_name}: ${new Date(r.opened_at).toLocaleString('ru-RU')}${r.closed_at ? ' — ' + new Date(r.closed_at).toLocaleString('ru-RU') : ''}`;
    default: return r.name || r.email || r.title || (params.id ? `№${params.id}` : '');
  }
}

/* ---------- Вход владельца с кодом из Telegram (двойная проверка) ---------- */
// Настройка в основной базе: { enabled, chatId, who } — код приходит в личный чат владельца с ботом уведомлений.
const twoFa = () => { try { return JSON.parse(mainStore.setting('owner_2fa', '{}')) || {}; } catch { return {}; } };
const setTwoFa = (v) => mainStore.setSetting('owner_2fa', JSON.stringify(v));
const needs2fa = (user) => Boolean(user && user.role === 'owner' && twoFa().enabled && twoFa().chatId);
const tgBot = () => contextOf(1).notifier.telegramSettings();
async function tgSendTo(chatId, text) {
  const tg = tgBot();
  if (!tg.token) throw new UserError('В «Настройки → Telegram» не указан токен бота');
  await contextOf(1).notifier.sendTelegram(text, { ...tg, chatId });
}
const codeHash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const pending2fa = new Map(); // token -> { result, hash, exp, tries, password }
setInterval(() => { const now = Date.now(); for (const [k, v] of pending2fa) if (v.exp < now) pending2fa.delete(k); }, 60_000).unref();
const TWOFA_OFF_HINT = 'Если бот не работает, отключите проверку на сервере: cd /opt/shop/app && sudo -u shop DB_FILE=/var/lib/shop/shop.db node server.js --2fa-off';

async function handleAuth(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req, 16_384);
    const result = auth.login(req, body.email || '', body.password || '');
    const who = { ip: clientIp(req), device: device(req) };
    if (!result.ok) {
      // Когда адрес уже заблокирован за подбор, каждую попытку в журнал не пишем — журнал не забивается.
      if (result.status !== 429) store.audit({ ...who, kind: 'login_failed', userName: String(body.email || '').slice(0, 120), action: 'Неудачная попытка входа', details: result.error });
      return sendJson(res, result.status, { error: result.error });
    }
    // Владелец с двойной проверкой на новом устройстве: сначала код из Telegram, сессия — только после кода.
    if (needs2fa(result.user) && !auth.trusted(req, result.user)) {
      const code = newCode();
      const token = crypto.randomBytes(18).toString('base64url');
      try {
        await tgSendTo(twoFa().chatId, `🔐 Код для входа в программу: ${code}\nДействует 5 минут. Никому его не сообщайте.\nЕсли это не вы — смените пароль владельца.`);
      } catch (err) {
        return sendJson(res, 503, { error: `Не получилось отправить код в Telegram: ${err.message}. ${TWOFA_OFF_HINT}` });
      }
      pending2fa.set(token, { result, hash: codeHash(code), exp: Date.now() + 5 * 60_000, tries: 0, password: body.password });
      store.audit({ ...who, kind: 'change', user: result.user, action: 'Пароль верный — код входа отправлен в Telegram' });
      return sendJson(res, 200, { ok: false, need2fa: true, token });
    }
    // Вход пишется в журнал магазина сотрудника: там и ищется его «последний вход».
    (contextOf(result.user.branch || 1)?.store || store).audit({ ...who, kind: 'login', user: result.user, action: 'Вход в программу' });
    keepSecret(result.user, 'password', body.password);
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, { ok: true, user: store.publicUser(result.user) });
  }
  // Второй шаг входа владельца: код из Telegram.
  if (url.pathname === '/api/login/2fa' && req.method === 'POST') {
    const body = await readBody(req, 16_384);
    const p = pending2fa.get(String(body.token || ''));
    const who = { ip: clientIp(req), device: device(req) };
    if (!p || p.exp < Date.now()) return sendJson(res, 400, { error: 'Код устарел. Введите пароль ещё раз — придёт новый код.', restart: true });
    if (auth.isBlocked(req, 'owner-2fa')) return sendJson(res, 429, { error: 'Слишком много неверных попыток. Подождите 15 минут.' });
    if (codeHash(String(body.code || '').replace(/\D/g, '')) !== p.hash) {
      auth.countFailure(req, 'owner-2fa');
      if (++p.tries >= 5) pending2fa.delete(String(body.token));
      store.audit({ ...who, kind: 'login_failed', userName: p.result.user.name || p.result.user.email, action: 'Неверный код входа из Telegram' });
      return sendJson(res, 401, { error: p.tries >= 5 ? 'Код введён неверно 5 раз. Введите пароль ещё раз.' : 'Неверный код', restart: p.tries >= 5 });
    }
    pending2fa.delete(String(body.token));
    const u = p.result.user;
    (contextOf(u.branch || 1)?.store || store).audit({ ...who, kind: 'login', user: u, action: 'Вход в программу (код из Telegram)', details: body.remember ? 'устройство запомнено на 30 дней' : '' });
    keepSecret(u, 'password', p.password);
    res.setHeader('Set-Cookie', body.remember ? [p.result.cookie, auth.trustCookie(req, u)] : p.result.cookie);
    tgSendTo(twoFa().chatId, `✅ Вход владельца в программу\n${who.device || 'устройство'} · IP ${who.ip}${body.remember ? '\nУстройство запомнено на 30 дней' : ''}`).catch(() => {});
    return sendJson(res, 200, { ok: true, user: store.publicUser(u) });
  }
  // Смена кассира: только с кассы, где уже работает сотрудник с правом «Касса».
  if (url.pathname === '/api/switch-user' && req.method === 'POST') {
    const onTill = auth.currentUser(req);
    if (!onTill || !can(onTill, 'pos')) return sendJson(res, 403, { error: 'Смена кассира доступна только на открытой кассе' });
    const body = await readBody(req, 16_384);
    const target = store.findUser(body.userId);
    if (!target || !can(target, 'pos')) return sendJson(res, 400, { error: 'Этот сотрудник не работает на кассе' });
    if (needs2fa(target)) return sendJson(res, 403, { error: 'Владелец входит через обычный вход: пароль и код из Telegram' });
    // Кассир выбирается в магазине, где сейчас открыта касса.
    const result = auth.switchUser(req, staffDirectory.keyOf({ ...target, branch: current().id }), String(body.code || ''));
    const who = { ip: clientIp(req), device: device(req) };
    if (!result.ok) {
      store.audit({ ...who, kind: 'login_failed', userName: target.name || target.email, action: 'Неудачная смена кассира', details: `${result.error} (на кассе был ${onTill.name || onTill.email})` });
      return sendJson(res, result.status, { error: result.error });
    }
    store.audit({ ...who, kind: 'login', user: result.user, action: 'Смена кассира', details: `после ${onTill.name || onTill.email}` });
    keepSecret(result.user, result.user.pin_hash ? 'pin' : 'password', String(body.code || ''));
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, { ok: true, user: store.publicUser(result.user) });
  }
  // Владелец переключается между магазинами: выбор хранится в cookie shop_branch.
  if (url.pathname === '/api/branch/switch' && req.method === 'POST') {
    const me = auth.currentUser(req);
    if (!me) return sendJson(res, 401, { error: 'Нужно войти' });
    const body = await readBody(req, 16_384);
    const ctx = contextOf(body.id);
    if (!ctx) return sendJson(res, 400, { error: 'Магазин не найден' });
    if (!allowedBranches(me).includes(ctx.id)) return sendJson(res, 403, { error: 'У вас нет доступа к этому магазину. Его открывает владелец в карточке сотрудника.' });
    res.setHeader('Set-Cookie', `shop_branch=${ctx.id}; Path=/; SameSite=Lax; Max-Age=${365 * 86400}`);
    mainStore.audit({ kind: 'change', user: me, ip: clientIp(req), device: device(req), action: 'Перешёл в магазин', details: branchList().find((b) => b.id === ctx.id)?.name || '' });
    return sendJson(res, 200, { ok: true, id: ctx.id });
  }
  // Владелец открывает программу от имени сотрудника — видит ровно то, что видит сотрудник.
  if (url.pathname === '/api/act-as' && req.method === 'POST') {
    const me = auth.ownerOf(req) || auth.currentUser(req);
    if (!me || !isOwner(me)) return sendJson(res, 403, { error: 'Входить от имени сотрудника может только владелец' });
    const body = await readBody(req, 16_384);
    const b = Number(body.branch) || 1;
    const ctx = contextOf(b);
    const target = ctx?.store.findUser(body.id);
    if (!target || target.disabled || target.owner_shadow || target.moved_to) return sendJson(res, 400, { error: 'Сотрудник не найден или закрыт' });
    if (target.role === 'owner') return sendJson(res, 400, { error: 'Это владелец' });
    res.setHeader('Set-Cookie', [...auth.actAsCookies(req, { ...target, branch: ctx.id }), `shop_branch=${ctx.id}; Path=/; SameSite=Lax; Max-Age=${365 * 86400}`]);
    mainStore.audit({ kind: 'change', user: me, ip: clientIp(req), device: device(req), action: 'Вошёл от имени сотрудника', details: `${target.name || target.email}${ctx.id !== 1 ? `, ${branchList().find((x) => x.id === ctx.id)?.name || ''}` : ''}` });
    return sendJson(res, 200, { ok: true, kassa: !can(target, 'dashboard') && can(target, 'pos') });
  }
  // «Подключить Instagram»: переход в окно Instagram и возврат с кодом (маркер сохраняется сам). Только с правом «Настройки».
  if ((url.pathname === '/api/instagram/connect' || url.pathname === '/api/instagram/callback') && req.method === 'GET') {
    const me = auth.currentUser(req);
    const back = (msg, ok) => { res.writeHead(302, { Location: `/?ig=${ok ? 'ok' : 'error'}&igmsg=${encodeURIComponent(msg)}#settings` }); res.end(); };
    if (auth.enabled && (!me || !can(me, 'settings'))) return back('Войдите в программу как владелец или администратор и нажмите «Подключить Instagram» ещё раз', false);
    const redirect = `https://${hostOf(req)}/api/instagram/callback`;
    try {
      if (url.pathname === '/api/instagram/connect') { res.writeHead(302, { Location: crm.instagramAuthUrl(redirect) }); return res.end(); }
      if (url.searchParams.get('error')) return back(`Instagram: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`, false);
      const r = await crm.instagramConnect(url.searchParams.get('code'), url.searchParams.get('state'), redirect);
      store.audit({ kind: 'change', user: me, ip: clientIp(req), device: device(req), action: 'Подключил Instagram', details: `@${r.username || r.id}` });
      return back(`Instagram подключён: @${r.username || r.name || r.id}`, true);
    } catch (err) {
      return back(err.message, false);
    }
  }
  if (url.pathname === '/api/act-as/stop' && req.method === 'POST') {
    const owner = auth.ownerOf(req);
    if (!owner) return sendJson(res, 400, { error: 'Вы и так работаете под своим именем' });
    const was = auth.currentUser(req);
    res.setHeader('Set-Cookie', auth.returnCookies(req));
    mainStore.audit({ kind: 'change', user: owner, ip: clientIp(req), device: device(req), action: 'Вернулся к своему имени', details: was ? `был в программе как ${was.name || was.email}` : '' });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const user = auth.currentUser(req);
    if (user) store.audit({ kind: 'logout', user, ip: clientIp(req), device: device(req), action: 'Выход из программы' });
    res.setHeader('Set-Cookie', auth.logoutCookie(req));
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

// Файл с серверов Meta через наш сервер (вложения клиентов, превью сторис): телефон не всегда открывает их напрямую.
async function proxyMeta(req, res, target) {
  let host = '';
  try { host = new URL(target).hostname; } catch { return sendJson(res, 404, { error: 'Файла нет' }); }
  if (!/(^|\.)(fbsbx\.com|fbcdn\.net|cdninstagram\.com|whatsapp\.net)$/i.test(host)) return sendJson(res, 404, { error: 'Файла нет' });
  try {
    const up = await fetch(target, { headers: req.headers.range ? { Range: req.headers.range } : {}, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!up.ok && up.status !== 206) return sendJson(res, 410, { error: 'Ссылка устарела — откройте в Instagram' });
    const head = { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' };
    for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) head[h] = up.headers.get(h);
    res.writeHead(up.status, head);
    for await (const chunk of up.body) if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    return res.end();
  } catch (err) {
    if (!res.headersSent) return sendJson(res, 502, { error: `Не получилось загрузить файл: ${err.message}` });
    return res.destroy();
  }
}

// Базы для скачивания копии: основная, филиалы, MONT AI Studio.
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
function backupSources() {
  const dir = path.dirname(DB_FILE);
  const list = [{ key: 'shop', name: `Основной магазин${branchList()[0]?.name ? ` «${branchList()[0].name}»` : ''}`, db: mainStore.db, file: DB_FILE }];
  for (const b of branchList()) {
    if (b.main || !b.file) continue;
    const ctx = contextOf(b.id);
    if (ctx?.store?.db) list.push({ key: `branch-${b.id}`, name: `Филиал «${b.name}»`, db: ctx.store.db, file: path.join(dir, b.file) });
  }
  if (studio?.db) list.push({ key: 'studio', name: 'MONT AI Studio (фото)', db: studio.db, file: path.join(dir, 'studio.db') });
  return list;
}

function sendBytes(res, type, data, cache = 'no-cache') {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(data);
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

// Вебхуки Meta: Instagram Direct и WhatsApp. GET — проверка адреса при подключении: вернуть
// hub.challenge, если токен совпал. POST — новые сообщения; подпись X-Hub-Signature-256 проверяется по App Secret.
// Настройки автоответа для страницы настроек (без токенов).
function igAutoPublic(s) {
  const d = require('./ig-price').IG_PRICE_DEFAULTS;
  return {
    autoPrice: Boolean(s.autoPrice), priceWords: s.priceWords ?? d.priceWords, priceTemplate: s.priceTemplate || d.priceTemplate,
    publicReply: s.publicReply ?? d.publicReply, notifyMissing: s.notifyMissing !== false, defaultTemplate: d.priceTemplate,
  };
}

// Настройки Instagram для экрана: без секретов; когда последний раз приходил вебхук и был ли отказ.
function igSettingsOut(s) {
  const lastHook = Number(store.setting('instagram_last_hook', '0')) || null;
  const lastComment = Number(store.setting('instagram_last_comment', '0')) || null;
  const lastDm = Number(store.setting('instagram_last_dm', '0')) || null;
  const denied = store.listAudit({ from: Date.now() - 7 * 864e5, to: Date.now() + 1, kind: 'denied', q: 'Вебхук Instagram', limit: 1 })[0];
  const failed = store.listAudit({ from: Date.now() - 7 * 864e5, to: Date.now() + 1, kind: 'change', q: 'Автоответ в Instagram не отправлен', limit: 1 })[0];
  return { enabled: s.enabled, verifyToken: s.verifyToken, hasSecret: Boolean(s.appSecret), hasToken: Boolean(s.accessToken), webhookPath: '/webhooks/instagram',
    autoReply: s.autoReply, autoText: s.autoText, autoHours: s.autoHours, lastHook, lastComment, lastDm, appId: s.appId || '', configId: s.configId || '', igId: s.igId || '', igUsername: s.igUsername || '', pageName: s.pageName || '', resolveNote: s.resolveNote || '', mode: crm.instagramMode(s), tokenExpires: s.tokenExpires || null, tokenKind: s.accessToken ? (/^IG/.test(s.accessToken) ? 'instagram' : /^EAA/.test(s.accessToken) ? 'facebook' : 'other') : null,
    lastDenied: denied ? { at: denied.at, details: denied.details } : null, lastAutoError: failed ? { at: failed.at, details: failed.details } : null, auto: igAutoPublic(s) };
}
const META_CHANNELS = {
  instagram: { name: 'Instagram', settings: () => crm.instagramSettings(), receive: (p) => crm.receiveInstagram(p), profile: (id) => crm.fillInstagramProfile(id) },
  whatsapp: { name: 'WhatsApp', settings: () => crm.whatsappSettings(), receive: (p) => crm.receiveWhatsapp(p), profile: async () => {} },
};

async function metaWebhook(req, res, url, channel) {
  const ch = META_CHANNELS[channel];
  const settings = ch.settings();
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === settings.verifyToken;
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(ok ? url.searchParams.get('hub.challenge') || '' : 'Неверный токен проверки');
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Только GET и POST' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) return sendJson(res, 413, { error: 'Слишком большой запрос' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!settings.enabled || !crm.verifySignature(raw, req.headers['x-hub-signature-256'], settings.appSecret)) {
    store.audit({ kind: 'denied', userName: ch.name, ip: clientIp(req), device: device(req), action: `Вебхук ${ch.name} отклонён`, details: settings.enabled ? 'неверная подпись' : `${ch.name} выключен в настройках` });
    return sendJson(res, 403, { error: 'Подпись не совпала' });
  }
  // Meta ждёт ответ быстро: отвечаем сразу, сообщения разбираем после.
  sendJson(res, 200, { ok: true });
  // Когда Meta последний раз прислала событие — видно в настройках (доходят ли сообщения вообще).
  try { store.setSetting(`${channel}_last_hook`, String(Date.now())); } catch { /* не важно */ }
  // Отдельно: доходят ли комментарии и сообщения Direct (часто приходят только комментарии).
  if (channel === 'instagram') {
    try {
      const p = JSON.parse(raw.toString('utf8'));
      const entries = p.entry || [];
      if (entries.some((e) => (e.changes || []).some((c) => c.field === 'comments'))) store.setSetting('instagram_last_comment', String(Date.now()));
      if (entries.some((e) => (e.messaging || []).some((m) => m.message && !m.message.is_echo) || (e.changes || []).some((c) => c.field === 'messages'))) store.setSetting('instagram_last_dm', String(Date.now()));
    } catch { /* не важно */ }
  }
  const greet = [];
  try {
    for (const { lead, isNew } of ch.receive(JSON.parse(raw.toString('utf8')))) {
      if (isNew) await ch.profile(lead.id);
      const fresh = crm.get(lead.id);
      notifier.broadcast('lead', { id: fresh.id, name: fresh.name, source: ch.name, text: fresh.events.at(-1)?.text || '' }, 'crm');
      if (channel === 'instagram' && !greet.some((x) => x.id === fresh.id)) greet.push(fresh);
    }
  } catch (err) {
    console.error(`${ch.name}: не получилось разобрать сообщение:`, err.message);
  }
  // Instagram: автоответ ценой на комментарии под рилсами и на артикул в Direct.
  if (channel === 'instagram') {
    try {
      await igPrice.handle(JSON.parse(raw.toString('utf8')));
    } catch (err) {
      console.error('Instagram: автоответ ценой не сработал:', err.message);
    }
    // Затем приветственный автоответ — один на человека; если ответ ценой уже ушёл (событие «Автоответ»), не дублируется.
    for (const lead of greet) {
      try { await crm.instagramAutoReply(lead.id); } catch (err) {
        store.audit({ kind: 'change', userName: 'Instagram', action: 'Автоответ в Instagram не отправлен', details: `${lead.name}: ${err.message}`.slice(0, 500) });
      }
    }
  }
}

// Личный кабинет покупателя на витрине: регистрация, вход, «Забыл пароль», мои заказы.
async function shopAccount(req, res, url) {
  const action = url.pathname.slice('/shop/account/'.length);
  const ip = clientIp(req);
  const who = (c, phoneText) => ({ ip, device: device(req), userName: `Покупатель: ${c?.name ? c.name + ', ' : ''}+${c?.phone || phoneText || ''}` });
  const done = (result) => {
    if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
    const { cookie, ...rest } = result;
    return sendJson(res, 200, rest);
  };
  try {
    // Капча для входа, регистрации и восстановления пароля.
    if (req.method === 'GET' && action === 'captcha') {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, captcha.create());
    }
    if (req.method === 'GET' && action === 'me') {
      const c = shopAuth.current(req);
      if (!c) return sendJson(res, 200, { customer: null });
      const full = store.findCustomer(c.id);
      const { enabled, percent, maxPay } = store.loyalty();
      // Покупки во всех магазинах: в филиале у покупателя своя запись (ищется по телефону).
      // Бонусы и сертификаты общие — лежат в основной базе.
      const purchases = [];
      for (const b of branchList()) {
        const ctx = contextOf(b.id);
        const bc = b.main ? c : ctx?.store.findCustomerByPhone(c.phone);
        if (bc) purchases.push(...ctx.shopAuth.myPurchases(bc).map((x) => ({ ...x, store: b.name, storeId: b.id })));
      }
      const named = (list) => list.map((x) => ({ ...x, store: storeName(x.store_id) }));
      const certificates = mainStore.customerCertificates(c.id, { all: true })
        .map(({ number, amount, balance, sold_at, expires_at, state }) => ({ number, amount, balance, sold_at, expires_at, state }));
      return sendJson(res, 200, {
        customer: { ...shopAuth.publicCustomer(c), birthdayDiscount: full.birthdayDiscount },
        orders: shopAuth.myOrders(c), purchases: purchases.sort((a, b) => b.created_at - a.created_at).slice(0, 100),
        bonusLog: named(shopAuth.myBonusLog(c)), certificates, certificateOps: named(mainStore.customerCertificateOps(c.id)),
        stores: branchList().length, loyalty: { enabled, percent, maxPay },
      });
    }
    if (req.method !== 'POST' && req.method !== 'PUT') return sendJson(res, 405, { error: 'Неверный запрос' });
    const body = await readBody(req, 65_536);
    if (['login', 'register', 'reset/request'].includes(action) && !captcha.verify(body.captchaId, body.captcha)) {
      return sendJson(res, 400, { error: 'Неверный код с картинки — введите цифры с новой картинки', captcha: true });
    }
    switch (action) {
      case 'register': {
        const r = await shopAuth.register(body, req);
        if (r.customer) store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель зарегистрировался на витрине' });
        return done(r);
      }
      case 'register/confirm': {
        const r = shopAuth.confirmRegistration(body, req);
        store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель зарегистрировался на витрине', details: 'номер подтверждён кодом' });
        return done(r);
      }
      case 'login':
        try {
          const r = shopAuth.login(body, req, ip);
          store.audit({ ...who(r.customer), kind: 'login', action: 'Покупатель вошёл на витрину' });
          return done(r);
        } catch (err) {
          let typed = String(body.phone || '').replace(/\D/g, '');
          try { typed = normalizePhone(body.phone); } catch { /* в журнал — как ввели */ }
          store.audit({ ...who(null, typed), kind: 'login_failed', action: 'Неудачный вход покупателя на витрину', details: err.message });
          throw err;
        }
      case 'logout':
        res.setHeader('Set-Cookie', shopAuth.logoutCookie(req));
        return sendJson(res, 200, { ok: true });
      case 'reset/request':
        return done(await shopAuth.requestReset(body));
      case 'reset': {
        const r = shopAuth.resetPassword(body, req);
        store.audit({ ...who(r.customer), kind: 'change', action: 'Покупатель сменил пароль по коду' });
        return done(r);
      }
      case 'me': {
        const c = shopAuth.current(req);
        if (!c) return sendJson(res, 401, { error: 'Войдите снова' });
        const fresh = shopAuth.updateProfile(c, body);
        // Если сменили пароль, старая сессия кончилась — выдаём новую.
        if (body.newPassword) res.setHeader('Set-Cookie', shopAuth.login({ phone: fresh.phone, password: body.newPassword }, req, ip).cookie);
        return sendJson(res, 200, { customer: shopAuth.publicCustomer(fresh) });
      }
      default:
        return sendJson(res, 404, { error: 'Не найдено' });
    }
  } catch (err) {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Что-то пошло не так. Попробуйте ещё раз.' });
  }
}

// Страницы и запросы без входа: оформление, интернет-витрина и её заказы.
async function handlePublic(req, res, url, user) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/theme.css') return sendBytes(res, 'text/css; charset=utf-8', themeCss(store.design(), mainStore.listFonts()));
  const font = req.method === 'GET' && pathname.match(/^\/fonts\/(\d+)$/);
  if (font) {
    const found = mainStore.getFont(font[1]);
    if (!found) return sendJson(res, 404, { error: 'Шрифта нет' });
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=31536000, immutable');
  }
  if (req.method === 'GET' && pathname === '/api/brand') return sendJson(res, 200, { name: store.design().name });
  const image = req.method === 'GET' && pathname.match(/^\/img\/(\d+)$/);
  if (image) {
    const found = store.getImage(image[1]);
    if (!found) return sendJson(res, 404, { error: 'Картинки нет' });
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=31536000, immutable');
  }
  const hook = pathname.match(/^\/webhooks\/(instagram|whatsapp)$/);
  if (hook) return metaWebhook(req, res, url, hook[1]);
  if (!pathname.startsWith('/shop')) return false;

  // Сотрудник с правом «Витрина» видит её и до открытия — чтобы настроить.
  const shop = store.shop();
  const preview = (auth.enabled ? Boolean(user) : true) && can(user, 'shop');
  const open = shop.enabled || preview;
  if (req.method === 'GET' && (pathname === '/shop' || pathname === '/shop/')) {
    if (!open) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Магазин закрыт</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">Интернет-магазин пока закрыт.</p>');
    }
    // Значок вкладки с номером картинки в адресе — после замены браузер возьмёт новый, а не старый из памяти.
    const iconId = shop.faviconId || shop.logoId;
    return serveStatic(res, '/shop.html', (html) => html.replaceAll('href="/shop/favicon"', `href="/shop/favicon?v=${iconId || 0}"`));
  }
  // Значок вкладки: своя картинка из конструктора, иначе логотип, иначе стандартный значок.
  if (req.method === 'GET' && pathname === '/shop/favicon') {
    const found = open && (shop.faviconId || shop.logoId) ? store.getImage(shop.faviconId || shop.logoId) : null;
    if (found) return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=86400');
    return sendBytes(res, 'image/svg+xml', fs.readFileSync(path.join(PUBLIC, 'icon.svg')), 'public, max-age=86400');
  }
  // Приложение витрины на телефоне: манифест (название, цвета, значок) и сервис-воркер (работа без сети).
  if (req.method === 'GET' && pathname === '/shop/manifest.webmanifest') {
    const iconId = shop.faviconId || shop.logoId;
    const icon = iconId ? store.getImage(iconId) : null;
    const start = hostOf(req) === SHOP_DOMAIN || hostOf(req) === `www.${SHOP_DOMAIN}` ? '/' : '/shop';
    const icons = icon ? [{ src: `/shop/favicon?v=${iconId}`, sizes: '512x512', type: icon.mime, purpose: 'any' }, { src: `/shop/favicon?v=${iconId}`, sizes: '192x192', type: icon.mime, purpose: 'any' }]
      : [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }];
    return sendBytes(res, 'application/manifest+json; charset=utf-8', JSON.stringify({
      name: shop.title || 'Магазин', short_name: (shop.title || 'Магазин').slice(0, 12), description: shop.slogan || '',
      id: start, start_url: `${start}?app=1`, scope: start, display: 'standalone', orientation: 'portrait',
      background_color: shop.bg || '#ffffff', theme_color: shop.accent || '#111111', lang: 'ru', icons,
    }), 'no-cache');
  }
  if (req.method === 'GET' && pathname === '/shop/sw.js') {
    res.setHeader('Service-Worker-Allowed', '/');
    return sendBytes(res, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(PUBLIC, 'shop-sw.js')), 'no-cache');
  }
  if (req.method === 'GET' && pathname === '/shop/theme.css') return sendBytes(res, 'text/css; charset=utf-8', shopCss(shop, mainStore.listFonts()));
  if (req.method === 'GET' && pathname === '/shop/data') {
    if (!open) return sendJson(res, 404, { error: 'Витрина закрыта' });
    const { css, payments, ...rest } = shop;
    // Способы оплаты: без счёта программы — покупателю он не нужен.
    const publicSettings = { ...rest, payments: payments.map((x) => ({ id: x.id, name: x.name, details: x.details, qr: x.qrId ? `/img/${x.qrId}` : null })) };
    const products = store.shopProductsCached().list;
    return sendJson(res, 200, { settings: { ...publicSettings, preview: !shop.enabled }, products, categories: store.shopCategories(products) });
  }
  const photo = req.method === 'GET' && pathname.match(/^\/shop\/photo\/(\d+)$/);
  if (photo) {
    if (!open || !store.shopPhotoAllowed(photo[1])) return sendJson(res, 404, { error: 'Фото нет' });
    const found = store.getPhoto(photo[1]);
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=86400');
  }
  const extra = req.method === 'GET' && pathname.match(/^\/shop\/photo\/(\d+)\/(\d+)$/);
  if (extra) {
    const found = open ? store.shopGalleryImage(extra[1], extra[2]) : null;
    if (!found) return sendJson(res, 404, { error: 'Фото нет' });
    return sendBytes(res, found.mime, Buffer.from(found.data), 'public, max-age=86400');
  }
  // Ошибки скриптов витрины у покупателей (браузер сам присылает текст ошибки) — в журнал сервиса:
  // journalctl -u shop | grep 'Витрина: ошибка'. Не больше 20 сообщений в минуту, короткий текст.
  if (req.method === 'POST' && pathname === '/shop/client-error') {
    const now = Date.now();
    if (now - clientErrors.at > 60e3) Object.assign(clientErrors, { at: now, n: 0 });
    if (++clientErrors.n <= 20) {
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 4000) break; }
      console.error('Витрина: ошибка у покупателя', String(req.headers['user-agent'] || '').slice(0, 200), '|', text.slice(0, 2000).replace(/\s+/g, ' '));
    }
    res.writeHead(204); return res.end();
  }
  if (pathname.startsWith('/shop/account/')) return shopAccount(req, res, url);
  // Покупатель прикрепил чек об оплате (скриншот перевода или PDF).
  const receipt = req.method === 'POST' && pathname.match(/^\/shop\/order\/(\d+)\/receipt$/);
  if (receipt) {
    try {
      const customer = shopAuth.current(req);
      if (!customer) return sendJson(res, 401, { error: 'Войдите снова' });
      const order = store.addOrderReceipt(receipt[1], customer, await readBody(req, 8e6));
      notifier.orderReceipt(order);
      store.audit({ kind: 'change', userName: `Покупатель: ${order.name}`, ip: clientIp(req), device: device(req), action: 'Покупатель прикрепил чек об оплате', details: `Заказ №${order.id} на ${order.total} сом` });
      return sendJson(res, 200, { ok: true, status: order.status, receipts: order.receipts.length });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      throw err;
    }
  }
  // Покупатель нажал «Я оплатил» — заказ ждёт сверки перевода.
  const paidClaim = req.method === 'POST' && pathname.match(/^\/shop\/order\/(\d+)\/paid$/);
  if (paidClaim) {
    try {
      const customer = shopAuth.current(req);
      if (!customer) return sendJson(res, 401, { error: 'Войдите снова' });
      const order = store.claimOrderPaid(paidClaim[1], customer);
      notifier.orderPaid(order);
      store.audit({ kind: 'change', userName: `Покупатель: ${order.name}`, ip: clientIp(req), device: device(req), action: 'Покупатель отметил оплату заказа', details: `Заказ №${order.id} на ${order.total} сом, ${order.pay_name}` });
      return sendJson(res, 200, { ok: true, status: order.status });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      throw err;
    }
  }
  if (req.method === 'POST' && pathname === '/shop/order') {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (orderLog.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= ORDER_LIMIT) return sendJson(res, 429, { error: 'Слишком много заказов подряд. Попробуйте через несколько минут или позвоните нам.' });
    try {
      const body = await readBody(req, 262_144);
      // Скрытое поле: люди его не видят и не заполняют, а боты заполняют.
      if (body.website) return sendJson(res, 200, { ok: true, id: 0 });
      const customer = shopAuth.current(req);
      if (!customer) return sendJson(res, 401, { error: 'Чтобы оформить заказ, войдите или зарегистрируйтесь' });
      const order = store.createOrder(body, customer);
      recent.push(now);
      orderLog.set(ip, recent);
      notifier.order(order);
      try {
        const lead = crm.fromOrder(order);
        notifier.broadcast('lead', { id: lead.id, name: lead.name, source: lead.source, text: `Заказ №${order.id}` }, 'crm');
      } catch (err) {
        console.error('CRM: заказ не попал в сделки:', err.message);
      }
      store.audit({ kind: 'change', userName: `Покупатель: ${order.name}`, ip, device: device(req), action: 'Новый заказ с витрины', details: `Заказ №${order.id} на ${order.total} сом` });
      return sendJson(res, 200, { ok: true, id: order.id, total: order.total, status: order.status });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Не получилось оформить заказ. Попробуйте ещё раз или позвоните нам.' });
    }
  }
  return false;
}

// Каждый запрос выполняется в контексте магазина: сотрудник филиала — в своём, владелец — в выбранном.
// Интернет-витрина и вебхуки Instagram/WhatsApp — у основного магазина.
// Два адреса на одном сервере: SHOP_DOMAIN (montshop.kg) — витрина для покупателей, ADMIN_DOMAIN
// (например, baza.montshop.kg) — программа для владельца и сотрудников. На адресе витрины программы не видно.
const SHOP_DOMAIN = String(process.env.SHOP_DOMAIN || '').toLowerCase().trim();
const ADMIN_DOMAIN = String(process.env.ADMIN_DOMAIN || '').toLowerCase().trim();
const SHOP_PATHS = new Set(['/shop', '/shop.js', '/shop.css', '/colors.js', '/icon.svg', '/favicon.ico']);
const hostOf = (req) => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (SHOP_DOMAIN && (hostOf(req) === SHOP_DOMAIN || hostOf(req) === `www.${SHOP_DOMAIN}`)) {
    if (url.pathname === '/') url.pathname = '/shop';
    const ok = SHOP_PATHS.has(url.pathname) || url.pathname.startsWith('/shop/') || url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/webhooks/');
    if (!ok) {
      // Сотрудник открыл программу по адресу витрины — отправляем на адрес программы.
      res.writeHead(ADMIN_DOMAIN ? 302 : 404, ADMIN_DOMAIN ? { Location: `https://${ADMIN_DOMAIN}${url.pathname}${url.search}` } : { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(ADMIN_DOMAIN ? '' : 'Не найдено');
    }
  }
  let found = null;
  try { found = auth.currentUser(req); } catch {}
  const shared = url.pathname.startsWith('/shop') || url.pathname.startsWith('/webhooks/');
  const { ctx, user, owner } = shared ? { ctx: contexts.get(1), user: found, owner: null } : resolveContext(req, found);
  return als.run(ctx, () => handleRequest(req, res, url, user, owner));
});

/* ---------- Защита от перегрузки (DDoS) и подделки запросов ---------- */
// Сколько запросов можно с одного адреса за минуту: обычная работа и витрина укладываются с большим запасом.
const RATE = { all: 3000, auth: 60 }; // мобильные операторы дают один адрес многим покупателям — пределы с запасом
const hits = new Map(); // ip -> { min, all, auth }
setInterval(() => { const m = Math.floor(Date.now() / 60_000); for (const [k, v] of hits) if (v.min < m - 1) hits.delete(k); }, 60_000).unref();
function rateLimited(req, url) {
  const ip = clientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1') return false;
  const min = Math.floor(Date.now() / 60_000);
  let h = hits.get(ip);
  if (!h || h.min !== min) { h = { min, all: 0, auth: 0 }; hits.set(ip, h); }
  h.all++;
  // Вход, регистрация, коды и капча — отдельный, строгий предел: подбор паролей и спам кодами.
  if (req.method !== 'GET' && (url.pathname === '/api/login' || url.pathname === '/api/switch-user' || url.pathname.startsWith('/shop/account/'))) h.auth++;
  if (url.pathname === '/shop/account/captcha') h.auth++;
  return h.all > RATE.all || h.auth > RATE.auth;
}
// Изменения (POST/PUT/DELETE) принимаются только со страниц самой программы: чужой сайт (и витрина для
// адреса программы) не может отправить запрос от имени вошедшего сотрудника. Вебхуки Meta — без cookie, им можно.
function foreignOrigin(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || url.pathname.startsWith('/webhooks/')) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== String(req.headers.host || ''); } catch { return true; }
}

async function handleRequest(req, res, url, user, owner) {
  // SAMEORIGIN, а не DENY: конструктор витрины показывает её предпросмотр во фрейме.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (rateLimited(req, url)) {
    res.setHeader('Retry-After', '60');
    return sendJson(res, 429, { error: 'Слишком много запросов. Подождите минуту.' });
  }
  if (foreignOrigin(req, url)) return sendJson(res, 403, { error: 'Запрос с чужого сайта отклонён' });
  try {
    if ((await handleAuth(req, res, url)) !== false) return;
  } catch (err) {
    return sendJson(res, err instanceof UserError ? 400 : 500, { error: err instanceof UserError ? err.message : 'Внутренняя ошибка' });
  }
  try {
    if ((await handlePublic(req, res, url, user)) !== false) return;
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Внутренняя ошибка' });
  }
  if (auth.enabled && !user && !PUBLIC_PATHS.has(url.pathname)) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Нужно войти' });
    res.writeHead(302, { Location: '/login.html' });
    return res.end();
  }
  if (!url.pathname.startsWith('/api/')) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Неверный адрес' });
    }
    return serveStatic(res, pathname);
  }
  // Вложение клиента из Instagram/WhatsApp через наш сервер: телефон (Safari) не всегда играет видео
  // со ссылки Meta напрямую. Только ссылки, сохранённые в переписке, и только домены Meta; перемотка (Range) работает.
  const file = req.method === 'GET' && url.pathname.match(/^\/api\/crm\/file\/(\d+)\/(\d+)$/);
  if (file) {
    if (!user || !can(user, 'crm')) return sendJson(res, 403, { error: 'Нет доступа' });
    const a = crm.eventFile(file[1], file[2]);
    if (!a) return sendJson(res, 404, { error: 'Вложения нет' });
    return proxyMeta(req, res, a.url);
  }
  const storyImg = req.method === 'GET' && url.pathname.match(/^\/api\/crm\/stories\/([\w-]+)\/image$/);
  if (storyImg) {
    if (!user || !can(user, 'crm')) return sendJson(res, 403, { error: 'Нет доступа' });
    const u = igPrice.storyImage(storyImg[1]);
    if (!u) return sendJson(res, 404, { error: 'Сторис нет' });
    return proxyMeta(req, res, u);
  }
  // Двойная проверка входа владельца: привязка личного чата, включение и отключение.
  if (url.pathname.startsWith('/api/2fa')) {
    if (!user || !isOwner(user)) return sendJson(res, 403, { error: 'Это настройка владельца' });
    try {
      const cfg = twoFa();
      if (req.method === 'GET' && url.pathname === '/api/2fa') {
        return sendJson(res, 200, { enabled: Boolean(cfg.enabled && cfg.chatId), linked: Boolean(cfg.chatId), who: cfg.who || '', bot: Boolean(tgBot().token) });
      }
      const body = req.method === 'POST' ? await readBody(req, 16_384) : {};
      if (req.method === 'POST' && url.pathname === '/api/2fa/link') {
        const tg = tgBot();
        if (!tg.token) throw new UserError('Сначала подключите бота: «Настройки → Telegram»');
        const me = await fetch(`https://api.telegram.org/bot${tg.token}/getMe`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => ({}));
        if (!me.ok) throw new UserError('Telegram не узнал бота — проверьте токен в «Настройки → Telegram»');
        const start = crypto.randomBytes(6).toString('hex');
        setTwoFa({ ...cfg, start, startAt: Date.now() });
        return sendJson(res, 200, { link: `https://t.me/${me.result.username}?start=${start}`, bot: me.result.username });
      }
      if (req.method === 'POST' && url.pathname === '/api/2fa/check') {
        // Ищем «/start КОД» от владельца в личном чате с ботом и шлём туда пробный код.
        if (!cfg.start || Date.now() - (cfg.startAt || 0) > 30 * 60_000) throw new UserError('Нажмите «Подключить Telegram» ещё раз');
        const tg = tgBot();
        const upd = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?allowed_updates=%5B%22message%22%5D`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => ({}));
        if (!upd.ok) throw new UserError(`Telegram не отдал сообщения бота: ${upd.description || 'нет связи'}`);
        const msg = (upd.result || []).map((u) => u.message).filter(Boolean).reverse().find((m) => m.chat?.type === 'private' && String(m.text || '').trim() === `/start ${cfg.start}`);
        if (!msg) throw new UserError('Бот ещё не получил ваше сообщение. Откройте ссылку, нажмите «Start» (или «Запустить») и нажмите «Проверить» ещё раз.');
        const code = newCode();
        await tgSendTo(msg.chat.id, `🔐 Проверочный код: ${code}\nВведите его в программе, чтобы включить вход с кодом.`);
        const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') + (msg.from?.username ? ` (@${msg.from.username})` : '');
        setTwoFa({ ...cfg, pendingChat: String(msg.chat.id), pendingWho: who, pendingHash: codeHash(code), pendingAt: Date.now() });
        return sendJson(res, 200, { sent: true, who });
      }
      if (req.method === 'POST' && url.pathname === '/api/2fa/enable') {
        if (!cfg.pendingChat || Date.now() - (cfg.pendingAt || 0) > 10 * 60_000) throw new UserError('Код устарел — нажмите «Проверить» ещё раз');
        if (auth.isBlocked(req, 'owner-2fa')) throw new UserError('Слишком много неверных попыток. Подождите 15 минут.');
        if (codeHash(String(body.code || '').replace(/\D/g, '')) !== cfg.pendingHash) { auth.countFailure(req, 'owner-2fa'); throw new UserError('Неверный код'); }
        setTwoFa({ enabled: true, chatId: cfg.pendingChat, who: cfg.pendingWho || '' });
        store.audit({ kind: 'change', user, ip: clientIp(req), device: device(req), action: 'Включил вход с кодом из Telegram', details: cfg.pendingWho || '' });
        // Это устройство сразу запоминается — владельца не выкидывает и код здесь не спрашивается 30 дней.
        res.setHeader('Set-Cookie', auth.trustCookie(req, user));
        return sendJson(res, 200, { enabled: true, who: cfg.pendingWho || '' });
      }
      if (req.method === 'POST' && url.pathname === '/api/2fa/disable') {
        // Отключить — только зная пароль владельца: забытый открытым компьютер не снимет защиту.
        if (!checkPassword(String(body.password || ''), user.password_hash)) { auth.countFailure(req, 'owner-2fa'); throw new UserError('Неверный пароль'); }
        setTwoFa({ enabled: false, chatId: cfg.chatId || '', who: cfg.who || '' });
        store.audit({ kind: 'change', user, ip: clientIp(req), device: device(req), action: 'Отключил вход с кодом из Telegram' });
        if (cfg.chatId) tgSendTo(cfg.chatId, '⚠️ Вход с кодом из Telegram отключён. Теперь владелец входит только по паролю.').catch(() => {});
        return sendJson(res, 200, { enabled: false });
      }
      return sendJson(res, 404, { error: 'Не найдено' });
    } catch (err) {
      return sendJson(res, err instanceof UserError ? 400 : 500, { error: err instanceof UserError ? err.message : 'Что-то пошло не так' });
    }
  }
  // Резервная копия базы — только владелец: целостный снимок (VACUUM INTO) во временный файл рядом с базой, отдаём и удаляем.
  if (req.method === 'GET' && url.pathname === '/api/backup/list') {
    if (auth.enabled && !isOwner(user)) return sendJson(res, 403, { error: 'Копию базы скачивает только владелец' });
    return sendJson(res, 200, backupSources().map(({ key, name, file }) => ({ key, name, size: fileSize(file) })));
  }
  if (req.method === 'GET' && url.pathname === '/api/backup/download') {
    if (auth.enabled && !isOwner(user)) return sendJson(res, 403, { error: 'Копию базы скачивает только владелец' });
    const src = backupSources().find((x) => x.key === url.searchParams.get('db'));
    if (!src) return sendJson(res, 404, { error: 'Такой базы нет' });
    const tmp = path.join(path.dirname(DB_FILE), `.download-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      src.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      // Дата в имени файла — по времени магазина (Бишкек), а не сервера.
      const stamp = new Date().toLocaleString('sv-SE', { timeZone: process.env.SHOP_TZ || 'Asia/Bishkek' }).slice(0, 16).replace(' ', '_').replace(':', '-');
      const size = fs.statSync(tmp).size;
      store.audit({ kind: 'change', user, ip: clientIp(req), device: device(req), action: 'Скачал резервную копию базы', details: `${src.name}, ${(size / 1048576).toFixed(1)} МБ` });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${src.key}-${stamp}.db"` });
      const rs = fs.createReadStream(tmp);
      const done = () => fs.rm(tmp, { force: true }, () => {});
      rs.on('close', done);
      res.on('close', () => { rs.destroy(); done(); });
      return rs.pipe(res);
    } catch (err) {
      fs.rm(tmp, { force: true }, () => {});
      return sendJson(res, 500, { error: `Не получилось сделать копию: ${err.message}` });
    }
  }
  // Файл MONT AI Studio — только с правом «AI Studio» и только своей съёмки текущего магазина.
  const studioFile = req.method === 'GET' && url.pathname.match(/^\/api\/studio\/assets\/(\d+)\/file$/);
  if (studioFile) {
    if (!can(user, 'studio')) return sendJson(res, 403, { error: 'Нет доступа к AI Studio' });
    const found = studio.assetFile(studioFile[1], current().id);
    if (!found) return sendJson(res, 404, { error: 'Файла нет' });
    res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(Buffer.from(found.data));
  }
  // Дополнительное фото товара (галерея) — так же, только своё фото этого товара.
  const extraPhoto = req.method === 'GET' && url.pathname.match(/^\/api\/products\/(\d+)\/images\/(\d+)$/);
  if (extraPhoto) {
    const found = store.getGalleryImage(extraPhoto[1], extraPhoto[2]);
    if (!found) return sendJson(res, 404, { error: 'Фото нет' });
    res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(Buffer.from(found.data));
  }
  // Фото товара отдаётся картинкой, а не JSON. Смотреть фото может любой вошедший.
  const photo = req.method === 'GET' && url.pathname.match(/^\/api\/products\/(\d+)\/photo$/);
  if (photo) {
    const found = store.getPhoto(photo[1]);
    if (!found) return sendJson(res, 404, { error: 'Фото нет' });
    res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(Buffer.from(found.data));
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!['notify', 'orders', 'crm', 'customers.accounts'].some((r) => can(user, r))) return sendJson(res, 403, { error: 'Нет доступа' });
    return notifier.subscribe(req, res, user);
  }
  const route = match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Не найдено' });
  // Пока сотрудников нет, программа открыта и всё можно (работа на своём компьютере).
  // access — право или список прав, из которых хватит любого.
  const allowed = route.access === 'any' || [route.access].flat().some((r) => can(user, r));
  if (!allowed) {
    if (req.method !== 'GET') store.audit({ kind: 'denied', user, ip: clientIp(req), device: device(req), action: 'Попытка действия без права', details: `${req.method} ${url.pathname}` });
    return sendJson(res, 403, { error: 'У вашей роли нет доступа к этому' });
  }
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    // actingAs — владелец, который смотрит программу от имени этого сотрудника.
    const actor = auth.ownerOf(req);
    const key = `${req.method} ${route.pattern}`;
    // Действие, которое можно отменить: изменения строк записываются под меткой (только синхронная часть обработчика).
    const undoToken = UNDO_KEYS.has(key) && !body.dryRun ? `a-${Date.now()}-${Math.random().toString(36).slice(2)}` : null;
    let result;
    let undoOk = Boolean(undoToken);
    if (undoToken) store.undoBegin(undoToken);
    reqMeta = { ip: clientIp(req), device: device(req) };
    try {
      result = route.handler(route.params, url, body, user && { ...store.publicUser(user), owner: Boolean(owner), actingAs: actor && isOwner(actor) ? actor.name || actor.email : null });
    } catch (err) {
      if (undoToken) { store.undoEnd(); store.undoDiscard(undoToken); }
      throw err;
    }
    if (undoToken) store.undoEnd();
    if (result && typeof result.then === 'function') {
      undoOk = false;
      try { result = await result; } catch (err) { if (undoToken) store.undoDiscard(undoToken); throw err; }
    }
    // Предварительный подсчёт (dryRun) ничего не меняет — в журнал не пишем.
    if (AUDIT_LABELS[key] && !body.dryRun) {
      try {
        // Действия, сделанные владельцем от имени сотрудника, помечаются — чтобы было видно, кто на самом деле.
        const prefix = actor && isOwner(actor) ? `[владелец ${actor.name || actor.email} от имени сотрудника] ` : '';
        const auditId = store.audit({ kind: 'change', user, ip: clientIp(req), device: device(req), action: AUDIT_LABELS[key], details: prefix + auditDetails(key, route.params, body, result) });
        if (undoToken) { if (undoOk) store.undoAttach(undoToken, auditId); else store.undoDiscard(undoToken); }
      } catch (err) {
        console.error('Журнал действий:', err.message);
        if (undoToken) store.undoDiscard(undoToken);
      }
    } else if (undoToken) store.undoDiscard(undoToken);
    if (!body.dryRun) moveTelegram(key, route.params, body, result, user);
    if (req.method !== 'GET') try { store.clearShopCache(); } catch {}
    if (result?.__file) return sendBytes(res, result.__file.mime, Buffer.from(result.__file.data), 'private, max-age=3600');
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message, ...(err.data || {}) });
    console.error(err);
    sendJson(res, 500, { error: 'Внутренняя ошибка, подробности в окне программы' });
  }
}

if (process.argv.includes('--2fa-off')) {
  // Аварийно: бот не работает, а владелец не может войти — снять вход с кодом прямо на сервере.
  const c = (() => { try { return JSON.parse(mainStore.setting('owner_2fa', '{}')) || {}; } catch { return {}; } })();
  mainStore.setSetting('owner_2fa', JSON.stringify({ ...c, enabled: false }));
  mainStore.audit({ kind: 'change', userName: 'Сервер', action: 'Вход с кодом из Telegram отключён командой на сервере' });
  console.log('Вход с кодом из Telegram отключён. Владелец входит по паролю.');
  process.exit(0);
}
if (process.argv.includes('--demo')) {
  if (!store.isEmpty()) {
    console.log(`В базе ${DB_FILE} уже есть товары, пример не загружен.`);
  } else {
    seedDemo(store);
    console.log('Пример магазина загружен.');
  }
} else {
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Порт ${PORT} уже занят: скорее всего, программа уже запущена в другом окне. Откройте http://localhost:${PORT} в браузере.`);
    console.error(`Чтобы перезапустить, остановите её командой: pkill -f server.js. Или запустите на другом порту: PORT=3001 npm start`);
    process.exit(1);
  });
  // Медленные «висящие» подключения (атака slowloris) обрываются: заголовки — за 20 секунд.
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  server.listen(PORT, HOST, () => {
    console.log(`Программа открыта: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`База данных: ${DB_FILE}`);
    console.log(auth.enabled ? 'Вход по email и паролю включён.' : 'Вход без пароля (администратор задаётся в ADMIN_EMAIL и ADMIN_PASSWORD).');
  });
}
