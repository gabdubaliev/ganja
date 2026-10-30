'use strict';

// Инвентаризация и списание.
// Инвентаризация: выбрать, что считаем (всё, категорию или выборочно), вписать или отсканировать факт —
// программа покажет недостачу и излишек, а после проведения остатки станут равны факту.
// Пересчёт может идти долго, поэтому черновик хранится в этом браузере, пока его не проведут или не отменят.
// Списание: товар, количество и причина — остаток уменьшается, потери видны по себестоимости.

const INV_KEY = 'inventory.draft';
const WRITEOFF_REASONS = ['Брак', 'Просрочка', 'Порча, бой', 'Недостача, кража', 'Для нужд магазина', 'Пересорт', 'Другое'];
const inv = { draft: null, filter: 'all' };
const wo = { lines: [], range: 'month' };

const num = (v) => (v === '' || v === null || v === undefined ? null : parseNum(v));
const numText = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const showExpected = () => session.can('stock.view');

/* ---------- Инвентаризация ---------- */
function saveDraft() {
  try { inv.draft ? localStorage.setItem(INV_KEY, JSON.stringify(inv.draft)) : localStorage.removeItem(INV_KEY); } catch {}
}
function loadDraft() {
  try { inv.draft = JSON.parse(localStorage.getItem(INV_KEY) || 'null'); } catch { inv.draft = null; }
  if (inv.draft) inv.draft.lines = inv.draft.lines.filter((l) => catalog.byId(l.productId));
}

// Начать: scope — 'all', 'cat' (с категорией) или 'pick' (товары добавляются поиском или сканером).
function startInventory(scope, category = '') {
  const items = scope === 'pick' ? [] : catalog.sellable().filter((p) => !p.archived && (scope === 'all' || (p.category || (p.parent_id && catalog.byId(p.parent_id)?.category)) === category));
  inv.draft = { scope, category, startedAt: Date.now(), lines: items.map((p) => ({ productId: p.id, actual: null })) };
  inv.filter = 'all';
  saveDraft();
  renderInventory();
  $('#inv-scan').focus();
}

function invLine(p) {
  let l = inv.draft.lines.find((x) => x.productId === p.id);
  if (!l) { l = { productId: p.id, actual: null }; inv.draft.lines.unshift(l); }
  return l;
}

function invCalc() {
  const rows = inv.draft.lines.map((l) => {
    const p = catalog.byId(l.productId);
    const diff = l.actual === null || p.stock === null ? null : Math.round((l.actual - p.stock) * 1000) / 1000;
    return { l, p, diff };
  });
  const counted = rows.filter((r) => r.l.actual !== null);
  const shortage = counted.filter((r) => r.diff < 0).reduce((s, r) => s - r.diff * r.p.cost, 0);
  const surplus = counted.filter((r) => r.diff > 0).reduce((s, r) => s + r.diff * r.p.cost, 0);
  return { rows, counted, shortage, surplus, mismatched: counted.filter((r) => r.diff).length };
}

