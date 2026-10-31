'use strict';

// Приход по фото накладной: фото → распознавание → строки с подобранными товарами →
// цены по курсу, доп. расходы по строкам, наценка → документ «Закупка».
// Введённое сохраняется в браузере, чтобы не потерять при случайной перезагрузке.

const RC_CUR = { USD: '$', KGS: 'сом', RUB: '₽', CNY: '¥', KZT: '₸', EUR: '€' };
const rc = Object.assign({
  supplier: '', number: '', date: '', currency: 'USD', rate: '', markup: '', mode: 'pct', markupCost: false, updatePrices: true, recordExpenses: true,
  extras: [{ name: 'Зарплата грузчикам', amount: '' }, { name: 'Доставка', amount: '' }], lines: [],
}, (() => { try { return JSON.parse(localStorage.getItem('rcDraft') || 'null') || {}; } catch { return {}; } })());
rc.photos = [];
let rcSuppliers = [];
let rcStatus = null;

const rcSave = () => { try { const { photos, ...keep } = rc; localStorage.setItem('rcDraft', JSON.stringify(keep)); } catch { /* браузер без хранилища */ } };
const rcLabel = (p) => `${p.code || '—'} · ${p.name}`;
const rcRate = () => (rc.currency === 'KGS' ? 1 : parseNum(rc.rate) || 0);

