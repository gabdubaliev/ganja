'use strict';

// Конструктор интернет-витрины: шаблоны, цвета, тексты, картинки, каталог,
// доставка и свой CSS. Изменения сразу видны в предпросмотре, «Сохранить» публикует их.

const SHOP_TEMPLATES = {
  light: { name: 'Светлый', accent: '#2a78d6', bg: '#ffffff', surface: '#f4f6fa', ink: '#111827', headingFont: 'Manrope', bodyFont: 'Inter', radius: 16, buttonStyle: 'pill', cardShadow: 'soft', heroStyle: 'image', cardRatio: '4:5', columns: 4 },
  boutique: { name: 'Бутик', accent: '#111111', bg: '#faf7f2', surface: '#efe9e1', ink: '#1a1a1a', headingFont: 'Cormorant Garamond', bodyFont: 'Jost', radius: 0, buttonStyle: 'square', cardShadow: 'none', heroStyle: 'split', cardRatio: '3:4', columns: 3 },
  terracotta: { name: 'Терракота', accent: '#c2410c', bg: '#ffffff', surface: '#f6f3ef', ink: '#1c1917', headingFont: 'Manrope', bodyFont: 'Inter', radius: 16, buttonStyle: 'pill', cardShadow: 'soft', heroStyle: 'image', cardRatio: '4:5', columns: 4 },
  pastel: { name: 'Пастель', accent: '#db2777', bg: '#fffafc', surface: '#fbeef4', ink: '#2a1621', headingFont: 'Comfortaa', bodyFont: 'Nunito', radius: 24, buttonStyle: 'pill', cardShadow: 'soft', heroStyle: 'split', cardRatio: '1:1', columns: 4 },
  night: { name: 'Ночной люкс', accent: '#d4a64a', bg: '#0f0f10', surface: '#1b1b1d', ink: '#f4efe6', headingFont: 'Playfair Display', bodyFont: 'Inter', radius: 6, buttonStyle: 'rounded', cardShadow: 'outline', heroStyle: 'image', cardRatio: '3:4', columns: 4 },
  fresh: { name: 'Эко', accent: '#2f7d4a', bg: '#fbfdf8', surface: '#edf4e8', ink: '#1b2a17', headingFont: 'Rubik', bodyFont: 'Rubik', radius: 20, buttonStyle: 'rounded', cardShadow: 'none', heroStyle: 'gradient', cardRatio: '1:1', columns: 4 },
  street: { name: 'Стрит', accent: '#facc15', bg: '#ffffff', surface: '#f3f3f3', ink: '#0a0a0a', headingFont: 'Unbounded', bodyFont: 'Montserrat', radius: 4, buttonStyle: 'square', cardShadow: 'outline', heroStyle: 'image', cardRatio: '4:5', columns: 4 },
  tech: { name: 'Техно', accent: '#6741d9', bg: '#f7f7fb', surface: '#ffffff', ink: '#15131f', headingFont: 'Montserrat', bodyFont: 'Inter', radius: 10, buttonStyle: 'rounded', cardShadow: 'strong', heroStyle: 'gradient', cardRatio: '1:1', columns: 5 },
};
// «Минимал» — строгая витрина одежды: сетка, прописные заголовки, без теней. Два цвета: красный и тёмно-синий.
// fill — тексты для мужской одежды, подставляются только в пустые поля (свои тексты не затираются).
const MENSWEAR_FILL = {
  heroButton: 'Смотреть коллекцию',
  announce: 'Новая коллекция уже в магазине · Примерка при получении · Обмен и возврат 14 дней',
  perks: [{ icon: '🚚', text: 'Доставка по городу за 1 день', on: true }, { icon: '👔', text: 'Примерка при получении', on: true },
    { icon: '↺', text: 'Обмен и возврат 14 дней', on: true }, { icon: '📏', text: 'Размеры от S до 4XL', on: true }],
  productNotes: [{ text: 'Доставка по городу за 1 день', on: true }, { text: 'Примерка при получении — не подошло, вернёте курьеру', on: true },
    { text: 'Обмен и возврат 14 дней', on: true }],
  sizeChart: 'Размер; Грудь, см; Талия, см; Рост, см\nS; 88–92; 76–80; 170–176\nM; 96–100; 84–88; 176–182\nL; 104–108; 92–96; 176–182\nXL; 112–116; 100–104; 182–188\nXXL; 120–124; 108–112; 182–188\n3XL; 128–132; 116–120; 188–194',
};
const MINIMAL = { look: 'minimal', bg: '#ffffff', surface: '#f4f4f4', ink: '#1b1b1b', headingFont: 'Roboto', bodyFont: 'Roboto', radius: 0, buttonStyle: 'square', cardShadow: 'none', heroStyle: 'image', heroHeight: 'large', heroAlign: 'left', headerStyle: 'left', cardRatio: '3:4', imageFit: 'cover', columns: 4, mobileColumns: 2, fill: MENSWEAR_FILL };
SHOP_TEMPLATES.minimal = { name: 'Минимал красный', accent: '#e60012', ...MINIMAL };
SHOP_TEMPLATES.minimalNavy = { name: 'Минимал тёмно-синий', accent: '#1f3a68', ...MINIMAL, surface: '#f2f3f5', ink: '#141821' };
// Остальные шаблоны — в обычном стиле: иначе после «Минимала» стиль остался бы строгим.
for (const t of Object.values(SHOP_TEMPLATES)) t.look ||= 'modern';
const FONT_NAMES = { system: 'Обычный', serif: 'С засечками', rounded: 'Округлый', mono: 'Моноширинный', condensed: 'Узкий' };
const builder = { saved: null, draft: null, products: [], ready: false };

