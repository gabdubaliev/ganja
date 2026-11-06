'use strict';

const DAY = 864e5;

// Масштаб страницы не меняется: iPhone не слушает user-scalable=no, поэтому жесты «щипок» гасим сами.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.scale !== undefined && e.scale !== 1) e.preventDefault(); }, { passive: false });

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('dash.' + key);
    localStorage.setItem('dash.' + key, value);
  } catch { return null; }
}

/* ---------- Форматирование ---------- */
// Валюта — кыргызский сом. Знак пишем сами: не все браузеры знают обозначение «сом».
const CURRENCY = 'сом';
const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const money = (v) => `${moneyFmt.format(Math.round(v))} ${CURRENCY}`;
const int = (v) => intFmt.format(v);
const pct = (v) => (v * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
function moneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
  if (a >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: a >= 1e4 ? 0 : 1 }) + ' тыс';
  return String(Math.round(v));
}
function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const ICONS = {
  up: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5 10 8H2z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 9.5 2 4h8z" fill="currentColor"/></svg>',
  out: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.5 5.5 5 5m0-5-5 5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  low: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="#fff"/></svg>',
  idle: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.4 5.6v4.8m3.2-4.8v4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5 8.2 2 2 4-4.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const STATUS = {
  out: { label: 'Нет в наличии', rank: 0 },
  low: { label: 'Заканчивается', rank: 1 },
  idle: { label: 'Не продаётся', rank: 2 },
  ok: { label: 'В норме', rank: 3 },
};

/* ---------- Даты ---------- */
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

function periodRange(key, now) {
  const p = PERIODS[key];
  const start = addDays(dayStart(now), -(p.days - 1));
  return { start, end: now, prevStart: addDays(start, -p.days), prevEnd: addDays(now, -p.days) };
}

function buildBuckets(key, range) {
  const p = PERIODS[key];
  const buckets = [];
  if (p.bucket === 'hour') {
    for (let h = 0; h < 24; h++) {
      buckets.push({ label: String(h).padStart(2, '0'), title: `${h}:00–${h + 1}:00`, from: range.start + h * 36e5 });
    }
  } else if (p.bucket === 'day') {
    for (let i = 0; i < p.days; i++) {
      const d = new Date(addDays(range.start, i));
      buckets.push({
        label: p.days <= 7 ? WEEKDAYS[d.getDay()] + ' ' + d.getDate() : d.getDate() + ' ' + MONTHS[d.getMonth()],
        title: d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }),
        from: d.getTime(),
      });
    }
  } else {
    const s = new Date(range.start);
    const e = new Date(range.end);
    for (let y = s.getFullYear(), m = s.getMonth(); y < e.getFullYear() || (y === e.getFullYear() && m <= e.getMonth()); m === 11 ? (y++, m = 0) : m++) {
      buckets.push({ label: MONTHS[m], title: MONTHS_FULL[m] + ' ' + y, from: Math.max(new Date(y, m, 1).getTime(), range.start) });
    }
  }
  for (const b of buckets) Object.assign(b, { revenue: 0, cost: 0, receipts: new Set() });
  return buckets;
}

function bucketIndex(buckets, t) {
  // Корзины идут по возрастанию, ищем последнюю, начало которой <= t.
  let lo = 0, hi = buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid].from <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}


/* ---------- Деньги с копейками, количество ---------- */
// Тыйыны показываются, только когда они есть: 150 сом, но 152,50 сом.
const money2Fmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money2 = (v) => `${Number.isInteger(Math.round(v * 100) / 100) ? moneyFmt.format(v) : money2Fmt.format(v)} ${CURRENCY}`;

// Телефон для показа: +996 700 123 456 или +7 900 123-45-67.
function phoneFmt(p) {
  if (p.length === 12 && p.startsWith('996')) return `+996 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}`;
  if (p.length === 11 && p[0] === '7') return `+7 ${p.slice(1, 4)} ${p.slice(4, 7)}-${p.slice(7, 9)}-${p.slice(9)}`;
  return '+' + p;
}
const qtyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const qty = (v, unit = 'шт') => `${qtyFmt.format(v)} ${unit}`;
const parseNum = (s) => Number(String(s ?? '').replace(/\s/g, '').replace(',', '.'));

/* ---------- Кнопки «−» и «+» у поля количества (документы, приход, товар, перенос) ---------- */
// qstep(html поля) — поле с кнопками; wrapQstep(input) — то же для поля, которое уже есть на странице.
// Кнопка меняет число на 1 и сообщает программе, как будто число вписали руками (события input и change).
const qstep = (inputHtml) => `<span class="qstep"><button type="button" class="qstep-btn" data-qstep="-1" tabindex="-1" aria-label="Меньше">−</button>${inputHtml}<button type="button" class="qstep-btn" data-qstep="1" tabindex="-1" aria-label="Больше">+</button></span>`;
function wrapQstep(input) {
  if (!input || input.closest('.qstep')) return;
  const box = document.createElement('span');
  box.className = 'qstep';
  input.before(box);
  box.innerHTML = '<button type="button" class="qstep-btn" data-qstep="-1" tabindex="-1" aria-label="Меньше">−</button><button type="button" class="qstep-btn" data-qstep="1" tabindex="-1" aria-label="Больше">+</button>';
  box.firstChild.after(input);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-qstep]');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  if (!input || input.disabled || input.readOnly) return;
  const cur = input.value.trim() === '' ? 0 : parseNum(input.value) || 0;
  const n = Math.max(0, Math.round((cur + Number(b.dataset.qstep)) * 1000) / 1000);
  input.value = String(n).replace('.', ',');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
