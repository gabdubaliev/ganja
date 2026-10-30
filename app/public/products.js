'use strict';

// Товары: справочник, добавление, изменение, инвентаризация.

const productsView = { archived: false, query: '', category: '', selected: new Set(), rows: [] };
// Справочник категорий: для фильтра, карточки товара и переноса.
const categories = {
  list: [],
  async load() { this.list = await api('/api/categories'); return this.list; },
  names() { return this.list.map((c) => c.name); },
  options(selected = '', empty = 'Без категории') {
    return `<option value="">${empty}</option>` + this.list.map((c) => `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  },
};

function markup(p) {
  return p.cost > 0 ? (p.price - p.cost) / p.cost : null;
}

async function renderProducts() {
  let list;
  try {
    [list] = await Promise.all([productsView.archived ? api('/api/products?archived=1') : catalog.load(), categories.load()]);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const q = productsView.query.trim().toLowerCase();
  const byId = new Map(list.map((p) => [p.id, p]));
  const kids = new Map();
  for (const p of list) if (p.parent_id) kids.set(p.parent_id, [...(kids.get(p.parent_id) || []), p]);
  // Модификации идут сразу под своим товаром.
  const sortKey = (p) => (p.parent_id ? `${byId.get(p.parent_id)?.name ?? ''}\u0001${p.name}` : p.name).toLowerCase();
  // Фильтр по категории: модификации идут за своим товаром.
  const catOf = (p) => (p.parent_id ? byId.get(p.parent_id)?.category ?? p.category : p.category);
  const rows = list
    .filter((p) => !productsView.category || (productsView.category === '—' ? !catOf(p) : catOf(p) === productsView.category))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'ru'));
  productsView.rows = rows;
  renderCategoryFilter();
  // Выбранными остаются только товары, которые есть в этом списке.
  const ids = new Set(list.map((p) => p.id));
  for (const id of productsView.selected) if (!ids.has(id)) productsView.selected.delete(id);
  const canEdit = session.can('products');
  const stockValue = list.reduce((s, p) => s + Math.max(0, p.stock) * p.cost, 0);
  const goods = list.filter((p) => !p.parent_id).length;
  $('#products-summary').textContent = productsView.archived
    ? `Скрыто товаров: ${list.length}`
    : `${goods} ${plural(goods, ['товар', 'товара', 'товаров'])}${list.length > goods ? `, ${list.length - goods} ${plural(list.length - goods, ['модификация', 'модификации', 'модификаций'])}` : ''}${session.can('stock.view') ? ` · товара на складе по себестоимости на ${money(stockValue)}` : ''}`;
  $('#products-body').innerHTML = rows.length ? rows.map((p) => {
    const m = markup(p);
    const children = kids.get(p.id) || [];
    const group = children.length > 0;
    const stock = group ? children.reduce((sum, k) => sum + k.stock, 0) : p.stock;
    const prices = group ? children.map((k) => k.price) : [p.price];
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const name = p.parent_id
      ? `<div class="pname">${esc(optionsText(p))}</div><div class="pcat">${esc(byId.get(p.parent_id)?.name ?? '')}</div>`
      : `<div class="pname">${esc(p.name)}${group ? ` <span class="role-tag">${children.length} ${plural(children.length, ['модификация', 'модификации', 'модификаций'])}</span>` : ''}</div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : ''}`;
    return `<tr class="${productsView.selected.has(p.id) ? 'selected' : ''} ${p.parent_id ? 'variant-row' : ''}">
      ${canEdit ? `<td class="sel"><input type="checkbox" data-select="${p.id}" ${productsView.selected.has(p.id) ? 'checked' : ''} aria-label="Выбрать ${esc(p.name)}"></td>` : ''}
      <td class="name-col"><div class="with-thumb">${photoCell(p)}<div>${name}</div></div></td>
      <td class="num">${group ? '' : esc(p.code) || '—'}</td>
      <td class="num">${group ? '' : esc(p.barcode) || '—'}</td>
      <td>${lo === hi ? money2(lo) : `${money2(lo)} – ${money2(hi)}`}</td>
      <td>${p.cost ? money2(p.cost) : '—'}</td>
      <td>${group || m === null ? '—' : pct(m)}</td>
      <td class="${stock !== null && stock <= 0 ? 'neg' : ''}">${p.stock === null ? '—' : qty(stock, p.unit)}</td>
      <td><div class="actions">
        ${canEdit ? `<button type="button" class="btn small ghost" data-edit="${p.id}">Изменить</button>` : ''}
        ${productsView.archived || group || !session.can('stock') ? '' : `<button type="button" class="btn small ghost" data-stock="${p.id}">Пересчитать</button>`}
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="empty">${list.length ? 'Ничего не нашлось' : productsView.archived ? 'Скрытых товаров нет' : 'Товаров пока нет. Нажмите «Добавить товар» или загрузите их из Excel.'}</td></tr>`;
  renderBulkBar();
}

function renderBulkBar() {
  const n = productsView.selected.size;
  $('#bulk-bar').hidden = !n;
  $('#bulk-count').textContent = `Выбрано: ${n}`;
  $('#bulk-archive').hidden = productsView.archived;
  $('#bulk-restore').hidden = !productsView.archived;
  const all = $('#products-all');
  const visible = productsView.rows.filter((p) => productsView.selected.has(p.id)).length;
  all.checked = visible > 0 && visible === productsView.rows.length;
  all.indeterminate = visible > 0 && visible < productsView.rows.length;
}

/* ---------- Групповые действия ---------- */
const BULK = {
  price: { title: 'Изменить цену', fields: 'price' },
  cost: { title: 'Изменить себестоимость', fields: 'price' },
  category: { title: 'Сменить категорию', fields: 'category' },
  unit: { title: 'Сменить единицу', fields: 'unit' },
  barcodes: { title: 'Создать штрихкоды', confirm: 'Товарам без штрихкода будет присвоен свой уникальный штрихкод EAN-13 (начинается на 20 — так обозначают внутренние коды магазина). Существующие штрихкоды не меняются.' },
  archive: { title: 'Убрать из продажи', confirm: 'Товары скроются из кассы и витрины. История продаж сохранится, вернуть их можно в любой момент.' },
  restore: { title: 'Вернуть в продажу', confirm: 'Товары снова появятся в кассе и на витрине.' },
  delete: { title: 'Удалить товары', confirm: 'Товары пропадут из всех списков. Если по товару были продажи или приходы, история по нему останется в отчётах. Отменить удаление нельзя.', danger: true },
};
let bulkAction = null;

function openBulk(action) {
  bulkAction = action;
  const b = BULK[action];
  const n = productsView.selected.size;
  $('#bulk-title').textContent = b.title;
  $('#bulk-sub').textContent = b.confirm || `${n} ${plural(n, ['товар', 'товара', 'товаров'])}`;
  $('#bulk-error').hidden = true;
  $('#bulk-submit').className = 'btn ' + (b.danger ? 'danger' : 'primary');
  $('#bulk-submit').textContent = b.danger ? `Удалить ${n}` : 'Применить';
  const cats = categories.names();
  $('#bulk-fields').innerHTML = {
    price: `
      <div class="field wide"><label for="bf-mode">Как изменить</label>
        <select id="bf-mode" name="mode" class="input">
          <option value="percent">Изменить на процент (минус — снизить)</option>
          <option value="add">Прибавить сумму в сомах (минус — вычесть)</option>
          <option value="set">Поставить одну цену всем</option>
          ${action === 'price' ? '<option value="markup">Наценка от себестоимости, %</option>' : ''}
        </select></div>
      <div class="field wide"><label for="bf-value">Значение</label><input id="bf-value" name="value" class="input num" inputmode="decimal" autocomplete="off" placeholder="Например, 10 или -5"></div>`,
    category: `<div class="field wide"><label for="bf-value">Перенести в категорию</label><select id="bf-value" name="value" class="input">${categories.options('', 'Без категории')}<option value="__new">+ Новая категория…</option></select></div>
      <div class="field wide" id="bf-new-field" hidden><label for="bf-new">Название новой категории</label><input id="bf-new" name="newCategory" class="input" autocomplete="off"></div>`,
    unit: `<div class="field wide"><label for="bf-value">Единица</label><select id="bf-value" name="value" class="input"><option>шт</option><option>кг</option><option>л</option><option>м</option><option>уп</option></select></div>`,
  }[b.fields] || '';
  $('#bulk-dialog').showModal();
  $('#bf-value')?.focus();
}

$('#bulk-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (btn) openBulk(btn.dataset.bulk);
});
$('#bulk-labels').addEventListener('click', async () => {
  const list = productsView.archived ? await api('/api/products?archived=1') : catalog.list;
  // Этикетки печатаются на то, что лежит на полке: основной товар заменяется его модификациями.
  const ids = new Set();
  for (const id of productsView.selected) {
    const kids = list.filter((p) => p.parent_id === id);
    if (kids.length) kids.forEach((k) => ids.add(k.id)); else ids.add(id);
  }
  openLabels(list.filter((p) => ids.has(p.id)));
});
$('#bulk-clear').addEventListener('click', () => { productsView.selected.clear(); renderProducts(); });
$('#bulk-cancel').addEventListener('click', () => $('#bulk-dialog').close());
$('#bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { ids: [...productsView.selected], action: bulkAction };
  if (f.elements.value) body.value = f.elements.value.value.replace(/[−–—]/g, '-');
  if (body.value === '__new') body.value = f.elements.newCategory.value.trim();
  if (f.elements.mode) body.mode = f.elements.mode.value;
  try {
    const result = await api('/api/products/bulk', { method: 'POST', body });
    $('#bulk-dialog').close();
    toast(`${BULK[bulkAction].title}: готово, ${result.count} ${plural(result.count, ['товар', 'товара', 'товаров'])}`);
    if (['delete', 'archive', 'restore'].includes(bulkAction)) productsView.selected.clear();
    renderProducts();
  } catch (err) {
    showFormError('#bulk-error', err);
  }
});

$('#products-all').addEventListener('change', (e) => {
  for (const p of productsView.rows) {
    if (e.target.checked) productsView.selected.add(p.id);
    else productsView.selected.delete(p.id);
  }
  renderProducts();
});

/* ---------- Карточка товара ---------- */
let productDialogDone = null;
let editingProduct = null;
// Свойства для новых модификаций ([{ name, values }]) и введённые в таблице цены и остатки по сочетаниям.
const gen = { options: [], edits: {} };

const round0 = (n) => Math.round(n);
const fmtNum = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100).replace('.', ',') : '');

// Цена, себестоимость и наценка связаны: что поменяли, от того и считаем остальное.
// Цена из наценки округляется до целого сома.
function syncPrices(changed) {
  const f = $('#product-form');
  const cost = parseNum(f.elements.cost.value);
  const price = parseNum(f.elements.price.value);
  const mk = parseNum(f.elements.markup.value);
  if ((changed === 'markup' || (changed === 'cost' && f.elements.markup.value)) && cost > 0 && Number.isFinite(mk) && f.elements.markup.value !== '') {
    f.elements.price.value = fmtNum(round0(cost * (1 + mk / 100)));
  } else if ((changed === 'price' || changed === 'cost') && cost > 0 && price > 0) {
    f.elements.markup.value = fmtNum(((price - cost) / cost) * 100);
  }
  const p = parseNum(f.elements.price.value);
  $('#pf-profit').textContent = cost > 0 && p > 0
    ? `Прибыль с единицы: ${money2(p - cost)} · маржа ${pct((p - cost) / p)}. Цена из наценки округляется до целого сома.`
    : 'Меняете наценку — пересчитывается цена, меняете цену — пересчитывается наценка.';
  renderGenPreview();
}

function renderBarcodePreview() {
  const code = $('#pf-barcode').value.trim();
  const svg = code ? barcodeSvg(code) : null;
  $('#pf-barcode-preview').hidden = !svg;
  if (svg) $('#pf-barcode-preview').innerHTML = svg;
}

function openProductDialog(product = null, onSaved = null) {
  editingProduct = product;
  productDialogDone = onSaved;
  const f = $('#product-form');
  f.reset();
  const variant = Boolean(product?.parent_id);
  const base = variant ? catalog.byId(product.parent_id) : null;
  const group = product && catalog.isGroup(product);
  $('#product-dialog-title').textContent = variant ? 'Модификация' : product ? 'Изменить товар' : 'Новый товар';
  $('#product-variant-of').hidden = !variant;
  if (variant) $('#product-variant-of').innerHTML = `Товар «${esc(base?.name || '')}». Название, категория и описание берутся у него. <button type="button" class="link" data-open-base="${product.parent_id}">Открыть товар</button>`;
  for (const id of ['#pf-name-field', '#pf-category-field', '#pf-unit-field', '#pf-description-field']) $(id).hidden = variant;
  $('#pf-variant-options').hidden = !variant;
  if (variant) {
    const opts = JSON.parse(product.options || '{}');
    $('#pf-variant-options').innerHTML = Object.entries(opts).map(([k, v]) => `
      <div class="field"><label>${esc(k)}</label><input class="input" data-opt="${esc(k)}" value="${esc(v)}" autocomplete="off"></div>`).join('');
  }
  $('#product-stock-field').hidden = Boolean(product) || !session.can('stock.view');
  // Основной товар с модификациями не продают: штрихкод и код — у модификаций, его цена — по умолчанию для новых.
  $('#pf-code').closest('.field').hidden = group;
  $('#pf-barcode').closest('.field').hidden = group;
  $('#product-archived-field').hidden = !product;
  $('#product-error').hidden = true;
  $('#product-delete').hidden = !product || !session.can('products.delete');
  $('#product-delete').textContent = group ? 'Удалить товар и модификации' : 'Удалить';
  $('#product-delete').classList.remove('danger');
  $('#product-labels').hidden = !product || group;
  if (product) {
    for (const key of ['name', 'category', 'code', 'barcode', 'unit', 'price', 'cost', 'description']) f.elements[key].value = product[key] ?? '';
    f.elements.price.value = fmtNum(product.price);
    f.elements.cost.value = product.cost ? fmtNum(product.cost) : '';
    f.elements.markup.value = product.cost > 0 ? fmtNum(((product.price - product.cost) / product.cost) * 100) : '';
    f.elements.archived.checked = Boolean(product.archived);
  }
  gen.options = [{ name: 'Цвет', values: '' }, { name: 'Размер', values: '' }];
  gen.edits = {};
  $('#pf-gen').open = false;
  $('#pf-variants').hidden = variant || !session.can('products');
  renderVariantsList();
  renderGenOptions();
  $('#categories').innerHTML = categories.names().map((c) => `<option value="${esc(c)}">`).join('');
  syncPrices();
  renderBarcodePreview();
  $('#product-dialog').showModal();
  (variant ? $('#pf-variant-options input') : f.elements.name)?.focus();
}

function renderVariantsList() {
  const kids = editingProduct ? catalog.children(editingProduct.id) : [];
  $('#pf-variants-list').innerHTML = kids.length ? `
    <table class="variants-table">
      <thead><tr><th>Модификация</th><th>Штрихкод</th><th>Цена</th><th>Остаток</th><th></th></tr></thead>
      <tbody>${kids.map((k) => `<tr>
        <td>${esc(optionsText(k))}</td>
        <td class="num">${esc(k.barcode) || '—'}</td>
        <td>${money2(k.price)}</td>
        <td class="${k.stock !== null && k.stock <= 0 ? 'neg' : ''}">${k.stock === null ? '—' : qty(k.stock, k.unit)}</td>
        <td><button type="button" class="btn small ghost" data-variant-edit="${k.id}">Изменить</button></td>
      </tr>`).join('')}</tbody>
    </table>` : '';
}

function renderGenOptions() {
  $('#pf-gen-options').innerHTML = gen.options.map((o, i) => `
    <div class="gen-row" data-i="${i}">
      <input class="input" data-gen="name" value="${esc(o.name)}" placeholder="Свойство" aria-label="Свойство" autocomplete="off">
      <input class="input" data-gen="values" value="${esc(o.values)}" placeholder="Значения через запятую: Красный, Синий" aria-label="Значения" autocomplete="off">
      <button type="button" class="icon-btn" data-gen-del="${i}" aria-label="Убрать свойство">×</button>
    </div>`).join('');
  $('#pf-gen-add').hidden = gen.options.length >= 4;
  renderGenPreview();
}

// Все сочетания значений: Цвет × Размер.
function genCombos() {
  const opts = gen.options
    .map((o) => ({ name: o.name.trim(), values: [...new Set(o.values.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean))] }))
    .filter((o) => o.name && o.values.length);
  if (!opts.length) return [];
  return opts.reduce((acc, o) => acc.flatMap((combo) => o.values.map((v) => ({ ...combo, [o.name]: v }))), [{}]);
}

function renderGenPreview() {
  const combos = genCombos();
  const existing = new Set((editingProduct ? catalog.children(editingProduct.id) : []).map((k) => optionsText(k).toLowerCase()));
  const fresh = combos.filter((c) => !existing.has(Object.values(c).join(', ').toLowerCase()));
  const f = $('#product-form');
  const price = f.elements.price.value;
  $('#pf-gen-preview').innerHTML = !combos.length ? '' : fresh.length > 300 ? `<p class="neg">Получится ${fresh.length} сочетаний — слишком много. Не больше 300.</p>` : `
    <p class="pick-meta">Будет создано ${fresh.length} ${plural(fresh.length, ['модификация', 'модификации', 'модификаций'])}${combos.length > fresh.length ? ` (${combos.length - fresh.length} уже есть)` : ''}. Цену и остаток можно поменять для каждой.</p>
    <table class="variants-table gen-table">
      <thead><tr><th>Модификация</th><th>Цена, сом</th><th>Остаток</th></tr></thead>
      <tbody>${fresh.map((c, i) => {
        const label = Object.values(c).join(', ');
        const ed = gen.edits[label] || {};
        return `<tr data-combo="${i}" data-label="${esc(label)}">
        <td>${esc(label)}</td>
        <td><input class="input num" data-combo="price" inputmode="decimal" value="${esc(ed.price || '')}" placeholder="${esc(price || '0')}" aria-label="Цена"></td>
        <td><input class="input num" data-combo="stock" inputmode="decimal" value="${esc(ed.stock || '')}" placeholder="0" aria-label="Остаток"></td>
      </tr>`;
      }).join('')}</tbody>
    </table>`;
  gen.fresh = fresh;
}

function collectVariants() {
  const f = $('#product-form');
  return (gen.fresh || []).map((options) => {
    const { price, stock } = gen.edits[Object.values(options).join(', ')] || {};
    return {
      options,
      price: price ? parseNum(price) : parseNum(f.elements.price.value) || 0,
      cost: parseNum(f.elements.cost.value) || 0,
      stock: stock ? parseNum(stock) : 0,
    };
  });
}

$('#product-form').addEventListener('input', (e) => {
  const name = e.target.name;
  if (['cost', 'price', 'markup'].includes(name)) syncPrices(name);
  if (name === 'barcode') renderBarcodePreview();
  const combo = e.target.closest('tr[data-label]');
  if (combo && e.target.dataset.combo) {
    const label = combo.dataset.label;
    gen.edits[label] = { ...gen.edits[label], [e.target.dataset.combo]: e.target.value };
    return;
  }
  const g = e.target.dataset.gen;
  if (g) {
    gen.options[Number(e.target.closest('.gen-row').dataset.i)][g] = e.target.value;
    renderGenPreview();
  }
});
$('#product-form').addEventListener('click', (e) => {
  const del = e.target.closest('[data-gen-del]');
  const edit = e.target.closest('[data-variant-edit]');
  const base = e.target.closest('[data-open-base]');
  if (del) {
    gen.options.splice(Number(del.dataset.genDel), 1);
    renderGenOptions();
  } else if (edit) {
    openProductDialog(catalog.byId(edit.dataset.variantEdit), productDialogDone);
  } else if (base) {
    openProductDialog(catalog.byId(base.dataset.openBase), productDialogDone);
  }
});
$('#pf-gen-add').addEventListener('click', () => {
  gen.options.push({ name: '', values: '' });
  renderGenOptions();
  $('#pf-gen-options .gen-row:last-child input').focus();
});
$('#pf-barcode-new').addEventListener('click', async () => {
  try {
    $('#pf-barcode').value = (await api('/api/barcode')).barcode;
    renderBarcodePreview();
  } catch (err) {
    showFormError('#product-error', err);
  }
});
$('#product-labels').addEventListener('click', () => openLabels([editingProduct]));

$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const variant = Boolean(editingProduct?.parent_id);
  const body = {
    barcode: f.elements.barcode.value,
    code: f.elements.code.value,
    price: f.elements.price.value,
    cost: f.elements.cost.value || 0,
  };
  if (variant) {
    body.options = Object.fromEntries([...document.querySelectorAll('#pf-variant-options [data-opt]')].map((i) => [i.dataset.opt, i.value]));
  } else {
    Object.assign(body, { name: f.elements.name.value, category: f.elements.category.value, unit: f.elements.unit.value, description: f.elements.description.value });
  }
  if (!editingProduct) body.stock = f.elements.stock.value || 0;
  else body.archived = f.elements.archived.checked;
  const variants = variant ? [] : collectVariants();
  if (variants.length > 300) return showFormError('#product-error', new Error('Слишком много модификаций за раз: не больше 300'));
  // Первые модификации забирают остаток на себя — у основного товара он обнуляется.
  const ownStock = editingProduct ? editingProduct.stock : parseNum(body.stock) || 0;
  if (variants.length && !catalog.children(editingProduct?.id).length && ownStock) {
    if (!confirm(`Остаток товара (${qtyFmt.format(ownStock)}) обнулится: дальше остатки ведутся по модификациям. Укажите остаток каждой модификации в таблице. Продолжить?`)) return;
  }
  try {
    const saved = await api(editingProduct ? `/api/products/${editingProduct.id}` : '/api/products', { method: editingProduct ? 'PUT' : 'POST', body });
    let made = [];
    if (variants.length) made = await api(`/api/products/${saved.id}/variants`, { method: 'POST', body: { variants, barcodes: $('#pf-gen-barcodes').checked } });
    $('#product-dialog').close();
    toast((editingProduct ? 'Сохранено' : `Товар «${saved.name}» добавлен`) + (made.length ? `, модификаций: ${made.length}` : ''));
    await catalog.load();
    productDialogDone?.(saved);
  } catch (err) {
    showFormError('#product-error', err);
    // Товар мог сохраниться, а модификации — нет: дальше правим уже его.
    await catalog.load().catch(() => {});
  }
});
$('#product-cancel').addEventListener('click', () => $('#product-dialog').close());
$('#product-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/products/${editingProduct.id}`, { method: 'DELETE' });
    $('#product-dialog').close();
    toast(`«${editingProduct.name}» удалён`);
    productsView.selected.delete(editingProduct.id);
    await catalog.load();
    productDialogDone?.();
  } catch (err) {
    showFormError('#product-error', err);
  }
});

