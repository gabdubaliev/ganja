'use strict';

// Главная: выручка, прибыль, хиты продаж и остатки.

const STOCK_WINDOW_DAYS = 30;
const LOW_STOCK_DAYS = 7;
const REFRESH_MS = 5 * 60_000;

const PERIODS = {
  day: { label: 'Сегодня', days: 1, bucket: 'hour', vs: 'вчера к этому часу' },
  week: { label: '7 дней', days: 7, bucket: 'day', vs: 'прошлые 7 дней' },
  month: { label: '30 дней', days: 30, bucket: 'day', vs: 'прошлые 30 дней' },
  quarter: { label: '90 дней', days: 90, bucket: 'day', vs: 'прошлые 90 дней' },
  year: { label: 'Год', days: 365, bucket: 'month', vs: 'прошлый год' },
};

// Магазин главной (владелец, несколько магазинов): '' — текущий, 'all' — все вместе, число — один магазин.
const homeShop = { v: (() => { try { return localStorage.getItem('home.shop') || ''; } catch { return ''; } })() };
const shopQ = (sep = '&') => (homeShop.v && multiShop() ? `${sep}shop=${homeShop.v}` : '');
const multiShop = () => session.isOwner && (session.branch?.allowed?.length || 0) > 1;
// Смотрим другой магазин (или все) — расходы здесь не правятся: их меняют в самом магазине.
const foreignShop = () => Boolean(homeShop.v) && multiShop() && homeShop.v !== String(session.branch?.id || 1);
const state = {
  // Главная всегда открывается на выручке за сегодня; дни листаются стрелками, свайпом и календарём.
  period: 'day',
  filter: 'all',
  sort: { key: 'profit', dir: -1 },
  query: '',
  limit: 50,
  mains: store('stockMains') === '1', // «Показать основной товар»: модификации складываются в свой товар
  data: null,
  view: null,
};
if (!PERIODS[state.period]) state.period = 'week';
// Главная — календарные периоды: день (по часам), неделя пн–вс, месяц (все дни), год (12 месяцев).
// dayOffset — сдвиг на целый период назад: −1 — вчера / прошлая неделя / прошлый месяц / прошлый год.
state.dayOffset = 0;
state.metric = 'revenue';
function homeRange(period = state.period, off = state.dayOffset) {
  const now = Date.now();
  const d = new Date(now);
  let start, full, prevStart;
  if (period === 'week') {
    const ds = dayStart(now);
    start = addDays(ds, -((ds.getDay() + 6) % 7) + 7 * off);
    full = addDays(start, 7); prevStart = addDays(start, -7);
  } else if (period === 'month') {
    start = new Date(d.getFullYear(), d.getMonth() + off, 1).getTime();
    full = new Date(d.getFullYear(), d.getMonth() + off + 1, 1).getTime();
    prevStart = new Date(d.getFullYear(), d.getMonth() + off - 1, 1).getTime();
  } else if (period === 'year') {
    start = new Date(d.getFullYear() + off, 0, 1).getTime();
    full = new Date(d.getFullYear() + off + 1, 0, 1).getTime();
    prevStart = new Date(d.getFullYear() + off - 1, 0, 1).getTime();
  } else {
    start = addDays(dayStart(now), off);
    full = addDays(start, 1); prevStart = addDays(start, -1);
  }
  const end = Math.min(now, full);
  // Сравнение — с прошлым таким же периодом на тот же момент (сегодня к этому часу — со вчера к этому часу).
  return { start, end, full, prevStart, prevEnd: Math.min(prevStart + (end - start), start) };
}
// Столбики графика: часы, дни недели, дни месяца, месяцы.
function homeBuckets(period, r) {
  const out = [];
  const add = (label, title, from) => out.push({ label, title, from, revenue: 0, cost: 0, receipts: new Set() });
  if (period === 'day') for (let h = 0; h < 24; h++) add(String(h), `${h}:00–${h + 1}:00`, r.start + h * 36e5);
  else if (period === 'week') for (let i = 0; i < 7; i++) { const t = addDays(r.start, i); add(['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][i], new Date(t).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }), t); }
  else if (period === 'month') for (let t = r.start; t < r.full; t = addDays(t, 1)) add(String(new Date(t).getDate()), new Date(t).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }), t);
  else for (let m = 0; m < 12; m++) { const y = new Date(r.start).getFullYear(); add(String(m + 1), new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''), new Date(y, m, 1).getTime()); }
  return out;
}
const viewNow = () => homeRange().end;
const VS = { day: ['вчера к этому часу', 'предыдущий день'], week: ['прошлая неделя к этому дню', 'предыдущая неделя'], month: ['прошлый месяц к этому дню', 'предыдущий месяц'], year: ['прошлый год к этому дню', 'предыдущий год'] };
const vsLabel = () => VS[state.period][state.dayOffset ? 1 : 0];
const capital = (t) => t[0].toUpperCase() + t.slice(1);
function periodTitle(period = state.period, off = state.dayOffset) {
  const r = homeRange(period, off);
  const d = new Date(r.start);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  if (period === 'week') {
    const last = new Date(addDays(r.start, 6));
    const f = (x, withMonth) => x.toLocaleDateString('ru-RU', { day: 'numeric', ...(withMonth && { month: 'long' }) });
    return `${f(d, d.getMonth() !== last.getMonth())} — ${f(last, true)}${thisYear ? '' : ` ${last.getFullYear()}`}`;
  }
  if (period === 'month') return capital(d.toLocaleDateString('ru-RU', { month: 'long', ...(!thisYear && { year: 'numeric' }) }).replace(' г.', ''));
  if (period === 'year') return String(d.getFullYear());
  const name = off === 0 ? 'Сегодня' : off === -1 ? 'Вчера' : capital(d.toLocaleDateString('ru-RU', { weekday: 'short' }));
  return `${name}, ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(!thisYear && { year: 'numeric' }) })}`;
}
const STEP_NAMES = { day: ['Предыдущий день', 'Следующий день'], week: ['Предыдущая неделя', 'Следующая неделя'], month: ['Предыдущий месяц', 'Следующий месяц'], year: ['Предыдущий год', 'Следующий год'] };
function renderDayNav() {
  let nav = document.getElementById('day-nav');
  if (!nav) {
    nav = document.createElement('div');
    nav.id = 'day-nav';
    nav.className = 'day-nav';
    $('#periods').after(nav);
    nav.addEventListener('click', (e) => {
      if (e.target.closest('[data-today]')) return setDay(0);
      const b = e.target.closest('[data-day]');
      if (b) shiftDay(Number(b.dataset.day));
      return undefined;
    });
    nav.addEventListener('change', (e) => {
      if (!e.target.matches('input[type=date]') || !e.target.value) return;
      // Выбранный день → тот период (день, неделя, месяц, год), в который он входит.
      const picked = new Date(fromDateInput(e.target.value)), now = new Date();
      const off = state.period === 'year' ? picked.getFullYear() - now.getFullYear()
        : state.period === 'month' ? (picked.getFullYear() - now.getFullYear()) * 12 + picked.getMonth() - now.getMonth()
          : state.period === 'week' ? Math.round((homeRange('week', 0).start - dayStart(picked) + ((picked.getDay() + 6) % 7) * 864e5) / -6048e5)
            : Math.round((dayStart(picked) - dayStart(Date.now())) / 864e5);
      setDay(Math.min(0, off));
    });
  }
  nav.hidden = false;
  const [prevName, nextName] = STEP_NAMES[state.period];
  nav.innerHTML = `<button type="button" class="btn small ghost" data-day="-1" aria-label="${prevName}" title="${prevName}">‹</button>
    <label class="day-pick" title="Выбрать дату"><b>${esc(periodTitle())}</b> 📅
      <input type="date" max="${dateInput(Date.now())}" value="${dateInput(homeRange().start)}" aria-label="Выбрать дату"></label>
    <button type="button" class="btn small ghost" data-day="1" aria-label="${nextName}" title="${nextName}" ${state.dayOffset >= 0 ? 'disabled' : ''}>›</button>
    ${state.dayOffset < 0 ? '<button type="button" class="btn small ghost" data-today>Сегодня</button>' : ''}`;
}
function setDay(off) {
  if (off > 0 || off === state.dayOffset) return undefined;
  state.dayOffset = off;
  state.tip = null;
  renderDayNav();
  load();
  return undefined;
}
const shiftDay = (n) => setDay(state.dayOffset + n);

/* ---------- Данные ---------- */
async function fetchData(from, to) {
  const d = await api(`/api/analytics?from=${Math.floor(from)}&to=${Math.ceil(to)}${shopQ()}`);
  // Сервер присылает продажи сжато (массивы, время — разницей): разворачиваем в обычные строки.
  if (d.sales && !Array.isArray(d.sales)) {
    const { rows, names } = d.sales;
    let t = 0;
    d.sales = rows.map((x) => { t += x[0]; return { t, r: String(x[1]), u: x[2], p: String(x[3]), n: names[x[4]], q: x[5], s: x[6], c: x[7], f: x[8] }; });
  }
  return d;
}

