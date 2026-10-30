'use strict';

// Интернет-витрина для покупателей: каталог, корзина и оформление заказа.
// В конструкторе витрина открыта во фрейме и получает несохранённые настройки
// через postMessage, чтобы изменения были видны сразу.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = (n) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
const qtyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif',
};

const state = { settings: null, products: [], cat: '', query: '', way: 'pickup', cart: loadCart() };

function loadCart() {
  try { return JSON.parse(localStorage.getItem('shop.cart')) || {}; } catch { return {}; }
}
function saveCart() {
  try { localStorage.setItem('shop.cart', JSON.stringify(state.cart)); } catch { /* приватный режим */ }
}

const byId = (id) => state.products.find((p) => p.id === Number(id));
const photo = (p) => (p.photo ? `/shop/photo/${p.id}?v=${p.photo_at}` : '');
const initial = (p) => esc((p.name.trim()[0] || '•').toUpperCase());

/* ---------- Оформление ---------- */
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Переменные из несохранённых настроек (предпросмотр). Сохранённые приходят из /shop/theme.css.
function applyVars(s) {
  const r = document.documentElement.style;
  r.setProperty('--accent', s.accent);
  r.setProperty('--accent-soft', hexToRgba(s.accent, 0.12));
  r.setProperty('--bg', s.bg);
  r.setProperty('--surface', s.surface);
  r.setProperty('--ink', s.ink);
  r.setProperty('--ink-soft', hexToRgba(s.ink, 0.62));
  r.setProperty('--line', hexToRgba(s.ink, 0.12));
  r.setProperty('--font', FONTS[s.font] || FONTS.system);
  r.setProperty('--radius', s.radius + 'px');
  r.setProperty('--cols', s.columns);
  let style = $('#preview-css');
  if (!style) {
    style = document.createElement('style');
    style.id = 'preview-css';
    document.head.append(style);
    // Свой CSS из сохранённой темы заменяется несохранённым.
    $('#shop-theme').disabled = true;
  }
  style.textContent = s.css || '';
}

function renderFrame() {
  const s = state.settings;
  document.title = s.title;
  $('#preview-note').hidden = !s.preview;
  $('#title').textContent = s.title;
  $('#logo').hidden = !s.logoId;
  if (s.logoId) $('#logo').src = `/img/${s.logoId}`;
  $('#hero-title').textContent = s.title;
  $('#slogan').textContent = s.slogan;
  $('#hero').classList.toggle('has-image', Boolean(s.bannerId));
  $('#hero').style.setProperty('--banner', s.bannerId ? `url(/img/${s.bannerId})` : 'none');
  $('#foot-title').textContent = s.title;
  $('#about').textContent = s.about;
  const phone = s.phone.replace(/[^\d+]/g, '');
  const wa = s.whatsapp.replace(/\D/g, '');
  const links = [
    phone && `<a href="tel:${esc(phone)}">${esc(s.phone)}</a>`,
    wa && `<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>`,
    s.telegram && `<a href="https://t.me/${esc(s.telegram)}" target="_blank" rel="noopener">Telegram</a>`,
  ].filter(Boolean);
  $('#head-contacts').innerHTML = links.join('');
  $('#foot-contacts').innerHTML = [
    ...links,
    s.address && `<span>📍 ${esc(s.address)}</span>`,
    s.hours && `<span>🕘 ${esc(s.hours)}</span>`,
  ].filter(Boolean).join('');
}

/* ---------- Каталог ---------- */
function renderCats() {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))];
  $('#cats').hidden = cats.length < 2;
  $('#cats').innerHTML = ['', ...cats].map((c) => `<button type="button" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${c ? esc(c) : 'Все товары'}</button>`).join('');
}