// Штрафы и бонусы сотрудника списком: дата, сумма, за что, кто выписал. showUser — с именем сотрудника.
function finesListHtml(items, { showUser = false, empty = 'Штрафов и бонусов нет' } = {}) {
  if (!items.length) return `<p class="pick-meta">${empty}</p>`;
  return `<ul class="fb-list">${items.map((f) => `<li class="fb-${f.kind}">
    <span class="fb-date">${new Date(f.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
    <span class="fb-text">${showUser ? `<b>${esc(f.user)}</b> · ` : ''}<b>${f.kind === 'bonus' ? 'Бонус' : 'Штраф'}</b>: ${esc(f.reason || '—')}<small>${f.by ? `выписал: ${esc(f.by)}` : ''}</small></span>
    <b class="fb-sum num">${f.kind === 'bonus' ? '+' : '−'}${money(f.amount)}</b>
  </li>`).join('')}</ul>`;
}
const fineTipLines = (items = []) => items.map((f) => `${f.kind === 'bonus' ? 'Бонус +' : 'Штраф −'}${money(f.amount)}: ${f.reason}${f.by ? ` (выписал: ${f.by})` : ''}`);
// ФИО: первая буква каждого слова (и после дефиса) — заглавная. Длина не меняется, поэтому курсор остаётся на месте.
const capitalizeWords = (v) => String(v).replace(/(^|[\s-])(\p{Ll})/gu, (m, sep, ch) => sep + ch.toUpperCase());
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches?.('[data-capitalize]')) return;
  const next = capitalizeWords(el.value);
  if (next === el.value) return;
  const { selectionStart: a, selectionEnd: b } = el;
  el.value = next;
  el.setSelectionRange(a, b);
});
const dateOnly = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
// Цена продажи со скидкой из карточки товара (так же считает сервер).
const salePrice = (p) => (p.discount > 0 ? Math.round(p.price * (1 - p.discount / 100) * 100) / 100 : p.price);
const dateTime = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/* ---------- Связь с сервером ---------- */
async function api(url, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Нет сети: касса по этому признаку сохраняет чек в очередь, чтобы пробить его, когда связь вернётся.
    const err = new Error(navigator.onLine === false ? 'Нет интернета' : 'Нет связи с программой. Проверьте интернет.');
    err.offline = true;
    throw err;
  }
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Нужно войти');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

// Справочник товаров, общий для кассы, прихода и списка товаров.
// Товар с модификациями (цвет, размер…) — это основной товар и его модификации с parent_id.
// Продаются и приходуют модификации, основной товар — только карточка, объединяющая их.
const catalog = {
  list: [],
  kids: new Map(),
  async load() {
    this.list = await api('/api/products');
    this.kids = new Map();
    for (const p of this.list) if (p.parent_id) this.kids.set(p.parent_id, [...(this.kids.get(p.parent_id) || []), p]);
    return this.list;
  },
  byId(id) { return this.list.find((p) => p.id === Number(id)); },
  children(id) { return this.kids.get(Number(id)) || []; },
  isGroup(p) { return this.kids.has(p.id); },
  // Остаток основного товара — сумма остатков модификаций.
  // null — остаток скрыт: у сотрудника нет права «Видеть остатки».
  stockOf(p) { if (p.stock === null) return null; return this.isGroup(p) ? this.children(p.id).reduce((s, k) => s + k.stock, 0) : p.stock; },
  // То, что можно продать или оприходовать: всё, кроме основных товаров с модификациями.
  sellable() { return this.list.filter((p) => !this.isGroup(p)); },
  search(q, limit = 8) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const list = this.sellable();
    // Штрихкод бывает общим у нескольких товаров (цвета одной модели) — возвращаем все.
    const exact = list.filter((p) => (p.barcode && p.barcode === q) || (p.code && p.code.toLowerCase() === q));
    if (exact.length) return exact;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)).slice(0, limit);
  },
};

// Свойства модификации для показа: «Красный, M».
const optionsText = (p) => (p.options ? Object.values(JSON.parse(p.options)).join(', ') : '');

/* ---------- Уведомления ---------- */
function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

function showFormError(id, err) {
  $(id).textContent = err.message;
  $(id).hidden = false;
}

// Окно кассы — отдельная страница со своими разделами.
const IS_KASSA = location.pathname.startsWith('/kassa');
// Разделы основной программы, которые есть и в окне кассы.
const KASSA_TOO = new Set(['orders', 'tasks', 'crm']);

/* ---------- Разделы ---------- */
// Каждый раздел регистрируется как views.name = { show, right }: right — право из roles.js.
const views = {};
let currentView = null;

// Скрытый владельцем раздел не открывается никому, кроме владельца.
const sectionHidden = (key) => Boolean(session.layout?.sections?.[key]?.hidden) && !session.isOwner;

// Настройки владельца в меню: скрытые разделы, свои названия.
function applyLayout() {
  const sections = session.layout?.sections || {};
  for (const a of document.querySelectorAll('.nav a[href^="#"], .nav a.nav-kassa')) {
    const key = a.classList.contains('nav-kassa') ? 'kassa' : a.getAttribute('href').slice(1);
    const s = sections[key];
    if (!s) continue;
    if (s.hidden) {
      if (session.isOwner) a.classList.add('layout-dim'); else a.classList.add('layout-hidden');
    }
    const label = a.querySelector('span:not(.badge)');
    if (s.name && label) label.textContent = s.name;
  }
}

// Владелец смотрит программу от имени сотрудника: полоса сверху и кнопка «Вернуться».
function showActingBanner(user) {
  const bar = document.createElement('div');
  bar.className = 'acting-bar';
  bar.innerHTML = `<span>👁 Вы смотрите программу как <b>${esc(user.name || user.email)}</b> (${esc(session.roleName(user.role))}) — так её видит сотрудник. Ваши действия запишутся в журнал с пометкой.</span>
    <button type="button" class="btn small">Вернуться к владельцу</button>`;
  bar.querySelector('button').addEventListener('click', async () => {
    try {
      await api('/api/act-as/stop', { method: 'POST' });
      // Полная перезагрузка: сменилось, кто вошёл.
      location.replace(`/?back=${Date.now()}#users`);
    } catch (err) { toast(err.message, 'error'); }
  });
  document.body.prepend(bar);
}

// Открыть программу от имени сотрудника (только владелец).
async function actAsUser(id, branch = null) {
  try {
    const r = await api('/api/act-as', { method: 'POST', body: { id, branch } });
    location.replace(r.kassa ? '/kassa.html' : '/');
  } catch (err) { toast(err.message, 'error'); }
}