function compute(data, key, now, range = periodRange(key, now), buckets = buildBuckets(key, range)) {
  const stockFrom = addDays(dayStart(now), -(STOCK_WINDOW_DAYS - 1));
  const cur = { revenue: 0, cost: 0, fee: 0, items: 0, receipts: new Set() };
  const prev = { revenue: 0, cost: 0, items: 0, receipts: new Set() };
  const byId = new Map();
  const staffById = new Map();
  // Сотрудник по чеку: выручка, прибыль, чеки — за период и за прошлый такой же период.
  const person = (u) => {
    const key = u ?? 'none';
    let s = staffById.get(key);
    if (!s) {
      const info = data.staff?.[u];
      s = { id: key, name: info ? info.name : 'Без сотрудника', role: info?.role || '', revenue: 0, cost: 0, receipts: new Set(), prevRevenue: 0, prevCost: 0, prevReceipts: new Set() };
      staffById.set(key, s);
    }
    return s;
  };
  const product = (id, name) => {
    let p = byId.get(id);
    if (!p) {
      p = { id, name: name || 'Товар ' + id, category: '', stock: null, qty: 0, revenue: 0, cost: 0, prevQty: 0, prevRevenue: 0, prevCost: 0, sold30: 0 };
      byId.set(id, p);
    }
    return p;
  };
  for (const raw of data.products) Object.assign(product(raw.id, raw.name), { name: raw.name, category: raw.category, stock: raw.stock });

  for (const l of data.sales) {
    if (l.t >= stockFrom && l.t < range.end) product(l.p, l.n).sold30 += l.q;
    if (l.t >= range.start && l.t < range.end) {
      const p = product(l.p, l.n);
      p.qty += l.q; p.revenue += l.s; p.cost += l.c;
      cur.revenue += l.s; cur.cost += l.c; cur.fee += l.f || 0; cur.items += l.q; cur.receipts.add(l.r);
      const w = person(l.u);
      w.revenue += l.s; w.cost += l.c; w.receipts.add(l.r);
      const b = buckets[bucketIndex(buckets, l.t)];
      b.revenue += l.s; b.cost += l.c; b.receipts.add(l.r);
    } else if (l.t >= range.prevStart && l.t < range.prevEnd) {
      const p = product(l.p, l.n);
      p.prevQty += l.q; p.prevRevenue += l.s; p.prevCost += l.c;
      prev.revenue += l.s; prev.cost += l.c; prev.items += l.q; prev.receipts.add(l.r);
      const w = person(l.u);
      w.prevRevenue += l.s; w.prevCost += l.c; w.prevReceipts.add(l.r);
    }
  }

  const products = [...byId.values()].map((p) => {
    const profit = p.revenue - p.cost;
    const perDay = p.sold30 / STOCK_WINDOW_DAYS;
    const daysLeft = p.stock === null ? null : perDay > 0 ? p.stock / perDay : Infinity;
    let status = 'ok';
    if (p.stock !== null && p.stock <= 0) status = 'out';
    else if (daysLeft !== null && daysLeft < LOW_STOCK_DAYS) status = 'low';
    else if (p.sold30 <= 0 && p.stock > 0) status = 'idle';
    return { ...p, profit, prevProfit: p.prevRevenue - p.prevCost, margin: p.revenue > 0 ? profit / p.revenue : null, daysLeft, status };
  });

  // «Топ товаров» — по основным товарам: модификации (цвет, размер) складываются в свой товар.
  const info = new Map(data.products.map((p) => [p.id, p]));
  const tops = new Map();
  for (const p of products) {
    const meta = info.get(p.id);
    const par = meta?.parent ? { id: meta.parent, name: meta.parentName } : data.parents?.[p.id];
    const key = par ? par.id : p.id;
    let t = tops.get(key);
    if (!t) { t = { id: key, name: par ? par.name || p.name.split(' · ')[0] : p.name, qty: 0, revenue: 0, cost: 0, profit: 0, prevQty: 0, prevRevenue: 0, prevCost: 0, prevProfit: 0, variants: 0 }; tops.set(key, t); }
    for (const k of ['qty', 'revenue', 'cost', 'profit', 'prevQty', 'prevRevenue', 'prevCost', 'prevProfit']) t[k] += p[k] || 0;
    if (par) t.variants++;
  }
  // Основные товары для таблицы «Товары и остатки»: продажи, закупка и остатки модификаций — суммой.
  const mainsMap = new Map();
  for (const p of products) {
    const meta = info.get(p.id);
    const par = meta?.parent ? { id: meta.parent, name: meta.parentName } : data.parents?.[p.id];
    const key = par ? par.id : p.id;
    let m = mainsMap.get(key);
    if (!m) { m = { id: key, name: par ? par.name || p.name.split(' · ')[0] : p.name, category: meta?.parentCategory || p.category, stock: null, qty: 0, revenue: 0, cost: 0, prevQty: 0, prevRevenue: 0, prevCost: 0, sold30: 0, variants: 0 }; mainsMap.set(key, m); }
    for (const k of ['qty', 'revenue', 'cost', 'prevQty', 'prevRevenue', 'prevCost', 'sold30']) m[k] += p[k] || 0;
    if (p.stock !== null) m.stock = (m.stock || 0) + Math.max(0, p.stock);
    if (!m.category) m.category = p.category;
    if (par) m.variants++;
  }
  const mains = [...mainsMap.values()].map((p) => {
    const profit = p.revenue - p.cost;
    const perDay = p.sold30 / STOCK_WINDOW_DAYS;
    const daysLeft = p.stock === null ? null : perDay > 0 ? p.stock / perDay : Infinity;
    let status = 'ok';
    if (p.stock !== null && p.stock <= 0) status = 'out';
    else if (daysLeft !== null && daysLeft < LOW_STOCK_DAYS) status = 'low';
    else if (p.sold30 <= 0 && p.stock > 0) status = 'idle';
    return { ...p, profit, prevProfit: p.prevRevenue - p.prevCost, margin: p.revenue > 0 ? profit / p.revenue : null, daysLeft, status };
  });

  const top = [...tops.values()].map((t) => ({ ...t, margin: t.revenue > 0 ? t.profit / t.revenue : null }));

  const staff = [...staffById.values()].map((s) => ({
    ...s, profit: s.revenue - s.cost, prevProfit: s.prevRevenue - s.prevCost,
    checks: s.receipts.size, prevChecks: s.prevReceipts.size,
    avg: s.receipts.size ? s.revenue / s.receipts.size : 0, prevAvg: s.prevReceipts.size ? s.prevRevenue / s.prevReceipts.size : 0,
  }));
  return { range, buckets, cur, prev, products, mains, top, staff };
}

/* ---------- Отрисовка ---------- */
// На главной — «День», «7 дней», «30 дней» над строкой с календарём (открывается всегда на «День»).
const HOME_PERIODS = { day: 'День', week: 'Неделя', month: 'Месяц', year: 'Год' };
function renderPeriods() {
  $('#periods').hidden = false;
  $('#periods').innerHTML = Object.entries(HOME_PERIODS).map(([key, label]) =>
    `<button type="button" data-period="${key}" aria-pressed="${key === state.period}">${label}</button>`).join('');
}

// inverse — рост показателя — это плохо (себестоимость): стрелка вверх красная.
function deltaHtml(cur, prev, label, points, inverse = false) {
  if (!prev) return `<span>Нет данных за ${esc(label)}</span>`;
  if (points) {
    const diff = (cur - prev) * 100;
    const dir = diff >= 0 ? 'up' : 'down';
    return `<span class="chg ${dir} ${inverse ? 'inverse' : ''}">${ICONS[dir]}${diff >= 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.</span><span>к ${esc(label)}</span>`;
  }
  const ch = (cur - prev) / Math.abs(prev);
  const dir = ch >= 0 ? 'up' : 'down';
  return `<span class="chg ${dir} ${inverse ? 'inverse' : ''}">${ICONS[dir]}${ch >= 0 ? '+' : '−'}${pct(Math.abs(ch))}</span><span>к ${esc(label)}</span>`;
}

