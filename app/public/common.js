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
    throw new Error('Нет связи с программой. Проверьте, что её окно открыто.');
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
const KASSA_TOO = new Set(['orders', 'tasks']);

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
    document.querySelector('main')?.insertAdjacentHTML('beforebegin', '<p class="empty">У вашей роли нет доступа к разделам. Обратитесь к администратору.</p>');
    return;
  }
  const name = location.hash.slice(1);
  const target = allowed.includes(name) ? name : ownWork[0] || allowed[0];
  currentView = target;
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== target;
  // Разделы из «Ещё» подсвечивают пункт «Ещё».
  const navTarget = document.querySelector(`.nav a[href="#${target}"]`) ? target : 'more';
  for (const a of document.querySelectorAll('.nav a[href^="#"]')) a.setAttribute('aria-current', a.getAttribute('href') === '#' + navTarget ? 'page' : 'false');
  views[target].show();
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
  for (const el of document.querySelectorAll('[data-can-any]')) el.hidden = !el.dataset.canAny.split(' ').some((r) => session.can(r));
  $('#nav-user').hidden = !s.user;
  if (s.user) {
    $('#me-password').textContent = s.user.name || s.user.email;
    $('#me-password').title = `${session.roleName(s.user.role)} · сменить пароль или PIN`;
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
  location.replace('/login.html');
});

// Название магазина из раздела «Оформление».
function applyBrand(name) {
  for (const el of document.querySelectorAll('.nav .logo')) {
    if (!IS_KASSA) el.textContent = name;
    el.dataset.initial = (name.trim()[0] || 'М').toUpperCase();
  }
  document.title = IS_KASSA ? `Касса — ${name}` : name;
}

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

/* ---------- Свой пароль ---------- */
$('#me-password').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-error').hidden = true;
  $('#password-dialog').showModal();
});
$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const f = e.target.elements;
    if (!f.password.value && !f.pin.value) throw new Error('Введите новый пароль или PIN-код');
    if (f.pin.value) await api('/api/me/pin', { method: 'PUT', body: { current: f.current.value, pin: f.pin.value } });
    if (!f.password.value) {
      $('#password-dialog').close();
      return toast('PIN-код сохранён. Им можно быстро войти через «Сменить кассира»');
    }
    await api('/api/me/password', { method: 'PUT', body: { current: f.current.value, password: f.password.value } });
    // Сессия подписана старым паролем и закончилась — входим заново.
    location.replace('/login.html');
  } catch (err) {
    showFormError('#password-error', err);
  }
});
$('#password-cancel').addEventListener('click', () => $('#password-dialog').close());

