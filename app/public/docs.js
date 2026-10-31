'use strict';

// Документы: продажа через админ-панель, закупка, возврат продажи, оприходование, списание,
// инвентаризация, перемещение. У каждого документа статус: «Не проведён» — черновик, остатки не меняются;
// «Проведён» — остатки (а для продажи — чек) изменились. Отметка снимается — всё возвращается как было.

const DOC_KIND = {
  sale: { name: 'Продажа', many: 'Продажи', icon: '🧾', right: 'docs.sale', about: 'Продажа через админ-панель: чек попадёт в продажи и отчёты' },
  purchase: { name: 'Закупка', many: 'Закупки', icon: '📦', right: 'arrivals', about: 'Товар от поставщика: остаток растёт, себестоимость пересчитывается' },
  return: { name: 'Возврат продажи', many: 'Возвраты', icon: '↩️', right: 'refund', about: 'Покупатель вернул товар: остаток растёт, деньги возвращены' },
  receipt: { name: 'Оприходование', many: 'Оприходования', icon: '➕', right: 'arrivals', about: 'Товар без поставщика: найденный, подарок, излишек' },
  writeoff: { name: 'Списание', many: 'Списания', icon: '🗑️', right: 'writeoff', about: 'Брак, просрочка, порча — остаток уменьшается' },
  inventory: { name: 'Инвентаризация', many: 'Инвентаризации', icon: '📋', right: 'stock', about: 'Пересчёт по факту: недостача и излишек' },
  transfer: { name: 'Перемещение', many: 'Перемещения', icon: '🚚', right: 'transfer', about: 'Товар в другой магазин: здесь убавится, там прибавится' },
};
const WRITEOFF_REASONS = ['Брак', 'Просрочка', 'Порча, бой', 'Недостача, кража', 'Для нужд магазина', 'Пересорт', 'Другое'];
const docsView = { kind: '', status: '', range: 'month', list: [] };
const doc = { data: null, dirty: false, methods: [], suppliers: [], branches: [], customer: null, filter: 'all' };

const docKinds = () => Object.keys(DOC_KIND).filter((k) => session.can(DOC_KIND[k].right));
const numText = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));
const docTitle = (d) => `${DOC_KIND[d.kind].name}${d.number ? ` №${d.number}` : ''}${d.direction === 'in' ? ' (входящее)' : ''}`;
const statusPill = (d) => `<span class="doc-status ${d.status}">${d.status === 'posted' ? '✓ Проведён' : 'Не проведён'}</span>`;
const isMoney = (k) => ['sale', 'return'].includes(k);
const isCost = (k) => ['purchase', 'receipt'].includes(k);

