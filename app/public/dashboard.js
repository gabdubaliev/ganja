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

const state = {
  period: store('period') || 'week',
  filter: 'all',
  sort: { key: 'profit', dir: -1 },
  query: '',
  limit: 50,
  data: null,
  view: null,
};
if (!PERIODS[state.period]) state.period = 'week';

/* ---------- Данные ---------- */
function fetchData(from, to) {
  return api(`/api/analytics?from=${Math.floor(from)}&to=${Math.ceil(to)}`);
}

function compute(data, key, now) {
  const range = periodRange(key, now);
  const stockFrom = addDays(dayStart(now), -(STOCK_WINDOW_DAYS - 1));
  const buckets = buildBuckets(key, range);
  const cur = { revenue: 0, cost: 0, fee: 0, receipts: new Set() };
  const prev = { revenue: 0, cost: 0, receipts: new Set() };
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
      cur.revenue += l.s; cur.cost += l.c; cur.fee += l.f || 0; cur.receipts.add(l.r);
      const w = person(l.u);
      w.revenue += l.s; w.cost += l.c; w.receipts.add(l.r);
      const b = buckets[bucketIndex(buckets, l.t)];
      b.revenue += l.s; b.cost += l.c; b.receipts.add(l.r);
    } else if (l.t >= range.prevStart && l.t < range.prevEnd) {
      const p = product(l.p, l.n);
      p.prevQty += l.q; p.prevRevenue += l.s; p.prevCost += l.c;
      prev.revenue += l.s; prev.cost += l.c; prev.receipts.add(l.r);
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

  const staff = [...staffById.values()].map((s) => ({
    ...s, profit: s.revenue - s.cost, prevProfit: s.prevRevenue - s.prevCost,
    checks: s.receipts.size, prevChecks: s.prevReceipts.size,
    avg: s.receipts.size ? s.revenue / s.receipts.size : 0, prevAvg: s.prevReceipts.size ? s.prevRevenue / s.prevReceipts.size : 0,
  }));
  return { range, buckets, cur, prev, products, staff };
}