// Табло главной: сверху выбранный показатель за период, под ним график, внизу — показатели (нажать — график по нему).
const METRICS = [
  ['revenue', 'Выручка'], ['cost', 'Цена закупки'], ['expenses', 'Расходы'], ['net', 'Чистая прибыль'], ['avg', 'Средний чек'],
];
function boardData(v) {
  const f = state.finance;
  const c = v.cur, pr = v.prev;
  const exp = f?.cur.total || 0, prevExp = f?.prev.total || 0;
  // Расходы по столбикам: разовые — в свой час/день, зарплата и постоянные — поровну по прошедшим столбикам.
  const list = state.expenses?.list || [];
  const r = homeRange();
  for (const b of v.buckets) b.exp = 0;
  if (state.finSeries && state.period !== 'day') {
    // Неделя, месяц, год: настоящие расходы каждого дня/месяца с сервера.
    state.finSeries.forEach((x, i) => { if (v.buckets[i]) v.buckets[i].exp = x.total || 0; });
  } else {
    // День по часам: разовые — в свой час, зарплата и постоянные — поровну по часам, когда были продажи.
    const oneOff = list.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const rest = Math.max(0, exp - oneOff);
    for (const e of list) { const k = v.buckets.findLastIndex((b) => b.from <= e.at); if (k >= 0) v.buckets[k].exp += Number(e.amount) || 0; }
    const work = v.buckets.filter((b) => b.from < r.end && b.receipts.size);
    const spread = work.length ? work : v.buckets.filter((b) => b.from < r.end);
    for (const b of spread) b.exp += rest / Math.max(1, spread.length);
  }
  const checks = c.receipts.size, prevChecks = pr.receipts.size;
  const totals = {
    revenue: [c.revenue, pr.revenue], cost: [c.cost, pr.cost], expenses: [exp, prevExp],
    net: [c.revenue - c.cost - exp, pr.revenue - pr.cost - prevExp], avg: [checks ? c.revenue / checks : 0, prevChecks ? pr.revenue / prevChecks : 0],
  };
  const bar = {
    revenue: (b) => b.revenue, cost: (b) => b.cost, expenses: (b) => b.exp, net: (b) => b.revenue - b.cost - b.exp,
    avg: (b) => (b.receipts.size ? b.revenue / b.receipts.size : 0),
  };
  return { totals, bar, checks, items: c.items, hasFinance: Boolean(f) };
}
const moneyCompact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн`;
  return int(Math.round(v));
};
function renderKpis(v) {
  const el = $('#kpis');
  el.className = 'panel rev-board';
  const d = boardData(v);
  const metrics = METRICS.filter(([k]) => d.hasFinance || (k !== 'expenses' && k !== 'net'));
  if (!metrics.some(([k]) => k === state.metric)) state.metric = 'revenue';
  const [cur, prev] = d.totals[state.metric];
  const inverse = state.metric === 'cost' || state.metric === 'expenses';
  let delta = '';
  if (prev) {
    const ch = (cur - prev) / Math.abs(prev);
    const up = ch >= 0;
    delta = `<span class="rb-delta ${(up !== inverse) ? 'good' : 'bad'}" title="к: ${esc(vsLabel())}">${up ? '▲' : '▼'} ${pct(Math.abs(ch))}</span>`;
  }
  const name = METRICS.find(([k]) => k === state.metric)[1];
  const tip = state.tip != null && v.buckets[state.tip] ? v.buckets[state.tip] : null;
  const head = tip ? `${esc(capital(tip.title))}: <b class="num">${money(d.bar[state.metric](tip))}</b>` : `${esc(name)} · ${esc(periodTitle())}`;
  el.innerHTML = `
    <div class="rb-head"><span class="rb-label">${head}</span>${tip ? '' : delta}</div>
    <div class="rb-total num ${cur < 0 ? 'neg' : ''}">${money(cur)}</div>
    <div class="rb-chart" id="rb-chart"></div>
    <div class="rb-meta">${int(d.checks)} ${plural(d.checks, ['чек', 'чека', 'чеков'])}${d.checks ? ` · в среднем ${(d.items / d.checks).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} товара в чеке` : ''}${prev ? ` · сравнение: ${esc(vsLabel())}` : ''}</div>
    <div class="rb-tabs" role="tablist">${metrics.map(([k, label]) => {
      const val = d.totals[k][0];
      return `<button type="button" role="tab" data-metric="${k}" aria-selected="${k === state.metric}"><b class="num ${val < 0 ? 'neg' : ''}">${moneyCompact(val)}</b><span>${label}</span></button>`;
    }).join('')}</div>`;
  renderPanelHome(v, d);
  if (panelUi()) return renderPanelChart(v, d);
  renderBoardChart(v, d);
}
function renderBoardChart(v, d) {
  const el = $('#rb-chart');
  if (!el) return;
  let buckets = v.buckets.map((b, i) => ({ ...b, i, val: d.bar[state.metric](b) }));
  // День: только рабочие часы — от первой до последней продажи (не меньше 9:00–21:00).
  if (state.period === 'day') {
    const active = buckets.filter((b) => b.receipts.size || b.exp > 0.5);
    let lo = 9, hi = 20;
    if (active.length) { lo = Math.min(lo, Number(active[0].label)); hi = Math.max(hi, Number(active[active.length - 1].label)); }
    buckets = buckets.filter((b) => Number(b.label) >= lo && Number(b.label) <= hi);
  }
  const W = el.clientWidth || 600, H = el.clientHeight || 220;
  const m = { t: 8, r: 46, b: 22, l: 2 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const peak = Math.max(...buckets.map((b) => b.val), 1);
  const low = Math.min(0, ...buckets.map((b) => b.val));
  const step = niceStep(peak - low || 1, 4);
  const max = step * Math.ceil(peak / step), min = low < 0 ? -step * Math.ceil(-low / step) : 0;
  const y = (val) => m.t + ih - ((val - min) / (max - min || 1)) * ih;
  const band = iw / buckets.length;
  const bw = Math.max(3, Math.min(34, band * 0.62));
  const now = homeRange().end;
  const parts = [];
  for (let val = min; val <= max + 1e-6; val += step) {
    if (val === min && min === 0) continue;
    parts.push(`<text x="${W - 2}" y="${Math.round(y(val)) + 4}" text-anchor="end" class="rb-axis">${moneyShort(val)}</text>`);
  }
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 26))));
  buckets.forEach((b, k) => {
    const x = m.l + k * band + (band - bw) / 2;
    const r = bw / 2;
    // Дорожка на всю высоту (как пустой столбик), поверх — значение.
    parts.push(`<rect x="${x}" y="${m.t}" width="${bw}" height="${ih}" rx="${r}" class="rb-track ${b.from >= now ? 'future' : ''}"/>`);
    const y0 = y(0), y1 = y(b.val);
    const h = Math.abs(y1 - y0);
    if (h > 0.5) parts.push(`<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(h, Math.min(bw, 6))}" rx="${Math.min(r, h / 2 + 2)}" class="rb-bar ${b.val < 0 ? 'neg' : ''} ${state.tip === b.i ? 'on' : ''}"/>`);
    if (k % labelEvery === 0) parts.push(`<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" class="rb-axis">${esc(b.label)}</text>`);
    parts.push(`<rect x="${m.l + k * band}" y="0" width="${band}" height="${H}" fill="transparent" class="rb-hit" data-i="${b.i}"/>`);
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="График: ${esc(METRICS.find(([k]) => k === state.metric)[1])}">${parts.join('')}</svg>`;
}
// Нажатие на вкладку — график по этому показателю; на столбик — его значение сверху (ещё раз — убрать).
$('#kpis').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-metric]');
  if (tab) { state.metric = tab.dataset.metric; state.tip = null; renderKpis(state.view); return; }
  const hit = e.target.closest('.rb-hit');
  if (hit) { const i = Number(hit.dataset.i); state.tip = state.tip === i ? null : i; renderKpis(state.view); }
});

function niceStep(max, count) {
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * pow >= raw) * pow;
  return step;
}

function topRoundedRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart(v) {
  const el = $('#chart');
  const W = el.clientWidth || 800, H = el.clientHeight || 260;
  const m = { t: 10, r: 4, b: 24, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const buckets = v.buckets;
  const peak = Math.max(...buckets.map((b) => b.revenue), 1000);
  const step = niceStep(peak, 4);
  const max = step * Math.ceil(peak / step);
  const y = (val) => m.t + ih - (val / max) * ih;
  const band = iw / buckets.length;
  const bw = Math.max(2, Math.min(24, band * 0.72));
  const gap = 2;
  const parts = [];

  for (let val = 0; val <= max + 1e-6; val += step) {
    const yy = Math.round(y(val)) + 0.5;
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="${val === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`);
    parts.push(`<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${moneyShort(val)}</text>`);
  }

  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 52))));
  buckets.forEach((b, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const base = m.t + ih;
    const profit = Math.max(0, b.revenue - b.cost);
    const cost = Math.max(0, b.revenue - profit);
    const hp = (profit / max) * ih;
    const hc = (cost / max) * ih;
    if (hc > 0.5) {
      const top = hp > 0.5 ? hc - gap : hc;
      if (top > 0.5) parts.push(`<path d="${topRoundedRect(x, base - hp - hc, bw, top, 4)}" fill="var(--rest)"/>`);
    }
    if (hp > 0.5) {
      parts.push(hc > 0.5
        ? `<rect x="${x}" y="${base - hp}" width="${bw}" height="${hp}" fill="var(--series)"/>`
        : `<path d="${topRoundedRect(x, base - hp, bw, hp, 4)}" fill="var(--series)"/>`);
    }
    if (i % labelEvery === 0) {
      parts.push(`<text x="${m.l + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`);
    }
  });
  // Зоны наведения шире самих столбиков.
  buckets.forEach((b, i) => {
    parts.push(`<rect class="hit" data-i="${i}" x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ih}" rx="4"/>`);
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Выручка и прибыль по ${PERIODS[state.period].bucket === 'hour' ? 'часам' : PERIODS[state.period].bucket === 'day' ? 'дням' : 'месяцам'}">${parts.join('')}</svg>`;
  $('#chart-sub').textContent = `Высота столбика — выручка. ${PERIODS[state.period].bucket === 'hour' ? 'По часам' : PERIODS[state.period].bucket === 'day' ? 'По дням' : 'По месяцам'}, наведите, чтобы увидеть цифры.`;
}

function showTip(i, evt) {
  const b = state.view.buckets[i];
  const tip = $('#tip');
  const profit = b.revenue - b.cost;
  tip.innerHTML = `
    <div class="tt">${esc(b.title)}</div>
    <div class="tr"><span>Выручка</span><b>${money(b.revenue)}</b></div>
    <div class="tr"><span><i style="background: var(--series)"></i>Прибыль</span><b>${money(profit)}</b></div>
    <div class="tr"><span><i style="background: var(--rest)"></i>Цена закупки</span><b>${money(b.cost)}</b></div>
    <div class="tr"><span>Чеков</span><b>${int(b.receipts.size)}</b></div>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + 14, yy = evt.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
  if (yy < 8) yy = evt.clientY + 16;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = yy + 'px';
}

// Топ: rows — товары или сотрудники, key — по чему сортировать. meta(p) — доп. строка под именем.
function renderTop(el, products, key, prevKey, fmt, unit, meta = () => '') {
  const rows = products.filter((p) => p[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 8);
  if (!rows.length) { el.innerHTML = '<li class="empty" style="display:block">За этот период продаж нет</li>'; return; }
  const total = products.reduce((s, p) => s + Math.max(0, p[key]), 0);
  const prevRank = new Map(products.filter((p) => p[prevKey] > 0).sort((a, b) => b[prevKey] - a[prevKey]).map((p, i) => [p.id, i + 1]));
  el.innerHTML = rows.map((p, i) => {
    const before = prevRank.get(p.id);
    let move = '';
    if (!before) move = '<span class="move up">новый в топе</span>';
    else if (before > i + 1) move = `<span class="move up">▲ ${before - i - 1}</span>`;
    else if (before < i + 1) move = `<span class="move down">▼ ${i + 1 - before}</span>`;
    return `<li>
      <span class="rank num">${i + 1}</span>
      <div>
        <div class="row-line"><span class="name">${esc(p.name)}</span><span class="val num">${fmt(p[key])}${unit}</span></div>
        <div class="track"><div class="bar" style="width:${(p[key] / rows[0][key]) * 100}%"></div></div>
        <div class="meta"><span>${pct(p[key] / total)} от всех</span>${meta(p)}${move}</div>
      </div>
    </li>`;
  }).join('');
}

// Топ товаров и сотрудников: по чему сортировать — выбор запоминается.
const TOP_PRODUCTS = {
  revenue: ['По выручке', 'prevRevenue', money, '', 'Больше всего выручки за период'],
  qty: ['По количеству', 'prevQty', int, ' шт', 'Больше всего продано, шт.'],
  profit: ['По прибыли', 'prevProfit', money, '', 'Выручка минус цена закупки'],
};
const TOP_STAFF = {
  revenue: ['Выручка', 'prevRevenue', money, '', 'Кто больше всех продал за период'],
  checks: ['Чеки', 'prevChecks', int, ' чек.', 'Кто пробил больше всего чеков'],
  avg: ['Средний чек', 'prevAvg', money, '', 'У кого самый большой средний чек'],
};
state.topProducts = store('topProducts') in TOP_PRODUCTS ? store('topProducts') : 'revenue';
state.topStaff = store('topStaff') in TOP_STAFF ? store('topStaff') : 'revenue';

function renderTops() {
  const chips = (id, map, cur, attr) => {
    $(id).innerHTML = Object.entries(map).map(([k, [label]]) => `<button type="button" class="chip" ${attr}="${k}" aria-pressed="${k === cur}">${label}</button>`).join('');
  };
  chips('#top-products-sort', TOP_PRODUCTS, state.topProducts, 'data-top-products');
  chips('#top-staff-sort', TOP_STAFF, state.topStaff, 'data-top-staff');
  const [, pk, pf, pu, ps] = TOP_PRODUCTS[state.topProducts];
  $('#top-products-sub').textContent = ps;
  renderTop($('#top-products'), state.view.top, state.topProducts, pk, pf, pu);
  const [, sk, sf, su, ss] = TOP_STAFF[state.topStaff];
  $('#top-staff-sub').textContent = `${ss} · ${periodTitle().toLowerCase()}`;
  // Рейтинг — только сотрудники; чеки, пробитые без входа, показываем отдельной строкой.
  const people = state.view.staff.filter((w) => w.id !== 'none');
  const nobody = state.view.staff.find((w) => w.id === 'none' && w.checks);
  renderTop($('#top-staff'), people, state.topStaff, sk, sf, su, (w) => `<span>${state.topStaff === 'checks'
    ? `${money(w.revenue)} · средний ${money(w.avg)}`
    : `${int(w.checks)} ${plural(w.checks, ['чек', 'чека', 'чеков'])}${state.topStaff === 'avg' ? ` · ${money(w.revenue)}` : ` · средний ${money(w.avg)}`}`}</span>`);
  if (!people.some((w) => w[state.topStaff] > 0)) {
    $('#top-staff').innerHTML = `<li class="empty" style="display:block">${nobody ? 'Продажи за период пробиты без входа сотрудника. Чтобы видеть, кто сколько продаёт, кассиры входят в кассу под своим email.' : 'За этот период продаж нет'}</li>`;
  } else if (nobody) {
    $('#top-staff').insertAdjacentHTML('beforeend', `<li class="top-note"><span></span><span class="pick-meta">Ещё ${int(nobody.checks)} ${plural(nobody.checks, ['чек', 'чека', 'чеков'])} на ${money(nobody.revenue)} пробито без входа сотрудника</span></li>`);
  }
}

document.addEventListener('click', (e) => {
  const tp = e.target.closest('[data-top-products]');
  const ts = e.target.closest('[data-top-staff]');
  if (tp) { state.topProducts = tp.dataset.topProducts; store('topProducts', state.topProducts); renderTops(); }
  if (ts) { state.topStaff = ts.dataset.topStaff; store('topStaff', state.topStaff); renderTops(); }
});

const COLUMNS = [
  { key: 'name', label: 'Товар', dir: 1 },
  { key: 'qty', label: 'Продано, шт' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'cost', label: 'Цена закупки' },
  { key: 'profit', label: 'Прибыль' },
  { key: 'margin', label: 'Маржа' },
  { key: 'stock', label: 'Остаток, шт' },
  { key: 'daysLeft', label: 'Хватит на' },
  { key: 'status', label: 'Состояние', dir: 1 },
];

const FILTERS = [
  ['all', 'Все', () => true],
  ['out', 'Нет в наличии', (p) => p.status === 'out'],
  ['low', 'Заканчиваются', (p) => p.status === 'low'],
  ['idle', 'Не продаются', (p) => p.status === 'idle'],
];

function renderTable(v) {
  const list = state.mains ? v.mains : v.products;
  const counts = Object.fromEntries(FILTERS.map(([key, , fn]) => [key, list.filter(fn).length]));
  $('#filters').innerHTML = FILTERS.map(([key, label]) =>
    `<button type="button" class="chip" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span class="count num">${counts[key]}</span></button>`).join('');

  const { key, dir } = state.sort;
  $('#thead').innerHTML = COLUMNS.map((c) => {
    const sorted = c.key === key;
    const aria = sorted ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : '';
    return `<th${aria}><button type="button" data-sort="${c.key}">${c.label}${sorted ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  }).join('');

  const q = state.query.trim().toLowerCase();
  const filterFn = FILTERS.find(([k]) => k === state.filter)[2];
  const val = (p) => (key === 'status' ? STATUS[p.status].rank : p[key]);
  const rows = list
    .filter(filterFn)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return b.revenue - a.revenue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return typeof x === 'string' ? x.localeCompare(y, 'ru') * dir : (x - y) * dir;
    });

  const shown = rows.slice(0, state.limit);
  $('#stock-totals').innerHTML = typeof stockTotalsHtml === 'function' ? stockTotalsHtml(state.data.products) : '';
  $('#tbody').innerHTML = shown.length ? shown.map((p) => `
    <tr class="clickable" data-card="${p.id}" title="Открыть карточку товара">
      <td><div class="pname"><button type="button" class="link-name">${esc(p.name)}</button></div>${p.category || p.variants ? `<div class="pcat">${esc(p.category || '')}${p.variants ? `${p.category ? ' · ' : ''}${int(p.variants)} ${plural(p.variants, ['модификация', 'модификации', 'модификаций'])}` : ''}</div>` : ''}</td>
      <td>${int(p.qty)}</td>
      <td>${money(p.revenue)}</td>
      <td>${money(p.cost)}</td>
      <td class="${p.profit < 0 ? 'neg' : ''}">${money(p.profit)}</td>
      <td>${p.margin === null ? '—' : pct(p.margin)}</td>
      <td>${p.stock === null ? '—' : int(p.stock)}</td>
      <td>${p.daysLeft === null || p.daysLeft === Infinity || p.status === 'out' ? '—' : p.daysLeft < 1 ? 'меньше дня' : `${int(Math.floor(p.daysLeft))} ${plural(Math.floor(p.daysLeft), ['день', 'дня', 'дней'])}`}</td>
      <td><span class="status ${p.status}">${ICONS[p.status]}${STATUS[p.status].label}</span></td>
    </tr>`).join('') : `<tr><td colspan="${COLUMNS.length}" class="empty">Ничего не найдено</td></tr>`;
  $('#more').hidden = rows.length <= state.limit;
  $('#more-btn').textContent = `Показать ещё (${rows.length - state.limit})`;
}

