'use strict';

// Товары: справочник, добавление, изменение, инвентаризация.

const productsView = { archived: false, query: '' };

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
  const stockValue = list.reduce((s, p) => s + Math.max(0, p.stock) * p.cost, 0);
  $('#products-summary').textContent = productsView.archived
    ? `Скрыто товаров: ${list.length}`
    : `${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])} · товара на складе по себестоимости на ${money(stockValue)}`;
  $('#products-body').innerHTML = rows.length ? rows.map((p) => {
    const m = markup(p);
    return `<tr>
      <td><div class="with-thumb">${photoCell(p)}<div><div class="pname">${esc(p.name)}</div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : ''}</div></div></td>
      <td class="num">${esc(p.code) || '—'}</td>
      <td class="num">${esc(p.barcode) || '—'}</td>
      <td>${money2(p.price)}</td>
      <td>${p.cost ? money2(p.cost) : '—'}</td>
      <td>${m === null ? '—' : pct(m)}</td>
      <td class="${p.stock <= 0 ? 'neg' : ''}">${qty(p.stock, p.unit)}</td>
      <td><div class="actions">
        <button type="button" class="btn small ghost" data-edit="${p.id}">Изменить</button>
        ${productsView.archived ? '' : `<button type="button" class="btn small ghost" data-stock="${p.id}">Пересчитать</button>`}
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty">${list.length ? 'Ничего не нашлось' : productsView.archived ? 'Скрытых товаров нет' : 'Товаров пока нет. Нажмите «Добавить товар» или загрузите их из Excel.'}</td></tr>`;
}

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
  if (product) {
    for (const key of ['name', 'category', 'code', 'barcode', 'unit', 'price', 'cost']) f.elements[key].value = product[key];
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
$('#products-archived').addEventListener('change', (e) => { productsView.archived = e.target.checked; renderProducts(); });

views.products = { show: renderProducts, right: 'products' };