/* ---------- Пересчёт остатка ---------- */
let stockProduct = null;
$('#stock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/products/${stockProduct.id}/stock`, { method: 'PUT', body: { stock: parseNum(e.target.elements.stock.value) } });
    $('#stock-dialog').close();
    toast('Остаток обновлён');
    renderProducts();
  } catch (err) {
    $('#stock-error').textContent = err.message;
    $('#stock-error').hidden = false;
  }
});
$('#stock-cancel').addEventListener('click', () => $('#stock-dialog').close());

$('#products-body').addEventListener('click', async (e) => {
  if (handlePhotoClick(e, () => { renderProducts(); })) return;
  const sel = e.target.closest('[data-select]');
  if (sel) {
    const id = Number(sel.dataset.select);
    if (sel.checked) productsView.selected.add(id); else productsView.selected.delete(id);
    sel.closest('tr').classList.toggle('selected', sel.checked);
    return renderBulkBar();
  }
  const edit = e.target.closest('[data-edit]');
  const stock = e.target.closest('[data-stock]');
  if (edit) {
    const list = productsView.archived ? await api('/api/products?archived=1') : catalog.list;
    openProductDialog(list.find((p) => p.id === Number(edit.dataset.edit)), renderProducts);
  } else if (stock) {
    stockProduct = catalog.byId(stock.dataset.stock);
    $('#stock-name').textContent = `${stockProduct.name}. Сейчас в программе: ${qty(stockProduct.stock, stockProduct.unit)}.`;
    $('#stock-form').elements.stock.value = stockProduct.stock;
    $('#stock-error').hidden = true;
    $('#stock-dialog').showModal();
    $('#stock-form').elements.stock.select();
  }
});
$('#product-add').addEventListener('click', () => openProductDialog(null, renderProducts));
$('#products-search').addEventListener('input', (e) => { productsView.query = e.target.value; renderProducts(); });
$('#bulk-form').addEventListener('change', (e) => {
  if (e.target.id === 'bf-value' && $('#bf-new-field')) $('#bf-new-field').hidden = e.target.value !== '__new';
});
$('#products-category').addEventListener('change', (e) => { productsView.category = e.target.value; productsView.selected.clear(); renderProducts(); });