/* ---------- Список документов ---------- */
async function renderDocs() {
  const kinds = docKinds();
  if (docsView.kind && !kinds.includes(docsView.kind)) docsView.kind = '';
  $('#docs-kinds').innerHTML = [['', 'Все'], ...kinds.map((k) => [k, `${DOC_KIND[k].icon} ${DOC_KIND[k].many}`])]
    .map(([k, l]) => `<button type="button" class="chip" data-kind="${k}" aria-pressed="${docsView.kind === k}">${l}</button>`).join('');
  $('#docs-status').innerHTML = [['', 'Все'], ['posted', 'Проведённые'], ['draft', 'Не проведённые']]
    .map(([k, l]) => `<button type="button" data-status="${k}" aria-pressed="${docsView.status === k}">${l}</button>`).join('');
  renderRanges($('#docs-ranges'), ['week', 'month', 'prevMonth', 'year'].filter((k) => RANGES[k]), docsView.range);
  $('#docs-new').innerHTML = kinds.map((k) => `<button type="button" class="btn ${k === docsView.kind ? 'primary' : ''}" data-new="${k}">+ ${DOC_KIND[k].name}</button>`).join('');
  const [from, to] = RANGES[docsView.range][1]();
  try {
    docsView.list = await api(`/api/docs?from=${from}&to=${to}${docsView.kind ? '&kind=' + docsView.kind : ''}${docsView.status ? '&status=' + docsView.status : ''}`);
  } catch (err) { return toast(err.message, 'error'); }
  const list = docsView.list;
  const drafts = list.filter((d) => d.status === 'draft').length;
  $('#docs-sub').textContent = `${list.length} ${plural(list.length, ['документ', 'документа', 'документов'])}${drafts ? ` · не проведено ${drafts}` : ''}`;
  $('#docs-body').innerHTML = list.length ? list.map((d) => `
    <tr class="clickable ${d.status}" data-doc="${d.id}">
      <td><b>${DOC_KIND[d.kind].icon} ${esc(docTitle(d))}</b><div class="pcat">${esc(d.created_by || '')}</div></td>
      <td>${new Date(d.doc_date).toLocaleDateString('ru-RU')}<div class="pcat">${new Date(d.doc_date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div></td>
      <td>${statusPill(d)}</td>
      <td>${esc(d.supplier || d.customer || d.method || '') || '—'}${d.note ? `<div class="pcat">${esc(d.note)}</div>` : ''}</td>
      <td class="num">${int(d.lines)}</td>
      <td class="num">${d.kind === 'inventory' ? (d.status !== 'posted' ? '—' : d.shortage_cost || d.surplus_cost ? `${d.shortage_cost ? `<span class="neg">−${money(d.shortage_cost)}</span>` : ''}${d.shortage_cost && d.surplus_cost ? ' / ' : ''}${d.surplus_cost ? `<span class="pos-text">+${money(d.surplus_cost)}</span>` : ''}` : 'без расхождений') : money(isMoney(d.kind) ? d.total : d.total_cost || d.total)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">Документов за этот период нет</td></tr>';
}

$('#docs-kinds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  docsView.kind = b.dataset.kind;
  renderDocs();
});
$('#docs-status').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (!b) return;
  docsView.status = b.dataset.status;
  renderDocs();
});
$('#docs-ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  docsView.range = b.dataset.range;
  renderDocs();
});
$('#docs-new').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (b) newDoc(b.dataset.new);
});
$('#docs-body').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-doc]');
  if (tr) openDoc(Number(tr.dataset.doc));
});

/* ---------- Редактор документа ---------- */
function newDoc(kind, items = []) {
  doc.data = { id: null, kind, status: 'draft', doc_date: Date.now(), note: '', items, number: null };
  doc.customer = null;
  doc.dirty = items.length > 0;
  doc.filter = 'all';
  location.hash = 'doc';
  if (currentView === 'doc') showDoc();
}

async function openDoc(id) {
  try { doc.data = await api(`/api/docs/${id}`); } catch (err) { return toast(err.message, 'error'); }
  doc.customer = doc.data.customer_id ? { id: doc.data.customer_id, name: doc.data.customer } : null;
  doc.dirty = false;
  doc.filter = 'all';
  location.hash = 'doc';
  if (currentView === 'doc') showDoc();
}

// Строки редактора хранят productId и поля документа; названия берутся из справочника.
const docLines = () => doc.data.items.map((i) => ({ ...i, productId: i.productId ?? i.product_id }));

async function showDoc() {
  if (!doc.data) { location.hash = 'docs'; return; }
  try {
    await catalog.load();
    const k = doc.data.kind;
    if (['sale', 'return', 'purchase'].includes(k) && !doc.methods.length) doc.methods = await api('/api/payment-methods?mine=1');
    if (k === 'purchase') doc.suppliers = await api('/api/suppliers');
    if (k === 'transfer') doc.branches = await api('/api/branches').then((r) => r.branches.filter((b) => !b.current)).catch(() => []);
  } catch (err) { toast(err.message, 'error'); }
  doc.data.items = docLines();
  renderDoc();
}

const readOnly = () => doc.data.status === 'posted' || doc.data.direction === 'in';

function renderDoc() {
  const d = doc.data, k = d.kind, ro = readOnly();
  $('#doc-title').textContent = d.id ? docTitle(d) : `Новый документ: ${DOC_KIND[k].name}`;
  $('#doc-about').textContent = DOC_KIND[k].about;
  // Статус — переключатель: «Проведён» меняет остатки, «Не проведён» — нет.
  $('#doc-switch').innerHTML = `
    <button type="button" data-set-status="draft" aria-pressed="${d.status === 'draft'}">Не проведён</button>
    <button type="button" data-set-status="posted" aria-pressed="${d.status === 'posted'}">✓ Проведён</button>`;
  $('#doc-switch').classList.toggle('posted', d.status === 'posted');
  $('#doc-switch').title = d.status === 'posted' ? 'Изменения в остатках сделаны' : 'Остатки не меняются, пока документ не проведён';
  $('#doc-posted-note').innerHTML = d.status === 'posted'
    ? `Проведён ${d.posted_at ? dateTime(d.posted_at) : ''}${d.posted_by ? ` · ${esc(d.posted_by)}` : ''}${d.sale_id ? ` · чек №${d.sale_id}` : ''}. ${d.direction === 'in' ? 'Входящее перемещение меняет магазин-отправитель.' : 'Чтобы изменить документ, отметьте «Не проведён».'}`
    : 'Черновик: остатки не меняются, пока документ не проведён.';

  // Шапка документа.
  const fields = [`<div class="field"><label for="doc-date">Дата</label><input id="doc-date" type="datetime-local" class="input" value="${toLocalInput(d.doc_date)}" ${ro ? 'disabled' : ''}></div>`];
  if (k === 'purchase') {
    fields.push(`<div class="field"><label for="doc-supplier">Поставщик</label><div class="row-input"><select id="doc-supplier" class="input" ${ro ? 'disabled' : ''}>
      <option value="">— не указан —</option>${doc.suppliers.map((s) => `<option value="${s.id}" ${s.id === d.supplier_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      ${ro ? '' : '<button type="button" class="btn small" id="doc-supplier-new">+ Новый</button>'}</div></div>`);
  }
  if (['sale', 'return', 'purchase'].includes(k)) {
    fields.push(`<div class="field"><label for="doc-method">${k === 'sale' ? 'Способ оплаты' : k === 'return' ? 'Как вернули деньги' : 'Оплачено со счёта (необязательно)'}</label><select id="doc-method" class="input" ${ro ? 'disabled' : ''}>
      <option value="">${k === 'purchase' ? '— не оплачено / не учитывать —' : '— выберите —'}</option>${doc.methods.map((m) => `<option value="${m.id}" ${m.id === d.method_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`);
    if (k !== 'purchase') fields.push(`<div class="field"><label for="doc-customer-phone">Покупатель (необязательно)</label>${doc.customer
      ? `<div class="row-input"><b class="doc-customer">${esc(doc.customer.name || '')}</b>${ro ? '' : '<button type="button" class="btn small ghost" id="doc-customer-clear">Убрать</button>'}</div>`
      : ro ? '<span class="pick-meta">—</span>' : '<div class="row-input"><input id="doc-customer-phone" class="input" inputmode="tel" placeholder="Телефон" autocomplete="off"><button type="button" class="btn small" id="doc-customer-find">Найти</button></div>'}</div>`);
  }
  if (k === 'transfer') {
    fields.push(`<div class="field"><label for="doc-branch">Куда переместить</label>${doc.branches.length || d.branch_to
      ? `<select id="doc-branch" class="input" ${ro ? 'disabled' : ''}><option value="">— магазин —</option>${doc.branches.map((b) => `<option value="${b.id}" ${b.id === d.branch_to ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}${d.branch_to && !doc.branches.some((b) => b.id === d.branch_to) ? `<option value="${d.branch_to}" selected>Магазин №${d.branch_to}</option>` : ''}</select>`
      : '<p class="pick-meta">Другой магазин ещё не заведён: «Ещё» → «Магазины».</p>'}</div>`);
  }
  fields.push(`<div class="field grow"><label for="doc-note">Комментарий</label><input id="doc-note" class="input" value="${esc(d.note || '')}" autocomplete="off" ${ro ? 'disabled' : ''} placeholder="${k === 'receipt' ? 'Основание, например: найдено при уборке' : ''}"></div>`);
  $('#doc-head').innerHTML = fields.join('');

  // Строки.
  $('#doc-add').hidden = ro;
  $('#doc-fill').hidden = ro || k !== 'inventory';
  if (k === 'inventory' && !ro) {
    const cats = [...new Set(catalog.list.filter((p) => !p.parent_id).map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    $('#doc-fill-cat').innerHTML = '<option value="">Категория…</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  }
  const showStock = session.can('stock.view');
  const cols = {
    sale: ['Товар', 'Кол-во', 'Цена', 'Сумма'],
    return: ['Товар', 'Кол-во', 'Цена возврата', 'Сумма'],
    purchase: ['Товар', 'Кол-во', 'Закупочная цена', 'Сумма'],
    receipt: ['Товар', 'Кол-во', 'Цена закупки', 'Сумма'],
    writeoff: ['Товар', ...(showStock ? ['Остаток'] : []), 'Кол-во', 'Причина', 'По себестоимости'],
    inventory: ['Товар', ...(showStock ? ['В программе'] : []), 'Факт', ...(showStock ? ['Разница', 'Разница, сом'] : [])],
    transfer: ['Товар', ...(showStock ? ['Остаток'] : []), 'Кол-во', 'На сумму'],
  }[k];
  $('#doc-cols').innerHTML = cols.map((c) => `<th>${c}</th>`).join('') + (ro ? '' : '<th></th>');
  let lines = d.items.map((l, i) => ({ l, i, p: catalog.byId(l.productId) }));
  // Инвентаризация: в проведённом документе «было» из документа, в черновике — текущий остаток.
  const expectedOf = ({ l, p }) => (ro ? l.expected : p?.stock ?? null);
  const diffOf = (x) => (x.l.actual === null || x.l.actual === undefined || expectedOf(x) === null ? null : Math.round((x.l.actual - expectedOf(x)) * 1000) / 1000);
  if (k === 'inventory') {
    $('#doc-filter').hidden = false;
    $('#doc-filter').innerHTML = [['all', 'Все'], ['todo', 'Не посчитаны'], ...(showStock ? [['diff', 'С расхождением']] : [])]
      .map(([f, l]) => `<button type="button" class="chip" data-doc-filter="${f}" aria-pressed="${doc.filter === f}">${l}</button>`).join('');
    if (doc.filter === 'todo') lines = lines.filter((x) => x.l.actual === null || x.l.actual === undefined);
    if (doc.filter === 'diff') lines = lines.filter((x) => diffOf(x));
  } else $('#doc-filter').hidden = true;
  const input = (field, value, label) => (ro ? `<span class="num">${field === 'reason' ? esc(value || '—') : numText(value) || '—'}</span>`
    : `<input class="input num" data-line="${field}" inputmode="decimal" value="${numText(value)}" placeholder="${field === 'actual' ? '—' : '0'}" aria-label="${label}">`);
  $('#doc-lines').innerHTML = lines.length ? lines.slice(0, 400).map((x) => {
    const { l, i, p } = x;
    const name = `<div class="pname">${esc(p?.name || l.name)}</div><div class="pcat">${esc([p?.barcode, p?.unit || l.unit].filter(Boolean).join(' · '))}</div>`;
    const unitPrice = isMoney(k) ? l.price : l.cost ?? p?.cost ?? 0;
    let cells;
    if (isMoney(k) || isCost(k)) {
      cells = [name, input('qty', l.qty, 'Количество'), input(isMoney(k) ? 'price' : 'cost', unitPrice, 'Цена'), `<span class="num">${money2((l.qty || 0) * (unitPrice || 0))}</span>`];
    } else if (k === 'writeoff') {
      cells = [name, ...(showStock ? [`<span class="num">${p ? qty(p.stock, p.unit) : ''}</span>`] : []), input('qty', l.qty, 'Количество'),
        ro ? esc(l.reason || '—') : `<select class="input" data-line="reason" aria-label="Причина">${WRITEOFF_REASONS.map((r) => `<option ${r === (l.reason || WRITEOFF_REASONS[0]) ? 'selected' : ''}>${r}</option>`).join('')}</select>`,
        `<span class="num">${money2((l.qty || 0) * (l.cost ?? p?.cost ?? 0))}</span>`];
    } else if (k === 'inventory') {
      const diff = diffOf(x), cost = l.cost || p?.cost || 0;
      cells = [name, ...(showStock ? [`<span class="num">${expectedOf(x) === null ? '—' : qtyFmt.format(expectedOf(x))}</span>`] : []), input('actual', l.actual, 'Факт'),
        ...(showStock ? [`<span class="num ${diff < 0 ? 'neg' : diff > 0 ? 'pos-text' : ''}">${diff === null ? '' : `${diff > 0 ? '+' : ''}${qtyFmt.format(diff)}`}</span>`,
          `<span class="num ${diff < 0 ? 'neg' : diff > 0 ? 'pos-text' : ''}">${diff ? `${diff > 0 ? '+' : '−'}${money(Math.abs(diff * cost))}` : ''}</span>`] : [])];
    } else {
      cells = [name, ...(showStock ? [`<span class="num">${p ? qty(p.stock, p.unit) : ''}</span>`] : []), input('qty', l.qty, 'Количество'), `<span class="num">${money2((l.qty || 0) * (l.price ?? p?.price ?? 0))}</span>`];
    }
    return `<tr data-i="${i}">${cells.map((c) => `<td>${c}</td>`).join('')}${ro ? '' : '<td><button type="button" class="icon-btn" data-line-remove aria-label="Убрать строку">×</button></td>'}</tr>`;
  }).join('') + (lines.length > 400 ? '<tr><td colspan="7" class="empty">Показаны первые 400 строк — найдите остальные поиском</td></tr>' : '')
    : `<tr><td colspan="7" class="empty">${ro ? 'Строк нет' : 'Отсканируйте штрихкод или найдите товар выше'}</td></tr>`;

  // Итоги.
  const items = d.items.map((l) => ({ l, p: catalog.byId(l.productId) }));
  let total;
  if (k === 'inventory') {
    const xs = items.map((x) => ({ ...x, diff: diffOf(x) }));
    const counted = xs.filter((x) => x.l.actual !== null && x.l.actual !== undefined);
    const shortage = ro ? d.shortage_cost : counted.filter((x) => x.diff < 0).reduce((s, x) => s - x.diff * (x.p?.cost || 0), 0);
    const surplus = ro ? d.surplus_cost : counted.filter((x) => x.diff > 0).reduce((s, x) => s + x.diff * (x.p?.cost || 0), 0);
    total = `Посчитано <b>${int(counted.length)} из ${int(items.length)}</b>${showStock ? ` · недостача <b class="neg">${money(shortage)}</b> · излишек <b class="pos-text">${money(surplus)}</b>` : ''}`;
  } else {
    const sum = items.reduce((s, { l, p }) => s + (l.qty || 0) * (isMoney(k) ? l.price ?? p?.price ?? 0 : k === 'transfer' ? l.price ?? p?.price ?? 0 : l.cost ?? p?.cost ?? 0), 0);
    total = `${int(items.filter((x) => x.l.qty > 0).length)} ${plural(items.length, ['позиция', 'позиции', 'позиций'])} · итого <b class="num">${money2(sum)}</b>${k === 'writeoff' ? ' по себестоимости' : ''}`;
  }
  $('#doc-total').innerHTML = total;
  $('#doc-save').hidden = ro;
  $('#doc-save').textContent = doc.dirty ? 'Сохранить черновик •' : 'Сохранить черновик';
  $('#doc-delete').hidden = ro || !d.id;
}

// Значение для <input type="datetime-local"> в местном времени.
function toLocalInput(t) {
  const x = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

function readHead() {
  const d = doc.data;
  const date = $('#doc-date')?.value;
  if (date) d.doc_date = new Date(date).getTime();
  d.note = $('#doc-note')?.value ?? d.note;
  if ($('#doc-supplier')) d.supplier_id = Number($('#doc-supplier').value) || null;
  if ($('#doc-method')) d.method_id = Number($('#doc-method').value) || null;
  if ($('#doc-branch')) d.branch_to = Number($('#doc-branch').value) || null;
  d.customer_id = doc.customer?.id || null;
}

function docBody() {
  readHead();
  const d = doc.data;
  return {
    kind: d.kind, doc_date: d.doc_date, note: d.note, supplier_id: d.supplier_id, method_id: d.method_id, branch_to: d.branch_to, customer_id: d.customer_id,
    items: d.items.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price, cost: l.cost, actual: l.actual, reason: l.reason || (d.kind === 'writeoff' ? WRITEOFF_REASONS[0] : '') })),
  };
}

async function saveDoc({ post = false, quiet = false } = {}) {
  const d = doc.data;
  try {
    const saved = await api(d.id ? `/api/docs/${d.id}` : '/api/docs', { method: d.id ? 'PUT' : 'POST', body: { ...docBody(), post } });
    doc.data = { ...saved, items: saved.items.map((i) => ({ ...i, productId: i.product_id })) };
    doc.dirty = false;
    if (!quiet) toast(post ? `Документ «${docTitle(saved)}» проведён — остатки изменены` : `Документ «${docTitle(saved)}» сохранён, не проведён`);
    if (post) await catalog.load();
    renderDoc();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function addDocProduct(p, { scan = false } = {}) {
  if (catalog.isGroup(p)) return toast('У товара есть модификации — выберите нужную', 'error');
  const k = doc.data.kind;
  let l = doc.data.items.find((x) => x.productId === p.id);
  if (!l) {
    l = { productId: p.id, qty: k === 'inventory' ? 0 : scan ? 0 : 1, price: k === 'sale' ? salePrice(p) : p.price, cost: ['purchase', 'receipt'].includes(k) ? p.purchase ?? p.cost : p.cost, actual: null, reason: k === 'writeoff' ? WRITEOFF_REASONS[0] : '' };
    doc.data.items.unshift(l);
  }
  // Каждый скан — +1: к факту в инвентаризации, к количеству в остальных документах.
  if (scan) {
    if (k === 'inventory') l.actual = (l.actual || 0) + 1;
    else l.qty = (l.qty || 0) + 1;
  }
  doc.dirty = true;
  $('#doc-search').value = '';
  $('#doc-results').hidden = true;
  renderDoc();
  const row = doc.data.items.indexOf(l);
  const field = $(`#doc-lines tr[data-i="${row}"] [data-line]`);
  if (scan) $('#doc-search').focus(); else field?.select();
}

$('#doc-search').addEventListener('input', () => {
  const q = $('#doc-search').value;
  const list = catalog.search(q, 8).filter((p) => !catalog.isGroup(p));
  $('#doc-results').hidden = !q.trim();
  $('#doc-results').innerHTML = list.length ? list.map((p) => `<button type="button" class="suggest" data-id="${p.id}"><span>${esc(p.name)}</span><span class="pick-meta num">${money2(p.price)}${p.stock === null ? '' : ` · ${qty(p.stock, p.unit)}`}</span></button>`).join('')
    : '<p class="pick-meta" style="padding:8px 12px">Ничего не нашлось</p>';
});
$('#doc-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  if (!code) return;
  const exact = catalog.sellable().find((p) => p.barcode === code || p.code === code);
  if (exact) return addDocProduct(exact, { scan: true });
  const found = catalog.search(code, 2).filter((p) => !catalog.isGroup(p));
  if (found.length === 1) addDocProduct(found[0]);
  else toast(found.length ? 'Найдено несколько — выберите из списка' : 'Товар не найден', 'error');
});
$('#doc-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) addDocProduct(catalog.byId(b.dataset.id));
});
$('#doc-lines').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-i]');
  const field = e.target.dataset.line;
  if (!tr || !field) return;
  const l = doc.data.items[Number(tr.dataset.i)];
  if (field === 'reason') l.reason = e.target.value;
  else {
    const v = e.target.value.trim() === '' ? null : Math.max(0, parseNum(e.target.value) || 0);
    l[field] = field === 'actual' ? v : v || 0;
  }
  doc.dirty = true;
  renderDoc();
});
$('#doc-lines').addEventListener('keydown', (e) => {
  // Enter — к следующей строке, как в Excel.
  if (e.key !== 'Enter' || !e.target.dataset.line) return;
  e.preventDefault();
  const field = e.target.dataset.line;
  const rows = [...$('#doc-lines').querySelectorAll(`[data-line="${field}"]`)];
  const nextRow = rows[rows.indexOf(e.target) + 1]?.closest('tr').dataset.i;
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
  if (nextRow !== undefined) $(`#doc-lines tr[data-i="${nextRow}"] [data-line="${field}"]`)?.select();
});
$('#doc-lines').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || !e.target.closest('[data-line-remove]')) return;
  doc.data.items.splice(Number(tr.dataset.i), 1);
  doc.dirty = true;
  renderDoc();
});
$('#doc-head').addEventListener('change', () => { doc.dirty = true; readHead(); $('#doc-save').textContent = 'Сохранить черновик •'; });
$('#doc-head').addEventListener('click', async (e) => {
  if (e.target.closest('#doc-customer-clear')) { doc.customer = null; doc.dirty = true; return renderDoc(); }
  if (e.target.closest('#doc-customer-find')) {
    readHead();
    try {
      const c = await api('/api/customers/by-phone?phone=' + encodeURIComponent($('#doc-customer-phone').value));
      if (!c) return toast('Покупатель с таким телефоном не найден', 'error');
      doc.customer = { id: c.id, name: c.name || phoneFmt(c.phone) };
      doc.dirty = true;
      renderDoc();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (e.target.closest('#doc-supplier-new')) openSupplier(null, async (s) => {
    readHead();
    doc.suppliers = await api('/api/suppliers');
    doc.data.supplier_id = s.id;
    doc.dirty = true;
    renderDoc();
  });
});
$('#doc-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-doc-filter]');
  if (!b) return;
  doc.filter = b.dataset.docFilter;
  renderDoc();
});
$('#doc-fill').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fill]');
  if (!b) return;
  const cat = $('#doc-fill-cat').value;
  if (b.dataset.fill === 'cat' && !cat) return toast('Выберите категорию', 'error');
  const catOf = (p) => p.category || (p.parent_id ? catalog.byId(p.parent_id)?.category : '');
  const add = catalog.sellable().filter((p) => !p.archived && (b.dataset.fill === 'all' || catOf(p) === cat))
    .filter((p) => !doc.data.items.some((l) => l.productId === p.id));
  for (const p of add) doc.data.items.push({ productId: p.id, qty: 0, price: p.price, cost: p.cost, actual: null, reason: '' });
  doc.dirty = true;
  toast(`Добавлено товаров: ${add.length}`);
  renderDoc();
});
$('#doc-switch').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-set-status]');
  if (!b || b.dataset.setStatus === doc.data.status) return;
  if (b.dataset.setStatus === 'posted') {
    if (doc.data.direction === 'in') return;
    if (doc.data.kind === 'inventory' && !doc.data.items.some((l) => l.actual !== null && l.actual !== undefined)) return toast('Сначала посчитайте хотя бы один товар', 'error');
    return saveDoc({ post: true });
  }
  if (!session.can('docs.unpost')) return toast('Отменять проведение может сотрудник с правом «Отменять проведение документов»', 'error');
  try {
    const d = await api(`/api/docs/${doc.data.id}/unpost`, { method: 'POST' });
    doc.data = { ...d, items: d.items.map((i) => ({ ...i, productId: i.product_id })) };
    toast(`Документ «${docTitle(d)}»: проведение отменено, остатки вернулись`);
    await catalog.load();
    renderDoc();
  } catch (err) { toast(err.message, 'error'); }
});
$('#doc-save').addEventListener('click', () => saveDoc());
$('#doc-back').addEventListener('click', () => { location.hash = 'docs'; });
$('#doc-delete').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('danger')) { e.target.classList.add('danger'); e.target.textContent = 'Удалить черновик?'; return; }
  try {
    await api(`/api/docs/${doc.data.id}`, { method: 'DELETE' });
    toast('Черновик удалён');
    doc.data = null;
    location.hash = 'docs';
  } catch (err) { toast(err.message, 'error'); }
  e.target.classList.remove('danger');
  e.target.textContent = 'Удалить';
});
// Несохранённый черновик не теряется молча при закрытии вкладки.
addEventListener('beforeunload', (e) => { if (currentView === 'doc' && doc.dirty) e.preventDefault(); });