function route() {
  const allowed = Object.keys(views).filter((name) => [views[name].right].flat().some((r) => session.can(r)) && !sectionHidden(name));
  // Если всё доступное сотруднику есть и в окне кассы (заказы), ему туда: «Ещё» не в счёт.
  const ownWork = allowed.filter((name) => name !== 'more' && (IS_KASSA || !KASSA_TOO.has(name)));
  if (!ownWork.length) {
    // Кассиру в общей программе делать нечего — его место в окне кассы.
    if (session.can('pos') && !IS_KASSA) return location.replace('/kassa.html');
    // Без кассы, но с доставкой, сделками или заданиями — работает в основной программе.
    for (const name of allowed) if (name !== 'more') ownWork.push(name);
  }
  if (!ownWork.length) {
    document.querySelector('main')?.insertAdjacentHTML('beforebegin', '<p class="empty">У вашей роли нет доступа к разделам. Обратитесь к администратору.</p>');
    return;
  }
  const name = location.hash.slice(1);
  const target = allowed.includes(name) ? name : ownWork[0] || allowed[0];
  currentView = target;
  // Главная и «Отчёты» — одна страница (общий период и данные), разный набор блоков.
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== target && el.dataset.also !== target;
  // Разделы из «Ещё» подсвечивают пункт «Ещё».
  // История продаж в окне кассы — часть «Продажи».
  const navTarget = document.querySelector(`.nav a[href="#${target}"]`) ? target : IS_KASSA && target === 'sales' ? 'pos' : 'more';
  for (const a of document.querySelectorAll('.nav a[href^="#"]')) a.setAttribute('aria-current', a.getAttribute('href') === '#' + navTarget ? 'page' : 'false');
  views[target].show();
  if (document.body.classList.contains('ui-side')) renderSideMenu();
  placeNavUser();
  applyScreenGuard();
}
addEventListener('hashchange', route);

// Кто вошёл и что ему можно. Пока сотрудников нет, программа открыта и работает как у администратора.
const session = {
  user: null, rights: new Set(), roles: {}, loyalty: { enabled: false },
  can(right) { return !right || this.rights.has(right); },
  roleName(role) { return this.roles[role]?.name || role; },
};
session.ready = api('/api/status').then((s) => {
  Object.assign(session, { user: s.user, rights: new Set(s.can), roles: s.roles, rightsList: s.rights, loyalty: s.loyalty, design: s.design, shop: s.shop, branch: s.branch,
    auth: s.auth, layout: s.layout || {} });
  // Владелец (или программа без входа) — админ-панель и скрытые разделы видны только ему.
  session.isOwner = !s.auth || s.user?.role === 'owner';
  if (session.isOwner) session.rights.add('__owner');
  applyLayout();
  if (s.user?.actingAs) showActingBanner(s.user);
  applyBrand(s.design.name);
  setOrdersBadge(s.newOrders);
  for (const el of document.querySelectorAll('[data-can]')) el.hidden = !session.can(el.dataset.can);
  // Закупка и себестоимость — только с правом на них (или на закупки, отчёты); остальным колонки и поля скрыты.
  const COST_RIGHTS = ['products.cost', 'arrivals', 'stock', 'writeoff', 'transfer', 'docs.sale', 'abc', 'finance', 'reports.stock', 'reports.money', 'kpi', 'receive.photo'];
  document.body.classList.toggle('no-cost', !COST_RIGHTS.some((r) => session.can(r)));
  for (const el of document.querySelectorAll('[data-can-any]')) el.hidden = !el.dataset.canAny.split(' ').some((r) => session.can(r));
  $('#nav-user').hidden = !s.user;
  if (s.user) {
    $('#me-password').textContent = '⚙️ Настройки';
    $('#me-password').title = `${s.user.name || s.user.email} · ${session.roleName(s.user.role)}`;
  }
  if (['notify', 'orders', 'crm', 'customers.accounts'].some((r) => session.can(r))) listenSales();
  renderBranchSwitch();
}).catch((err) => toast(err.message, 'error'));

// Магазин (филиал) в шапке: владелец переключается списком, остальные видят, в каком магазине работают.
async function renderBranchSwitch() {
  const b = session.branch;
  if (!b || b.count < 2 || !session.user) return;
  const host = $('#nav-user');
  const el = document.createElement('span');
  el.className = 'branch-switch';
  // Список — у тех, кому открыто несколько магазинов (владелец — все); остальные видят свой магазин.
  if (b.allowed?.length > 1) {
    el.innerHTML = `<select aria-label="Магазин" title="Магазин, в котором вы сейчас работаете">${b.allowed.map((x) => `<option value="${x.id}" ${x.id === b.id ? 'selected' : ''}>🏬 ${esc(x.name)}</option>`).join('')}</select>`;
    el.querySelector('select').addEventListener('change', (e) => switchBranch(Number(e.target.value)));
  } else {
    el.innerHTML = `<span class="branch-chip" title="Ваш магазин">🏬 ${esc(b.name)}</span>`;
  }
  host.prepend(el);
}

async function switchBranch(id) {
  try {
    await api('/api/branch/switch', { method: 'POST', body: { id } });
    location.hash = '';
    location.reload();
  } catch (err) { toast(err.message, 'error'); }
}
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  // Сохранённые для работы без интернета данные этого сотрудника — стираются при выходе.
  try { if (window.caches) for (const k of await caches.keys()) if (k.startsWith('kassa-')) await caches.delete(k); } catch {}
  location.replace('/login.html');
});

// Название магазина из раздела «Оформление».
function applyBrand(name) {
  for (const el of document.querySelectorAll('.nav .logo')) {
    if (!IS_KASSA) { const t = el.querySelector('.logo-text'); if (t) t.textContent = name; else el.textContent = name; }
    el.dataset.initial = (name.trim()[0] || 'М').toUpperCase();
  }
  document.title = IS_KASSA ? `Касса — ${name}` : name;
}

