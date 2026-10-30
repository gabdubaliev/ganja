'use strict';

const DAY = 864e5;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('dash.' + key);
    localStorage.setItem('dash.' + key, value);
  } catch { return null; }
}

/* ---------- Форматирование ---------- */
const moneyFmt = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const money = (v) => moneyFmt.format(Math.round(v));
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
const money2Fmt = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money2 = (v) => money2Fmt.format(v);
const qtyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const qty = (v, unit = 'шт') => `${qtyFmt.format(v)} ${unit}`;
const parseNum = (s) => Number(String(s ?? '').replace(/\s/g, '').replace(',', '.'));
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
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

// Справочник товаров, общий для кассы, прихода и списка товаров.
const catalog = {
  list: [],
  async load() {
    this.list = await api('/api/products');
    return this.list;
  },
  byId(id) { return this.list.find((p) => p.id === Number(id)); },
  search(q, limit = 8) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    // Штрихкод бывает общим у нескольких товаров (цвета одной модели) — возвращаем все.
    const exact = this.list.filter((p) => (p.barcode && p.barcode === q) || (p.code && p.code.toLowerCase() === q));
    if (exact.length) return exact;
    return this.list.filter((p) => p.name.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)).slice(0, limit);
  },
};

/* ---------- Уведомления ---------- */
function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

/* ---------- Разделы ---------- */
const views = {};
let currentView = null;

// Разделы, открытые продавцу. Остальные видит только администратор.
const SELLER_VIEWS = new Set(['pos', 'sales']);

function route() {
  const home = session.isAdmin ? 'home' : 'pos';
  const name = location.hash.slice(1) || home;
  const target = views[name] && (session.isAdmin || SELLER_VIEWS.has(name)) ? name : home;
  currentView = target;
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== target;
  for (const a of document.querySelectorAll('.nav a')) a.setAttribute('aria-current', a.getAttribute('href') === '#' + target ? 'page' : 'false');
  views[target].show();
}
addEventListener('hashchange', route);

// Кто вошёл. Пока сотрудников нет, программа открыта и работает как у администратора.
const ROLE_NAMES = { admin: 'Администратор', seller: 'Продавец' };
const session = { user: null, isAdmin: true };
session.ready = api('/api/status').then((s) => {
  session.user = s.user;
  session.isAdmin = !s.user || s.user.role === 'admin';
  document.body.dataset.role = session.isAdmin ? 'admin' : 'seller';
  $('#nav-user').hidden = !s.user;
  if (s.user) {
    $('#me-password').textContent = s.user.name || s.user.email;
    $('#me-password').title = `${ROLE_NAMES[s.user.role]} · сменить пароль`;
  }
}).catch((err) => toast(err.message, 'error'));
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
});