/* ---------- Справочник категорий ---------- */
async function renderCategoryFilter() {
  const counts = new Map(categories.list.map((c) => [c.name, c.count]));
  $('#products-category').innerHTML = `<option value="">Все категории</option>` +
    categories.list.map((c) => `<option value="${esc(c.name)}" ${c.name === productsView.category ? 'selected' : ''}>${esc(c.name)} (${counts.get(c.name) || 0})</option>`).join('') +
    `<option value="—" ${productsView.category === '—' ? 'selected' : ''}>Без категории</option>`;
}

async function renderCategoryManager() {
  try { await categories.load(); } catch (err) { return toast(err.message, 'error'); }
  const list = categories.list;
  $('#cat-list').innerHTML = list.length ? list.map((c, i) => `
    <div class="cat-row" data-cat-id="${c.id}">
      <button type="button" class="cat-img" data-cat-image="${c.id}" title="${c.image_id ? 'Заменить картинку' : 'Добавить картинку для витрины'}">${c.image_id ? `<img src="/img/${c.image_id}" alt="">` : '<span aria-hidden="true">🖼️</span>'}</button>
      <input class="input" value="${esc(c.name)}" data-cat-name="${c.id}" aria-label="Название категории">
      <span class="pcat cat-count">${int(c.count)} ${plural(c.count, ['товар', 'товара', 'товаров'])}</span>
      <div class="cat-actions">
        <button type="button" class="icon-btn" data-cat-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button type="button" class="icon-btn" data-cat-move="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
        ${c.image_id ? `<button type="button" class="btn small ghost" data-cat-image-del="${c.id}">Убрать картинку</button>` : ''}
        <button type="button" class="btn small ghost danger-text" data-cat-delete="${c.id}">Удалить</button>
      </div>
      <div class="cat-delete" data-cat-delete-box="${c.id}" hidden>
        <span>Товары категории перенести в</span>
        <select class="input"><option value="">Без категории</option>${list.filter((o) => o.id !== c.id).map((o) => `<option>${esc(o.name)}</option>`).join('')}</select>
        <button type="button" class="btn small danger" data-cat-delete-ok="${c.id}">Удалить категорию</button>
      </div>
    </div>`).join('') : '<p class="empty">Категорий пока нет. Добавьте первую выше или впишите категорию в карточке товара.</p>';
}