function renderSource(error) {
  const time = new Date(state.data?.updatedAt || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('#source').className = 'source ' + (error ? 'error' : '');
  $('#source-text').textContent = error ? 'Нет связи с программой' : `Обновлено в ${time}`;

  const notice = $('#notice');
  if (error) {
    notice.className = 'notice error';
    notice.innerHTML = `<strong>Не удалось загрузить данные.</strong><span>${esc(error)}</span><span>Проверьте, что окно программы открыто. Повторю через 5 минут.</span>`;
    notice.hidden = false;
  } else if (!state.data.products.length) {
    notice.className = 'notice';
    notice.innerHTML = `<strong>Пока нет ни одного товара.</strong>
      <span>Добавьте товары в разделе «Товары» или загрузите пример магазина, чтобы посмотреть, как всё работает.</span>
      <a class="btn" href="#products">Добавить товар</a>
      <button type="button" class="btn ghost" id="load-demo">Загрузить пример</button>`;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

function renderAll() {
  if (!state.data) return;
  const r = homeRange();
  state.view = compute(state.data, state.period, r.end, r, homeBuckets(state.period, r));
  renderPeriods();
  renderDayNav();
  renderKpis(state.view);
  renderNetProfit(state.view);
  renderChart(state.view);
  renderTops();
  renderTable(state.view);
}

let loading = 0;
// Уже открытые периоды держим в памяти: при возврате к ним график показывается сразу, свежие цифры догружаются следом.
const homeCache = new Map();
const homeKey = () => `${state.period}:${state.dayOffset}:${homeShop.v}`;
function applyHome(c) {
  state.finSeries = c.finSeries; state.finance = c.finance; state.expenses = c.expenses; state.recurring = c.recurring; state.data = c.data;
  renderAll();
}
async function load() {
  const ticket = ++loading;
  const key = homeKey();
  if (homeCache.has(key)) applyHome(homeCache.get(key));
  const r = homeRange();
  const now = r.end;
  const from = Math.min(r.prevStart, addDays(dayStart(now), -(STOCK_WINDOW_DAYS - 1)));
  try {
    // Зарплата и расходы — за текущий и прошлый такой же период (для сравнения чистой прибыли).
    const fin = (a, b) => api(`/api/finance?from=${Math.floor(a)}&to=${Math.ceil(b)}${shopQ()}`);
    // Расходы и чистая прибыль — только с правом «finance».
    const f = session.can('finance');
    // Расходы по дням (неделя, месяц) и по месяцам (год) — каждый столбик считает сервер: зарплата по сменам этого дня.
    // Запрашиваются одновременно с продажами, а не после них.
    const starts = f && state.period !== 'day' ? homeBuckets(state.period, r).map((x) => x.from).filter((t) => t < r.end) : [];
    const series = starts.length ? api(`/api/finance/series?b=${[...starts, r.end].map((t) => Math.round(t)).join(',')}${shopQ()}`).catch(() => null) : null;
    const [data, cur, prev, expenses, recurring, finSeries] = await Promise.all([fetchData(from, now),
      f ? fin(r.start, now).catch(() => null) : null, f ? fin(r.prevStart, r.prevEnd).catch(() => null) : null,
      f ? api(`/api/expenses?from=${Math.floor(r.start)}&to=${Math.ceil(now)}${shopQ()}`).catch(() => null) : null,
      f ? api(`/api/recurring-expenses${shopQ('?')}`).catch(() => []) : [], series]);
    if (ticket !== loading) return;
    const c = { finSeries, finance: cur && prev ? { cur, prev } : null, expenses, recurring, data };
    homeCache.set(key, c);
    if (homeCache.size > 12) homeCache.delete(homeCache.keys().next().value);
    applyHome(c);
    renderSource(null);
  } catch (err) {
    if (ticket !== loading) return;
    renderSource(err.message);
  }
}

/* ---------- События ---------- */
$('#periods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn || btn.dataset.period === state.period) return;
  state.period = btn.dataset.period;
  state.dayOffset = 0;
  state.tip = null;
  store('period', state.period);
  renderPeriods();
  load();
});
$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  state.limit = 50;
  renderTable(state.view);
});
$('#thead').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  const col = COLUMNS.find((c) => c.key === btn.dataset.sort);
  state.sort = state.sort.key === col.key ? { key: col.key, dir: -state.sort.dir } : { key: col.key, dir: col.dir || -1 };
  renderTable(state.view);
});
$('#stock-mains').checked = state.mains;
$('#stock-mains').addEventListener('change', (e) => { state.mains = e.target.checked; store('stockMains', state.mains ? '1' : '0'); state.limit = 50; renderTable(state.view); });
$('#search').addEventListener('input', (e) => { state.query = e.target.value; state.limit = 50; renderTable(state.view); });
$('#more-btn').addEventListener('click', () => { state.limit += 50; renderTable(state.view); });

