'use strict';

// Товары: справочник, добавление, изменение, инвентаризация.

const productsView = { archived: false, query: '', selected: new Set(), rows: [] };

function markup(p) {
  return p.cost > 0 ? (p.price - p.cost) / p.cost : null;
}

async function renderProducts() {
  let list;
  try {
    list = productsView.archived ? await api('/api/products?archived=1') : await catalog.load();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const q = productsView.query.trim().toLowerCase();
  const rows = list.filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q));
  productsView.rows = rows;
  // Выбранными остаются только товары, которые есть в этом списке.
  const ids = new Set(list.map((p) => p.id));
  for (const id of productsView.selected) if (!ids.has(id)) productsView.selected.delete(id);
  const canEdit = session.can('products');
  const stockValue = list.reduce((s, p) => s + Math.max(0, p.stock) * p.cost, 0);
  $('#products-summary').textContent = productsView.archived
    ? `Скрыто товаров: ${list.length}`
    : `${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])} · товара на складе по себестоимости на ${money(stockValue)}`;
  $('#products-body').innerHTML = rows.length ? rows.map((p) => {
    const m = markup(p);
    return `<tr class="${productsView.selected.has(p.id) ? 'selected' : ''}">
      ${canEdit ? `<td class="sel"><input type="checkbox" data-select="${p.id}" ${productsView.selected.has(p.id) ? 'checked' : ''} aria-label="Выбрать ${esc(p.name)}"></td>` : ''}
      <td class="name-col"><div class="with-thumb">${photoCell(p)}<div><div class="pname">${esc(p.name)}</div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : ''}</div></div></td>
      <td class="num">${esc(p.code) || '—'}</td>
      <td class="num">${esc(p.barcode) || '—'}</td>
      <td>${money2(p.price)}</td>
      <td>${p.cost ? money2(p.cost) : '—'}</td>
      <td>${m === null ? '—' : pct(m)}</td>
      <td class="${p.stock <= 0 ? 'neg' : ''}">${qty(p.stock, p.unit)}</td>
      <td><div class="actions">
        ${canEdit ? `<button type="button" class="btn small ghost" data-edit="${p.id}">Изменить</button>` : ''}
        ${productsView.archived || !session.can('stock') ? '' : `<button type="button" class="btn small ghost" data-stock="${p.id}">Пересчитать</button>`}
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
  const cats = [...new Set(catalog.list.map((p) => p.category).filter(Boolean))].sort();
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
    category: `<div class="field wide"><label for="bf-value">Новая категория (пусто — без категории)</label><input id="bf-value" name="value" class="input" list="bulk-cats" autocomplete="off"><datalist id="bulk-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>`,
    unit: `<div class="field wide"><label for="bf-value">Единица</label><select id="bf-value" name="value" class="input"><option>шт</option><option>кг</option><option>л</option><option>м</option><option>уп</option></select></div>`,
  }[b.fields] || '';
  $('#bulk-dialog').showModal();
  $('#bf-value')?.focus();
}

$('#bulk-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (btn) openBulk(btn.dataset.bulk);
});
$('#bulk-clear').addEventListener('click', () => { productsView.selected.clear(); renderProducts(); });
$('#bulk-cancel').addEventListener('click', () => $('#bulk-dialog').close());
$('#bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { ids: [...productsView.selected], action: bulkAction };
  if (f.elements.value) body.value = f.elements.value.value.replace(/[−–—]/g, '-');
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

function openProductDialog(product = null, onSaved = null) {
  editingProduct = product;
  productDialogDone = onSaved;
  const f = $('#product-form');
  f.reset();
  $('#product-dialog-title').textContent = product ? 'Изменить товар' : 'Новый товар';
  $('#product-stock-field').hidden = Boolean(product);
  $('#product-archived-field').hidden = !product;
  $('#product-error').hidden = true;
  $('#product-delete').hidden = !product || !session.can('products.delete');
  $('#product-delete').textContent = 'Удалить товар';
  $('#product-delete').classList.remove('danger');
  if (product) {
    for (const key of ['name', 'category', 'code', 'barcode', 'unit', 'price', 'cost', 'description']) f.elements[key].value = product[key] ?? '';
    f.elements.archived.checked = Boolean(product.archived);
  }
  $('#categories').innerHTML = [...new Set(catalog.list.map((p) => p.category).filter(Boolean))].sort().map((c) => `<option value="${esc(c)}">`).join('');
  $('#product-dialog').showModal();
  f.elements.name.focus();
}

$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.elements.name.value,
    category: f.elements.category.value,
    barcode: f.elements.barcode.value,
    code: f.elements.code.value,
    unit: f.elements.unit.value,
    price: f.elements.price.value,
    cost: f.elements.cost.value || 0,
    description: f.elements.description.value,
  };
  if (!editingProduct) body.stock = f.elements.stock.value || 0;
  else body.archived = f.elements.archived.checked;
  try {
    const saved = await api(editingProduct ? `/api/products/${editingProduct.id}` : '/api/products', { method: editingProduct ? 'PUT' : 'POST', body });
    $('#product-dialog').close();
    toast(editingProduct ? 'Товар сохранён' : `Товар «${saved.name}» добавлен`);
    await catalog.load();
    productDialogDone?.(saved);
  } catch (err) {
    $('#product-error').textContent = err.message;
    $('#product-error').hidden = false;
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
    toast(`Товар «${editingProduct.name}» удалён`);
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
$('#products-archived').addEventListener('change', (e) => { productsView.archived = e.target.checked; productsView.selected.clear(); renderProducts(); });

views.products = { show: renderProducts, right: 'products' };
