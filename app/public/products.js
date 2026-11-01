'use strict';

// Товары: справочник, добавление, изменение, инвентаризация.

const productsView = { archived: false, query: '', category: '', selected: new Set(), rows: [], list: [],
  // Модификации: общий режим (по умолчанию скрыты, выбор запоминается) и исключения по отдельным товарам.
  showVariants: (() => { try { return localStorage.getItem('products.variants') === 'show'; } catch { return false; } })(),
  toggled: new Set() };
// Открыты ли модификации товара: общий режим, изменённый кнопкой у самого товара.
const variantsOpen = (id) => productsView.showVariants !== productsView.toggled.has(id);
// Справочник категорий: для фильтра, карточки товара и переноса.
const categories = {
  list: [],
  async load() { this.list = await api('/api/categories'); return this.list; },
  names() { return this.list.map((c) => c.name); },
  options(selected = '', empty = 'Без категории') {
    return `<option value="">${empty}</option>` + this.list.map((c) => `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  },
};

// Наценка и маржинальность — от цены закупки (чистая стоимость товара), а если её нет — от себестоимости.
// Расходы (зарплата, аренда…) вычитаются на главной, в чистой прибыли.
const baseCost = (p) => p.cost || p.purchase || 0;
const basePurchase = (p) => p.purchase || p.cost || 0;
function markup(p) {
  const c = basePurchase(p);
  return c > 0 ? (p.price - c) / c : null;
}
// Последнее поступление товара; у товара с модификациями — по всем модификациям.
const receivedOf = (p, kids = []) => Math.max(p.received_at || 0, ...kids.map((k) => k.received_at || 0)) || null;

/* ---------- Итоги остатков ---------- */
// Сколько товара на складе: позиций, единиц, по себестоимости и по цене продажи.
// list — продаваемые товары (без «шапок» с модификациями); отрицательный остаток не считается.
function stockTotalsHtml(list) {
  const positions = list.length;
  if (list.some((p) => p.stock === null)) {
    return `<div class="st-tile"><span>Товаров</span><b class="num">${int(positions)}</b><small>позиций в продаже</small></div>`;
  }
  const inStock = list.filter((p) => p.stock > 0);
  const units = inStock.reduce((s, p) => s + p.stock, 0);
  const atCost = inStock.reduce((s, p) => s + p.stock * p.cost, 0);
  const atPurchase = inStock.reduce((s, p) => s + p.stock * (p.purchase ?? p.cost), 0);
  const atPrice = inStock.reduce((s, p) => s + p.stock * p.price, 0);
  const noCost = inStock.filter((p) => !p.cost).length;
  return `
    <div class="st-tile"><span>Товаров</span><b class="num">${int(positions)}</b><small>${int(inStock.length)} в наличии · ${int(positions - inStock.length)} нет · ${qtyFmt.format(Math.round(units * 1000) / 1000)} ед.</small></div>
    <div class="st-tile"><span>По цене закупки</span><b class="num">${money(atPurchase)}</b><small>сколько заплачено поставщикам</small></div>
    <div class="st-tile"><span>По себестоимости</span><b class="num">${money(atCost)}</b><small>${noCost ? `у ${noCost} без себестоимости` : 'закупка с расходами'}</small></div>
    <div class="st-tile accent"><span>По цене продажи</span><b class="num">${money(atPrice)}</b><small>можно выручить · наценка ${money(atPrice - atPurchase)}</small></div>`;
}

/* ---------- Карточка товара: информация, цены, склад, история ---------- */
// stats — продажи товара из главной за выбранный период (необязательно).
let cardProduct = null;
let cardTab = 'info';
const pcCell = (label, value, note = '', cls = '') => `<div class="pc-cell ${cls}"><span>${label}</span><b class="num">${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;

async function openProductCard(id, stats = null) {
  let p;
  try {
    p = await api(`/api/products/${id}/info`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (!catalog.list.length) await catalog.load().catch(() => {});
  cardProduct = p;
  const base = p.parent_id ? catalog.byId(p.parent_id) || (await api(`/api/products/${p.parent_id}/info`).catch(() => null)) : null;
  const kids = p.children;
  const listed = catalog.byId(p.id);
  const received = receivedOf(listed || p, kids.map((k) => catalog.byId(k.id) || k));
  const stock = p.stock === null ? null : kids.length ? kids.reduce((s, k) => s + k.stock, 0) : p.stock;
  const photo = photoUrl(p) || (base ? photoUrl(base) : '');
  $('#pc-photo').innerHTML = photo ? `<img src="${photo}" alt="">` : '<span aria-hidden="true">📦</span>';
  $('#pc-title').textContent = base ? base.name : p.name;
  $('#pc-sub').textContent = [base ? optionsText(p) : '', p.category || base?.category || 'Без категории', p.archived ? 'убран из продажи' : ''].filter(Boolean).join(' · ');

  // Информация о товаре.
  $('#pc-info').innerHTML = [
    pcCell('Создан', dateOnly(p.created_at), new Date(p.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })),
    pcCell('Последнее поступление', received ? dateOnly(received) : '—', received ? '' : 'закупок ещё не было'),
    kids.length ? '' : pcCell('Код товара', esc(p.code || '—')),
    kids.length ? '' : pcCell('Штрихкод', esc(p.barcode || '—')),
    pcCell('Артикул', esc(p.article || '—')),
    pcCell('Поставщик', esc(p.supplier_name || '—')),
    pcCell('Единица', esc(p.unit)),
    stock === null ? '' : pcCell('Остаток здесь', qty(stock, p.unit), stock <= 0 ? '<span class="neg">нет в наличии</span>' : ''),
  ].join('') + (p.description ? `<div class="pc-cell pc-wide"><span>Описание</span><small class="pc-text">${esc(p.description)}</small></div>` : '')
    + (!kids.length && p.barcode ? `<div class="pc-cell pc-wide pc-barcode">${typeof barcodeSvg === 'function' ? barcodeSvg(p.barcode) || '' : ''}</div>` : '');
  $('#pc-variants').innerHTML = kids.length ? `<h3>Модификации (${kids.length})</h3><div class="pc-variants">${kids.map((k) => `
    <button type="button" class="pc-variant" data-card-kid="${k.id}"><span>${esc(optionsText(k) || k.name)}<small class="pcat"> · код ${esc(k.code || '—')}</small></span><span class="num">${money2(salePrice(k))}</span>${k.stock === null ? '' : `<span class="num ${k.stock <= 0 ? 'neg' : ''}">${qty(k.stock, k.unit)}</span>`}</button>`).join('')}</div>` : '';
  $('#pc-sales').innerHTML = stats ? `<h3>Продажи за выбранный на главной период</h3><div class="pc-grid">
    ${pcCell('Продано', qty(stats.qty, p.unit))}${pcCell('Выручка', money(stats.revenue))}${pcCell('Прибыль', money(stats.profit), stats.margin === null ? '' : `маржа ${pct(stats.margin)}`)}
    ${stock !== null && stats.daysLeft !== null ? pcCell('Хватит на', stats.daysLeft === Infinity ? 'не продаётся' : stats.daysLeft < 1 ? 'меньше дня' : `${int(Math.floor(stats.daysLeft))} ${plural(Math.floor(stats.daysLeft), ['день', 'дня', 'дней'])}`, `за 30 дней продано ${qty(stats.sold30, p.unit)}`) : ''}</div>` : '';

  renderCardPrices(p, kids);
  $('#pc-stores').innerHTML = '';
  $('#pc-history').innerHTML = '';
  $('#pc-edit').hidden = !session.can('products');
  $('#pc-gallery').hidden = !session.can('photos') || typeof openGallery !== 'function';
  $('#pc-studio').hidden = !session.can('studio') || typeof openStudioForProduct !== 'function';
  // Счётчик на кнопке: сколько всего фото у товара (основное + дополнительные).
  $('#pc-gallery').textContent = '🖼 Фото товара';
  if (!$('#pc-gallery').hidden) {
    api(`/api/products/${p.id}/gallery`).then((g) => {
      const n = (g.main ? 1 : 0) + g.images.length;
      if (cardProduct?.id === p.id && n) $('#pc-gallery').textContent = `🖼 Фото товара · ${n}`;
    }).catch(() => {});
  }
  $('#pc-stock').hidden = !session.can('stock') || kids.length > 0 || stock === null;
  $('#pc-writeoff').hidden = !session.can('writeoff') || kids.length > 0;
  $('#pc-open').hidden = currentView === 'products' || (!session.can('products') && !session.can('photos'));
  $('#pc-tabs [data-pc-tab="stock"]').hidden = !session.can('stock.view') && !session.can('stock') && !session.can('writeoff');
  $('#pc-tabs [data-pc-tab="history"]').hidden = !session.can('products.history');
  if (!$('#product-card').open) {
    cardTab = 'info';
    $('#product-card').showModal();
  }
  showCardTab(cardTab);
}

// Цены и скидки: цена продажи, закупки, себестоимость, скидка, наценка и маржинальность.
function renderCardPrices(p, kids) {
  const one = (x) => {
    const sale = salePrice(x);
    const cost = baseCost(x);
    const buy = basePurchase(x);
    return { sale, cost, purchase: x.purchase ?? x.cost, markup: buy > 0 ? (x.price - buy) / buy : null, margin: sale > 0 && buy > 0 ? (sale - buy) / sale : null, profit: sale - buy };
  };
  if (kids.length) {
    const prices = kids.map((k) => k.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    $('#pc-prices').innerHTML = pcCell('Цена продажи', lo === hi ? money2(lo) : `${money2(lo)} – ${money2(hi)}`, 'у модификаций');
    $('#pc-prices-note').textContent = 'Цены, скидки и себестоимость у каждой модификации свои. Нажмите на модификацию, чтобы открыть её карточку.';
    $('#pc-prices-variants').innerHTML = `<div class="table-wrap"><table class="pc-table">
      <thead><tr><th>Модификация</th><th class="num">Цена</th><th class="num">Скидка</th><th class="num">Закупка</th><th class="num">Себест.</th><th class="num">Наценка</th><th class="num">Маржа</th></tr></thead>
      <tbody>${kids.map((k) => { const c = one(k); return `<tr class="clickable" data-card-kid="${k.id}">
        <td>${esc(optionsText(k) || k.name)}</td><td class="num">${money2(c.sale)}</td><td class="num">${k.discount ? `${int(k.discount)}%` : '—'}</td><td class="num">${money2(c.purchase)}</td><td class="num">${money2(k.cost)}</td>
        <td class="num">${c.markup === null ? '—' : pct(c.markup)}</td><td class="num">${c.margin === null ? '—' : pct(c.margin)}</td></tr>`; }).join('')}</tbody></table></div>`;
    return;
  }
  const c = one(p);
  const extra = p.cost - c.purchase;
  $('#pc-prices').innerHTML = [
    pcCell('Цена продажи', money2(p.price), p.discount > 0 ? `со скидкой <b>${money2(c.sale)}</b>` : '', 'accent'),
    pcCell('Цена закупки', c.purchase ? money2(c.purchase) : '—', 'только товар у поставщика'),
    pcCell('Себестоимость', p.cost ? money2(p.cost) : '—', p.cost && extra > 0.004 ? `закупка + расходы ${money2(extra)}` : 'закупка с расходами'),
    pcCell('Скидка', p.discount > 0 ? `${int(p.discount)}%` : '0%', p.discount > 0 ? `−${money2(p.price - c.sale)} с единицы` : 'без скидки'),
    pcCell('Наценка', c.markup === null ? '—' : pct(c.markup), c.purchase ? `от цены закупки, +${money2(p.price - c.purchase)}` : 'от цены закупки'),
    pcCell('Маржинальность', c.margin === null ? '—' : pct(c.margin), c.margin === null ? 'от цены закупки' : `от цены закупки · с единицы ${money2(c.profit)}`),
  ].join('');
  $('#pc-prices-note').textContent = c.purchase && c.purchase !== p.cost
    ? `С учётом расходов на единицу (себестоимость ${money2(p.cost)}): наценка ${pct((p.price - p.cost) / p.cost)}, маржинальность ${c.sale > 0 ? pct((c.sale - p.cost) / c.sale) : '—'}.`
    : 'Маржинальность — какая доля цены продажи (со скидкой) остаётся после цены закупки.';
  $('#pc-prices-variants').innerHTML = '';
}

// Склад: остаток в каждом магазине.
async function renderCardStores() {
  const p = cardProduct;
  $('#pc-stores').innerHTML = '<p class="pick-meta">Загружаю остатки…</p>';
  if (!session.can('stock.view')) { $('#pc-stores').innerHTML = '<p class="pick-meta">У вас нет права видеть остатки.</p>'; return; }
  let list;
  try { list = await api(`/api/products/${p.id}/stores`); } catch (err) { $('#pc-stores').innerHTML = `<p class="neg">${esc(err.message)}</p>`; return; }
  if (cardProduct !== p) return;
  const total = list.filter((s) => s.found).reduce((sum, s) => sum + s.stock, 0);
  $('#pc-stores').innerHTML = `<div class="table-wrap"><table class="pc-table">
    <thead><tr><th>Магазин</th><th class="num">Остаток</th><th class="num">Цена</th><th class="num">На сумму</th></tr></thead>
    <tbody>${list.map((s) => `<tr class="${s.current ? 'pc-here' : ''}">
      <td><b>${esc(s.name)}</b>${s.current ? ' <span class="role-tag">здесь</span>' : ''}${s.found && s.archived ? '<div class="pcat">убран из продажи</div>' : ''}</td>
      ${s.found ? `<td class="num ${s.stock <= 0 ? 'neg' : ''}">${qty(s.stock, p.unit)}</td><td class="num">${money2(s.price)}</td><td class="num">${money(Math.max(0, s.stock) * s.price)}</td>`
        : '<td colspan="3" class="pcat">товара нет в этом магазине</td>'}
    </tr>`).join('')}</tbody>
    ${list.length > 1 ? `<tfoot><tr><td>Всего</td><td class="num">${qty(Math.round(total * 1000) / 1000, p.unit)}</td><td></td><td></td></tr></tfoot>` : ''}
  </table></div>
  <p class="pick-meta">${list.length > 1 ? 'В других магазинах товар ищется по штрихкоду, коду с названием или по названию.' : 'Магазин один. Когда появятся филиалы, здесь будут остатки в каждом.'}</p>`;
}

const HISTORY_KIND = { sale: 'out', writeoff: 'out', refund: 'in', purchase: 'in', receipt: 'in', return: 'in', created: 'info' };
// История движения: продажи, закупки, списания, перемещения — с датами.
async function renderCardHistory() {
  const p = cardProduct;
  $('#pc-history').innerHTML = '<p class="pick-meta">Загружаю историю…</p>';
  let list;
  try { list = await api(`/api/products/${p.id}/history`); } catch (err) { $('#pc-history').innerHTML = `<p class="neg">${esc(err.message)}</p>`; return; }
  if (cardProduct !== p) return;
  const by = (k) => list.filter((e) => e.kind === k);
  const sum = (arr) => arr.reduce((s, e) => s + Math.abs(e.qty || 0), 0);
  const incoming = list.filter((e) => ['purchase', 'receipt'].includes(e.kind) || (e.kind === 'transfer' && e.qty > 0));
  $('#pc-history').innerHTML = `
    <div class="pc-grid pc-history-sum">
      ${pcCell('Поступило', qty(sum(incoming), p.unit), incoming.length ? `${incoming.length} ${plural(incoming.length, ['раз', 'раза', 'раз'])}, последний ${dateOnly(incoming[0].at)}` : 'поступлений не было')}
      ${pcCell('Продано', qty(sum(by('sale')) - sum(by('refund')), p.unit), `${by('sale').length} ${plural(by('sale').length, ['чек', 'чека', 'чеков'])}`)}
      ${pcCell('Списано', qty(sum(by('writeoff')), p.unit))}
    </div>
    <div class="table-wrap pc-history"><table class="pc-table">
      <thead><tr><th>Дата</th><th>Операция</th><th class="num">Кол-во</th><th class="num">Цена</th></tr></thead>
      <tbody>${list.map((e) => {
        const dir = e.qty === null ? 'info' : e.qty > 0 ? 'in' : e.qty < 0 ? 'out' : HISTORY_KIND[e.kind] || 'info';
        return `<tr>
        <td class="nowrap">${dateOnly(e.at)}<div class="pcat">${new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div></td>
        <td><b>${esc(e.title)}</b>${e.variant ? `<div class="pcat">${esc(e.variant)}</div>` : ''}${e.note || e.who ? `<div class="pcat">${esc([e.note, e.who].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td class="num hist-${dir}">${e.qty === null ? '' : `${e.qty > 0 ? '+' : e.qty < 0 ? '−' : ''}${qtyFmt.format(Math.abs(e.qty))}`}</td>
        <td class="num">${e.price === null || e.price === undefined ? '' : money2(e.price)}</td>
      </tr>`;
      }).join('')}</tbody>
    </table></div>
    ${list.length >= 1000 ? '<p class="pick-meta">Показаны последние 1000 движений.</p>' : ''}`;
}

function showCardTab(tab) {
  if ($(`#pc-tabs [data-pc-tab="${tab}"]`)?.hidden) tab = 'info';
  cardTab = tab;
  for (const b of document.querySelectorAll('#pc-tabs [data-pc-tab]')) b.setAttribute('aria-pressed', String(b.dataset.pcTab === tab));
  for (const pane of document.querySelectorAll('#product-card [data-pc-pane]')) pane.hidden = pane.dataset.pcPane !== tab;
  if (tab === 'stock') renderCardStores();
  if (tab === 'history') renderCardHistory();
}

$('#pc-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pc-tab]');
  if (b) showCardTab(b.dataset.pcTab);
});
$('#pc-close').addEventListener('click', () => $('#product-card').close());
// MONT AI Studio: новая съёмка с этим товаром (или его модификацией).
$('#pc-studio').addEventListener('click', () => {
  if (!cardProduct) return;
  $('#product-card').close();
  openStudioForProduct(cardProduct.id);
});
// Галерея фото этого товара (у модификации — своя). После сохранения карточка обновляется.
$('#pc-gallery').addEventListener('click', () => {
  if (!cardProduct) return;
  const id = cardProduct.id;
  openGallery(id, { title: [$('#pc-title').textContent, cardProduct.parent_id ? optionsText(cardProduct) : ''].filter(Boolean).join(' · '), onSaved: () => openProductCard(id) });
});
$('#product-card').addEventListener('click', (e) => {
  const b = e.target.closest('[data-card-kid]');
  if (b) openProductCard(Number(b.dataset.cardKid));
});
// После изменения — обновить справочник, экран, с которого открыли карточку, и саму карточку.
async function afterCardEdit(saved) {
  await catalog.load().catch(() => {});
  if (currentView === 'products') renderProducts();
  if (currentView === 'home' && typeof load === 'function') load();
  if (saved?.id) openProductCard(saved.id);
}
$('#pc-edit').addEventListener('click', async () => {
  const list = cardProduct.archived ? await api('/api/products?archived=1').catch(() => []) : catalog.list;
  const p = list.find((x) => x.id === cardProduct.id) || cardProduct;
  $('#product-card').close();
  openProductDialog(p, afterCardEdit);
});
function openStockDialog(p) {
  stockProduct = p;
  $('#stock-name').textContent = `${p.name}. Сейчас в программе: ${qty(p.stock, p.unit)}.`;
  $('#stock-form').elements.stock.value = p.stock;
  $('#stock-error').hidden = true;
  $('#stock-dialog').showModal();
  $('#stock-form').elements.stock.select();
}
$('#pc-stock').addEventListener('click', () => {
  $('#product-card').close();
  openStockDialog(cardProduct);
});
$('#pc-writeoff').addEventListener('click', () => {
  $('#product-card').close();
  writeoffProduct(cardProduct);
});
$('#pc-open').addEventListener('click', () => {
  const name = (cardProduct.parent_id ? catalog.byId(cardProduct.parent_id) || cardProduct : cardProduct).name;
  $('#product-card').close();
  productsView.query = name;
  $('#products-search').value = name;
  if (currentView === 'products') renderProducts(); else location.hash = 'products';
});

async function renderProducts() {
  let list;
  try {
    [list] = await Promise.all([productsView.archived ? api('/api/products?archived=1') : catalog.load(), categories.load(), loadGalleryCounts()]);
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
  const matches = (p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q);
  const rows = list
    .filter((p) => !productsView.category || (productsView.category === '—' ? !catOf(p) : catOf(p) === productsView.category))
    .filter(matches)
    // Модификация видна, если у её товара открыты модификации или если поиск нашёл именно её.
    .filter((p) => !p.parent_id || variantsOpen(p.parent_id) || (q && !matches(byId.get(p.parent_id) || {})))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'ru'));
  productsView.list = list;
  renderCategoryChips(list, catOf);
  $('#products-variants').hidden = !kids.size;
  $('#products-variants').textContent = productsView.showVariants ? '▾ Скрыть все модификации' : '▸ Показать все модификации';
  productsView.rows = rows;
  renderCategoryFilter();
  // Выбранными остаются только товары, которые есть в этом списке.
  const ids = new Set(list.map((p) => p.id));
  for (const id of productsView.selected) if (!ids.has(id)) productsView.selected.delete(id);
  const canEdit = session.can('products');
  const goods = list.filter((p) => !p.parent_id).length;
  $('#products-summary').textContent = productsView.archived
    ? `Скрыто товаров: ${list.length}`
    : `${goods} ${plural(goods, ['товар', 'товара', 'товаров'])}${list.length > goods ? `, ${list.length - goods} ${plural(list.length - goods, ['модификация', 'модификации', 'модификаций'])}` : ''}`;
  $('#products-totals').hidden = productsView.archived;
  $('#products-totals').innerHTML = stockTotalsHtml(list.filter((p) => !kids.has(p.id)));
  $('#products-body').innerHTML = rows.length ? rows.map((p) => {
    const m = markup(p);
    const children = kids.get(p.id) || [];
    const group = children.length > 0;
    const stock = group ? children.reduce((sum, k) => sum + k.stock, 0) : p.stock;
    const prices = group ? children.map((k) => k.price) : [p.price];
    const lo = Math.min(...prices), hi = Math.max(...prices);
    // Вся строка — кнопка: открывает карточку товара.
    const name = p.parent_id
      ? `<div class="pname"><span class="link-name">${esc(optionsText(p))}</span></div><div class="pcat">${esc(byId.get(p.parent_id)?.name ?? '')}</div>`
      : `<div class="pname"><span class="link-name">${esc(p.name)}</span>${group ? ` <button type="button" class="role-tag var-toggle" data-variants-toggle="${p.id}" aria-expanded="${variantsOpen(p.id)}" title="${variantsOpen(p.id) ? 'Скрыть' : 'Показать'} модификации">${variantsOpen(p.id) ? '▾' : '▸'} ${children.length} ${plural(children.length, ['модификация', 'модификации', 'модификаций'])}</button>` : ''}</div>${p.category ? `<div class="pcat">${esc(p.category)}</div>` : ''}`;
    const received = receivedOf(p, children);
    const purchase = p.purchase ?? p.cost;
    return `<tr class="clickable ${productsView.selected.has(p.id) ? 'selected' : ''} ${p.parent_id ? 'variant-row' : ''}" data-card="${p.id}" tabindex="0" title="Открыть карточку товара">
      ${canEdit ? `<td class="sel"><input type="checkbox" data-select="${p.id}" ${productsView.selected.has(p.id) ? 'checked' : ''} aria-label="Выбрать ${esc(p.name)}"></td>` : ''}
      <td class="name-col"><div class="with-thumb">${photoCell(p)}<div>${name}</div></div></td>
      <td class="num">${group ? '' : esc(p.code) || '—'}</td>
      <td class="num">${group ? '' : esc(p.barcode) || '—'}</td>
      <td>${lo === hi ? money2(lo) : `${money2(lo)} – ${money2(hi)}`}${!group && p.discount > 0 ? `<div class="pcat disc-tag">скидка ${int(p.discount)}% → ${money2(salePrice(p))}</div>` : ''}</td>
      <td>${group ? '' : purchase ? money2(purchase) : '—'}</td>
      <td>${group ? '' : p.cost ? money2(p.cost) : '—'}</td>
      <td>${group || m === null ? '—' : pct(m)}</td>
      <td class="${stock !== null && stock <= 0 ? 'neg' : ''}">${p.stock === null ? '—' : qty(stock, p.unit)}</td>
      <td class="nowrap">${received ? dateOnly(received) : '—'}</td>
      <td><div class="actions">
        <button type="button" class="btn small ghost" data-print-labels="${p.id}" title="${group ? 'Печать этикеток: выбрать модификации' : 'Печать этикетки'}">🏷 Этикетка</button>
        ${productsView.archived || group || !session.can('stock') ? '' : `<button type="button" class="btn small ghost" data-stock="${p.id}">Пересчитать</button>`}
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" class="empty">${list.length ? 'Ничего не нашлось' : productsView.archived ? 'Скрытых товаров нет' : 'Товаров пока нет. Нажмите «Добавить товар» или загрузите их из Excel.'}</td></tr>`;
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
  purchase: { title: 'Изменить цену закупки', fields: 'price' },
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
          ${action === 'price' ? '<option value="markup">Наценка от цены закупки, %</option>' : ''}
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
// Документ по выбранным товарам: основной товар заменяется его модификациями.
function bulkDocItems() {
  const ids = new Set();
  for (const id of productsView.selected) {
    const kids = catalog.children(id);
    if (kids.length) kids.forEach((k) => ids.add(k.id)); else ids.add(id);
  }
  return catalog.sellable().filter((p) => ids.has(p.id));
}
$('#bulk-inventory').addEventListener('click', () => {
  const list = bulkDocItems();
  if (!list.length) return toast('Выберите товары, которые есть в продаже', 'error');
  productsView.selected.clear();
  newDoc('inventory', list.map((p) => ({ productId: p.id, qty: 0, price: p.price, cost: p.cost, actual: null, reason: '' })));
});
$('#bulk-writeoff').addEventListener('click', () => {
  const list = bulkDocItems();
  if (!list.length) return toast('Выберите товары, которые есть в продаже', 'error');
  productsView.selected.clear();
  newDoc('writeoff', list.map((p) => ({ productId: p.id, qty: 1, price: p.price, cost: p.cost, actual: null, reason: WRITEOFF_REASONS[0] })));
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
// Наценка — от цены закупки, а пока её нет — от себестоимости. Цена из наценки округляется до целого сома.
// Пока себестоимость не трогали, она повторяет цену закупки.
function syncPrices(changed) {
  const f = $('#product-form');
  if (changed === 'purchase' && f.dataset.costFollows === '1') f.elements.cost.value = f.elements.purchase.value;
  if (changed === 'cost') f.dataset.costFollows = f.elements.cost.value === '' ? '1' : '0';
  const purchase = parseNum(f.elements.purchase.value);
  const cost = parseNum(f.elements.cost.value) || purchase;
  const price = parseNum(f.elements.price.value);
  const mk = parseNum(f.elements.markup.value);
  const buy = purchase || cost;
  const buyChanged = changed === 'purchase' || (changed === 'cost' && !purchase);
  if ((changed === 'markup' || (buyChanged && f.elements.markup.value)) && buy > 0 && Number.isFinite(mk) && f.elements.markup.value !== '') {
    f.elements.price.value = fmtNum(round0(buy * (1 + mk / 100)));
  } else if ((changed === 'price' || buyChanged) && buy > 0 && price > 0) {
    f.elements.markup.value = fmtNum(((price - buy) / buy) * 100);
  }
  const p = parseNum(f.elements.price.value);
  const disc = parseNum(f.elements.discount.value) || 0;
  const sale = disc > 0 && disc < 100 ? Math.round(p * (1 - disc / 100) * 100) / 100 : p;
  $('#pf-profit').textContent = buy > 0 && p > 0
    ? `${disc > 0 ? `Цена со скидкой ${money2(sale)}. ` : ''}С единицы: ${money2(sale - buy)} · маржинальность ${sale > 0 ? pct((sale - buy) / sale) : '—'} (от цены закупки). Цена из наценки округляется до целого сома.`
    : 'Меняете наценку — пересчитывается цена, меняете цену — пересчитывается наценка.';
  renderGenPreview();
}

// Поставщики для карточки товара. Без права их видеть — только текущий поставщик товара.
let suppliersCache = null;
async function fillSupplierSelect(product) {
  const sel = $('#pf-supplier');
  const current = product?.supplier_id ? [{ id: product.supplier_id, name: product.supplier_name || 'Поставщик' }] : [];
  const render = (list) => {
    const all = [...list, ...current.filter((c) => !list.some((x) => x.id === c.id))];
    sel.innerHTML = '<option value="">Не указан</option>' + all.map((x) => `<option value="${x.id}" ${x.id === product?.supplier_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  };
  render(suppliersCache || []);
  if (!suppliersCache) {
    try { suppliersCache = await api('/api/suppliers'); } catch { suppliersCache = []; }
    if (editingProduct === product) render(suppliersCache);
  }
}

function renderBarcodePreview() {
  const code = $('#pf-barcode').value.trim();
  const svg = code ? barcodeSvg(code) : null;
  $('#pf-barcode-preview').hidden = !svg;
  if (svg) $('#pf-barcode-preview').innerHTML = svg;
}

// Калькулятор $ → сом в карточке товара. Курс — из «Настроек»; в базу записываются только сомы.
let usdRate = null;
const round2 = (n) => Math.round(n * 100) / 100;
function loadUsdRate() {
  api('/api/settings/currency').then((r) => { usdRate = r.usdRate || null; }, () => { usdRate = null; }).finally(renderUsd);
}
function renderUsd() {
  $('#pf-usd').hidden = false;
  const on = usdRate > 0;
  for (const id of ['#pf-usd-purchase', '#pf-usd-price']) $(id).closest('.field').hidden = !on;
  $('#pf-usd-note').innerHTML = on
    ? `Курс: 1 $ = ${esc(fmtNum(usdRate))} сом${session.can('settings') ? ' (меняется в «Настройках»)' : ''}. Вводите цену в $ — сомы посчитаются сами; цена продажи округляется до целого сома.`
    : session.can('settings') ? 'Чтобы вводить цены в долларах, укажите курс доллара в «Настройках».' : 'Цены в долларах можно вводить, когда владелец укажет курс доллара в «Настройках».';
  fillUsdFromSom();
}
// $-поля повторяют сомы (кроме поля, которое сейчас вводят).
function fillUsdFromSom(skip = '') {
  if (!(usdRate > 0)) return;
  const f = $('#product-form');
  for (const [id, key] of [['pf-usd-purchase', 'purchase'], ['pf-usd-price', 'price']]) {
    if (id === skip) continue;
    const som = parseNum(f.elements[key].value);
    $('#' + id).value = som > 0 ? fmtNum(round2(som / usdRate)) : '';
  }
}

// Номер открытия окна: повтор той же отправки (зависла связь) сервер узнаёт и копию не создаёт.
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
let productRequestId = '';

function openProductDialog(product = null, onSaved = null) {
  editingProduct = product;
  productRequestId = newRequestId();
  delete $('#product-form').dataset.busy;
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
      <div class="field"><label>${esc(k)}</label><input class="input" data-opt="${esc(k)}" value="${esc(v)}" autocomplete="off" list="opt-list-${esc(k.replace(/\W/g, '_'))}">
      <datalist id="opt-list-${esc(k.replace(/\W/g, '_'))}">${knownValues(k).map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>`).join('');
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
    for (const key of ['name', 'category', 'code', 'barcode', 'unit', 'price', 'cost', 'description', 'article']) f.elements[key].value = product[key] ?? '';
    f.elements.price.value = fmtNum(product.price);
    f.elements.cost.value = product.cost ? fmtNum(product.cost) : '';
    const purchase = product.purchase ?? product.cost;
    f.elements.purchase.value = purchase ? fmtNum(purchase) : '';
    f.elements.discount.value = product.discount ? fmtNum(product.discount) : '';
    const mkBase = purchase || product.cost;
    f.elements.markup.value = mkBase > 0 ? fmtNum(((product.price - mkBase) / mkBase) * 100) : '';
    f.elements.archived.checked = Boolean(product.archived);
  }
  // У нового товара себестоимость повторяет закупку, пока её не поменяли отдельно.
  f.dataset.costFollows = !product || !product.cost || product.cost === (product.purchase ?? product.cost) ? '1' : '0';
  fillSupplierSelect(product);
  gen.options = [{ name: 'Цвет', values: '' }, { name: 'Размер', values: '' }];
  gen.edits = {};
  $('#pf-gen').open = false;
  $('#pf-variants').hidden = variant || !session.can('products');
  renderVariantsList();
  renderGenOptions();
  $('#categories').innerHTML = categories.names().map((c) => `<option value="${esc(c)}">`).join('');
  syncPrices();
  renderUsd();
  loadUsdRate();
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

// Готовые значения свойства — галочками, чтобы не писать каждый раз заново:
// сначала те, что уже есть у товаров (чаще встречающиеся — раньше), затем стандартные цвета или размеры.
const PRESET_COLORS = ['Черный', 'Белый', 'Серый', 'Темно-серый', 'Темно-синий', 'Синий', 'Голубой', 'Бежевый', 'Молочный', 'Хаки', 'Оливковый', 'Зеленый', 'Коричневый', 'Бордовый', 'Красный'];
const PRESET_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const SIZE_RANK = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
const isSizeOption = (name) => /размер|рост|size/i.test(name);
function sizeSort(values) {
  const rank = (v) => {
    const u = String(v).toUpperCase().replace(/\s/g, '');
    const i = SIZE_RANK.indexOf(u === '2XL' ? 'XXL' : u === 'XXXL' ? '3XL' : u);
    if (i >= 0) return i;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? 100 + n : null;
  };
  return values.every((v) => rank(v) !== null) ? [...values].sort((a, b) => rank(a) - rank(b)) : values;
}
function knownValues(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return [];
  const count = new Map();
  for (const p of catalog.list) {
    if (!p.parent_id || !p.options) continue;
    let opts;
    try { opts = typeof p.options === 'string' ? JSON.parse(p.options) : p.options; } catch { continue; }
    for (const [k, v] of Object.entries(opts || {})) {
      if (normVal(k) !== normVal(key) || !String(v).trim()) continue;
      const val = String(v).trim();
      const same = [...count.keys()].find((x) => normVal(x) === normVal(val)) || val;
      count.set(same, (count.get(same) || 0) + 1);
    }
  }
  let list = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  const preset = typeof isColorOption === 'function' && isColorOption(name) ? PRESET_COLORS : isSizeOption(name) ? PRESET_SIZES : [];
  for (const v of preset) if (!list.some((x) => normVal(x) === normVal(v))) list.push(v);
  if (isSizeOption(name)) list = sizeSort(list);
  return list.slice(0, 40);
}
const normVal = (v) => String(v).trim().toLowerCase().replace(/ё/g, 'е');
const genValues = (text) => String(text || '').split(/[,;\n]/).map((v) => v.trim()).filter(Boolean);
function genChipsHtml(o, i) {
  const vals = knownValues(o.name);
  if (!vals.length) return '';
  const chosen = new Set(genValues(o.values).map(normVal));
  const color = typeof isColorOption === 'function' && isColorOption(o.name);
  return vals.map((v) => `<button type="button" class="gen-chip" data-chip-i="${i}" data-chip-v="${esc(v)}" aria-pressed="${chosen.has(normVal(v))}">${color && typeof swatchBg === 'function' ? `<i style="background:${swatchBg(v)}"></i>` : ''}${esc(v)}</button>`).join('')
    + `<button type="button" class="link gen-chip-all" data-chip-all="${i}">${vals.every((v) => chosen.has(normVal(v))) ? 'Снять все' : 'Выбрать все'}</button>`;
}
function renderGenChips(i) {
  const box = $(`#pf-gen-options .gen-row[data-i="${i}"] .gen-chips`);
  if (box) box.innerHTML = genChipsHtml(gen.options[i], i);
}

function renderGenOptions() {
  $('#pf-gen-options').innerHTML = gen.options.map((o, i) => `
    <div class="gen-row" data-i="${i}">
      <input class="input" data-gen="name" value="${esc(o.name)}" placeholder="Свойство" aria-label="Свойство" autocomplete="off">
      <input class="input" data-gen="values" value="${esc(o.values)}" placeholder="Отметьте ниже или впишите через запятую" aria-label="Значения" autocomplete="off">
      <button type="button" class="icon-btn" data-gen-del="${i}" aria-label="Убрать свойство">×</button>
      <div class="gen-chips" role="group" aria-label="Готовые значения">${genChipsHtml(o, i)}</div>
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
      cost: parseNum(f.elements.cost.value) || parseNum(f.elements.purchase.value) || 0,
      purchase: parseNum(f.elements.purchase.value) || 0,
      stock: stock ? parseNum(stock) : 0,
    };
  });
}

$('#product-form').addEventListener('input', (e) => {
  const name = e.target.name;
  if (['cost', 'price', 'markup', 'purchase', 'discount'].includes(name)) { syncPrices(name); fillUsdFromSom(); }
  if ((e.target.id === 'pf-usd-purchase' || e.target.id === 'pf-usd-price') && usdRate > 0) {
    const usd = parseNum(e.target.value);
    const price = e.target.id === 'pf-usd-price';
    const key = price ? 'price' : 'purchase';
    $('#product-form').elements[key].value = e.target.value.trim() && usd >= 0 ? fmtNum(price ? round0(usd * usdRate) : round2(usd * usdRate)) : '';
    syncPrices(key);
    fillUsdFromSom(e.target.id);
    return;
  }
  if (name === 'barcode') renderBarcodePreview();
  const combo = e.target.closest('tr[data-label]');
  if (combo && e.target.dataset.combo) {
    const label = combo.dataset.label;
    gen.edits[label] = { ...gen.edits[label], [e.target.dataset.combo]: e.target.value };
    return;
  }
  const g = e.target.dataset.gen;
  if (g) {
    const i = Number(e.target.closest('.gen-row').dataset.i);
    gen.options[i][g] = e.target.value;
    renderGenChips(i);
    renderGenPreview();
  }
});
$('#product-form').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip-v]');
  const all = e.target.closest('[data-chip-all]');
  if (chip || all) {
    const i = Number((chip || all).dataset[chip ? 'chipI' : 'chipAll']);
    const o = gen.options[i];
    let vals = genValues(o.values);
    const has = (v) => vals.some((x) => normVal(x) === normVal(v));
    if (chip) {
      const v = chip.dataset.chipV;
      vals = has(v) ? vals.filter((x) => normVal(x) !== normVal(v)) : [...vals, v];
    } else {
      const known = knownValues(o.name);
      vals = known.every(has) ? vals.filter((x) => !known.some((k) => normVal(k) === normVal(x))) : [...vals, ...known.filter((v) => !has(v))];
    }
    if (isSizeOption(o.name)) vals = sizeSort(vals);
    o.values = vals.join(', ');
    $(`#pf-gen-options .gen-row[data-i="${i}"] [data-gen="values"]`).value = o.values;
    renderGenChips(i);
    renderGenPreview();
    return;
  }
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
  // Пока идёт сохранение, повторное нажатие «Сохранить» (или Enter) ничего не делает.
  if (f.dataset.busy) return;
  const variant = Boolean(editingProduct?.parent_id);
  const body = {
    barcode: f.elements.barcode.value,
    code: f.elements.code.value,
    article: f.elements.article.value,
    supplier_id: f.elements.supplier_id.value || null,
    price: f.elements.price.value,
    purchase: f.elements.purchase.value || 0,
    cost: f.elements.cost.value || f.elements.purchase.value || 0,
    discount: f.elements.discount.value || 0,
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
  const submit = f.querySelector('button[type=submit]');
  const label = submit.textContent;
  f.dataset.busy = '1';
  submit.disabled = true;
  submit.textContent = 'Сохраняю…';
  let saved = null;
  try {
    saved = await api(editingProduct ? `/api/products/${editingProduct.id}` : '/api/products', { method: editingProduct ? 'PUT' : 'POST', body: { ...body, requestId: productRequestId } });
    let made = [];
    if (variants.length) made = await api(`/api/products/${saved.id}/variants`, { method: 'POST', body: { variants, barcodes: $('#pf-gen-barcodes').checked, requestId: productRequestId } });
    $('#product-dialog').close();
    toast((editingProduct ? 'Сохранено' : `Товар «${saved.name}» добавлен`) + (made.length ? `, модификаций: ${made.length}` : ''));
    await catalog.load();
    productDialogDone?.(saved);
  } catch (err) {
    showFormError('#product-error', err);
    // Товар мог сохраниться, а модификации — нет: дальше правим уже его (повторное «Сохранить» не создаст копию).
    await catalog.load().catch(() => {});
    if (saved && !editingProduct) {
      editingProduct = catalog.byId(saved.id) || saved;
      $('#product-dialog-title').textContent = 'Изменить товар';
    }
    renderVariantsList();
    renderGenPreview();
  } finally {
    delete f.dataset.busy;
    submit.disabled = false;
    submit.textContent = label;
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
  const stock = e.target.closest('[data-stock]');
  if (stock) return openStockDialog(catalog.byId(stock.dataset.stock));
  // Показать / скрыть модификации этого товара.
  const vt = e.target.closest('[data-variants-toggle]');
  if (vt) {
    const id = Number(vt.dataset.variantsToggle);
    if (productsView.toggled.has(id)) productsView.toggled.delete(id); else productsView.toggled.add(id);
    return renderProducts();
  }
  // Этикетка: у товара с модификациями — выбор, какие печатать.
  const pl = e.target.closest('[data-print-labels]');
  if (pl) return printProductLabels(Number(pl.dataset.printLabels));
  // Клик по ячейке выбора (мимо галочки) не открывает карточку.
  if (e.target.closest('td.sel')) return;
  const card = e.target.closest('[data-card]');
  if (card) openProductCard(Number(card.dataset.card));
});
$('#products-body').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('tr[data-card]')) return;
  e.preventDefault();
  openProductCard(Number(e.target.dataset.card));
});
$('#product-add').addEventListener('click', () => openProductDialog(null, renderProducts));
$('#products-search').addEventListener('input', (e) => { productsView.query = e.target.value; renderProducts(); });
$('#bulk-form').addEventListener('change', (e) => {
  if (e.target.id === 'bf-value' && $('#bf-new-field')) $('#bf-new-field').hidden = e.target.value !== '__new';
});
$('#products-category').addEventListener('change', (e) => { productsView.category = e.target.value; productsView.selected.clear(); renderProducts(); });

/* ---------- Этикетки на строке товара ---------- */
// Обычный товар или модификация — сразу окно печати (шаблон из конструктора). Товар с модификациями —
// сначала выбор: все, одна или несколько.
let labelPickFor = [];
document.body.insertAdjacentHTML('beforeend', `
<dialog id="label-pick" aria-labelledby="label-pick-title">
  <h2 id="label-pick-title">Этикетки</h2>
  <p class="sub" id="label-pick-sub">Отметьте модификации, для которых печатать этикетки.</p>
  <div class="label-pick-tools"><button type="button" class="btn small" data-lp-all="1">Выбрать все</button><button type="button" class="btn small ghost" data-lp-all="0">Снять все</button></div>
  <div class="label-pick-list" id="label-pick-list"></div>
  <p class="form-error" id="label-pick-error" role="alert" hidden></p>
  <div class="form-actions"><button type="button" class="btn ghost" id="label-pick-cancel">Отмена</button><button type="button" class="btn primary" id="label-pick-ok">Дальше</button></div>
</dialog>`);
function printProductLabels(id) {
  const list = productsView.list.length ? productsView.list : catalog.list;
  const p = list.find((x) => x.id === id);
  if (!p) return toast('Товар не найден — обновите страницу', 'error');
  const kids = list.filter((x) => x.parent_id === id);
  if (!kids.length) return openLabels([p]);
  labelPickFor = kids;
  $('#label-pick-title').textContent = `Этикетки: ${p.name}`;
  $('#label-pick-list').innerHTML = kids.map((k) => `<label class="check label-pick-row"><input type="checkbox" value="${k.id}" checked>
    <span><b>${esc(optionsText(k) || k.name)}</b><small>${esc([k.code && `код ${k.code}`, k.barcode || 'нет штрихкода', k.stock === null ? '' : `остаток ${qty(k.stock, k.unit)}`].filter(Boolean).join(' · '))}</small></span></label>`).join('');
  syncLabelPick();
  $('#label-pick').showModal();
}
function syncLabelPick() {
  const n = $('#label-pick-list').querySelectorAll('input:checked').length;
  $('#label-pick-ok').textContent = n ? `Дальше (${n})` : 'Дальше';
  $('#label-pick-ok').disabled = !n;
  $('#label-pick-error').hidden = true;
}
$('#label-pick-list').addEventListener('change', syncLabelPick);
$('#label-pick').addEventListener('click', (e) => {
  const all = e.target.closest('[data-lp-all]');
  if (!all) return;
  for (const c of $('#label-pick-list').querySelectorAll('input')) c.checked = all.dataset.lpAll === '1';
  syncLabelPick();
});
$('#label-pick-cancel').addEventListener('click', () => $('#label-pick').close());
$('#label-pick-ok').addEventListener('click', () => {
  const ids = new Set([...$('#label-pick-list').querySelectorAll('input:checked')].map((c) => Number(c.value)));
  if (!ids.size) return showFormError('#label-pick-error', new Error('Отметьте хотя бы одну модификацию'));
  $('#label-pick').close();
  openLabels(labelPickFor.filter((k) => ids.has(k.id)));
});

/* ---------- Модификации: показать / скрыть все ---------- */
$('#products-variants').addEventListener('click', () => {
  productsView.showVariants = !productsView.showVariants;
  productsView.toggled.clear();
  try { localStorage.setItem('products.variants', productsView.showVariants ? 'show' : 'hide'); } catch { /* без памяти */ }
  renderProducts();
});

/* ---------- Категории над списком товаров ---------- */
function renderCategoryChips(list, catOf) {
  const goods = list.filter((p) => !p.parent_id);
  const count = new Map();
  for (const p of goods) count.set(catOf(p) || '—', (count.get(catOf(p) || '—') || 0) + 1);
  const chip = (value, label, n) => `<button type="button" class="chip" data-cat-chip="${esc(value)}" aria-pressed="${productsView.category === value}">${esc(label)} <small>${n}</small></button>`;
  $('#products-cats').innerHTML = chip('', 'Все', goods.length)
    + categories.list.map((c) => chip(c.name, c.name, count.get(c.name) || 0)).join('')
    + (count.get('—') ? chip('—', 'Без категории', count.get('—')) : '')
    + (session.can('products') ? '<button type="button" class="chip add" id="products-cat-add">+ Категория</button>' : '');
}
$('#products-cats').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-cat-chip]');
  if (c) {
    productsView.category = c.dataset.catChip;
    productsView.selected.clear();
    return renderProducts();
  }
  if (e.target.closest('#products-cat-add')) {
    const name = (prompt('Название новой категории') || '').trim();
    if (!name) return;
    try {
      await api('/api/categories', { method: 'POST', body: { name } });
      toast(`Категория «${name}» создана`);
      renderProducts();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

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
