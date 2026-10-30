'use strict';

// Конструктор интернет-витрины: шаблоны, цвета, тексты, картинки, каталог,
// доставка и свой CSS. Изменения сразу видны в предпросмотре, «Сохранить» публикует их.

const SHOP_TEMPLATES = {
  light: { name: 'Светлый', accent: '#2a78d6', bg: '#ffffff', surface: '#f5f5f3', ink: '#111111', font: 'system', radius: 14, cardStyle: 'photo', columns: 4 },
  fresh: { name: 'Свежий', accent: '#2f9e44', bg: '#fbfdf8', surface: '#eef6e8', ink: '#1b2a17', font: 'rounded', radius: 20, cardStyle: 'photo', columns: 4 },
  warm: { name: 'Тёплый', accent: '#e8590c', bg: '#fff8f0', surface: '#ffffff', ink: '#2b1a0e', font: 'rounded', radius: 24, cardStyle: 'photo', columns: 3 },
  boutique: { name: 'Бутик', accent: '#111111', bg: '#faf7f2', surface: '#ffffff', ink: '#1a1a1a', font: 'serif', radius: 0, cardStyle: 'photo', columns: 3 },
  night: { name: 'Ночной', accent: '#f5b301', bg: '#111214', surface: '#1c1d21', ink: '#f2f2f2', font: 'system', radius: 12, cardStyle: 'photo', columns: 4 },
  tech: { name: 'Техно', accent: '#6741d9', bg: '#f7f7fb', surface: '#ffffff', ink: '#15131f', font: 'mono', radius: 6, cardStyle: 'compact', columns: 5 },
  menu: { name: 'Меню', accent: '#c2255c', bg: '#ffffff', surface: '#fff0f6', ink: '#212529', font: 'condensed', radius: 10, cardStyle: 'list', columns: 1 },
};
const FONT_NAMES = { system: 'Обычный', serif: 'С засечками', rounded: 'Округлый', mono: 'Моноширинный', condensed: 'Узкий' };
const builder = { saved: null, draft: null, products: [], ready: false };

const shopFrame = () => $('#shop-preview');

async function renderShop() {
  try {
    [builder.saved, builder.products] = await Promise.all([api('/api/shop'), catalog.load()]);
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
  for (const sel of f.querySelectorAll('select.fonts')) sel.innerHTML = Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  for (const el of f.elements) {
    if (!el.name || !(el.name in d)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(d[el.name]);
    else el.value = d[el.name] ?? '';
  }
  const cats = [...new Set(builder.products.map((p) => p.category).filter(Boolean))].sort();
  $('#shop-cats').innerHTML = cats.length ? cats.map((c) => `<label class="check"><input type="checkbox" data-cat="${esc(c)}" ${d.categories.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') : '<span class="pick-meta">У товаров пока нет категорий</span>';
  renderImagePicks();
  renderOutputs();
  markDirty();
}

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
  const toShop = (p) => ({ id: p.id, name: p.name, category: p.category, unit: p.unit, price: p.price, description: p.description || '',
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
  shopFrame().contentWindow.postMessage({ type: 'shop-preview', settings: builder.draft, products: draftProducts() }, location.origin);
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
    else if (el.type === 'range' || ['deliveryPrice', 'minOrder'].includes(el.name)) d[el.name] = parseNum(el.value) || 0;
    else d[el.name] = el.value;
  }
  d.categories = [...document.querySelectorAll('#shop-cats [data-cat]:checked')].map((i) => i.dataset.cat);
}

function onShopChange() {
  readShopForm();
  renderOutputs();
  markDirty();
  pushPreview();
}

$('#shop-form').addEventListener('input', onShopChange);
$('#shop-form').addEventListener('change', onShopChange);
$('#shop-form').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-template]');
  if (t) {
    const { name, ...preset } = SHOP_TEMPLATES[t.dataset.template];
    Object.assign(builder.draft, preset, { template: t.dataset.template });
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