async function renderReceive() {
  try {
    [rcStatus] = await Promise.all([api('/api/invoice/status'), catalog.list.length ? null : catalog.load()]);
    rcSuppliers = await api('/api/suppliers').catch(() => []);
    await categories.load().catch(() => {});
    $('#categories').innerHTML = categories.names().map((c) => `<option value="${esc(c)}">`).join('');
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (!rc.rate && rcStatus.rate) rc.rate = String(rcStatus.rate).replace('.', ',');
  if (!rc.date) rc.date = dateInput(Date.now());
  // Блок ключа: администратору — всегда (можно поменять), остальным — только если распознавание не настроено.
  $('#rc-key').hidden = rcStatus.configured && !session.can('settings');
  $('#rc-key-form').hidden = !session.can('settings') || rcStatus.fromEnv;
  $('#rc-key-note').textContent = rcStatus.fromEnv ? 'Ключ задан на сервере (ANTHROPIC_API_KEY).'
    : rcStatus.configured ? 'Ключ сохранён — распознавание работает. Чтобы заменить, вставьте новый.'
      : session.can('settings') ? 'Ключа пока нет — без него можно вводить строки вручную.' : 'Распознавание не настроено — попросите администратора ввести ключ. Строки можно ввести вручную.';
  $('#rc-suppliers').innerHTML = rcSuppliers.map((s) => `<option value="${esc(s.name)}">`).join('');
  $('#rc-products').innerHTML = catalog.sellable().map((p) => `<option value="${esc(rcLabel(p))}">`).join('');
  $('#rc-supplier').value = rc.supplier;
  $('#rc-number').value = rc.number;
  $('#rc-date').value = rc.date;
  $('#rc-currency').value = rc.currency;
  $('#rc-rate').value = rc.rate;
  $('#rc-markup').value = rc.markup;
  $('#rc-markup-cost').checked = rc.markupCost;
  $('#rc-update-prices').checked = rc.updatePrices;
  $('#rc-expenses').checked = rc.recordExpenses;
  drawReceive();
}

// Расчёт строк: закупка в сомах, доля доп. расходов, себестоимость, цена продажи.
function rcCalc() {
  const rate = rcRate();
  const extras = rc.extras.reduce((s, e) => s + (parseNum(e.amount) || 0), 0);
  const rows = rc.lines.map((l) => {
    const qty = parseNum(l.qty) || 0;
    const purchase = Math.round((parseNum(l.price_cur) || 0) * rate * 100) / 100;
    return { l, qty, purchase, sum: purchase * qty, p: l.product_id ? catalog.byId(l.product_id) : null };
  });
  const total = rows.reduce((s, r) => s + r.sum, 0);
  const m = parseNum(rc.markup);
  for (const r of rows) {
    r.extra = total > 0 && r.qty > 0 ? Math.round(extras * (r.sum / total) / r.qty * 100) / 100 : 0;
    r.cost = Math.round((r.purchase + r.extra) * 100) / 100;
    const base = rc.markupCost ? r.cost : r.purchase;
    r.auto = Number.isFinite(m) && rc.markup !== '' && base > 0 ? Math.round(rc.mode === 'pct' ? base * (1 + m / 100) : base + m) : (r.p?.price || 0);
    r.keepOld = r.p && !rc.updatePrices;
    r.sale = r.keepOld ? r.p.price : r.l.sale !== undefined && r.l.sale !== '' && r.l.sale !== null ? parseNum(r.l.sale) || 0 : r.auto;
  }
  return { rows, total, extras, rate };
}

function drawReceive() {
  const cur = RC_CUR[rc.currency] || rc.currency;
  $('#rc-cur-label').textContent = cur;
  for (const el of document.querySelectorAll('.rc-cur')) el.textContent = cur;
  document.querySelector('.rc-rate-field').hidden = rc.currency === 'KGS';
  for (const b of document.querySelectorAll('#rc-markup-mode [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === rc.mode));
  $('#rc-extras').innerHTML = rc.extras.map((e, i) => `<div class="rc-extra" data-i="${i}">
    <input class="input" data-extra="name" value="${esc(e.name)}" placeholder="Например, Зарплата" aria-label="Расход">
    <input class="input num" data-extra="amount" inputmode="decimal" value="${esc(e.amount)}" placeholder="0 сом" aria-label="Сумма, сом">
    <button type="button" class="icon-btn" data-extra-del="${i}" aria-label="Убрать расход">×</button></div>`).join('');
  $('#rc-thumbs').innerHTML = rc.photos.map((p, i) => `<div class="rc-thumb"><img src="data:${p.mime};base64,${p.data}" alt="Страница ${i + 1}"><button type="button" class="icon-btn" data-photo-del="${i}" aria-label="Убрать фото">×</button></div>`).join('');
  $('#rc-recognize').disabled = !rc.photos.length || !rcStatus?.configured;
  drawReceiveLines();
}

function drawReceiveLines() {
  const { rows, total, extras, rate } = rcCalc();
  const cur = RC_CUR[rc.currency] || rc.currency;
  $('#rc-lines-sub').textContent = rows.length ? `${rows.length} ${plural(rows.length, ['строка', 'строки', 'строк'])} · найдено в базе ${rows.filter((r) => r.p).length}, новых ${rows.filter((r) => !r.p).length}. Впишите название из списка, чтобы связать с товаром, или оставьте своё — заведётся новый.` : 'Строки появятся после распознавания. Можно добавить и вручную.';
  $('#rc-lines').innerHTML = rows.length ? rows.map((r, i) => {
    const l = r.l;
    const badge = r.p ? `<span class="rc-badge found">в базе${l.how ? ` · ${esc(l.how)}` : ''}</span>` : '<span class="rc-badge new">новый товар</span>';
    return `<tr data-i="${i}">
      <td class="rc-name">
        <input class="input" data-line="product" list="rc-products" value="${esc(r.p ? rcLabel(r.p) : l.name || '')}" placeholder="Название или код товара" aria-label="Товар">
        <div class="rc-meta">${badge}${l.raw && (!r.p || r.p.name !== l.raw) ? `<span class="pcat">в накладной: ${esc(l.raw)}</span>` : ''}${!r.p ? `<input class="input rc-cat" data-line="category" list="categories" value="${esc(l.category || '')}" placeholder="Категория">` : ''}</div>
      </td>
      <td><input class="input num rc-qty" data-line="qty" inputmode="decimal" value="${esc(l.qty ?? '')}" aria-label="Количество"><div class="pcat">${esc(r.p?.unit || l.unit || 'шт')}</div></td>
      <td><input class="input num rc-price" data-line="price_cur" inputmode="decimal" value="${esc(l.price_cur ?? '')}" aria-label="Цена в валюте"><div class="pcat">${r.qty ? `${qtyFmt.format(Math.round((parseNum(l.price_cur) || 0) * r.qty * 100) / 100)} ${cur}` : ''}</div></td>
      <td class="num">${money2(r.purchase)}${r.p ? `<div class="pcat">было ${money2(r.p.purchase ?? r.p.cost)}</div>` : ''}</td>
      <td class="num">${r.extra ? `+${money2(r.extra)}` : '—'}</td>
      <td class="num"><b>${money2(r.cost)}</b></td>
      <td>${r.keepOld ? `<span class="num">${money2(r.sale)}</span><div class="pcat">цена не меняется</div>`
        : `<input class="input num rc-sale ${l.sale !== undefined && l.sale !== '' && l.sale !== null ? 'manual' : ''}" data-line="sale" inputmode="decimal" value="${esc(l.sale ?? '')}" placeholder="${r.auto ? String(r.auto) : 'цена'}" aria-label="Цена продажи">
          <div class="pcat">${r.purchase > 0 && r.sale > 0 ? `наценка ${pct((r.sale - r.purchase) / r.purchase)}` : ''}${r.p ? ` · сейчас ${money2(r.p.price)}` : ''}</div>`}</td>
      <td><button type="button" class="icon-btn" data-line-del="${i}" aria-label="Убрать строку">×</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">Строк пока нет</td></tr>';
  const sale = rows.reduce((s, r) => s + r.sale * r.qty, 0);
  const cost = rows.reduce((s, r) => s + r.cost * r.qty, 0);
  const curTotal = rows.reduce((s, r) => s + (parseNum(r.l.price_cur) || 0) * r.qty, 0);
  $('#rc-totals').innerHTML = rows.length ? `
    <div><span>В накладной</span><b class="num">${rc.currency === 'KGS' ? money2(curTotal) : `${qtyFmt.format(Math.round(curTotal * 100) / 100)} ${cur}`}</b>${rc.currency !== 'KGS' ? `<small>${rate ? `по курсу ${String(rate).replace('.', ',')}` : 'укажите курс'}</small>` : ''}</div>
    <div><span>Закупка, сом</span><b class="num">${money2(total)}</b></div>
    <div><span>Доп. расходы</span><b class="num">${money2(extras)}</b></div>
    <div><span>Себестоимость всего</span><b class="num">${money2(cost)}</b></div>
    <div class="accent"><span>По ценам продажи</span><b class="num">${money2(sale)}</b><small>${cost ? `прибыль ${money(sale - cost)} · ${pct((sale - cost) / sale || 0)}` : ''}</small></div>` : '';
}

// Фото: уменьшаем до 2000 px — так быстрее и дешевле, а текст читается.
$('#rc-file').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    try { rc.photos.push({ mime: 'image/jpeg', data: await shrinkPhoto(file, 2000) }); } catch (err) { toast(err.message, 'error'); }
  }
  e.target.value = '';
  drawReceive();
});

$('#rc-recognize').addEventListener('click', async () => {
  const btn = $('#rc-recognize');
  btn.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => { $('#rc-status').textContent = `Читаю накладную… ${Math.round((Date.now() - started) / 1000)} с (обычно 20–60 секунд)`; }, 1000);
  try {
    const r = await api('/api/invoice/recognize', { method: 'POST', body: { images: rc.photos.map(({ mime, data }) => ({ mime, data })) } });
    if (r.supplier) rc.supplier = r.supplier;
    if (r.number) rc.number = r.number;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) rc.date = r.date;
    if (RC_CUR[r.currency]) rc.currency = r.currency;
    const fresh = r.lines.map((l) => ({ raw: l.name, name: l.name, article: l.article, barcode: l.barcode, unit: l.unit || 'шт', qty: l.qty ? String(l.qty).replace('.', ',') : '',
      price_cur: l.price ? String(l.price).replace('.', ',') : l.total && l.qty ? String(Math.round(l.total / l.qty * 100) / 100).replace('.', ',') : '', product_id: l.match?.id ?? null, how: l.how }));
    rc.lines = [...rc.lines, ...fresh];
    rcSave();
    const sum = fresh.reduce((s, l) => s + (parseNum(l.price_cur) || 0) * (parseNum(l.qty) || 0), 0);
    const check = r.total && Math.abs(sum - r.total) > Math.max(1, r.total * 0.005) ? ` Внимание: сумма строк ${qtyFmt.format(Math.round(sum * 100) / 100)} не сходится с итогом накладной ${qtyFmt.format(r.total)} — проверьте строки.` : '';
    $('#rc-status').textContent = `Распознано строк: ${fresh.length}, найдено в базе: ${fresh.filter((l) => l.product_id).length}.${check}${r.notes ? ` Заметка: ${r.notes}` : ''}`;
    $('#rc-supplier').value = rc.supplier; $('#rc-number').value = rc.number; $('#rc-date').value = rc.date; $('#rc-currency').value = rc.currency;
    if (rc.currency !== 'KGS' && !rc.rate) toast('Укажите курс — цены пересчитаются в сомы', 'error');
    drawReceive();
  } catch (err) {
    $('#rc-status').textContent = '';
    toast(err.message, 'error');
  } finally {
    clearInterval(tick);
    btn.disabled = !rc.photos.length;
  }
});

// Поля шапки.
const rcField = (id, key, redraw = true) => $(id).addEventListener('input', (e) => { rc[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; rcSave(); if (redraw) drawReceiveLines(); });
rcField('#rc-supplier', 'supplier', false);
rcField('#rc-number', 'number', false);
rcField('#rc-date', 'date', false);
rcField('#rc-rate', 'rate');
rcField('#rc-markup', 'markup');
for (const [id, key] of [['#rc-markup-cost', 'markupCost'], ['#rc-update-prices', 'updatePrices'], ['#rc-expenses', 'recordExpenses']]) {
  $(id).addEventListener('change', (e) => { rc[key] = e.target.checked; rcSave(); drawReceiveLines(); });
}
$('#rc-currency').addEventListener('change', (e) => { rc.currency = e.target.value; rcSave(); drawReceive(); });
$('#rc-markup-mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  rc.mode = b.dataset.mode;
  rcSave();
  drawReceive();
});
$('#rc-extras').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]');
  if (!row || !e.target.dataset.extra) return;
  rc.extras[Number(row.dataset.i)][e.target.dataset.extra] = e.target.value;
  rcSave();
  drawReceiveLines();
});
$('#rc-extras').addEventListener('click', (e) => {
  const del = e.target.closest('[data-extra-del]');
  if (!del) return;
  rc.extras.splice(Number(del.dataset.extraDel), 1);
  rcSave();
  drawReceive();
});
$('#rc-extra-add').addEventListener('click', () => { rc.extras.push({ name: '', amount: '' }); drawReceive(); });
$('#rc-thumbs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-photo-del]');
  if (del) { rc.photos.splice(Number(del.dataset.photoDel), 1); drawReceive(); }
});

// Строки: числа пересчитываются по выходу из поля, чтобы не прыгал курсор.
$('#rc-lines').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-i]');
  const key = e.target.dataset.line;
  if (!tr || !key) return;
  const l = rc.lines[Number(tr.dataset.i)];
  if (key === 'product') {
    const v = e.target.value.trim();
    const p = catalog.sellable().find((x) => rcLabel(x) === v);
    if (p) { l.product_id = p.id; l.how = 'выбран вручную'; } else { l.product_id = null; l.name = v; l.how = ''; }
  } else {
    l[key] = e.target.value;
  }
  rcSave();
  drawReceiveLines();
});
$('#rc-lines').addEventListener('click', (e) => {
  const del = e.target.closest('[data-line-del]');
  if (!del) return;
  rc.lines.splice(Number(del.dataset.lineDel), 1);
  rcSave();
  drawReceiveLines();
});
$('#rc-line-add').addEventListener('click', () => {
  rc.lines.push({ name: '', qty: '1', price_cur: '', product_id: null, unit: 'шт' });
  rcSave();
  drawReceiveLines();
  document.querySelector('#rc-lines tr:last-child input')?.focus();
});
$('#rc-clear').addEventListener('click', () => {
  if (rc.lines.length && !confirm('Очистить строки и фото? Поставщик, курс и наценка останутся.')) return;
  Object.assign(rc, { lines: [], photos: [], number: '', supplier: '' });
  rcSave();
  $('#rc-status').textContent = '';
  renderReceive();
});

async function rcSubmit(post) {
  $('#rc-error').hidden = true;
  const { rows, rate } = rcCalc();
  if (!rows.length) return showFormError('#rc-error', new Error('Добавьте строки — распознайте фото или введите вручную'));
  if (rc.currency !== 'KGS' && !rate) return showFormError('#rc-error', new Error('Укажите курс валюты к сому'));
  const bad = rows.findIndex((r) => !r.qty || !(parseNum(r.l.price_cur) > 0) || (!r.p && !String(r.l.name || '').trim()));
  if (bad >= 0) return showFormError('#rc-error', new Error(`Строка ${bad + 1}: проверьте товар, количество и цену`));
  const noPrice = rows.filter((r) => !r.p && !(r.sale > 0)).length;
  if (noPrice && !confirm(`У ${noPrice} новых товаров нет цены продажи (не указана наценка). Оприходовать без цены?`)) return;
  const supplier = rcSuppliers.find((s) => s.name.toLowerCase() === rc.supplier.trim().toLowerCase());
  const body = {
    supplier_id: supplier?.id || null, supplier_name: supplier ? '' : rc.supplier.trim(), number: rc.number, date: rc.date ? fromDateInput(rc.date) + 12 * 36e5 : null,
    currency: rc.currency, rate, extras: rc.extras.map((e) => ({ name: e.name, amount: parseNum(e.amount) || 0 })),
    post, updatePrices: rc.updatePrices, recordExpenses: rc.recordExpenses,
    lines: rows.map((r) => ({ product_id: r.p?.id || null, name: r.p ? r.p.name : r.l.name, category: r.l.category || '', unit: r.l.unit || 'шт', barcode: r.l.barcode || '', article: r.l.article || '',
      qty: r.qty, price_cur: parseNum(r.l.price_cur) || 0, price: r.sale || 0 })),
  };
  for (const b of ['#rc-save', '#rc-save-draft']) $(b).disabled = true;
  try {
    const r = await api('/api/invoice/receive', { method: 'POST', body });
    toast(`${r.posted ? 'Оприходовано' : 'Сохранено черновиком'}: закупка №${r.doc.number}, строк ${r.lines}${r.created ? `, новых товаров ${r.created}` : ''}`);
    Object.assign(rc, { lines: [], photos: [], number: '', supplier: '' });
    rcSave();
    $('#rc-status').textContent = '';
    await catalog.load().catch(() => {});
    openDoc(r.doc.id);
  } catch (err) {
    showFormError('#rc-error', err);
  } finally {
    for (const b of ['#rc-save', '#rc-save-draft']) $(b).disabled = false;
  }
}
$('#rc-save').addEventListener('click', () => rcSubmit(true));
$('#rc-save-draft').addEventListener('click', () => rcSubmit(false));

$('#rc-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/invoice/key', { method: 'PUT', body: { key: e.target.elements.key.value } });
    e.target.reset();
    toast(r.configured ? 'Ключ сохранён — можно распознавать накладные' : 'Ключ убран');
    renderReceive();
  } catch (err) {
    toast(err.message, 'error');
  }
});

views.receive = { show: renderReceive, right: 'arrivals' };