/* ---------- Отрисовка ---------- */
function renderPeriods() {
  $('#periods').innerHTML = Object.entries(PERIODS).map(([key, p]) =>
    `<button type="button" data-period="${key}" aria-pressed="${key === state.period}">${p.label}</button>`).join('');
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

function renderKpis(v) {
  const p = PERIODS[state.period];
  const c = v.cur, pr = v.prev;
  const f = state.finance;
  const net = (x, fin) => x.revenue - x.cost - (fin?.total || 0);
  const tiles = [
    // Выручка уже за вычетом комиссии банков (М-Банк и т.п.) — так же и прибыль.
    [c.fee >= 0.5 ? `Выручка <small class="kpi-note">без комиссии банков −${money(c.fee)}</small>` : 'Выручка', money(c.revenue), c.revenue, pr.revenue],
    // Себестоимость проданного на главной — чистая цена закупки: расходы вычитаются ниже, в чистой прибыли.
    ['Закупка <small class="kpi-note">цена закупки проданного</small>', money(c.cost), c.cost, pr.cost, false, true],
    [`Валовая прибыль <small class="kpi-note">выручка − закупка${c.revenue ? ` · маржа ${pct((c.revenue - c.cost) / c.revenue)}` : ''}</small>`, money(c.revenue - c.cost), c.revenue - c.cost, pr.revenue - pr.cost],
    ...(f ? [[`Чистая прибыль <small class="kpi-note">за вычетом ЗП и расходов −${money(f.cur.total)}</small>`, `<span class="${net(c, f.cur) < 0 ? 'neg' : ''}">${money(net(c, f.cur))}</span>`, net(c, f.cur), net(pr, f.prev)]] : []),
    // Без данных о расходах — маржа отдельной плиткой, как раньше.
    ...(f ? [] : [['Маржа', c.revenue ? pct((c.revenue - c.cost) / c.revenue) : '—', c.revenue ? (c.revenue - c.cost) / c.revenue : 0, pr.revenue ? (pr.revenue - pr.cost) / pr.revenue : 0, true]]),
    ['Чеков', int(c.receipts.size), c.receipts.size, pr.receipts.size],
    ['Средний чек', c.receipts.size ? money(c.revenue / c.receipts.size) : '—', c.receipts.size ? c.revenue / c.receipts.size : 0, pr.receipts.size ? pr.revenue / pr.receipts.size : 0],
  ];
  $('#kpis').innerHTML = tiles.map(([label, value, cur, prev, points, inverse]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="delta">${deltaHtml(cur, prev, p.vs, points, inverse)}</div>
    </div>`).join('');
}

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
    <div class="tr"><span><i style="background: var(--rest)"></i>Закупка</span><b>${money(b.cost)}</b></div>
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
  renderTop($('#top-products'), state.view.products, state.topProducts, pk, pf, pu);
  const [, sk, sf, su, ss] = TOP_STAFF[state.topStaff];
  $('#top-staff-sub').textContent = `${ss} · ${PERIODS[state.period].label.toLowerCase()}`;
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
  { key: 'cost', label: 'Закупка' },
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
  const counts = Object.fromEntries(FILTERS.map(([key, , fn]) => [key, v.products.filter(fn).length]));
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
  const rows = v.products
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
      <td><div class="pname"><button type="button" class="link-name">${esc(p.name)}</button></div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : ''}</td>
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
  state.view = compute(state.data, state.period, Date.now());
  renderPeriods();
  renderKpis(state.view);
  renderNetProfit(state.view);
  renderChart(state.view);
  renderTops();
  renderTable(state.view);
}

let loading = 0;
async function load() {
  const ticket = ++loading;
  const now = Date.now();
  const r = periodRange(state.period, now);
  const from = Math.min(r.prevStart, addDays(dayStart(now), -(STOCK_WINDOW_DAYS - 1)));
  try {
    // Зарплата и расходы — за текущий и прошлый такой же период (для сравнения чистой прибыли).
    const fin = (a, b) => api(`/api/finance?from=${Math.floor(a)}&to=${Math.ceil(b)}`);
    const [data, cur, prev, expenses] = await Promise.all([fetchData(from, now),
      fin(r.start, now).catch(() => null), fin(r.prevStart, r.prevEnd).catch(() => null),
      api(`/api/expenses?from=${Math.floor(r.start)}&to=${Math.ceil(now)}`).catch(() => null)]);
    if (ticket !== loading) return;
    state.finance = cur && prev ? { cur, prev } : null;
    state.expenses = expenses;
    state.data = data;
    renderAll();
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
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.view && renderChart(state.view), 120); });

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

/* ---------- Чистая прибыль: выручка − закупка − зарплата − расходы ---------- */
function renderNetProfit(v) {
  const f = state.finance?.cur;
  $('#net-profit').hidden = !f;
  if (!f) return;
  const c = v.cur;
  const gross = c.revenue - c.cost;
  const net = gross - f.total;
  const line = (label, value, cls = '', note = '') => `<div class="np-line ${cls}"><span>${label}${note ? `<small>${note}</small>` : ''}</span><b class="num">${value}</b></div>`;
  const minus = (n) => (n ? `−${money(n)}` : money(0));
  $('#np-sub').textContent = `${PERIODS[state.period].label}: выручка минус закупка товара, зарплата и расходы`;
  $('#np-lines').innerHTML = [
    line('Выручка', money(c.revenue), '', c.fee >= 0.5 ? `уже без комиссии банков ${money(c.fee)}` : ''),
    line('Закупка товара', minus(c.cost), 'np-minus', 'цена закупки проданного'),
    line('Валовая прибыль', money(gross), 'np-sub'),
    line(session.can('kpi') || session.can('salary') ? '<a href="#kpi">Зарплата</a>' : 'Зарплата', minus(f.salary), 'np-minus', f.staff ? `${f.staff} ${plural(f.staff, ['сотрудник', 'сотрудника', 'сотрудников'])}, по ставкам и % от продаж` : 'ставки сотрудникам не заданы'),
    ...f.expenses.map((e) => line(esc(e.category), minus(e.amount), 'np-minus', `${e.n} ${plural(e.n, ['запись', 'записи', 'записей'])}`)),
    f.writeoffs ? line('Списания', minus(f.writeoffs), 'np-minus', 'брак, просрочка — по себестоимости') : '',
    line('Чистая прибыль', `<span class="${net < 0 ? 'neg' : ''}">${money(net)}</span>`, 'np-total', c.revenue > 0 ? `${pct(net / c.revenue)} от выручки` : ''),
  ].join('');
  const list = state.expenses?.list || [];
  const canEdit = session.can('expenses');
  $('#np-list').innerHTML = `<h3>Расходы за период</h3>${list.length ? `<ul class="np-items">${list.slice(0, 30).map((e) => `
    <li><span class="np-date">${dateOnly(e.at)}</span><span><b>${esc(e.category)}</b>${e.note || e.account ? `<small>${esc([e.note, e.account ? `со счёта «${e.account}»` : ''].filter(Boolean).join(' · '))}</small>` : ''}</span>
      <b class="num">${money(e.amount)}</b>${canEdit ? `<button type="button" class="icon-btn" data-expense-del="${e.id}" aria-label="Удалить расход" title="Удалить">×</button>` : ''}</li>`).join('')}</ul>
    ${list.length > 30 ? `<p class="pick-meta">И ещё ${list.length - 30}</p>` : ''}`
    : `<p class="pick-meta">${canEdit ? 'Расходов пока нет. Нажмите «+ Расход», чтобы внести аренду, доставку, налоги и т.д.' : 'Расходов за период нет.'}</p>`}`;
}

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
  try { d = await api('/api/cash-desk'); } catch { return; }
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

// Касса обновляется сама: после каждой продажи и раз в минуту.
salesFeed.listeners.push(() => { if (currentView === 'home') loadCashDesk(); });
setInterval(() => { if (currentView === 'home' && !document.hidden) loadCashDesk(); }, 60000);

// Строка таблицы «Товары и остатки» открывает карточку товара с продажами за период.
$('#tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-card]');
  if (!tr) return;
  const stats = state.view.products.find((p) => String(p.id) === tr.dataset.card);
  openProductCard(Number(tr.dataset.card), stats);
});

views.home = { show: () => { renderPeriods(); load(); loadCashDesk(); }, right: 'dashboard' };
setInterval(() => { if (currentView === 'home') load(); }, REFRESH_MS);