const chartEl = $('#chart');
let tipIndex = -1;
chartEl.addEventListener('mousemove', (e) => {
  const hit = e.target.closest('.hit');
  if (!hit) { $('#tip').hidden = true; tipIndex = -1; return; }
  tipIndex = Number(hit.dataset.i);
  showTip(tipIndex, e);
});
chartEl.addEventListener('mouseleave', () => { $('#tip').hidden = true; tipIndex = -1; });

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view) { renderChart(state.view); renderKpis(state.view); } }, 120); });

$('#notice').addEventListener('click', async (e) => {
  if (!e.target.closest('#load-demo')) return;
  e.target.disabled = true;
  e.target.textContent = 'Загружаю…';
  try {
    await api('/api/demo', { method: 'POST' });
    toast('Пример магазина загружен');
    load();
  } catch (err) {
    toast(err.message, 'error');
    e.target.disabled = false;
  }
});

/* ---------- Расходы и чистая прибыль: выручка − закупка − зарплата − расходы ---------- */
const npOpen = new Set(); // раскрытые строки (зарплата по сотрудникам)
function renderNetProfit(v) {
  const f = state.finance?.cur;
  $('#net-profit').hidden = !f;
  if (!f) return;
  const c = v.cur;
  const net = c.revenue - c.cost - f.total;
  const line = (label, value, cls = '', note = '', extra = '') => `<div class="np-line ${cls}"><span>${label}${note ? `<small>${note}</small>` : ''}</span><b class="num">${value}</b></div>${extra}`;
  const minus = (n) => (n ? `−${money(n)}` : money(0));
  const days = (d) => `${d} ${plural(d, ['день', 'дня', 'дней'])}`;
  $('#np-sub').textContent = `${periodTitle()}: выручка минус цена закупки, зарплата и расходы`;
  const staffOpen = npOpen.has('staff');
  const staffRows = f.staff.length ? `<div class="np-detail" ${staffOpen ? '' : 'hidden'}>${f.staff.map((w) => `
    <div class="np-detail-row"><span>${esc(w.name)}<small>${[w.shifts ? `${w.shifts} ${plural(w.shifts, ['выход', 'выхода', 'выходов'])}` : '', w.salary ? `ставка и оклад ${money(w.salary)}` : '', w.bonus ? `${w.percent ? `${int(w.percent)}% от продаж и бонусы` : 'бонусы'} ${money(w.bonus)}` : '', w.fines ? `штрафы −${money(w.fines)}` : ''].filter(Boolean).join(' · ')}</small></span><b class="num">${money(w.pay)}</b></div>`).join('')}</div>` : '';
  $('#np-lines').innerHTML = [
    line('Выручка', money(c.revenue), 'np-plus', c.fee >= 0.5 ? `уже без комиссии банков ${money(c.fee)}` : ''),
    line('Цена закупки', minus(c.cost), 'np-minus', 'проданного товара'),
    line(f.staff.length ? `<button type="button" class="np-toggle" data-np-toggle="staff" aria-expanded="${staffOpen}">Зарплата ${staffOpen ? '▴' : '▾'}</button>` : 'Зарплата', minus(f.salary), 'np-minus',
      f.staff.length ? `${f.staff.length} ${plural(f.staff.length, ['сотрудник', 'сотрудника', 'сотрудников'])}: ставка за выход, оклад, свой % от продаж` : 'ставки сотрудникам не заданы', staffRows),
    ...f.recurring.map((r) => line(esc(r.name), minus(r.amount), 'np-minus', `${money(r.monthly)} в месяц · за ${days(r.days)}`)),
    ...f.expenses.map((e) => line(esc(e.category), minus(e.amount), 'np-minus', `разовый · ${e.n} ${plural(e.n, ['запись', 'записи', 'записей'])}`)),
    f.writeoffs ? line('Списания', minus(f.writeoffs), 'np-minus', 'брак, просрочка — по себестоимости') : '',
    line('Расходы всего', minus(f.total), 'np-sub', 'зарплата + постоянные + разовые'),
    line('Чистая прибыль', `<span class="${net < 0 ? 'neg' : ''}">${money(net)}</span>`, 'np-total', c.revenue > 0 ? `${pct(net / c.revenue)} от выручки` : ''),
    // Сертификаты — справочно: деньги за них уже на счёте, в выручку они идут, когда по ним покупают товар.
    f.certificates && (f.certificates.sold || f.certificates.outstanding || f.certificates.redeemed) ? `<div class="np-cert">
      <div><span>🎁 Продано сертификатов</span><b class="num">${money(f.certificates.sold)}</b><small>${f.certificates.soldCount} шт. · деньги на счёте, в выручку пока не входят</small></div>
      <div><span>Куплено по сертификатам</span><b class="num">${money(f.certificates.redeemed)}</b><small>уже в выручке выше</small></div>
      <div><span>Не потрачено по сертификатам</span><b class="num">${money(f.certificates.outstanding)}</b><small>${f.certificates.openCount} действующих — столько товара ещё должны выдать</small></div>
    </div>` : '',
  ].join('');
  const canEdit = session.can('expenses') && !foreignShop();
  const fixed = state.recurring || [];
  $('#np-fixed').innerHTML = `<h3>Постоянные расходы</h3>${fixed.length ? `<ul class="np-items">${fixed.map((r) => {
    const dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const term = r.until ? fixedTermDays(r.since || r.created_at || Date.now(), r.until) : 0;
    const perDay = r.until ? (term ? r.amount / term : 0) : r.amount / dim;
    return `<li class="${r.active ? '' : 'np-off'}"><span class="np-date">${r.active ? '' : 'выкл.'}</span><span><b>${esc(r.name)}</b><small>${money(perDay)} в день${r.until ? '' : ' в этом месяце'}${r.since ? ` · с ${dateOnly(r.since)}` : ''}${r.until ? ` · до ${dateOnly(r.until)}${r.until <= Date.now() ? ' (закончился)' : ''}` : ''}</small></span>
      <b class="num">${money(r.amount)}${r.until ? '<small class="pcat"> за срок</small>' : ''}</b>${canEdit ? `<button type="button" class="icon-btn" data-fixed-edit="${r.id}" aria-label="Изменить" title="Изменить">✎</button>` : ''}</li>`;
  }).join('')}</ul>` : `<p class="pick-meta">${canEdit ? 'Нажмите «+ Постоянный расход» и заведите аренду, таргет и другие ежемесячные расходы — они разделятся по дням.' : 'Постоянных расходов нет.'}</p>`}`;
  const list = state.expenses?.list || [];
  $('#np-list').innerHTML = `<h3>Разовые расходы за период</h3>${list.length ? `<ul class="np-items">${list.slice(0, 30).map((e) => `
    <li><span class="np-date">${dateOnly(e.at)}</span><span><b>${esc(e.category)}</b>${e.note || e.account ? `<small>${esc([e.note, e.account ? `со счёта «${e.account}»` : ''].filter(Boolean).join(' · '))}</small>` : ''}</span>
      <b class="num">${money(e.amount)}</b>${canEdit ? `<button type="button" class="icon-btn" data-expense-del="${e.id}" aria-label="Удалить расход" title="Удалить">×</button>` : ''}</li>`).join('')}</ul>
    ${list.length > 30 ? `<p class="pick-meta">И ещё ${list.length - 30}</p>` : ''}`
    : '<p class="pick-meta">Разовых расходов за период нет.</p>'}`;
}
$('#np-lines').addEventListener('click', (e) => {
  const t = e.target.closest('[data-np-toggle]');
  if (!t) return;
  const k = t.dataset.npToggle;
  if (npOpen.has(k)) npOpen.delete(k); else npOpen.add(k);
  renderNetProfit(state.view);
});

