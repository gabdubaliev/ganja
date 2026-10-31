'use strict';

// ABC/XYZ-анализ ассортимента.
// ABC — вклад товара в выручку (прибыль, количество): A — первые 80% накопленной доли, B — до 95%, C — остальное.
// XYZ — стабильность спроса: коэффициент вариации продаж по полным неделям (месяцам) —
// X — до 20%, Y — до 40%, Z — больше или продаж нет. Границы можно поменять.

const ABC_PERIODS = {
  w8: { label: '8 недель', bucket: 'week', n: 8 },
  w13: { label: '13 недель', bucket: 'week', n: 13 },
  m6: { label: '6 месяцев', bucket: 'month', n: 6 },
  m12: { label: '12 месяцев', bucket: 'month', n: 12 },
};
const ABC_BY = { revenue: 'выручке', profit: 'прибыли', qty: 'количеству' };
const ABC_ADVICE = {
  AX: ['Основа магазина', 'Приносят больше всего и продаются ровно. Всегда держите в наличии, заказывайте регулярно, следите, чтобы не кончались.'],
  AY: ['Важные, спрос колеблется', 'Много денег, но продажи гуляют. Держите запас с небольшим резервом, смотрите на сезон и акции.'],
  AZ: ['Важные, но непредсказуемые', 'Дают деньги, но продаются рывками. Заказывайте под спрос, ищите причину всплесков, не замораживайте много денег в остатке.'],
  BX: ['Стабильная середина', 'Продаются ровно — удобно заказывать по графику. Можно попробовать поднять в A: выкладка, допродажа.'],
  BY: ['Обычные товары', 'Средний вклад и колебания. Обычный запас, пересматривайте раз в месяц.'],
  BZ: ['Средние, нерегулярные', 'Продаются от случая к случаю. Заказывайте небольшими партиями по мере продаж.'],
  CX: ['Мало, но стабильно', 'Приносят мало, зато покупают регулярно — часто это то, за чем приходят. Минимальный запас, подумайте о цене.'],
  CY: ['Мало и с колебаниями', 'Небольшой вклад. Сократите запас, не закупайте впрок.'],
  CZ: ['Кандидаты на вывод', 'Мало денег и редкие продажи. Распродайте остаток со скидкой и подумайте, нужны ли они в ассортименте.'],
};
const abc = {
  period: store('abcPeriod') in ABC_PERIODS ? store('abcPeriod') : 'w13',
  by: store('abcBy') in ABC_BY ? store('abcBy') : 'revenue',
  cell: '', filter: '', query: '', sort: { key: 'value', dir: -1 }, data: null, rows: [],
};