const shopFrame = () => $('#shop-preview');

async function renderShop() {
  try {
    [builder.saved, builder.products] = await Promise.all([api('/api/shop'), catalog.load(), loadCustomFonts()]);
  } catch (err) {
    return toast(err.message, 'error');
  }
  builder.draft = structuredClone(builder.saved);
  const created = builder.saved.enabled || builder.saved.created;
  $('#shop-create').hidden = Boolean(created);
  $('#shop-builder').hidden = !created;
  renderShopTools();
  if (!created) return;
  fillShopForm();
  loadPayAccounts();
  if (shopFrame().src.endsWith('about:blank')) {
    builder.ready = false;
    shopFrame().src = '/shop';
  } else {
    pushPreview();
  }
}

function renderShopTools() {
  const s = builder.saved;
  const url = location.origin + '/shop';
  $('#shop-state').textContent = s.enabled ? 'Открыта для покупателей' : s.created ? 'Закрыта — видите только вы' : '';
  $('#shop-tools').innerHTML = s.enabled || s.created ? `
    <a class="btn" href="/shop" target="_blank" rel="noopener">Открыть витрину ↗</a>
    <button type="button" class="btn" id="shop-copy" data-url="${esc(url)}">Скопировать ссылку</button>
    <button type="button" class="btn ${s.enabled ? '' : 'primary'}" id="shop-toggle">${s.enabled ? 'Закрыть витрину' : 'Открыть для покупателей'}</button>` : '';
}