function cardHtml(p) {
  const inCart = state.cart[p.id] || 0;
  const pic = photo(p);
  const s = state.settings;
  return `<div class="card" role="button" tabindex="0" data-open="${p.id}">
    <div class="pic">${pic ? `<img src="${pic}" alt="" loading="lazy">` : initial(p)}</div>
    <div class="info">
      <div>
        <div class="name">${esc(p.name)}</div>
        ${s.showStock && p.stock > 0 ? `<div class="meta">В наличии: ${qtyFmt.format(p.stock)} ${esc(p.unit)}</div>` : `<div class="meta">${esc(p.unit === 'шт' ? '' : 'за ' + p.unit)}</div>`}
      </div>
      <div class="row">
        <span class="price">${rub(p.price)}</span>
        ${p.stock > 0 ? `<button type="button" class="add ${inCart ? 'in' : ''}" data-add="${p.id}">${inCart ? `В корзине: ${qtyFmt.format(inCart)}` : 'В корзину'}</button>` : '<span class="out-tag">Нет в наличии</span>'}
      </div>
    </div>
  </div>`;
}

function renderGrid() {
  const q = state.query.trim().toLowerCase();
  const list = state.products.filter((p) => (!state.cat || p.category === state.cat) && (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));
  const grid = $('#grid');
  grid.className = 'grid ' + state.settings.cardStyle;
  if (!list.length) {
    grid.innerHTML = `<p class="empty">${state.products.length ? 'Ничего не нашлось' : 'Товары скоро появятся'}</p>`;
    return;
  }
  // На «Все товары» без поиска товары разбиты по категориям.
  if (!state.cat && !q && new Set(list.map((p) => p.category)).size > 1) {
    let html = '';
    let current = null;
    for (const p of list) {
      if (p.category !== current) {
        current = p.category;
        html += `<h2 class="cat-title">${esc(current || 'Другое')}</h2>`;
      }
      html += cardHtml(p);
    }
    grid.innerHTML = html;
  } else {
    grid.innerHTML = list.map(cardHtml).join('');
  }
}

function openProduct(id) {
  const p = byId(id);
  if (!p) return;
  const pic = photo(p);
  $('#product-body').innerHTML = `
    <h2 id="product-name">${esc(p.name)}</h2>
    <div class="product-pic">${pic ? `<img src="${pic}" alt="">` : initial(p)}</div>
    ${p.category ? `<p class="small" style="text-align:left">${esc(p.category)}</p>` : ''}
    ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ''}
    <div class="product-buy">
      <span class="price">${rub(p.price)}${p.unit !== 'шт' ? ` <span class="small">за ${esc(p.unit)}</span>` : ''}</span>
      ${p.stock > 0 ? `<button type="button" class="primary" data-add="${p.id}">${state.cart[p.id] ? `В корзине: ${qtyFmt.format(state.cart[p.id])} · ещё` : 'В корзину'}</button>` : '<span class="out-tag">Нет в наличии</span>'}
    </div>`;
  if (!$('#product').open) $('#product').showModal();
}

/* ---------- Корзина ---------- */
function add(id, delta = 1) {
  const p = byId(id);
  if (!p) return;
  const next = Math.max(0, (state.cart[id] || 0) + delta);
  // Если остаток показывается, больше остатка положить нельзя.
  if (state.settings.showStock && next > p.stock) return;
  if (next) state.cart[id] = next; else delete state.cart[id];
  saveCart();
  renderAll();
}