// Надпись логотипа — по центру картинки и в браузерах, которые не умеют text-box (старый Chrome, Samsung Internet, DeX):
// меряем высоту заглавных букв шрифта и сдвигаем надпись так, чтобы их середина совпала с серединой картинки.
function alignLogoText() {
  if (window.CSS?.supports?.('text-box', 'trim-both cap alphabetic')) return;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const t of document.querySelectorAll('.logo .logo-text')) {
    const cs = getComputedStyle(t);
    if (!parseFloat(cs.fontSize) || !t.offsetParent) continue;
    t.style.transform = '';
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const cap = ctx.measureText('НКМ').actualBoundingBoxAscent;
    if (!cap) continue;
    // Где у надписи базовая линия: невидимая точка на ней.
    const mark = document.createElement('i');
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    t.append(mark);
    const baseline = mark.getBoundingClientRect().top;
    mark.remove();
    const pic = t.parentElement.querySelector(':scope > .ui-icon') || t.parentElement;
    const r = pic.getBoundingClientRect();
    const shift = (r.top + r.bottom) / 2 - (baseline - cap / 2);
    if (Math.abs(shift) > 0.2 && Math.abs(shift) < 20) t.style.transform = `translateY(${shift.toFixed(2)}px)`;
  }
}
alignLogoText();
document.fonts?.ready.then(alignLogoText);
window.addEventListener('resize', alignLogoText);
new MutationObserver(() => alignLogoText()).observe(document.getElementById('logo-home') || document.createElement('i'), { attributes: true, attributeFilter: ['style', 'class'] });

function setOrdersBadge(n) {
  session.newOrders = n;
  for (const badge of document.querySelectorAll('#orders-badge, [data-orders-badge]')) {
    badge.hidden = !n;
    badge.textContent = n;
  }
}

/* ---------- Периоды для отчётов, смен, штрафов и журнала ---------- */
// Зарплату платят 1-го и 15-го: выплатные периоды — с 1 по 15 и с 16 по конец месяца.
function halfOf(t) {
  const d = new Date(t);
  const y = d.getFullYear(), m = d.getMonth();
  return d.getDate() <= 15
    ? [new Date(y, m, 1).getTime(), new Date(y, m, 16).getTime()]
    : [new Date(y, m, 16).getTime(), new Date(y, m + 1, 1).getTime()];
}