function fillShopForm() {
  const f = $('#shop-form');
  const d = builder.draft;
  $('#shop-templates').innerHTML = Object.entries(SHOP_TEMPLATES).map(([key, t]) => `
    <button type="button" class="template ${d.template === key ? 'on' : ''}" data-template="${key}" style="--t-bg:${t.bg};--t-surface:${t.surface};--t-accent:${t.accent};--t-ink:${t.ink};--t-radius:${Math.min(t.radius, 12)}px">
      <span class="t-swatch"><i></i><i></i><i></i></span>${t.name}
    </button>`).join('');
  // Свои загруженные шрифты — первыми в списках шрифтов витрины.
  for (const sel of f.querySelectorAll('select[name="headingFont"], select[name="bodyFont"]')) {
    sel.querySelector('optgroup.custom')?.remove();
    const fams = customFamilyList();
    if (fams.length) sel.insertAdjacentHTML('afterbegin', `<optgroup class="custom" label="Мои шрифты">${fams.map((x) => `<option value="${esc(x)}" style="font-family:'${esc(x)}'">${esc(x)}</option>`).join('')}</optgroup>`);
  }
  for (const sel of f.querySelectorAll('select.fonts')) sel.innerHTML = Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  for (const el of f.elements) {
    if (!el.name || !(el.name in d)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(d[el.name]);
    else el.value = d[el.name] ?? '';
  }
  renderLists();
  renderSizeEdit();
  renderColorMap();
  const cats = [...new Set(builder.products.map((p) => p.category).filter(Boolean))].sort();
  $('#shop-cats').innerHTML = cats.length ? cats.map((c) => `<label class="check"><input type="checkbox" data-cat="${esc(c)}" ${d.categories.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') : '<span class="pick-meta">У товаров пока нет категорий</span>';
  renderImagePicks();
  renderPays();
  renderOutputs();
  markDirty();
}

/* ---------- Способы оплаты: QR-код, реквизиты, счёт ---------- */
let payAccounts = [];
async function loadPayAccounts() {
  try { payAccounts = (await api('/api/payment-methods')).methods || []; } catch { payAccounts = []; }
  renderPays();
}
function renderPays() {
  const list = builder.draft.payments || [];
  $('#shop-pays').innerHTML = list.length ? list.map((p, i) => `<div class="shop-pay">
      <div class="qr">${p.qrId ? `<img src="/img/${p.qrId}" alt="QR-код">` : '<div class="empty-qr">QR-кода нет</div>'}
        <button type="button" class="btn small" data-pay-qr="${i}">${p.qrId ? 'Заменить QR' : 'Загрузить QR'}</button>
        ${p.qrId ? `<button type="button" class="btn small ghost" data-pay-qr-del="${i}">Убрать QR</button>` : ''}</div>
      <div class="fields">
        <div class="field"><label>Название для покупателя</label><input class="input" data-pay-i="${i}" data-pay-f="name" value="${esc(p.name || '')}" placeholder="Например: МБАНК по QR"></div>
        <div class="field"><label>Реквизиты (необязательно)</label><textarea class="input" data-pay-i="${i}" data-pay-f="details" placeholder="Номер телефона или счёта, получатель">${esc(p.details || '')}</textarea></div>
        <div class="field"><label>Куда приходят деньги (счёт в программе)</label><select class="input" data-pay-i="${i}" data-pay-f="methodId">
          <option value="">— выбрать при выдаче —</option>${payAccounts.map((m) => `<option value="${m.id}" ${Number(p.methodId) === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <button type="button" class="btn small ghost danger-text" data-pay-del="${i}">Удалить способ</button>
      </div></div>`).join('') : '<p class="pick-meta">Способов оплаты нет — покупатели платят при получении.</p>';
}
$('#shop-pays').addEventListener('input', (e) => {
  const el = e.target.closest('[data-pay-f]');
  if (!el) return;
  const p = builder.draft.payments[Number(el.dataset.payI)];
  p[el.dataset.payF] = el.dataset.payF === 'methodId' ? (el.value ? Number(el.value) : null) : el.value;
});
$('#shop-pays').addEventListener('change', (e) => { if (e.target.closest('[data-pay-f]')) { markDirty(); pushPreview(); } });
$('#shop-pay-add').addEventListener('click', () => {
  builder.draft.payments = [...(builder.draft.payments || []), { id: '', name: 'Перевод по QR-коду', qrId: null, details: '', methodId: null }];
  renderPays();
  markDirty();
});
$('#shop-pays').addEventListener('click', async (e) => {
  const qr = e.target.closest('[data-pay-qr]');
  const qrDel = e.target.closest('[data-pay-qr-del]');
  const del = e.target.closest('[data-pay-del]');
  const list = builder.draft.payments;
  if (del) {
    list.splice(Number(del.dataset.payDel), 1);
  } else if (qrDel) {
    list[Number(qrDel.dataset.payQrDel)].qrId = null;
  } else if (qr) {
    const file = await pickFile();
    if (!file) return;
    try {
      // PNG без сжатия деталей — чтобы QR-код точно считывался.
      const { id } = await api('/api/images', { method: 'POST', body: { mime: 'image/png', data: await shrinkPhoto(file, 1000, 'image/png') } });
      list[Number(qr.dataset.payQr)].qrId = id;
      toast('QR-код загружен. Нажмите «Сохранить», чтобы покупатели увидели новый');
    } catch (err) {
      return toast(err.message, 'error');
    }
  } else return;
  renderPays();
  markDirty();
  pushPreview();
});

function renderImagePicks() {
  for (const el of document.querySelectorAll('#shop-form .image-pick')) {
    const id = builder.draft[el.dataset.image];
    el.innerHTML = id
      ? `<img src="/img/${id}" alt=""><button type="button" class="btn small ghost" data-image-del="${el.dataset.image}">Убрать</button>`
      : `<button type="button" class="btn small" data-image-add="${el.dataset.image}">Загрузить</button>`;
  }
}

function renderOutputs() {
  for (const out of document.querySelectorAll('#shop-form [data-out]')) out.textContent = builder.draft[out.dataset.out];
}

// Товары витрины по черновику настроек — та же логика, что на сервере.
function draftProducts() {
  const d = builder.draft;
  const cats = new Set(d.categories);
  const shown = (p) => p.price > 0 && (!d.hideOutOfStock || p.stock > 0);
  const toShop = (p) => ({ id: p.id, name: p.name, category: p.category, unit: p.unit, price: salePrice(p), oldPrice: p.discount > 0 ? p.price : null, created_at: p.created_at, description: p.description || '',
    photo_at: p.photo_at, photo: Boolean(p.photo_at), parent_id: p.parent_id || null, options: p.options ? JSON.parse(p.options) : null,
    hasVariants: catalog.isGroup(p), stock: d.showStock ? Math.max(0, p.stock) : p.stock > 0 ? 1 : 0 });
  const out = [];
  const bases = builder.products.filter((p) => !p.parent_id && (!cats.size || cats.has(p.category)))
    .sort((a, b) => a.category.localeCompare(b.category, 'ru') || a.name.localeCompare(b.name, 'ru'));
  for (const p of bases) {
    const variants = catalog.children(p.id).filter(shown);
    if (catalog.isGroup(p) ? !variants.length : !shown(p)) continue;
    out.push(p, ...variants);
  }
  return out.map(toShop);
}

function pushPreview() {
  if (!builder.ready) return;
  const settings = { ...builder.draft, payments: (builder.draft.payments || []).map((p) => ({ ...p, qr: p.qrId ? `/img/${p.qrId}` : null })) };
  shopFrame().contentWindow.postMessage({ type: 'shop-preview', settings, products: draftProducts() }, location.origin);
}

function markDirty() {
  const dirty = JSON.stringify(builder.draft) !== JSON.stringify(builder.saved);
  $('#shop-dirty').textContent = dirty ? 'Есть несохранённые изменения' : 'Всё сохранено';
}

function readShopForm() {
  const f = $('#shop-form');
  const d = builder.draft;
  for (const el of f.elements) {
    if (!el.name || !(el.name in d)) continue;
    if (el.type === 'checkbox') d[el.name] = el.checked;
    else if (el.type === 'range' || ['deliveryPrice', 'minOrder', 'newDays', 'mobileColumns'].includes(el.name)) d[el.name] = parseNum(el.value) || 0;
    else d[el.name] = el.value;
  }
  d.categories = [...document.querySelectorAll('#shop-cats [data-cat]:checked')].map((i) => i.dataset.cat);
  readLists();
  readSizeEdit();
  const map = { ...(d.colorMap || {}) };
  for (const inp of document.querySelectorAll('#color-map input[data-cm]')) if (inp.dataset.own === '1') map[inp.dataset.cm] = inp.value;
  d.colorMap = map;
}

/* ---------- Цвета кружков расцветок ---------- */
function productColors() {
  const set = new Set();
  // Модификации по товарам: цвет определяется так же, как на витрине (по названию свойства или по значениям).
  const groups = new Map();
  for (const p of builder.products) {
    if (!p.options || !p.parent_id) continue;
    let o = {};
    try { o = typeof p.options === 'string' ? JSON.parse(p.options) : p.options; } catch { continue; }
    groups.set(p.parent_id, [...(groups.get(p.parent_id) || []), o || {}]);
  }
  for (const list of groups.values()) {
    const opt = detectColorOption(list, builder.draft?.colorMap || {});
    if (opt) for (const o of list) if (o[opt]) set.add(String(o[opt]));
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}
function renderColorMap() {
  const box = $('#color-map');
  if (!box) return;
  const map = builder.draft.colorMap || {};
  const names = productColors();
  const toHex = (c) => (c && c.startsWith('#') ? c : '#cccccc');
  box.innerHTML = names.length ? names.map((n) => {
    const own = Boolean(map[n]);
    const auto = colorHex(n, {});
    return `<div class="cm-row ${own ? 'own' : ''}">
      <label class="cm-dot" style="background:${own ? map[n] : swatchBg(n, {})}"><input type="color" data-cm="${esc(n)}" data-own="${own ? 1 : 0}" value="${toHex(map[n] || auto)}" aria-label="Цвет «${esc(n)}»"></label>
      <span>${esc(n)}${!own && !auto ? ' <small>— не узнали, выберите</small>' : ''}</span>
      ${own ? `<button type="button" class="btn small ghost" data-cm-reset="${esc(n)}" title="Как по названию">↺</button>` : ''}
    </div>`;
  }).join('') : '<span class="pick-meta">У товаров нет модификаций со свойством «Цвет». Добавьте его в карточке товара (модификации: Цвет, Размер).</span>';
}

/* ---------- Списки строк (преимущества, строки в окне товара) ---------- */
const LIST_MAX = 8;
function renderLists() {
  for (const box of document.querySelectorAll('#shop-form .list-edit')) {
    const icon = box.dataset.icon !== undefined;
    const items = builder.draft[box.dataset.list] || [];
    box.innerHTML = items.map((x, i) => `
      <div class="le-row ${x.on === false ? 'off' : ''}">
        <input type="checkbox" data-le="on" ${x.on === false ? '' : 'checked'} title="Показывать строку" aria-label="Показывать строку">
        ${icon ? `<input class="input le-icon" data-le="icon" value="${esc(x.icon || '')}" maxlength="8" list="perk-icons" placeholder="—" aria-label="Значок">` : ''}
        <input class="input le-text" data-le="text" value="${esc(x.text || '')}" maxlength="${icon ? 80 : 200}" placeholder="Текст строки">
        <span class="le-tools">
          <button type="button" class="btn small ghost" data-le-move="-1" data-i="${i}" ${i ? '' : 'disabled'} title="Выше">↑</button>
          <button type="button" class="btn small ghost" data-le-move="1" data-i="${i}" ${i < items.length - 1 ? '' : 'disabled'} title="Ниже">↓</button>
          <button type="button" class="btn small ghost" data-le-del data-i="${i}" title="Удалить">✕</button>
        </span>
      </div>`).join('')
      + (items.length < LIST_MAX ? '<button type="button" class="btn small" data-le-add>+ Добавить строку</button>' : '');
  }
}
function readLists() {
  for (const box of document.querySelectorAll('#shop-form .list-edit')) {
    builder.draft[box.dataset.list] = [...box.querySelectorAll('.le-row')].map((r) => ({
      ...(box.dataset.icon !== undefined && { icon: r.querySelector('[data-le="icon"]').value.trim() }),
      text: r.querySelector('[data-le="text"]').value,
      on: r.querySelector('[data-le="on"]').checked,
    }));
    box.querySelectorAll('.le-row').forEach((r) => r.classList.toggle('off', !r.querySelector('[data-le="on"]').checked));
  }
}

/* ---------- Таблица размеров: каждая ячейка, строка и столбец ---------- */
const parseChart = (s) => {
  const rows = String(s || '').split('\n').filter((l) => l.trim()).map((l) => l.split(/\s*[;|\t]\s*/));
  const w = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: w }, (_, i) => r[i] ?? ''));
};
const cleanCell = (v) => v.replace(/[;|\t\n]/g, ' ').trim();
let sizeRows = [];
function renderSizeEdit() {
  sizeRows = parseChart(builder.draft.sizeChart);
  const box = $('#size-edit');
  if (!sizeRows.length) {
    box.innerHTML = `<div class="se-empty">Таблицы нет — в товарах её не будет.
      <button type="button" class="btn small" data-se="seed">Создать мужскую таблицу</button>
      <button type="button" class="btn small ghost" data-se="blank">Пустая таблица</button></div>`;
    return;
  }
  const cols = sizeRows[0].length;
  const colTools = Array.from({ length: cols }, (_, c) => `<th><span class="se-tools">
      <button type="button" data-se="col-left" data-c="${c}" ${c ? '' : 'disabled'} title="Левее">←</button>
      <button type="button" data-se="col-del" data-c="${c}" ${cols > 1 ? '' : 'disabled'} title="Удалить столбец">✕</button>
      <button type="button" data-se="col-right" data-c="${c}" ${c < cols - 1 ? '' : 'disabled'} title="Правее">→</button></span></th>`).join('');
  box.innerHTML = `<div class="se-scroll"><table class="se-table">
    <thead><tr>${colTools}<th></th></tr></thead>
    <tbody>${sizeRows.map((r, ri) => `<tr class="${ri ? '' : 'se-head'}">${r.map((v, c) => `<td><input class="input" data-r="${ri}" data-c="${c}" value="${esc(v)}" placeholder="${ri ? '—' : 'Заголовок'}"></td>`).join('')}
      <td><span class="se-tools">
        <button type="button" data-se="row-up" data-r="${ri}" ${ri ? '' : 'disabled'} title="Выше">↑</button>
        <button type="button" data-se="row-down" data-r="${ri}" ${ri < sizeRows.length - 1 ? '' : 'disabled'} title="Ниже">↓</button>
        <button type="button" data-se="row-del" data-r="${ri}" title="Удалить строку">✕</button></span></td></tr>`).join('')}</tbody>
  </table></div>
  <div class="se-actions">
    <button type="button" class="btn small" data-se="row-add">+ Строка</button>
    <button type="button" class="btn small" data-se="col-add">+ Столбец</button>
    <button type="button" class="btn small ghost" data-se="clear">Удалить таблицу</button>
  </div>`;
}
function readSizeEdit() {
  for (const inp of document.querySelectorAll('#size-edit input[data-r]')) sizeRows[inp.dataset.r][inp.dataset.c] = cleanCell(inp.value);
  builder.draft.sizeChart = sizeRows.map((r) => r.join('; ')).join('\n');
}
function sizeAction(act, r, c) {
  const swap = (a, i, j) => { [a[i], a[j]] = [a[j], a[i]]; };
  const cols = sizeRows[0]?.length || 0;
  if (act === 'seed') sizeRows = parseChart(MENSWEAR_FILL.sizeChart);
  else if (act === 'blank') sizeRows = [['Размер', 'Грудь, см', 'Талия, см'], ['', '', '']];
  else if (act === 'clear') { if (!confirm('Удалить таблицу размеров целиком?')) return; sizeRows = []; }
  else if (act === 'row-add') { if (sizeRows.length < 30) sizeRows.push(Array(cols).fill('')); }
  else if (act === 'col-add') { if (cols < 10) sizeRows.forEach((row) => row.push('')); }
  else if (act === 'row-del') sizeRows.splice(r, 1);
  else if (act === 'row-up') swap(sizeRows, r, r - 1);
  else if (act === 'row-down') swap(sizeRows, r, r + 1);
  else if (act === 'col-del') sizeRows.forEach((row) => row.splice(c, 1));
  else if (act === 'col-left') sizeRows.forEach((row) => swap(row, c, c - 1));
  else if (act === 'col-right') sizeRows.forEach((row) => swap(row, c, c + 1));
  builder.draft.sizeChart = sizeRows.map((row) => row.join('; ')).join('\n');
  renderSizeEdit();
  if (act === 'row-add' || act === 'col-add') {
    const inputs = document.querySelectorAll('#size-edit input[data-r]');
    (act === 'row-add' ? inputs[inputs.length - (sizeRows[0]?.length || 1)] : document.querySelector(`#size-edit input[data-r="0"][data-c="${(sizeRows[0]?.length || 1) - 1}"]`))?.focus();
  }
}

function onShopChange() {
  readShopForm();
  renderOutputs();
  markDirty();
  pushPreview();
}

// Выбор цвета кружка: отмечаем, что цвет свой, — до общего обработчика (фаза захвата).
$('#shop-form').addEventListener('input', (e) => {
  const inp = e.target.closest('input[data-cm]');
  if (!inp) return;
  inp.dataset.own = '1';
  const dot = inp.closest('.cm-dot');
  dot.style.background = inp.value;
  dot.closest('.cm-row').classList.add('own');
}, true);
$('#shop-form').addEventListener('change', (e) => { if (e.target.matches('input[data-cm]')) renderColorMap(); });
$('#shop-form').addEventListener('input', onShopChange);
$('#shop-form').addEventListener('change', onShopChange);
$('#shop-form').addEventListener('click', async (e) => {
  const cmReset = e.target.closest('[data-cm-reset]');
  if (cmReset) {
    e.preventDefault();
    const map = { ...(builder.draft.colorMap || {}) };
    delete map[cmReset.dataset.cmReset];
    builder.draft.colorMap = map;
    renderColorMap();
    markDirty();
    return pushPreview();
  }
  // Редакторы строк и таблицы размеров.
  const le = e.target.closest('[data-le-add], [data-le-move], [data-le-del]');
  const se = e.target.closest('[data-se]');
  if (le || se) {
    e.preventDefault();
    readShopForm();
    if (se) sizeAction(se.dataset.se, Number(se.dataset.r), Number(se.dataset.c));
    else {
      const box = le.closest('.list-edit');
      const list = builder.draft[box.dataset.list];
      const i = Number(le.dataset.i);
      if (le.dataset.leAdd !== undefined) list.push({ ...(box.dataset.icon !== undefined && { icon: '✓' }), text: '', on: true });
      else if (le.dataset.leDel !== undefined) list.splice(i, 1);
      else { const j = i + Number(le.dataset.leMove); [list[i], list[j]] = [list[j], list[i]]; }
      renderLists();
      if (le.dataset.leAdd !== undefined) [...box.querySelectorAll('.le-text')].at(-1)?.focus();
    }
    renderOutputs();
    markDirty();
    return pushPreview();
  }
  const t = e.target.closest('[data-template]');
  if (t) {
    const { name, fill = {}, ...preset } = SHOP_TEMPLATES[t.dataset.template];
    Object.assign(builder.draft, preset, { template: t.dataset.template });
    for (const [k, v] of Object.entries(fill)) {
      const cur = builder.draft[k];
      if (!cur || (Array.isArray(cur) && !cur.length) || (k === 'heroButton' && cur === 'Смотреть каталог')) builder.draft[k] = structuredClone(v);
    }
    fillShopForm();
    return pushPreview();
  }
  const add = e.target.closest('[data-image-add]');
  const del = e.target.closest('[data-image-del]');
  if (del) {
    builder.draft[del.dataset.imageDel] = null;
  } else if (add) {
    const file = await pickFile();
    if (!file) return;
    const logo = add.dataset.imageAdd === 'logoId';
    try {
      const type = logo ? 'image/png' : 'image/jpeg';
      const { id } = await api('/api/images', { method: 'POST', body: { mime: type, data: await shrinkPhoto(file, logo ? 400 : 1800, type) } });
      builder.draft[add.dataset.imageAdd] = id;
    } catch (err) {
      return toast(err.message, 'error');
    }
  } else return;
  renderImagePicks();
  markDirty();
  pushPreview();
});

async function saveShop(patch = {}) {
  $('#shop-error').hidden = true;
  try {
    builder.saved = await api('/api/shop', { method: 'PUT', body: { ...builder.draft, ...patch } });
    builder.draft = { ...builder.draft, ...patch, ...builder.saved };
    session.shop = { enabled: builder.saved.enabled };
    renderShopTools();
    markDirty();
    return true;
  } catch (err) {
    showFormError('#shop-error', err);
    toast(err.message, 'error');
    return false;
  }
}

$('#shop-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveShop()) toast('Витрина сохранена');
});

