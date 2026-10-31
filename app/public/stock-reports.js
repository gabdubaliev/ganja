'use strict';

// Товарный отчёт (остаток на начало, приход, расход, остаток на конец), неликвиды и автоматика.
// Данные — из журнала движения товара (stock_moves): каждое изменение остатка записывается само.

const MOVE_NAMES = {
  purchase: 'Закупка', receipt: 'Оприходование', transfer_in: 'Перемещение (приход)', return: 'Возврат покупателя', refund: 'Возврат по чеку',
  sale: 'Продажи', sale_delete: 'Удалённые чеки', writeoff: 'Списание', transfer_out: 'Перемещение (отправка)',
};
const csvDownload = (name, head, rows) => {
  const csv = '﻿' + [head, ...rows].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const qn = (v) => (v ? qtyFmt.format(v) : '—');
const optLine = (o) => { try { return Object.values(typeof o === 'string' ? JSON.parse(o || '{}') : o || {}).filter(Boolean).join(' · '); } catch { return ''; } };

/* ---------- Товарный отчёт ---------- */
const sr = { mode: 'period', range: 'month', from: null, to: null, at: null, data: null };

function srPeriod() {
  if (sr.mode === 'date') {
    const at = sr.at ?? dayStart(Date.now()).getTime();
    return [0, addDays(at, 1)];
  }
  if (sr.range === 'custom' && sr.from && sr.to) return [sr.from, addDays(sr.to, 1)];
  return RANGES[sr.range][1]();
}

async function renderStockReport() {
  for (const b of document.querySelectorAll('[data-sr-mode]')) b.setAttribute('aria-pressed', String(b.dataset.srMode === sr.mode));
  $('#sr-ranges').hidden = sr.mode !== 'period';
  $('#sr-dates').hidden = sr.mode !== 'period';
  $('#sr-ondate').hidden = sr.mode !== 'date';
  renderRanges($('#sr-ranges'), ['today', 'week', 'month', 'prevMonth', 'year'], sr.range);
  const [from, to] = srPeriod();
  if (sr.mode === 'period') { $('#sr-from').value = dateInput(from); $('#sr-to').value = dateInput(to - 1); } else $('#sr-at').value = dateInput(to - 1);
  const qs = new URLSearchParams({ from, to, category: $('#sr-cat').value || '', q: $('#sr-q').value.trim() });
  try {
    sr.data = await api(`/api/reports/stock?${qs}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const d = sr.data;
  const cur = $('#sr-cat').value;
  $('#sr-cat').innerHTML = '<option value="">Все категории</option>' + d.categories.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const t = d.totals;
  const dateOnly = sr.mode === 'date';
  $('#sr-sub').textContent = dateOnly ? `остатки на конец ${new Date(to - 1).toLocaleDateString('ru-RU')}` : `${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}`;
  $('#sr-tiles').innerHTML = dateOnly ? `
    <div class="st-tile accent"><span>Остаток</span><b class="num">${qtyFmt.format(t.close)}</b><small>${d.list.length} товаров</small></div>
    <div class="st-tile"><span>По закупке</span><b class="num">${money(t.closeCost)}</b><small>сколько денег в товаре</small></div>
    <div class="st-tile"><span>В рознице</span><b class="num">${money(t.closeRetail)}</b><small>по нынешним ценам</small></div>
    <div class="st-tile"><span>Возможная наценка</span><b class="num">${money(t.closeRetail - t.closeCost)}</b><small>если продать всё</small></div>` : `
    <div class="st-tile"><span>На начало</span><b class="num">${qtyFmt.format(t.open)}</b><small>${money(t.openCost)}</small></div>
    <div class="st-tile"><span>Приход</span><b class="num">+${qtyFmt.format(t.in)}</b><small>${money(t.inCost)}</small></div>
    <div class="st-tile"><span>Расход</span><b class="num">−${qtyFmt.format(t.out)}</b><small>${money(t.outCost)}${t.inv ? ` · инвентаризация ${t.inv > 0 ? '+' : ''}${qtyFmt.format(t.inv)}` : ''}</small></div>
    <div class="st-tile accent"><span>На конец</span><b class="num">${qtyFmt.format(t.close)}</b><small>${money(t.closeCost)} · в рознице ${money(t.closeRetail)}</small></div>`;
  $('#sr-head').innerHTML = dateOnly
    ? '<tr><th>Товар</th><th>Остаток</th><th>Закупка за шт</th><th>По закупке</th><th>Цена</th><th>В рознице</th></tr>'
    : '<tr><th>Товар</th><th>На начало</th><th>Приход</th><th>Расход</th><th>Инвентар.</th><th>Прочее</th><th>На конец</th><th>На конец, по закупке</th></tr>';
  const tip = (by) => Object.entries(by).map(([k, v]) => `${MOVE_NAMES[k] || k}: ${qtyFmt.format(v)}`).join('\n');
  const row = (x) => (dateOnly
    ? `<tr><td><div class="pname">${esc(x.name)}</div><span class="sub">${esc([x.category, x.code].filter(Boolean).join(' · '))}</span></td>
        <td class="num">${qtyFmt.format(x.close)} ${esc(x.unit)}</td><td class="num">${money2(x.cost)}</td><td class="num">${money(x.closeCost)}</td><td class="num">${money2(x.price)}</td><td class="num">${money(x.closeRetail)}</td></tr>`
    : `<tr><td><div class="pname">${esc(x.name)}</div><span class="sub">${esc([x.category, x.code].filter(Boolean).join(' · '))}</span></td>
        <td class="num">${qn(x.open)}</td><td class="num in" title="${esc(tip(x.inBy))}">${x.in ? '+' + qtyFmt.format(x.in) : '—'}</td>
        <td class="num out" title="${esc(tip(x.outBy))}">${x.out ? '−' + qtyFmt.format(x.out) : '—'}</td><td class="num">${x.inv ? (x.inv > 0 ? '+' : '') + qtyFmt.format(x.inv) : '—'}</td>
        <td class="num" title="Начальные остатки, импорт, ручные правки">${x.other ? (x.other > 0 ? '+' : '') + qtyFmt.format(x.other) : '—'}</td>
        <td class="num"><b>${qtyFmt.format(x.close)}</b></td><td class="num">${money(x.closeCost)}</td></tr>`);
  const list = dateOnly ? d.list.filter((x) => x.close) : d.list;
  let html = '';
  if ($('#sr-group').checked) {
    const cats = new Map();
    for (const x of list) { const k = x.category || 'Без категории'; if (!cats.has(k)) cats.set(k, []); cats.get(k).push(x); }
    for (const [cat, items] of cats) {
      const s = (k) => items.reduce((a, x) => a + x[k], 0);
      html += dateOnly
        ? `<tr class="cat"><td>${esc(cat)}</td><td class="num">${qtyFmt.format(s('close'))}</td><td></td><td class="num">${money(s('closeCost'))}</td><td></td><td class="num">${money(s('closeRetail'))}</td></tr>`
        : `<tr class="cat"><td>${esc(cat)}</td><td class="num">${qn(s('open'))}</td><td class="num">${qn(s('in'))}</td><td class="num">${qn(s('out'))}</td><td class="num">${qn(s('inv'))}</td><td class="num">${qn(s('other'))}</td><td class="num">${qtyFmt.format(s('close'))}</td><td class="num">${money(s('closeCost'))}</td></tr>`;
      html += items.map(row).join('');
    }
  } else html = list.map(row).join('');
  html += list.length ? (dateOnly
    ? `<tr class="total"><td>Итого</td><td class="num">${qtyFmt.format(t.close)}</td><td></td><td class="num">${money(t.closeCost)}</td><td></td><td class="num">${money(t.closeRetail)}</td></tr>`
    : `<tr class="total"><td>Итого</td><td class="num">${qn(t.open)}</td><td class="num">${qn(t.in)}</td><td class="num">${qn(t.out)}</td><td class="num">${qn(t.inv)}</td><td class="num">${qn(t.other)}</td><td class="num">${qtyFmt.format(t.close)}</td><td class="num">${money(t.closeCost)}</td></tr>`)
    : `<tr><td colspan="8" class="empty">${dateOnly ? 'На эту дату товара на складе не было' : 'За этот период движения товара не было'}</td></tr>`;
  $('#sr-body').innerHTML = html;
}

$('#sr-ranges').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (b) { sr.range = b.dataset.range; renderStockReport(); } });
$('#sr-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-sr-mode]'); if (b) { sr.mode = b.dataset.srMode; renderStockReport(); } });
for (const id of ['#sr-from', '#sr-to']) $(id).addEventListener('change', () => { if ($('#sr-from').value && $('#sr-to').value) { sr.range = 'custom'; sr.from = fromDateInput($('#sr-from').value); sr.to = fromDateInput($('#sr-to').value); renderStockReport(); } });
$('#sr-at').addEventListener('change', () => { if ($('#sr-at').value) { sr.at = fromDateInput($('#sr-at').value); renderStockReport(); } });
$('#sr-cat').addEventListener('change', renderStockReport);
$('#sr-group').addEventListener('change', renderStockReport);
let srTimer = null;
$('#sr-q').addEventListener('input', () => { clearTimeout(srTimer); srTimer = setTimeout(renderStockReport, 300); });
$('#sr-export').addEventListener('click', () => {
  const d = sr.data;
  if (!d) return;
  csvDownload(`Товарный отчёт ${$('#sr-sub').textContent}.csv`,
    ['Товар', 'Категория', 'Код', 'На начало', 'Приход', 'Расход', 'Инвентаризация', 'Прочее', 'На конец', 'Закупка за шт', 'На конец по закупке', 'Цена', 'На конец в рознице'],
    d.list.map((x) => [x.name, x.category, x.code, x.open, x.in, x.out, x.inv, x.other, x.close, x.cost, x.closeCost, x.price, x.closeRetail]));
});
views.stockreport = { show: renderStockReport, right: 'reports.stock' };

/* ---------- Неликвиды ---------- */
const ds = { days: 30, data: null, sel: new Set() };
const stageClass = (d) => (d >= 180 ? 's180' : d >= 90 ? 's90' : d >= 60 ? 's60' : 's30');

async function renderDeadStock() {
  try {
    ds.data = await api(`/api/reports/dead?days=${ds.days}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const d = ds.data;
  const share = d.stockValue ? Math.round((d.totals.frozen / d.stockValue) * 100) : 0;
  $('#ds-sub').textContent = `${d.totals.count} товаров не продаются ${ds.days}+ дней · ${share}% денег склада`;
  $('#ds-tiles').innerHTML = d.stages.map((s) => `<button type="button" class="st-tile ${s.days === ds.days ? 'accent' : ''}" data-ds-days="${s.days}" style="text-align:left;cursor:pointer">
      <span>Без продаж ${s.days}+ дней</span><b class="num">${money(s.frozen)}</b><small>${s.count} товаров · ${qtyFmt.format(s.qty)} шт · в рознице ${money(s.retail)}</small></button>`).join('');
  $('#ds-days').innerHTML = [30, 60, 90, 180].map((x) => `<button type="button" class="chip" data-ds-days="${x}" aria-pressed="${x === ds.days}">${x}+ дней</button>`).join('');
  renderDeadRows();
  renderArchive();
}

function renderDeadRows() {
  const q = $('#ds-q').value.trim().toLowerCase();
  const list = ds.data.list.filter((x) => !q || `${x.name} ${x.code} ${x.barcode} ${x.article} ${x.category}`.toLowerCase().includes(q));
  for (const id of [...ds.sel]) if (!ds.data.list.some((x) => x.id === id)) ds.sel.delete(id);
  $('#ds-body').innerHTML = list.length ? list.map((x) => `<tr class="${ds.sel.has(x.id) ? 'sel' : ''}">
      <td><input type="checkbox" data-ds-sel="${x.id}" ${ds.sel.has(x.id) ? 'checked' : ''} aria-label="Выбрать"></td>
      <td><div class="pname">${esc(x.name)}${optLine(x.options) ? ` <span class="pcat">${esc(optLine(x.options))}</span>` : ''}</div><span class="sub">${esc([x.category, x.code, x.article].filter(Boolean).join(' · '))}</span></td>
      <td class="num">${qtyFmt.format(x.stock)} ${esc(x.unit)}</td>
      <td class="num"><span class="ds-idle ${stageClass(x.idle)}">${x.idle} дн.</span></td>
      <td class="num">${x.lastSale ? new Date(x.lastSale).toLocaleDateString('ru-RU') : '<span class="pcat">не продавался</span>'}<span class="sub">${x.lastIn ? `поступил ${new Date(x.lastIn).toLocaleDateString('ru-RU')}` : ''}</span></td>
      <td class="num">${x.sold30 ? qtyFmt.format(x.sold30) : '—'}</td>
      <td class="num"><b>${money(x.frozen)}</b><span class="sub">по закупке</span></td>
      <td class="num">${x.discount ? `−${x.discount}%${x.auto_discount ? '<span class="sub">автоуценка</span>' : ''}` : '—'}</td>
      <td class="num">${money2(x.discount ? x.price * (1 - x.discount / 100) : x.price)}${x.discount ? `<span class="sub"><s>${money2(x.price)}</s></span>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="9" class="empty">Нет товаров, которые не продаются ${ds.days}+ дней. Отлично!</td></tr>`;
  $('#ds-all').checked = list.length > 0 && list.every((x) => ds.sel.has(x.id));
  $('#ds-bulk').hidden = !ds.sel.size;
  $('#ds-count').textContent = `Выбрано: ${ds.sel.size}`;
}

async function renderArchive() {
  let list = [];
  try { list = await api('/api/auto-reports'); } catch { /* без архива */ }
  const ICON = { weekly: '🐌', monthly: '📦', markdown: '🏷️' };
  $('#ds-archive').innerHTML = list.length ? list.slice(0, 20).map((r) => `<div class="ar-item"><span>${ICON[r.kind] || '📄'}</span>
      <span><b>${esc(r.title)}</b><br><small>${esc(r.summary)} · ${dateTime(r.created_at)}</small></span>
      <button type="button" class="btn small" data-ar="${r.id}">Скачать для Excel</button></div>`).join('')
    : '<p class="pick-meta">Пока ни одного. Первый отчёт придёт по расписанию из «Автоматики» — или нажмите там «Прислать сейчас».</p>';
}

$('#ds-archive').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ar]');
  if (!b) return;
  try {
    const r = await api(`/api/auto-reports/${b.dataset.ar}`);
    if (r.kind === 'weekly') csvDownload(`${r.title}.csv`, ['Товар', 'Категория', 'Остаток', 'Дней без продаж', 'Заморожено', 'Цена', 'Скидка %'], r.data.list.map((x) => [x.name, x.category, x.stock, x.idle, x.frozen, x.price, x.discount || 0]));
    else if (r.kind === 'monthly') csvDownload(`${r.title}.csv`, ['Товар', 'Категория', 'На начало', 'Приход', 'Расход', 'Инвентаризация', 'Прочее', 'На конец', 'На конец по закупке'], r.data.list.map((x) => [x.name, x.category, x.open, x.in, x.out, x.inv, x.other, x.close, x.closeCost]));
    else csvDownload(`${r.title}.csv`, ['Товар', 'Категория', 'Дней без продаж', 'Скидка была %', 'Скидка стала %', 'Цена', 'Цена со скидкой'], r.data.changes.map((c) => [c.name, c.category, c.idle, c.from, c.to, c.price, c.newPrice]));
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.querySelector('[data-view="deadstock"]').addEventListener('click', (e) => {
  const day = e.target.closest('[data-ds-days]');
  if (day) { ds.days = Number(day.dataset.dsDays); ds.sel.clear(); return renderDeadStock(); }
});
$('#ds-q').addEventListener('input', renderDeadRows);
$('#ds-body').addEventListener('change', (e) => {
  const c = e.target.closest('[data-ds-sel]');
  if (!c) return;
  const id = Number(c.dataset.dsSel);
  if (c.checked) ds.sel.add(id); else ds.sel.delete(id);
  renderDeadRows();
});
$('#ds-all').addEventListener('change', (e) => {
  const q = $('#ds-q').value.trim().toLowerCase();
  for (const x of ds.data.list.filter((y) => !q || `${y.name} ${y.code} ${y.barcode} ${y.article} ${y.category}`.toLowerCase().includes(q))) {
    if (e.target.checked) ds.sel.add(x.id); else ds.sel.delete(x.id);
  }
  renderDeadRows();
});
$('#ds-unselect').addEventListener('click', () => { ds.sel.clear(); renderDeadRows(); });
async function dsDiscount(value) {
  try {
    const r = await api('/api/reports/dead/discount', { method: 'POST', body: { ids: [...ds.sel], discount: value } });
    toast(value ? `Уценено: ${r.count} товаров на ${r.discount}%. Не забудьте ценники` : `Скидка снята у ${r.count} товаров`);
    await catalog.load();
    renderDeadStock();
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('#ds-apply').addEventListener('click', () => dsDiscount(parseNum($('#ds-disc').value) || 0));
$('#ds-clear-disc').addEventListener('click', () => dsDiscount(0));
// Ценники — через обычное окно «Печать этикеток» (шаблон, количество, принтер).
async function dsPrint(ids) {
  await catalog.load();
  const products = ids.map((id) => catalog.list.find((p) => p.id === id)).filter(Boolean);
  if (!products.length) return toast('Нет товаров для ценников', 'error');
  openLabels(products);
}
$('#ds-print').addEventListener('click', () => dsPrint([...ds.sel]));
$('#ds-labels-auto').addEventListener('click', async () => {
  await catalog.load();
  dsPrint(catalog.list.filter((p) => p.auto_discount > 0 && p.stock > 0).map((p) => p.id));
});
$('#ds-export').addEventListener('click', () => {
  if (!ds.data) return;
  csvDownload(`Неликвиды ${ds.days}+ дней ${new Date().toLocaleDateString('ru-RU')}.csv`,
    ['Товар', 'Модификация', 'Категория', 'Код', 'Штрихкод', 'Остаток', 'Дней без продаж', 'Последняя продажа', 'Продано за 30 дней', 'Закупка за шт', 'Заморожено', 'Цена', 'Скидка %', 'В рознице'],
    ds.data.list.map((x) => [x.name, optLine(x.options), x.category, x.code, x.barcode, x.stock, x.idle, x.lastSale ? new Date(x.lastSale).toLocaleDateString('ru-RU') : 'не было', x.sold30, x.cost, x.frozen, x.price, x.discount || 0, x.retail]));
});
views.deadstock = { show: () => { ds.sel.clear(); renderDeadStock(); }, right: 'reports.stock' };

/* ---------- Автоматика ---------- */
const au = { s: null, preview: [] };
const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

async function renderAutomation() {
  try {
    const r = await api('/api/automation');
    au.s = r.settings;
    au.preview = r.preview;
    $('#au-tg').hidden = r.telegram;
    $('#au-tg').innerHTML = 'Telegram не подключён — отчёты будут только в программе («Неликвиды» → «Автоотчёты»). Чтобы они приходили на телефон, подключите бота: «Ещё» → «Настройки» → Telegram.';
    await catalog.load();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const s = au.s;
  $('#au-w-on').checked = s.weekly.on;
  $('#au-w-day').value = String(s.weekly.weekday);
  $('#au-w-hour').innerHTML = hours(s.weekly.hour);
  $('#au-w-days').value = s.weekly.days;
  $('#au-m-on').checked = s.monthly.on;
  $('#au-m-day').innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i + 1 === s.monthly.day ? 'selected' : ''}>${i + 1}</option>`).join('');
  $('#au-m-hour').innerHTML = hours(s.monthly.hour);
  $('#au-md-on').checked = s.markdown.on;
  $('#au-md-hour').innerHTML = hours(s.markdown.hour);
  $('#au-md-margin').value = s.markdown.minMargin;
  $('#au-md-reset').checked = s.markdown.resetOnArrival;
  const cats = [...new Set(catalog.list.map((p) => p.category).filter(Boolean))].sort();
  $('#au-md-cats').innerHTML = cats.length ? cats.map((c) => `<label class="check"><input type="checkbox" data-au-cat="${esc(c)}" ${s.markdown.exclude.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') : '<span class="pick-meta">Категорий нет</span>';
  renderStages();
  renderPreview();
}

function renderStages() {
  $('#au-stages').innerHTML = au.s.markdown.stages.map((st, i) => `<div class="au-stage">Не продаётся <input class="input num" data-st-days="${i}" value="${st.days}" inputmode="numeric"> дней →
      скидка <input class="input num" data-st-disc="${i}" value="${st.discount}" inputmode="numeric"> %
      <button type="button" class="btn small ghost danger-text" data-st-del="${i}">Убрать</button></div>`).join('') || '<p class="pick-meta">Ступеней нет — добавьте хотя бы одну.</p>';
}
function renderPreview() {
  const p = au.preview;
  $('#au-preview').innerHTML = p.length
    ? `<p class="pick-meta">По сохранённым настройкам сейчас получили бы скидку ${p.length} товаров:</p>` + p.slice(0, 50).map((c) => `<div><span>${esc(c.name)} <span class="pcat">${c.idle} дн. без продаж</span></span><span>${c.from}% → <b>${c.to}%</b> · ${money2(c.newPrice)}</span></div>`).join('')
      + (p.length > 50 ? `<p class="pick-meta">…и ещё ${p.length - 50}</p>` : '')
    : '<p class="pick-meta">Сейчас уценивать нечего: залежавшихся товаров на этих ступенях нет (или скидка уже такая).</p>';
}

function readAutomation() {
  const s = au.s;
  s.weekly = { on: $('#au-w-on').checked, weekday: Number($('#au-w-day').value), hour: Number($('#au-w-hour').value), days: Number($('#au-w-days').value) || 30 };
  s.monthly = { on: $('#au-m-on').checked, day: Number($('#au-m-day').value), hour: Number($('#au-m-hour').value) };
  s.markdown.on = $('#au-md-on').checked;
  s.markdown.hour = Number($('#au-md-hour').value);
  s.markdown.minMargin = Number($('#au-md-margin').value) || 0;
  s.markdown.resetOnArrival = $('#au-md-reset').checked;
  s.markdown.exclude = [...document.querySelectorAll('[data-au-cat]:checked')].map((x) => x.dataset.auCat);
  s.markdown.stages = s.markdown.stages.map((st, i) => ({ days: Number($(`[data-st-days="${i}"]`)?.value) || st.days, discount: Number($(`[data-st-disc="${i}"]`)?.value) || st.discount }));
  return s;
}

async function saveAutomation(quiet = false) {
  try {
    au.s = await api('/api/automation', { method: 'PUT', body: readAutomation() });
    const r = await api('/api/automation');
    au.preview = r.preview;
    renderStages();
    renderPreview();
    if (!quiet) toast(au.s.markdown.on ? 'Сохранено. Автоуценка включена — проверка каждый день' : 'Сохранено');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}
$('#au-save').addEventListener('click', () => saveAutomation());
$('#au-stage-add').addEventListener('click', () => {
  readAutomation();
  const last = au.s.markdown.stages.at(-1) || { days: 30, discount: 10 };
  au.s.markdown.stages.push({ days: last.days + 30, discount: Math.min(90, last.discount + 15) });
  renderStages();
});
$('#au-stages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-st-del]');
  if (!b) return;
  readAutomation();
  au.s.markdown.stages.splice(Number(b.dataset.stDel), 1);
  renderStages();
});
document.querySelector('[data-view="automation"]').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-au-run]');
  if (!b) return;
  if (b.dataset.auRun === 'markdown' && !b.classList.contains('danger')) {
    b.classList.add('danger');
    b.textContent = `Точно уценить ${au.preview.length} товаров?`;
    return;
  }
  b.disabled = true;
  try {
    if (!(await saveAutomation(true))) return;
    const r = await api('/api/automation/run', { method: 'POST', body: { job: b.dataset.auRun } });
    toast(r.count === 0 ? 'Уценивать нечего' : `${r.title || 'Готово'}${r.sent ? ' — отправлено в Telegram' : ' — сохранено в «Неликвиды» → «Автоотчёты»'}`);
    if (b.dataset.auRun === 'markdown') renderAutomation();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    b.disabled = false;
    if (b.dataset.auRun === 'markdown') { b.classList.remove('danger'); b.textContent = '▶ Уценить сейчас'; }
  }
});
views.automation = { show: renderAutomation, right: 'automation' };