function renderInventory() {
  const d = inv.draft;
  $('#inv-start').hidden = Boolean(d);
  $('#inv-editor').hidden = !d;
  if (!d) return;
  const c = invCalc();
  $('#inv-title').textContent = d.scope === 'all' ? 'Все товары' : d.scope === 'cat' ? `Категория «${d.category}»` : 'Выборочная инвентаризация';
  $('#inv-started').textContent = `начата ${dateTime(d.startedAt)}`;
  $('#inv-stats').innerHTML = `
    <div class="st-tile"><span>Посчитано</span><b class="num">${int(c.counted.length)} из ${int(c.rows.length)}</b><small>${c.rows.length - c.counted.length ? `осталось ${int(c.rows.length - c.counted.length)}` : 'всё посчитано'}</small></div>
    ${showExpected() ? `<div class="st-tile"><span>Расхождений</span><b class="num">${int(c.mismatched)}</b><small>товаров с разницей</small></div>
    <div class="st-tile bad"><span>Недостача</span><b class="num">${money(c.shortage)}</b><small>по себестоимости</small></div>
    <div class="st-tile good"><span>Излишек</span><b class="num">${money(c.surplus)}</b><small>по себестоимости</small></div>` : ''}`;
  $('#inv-filter').innerHTML = [['all', 'Все'], ['todo', 'Не посчитаны'], ...(showExpected() ? [['diff', 'С расхождением']] : [])]
    .map(([k, l]) => `<button type="button" class="chip" data-inv-filter="${k}" aria-pressed="${inv.filter === k}">${l}</button>`).join('');
  const q = $('#inv-find').value.trim().toLowerCase();
  const rows = c.rows.filter((r) => (inv.filter === 'todo' ? r.l.actual === null : inv.filter === 'diff' ? r.diff : true))
    .filter((r) => !q || r.p.name.toLowerCase().includes(q) || (r.p.barcode || '').includes(q) || (r.p.code || '').toLowerCase().includes(q));
  $('#inv-head').innerHTML = `<th>Товар</th>${showExpected() ? '<th>В программе</th>' : ''}<th>Факт</th>${showExpected() ? '<th>Разница</th><th>Разница, сом</th>' : ''}<th></th>`;
  $('#inv-lines').innerHTML = rows.length ? rows.slice(0, 300).map((r) => `
    <tr data-pid="${r.p.id}" class="${r.diff < 0 ? 'short' : r.diff > 0 ? 'over' : ''}">
      <td><div class="pname">${esc(r.p.name)}</div><div class="pcat">${esc([r.p.barcode, r.p.category].filter(Boolean).join(' · '))}</div></td>
      ${showExpected() ? `<td class="num">${qty(r.p.stock, r.p.unit)}</td>` : ''}
      <td><input class="input num" data-actual inputmode="decimal" value="${numText(r.l.actual)}" placeholder="—" aria-label="Факт: ${esc(r.p.name)}"></td>
      ${showExpected() ? `<td class="num ${r.diff < 0 ? 'neg' : r.diff > 0 ? 'pos-text' : ''}">${r.diff === null ? '' : `${r.diff > 0 ? '+' : ''}${qtyFmt.format(r.diff)}`}</td>
      <td class="num ${r.diff < 0 ? 'neg' : r.diff > 0 ? 'pos-text' : ''}">${r.diff ? `${r.diff > 0 ? '+' : '−'}${money(Math.abs(r.diff * r.p.cost))}` : ''}</td>` : ''}
      <td><button type="button" class="icon-btn" data-inv-remove aria-label="Убрать из инвентаризации">×</button></td>
    </tr>`).join('') + (rows.length > 300 ? `<tr><td colspan="6" class="empty">Показаны первые 300 — найдите остальные поиском</td></tr>` : '')
    : '<tr><td colspan="6" class="empty">Отсканируйте штрихкод или найдите товар — он появится здесь</td></tr>';
  $('#inv-save').disabled = !c.counted.length;
  $('#inv-zero-row').hidden = d.scope === 'pick';
}

// Сканер или поиск: найденный товар +1 к факту (или фокус на поле, если ввели название).
function invScan(value) {
  const code = value.trim();
  if (!code) return;
  const exact = catalog.sellable().find((p) => p.barcode === code || p.code === code);
  const found = exact ? [exact] : catalog.search(code, 2).filter((p) => !catalog.isGroup(p));
  if (found.length !== 1) return toast(found.length ? 'Найдено несколько товаров — уточните' : 'Товар не найден', 'error');
  const p = found[0];
  const l = invLine(p);
  if (exact) l.actual = (l.actual || 0) + 1;
  saveDraft();
  $('#inv-scan').value = '';
  inv.filter = 'all';
  $('#inv-find').value = '';
  renderInventory();
  const input = $(`#inv-lines tr[data-pid="${p.id}"] [data-actual]`);
  if (exact) {
    toast(`${p.name}: ${qtyFmt.format(l.actual)}`);
    $('#inv-scan').focus();
  } else input?.focus();
}