/* ---------- Постоянные расходы: аренда, таргет… ---------- */
let fixedEditing = null;
function openFixedDialog(r = null) {
  fixedEditing = r;
  const f = $('#fixed-form');
  f.reset();
  $('#fixed-title').textContent = r ? 'Постоянный расход' : 'Новый постоянный расход';
  f.elements.name.value = r?.name || '';
  f.elements.amount.value = r ? String(r.amount).replace('.', ',') : '';
  f.elements.since.value = r?.since ? dateInput(r.since) : '';
  f.elements.until.value = r?.until ? dateInput(r.until) : '';
  f.elements.active.checked = r ? r.active : true;
  $('#fixed-delete').hidden = !r;
  $('#fixed-delete').classList.remove('danger');
  $('#fixed-delete').textContent = 'Удалить';
  $('#fixed-error').hidden = true;
  $('#ex-categories').innerHTML = (state.expenses?.categories || []).map((c) => `<option value="${esc(c)}">`).join('');
  fixedPerDay();
  $('#fixed-dialog').showModal();
  f.elements.name.focus();
}
// Дней в сроке «с … до …» (последний день не считается).
function fixedTermDays(since, until) {
  let n = 0;
  for (const d = new Date(dayStart(since)); d.getTime() < until; d.setDate(d.getDate() + 1)) n++;
  return n;
}
function fixedPerDay() {
  const f = $('#fixed-form');
  const n = parseNum(f.elements.amount.value);
  const until = f.elements.until.value ? fromDateInput(f.elements.until.value) : null;
  const since = f.elements.since.value ? fromDateInput(f.elements.since.value) : dayStart(Date.now()).getTime();
  $('#fixexp-amount-label').textContent = until ? 'Сумма за весь срок, сом' : 'Сумма в месяц, сом';
  if (!(n > 0)) { $('#fixexp-per-day').textContent = ''; return; }
  if (until) {
    const days = fixedTermDays(since, until);
    $('#fixexp-per-day').textContent = days > 0 ? `Срок ${days} ${plural(days, ['день', 'дня', 'дней'])}: ${money2(n / days)} в день, за неделю ≈ ${money(n / days * 7)}.` : 'Дата «до» должна быть позже даты «с».';
    return;
  }
  const d = new Date();
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  $('#fixexp-per-day').textContent = `В этом месяце ${dim} ${plural(dim, ['день', 'дня', 'дней'])}: ${money2(n / dim)} в день, за неделю ≈ ${money(n / dim * 7)}.`;
}
$('#fixed-form').addEventListener('input', fixedPerDay);
$('#fixed-form').addEventListener('change', fixedPerDay);
$('#np-fixed-add').addEventListener('click', () => openFixedDialog());
$('#np-fixed').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fixed-edit]');
  if (b) openFixedDialog((state.recurring || []).find((r) => r.id === Number(b.dataset.fixedEdit)));
});
$('#fixed-cancel').addEventListener('click', () => $('#fixed-dialog').close());
$('#fixed-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.elements.name.value, amount: f.elements.amount.value, since: f.elements.since.value ? fromDateInput(f.elements.since.value) : null,
    until: f.elements.until.value ? fromDateInput(f.elements.until.value) : null, active: f.elements.active.checked };
  try {
    await api(fixedEditing ? `/api/recurring-expenses/${fixedEditing.id}` : '/api/recurring-expenses', { method: fixedEditing ? 'PUT' : 'POST', body });
    $('#fixed-dialog').close();
    toast('Постоянный расход сохранён');
    load();
  } catch (err) {
    showFormError('#fixed-error', err);
  }
});
$('#fixed-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/recurring-expenses/${fixedEditing.id}`, { method: 'DELETE' });
    $('#fixed-dialog').close();
    toast('Постоянный расход удалён');
    load();
  } catch (err) {
    showFormError('#fixed-error', err);
  }
});

let expenseMethods = null;
$('#np-add').addEventListener('click', async () => {
  const f = $('#expense-form');
  f.reset();
  f.elements.date.value = dateInput(Date.now());
  $('#expense-error').hidden = true;
  $('#ex-categories').innerHTML = (state.expenses?.categories || []).map((c) => `<option value="${esc(c)}">`).join('');
  if (!expenseMethods) {
    try { expenseMethods = (await api('/api/payment-methods')).methods; } catch { expenseMethods = []; }
  }
  $('#ex-method').innerHTML = '<option value="">Не списывать со счёта</option>' + expenseMethods.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#expense-dialog').showModal();
  f.elements.category.focus();
});
$('#expense-cancel').addEventListener('click', () => $('#expense-dialog').close());
$('#expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  // Расход за сегодня — текущим временем, за прошлый день — серединой того дня.
  const day = f.elements.date.value ? fromDateInput(f.elements.date.value) : Date.now();
  const at = dayStart(Date.now()).getTime() === day ? Date.now() : day + 12 * 36e5;
  try {
    await api('/api/expenses', { method: 'POST', body: { category: f.elements.category.value, amount: f.elements.amount.value, at, method_id: f.elements.method_id.value || null, note: f.elements.note.value } });
    $('#expense-dialog').close();
    toast('Расход сохранён');
    load();
  } catch (err) {
    showFormError('#expense-error', err);
  }
});
$('#np-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-expense-del]');
  if (!del) return;
  if (!confirm('Удалить этот расход?')) return;
  try {
    await api(`/api/expenses/${del.dataset.expenseDel}`, { method: 'DELETE' });
    toast('Расход удалён');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ---------- Касса сейчас: открытые смены, наличные и безнал ---------- */
const durationText = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim();
};
const methodsText = (methods) => methods.filter((m) => m.kind !== 'cash' && m.sum).map((m) => `${esc(m.name)} ${money(m.sum)}`).join(' · ');