const halfLabel = ([from, to]) => {
  const a = new Date(from), b = new Date(to - 1);
  return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}${b.getFullYear() !== new Date().getFullYear() ? ' ' + b.getFullYear() : ''}`;
};

const RANGES = {
  today: ['Сегодня', () => { const t = dayStart(Date.now()).getTime(); return [t, addDays(t, 1)]; }],
  yesterday: ['Вчера', () => { const t = dayStart(Date.now()).getTime(); return [addDays(t, -1), t]; }],
  week: ['7 дней', () => { const t = dayStart(Date.now()).getTime(); return [addDays(t, -6), addDays(t, 1)]; }],
  half: ['Этот период', () => halfOf(Date.now())],
  prevHalf: ['Прошлый период', () => halfOf(halfOf(Date.now())[0] - 1)],
  month: ['Этот месяц', () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]; }],
  prevMonth: ['Прошлый месяц', () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()]; }],
  year: ['Год', () => { const t = dayStart(Date.now()).getTime(); return [addDays(t, -364), addDays(t, 1)]; }],
};

// Кнопки периодов. keys — какие показать. Возвращает [from, to] выбранного.
function renderRanges(el, keys, current) {
  el.innerHTML = keys.map((k) => {
    const [label, get] = RANGES[k];
    const title = k === 'half' || k === 'prevHalf' ? ` title="${halfLabel(get())}"` : '';
    return `<button type="button" data-range="${k}" aria-pressed="${k === current}"${title}>${k === 'half' || k === 'prevHalf' ? halfLabel(get()) : label}</button>`;
  }).join('');
}

const dateInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fromDateInput = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/* ---------- Уведомления о продажах ---------- */
const salesFeed = { listeners: [], orderListeners: [], leadListeners: [], codeListeners: [] };

function listenSales() {
  if (!window.EventSource) return;
  const source = new EventSource('/api/events');
  source.addEventListener('sale', (e) => {
    const sale = JSON.parse(e.data);
    // Свои продажи кассир видит и так — уведомляем только о чужих.
    if (sale.userId && sale.userId === session.user?.id) return;
    const text = `${sale.user}: чек №${sale.id} на ${money2(sale.total)}`;
    toast('🧾 ' + text);
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        new Notification('Новая продажа', { body: text, tag: 'sale-' + sale.id });
      }
    } catch { /* на некоторых телефонах уведомления из страницы запрещены */ }
    for (const fn of salesFeed.listeners) fn(sale);
  });
  source.addEventListener('code', (e) => {
    const c = JSON.parse(e.data);
    const text = `🔑 ${c.name || 'Покупатель'} (${phoneFmt(c.phone)}) просит код: ${c.purpose === 'reset' ? 'забыл пароль' : 'регистрация'}. Код — в «Покупателях».`;
    toast(text);
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Покупатель ждёт код', { body: text, tag: 'code-' + c.phone });
    } catch { /* см. выше */ }
    for (const fn of salesFeed.codeListeners) fn(c);
  });
  source.addEventListener('lead', (e) => {
    const lead = JSON.parse(e.data);
    const text = `${lead.source === 'Instagram' ? '📩 Instagram' : '🤝 CRM'}: ${lead.name || 'клиент'} — ${lead.text}`.slice(0, 160);
    toast(text);
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Новое сообщение клиента', { body: text, tag: 'lead-' + lead.id });
    } catch { /* см. выше */ }
    for (const fn of salesFeed.leadListeners) fn(lead);
  });
  source.addEventListener('order', (e) => {
    const order = JSON.parse(e.data);
    const text = `Новый заказ №${order.id} с витрины на ${money2(order.total)} — ${order.name}`;
    toast('🛒 ' + text);
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Новый заказ', { body: text, tag: 'order-' + order.id });
    } catch { /* см. выше */ }
    for (const fn of salesFeed.orderListeners) fn(order);
  });
  updateBell();
}

function updateBell() {
  const bell = $('#bell');
  if (!bell) return;
  bell.hidden = !session.can('notify') || !window.Notification;
  const on = window.Notification && Notification.permission === 'granted';
  bell.setAttribute('aria-pressed', on);
  bell.title = on ? 'Уведомления о продажах включены' : 'Включить уведомления о продажах на этом устройстве';
  bell.textContent = on ? '🔔' : '🔕';
}
$('#bell')?.addEventListener('click', async () => {
  if (Notification.permission === 'denied') return toast('Уведомления запрещены в настройках браузера для этого сайта', 'error');
  if (Notification.permission === 'default') await Notification.requestPermission();
  updateBell();
  if (Notification.permission === 'granted') toast('Уведомления о продажах включены. Они приходят, когда окно программы свёрнуто.');
});

/* ---------- Фото товаров ---------- */
const photoUrl = (p) => (p.photo_at ? `/api/products/${p.id}/photo?v=${p.photo_at}` : '');

// Сколько дополнительных фото у товаров (галерея) — для значка «+N» на миниатюре. Только у кого есть право «Фото».
let galleryCounts = {};
async function loadGalleryCounts() {
  if (!session.can('photos')) return;
  try { galleryCounts = await api('/api/products/gallery-counts'); } catch { galleryCounts = {}; }
}
const galleryBadge = (p) => (galleryCounts[p.id] ? `<span class="thumb-more" title="Ещё фото в галерее: ${galleryCounts[p.id]}">+${galleryCounts[p.id]}</span>` : '');

// Миниатюра товара с кнопками «добавить / заменить / удалить» фото.
function photoCell(p) {
  const url = photoUrl(p);
  const img = url ? `<img src="${url}" alt="" loading="lazy">` : '<span aria-hidden="true">📷</span>';
  if (!session.can('photos')) return `<span class="thumb">${img}</span>`;
  return `<span class="thumb-wrap">${galleryBadge(p)}
    <button type="button" class="thumb" data-photo="${p.id}" title="${url ? 'Заменить фото' : 'Добавить фото'}" aria-label="${url ? 'Заменить фото' : 'Добавить фото'} ${esc(p.name)}">${img}</button>
    ${url ? `<button type="button" class="thumb-del" data-photo-del="${p.id}" title="Удалить фото" aria-label="Удалить фото ${esc(p.name)}">×</button>` : ''}
  </span>`;
}

// Обработчик кликов по миниатюрам в любом списке товаров. После изменения вызывает done().
function handlePhotoClick(e, done) {
  const add = e.target.closest('[data-photo]');
  const del = e.target.closest('[data-photo-del]');
  if (add) choosePhoto(Number(add.dataset.photo)).then((saved) => saved && done());
  else if (del) removePhoto(Number(del.dataset.photoDel)).then((saved) => saved && done());
  return Boolean(add || del);
}

// Уменьшает картинку до max px по большей стороне: так база не растёт от снимков с телефона.
// PNG сохраняет прозрачность (для логотипа), JPEG легче (для фото).
function shrinkPhoto(file, max = 1000, type = 'image/jpeg') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL(type, 0.85).split(',')[1]);
    };
    img.onerror = () => reject(new Error('Не получилось открыть картинку. Выберите JPEG, PNG или WebP.'));
    img.src = URL.createObjectURL(file);
  });
}

// Выбор файла картинки (на телефоне — и камера). Возвращает File или null.
function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.click();
  });
}

// Открывает выбор файла и сохраняет фото товара.
async function choosePhoto(productId) {
  const file = await pickFile();
  if (!file) return null;
  try {
    const data = await shrinkPhoto(file);
    const saved = await api(`/api/products/${productId}/photo`, { method: 'PUT', body: { mime: 'image/jpeg', data } });
    toast('Фото сохранено');
    return saved;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function removePhoto(productId) {
  try {
    const saved = await api(`/api/products/${productId}/photo`, { method: 'DELETE' });
    toast('Фото удалено');
    return saved;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/* ---------- Профиль: имя, email, пароль, PIN и выход ---------- */
// «⚙️ Настройки» в шапке: маленькое меню — «Профиль» и «Выход».
$('#me-password').addEventListener('click', (e) => {
  e.stopPropagation();
  let m = document.getElementById('me-menu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'me-menu';
    m.className = 'me-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = '<div class="me-menu-who"></div><button type="button" role="menuitem" data-me="profile">👤 Профиль</button>'
      + (session.isOwner ? '<button type="button" role="menuitem" data-me="owner">⚙️ Админ-панель</button><button type="button" role="menuitem" data-me="ui">✏️ Изменить интерфейс</button>' : '')
      + '<button type="button" role="menuitem" data-me="logout" class="danger-text">🚪 Выход</button>';
    document.body.append(m);
    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-me]');
      if (!b) return;
      m.hidden = true;
      if (b.dataset.me === 'profile') openProfile();
      else if (b.dataset.me === 'owner') { if (document.body.classList.contains('kassa')) location.href = '/#owner'; else location.hash = '#owner'; }
      else if (b.dataset.me === 'ui') window.uiEditStart?.();
      else $('#logout').click();
    });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('#me-menu')) m.hidden = true; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') m.hidden = true; });
  }
  if (!m.hidden && m.dataset.open === '1') { m.hidden = true; m.dataset.open = ''; return; }
  const u = session.user || {};
  m.querySelector('.me-menu-who').textContent = `${u.name || u.email || ''}${session.roleName ? ' · ' + session.roleName(u.role) : ''}`;
  const r = e.currentTarget.getBoundingClientRect();
  m.hidden = false;
  // Кнопка внизу (меню слева, касса) — окошко открывается над ней, иначе уходит за край экрана.
  const below = r.bottom + 6 + m.offsetHeight <= window.innerHeight;
  m.style.top = below ? `${Math.round(r.bottom + 6)}px` : 'auto';
  m.style.bottom = below ? 'auto' : `${Math.round(window.innerHeight - r.top + 6)}px`;
  const leftSide = r.left + r.width / 2 < window.innerWidth / 2;
  m.style.left = leftSide ? `${Math.max(8, Math.round(r.left))}px` : 'auto';
  m.style.right = leftSide ? 'auto' : `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  m.dataset.open = '1';
});
function openProfile() {
  const f = $('#password-form');
  f.reset();
  $('#password-error').hidden = true;
  const u = session.user || {};
  f.elements.name.value = u.name || '';
  f.elements.email.value = u.email || '';
  $('#pf-role').textContent = [session.roleName ? session.roleName(u.role) : u.role, session.branch?.name].filter(Boolean).join(' · ');
  renderProfileTelegram();
  $('#password-dialog').showModal();
}
// «Мой Telegram»: личные уведомления сотруднику (переданные чаты и т.п.) — через бота магазина.
async function renderProfileTelegram() {
  let box = document.getElementById('pf-tg');
  if (!box) {
    box = document.createElement('div');
    box.id = 'pf-tg';
    box.className = 'pf-tg';
    $('#pf-role').after(box);
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-tg]');
      if (!b) return;
      try {
        if (b.dataset.tg === 'link') {
          const r = await api('/api/me/telegram/link', { method: 'POST', body: {} });
          window.open(r.link, '_blank');
          box.innerHTML = `<p class="sub">Откроется Telegram с ботом <b>@${esc(r.bot)}</b> — нажмите там «Start» (или «Запустить»). Потом нажмите «Проверить».</p>
            <div class="row"><a class="btn small" href="${esc(r.link)}" target="_blank" rel="noopener">Открыть Telegram ещё раз</a><button type="button" class="btn small primary" data-tg="check">Проверить</button></div>`;
        } else if (b.dataset.tg === 'check') {
          const st = await api('/api/me/telegram');
          if (!st.linked) return toast('Бот ещё не получил «Start». Откройте ссылку и нажмите «Start», потом «Проверить».', 'error');
          toast('Telegram подключён');
          renderProfileTelegram();
        } else if (b.dataset.tg === 'off') {
          if (!confirm('Отключить личные уведомления в Telegram?')) return;
          await api('/api/me/telegram', { method: 'DELETE' });
          renderProfileTelegram();
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  box.innerHTML = '<p class="sub">Telegram: проверяю…</p>';
  try {
    const st = await api('/api/me/telegram');
    box.innerHTML = st.linked
      ? `<p class="sub">📱 Мой Telegram: <b>${esc(st.who || 'подключён')}</b> — сюда приходят личные уведомления (например, когда вам передали чаты). <button type="button" class="link" data-tg="off">Отключить</button></p>`
      : st.bot ? `<p class="sub">📱 Подключите свой Telegram — будут приходить личные уведомления (например, когда вам передали чаты с клиентами).</p><button type="button" class="btn small" data-tg="link">Подключить мой Telegram</button>`
        : '<p class="sub">📱 Личные уведомления в Telegram станут доступны, когда владелец подключит бота магазина.</p>';
  } catch { box.innerHTML = ''; }
}
$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const f = e.target.elements;
    const u = session.user || {};
    const profileChanged = f.name.value.trim() !== (u.name || '') || f.email.value.trim().toLowerCase() !== String(u.email || '').toLowerCase();
    if (!profileChanged && !f.password.value && !f.pin.value) throw new Error('Ничего не изменено');
    if (!f.current.value) throw new Error('Введите текущий пароль — без него изменения не сохраняются');
    if (profileChanged) {
      const saved = await api('/api/me/profile', { method: 'PUT', body: { current: f.current.value, name: f.name.value, email: f.email.value } });
      Object.assign(session.user, { name: saved.name, email: saved.email });
      $('#me-password').textContent = saved.name || saved.email;
    }
    if (f.pin.value) await api('/api/me/pin', { method: 'PUT', body: { current: f.current.value, pin: f.pin.value } });
    if (f.password.value) {
      await api('/api/me/password', { method: 'PUT', body: { current: f.current.value, password: f.password.value } });
      // Сессия подписана старым паролем и закончилась — входим заново.
      return location.replace('/login.html');
    }
    $('#password-dialog').close();
    toast(['Профиль сохранён', f.pin.value ? 'PIN-код сохранён — им можно быстро войти через «Сменить кассира»' : ''].filter(Boolean).join('. '));
  } catch (err) {
    showFormError('#password-error', err);
  }
});
// Логотип: на главную (в кассе — к продаже) и обновить страницу.
$('#logo-home')?.addEventListener('click', (e) => {
  e.preventDefault();
  const home = document.body.classList.contains('kassa') ? '#pos' : session.can?.('dashboard') ? '#home' : '';
  if (location.hash === home || (!home && !location.hash)) return location.reload();
  location.hash = home;
  location.reload();
});
// Кнопка «Главная» в меню (и в нижней панели на телефоне) — как логотип: на главную и обновить страницу.
document.querySelector('.nav-main a[href="#home"]')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (location.hash !== '#home') location.hash = 'home';
  location.reload();
});
$('#password-cancel').addEventListener('click', () => $('#password-dialog').close());