function abcRange() {
  const p = ABC_PERIODS[abc.period];
  const now = new Date();
  // Только полные недели (с понедельника) или полные месяцы — текущая неполная не входит.
  if (p.bucket === 'week') {
    const monday = dayStart(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return { from: addDays(monday, -7 * p.n), to: monday.getTime() };
  }
  return { from: new Date(now.getFullYear(), now.getMonth() - p.n, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
}

async function renderAbc() {
  const { from, to } = abcRange();
  const p = ABC_PERIODS[abc.period];
  try {
    abc.data = await api(`/api/reports/abc?from=${from}&to=${to}&bucket=${p.bucket}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  $('#abc-sub').textContent = `${dateOnly(from)} — ${dateOnly(to - 1)}, полные ${p.bucket === 'week' ? 'недели' : 'месяцы'}`;
  abcCompute();
  abcDraw();
}

const abcNum = (id, def) => { const v = parseNum($(id).value); return Number.isFinite(v) && v > 0 ? v : def; };

function abcCompute() {
  abc.rows = abcClassify(abc.data, abc.by);
  abc.total = abc.rows.reduce((s, p) => s + p.value, 0);
}

// Делит товары на группы ABC и XYZ. d — ответ /api/reports/abc, by — revenue | profit | qty.
function abcClassify(d, by) {
  const A = abcNum('#abc-a', 80) / 100, B = Math.max(A, abcNum('#abc-b', 95) / 100);
  const X = abcNum('#abc-x', 20) / 100, Y = Math.max(X, abcNum('#abc-y', 40) / 100);
  const val = (p) => Math.max(0, p[by]);
  const list = d.products.map((p) => ({ ...p, value: val(p) })).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, p) => s + p.value, 0);
  let acc = 0;
  for (const p of list) {
    p.share = total ? p.value / total : 0;
    const before = acc;
    acc += p.share;
    p.cum = acc;
    // Товар попадает в группу, в которой начинается его доля: так лидер с долей больше 80% — всё равно A.
    p.abc = p.value <= 0 ? 'C' : before < A ? 'A' : before < B ? 'B' : 'C';
    // XYZ: только полные отрезки и только после того, как товар завели.
    // Неделя, в которую товар завели, тоже неполная — не берём.
    const s = p.series.filter((_, i) => d.full[i] && d.buckets[i] >= (p.created_at || 0));
    const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    const sd = s.length ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length) : 0;
    p.cv = mean > 0 ? sd / mean : null;
    p.points = s.length;
    p.xyz = p.cv === null || s.length < 3 ? 'Z' : p.cv <= X ? 'X' : p.cv <= Y ? 'Y' : 'Z';
    p.fewData = s.length < 3;
    p.frozen = p.stock > 0 ? p.stock * (p.purchase || 0) : 0;
  }
  return list;
}

const ABC_COLORS = { A: 'a', B: 'b', C: 'c' };

// Матрица 3×3: число товаров, доля и сумма в остатке. selected — выделенная клетка.
function abcMatrixHtml(rows, by, selected = '') {
  const total = rows.reduce((s, p) => s + p.value, 0);
  const cellOf = (a, x) => rows.filter((p) => p.abc === a && p.xyz === x);
  return `<div class="abc-corner"></div>${['X', 'Y', 'Z'].map((x) => `<div class="abc-colhead">${x}<small>${{ X: 'ровно', Y: 'колеблется', Z: 'рывками' }[x]}</small></div>`).join('')}
    ${['A', 'B', 'C'].map((a) => `<div class="abc-rowhead">${a}<small>${{ A: '80% денег', B: '15%', C: '5%' }[a]}</small></div>
      ${['X', 'Y', 'Z'].map((x) => {
        const list = cellOf(a, x);
        const value = list.reduce((s, p) => s + p.value, 0);
        const frozen = list.reduce((s, p) => s + p.frozen, 0);
        const key = a + x;
        return `<button type="button" class="abc-cell abc-${key.toLowerCase()} ${selected === key ? 'on' : ''}" data-abc-cell="${key}" aria-pressed="${selected === key}" title="${esc(ABC_ADVICE[key][0] + ': ' + ABC_ADVICE[key][1])}">
          <span class="abc-key">${key}</span>
          <b class="num">${int(list.length)}</b><span class="abc-cell-sub">${plural(list.length, ['товар', 'товара', 'товаров'])}</span>
          <span class="abc-cell-meta">${total ? pct(value / total) : '0%'} ${ABC_BY[by]}${frozen >= 1 ? ` · в остатке ${moneyShort(frozen)}` : ''}</span>
        </button>`;
      }).join('')}`).join('')}`;
}

// Матрица на главной: 13 полных недель по выручке. Клетка открывает полный анализ с её товарами.
async function renderHomeAbc() {
  const box = $('#home-abc');
  if (!box) return;
  if (!session.can('abc')) { box.hidden = true; return; }
  const saved = abc.period;
  abc.period = 'w13';
  const { from, to } = abcRange();
  abc.period = saved;
  let d;
  try { d = await api(`/api/reports/abc?from=${from}&to=${to}&bucket=week`); } catch { box.hidden = true; return; }
  box.hidden = false;
  const rows = abcClassify(d, 'revenue');
  const a = rows.filter((p) => p.abc === 'A');
  const cz = rows.filter((p) => p.abc === 'C' && p.xyz === 'Z');
  $('#home-abc-sub').textContent = `13 полных недель по выручке: ${a.length} ${plural(a.length, ['товар', 'товара', 'товаров'])} группы A дают ${pct(a.reduce((s, p) => s + p.share, 0))} выручки${cz.length ? ` · ${cz.length} в CZ — кандидаты на распродажу` : ''}. Нажмите на клетку — откроется подробный анализ.`;
  $('#home-abc-matrix').innerHTML = abcMatrixHtml(rows, 'revenue');
}
document.addEventListener('click', (e) => {
  const cell = e.target.closest('#home-abc [data-abc-cell]');
  if (!cell) return;
  abc.cell = cell.dataset.abcCell;
  abc.filter = '';
  abc.by = 'revenue';
  abc.period = 'w13';
  location.hash = 'abc';
});

function abcDraw() {
  const rows = abc.rows;
  const by = ABC_BY[abc.by];
  $('#abc-periods').innerHTML = Object.entries(ABC_PERIODS).map(([k, p]) => `<button type="button" class="chip" data-abc-period="${k}" aria-pressed="${k === abc.period}">${p.label}</button>`).join('');
  $('#abc-by').innerHTML = Object.entries(ABC_BY).map(([k, l]) => `<button type="button" class="chip" data-abc-by="${k}" aria-pressed="${k === abc.by}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('');
  const fmtVal = (v) => (abc.by === 'qty' ? `${qtyFmt.format(Math.round(v))} шт` : money(v));

  const cellOf = (a, x) => rows.filter((p) => p.abc === a && p.xyz === x);
  $('#abc-matrix').innerHTML = abcMatrixHtml(rows, abc.by, abc.cell);


  // Советы: по выбранной клетке или по всем.
  const counts = (key) => cellOf(key[0], key[1]).length;
  if (abc.cell) {
    const [title, text] = ABC_ADVICE[abc.cell];
    const list = cellOf(abc.cell[0], abc.cell[1]);
    $('#abc-advice-title').textContent = `${abc.cell}: ${title}`;
    $('#abc-advice-sub').textContent = `${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])}`;
    $('#abc-advice').innerHTML = `<p class="abc-advice-text">${text}</p>
      <ul class="abc-advice-list">${list.slice(0, 8).map((p) => `<li><span>${esc(p.name)}</span><b class="num">${fmtVal(p.value)}</b></li>`).join('')}</ul>
      ${list.length > 8 ? `<p class="pick-meta">И ещё ${list.length - 8} — в таблице ниже</p>` : ''}
      <button type="button" class="btn small ghost" data-abc-cell="${abc.cell}">Показать все товары</button>`;
  } else {
    const dead = rows.filter((p) => p.value <= 0);
    const frozenCZ = cellOf('C', 'Z').reduce((s, p) => s + p.frozen, 0);
    const a = rows.filter((p) => p.abc === 'A');
    $('#abc-advice-title').textContent = 'Главное';
    $('#abc-advice-sub').textContent = `${rows.length} ${plural(rows.length, ['товар', 'товара', 'товаров'])} в продаже`;
    $('#abc-advice').innerHTML = `<ul class="abc-points">
      <li><b>${int(a.length)} ${plural(a.length, ['товар', 'товара', 'товаров'])} (${rows.length ? pct(a.length / rows.length) : '0%'})</b> дают ${pct(a.reduce((s, p) => s + p.share, 0))} ${by}. Их нельзя допускать до нуля на складе.</li>
      ${counts('AX') || counts('AY') ? `<li><b>AX и AY — ${int(counts('AX') + counts('AY'))}</b>: главные и предсказуемые — заказывайте по графику.</li>` : ''}
      ${dead.length ? `<li><b>${int(dead.length)} ${plural(dead.length, ['товар', 'товара', 'товаров'])} не продавались</b> за период${dead.some((p) => p.frozen) ? ` — в них ${money(dead.reduce((s, p) => s + p.frozen, 0))} по цене закупки` : ''}.</li>` : ''}
      ${frozenCZ >= 1 ? `<li><b>В группе CZ заморожено ${money(frozenCZ)}</b> — кандидаты на распродажу.</li>` : ''}
      <li>Нажмите на клетку матрицы, чтобы увидеть совет и товары этой группы.</li>
    </ul>`;
  }

  // Таблица.
  $('#abc-filter').innerHTML = [['', 'Все'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']]
    .map(([k, l]) => `<button type="button" class="chip" data-abc-filter="${k}" aria-pressed="${abc.filter === k && !abc.cell}">${l}</button>`).join('')
    + (abc.cell ? `<button type="button" class="chip" aria-pressed="true" data-abc-cell="${abc.cell}">${abc.cell} ×</button>` : '');
  const q = abc.query.trim().toLowerCase();
  const shown = rows.filter((p) => (!abc.cell || p.abc + p.xyz === abc.cell)
    && (!abc.filter || abc.cell || p.abc === abc.filter || p.xyz === abc.filter)
    && (!q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)));
  const cols = [
    ['name', 'Товар', 1], ['abc', 'ABC', 1], ['xyz', 'XYZ', 1], ['value', abc.by === 'qty' ? 'Продано' : abc.by === 'profit' ? 'Прибыль' : 'Выручка'],
    ['share', 'Доля'], ['cum', 'Накопл.'], ['cv', 'Разброс'], ['series', `По ${ABC_PERIODS[abc.period].bucket === 'week' ? 'неделям' : 'месяцам'}`, 0, true], ['stock', 'Остаток'], ['frozen', 'В остатке, сом'],
  ];
  const { key, dir } = abc.sort;
  $('#abc-head').innerHTML = cols.map(([k, l, , nosort]) => (nosort ? `<th>${l}</th>` : `<th${k === key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-abc-sort="${k}">${l}${k === key ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`)).join('');
  const sv = (p) => (key === 'cv' ? p.cv ?? Infinity : p[key]);
  shown.sort((a, b) => {
    const x = sv(a), y = sv(b);
    if (x === y) return b.value - a.value;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return typeof x === 'string' ? x.localeCompare(y, 'ru') * dir : (x - y) * dir;
  });
  const spark = (series) => {
    const used = series.filter((_, i) => abc.data.full[i]);
    const max = Math.max(...used, 0.0001);
    return `<svg class="abc-spark" viewBox="0 0 ${used.length * 6} 22" preserveAspectRatio="none" aria-hidden="true">${used.map((v, i) => `<rect x="${i * 6}" y="${22 - Math.max(v > 0 ? 1.5 : 0, (v / max) * 22)}" width="4.5" height="${Math.max(v > 0 ? 1.5 : 0, (v / max) * 22)}" rx="1"/>`).join('')}</svg>`;
  };
  $('#abc-table-sub').textContent = `${shown.length} ${plural(shown.length, ['товар', 'товара', 'товаров'])} · ABC по ${by}. Нажмите на товар — откроется карточка.`;
  $('#abc-body').innerHTML = shown.length ? shown.slice(0, 500).map((p) => `
    <tr class="clickable" data-abc-card="${p.id}" ${p.gone ? '' : 'title="Открыть карточку товара"'}>
      <td><div class="pname">${esc(p.name)}</div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : p.gone ? '<div class="pcat">убран из продажи</div>' : ''}</td>
      <td><span class="abc-tag abc-${ABC_COLORS[p.abc]}">${p.abc}</span></td>
      <td><span class="abc-tag xyz-${p.xyz.toLowerCase()}" ${p.fewData ? 'title="Мало полных недель — считаем как Z"' : ''}>${p.xyz}${p.fewData && p.value > 0 ? '?' : ''}</span></td>
      <td>${p.value > 0 ? fmtVal(p.value) : '—'}${abc.by !== 'qty' ? `<div class="pcat">${qtyFmt.format(Math.round(p.qty * 100) / 100)} ${esc(p.unit || 'шт')}</div>` : ''}</td>
      <td>${p.share ? pct(p.share) : '—'}</td>
      <td>${p.value > 0 ? pct(Math.min(1, p.cum)) : '—'}</td>
      <td>${p.cv === null ? '—' : pct(p.cv)}</td>
      <td>${spark(p.series)}</td>
      <td class="${p.stock !== null && p.stock <= 0 ? 'neg' : ''}">${p.stock === null ? '—' : qtyFmt.format(p.stock)}</td>
      <td>${p.frozen >= 1 ? money(p.frozen) : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">Ничего не нашлось</td></tr>`;
}

document.querySelector('[data-view="abc"]').addEventListener('click', (e) => {
  const per = e.target.closest('[data-abc-period]');
  const by = e.target.closest('[data-abc-by]');
  const cell = e.target.closest('[data-abc-cell]');
  const f = e.target.closest('[data-abc-filter]');
  const sort = e.target.closest('[data-abc-sort]');
  const card = e.target.closest('[data-abc-card]');
  if (per) { abc.period = per.dataset.abcPeriod; store('abcPeriod', abc.period); return renderAbc(); }
  if (by) { abc.by = by.dataset.abcBy; store('abcBy', abc.by); abcCompute(); return abcDraw(); }
  if (cell) { abc.cell = abc.cell === cell.dataset.abcCell ? '' : cell.dataset.abcCell; abc.filter = ''; return abcDraw(); }
  if (f) { abc.filter = f.dataset.abcFilter; abc.cell = ''; return abcDraw(); }
  if (sort) {
    const k = sort.dataset.abcSort;
    abc.sort = abc.sort.key === k ? { key: k, dir: -abc.sort.dir } : { key: k, dir: ['name', 'abc', 'xyz', 'cv'].includes(k) ? 1 : -1 };
    return abcDraw();
  }
  if (card) {
    const p = abc.rows.find((x) => String(x.id) === card.dataset.abcCard);
    if (p && !p.gone && typeof openProductCard === 'function') openProductCard(p.id);
  }
});
for (const id of ['#abc-a', '#abc-b', '#abc-x', '#abc-y']) $(id).addEventListener('change', () => { if (abc.data) { abcCompute(); abcDraw(); } });
$('#abc-search').addEventListener('input', (e) => { abc.query = e.target.value; abcDraw(); });

// Для Excel: CSV с «;» и BOM.
$('#abc-export').addEventListener('click', () => {
  if (!abc.rows.length) return;
  const head = ['Товар', 'Категория', 'ABC', 'XYZ', 'Группа', 'Продано', 'Выручка', 'Прибыль', 'Доля', 'Накопленная доля', 'Разброс, %', 'Остаток', 'В остатке по закупке'];
  const lines = abc.rows.map((p) => [p.name, p.category || '', p.abc, p.xyz, p.abc + p.xyz, p.qty, Math.round(p.revenue), Math.round(p.profit),
    (p.share * 100).toFixed(2).replace('.', ','), (Math.min(1, p.cum) * 100).toFixed(2).replace('.', ','), p.cv === null ? '' : (p.cv * 100).toFixed(1).replace('.', ','), p.stock ?? '', Math.round(p.frozen)]);
  const csv = '﻿' + [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `ABC-XYZ ${$('#abc-sub').textContent.replace(/[^\d.,а-яА-Я —-]/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

views.abc = { show: renderAbc, right: 'abc' };