$('#shop-create-btn').addEventListener('click', async () => {
  // Название витрины по умолчанию — название магазина из «Оформления».
  builder.draft = { ...builder.saved, title: session.design?.name || builder.saved.title, created: true, enabled: true };
  if (!(await saveShop())) return;
  toast('Витрина создана и открыта. Настройте её под себя — изменения видны справа.');
  shopFrame().src = 'about:blank';
  renderShop();
});

$('#shop-tools').addEventListener('click', async (e) => {
  if (e.target.id === 'shop-copy') {
    try {
      await navigator.clipboard.writeText(e.target.dataset.url);
      toast('Ссылка скопирована');
    } catch {
      toast('Ссылка: ' + e.target.dataset.url);
    }
  } else if (e.target.id === 'shop-toggle') {
    const enabled = !builder.saved.enabled;
    if (await saveShop({ enabled })) toast(enabled ? 'Витрина открыта для покупателей' : 'Витрина закрыта');
  }
});

$('#preview-size').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-size]');
  if (!btn) return;
  for (const b of $('#preview-size').children) b.setAttribute('aria-pressed', b === btn);
  $('.preview-frame').classList.toggle('mobile', btn.dataset.size === 'mobile');
});

addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'shop-ready') return;
  builder.ready = true;
  pushPreview();
});

views.shop = { show: renderShop, right: 'shop' };