function cartLines() {
  return Object.entries(state.cart).map(([id, qty]) => ({ p: byId(id), qty })).filter((l) => l.p && l.p.stock > 0);
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((s, l) => s + l.qty, 0);
  $('#cart-count').hidden = !count;
  $('#cart-count').textContent = qtyFmt.format(count);
  const s = state.settings;
  $('#cart-lines').innerHTML = lines.length ? lines.map((l) => `
    <div class="cart-line">
      <div><div class="name">${esc(l.p.name)}</div><div class="meta">${rub(l.p.price)} за ${esc(l.p.unit)}</div></div>
      <div class="stepper"><button type="button" data-add="${l.p.id}" data-delta="-1" aria-label="Меньше">−</button><span>${qtyFmt.format(l.qty)}</span><button type="button" data-add="${l.p.id}" aria-label="Больше">+</button></div>
      <div class="line-sum">${rub(l.qty * l.p.price)}</div>
    </div>`).join('') : '<p class="empty">Корзина пуста</p>';
  $('#checkout').hidden = !lines.length;
  if (!lines.length) return;
  if (!s[state.way]) state.way = s.pickup ? 'pickup' : 'delivery';
  const goods = lines.reduce((sum, l) => sum + l.qty * l.p.price, 0);
  const delivery = state.way === 'delivery' ? s.deliveryPrice : 0;
  $('#sum-goods').textContent = rub(goods);
  $('#sum-delivery-row').hidden = state.way !== 'delivery';
  $('#sum-delivery').textContent = delivery ? rub(delivery) : 'бесплатно';
  $('#sum-total').textContent = rub(goods + delivery);
  $('#ways').innerHTML = [['pickup', 'Самовывоз'], ['delivery', 'Доставка']].filter(([k]) => s[k])
    .map(([k, label]) => `<button type="button" data-way="${k}" aria-pressed="${state.way === k}">${label}</button>`).join('');
  $('#ways').hidden = !(s.pickup && s.delivery);
  $('#address-row').hidden = state.way !== 'delivery';
  const short = s.minOrder && goods < s.minOrder;
  const submit = $('#checkout button[type=submit]');
  submit.disabled = Boolean(short);
  submit.textContent = short ? `Минимальный заказ — ${rub(s.minOrder)}` : 'Оформить заказ';
}

function renderAll() {
  renderGrid();
  renderCart();
  if ($('#product').open) openProduct($('#product-body [data-add]')?.dataset.add);
}

/* ---------- События ---------- */
document.addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-add]');
  if (addBtn) {
    e.stopPropagation();
    return add(addBtn.dataset.add, Number(addBtn.dataset.delta || 1));
  }
  const open = e.target.closest('[data-open]');
  if (open) return openProduct(open.dataset.open);
  const cat = e.target.closest('[data-cat]');
  if (cat) {
    state.cat = cat.dataset.cat;
    renderCats();
    return renderGrid();
  }
  const way = e.target.closest('[data-way]');
  if (way) {
    state.way = way.dataset.way;
    return renderCart();
  }
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-open]')) openProduct(e.target.dataset.open);
});
// Клик по затемнению закрывает окно.
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
$('#cart-open').addEventListener('click', () => { renderCart(); $('#cart').showModal(); });
$('#brand').addEventListener('click', (e) => { e.preventDefault(); scrollTo({ top: 0 }); });
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); });

$('#checkout').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#checkout-error');
  err.hidden = true;
  if (!f.elements.name.value.trim() || !f.elements.phone.value.trim()) {
    err.textContent = 'Укажите имя и телефон';
    err.hidden = false;
    return;
  }
  const submit = f.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const res = await fetch('/shop/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: f.elements.name.value, phone: f.elements.phone.value, address: f.elements.address.value,
        comment: f.elements.comment.value, website: f.elements.website.value, delivery: state.way,
        items: cartLines().map((l) => ({ productId: l.p.id, qty: l.qty })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не получилось оформить заказ');
    state.cart = {};
    saveCart();
    renderAll();
    $('#cart').close();
    $('#done-text').textContent = `Номер заказа: ${data.id}. Сумма: ${rub(data.total)}. Мы скоро позвоним, чтобы подтвердить.`;
    $('#done').showModal();
    f.reset();
  } catch (error) {
    err.textContent = error.message === 'Failed to fetch' ? 'Нет связи. Проверьте интернет и попробуйте ещё раз.' : error.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
    renderCart();
  }
});

// Предпросмотр из конструктора: принимаем сообщения только со своего сайта.
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'shop-preview' || !state.settings) return;
  state.settings = { ...state.settings, ...e.data.settings, preview: state.settings.preview };
  applyVars(state.settings);
  // Набор категорий меняет список товаров, поэтому он приходит из конструктора готовым.
  if (e.data.products) state.products = e.data.products;
  renderFrame();
  renderCats();
  renderAll();
});

(async () => {
  try {
    const res = await fetch('/shop/data');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.settings = data.settings;
    state.products = data.products;
  } catch {
    document.body.innerHTML = '<p class="empty">Магазин сейчас недоступен. Попробуйте обновить страницу.</p>';
    return;
  }
  renderFrame();
  renderCats();
  renderAll();
  parent.postMessage({ type: 'shop-ready' }, location.origin);
})();