async function loadCashDesk() {
  let d;
  try { d = await api(`/api/cash-desk${shopQ('?')}`); } catch { return; }
  const o = d.open;
  $('#desk-sub').textContent = d.shifts.length
    ? `${d.shifts.length} ${plural(d.shifts.length, ['открытая смена', 'открытые смены', 'открытых смен'])} · ${int(o.receipts)} ${plural(o.receipts, ['чек', 'чека', 'чеков'])}`
    : 'Сейчас открытых смен нет';
  $('#desk-tiles').innerHTML = `
    <div class="desk-tile cash"><span>💵 Наличными в кассе</span><b class="num">${money(o.cash)}</b><small>за открытые смены</small></div>
    <div class="desk-tile cashless"><span>💳 Безнал</span><b class="num">${money(o.cashless)}</b><small>${methodsText(o.methods) || 'карты, банки, QR'}</small></div>
    <div class="desk-tile total"><span>Всего за смены</span><b class="num">${money(o.cash + o.cashless)}</b><small>${o.commission ? `комиссия банков −${money(o.commission)} · к зачислению ${money(o.cash + o.cashless - o.commission)}` : 'без комиссий'}</small></div>`;
  $('#desk-shifts').innerHTML = d.shifts.length ? `<table class="desk-table">
    <thead><tr><th>Кассир</th><th>Открыта</th><th>Чеков</th><th>Наличные</th><th>Безнал</th><th>Всего</th></tr></thead>
    <tbody>${d.shifts.map((sh) => {
      const cash = sh.byMethod.filter((m) => m.kind === 'cash').reduce((s, m) => s + m.sum, 0);
      const other = sh.byMethod.filter((m) => m.kind !== 'cash');
      return `<tr>
        <td><span class="live-dot" aria-hidden="true"></span><b>${esc(sh.user_name || '—')}</b>${sh.register_name ? `<div class="pcat">${esc(sh.register_name)}</div>` : ''}</td>
        <td>${new Date(sh.opened_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}<div class="pcat">${new Date(sh.opened_at).toDateString() === new Date().toDateString() ? '' : new Date(sh.opened_at).toLocaleDateString('ru-RU') + ' · '}идёт ${durationText(Date.now() - sh.opened_at)}</div></td>
        <td>${int(sh.receipts)}</td>
        <td>${money(cash)}</td>
        <td>${money(other.reduce((s, m) => s + m.sum, 0))}${other.length ? `<div class="pcat">${methodsText(other)}</div>` : ''}</td>
        <td><b>${money(sh.revenue)}</b></td>
      </tr>`;
    }).join('')}</tbody></table>` : '';
  const t = d.today;
  $('#desk-today').innerHTML = `За сегодня всего (все смены и чеки): ${int(t.receipts)} ${plural(t.receipts, ['чек', 'чека', 'чеков'])} · наличными <b>${money(t.cash)}</b> · безнал <b>${money(t.cashless)}</b>${methodsText(t.methods) ? ` (${methodsText(t.methods)})` : ''}${t.commission ? ` · комиссия −${money(t.commission)}` : ''}`;
}

/* ---------- Подробно о смене: деньги, продажи, прибыль, зарплата, куда разложить деньги ---------- */
const srView = { id: null, data: null };
const hm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dm = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const srRow = (label, value, cls = '') => `<div class="shr-row ${cls}"><span>${label}</span><b class="num">${value}</b></div>`;
async function openShiftReport(id = null) {
  let r;
  try { r = await api(`/api/shift-session${id ? `?id=${id}` : ''}`); } catch (err) { return toast(err.message, 'error'); }
  if (!r) return toast('Смен ещё не было');
  srView.id = r.id;
  srView.data = r;
  $('#shr-title').textContent = r.open ? '🟢 Смена идёт' : '🔴 Смена закрыта';
  $('#shr-sub').textContent = `${dm(r.from)} — ${r.open ? 'сейчас' : dm(r.to)} · сотрудников: ${r.people}`;
  $('#shr-prev').disabled = !r.prevId;
  $('#shr-next').disabled = !r.nextId;
  const c = r.cash, s = r.sales, f = r.finance, sp = r.split;
  const cashless = r.byMethod.filter((m) => m.kind !== 'cash');
  $('#shr-body').innerHTML = `
    <div class="shr-cards">
      <div class="shr-card"><span>💵 В кассе ${r.open ? 'сейчас' : 'по программе'}</span><b class="num">${money(c.expected)}</b><small class="pcat">на начало ${c.open === null ? '—' : money(c.open)}</small></div>
      <div class="shr-card"><span>Выручка</span><b class="num">${money(s.gross)}</b><small class="pcat">${int(s.receipts)} ${plural(s.receipts, ['чек', 'чека', 'чеков'])} · ${s.items} шт.</small></div>
      <div class="shr-card"><span>Безнал</span><b class="num">${money(cashless.reduce((a, m) => a + m.sum, 0))}</b><small class="pcat">${cashless.map((m) => esc(m.name)).join(', ') || 'нет'}</small></div>
      <div class="shr-card ${r.net >= 0 ? 'good' : 'bad'}"><span>Чистая прибыль</span><b class="num">${money(r.net)}</b><small class="pcat">после зарплаты и расходов</small></div>
    </div>
    <div class="shr-grid2">
      <section class="shr-sec"><h3>👥 Кто на смене</h3>
        ${r.staff.map((x) => srRow(`<b>${esc(x.user)}</b>${x.register ? ` · ${esc(x.register)}` : ''}<div class="pcat">открыл ${hm(x.opened)} · ${x.closed ? `закрыл ${hm(x.closed)}` : '<span class="live-dot"></span> на смене'} · ${int(x.receipts)} чек.</div>`, money(x.revenue))).join('')}
      </section>
      <section class="shr-sec"><h3>💵 Наличные в кассе</h3>
        ${srRow('На начало смены', c.open === null ? '—' : money(c.open))}
        ${c.openDiff ? srRow('Расхождение при открытии', money(c.openDiff), 'sub') : ''}
        ${srRow('+ продажи наличными', money(c.sales))}
        ${c.changeKept ? srRow('+ сдача, оставленная в кассе', money(c.changeKept)) + r.kept.map((k) => srRow(`${esc(k.note)}${k.user_name ? ` · ${esc(k.user_name)}` : ''}`, money(k.amount), 'sub')).join('') : ''}
        ${c.expenses ? srRow('− расходы из кассы', money(c.expenses)) : ''}
        ${r.cashExpenses.map((e) => srRow(`${esc(e.category)}: ${esc(e.note)}${e.user_name ? ` · ${esc(e.user_name)}` : ''} · ${hm(e.at)}`, money(e.amount), 'sub')).join('')}
        ${c.chef ? srRow('+ сдача от шефа (ваши деньги в кассе)', money(c.chef)) + r.chef.map((k) => srRow(`${esc(k.note)}${k.user_name ? ` · ${esc(k.user_name)}` : ''}`, money(k.amount), 'sub')).join('') : ''}
        ${c.ops ? srRow('± внесения и изъятия', money(c.ops)) : ''}
        ${srRow(r.open ? '= должно быть в кассе сейчас' : '= должно было быть', money(c.expected), 'total')}
        ${c.counted !== null ? srRow('Насчитано при закрытии', money(c.counted) + (c.closeDiff ? ` (${c.closeDiff < 0 ? 'недостача' : 'излишек'} ${money(Math.abs(c.closeDiff))})` : ' ✓')) + (c.deposited ? srRow('Сдано на счёт', money(c.deposited)) : '') + srRow('Оставлено в кассе', money(c.left)) : ''}
      </section>
      <section class="shr-sec"><h3>💳 Оплаты по способам</h3>
        ${r.byMethod.map((m) => srRow(`${esc(m.name)} <span class="pcat">· ${int(m.receipts)} чек.${m.commission ? ` · комиссия −${money(m.commission)}` : ''}</span>`, money(m.sum))).join('') || '<p class="pcat">Оплат не было</p>'}
        ${srRow('Всего', money(r.byMethod.reduce((a, m) => a + m.sum, 0)), 'total')}
      </section>
      <section class="shr-sec"><h3>🧾 Продажи</h3>
        ${srRow('Чеков', int(s.receipts))}${srRow('Товаров продано', `${s.items} шт.`)}${srRow('Средний чек', money(s.avg))}
        ${s.discount ? srRow('Скидки', money(s.discount)) : ''}${s.bonus ? srRow('Оплачено бонусами', money(s.bonus)) : ''}
        ${s.loyal ? srRow('Чеков с картой покупателя', int(s.loyal)) : ''}
        ${s.refunds ? srRow('Возвраты', `${s.refunds} на ${money(s.refunded)}`) : ''}${s.certificates ? srRow('Продано сертификатов', money(s.certificates)) : ''}
      </section>
      <section class="shr-sec"><h3>📈 Прибыль</h3>
        ${srRow('Выручка', money(s.gross))}${s.commission ? srRow('− комиссия банков', money(s.commission)) : ''}
        ${srRow('− себестоимость проданного', money(s.cost))}${srRow('= валовая прибыль', money(s.grossProfit), 'total')}
        ${srRow('− зарплата', money(f.salary))}
        ${f.staff.map((w) => srRow(`${esc(w.name)}${w.shifts ? ` · ${w.shifts} вых.` : ''}${w.bonus ? ` · % и бонусы ${money(w.bonus)}` : ''}${w.fines ? ` · штрафы −${money(w.fines)}` : ''}`, money(w.pay), 'sub')).join('')}
        ${f.other ? srRow('− расходы', money(f.other)) + f.expenses.map((e) => srRow(esc(e.category), money(e.amount), 'sub')).join('') : ''}
        ${f.fixed ? srRow('− постоянные расходы (доля за день)', money(f.fixed)) + f.recurring.map((e) => srRow(esc(e.name), money(e.amount), 'sub')).join('') : ''}
        ${f.writeoffs ? srRow('− списания', money(f.writeoffs)) : ''}
        ${c.changeKept ? srRow('+ сдача, оставленная покупателями', money(c.changeKept)) : ''}
        ${srRow('= Чистая прибыль', money(r.net), 'total')}
      </section>
      <section class="shr-sec"><h3>🏦 Куда разложить деньги дня</h3>
        ${srRow('Оборот — вернуть в товар (себестоимость)', money(sp.turnover))}
        ${srRow('Зарплата сотрудникам', money(sp.salary))}
        ${f.staff.length > 1 ? f.staff.map((w) => srRow(esc(w.name), money(w.pay), 'sub')).join('') : ''}
        ${sp.expenses ? srRow('Расходы (уже потрачены)', money(sp.expenses)) : ''}
        ${sp.fixed ? srRow('Отложить на постоянные расходы', money(sp.fixed)) : ''}
        ${sp.commission ? srRow('Комиссия банков (удержал банк)', money(sp.commission)) : ''}
        ${srRow('На счёт прибыли', money(sp.profit), 'total')}
        ${srRow('Итого = выручка' + (sp.changeKept ? ' + оставленная сдача' : ''), money(sp.turnover + sp.salary + sp.expenses + sp.fixed + sp.commission + sp.profit + (f.writeoffs || 0)), 'sub')}
      </section>
    </div>`;
  // Отчёт в Telegram уходит сам при закрытии смены; вручную отправить может только владелец.
  $('#shr-tg').hidden = !session.isOwner;
  if (!$('#shr-dlg').open) $('#shr-dlg').showModal();
}
$('#desk-report-btn').addEventListener('click', () => openShiftReport());
$('#desk-tiles').addEventListener('click', () => openShiftReport());
$('#desk-tiles').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openShiftReport(); } });
$('#desk-shifts').addEventListener('click', () => openShiftReport());
$('#shr-prev').addEventListener('click', () => srView.data?.prevId && openShiftReport(srView.data.prevId));
$('#shr-next').addEventListener('click', () => srView.data?.nextId && openShiftReport(srView.data.nextId));
$('#shr-close').addEventListener('click', () => $('#shr-dlg').close());
$('#shr-ok').addEventListener('click', () => $('#shr-dlg').close());
$('#shr-tg').addEventListener('click', async () => {
  try { await api('/api/shift-session/telegram', { method: 'POST', body: { id: srView.id } }); toast('Отчёт отправлен в Telegram'); } catch (err) { toast(err.message, 'error'); }
});

// Касса обновляется сама: после каждой продажи и раз в минуту.
salesFeed.listeners.push(() => { if (currentView === 'home') loadCashDesk(); });
setInterval(() => { if (currentView === 'home' && !document.hidden) loadCashDesk(); }, 60000);

// Строка таблицы «Товары и остатки» открывает карточку товара с продажами за период.
$('#tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-card]');
  if (!tr) return;
  const stats = (state.mains ? state.view.mains : state.view.products).find((p) => String(p.id) === tr.dataset.card);
  // Товары другого магазина (вид «Все магазины») — карточка открывается в своём магазине.
  if (!/^\d+$/.test(tr.dataset.card)) return toast('Карточка товара другого магазина — переключите магазин вверху', 'error');
  openProductCard(Number(tr.dataset.card), stats);
});

// Блоки главной — их порядок и видимость настраивает владелец в админ-панели.
const HOME_BLOCKS = [
  ['kpis', 'Плитки: выручка, расходы, прибыль, чеки'], ['cash-desk', 'Касса сейчас'], ['net-profit', 'Расходы и чистая прибыль'],
  ['home-chart', 'График выручки'], ['home-hits', 'Топ товаров и сотрудников'], ['home-abc', 'ABC / XYZ матрица'], ['home-stock', 'Товары и остатки'],
];
function applyHomeLayout() {
  const page = document.querySelector('main[data-view="home"]');
  const cfg = session.layout?.home || {};
  const order = [...(cfg.order || []), ...HOME_BLOCKS.map(([id]) => id).filter((id) => !(cfg.order || []).includes(id))];
  for (const id of order) {
    const el = document.getElementById(id);
    if (!el) continue;
    page.append(el);
    el.classList.toggle('layout-hidden', (cfg.hidden || []).includes(id));
  }
}
// Главная — выручка и «Касса сейчас»; «Отчёты» — расходы и чистая прибыль, топы, матрица, остатки (тот же период).
// Выбор магазина на главной и в отчётах: «Все магазины» или один (только владелец с несколькими магазинами).
function renderHomeShop() {
  const top = document.querySelector('main[data-view="home"] .home-top');
  let sel = document.getElementById('home-shop');
  if (!multiShop()) { sel?.remove(); return; }
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'home-shop';
    sel.className = 'input home-shop';
    sel.setAttribute('aria-label', 'Магазин');
    sel.addEventListener('change', () => {
      homeShop.v = sel.value;
      try { localStorage.setItem('home.shop', homeShop.v); } catch { /* без памяти */ }
      load();
      if (currentView === 'home') loadCashDesk();
    });
    // Рядом с «День, Неделя, Месяц, Год» — в одной строке.
    const per = top.querySelector('#periods');
    const row = document.createElement('div');
    row.className = 'home-pick';
    per.before(row);
    row.append(per, sel);
  }
  const cur = homeShop.v || String(session.branch?.id || 1);
  sel.innerHTML = `<option value="all" ${cur === 'all' ? 'selected' : ''}>🏬 Все магазины</option>` + session.branch.allowed.map((b) => `<option value="${b.id}" ${String(b.id) === cur ? 'selected' : ''}>🏬 ${esc(b.name)}</option>`).join('');
}
function showHome(mode) {
  renderHomeShop();
  document.querySelector('main[data-view="home"]').dataset.mode = mode;
  applyHomeLayout(); renderPeriods(); load();
  if (mode === 'home') loadCashDesk();
  if (mode === 'reports' && typeof renderHomeAbc === 'function') renderHomeAbc();
}
views.home = { show: () => showHome('home'), right: 'dashboard' };
views.reports = { show: () => showHome('reports'), right: 'dashboard' };
setInterval(() => { if (currentView === 'home' || currentView === 'reports') load(); }, REFRESH_MS);