$('#categories-open').addEventListener('click', async () => {
  await renderCategoryManager();
  $('#categories-dialog').showModal();
});
$('#cat-close').addEventListener('click', () => $('#categories-dialog').close());
// Закрыли окно — обновляем список товаров: категории могли поменяться.
$('#categories-dialog').addEventListener('close', () => renderProducts());
$('#cat-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/categories', { method: 'POST', body: { name: e.target.elements.name.value } });
    e.target.reset();
    renderCategoryManager();
  } catch (err) {
    toast(err.message, 'error');
  }
});
// Переименование — по выходу из поля или Enter.
$('#cat-list').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-cat-name]');
  if (!input) return;
  const cat = categories.list.find((c) => c.id === Number(input.dataset.catName));
  if (!input.value.trim() || input.value.trim() === cat.name) { input.value = cat.name; return; }
  try {
    const saved = await api(`/api/categories/${cat.id}`, { method: 'PUT', body: { name: input.value } });
    toast(saved.id === cat.id ? `Категория переименована: «${saved.name}»` : `Категории объединены в «${saved.name}»`);
    if (productsView.category === cat.name) productsView.category = saved.name;
    renderCategoryManager();
  } catch (err) {
    toast(err.message, 'error');
    input.value = cat.name;
  }
});
$('#cat-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-cat-name]')) e.target.blur(); });
$('#cat-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-cat-id]');
  if (!row) return;
  const id = Number(row.dataset.catId);
  const move = e.target.closest('[data-cat-move]');
  try {
    if (move) {
      const ids = categories.list.map((c) => c.id);
      const i = ids.indexOf(id), j = i + Number(move.dataset.catMove);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('/api/categories-order', { method: 'PUT', body: { ids } });
      return renderCategoryManager();
    }
    if (e.target.closest('[data-cat-image]')) {
      const file = await pickFile();
      if (!file) return;
      await api(`/api/categories/${id}/image`, { method: 'PUT', body: { mime: 'image/jpeg', data: await shrinkPhoto(file, 600) } });
      toast('Картинка категории сохранена');
      return renderCategoryManager();
    }
    if (e.target.closest('[data-cat-image-del]')) {
      await api(`/api/categories/${id}/image`, { method: 'PUT', body: {} });
      return renderCategoryManager();
    }
    if (e.target.closest('[data-cat-delete]')) {
      row.querySelector('[data-cat-delete-box]').hidden = false;
      return;
    }
    if (e.target.closest('[data-cat-delete-ok]')) {
      const moveTo = row.querySelector('[data-cat-delete-box] select').value;
      const r = await api(`/api/categories/${id}?moveTo=${encodeURIComponent(moveTo)}`, { method: 'DELETE' });
      toast(`Категория удалена. Товаров ${r.to ? `перенесено в «${r.to}»` : 'без категории'}: ${r.moved}`);
      productsView.category = '';
      return renderCategoryManager();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#products-archived').addEventListener('change', (e) => { productsView.archived = e.target.checked; productsView.selected.clear(); renderProducts(); });

views.products = { show: renderProducts, right: 'products' };