// Поля количества, которые уже есть на странице: «Сейчас на складе» в карточке товара и «Сколько на самом деле».
for (const id of ['pf-stock', 'sf-stock']) wrapQstep(document.getElementById(id));

/* ---------- USB-сканер штрихкодов: находит товар, куда бы ни стоял курсор ---------- */
// Сканер — это «клавиатура», которая очень быстро печатает код и жмёт Enter туда, где курсор.
// Отличаем его от человека по скорости: символы идут чаще, чем раз в 50 мс. Тогда код отправляется
// туда, где он нужен на этой странице (касса — в чек, документ — в документ, товары — карточка),
// а из случайного поля, куда сканер успел напечатать, напечатанное убирается.
// Поля в открытых окнах (сертификат, карта клиента, оплата) не трогаем: туда сканируют нарочно.
const SCAN_GAP = 50;
let scanBuf = { chars: '', first: 0, last: 0, target: null, before: null };
function barcodeRoute() {
  const kassa = document.body.classList.contains('kassa');
  if (kassa) return { input: 'pos-search', view: 'pos' };
  if (currentView === 'doc') return { input: 'doc-search', view: 'doc' };
  if (currentView === 'products' || currentView === 'home' || currentView === 'reports') return { products: true };
  return null;
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  const t = e.target;
  if (e.key.length === 1) {
    if (now - scanBuf.last > SCAN_GAP) {
      // Новая серия символов: запоминаем, где был курсор и что было в поле.
      scanBuf = { chars: '', first: now, last: now, target: t, before: t && 'value' in t ? t.value : null };
    }
    scanBuf.chars += e.key;
    scanBuf.last = now;
    return;
  }
  if (e.key !== 'Enter') return;
  const b = scanBuf;
  scanBuf = { chars: '', first: 0, last: 0, target: null, before: null };
  const fast = b.chars.length >= 4 && now - b.last < SCAN_GAP * 2 && (b.last - b.first) / Math.max(1, b.chars.length - 1) < SCAN_GAP;
  if (!fast) return;
  if (t?.closest?.('dialog[open], .scan-overlay, #ui-pane')) return; // окно ждёт этот код само
  const route = barcodeRoute();
  if (!route) return;
  const code = b.chars.trim();
  // Уже в нужном поле — пусть работает как обычно (Enter в поиске).
  if (route.input && t?.id === route.input) return;
  e.preventDefault();
  e.stopPropagation();
  // Сканер напечатал код в другое поле — возвращаем то, что там было.
  if (b.target && b.before !== null && b.target.value !== b.before && b.target.id !== route.input) {
    b.target.value = b.before;
    b.target.dispatchEvent(new Event('input', { bubbles: true }));
    // «change» — чтобы программа запомнила то, что человек вписал в это поле до скана (комментарий и т.п.).
    b.target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (route.products) {
    if (typeof productByScan === 'function') productByScan(code);
    return;
  }
  const go = () => {
    const input = document.getElementById(route.input);
    if (!input) return;
    input.value = code;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  if (currentView !== route.view) { location.hash = route.view; setTimeout(go, 300); } else go();
}, true);


/* ---------- Защита разделов с цифрами от снимков экрана (сотрудники без права «Скриншоты») ---------- */
// Сайт не может запретить снимок экрана — это умеют только приложения. Поэтому: водяной знак с именем и временем
// (по снимку видно, кто снял), цифры размываются, когда окно не в фокусе, копирование выключено,
// PrintScreen на компьютере прячет экран и сообщает владельцу.
const GUARD_VIEWS = new Set(['home', 'sales', 'money', 'kpi', 'stockreport', 'deadstock', 'sizes', 'abc', 'accounts', 'shifts', 'timesheet', 'mytimesheet', 'certificates', 'loyalty', 'bonuses', 'fines', 'owner', 'audit']);
const screenGuardOn = () => session.user && !session.isOwner && !session.can('screenshots') && GUARD_VIEWS.has(currentView);
let guardTimer = null;
function guardMark() {
  let m = document.getElementById('screen-guard');
  if (!m) {
    m = document.createElement('div');
    m.id = 'screen-guard';
    m.setAttribute('aria-hidden', 'true');
    document.body.append(m);
  }
  const who = (session.user?.name || session.user?.email || 'Сотрудник').replace(/[<>&"']/g, '');
  const when = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const text = `${who} · ${when}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><text x="10" y="110" transform="rotate(-24 160 90)" font-family="sans-serif" font-size="15" fill="rgba(120,120,135,0.16)">${text}</text></svg>`;
  m.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}
function applyScreenGuard() {
  const on = Boolean(screenGuardOn());
  document.body.classList.toggle('screen-guard', on);
  clearInterval(guardTimer);
  if (on) { guardMark(); guardTimer = setInterval(guardMark, 60_000); }
  else document.body.classList.remove('guard-hide');
}
session.ready?.then?.(() => applyScreenGuard());
const guardHide = (on) => { if (document.body.classList.contains('screen-guard')) document.body.classList.toggle('guard-hide', on); };
addEventListener('blur', () => guardHide(true));
addEventListener('focus', () => guardHide(false));
document.addEventListener('visibilitychange', () => guardHide(document.hidden));
const guardReport = (how) => { api('/api/security/screenshot', { method: 'POST', body: { view: currentView, how } }).catch(() => {}); };
addEventListener('keyup', (e) => {
  if (!document.body.classList.contains('screen-guard')) return;
  if (e.key === 'PrintScreen' || (e.shiftKey && e.metaKey && ['s', 'S', '3', '4', '5'].includes(e.key))) {
    guardHide(true);
    navigator.clipboard?.writeText(' ').catch(() => {}); // убрать снимок из буфера, если браузер разрешит
    toast('Снимки экрана в этом разделе запрещены — владелец получит уведомление', 'error');
    guardReport(e.key === 'PrintScreen' ? 'PrintScreen' : 'Cmd+Shift');
    setTimeout(() => guardHide(false), 1500);
  }
});
document.addEventListener('copy', (e) => { if (document.body.classList.contains('screen-guard') && !e.target.closest?.('input, textarea')) { e.preventDefault(); toast('Копирование цифр в этом разделе запрещено', 'error'); } });
document.addEventListener('contextmenu', (e) => { if (document.body.classList.contains('screen-guard') && !e.target.closest('input, textarea')) e.preventDefault(); });

/* ---------- Стиль «Панель» (только компьютер): поиск и категории в боковом меню ---------- */
const panelUi = () => /^panel-/.test(session.design?.ui || '') && matchMedia('(min-width: 1100px)').matches;
// Меню слева (поиск и категории) — в «Как у Apple» и «Панели», только на компьютере.
const sideUi = () => /^(ios|panel-)/.test(session.design?.ui || 'ios') && matchMedia('(min-width: 1100px)').matches;
function panelSidebar() {
  const nav = document.querySelector('.nav-inner');
  document.body.classList.toggle('ui-panel', panelUi());
  document.body.classList.toggle('ui-side', sideUi());
  placeNavUser();
  if (!nav || !sideUi()) return;
  renderSideMenu();
  const kassa = document.body.classList.contains('kassa');
  if (!document.querySelector('.pn-search')) {
    const box = document.createElement('label');
    box.className = 'pn-search';
    box.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" placeholder="Поиск товара" aria-label="Поиск товара"><kbd>${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd>`;
    nav.querySelector('.logo').after(box);
    const lab = document.createElement('div');
    lab.className = 'pn-label';
    lab.textContent = 'Разделы';
    box.after(lab);
    const input = box.querySelector('input');
    // Пишут в поиске меню — ищем в товарах (в кассе — в подборе товара для чека).
    input.addEventListener('input', () => {
      const q = input.value;
      if (kassa) {
        if (location.hash !== '#pos') location.hash = 'pos';
        const t = document.getElementById('pos-search');
        if (t) { t.value = q; t.dispatchEvent(new Event('input', { bubbles: true })); }
        return;
      }
      if (location.hash !== '#products') location.hash = 'products';
      setTimeout(() => { const t = document.getElementById('products-search'); if (t) { t.value = q; t.dispatchEvent(new Event('input', { bubbles: true })); } }, location.hash === '#products' ? 0 : 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && kassa) { e.preventDefault(); document.getElementById('pos-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); input.value = ''; }
      if (e.key === 'Escape') input.blur();
    });
    addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && sideUi()) { e.preventDefault(); input.focus(); input.select(); } });
  }
}
/* ---------- Меню слева (компьютер): все разделы по порядку, с группами ---------- */
// [раздел, название, значок] или [null, группа, значок, [[раздел, название], …]]. Пункт виден, если у сотрудника есть право на раздел.
const SIDE_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  kassa: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V4h10v3M7 12h4M7 16h2M15 12h2M15 16h2"/>',
  receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  move: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6"/>',
  shop: '<path d="M4 9h16l-1 11H5zM8 9V7a4 4 0 0 1 8 0v2"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h12l2-8H6"/>',
  deal: '<path d="m11 17 2 2a1 1 0 0 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 0 0 3-3l-3.9-3.9a3 3 0 0 0-4.2 0l-.9.9a1 1 0 0 1-3-3l2.8-2.8a5 5 0 0 1 5.9-.8l.5.3a2 2 0 0 0 1.4.2L21 4M3 4l1 9 5 5"/>',
  docs: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  company: '<path d="M3 21h18M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M15 9h3a1 1 0 0 1 1 1v11M8 8h2M8 12h2M8 16h2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  more: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
};
const SIDE_MENU = [
  ['home', 'Главная', 'home'],
  ['products', 'Товары', 'box'],
  [null, 'Касса и смены', 'kassa', [['kassa', 'Открыть кассу'], ['shifts', 'Смены'], ['registers', 'Кассы']]],
  ['sales', 'Журнал продаж', 'receipt'],
  ['cashflow', 'Движение денег', 'money'],
  ['goods', 'Движение товара', 'move'],
  ['reports', 'Отчёты', 'chart'],
  [null, 'Контрагенты', 'people', [['suppliers', 'Поставщики'], ['loyalty', 'Клиенты']]],
  ['shop', 'Интернет-витрина', 'shop'],
  ['orders', 'Заказы с витрины', 'cart'],
  ['crm', 'CRM — сделки', 'deal'],
  [null, 'Все отчёты', 'docs', [['money', 'ДДС и прибыль'], ['kpi', 'Зарплата и продавцы'], ['stockreport', 'Товарный отчёт'], ['deadstock', 'Неликвиды'], ['sizes', 'Заканчиваются размеры'], ['abc', 'ABC / XYZ анализ']]],
  [null, 'Компания', 'company', [['settings', 'Настройки компании'], ['users', 'Сотрудники'], ['branches', 'Магазины'], ['loyaltyset', 'Лояльность'], ['accounts', 'Счета']]],
  ['timesheet', 'Табель', 'calendar'],
  ['access', 'Права и доступ', 'lock'],
  ['audit', 'Журнал событий', 'shield'],
  ['more', 'Ещё', 'more'],
];
// Разделы, которые есть в меню слева, — в «Ещё» их не показываем (на компьютере).
const SIDE_KEYS = new Set(SIDE_MENU.flatMap(([k, , , sub]) => (sub ? sub.map(([x]) => x) : [k])).filter((k) => k && k !== 'more'));
const sideOk = (key) => {
  if (key === 'kassa') return session.can('pos') && !sectionHidden('kassa');
  const v = views[key];
  return Boolean(v) && (v.right === null || v.right === '' || [v.right].flat().some((r) => session.can(r))) && !sectionHidden(key);
};
let sideOpen = (() => { try { return new Set(JSON.parse(localStorage.getItem('nav.open') || '[]')); } catch { return new Set(); } })();
function renderSideMenu() {
  const nav = document.querySelector('.nav-inner');
  if (!nav || document.body.classList.contains('kassa')) return;
  let box = document.querySelector('.nav-side');
  if (!box) {
    box = document.createElement('div');
    box.className = 'nav-side';
    document.querySelector('.nav-main').after(box);
    box.addEventListener('click', (e) => {
      const g = e.target.closest('[data-side-group]');
      if (!g) return;
      const name = g.dataset.sideGroup;
      if (sideOpen.has(name)) sideOpen.delete(name); else sideOpen.add(name);
      try { localStorage.setItem('nav.open', JSON.stringify([...sideOpen])); } catch { /* без памяти */ }
      renderSideMenu();
    });
  }
  const svg = (i) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SIDE_ICONS[i] || ''}</svg>`;
  const link = (key, label, icon, sub) => {
    const cur = currentView === key;
    const href = key === 'kassa' ? '/kassa.html" target="_blank' : `#${key}`;
    const badge = key === 'orders' ? ' <span class="badge" data-orders-badge hidden></span>' : '';
    return `<a href="${href}" class="${sub ? 'side-sub' : ''}" ${cur ? 'aria-current="page"' : ''}>${icon ? svg(icon) : ''}<span>${esc(label)}</span>${badge}</a>`;
  };
  box.innerHTML = SIDE_MENU.map(([key, label, icon, sub]) => {
    if (!sub) return sideOk(key) ? link(key, label, icon) : '';
    const items = sub.filter(([k]) => sideOk(k));
    if (!items.length) return '';
    const open = sideOpen.has(label) || items.some(([k]) => k === currentView);
    return `<button type="button" class="side-group" data-side-group="${esc(label)}" aria-expanded="${open}">${svg(icon)}<span>${esc(label)}</span><i aria-hidden="true">${open ? '▾' : '▸'}</i></button>`
      + (open ? `<div class="side-items">${items.map(([k, l]) => link(k, l, null, true)).join('')}</div>` : '');
  }).join('');
  if (typeof setOrdersBadge === 'function' && session.newOrders !== undefined) setOrdersBadge(session.newOrders);
}

// Меню слева: «Настройки» и выбор магазина на главной и в отчётах — справа от «День, Неделя, Месяц, Год».
function placeNavUser() {
  const u = document.getElementById('nav-user');
  if (!u) return;
  const top = document.querySelector('main:not([hidden]) .home-top');
  const want = document.body.classList.contains('ui-side') && top ? top : document.querySelector('.nav-inner');
  if (want && u.parentElement !== want) want.append(u);
}
session.ready?.then?.(() => panelSidebar());
matchMedia('(min-width: 1100px)').addEventListener?.('change', () => { panelSidebar(); if (typeof renderAll === 'function' && typeof state !== 'undefined' && state.data) renderAll(); });