// Свайп по главной влево/вправо — соседний день (когда выбран «Сегодня»).
(() => {
  const page = document.querySelector('[data-view="home"]');
  if (!page) return;
  let x0 = null, y0 = 0, t0 = 0;
  page.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.chart, .rb-chart, .rb-tabs, .table-wrap, table, .periods, input, select, textarea')) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  page.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - t0 > 800) return;
    shiftDay(dx > 0 ? -1 : 1); // вправо — вчера, влево — к сегодняшнему
  }, { passive: true });
})();

// Строка с днём прилипает под верхним меню — высота меню меняется (телефон/компьютер), поэтому меряем.
(() => {
  const nav = document.querySelector('.nav');
  if (!nav || !window.ResizeObserver) return;
  new ResizeObserver(() => document.documentElement.style.setProperty('--nav-h', `${nav.offsetHeight}px`)).observe(nav);
})();

/* ---------- Стиль «Панель» (компьютер): заголовок периода, три карточки, график плавными линиями ---------- */
function renderPanelHome(v, d) {
  const on = panelUi();
  let head = document.getElementById('pn-head'), cards = document.getElementById('pn-cards');
  if (!on) { head?.remove(); cards?.remove(); document.getElementById('pn-legend')?.remove(); return; }
  if (!head) {
    head = document.createElement('div');
    head.id = 'pn-head';
    $('header.home-top').before(head);
  }
  const t = periodTitle();
  const year = String(new Date(homeRange().start).getFullYear());
  const main = state.period === 'year' ? 'Год' : t.replace(new RegExp(`\\s*${year}$`), '');
  head.innerHTML = `<div class="pn-crumb"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>${currentView === 'reports' ? 'Отчёты' : 'Главная'}</div>
    <h1 class="pn-title">${esc(main)} <span>${esc(year)}</span></h1>`;
  if (!cards) {
    cards = document.createElement('section');
    cards.id = 'pn-cards';
    cards.className = 'pn-cards';
    $('#kpis').before(cards);
  }
  const ch = (a, b, inverse) => {
    if (!b) return '<b>—</b>';
    const up = a >= b;
    return `<b class="${up === Boolean(inverse) ? 'bad' : ''}">${up ? '+' : '−'}${pct(Math.abs((a - b) / Math.abs(b)))}</b>`;
  };
  const [rev, prevRev] = d.totals.revenue, [net, prevNet] = d.totals.net, [avg] = d.totals.avg;
  const pc = v.prev.receipts.size;
  const deco = `<svg class="pn-deco" viewBox="0 0 200 116" aria-hidden="true">
    <rect x="62" y="6" width="132" height="84" rx="12" fill="var(--surface-2)" stroke="var(--border)" transform="rotate(-8 128 48)"/>
    <rect x="42" y="24" width="132" height="84" rx="12" fill="var(--pn-fill)" stroke="var(--axis)" transform="rotate(-8 108 66)"/>
    <rect x="58" y="48" width="22" height="16" rx="3" fill="var(--muted)" opacity=".55" transform="rotate(-8 108 66)"/>
    <text x="112" y="94" fill="var(--muted)" font-size="9" font-family="monospace" transform="rotate(-8 108 66)">${esc((session.design?.name || 'MONT').slice(0, 14))}</text></svg>`;
  cards.innerHTML = `
    <div class="pn-card"><div class="k">Выручка · ${esc(t)}</div><div class="v num">${money(rev)}</div><div class="d">${ch(rev, prevRev)} · ${esc(vsLabel())}</div>${deco}</div>
    <div class="pn-card"><div class="k">${d.hasFinance ? 'Чистая прибыль' : 'Прибыль'}</div><div class="v num ${net < 0 ? 'neg' : ''}">${money(d.hasFinance ? net : rev - d.totals.cost[0])}</div><div class="d">${ch(net, prevNet)} · ${esc(vsLabel())}</div></div>
    <div class="pn-card"><div class="k">Чеки</div><div class="v num">${int(d.checks)}</div><div class="d">${ch(d.checks, pc)} · средний ${money(avg)}</div></div>`;
}
function renderPanelChart(v, d) {
  const el = $('#rb-chart');
  if (!el) return;
  let bk = v.buckets.map((b, i) => ({ ...b, i }));
  if (state.period === 'day') {
    const active = bk.filter((b) => b.receipts.size || b.exp > 0.5);
    let lo = 9, hi = 20;
    if (active.length) { lo = Math.min(lo, Number(active[0].label)); hi = Math.max(hi, Number(active[active.length - 1].label)); }
    bk = bk.filter((b) => Number(b.label) >= lo && Number(b.label) <= hi);
  }
  const W = el.clientWidth || 900, H = el.clientHeight || 300, m = { l: 52, r: 12, t: 12, b: 22 };
  const now = homeRange().end;
  const live = bk.filter((b) => b.from < now);
  const series = [
    ['revenue', 'Выручка', '#f5c84c', (b) => b.revenue],
    ['cost', 'Цена закупки', '#6f9bff', (b) => b.cost],
    ['net', d.hasFinance ? 'Чистая прибыль' : 'Прибыль', '#5fd3a2', (b) => d.bar.net(b)],
  ];
  const sel = ['revenue', 'cost', 'net'].includes(state.metric) ? state.metric : null;
  const down = (b) => (d.hasFinance ? b.exp || 0 : 0);
  const hasDown = live.some((b) => down(b) > 0.5);
  const max = Math.max(1, ...live.map((b) => Math.max(b.revenue, d.bar.net(b), b.cost)));
  const dmax = Math.max(1, ...live.map(down));
  const mid = m.t + (H - m.t - m.b) * (hasDown ? 0.68 : 0.93);
  const yUp = (val) => mid - (Math.max(0, val) / max) * (mid - m.t);
  const yDn = (val) => mid + (val / dmax) * (H - m.b - mid - 4);
  const x = (k) => m.l + (bk.length > 1 ? k / (bk.length - 1) : 0.5) * (W - m.l - m.r);
  const path = (pts) => pts.map((p, k) => {
    if (!k) return `M${p[0]},${p[1]}`;
    const [x0, y0] = pts[k - 1]; const cx = (x0 + p[0]) / 2;
    return `C${cx},${y0} ${cx},${p[1]} ${p[0]},${p[1]}`;
  }).join('');
  const n = Math.max(1, live.length);
  const pts = (fn, y) => bk.slice(0, n).map((b, k) => [x(k), y(fn(b))]);
  const parts = [];
  for (const k of [1, 0.75, 0.5, 0.25]) parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yUp(max * k)}" y2="${yUp(max * k)}" stroke="var(--grid)"/><text x="${m.l - 8}" y="${yUp(max * k) + 4}" text-anchor="end" class="rb-axis" font-family="monospace">${moneyShort(max * k)}</text>`);
  if (hasDown) for (const k of [0.5, 1]) parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yDn(dmax * k)}" y2="${yDn(dmax * k)}" stroke="var(--grid)"/><text x="${m.l - 8}" y="${yDn(dmax * k) + 4}" text-anchor="end" class="rb-axis" font-family="monospace">${moneyShort(dmax * k)}</text>`);
  parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${mid}" y2="${mid}" stroke="var(--axis)"/>`);
  const every = Math.max(1, Math.ceil(bk.length / Math.max(1, Math.floor((W - m.l) / 46))));
  bk.forEach((b, k) => { if (k % every === 0) parts.push(`<text x="${x(k)}" y="${hasDown ? mid + 15 : H - 4}" text-anchor="middle" class="rb-axis" font-family="monospace">${esc(b.label)}</text>`); });
  if (n >= 1) {
    for (const [key, , color, fn] of series) {
      const dim = sel && key !== sel;
      parts.push(`<path d="${path(n === 1 ? [[x(0) - 6, yUp(fn(bk[0]))], [x(0) + 6, yUp(fn(bk[0]))]] : pts(fn, yUp))}" fill="none" stroke="${color}" stroke-width="${key === sel ? 2.8 : 2}" stroke-linecap="round" opacity="${dim ? 0.35 : 1}" filter="${dim ? '' : 'url(#pn-glow)'}"/>`);
    }
    if (hasDown) [1, 0.82, 0.64].forEach((k, j) => parts.push(`<path d="${path(pts((b) => down(b) * k, yDn))}" fill="none" stroke="var(--muted)" stroke-width="1.4" opacity="${0.7 - j * 0.18}"/>`));
  }
  // Наведение/нажатие: вертикальная линия и значения сверху.
  if (state.tip != null) {
    const k = bk.findIndex((b) => b.i === state.tip);
    if (k >= 0) parts.push(`<line x1="${x(k)}" x2="${x(k)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--axis)" stroke-dasharray="3 3"/>` + series.map(([, , c, fn]) => `<circle cx="${x(k)}" cy="${yUp(fn(bk[k]))}" r="4" fill="${c}"/>`).join(''));
  }
  const band = (W - m.l - m.r) / Math.max(1, bk.length - 1);
  bk.forEach((b, k) => parts.push(`<rect x="${x(k) - band / 2}" y="0" width="${band}" height="${H}" fill="transparent" class="rb-hit" data-i="${b.i}"/>`));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="График выручки, закупки и прибыли"><defs><filter id="pn-glow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="${parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pn-glow')) || 3}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${parts.join('')}</svg>`;
  let lg = document.getElementById('pn-legend');
  if (!lg) { lg = document.createElement('div'); lg.id = 'pn-legend'; lg.className = 'pn-legend'; el.after(lg); }
  lg.innerHTML = series.map(([, name, c]) => `<span><i style="background:${c};box-shadow:0 0 8px ${c}"></i>${esc(name)}</span>`).join('') + (hasDown ? '<span><i style="background:var(--muted)"></i>Расходы — вниз от оси</span>' : '');
}