$('#inv-start').addEventListener('click', (e) => {
  const b = e.target.closest('[data-inv-scope]');
  if (!b) return;
  if (b.dataset.invScope === 'cat') {
    const cat = $('#inv-cat').value;
    if (!cat) return toast('Выберите категорию', 'error');
    return startInventory('cat', cat);
  }
  startInventory(b.dataset.invScope);
});
$('#inv-scan').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  invScan(e.target.value);
});
$('#inv-scan-btn').addEventListener('click', () => invScan($('#inv-scan').value));
$('#inv-find').addEventListener('input', renderInventory);
$('#inv-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-inv-filter]');
  if (!b) return;
  inv.filter = b.dataset.invFilter;
  renderInventory();
});
$('#inv-lines').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-pid]');
  if (!tr || !e.target.matches('[data-actual]')) return;
  const v = num(e.target.value);
  invLine(catalog.byId(tr.dataset.pid)).actual = v === null || Number.isNaN(v) ? null : Math.max(0, v);
  saveDraft();
  renderInventory();
});
$('#inv-lines').addEventListener('keydown', (e) => {
  // Enter — к следующему товару, как в Excel.
  if (e.key !== 'Enter' || !e.target.matches('[data-actual]')) return;
  e.preventDefault();
  const inputs = [...$('#inv-lines').querySelectorAll('[data-actual]')];
  const next = inputs[inputs.indexOf(e.target) + 1];
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
  const id = next?.closest('tr').dataset.pid;
  if (id) $(`#inv-lines tr[data-pid="${id}"] [data-actual]`)?.focus();
});
$('#inv-lines').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pid]');
  if (!tr || !e.target.closest('[data-inv-remove]')) return;
  inv.draft.lines = inv.draft.lines.filter((l) => l.productId !== Number(tr.dataset.pid));
  saveDraft();
  renderInventory();
});
$('#inv-cancel').addEventListener('click', (e) => {
  if (!e.target.classList.contains('danger')) { e.target.classList.add('danger'); e.target.textContent = 'Точно отменить? Посчитанное пропадёт'; return; }
  e.target.classList.remove('danger');
  e.target.textContent = 'Отменить инвентаризацию';
  inv.draft = null;
  saveDraft();
  renderInventory();
});
$('#inv-save').addEventListener('click', async () => {
  const zero = $('#inv-zero').checked && inv.draft.scope !== 'pick';
  const items = inv.draft.lines.filter((l) => l.actual !== null || zero).map((l) => ({ productId: l.productId, actual: l.actual ?? 0 }));
  try {
    const doc = await api('/api/inventory', { method: 'POST', body: { items, note: $('#inv-note').value } });
    toast(`Инвентаризация №${doc.id} проведена: ${doc.items.length} поз., недостача ${money(doc.shortage_cost)}, излишек ${money(doc.surplus_cost)}`);
    inv.draft = null;
    saveDraft();
    $('#inv-note').value = '';
    await catalog.load();
    renderInventory();
    renderStockHistory('inventory');
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------- История документов ---------- */
async function renderStockHistory(kind) {
  const el = kind === 'inventory' ? $('#inv-history') : $('#wo-history');
  try {
    const [from, to] = kind === 'inventory' ? [Date.now() - 365 * 864e5, Date.now() + 1] : RANGES[wo.range][1]();
    const r = await api(`/api/${kind === 'inventory' ? 'inventory' : 'writeoffs'}?from=${from}&to=${to}`);
    const docs = kind === 'inventory' ? r : r.docs;
    if (kind === 'writeoff') renderWriteoffSummary(r.summary);
    el.innerHTML = docs.length ? docs.map((d) => `
      <details class="doc">
        <summary>
          <span class="num">№${d.id}</span>
          <span>${dateTime(d.created_at)}</span>
          <span class="doc-who">${esc(d.user_name || '—')}${d.note ? ` · ${esc(d.note)}` : ''}</span>
          <span class="pick-meta">${d.items.length} ${plural(d.items.length, ['позиция', 'позиции', 'позиций'])}</span>
          ${kind === 'inventory'
            ? (d.shortage_cost || d.surplus_cost ? `<b class="num"><span class="neg">−${money(d.shortage_cost)}</span> / <span class="pos-text">+${money(d.surplus_cost)}</span></b>` : '<b class="pos-text">без расхождений</b>')
            : `<b class="num neg">−${money(d.total_cost)}</b>`}
        </summary>
        <ul>${d.items.map((i) => kind === 'inventory'
          ? `<li><span>${esc(i.name)}</span><span class="num">было ${qty(i.expected, i.unit)} → факт ${qty(i.actual, i.unit)} <b class="${i.qty < 0 ? 'neg' : i.qty > 0 ? 'pos-text' : ''}">${i.qty > 0 ? '+' : ''}${qtyFmt.format(i.qty)}</b>${i.qty ? ` (${i.qty > 0 ? '+' : '−'}${money(Math.abs(i.qty * i.cost))})` : ''}</span></li>`
          : `<li><span>${esc(i.name)} <span class="pick-meta">· ${esc(i.reason)}</span></span><span class="num">${qty(i.qty, i.unit)} × ${money2(i.cost)} = ${money2(i.qty * i.cost)}</span></li>`).join('')}</ul>
      </details>`).join('') : `<p class="empty">${kind === 'inventory' ? 'Инвентаризаций ещё не было' : 'За этот период списаний нет'}</p>`;
  } catch (err) { toast(err.message, 'error'); }
}

/* ---------- Списание ---------- */
function renderWriteoff() {
  const total = wo.lines.reduce((s, l) => s + (l.qty || 0) * catalog.byId(l.productId).cost, 0);
  $('#wo-lines').innerHTML = wo.lines.length ? wo.lines.map((l, i) => {
    const p = catalog.byId(l.productId);
    return `<tr data-i="${i}">
      <td><div class="pname">${esc(p.name)}</div>${p.stock === null ? '' : `<div class="pcat">на складе ${qty(p.stock, p.unit)}</div>`}</td>
      <td><input class="input num" data-wo="qty" inputmode="decimal" value="${numText(l.qty)}" placeholder="0" aria-label="Количество"></td>
      <td><select class="input" data-wo="reason" aria-label="Причина">${WRITEOFF_REASONS.map((r) => `<option ${r === l.reason ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td class="num">${money2((l.qty || 0) * p.cost)}</td>
      <td><button type="button" class="icon-btn" data-wo-remove aria-label="Убрать строку">×</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">Найдите товар или отсканируйте штрихкод</td></tr>';
  $('#wo-total').textContent = money2(total);
  $('#wo-save').disabled = !wo.lines.length;
}

function addWriteoffLine(p, reason = WRITEOFF_REASONS[0]) {
  const l = wo.lines.find((x) => x.productId === p.id);
  if (l) l.qty = (l.qty || 0) + 1;
  else wo.lines.push({ productId: p.id, qty: 1, reason });
  $('#wo-search').value = '';
  $('#wo-results').hidden = true;
  renderWriteoff();
  $(`#wo-lines tr[data-i="${wo.lines.findIndex((x) => x.productId === p.id)}"] [data-wo="qty"]`)?.select();
}

function renderWriteoffSummary(rows) {
  const total = rows.reduce((s, r) => s + r.cost, 0);
  renderRanges($('#wo-ranges'), ['week', 'month', 'prevMonth'], wo.range);
  $('#wo-summary').innerHTML = rows.length ? `<div class="st-tile bad"><span>Потери всего</span><b class="num">${money(total)}</b><small>по себестоимости · по цене ${money(rows.reduce((s, r) => s + r.price, 0))}</small></div>`
    + rows.map((r) => `<div class="st-tile"><span>${esc(r.reason || 'Без причины')}</span><b class="num">${money(r.cost)}</b><small>${int(r.lines)} ${plural(r.lines, ['строка', 'строки', 'строк'])}</small></div>`).join('') : '';
}

$('#wo-search').addEventListener('input', () => {
  const q = $('#wo-search').value;
  const list = catalog.search(q, 8).filter((p) => !catalog.isGroup(p));
  $('#wo-results').hidden = !q.trim();
  $('#wo-results').innerHTML = list.length ? list.map((p) => `<button type="button" class="suggest" data-id="${p.id}"><span>${esc(p.name)}</span>${p.stock === null ? '' : `<span class="pick-meta num">на складе ${qty(p.stock, p.unit)}</span>`}</button>`).join('')
    : '<p class="pick-meta" style="padding:8px 12px">Ничего не нашлось</p>';
});
$('#wo-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  const exact = catalog.sellable().find((p) => p.barcode === code || p.code === code);
  const found = exact ? [exact] : catalog.search(code, 2).filter((p) => !catalog.isGroup(p));
  if (found.length === 1) addWriteoffLine(found[0]);
});
$('#wo-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) addWriteoffLine(catalog.byId(b.dataset.id));
});
$('#wo-lines').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || !e.target.dataset.wo) return;
  const l = wo.lines[Number(tr.dataset.i)];
  if (e.target.dataset.wo === 'qty') l.qty = Math.max(0, parseNum(e.target.value) || 0);
  else l.reason = e.target.value;
  renderWriteoff();
});
$('#wo-lines').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || !e.target.closest('[data-wo-remove]')) return;
  wo.lines.splice(Number(tr.dataset.i), 1);
  renderWriteoff();
});
$('#wo-save').addEventListener('click', async () => {
  const empty = wo.lines.find((l) => !(l.qty > 0));
  if (empty) return toast(`Укажите количество для «${catalog.byId(empty.productId).name}»`, 'error');
  try {
    const doc = await api('/api/writeoffs', { method: 'POST', body: { items: wo.lines, note: $('#wo-note').value } });
    toast(`Списание №${doc.id} проведено на ${money2(doc.total_cost)} по себестоимости`);
    wo.lines = [];
    $('#wo-note').value = '';
    await catalog.load();
    renderWriteoff();
    renderStockHistory('writeoff');
  } catch (err) { toast(err.message, 'error'); }
});
$('#wo-ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  wo.range = b.dataset.range;
  renderStockHistory('writeoff');
});

// Из карточки товара: «Списать» добавляет товар в списание.
function writeoffProduct(p) {
  if (!wo.lines.some((l) => l.productId === p.id)) wo.lines.push({ productId: p.id, qty: 1, reason: WRITEOFF_REASONS[0] });
  location.hash = 'writeoff';
}

views.inventory = {
  async show() {
    try { await catalog.load(); } catch (err) { toast(err.message, 'error'); }
    loadDraft();
    const cats = [...new Set(catalog.list.filter((p) => !p.parent_id).map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    $('#inv-cat').innerHTML = '<option value="">Категория…</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    renderInventory();
    renderStockHistory('inventory');
  },
  right: 'stock',
};

views.writeoff = {
  async show() {
    try { await catalog.load(); } catch (err) { toast(err.message, 'error'); }
    wo.lines = wo.lines.filter((l) => catalog.byId(l.productId));
    renderWriteoff();
    renderStockHistory('writeoff');
    $('#wo-search').focus();
  },
  right: 'writeoff',
};