// Из карточки товара: «Списать» — новый документ списания с этим товаром.
function writeoffProduct(p) {
  newDoc('writeoff', [{ productId: p.id, qty: 1, price: p.price, cost: p.cost, actual: null, reason: WRITEOFF_REASONS[0] }]);
}

/* ---------- Поставщики ---------- */
let supplierDone = null;
async function renderSuppliers() {
  let list;
  try { list = await api('/api/suppliers'); } catch (err) { return toast(err.message, 'error'); }
  $('#suppliers-add').hidden = !session.can('arrivals');
  $('#suppliers-body').innerHTML = list.length ? list.map((s) => `
    <tr class="clickable" data-supplier="${s.id}">
      <td><b>${esc(s.name)}</b>${s.contact ? `<div class="pcat">${esc(s.contact)}</div>` : ''}</td>
      <td>${s.phone ? esc(s.phone) : '—'}</td>
      <td>${esc(s.inn || '—')}</td>
      <td class="num">${int(s.docs)}</td>
      <td class="num">${money(s.total)}</td>
      <td>${s.last_at ? new Date(s.last_at).toLocaleDateString('ru-RU') : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">Поставщиков пока нет</td></tr>';
  renderSuppliers.list = list;
}

function openSupplier(s, done = null) {
  supplierDone = done;
  const f = $('#supplier-form');
  f.reset();
  f.dataset.id = s?.id || '';
  for (const k of ['name', 'phone', 'contact', 'inn', 'address', 'note']) f.elements[k].value = s?.[k] || '';
  $('#supplier-title').textContent = s ? s.name : 'Новый поставщик';
  $('#supplier-delete').hidden = !s;
  $('#supplier-error').hidden = true;
  $('#supplier-dialog').showModal();
  f.elements.name.focus();
}

$('#suppliers-add').addEventListener('click', () => openSupplier(null, renderSuppliers));
$('#suppliers-body').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-supplier]');
  if (tr && session.can('arrivals')) openSupplier(renderSuppliers.list.find((s) => s.id === Number(tr.dataset.supplier)), renderSuppliers);
});
$('#supplier-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['name', 'phone', 'contact', 'inn', 'address', 'note'].map((k) => [k, f.elements[k].value]));
  try {
    const s = await api(f.dataset.id ? `/api/suppliers/${f.dataset.id}` : '/api/suppliers', { method: f.dataset.id ? 'PUT' : 'POST', body });
    $('#supplier-dialog').close();
    toast('Поставщик сохранён');
    supplierDone?.(s);
  } catch (err) { showFormError('#supplier-error', err); }
});
$('#supplier-cancel').addEventListener('click', () => $('#supplier-dialog').close());
$('#supplier-delete').addEventListener('click', async () => {
  try {
    await api(`/api/suppliers/${$('#supplier-form').dataset.id}`, { method: 'DELETE' });
    $('#supplier-dialog').close();
    toast('Поставщик удалён');
    renderSuppliers();
  } catch (err) { showFormError('#supplier-error', err); }
});

const DOC_RIGHTS = Object.values(DOC_KIND).map((k) => k.right);
views.docs = { show: renderDocs, right: DOC_RIGHTS };
views.doc = { show: showDoc, right: DOC_RIGHTS };
views.suppliers = { show: renderSuppliers, right: ['arrivals', 'transfer', 'stock', 'writeoff'] };
