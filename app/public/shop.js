'use strict';

// Интернет-витрина для покупателей: каталог, корзина и оформление заказа.
// В конструкторе витрина открыта во фрейме и получает несохранённые настройки
// через postMessage, чтобы изменения были видны сразу.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = (n) => `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n)} сом`;
const qtyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const FONTS = {
  system: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif',
};

const state = { settings: null, products: [], categories: [], cat: '', query: '', way: 'pickup', cart: loadCart(), open: null, sel: {}, me: null, orders: [], codeFor: null };

function loadCart() {
  try { return JSON.parse(localStorage.getItem('shop.cart')) || {}; } catch { return {}; }
}
function saveCart() {
  try { localStorage.setItem('shop.cart', JSON.stringify(state.cart)); } catch { /* приватный режим */ }
}

const byId = (id) => state.products.find((p) => p.id === Number(id));
// Модификации (цвет, размер…) приходят вместе с основным товаром: у них есть parent_id.
const variantsOf = (p) => state.products.filter((v) => v.parent_id === p.id);
const inStock = (p) => (p.hasVariants ? variantsOf(p).some((v) => v.stock > 0) : p.stock > 0);
// У модификации без своего фото — фото товара.
const photo = (p) => (p.photo ? `/shop/photo/${p.id}?v=${p.photo_at}` : p.parent_id ? photo(byId(p.parent_id) || {}) : '');
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
// Категории с картинками (если их задали в программе) в порядке справочника.
function renderCats() {
  const used = [...new Set(state.products.filter((p) => !p.parent_id).map((p) => p.category).filter(Boolean))];
  const meta = new Map(state.categories.map((c) => [c.name, c]));
  const cats = [...state.categories.map((c) => c.name).filter((n) => used.includes(n)), ...used.filter((n) => !meta.has(n))];
  const withImages = cats.some((c) => meta.get(c)?.image);
  $('#cats').hidden = cats.length < 2;
  $('#cats').classList.toggle('with-images', withImages);
  $('#cats').innerHTML = ['', ...cats].map((c) => {
    const img = meta.get(c)?.image;
    return `<button type="button" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${withImages ? `<span class="cat-pic">${img ? `<img src="${img}" alt="" loading="lazy">` : c ? esc(c.trim()[0].toUpperCase()) : '★'}</span>` : ''}<span>${c ? esc(c) : 'Все товары'}</span></button>`;
  }).join('');
}

function priceHtml(p) {
  if (!p.hasVariants) return rub(p.price);
  const prices = variantsOf(p).map((v) => v.price);
  const lo = Math.min(...prices);
  return Math.max(...prices) === lo ? rub(lo) : `от ${rub(lo)}`;
}

function cardHtml(p) {
  const inCart = p.hasVariants ? variantsOf(p).reduce((sum, v) => sum + (state.cart[v.id] || 0), 0) : state.cart[p.id] || 0;
  const pic = photo(p);
  const s = state.settings;
  if (p.hasVariants) {
    return `<div class="card" role="button" tabindex="0" data-open="${p.id}">
      <div class="pic">${pic ? `<img src="${pic}" alt="" loading="lazy">` : initial(p)}</div>
      <div class="info">
        <div><div class="name">${esc(p.name)}</div><div class="meta">${esc(optionNames(p).join(', '))}</div></div>
        <div class="row">
          <span class="price">${priceHtml(p)}</span>
          ${inStock(p) ? `<button type="button" class="add ${inCart ? 'in' : ''}" data-open="${p.id}">${inCart ? `В корзине: ${qtyFmt.format(inCart)}` : 'Выбрать'}</button>` : '<span class="out-tag">Нет в наличии</span>'}
        </div>
      </div>
    </div>`;
  }
  return `<div class="card" role="button" tabindex="0" data-open="${p.id}">
    <div class="pic">${pic ? `<img src="${pic}" alt="" loading="lazy">` : initial(p)}</div>
    <div class="info">
      <div>
        <div class="name">${esc(p.name)}</div>
        ${s.showStock && p.stock > 0 ? `<div class="meta">В наличии: ${qtyFmt.format(p.stock)} ${esc(p.unit)}</div>` : `<div class="meta">${esc(p.unit === 'шт' ? '' : 'за ' + p.unit)}</div>`}
      </div>
      <div class="row">
        <span class="price">${p.oldPrice ? `<s class="old-price">${rub(p.oldPrice)}</s> ` : ''}${rub(p.price)}</span>
        ${p.stock > 0 ? `<button type="button" class="add ${inCart ? 'in' : ''}" data-add="${p.id}">${inCart ? `В корзине: ${qtyFmt.format(inCart)}` : 'В корзину'}</button>` : '<span class="out-tag">Нет в наличии</span>'}
      </div>
    </div>
  </div>`;
}

function renderGrid() {
  const q = state.query.trim().toLowerCase();
  const list = state.products.filter((p) => !p.parent_id && (!state.cat || p.category === state.cat) && (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));
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

// Названия свойств товара с модификациями в порядке первой модификации: «Цвет», «Размер».
function optionNames(p) {
  const names = [];
  for (const v of variantsOf(p)) for (const k of Object.keys(v.options || {})) if (!names.includes(k)) names.push(k);
  return names;
}

// Модификация, подходящая под выбранные значения, или null.
const matchVariant = (p, sel) => variantsOf(p).find((v) => Object.entries(sel).every(([k, val]) => v.options?.[k] === val)) || null;

function openProduct(id) {
  const p = byId(id);
  if (!p) return;
  if (state.open !== p.id) {
    state.open = p.id;
    // Сразу выбрана первая модификация в наличии — покупателю остаётся поменять, что нужно.
    const first = variantsOf(p).find((v) => v.stock > 0) || variantsOf(p)[0];
    state.sel = p.hasVariants && first ? { ...first.options } : {};
  }
  const v = p.hasVariants ? matchVariant(p, state.sel) : p;
  const shown = v && v !== p && v.photo ? v : p;
  const pic = photo(shown);
  const s = state.settings;
  const pickers = p.hasVariants ? optionNames(p).map((name) => {
    const values = [...new Set(variantsOf(p).map((x) => x.options?.[name]).filter(Boolean))];
    return `<div class="opt"><div class="opt-name">${esc(name)}${state.sel[name] ? `: <b>${esc(state.sel[name])}</b>` : ''}</div><div class="opt-values">
      ${values.map((val) => {
        // Значение недоступно, если с остальными выбранными свойствами такого товара нет в наличии.
        const alt = matchVariant(p, { ...state.sel, [name]: val });
        return `<button type="button" data-opt="${esc(name)}" data-val="${esc(val)}" aria-pressed="${state.sel[name] === val}" class="${alt && alt.stock > 0 ? '' : 'na'}">${esc(val)}</button>`;
      }).join('')}
    </div></div>`;
  }).join('') : '';
  const can = v && v.stock > 0;
  $('#product-body').innerHTML = `
    <h2 id="product-name">${esc(p.name)}</h2>
    <div class="product-pic">${pic ? `<img src="${pic}" alt="">` : initial(p)}</div>
    ${p.category ? `<p class="small" style="text-align:left">${esc(p.category)}</p>` : ''}
    ${pickers}
    ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ''}
    <div class="product-buy">
      <span class="price">${v ? rub(v.price) : priceHtml(p)}${p.unit !== 'шт' ? ` <span class="small">за ${esc(p.unit)}</span>` : ''}</span>
      ${can ? `<button type="button" class="primary" data-add="${v.id}">${state.cart[v.id] ? `В корзине: ${qtyFmt.format(state.cart[v.id])} · ещё` : 'В корзину'}</button>`
        : `<span class="out-tag">${p.hasVariants && !v ? 'Такого сочетания нет' : 'Нет в наличии'}</span>`}
    </div>
    ${s.showStock && can ? `<p class="small" style="text-align:left">В наличии: ${qtyFmt.format(v.stock)} ${esc(p.unit)}</p>` : ''}`;
  if (!$('#product').open) $('#product').showModal();
}

/* ---------- Корзина ---------- */
function add(id, delta = 1) {
  const p = byId(id);
  if (!p) return;
  if (p.hasVariants) return openProduct(p.id);
  const next = Math.max(0, (state.cart[id] || 0) + delta);
  // Если остаток показывается, больше остатка положить нельзя.
  if (state.settings.showStock && next > p.stock) return;
  if (next) state.cart[id] = next; else delete state.cart[id];
  saveCart();
  renderAll();
}

function cartLines() {
  return Object.entries(state.cart).map(([id, qty]) => ({ p: byId(id), qty })).filter((l) => l.p && !l.p.hasVariants && l.p.stock > 0);
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
  // Без входа заказ не оформить: вместо формы — приглашение войти.
  const guest = !state.me;
  $('#checkout-login').hidden = !guest;
  for (const el of $('#checkout').querySelectorAll('#ways, #checkout-who, label, button[type=submit], .small')) el.hidden = guest || (el.id === 'address-row' && state.way !== 'delivery');
  $('#ways').hidden = guest || !(s.pickup && s.delivery);
  $('#checkout-who').innerHTML = state.me ? `Заказ на <b>${esc(state.me.name)}</b>, ${esc(phoneText(state.me.phone))}` : '';
  const short = s.minOrder && goods < s.minOrder;
  const submit = $('#checkout button[type=submit]');
  submit.disabled = Boolean(short);
  submit.textContent = short ? `Минимальный заказ — ${rub(s.minOrder)}` : 'Оформить заказ';
}

function renderAll() {
  renderGrid();
  renderCart();
  if ($('#product').open && state.open) openProduct(state.open);
}

/* ---------- События ---------- */
document.addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-add]');
  if (addBtn) {
    e.stopPropagation();
    return add(addBtn.dataset.add, Number(addBtn.dataset.delta || 1));
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    state.sel[opt.dataset.opt] = opt.dataset.val;
    return openProduct(state.open);
  }
  const open = e.target.closest('[data-open]');
  if (open) {
    state.open = null;
    return openProduct(open.dataset.open);
  }
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
  if (!state.me) return openAccount('login');
  const submit = f.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const res = await fetch('/shop/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: f.elements.address.value,
        comment: f.elements.comment.value, website: f.elements.website.value, delivery: state.way,
        items: cartLines().map((l) => ({ productId: l.p.id, qty: l.qty })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.me = null; renderAccountButton(); openAccount('login'); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || 'Не получилось оформить заказ');
    loadMe();
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

/* ---------- Аккаунт покупателя ---------- */
const phoneText = (p) => (p.length === 12 && p.startsWith('996') ? `+996 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : '+' + p);
const ORDER_STATUS = { new: 'Принят', confirmed: 'Подтверждён', ready: 'Собран', shipped: 'Передан курьеру', done: 'Получен', cancelled: 'Отменён' };

async function account(path, body, method = 'POST') {
  const res = await fetch('/shop/account/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

async function loadMe() {
  try {
    const d = await fetch('/shop/account/me').then((r) => r.json());
    state.me = d.customer;
    state.orders = d.orders || [];
  } catch {
    state.me = null;
  }
  renderAccountButton();
  renderCart();
}

function renderAccountButton() {
  $('#account-label').textContent = state.me ? state.me.name.split(' ')[0] : 'Войти';
}

function openAccount(view) {
  if (!view) view = state.me ? 'profile' : 'login';
  for (const el of document.querySelectorAll('#account .acc')) el.hidden = el.dataset.view !== view;
  for (const e of document.querySelectorAll('#account .error')) e.hidden = true;
  if (view === 'profile') renderProfile();
  if (!$('#account').open) $('#account').showModal();
  $(`#account [data-view="${view}"] input`)?.focus();
}

function showError(form, err) {
  const el = form.querySelector('.error');
  el.textContent = err.message === 'Failed to fetch' ? 'Нет связи. Проверьте интернет.' : err.message;
  el.hidden = false;
}

// Код подтверждения: purpose — register или reset, channel — whatsapp или manual (через сотрудника).
function openCode(purpose, phone, channel, extra = {}) {
  state.codeFor = { purpose, phone, ...extra };
  openAccount('code');
  const form = $('#account [data-view="code"]');
  form.reset();
  form.querySelector('.new-pass').hidden = purpose !== 'reset';
  form.querySelector('.code-hint').textContent = channel === 'sms'
    ? `Мы отправили SMS с кодом на номер ${phone}. Код действует 15 минут.`
    : channel === 'whatsapp'
    ? 'Мы отправили код в WhatsApp на ваш номер. Код действует 15 минут.'
    : 'Мы получили запрос: сотрудник магазина позвонит или напишет вам и назовёт код. Код действует 15 минут.' +
      (state.settings.phone ? ` Можно позвонить нам: ${state.settings.phone}.` : '');
}

function loggedIn(data, message) {
  state.me = data.customer;
  renderAccountButton();
  $('#account').close();
  loadMe();
  toast(message);
}

// Простое всплывающее сообщение внизу витрины.
// Имя с заглавных букв (каждое слово), дата — точки ставятся сами.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches?.('[data-capitalize]')) {
    const next = el.value.replace(/(^|[\s-])(\p{Ll})/gu, (m, sep, ch) => sep + ch.toUpperCase());
    if (next !== el.value) { const { selectionStart: a, selectionEnd: b } = el; el.value = next; el.setSelectionRange(a, b); }
  }
  if (el.matches?.('[data-date]') && e.inputType !== 'deleteContentBackward') {
    const d = el.value.replace(/\D/g, '').slice(0, 8);
    el.value = [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('.');
  }
});

function toast(text) {
  const el = document.createElement('div');
  el.className = 'shop-toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function renderProfile() {
  const me = state.me;
  $('#profile-name').textContent = me.name;
  $('#profile-bonus').textContent = `${new Intl.NumberFormat('ru-RU').format(me.bonus)} бонусов`;
  $('#profile-phone').textContent = phoneText(me.phone);
  $('#profile-card').textContent = me.card || '—';
  $('#profile-bday').hidden = !me.birthdayDiscount;
  $('#profile-bday').textContent = me.birthdayDiscount ? `🎂 С днём рождения! Скидка ${me.birthdayDiscount}% — назовите номер телефона на кассе.` : '';
  $('#profile-orders').innerHTML = state.orders.length ? state.orders.map((o) => `
    <div class="profile-order">
      <div><b>№${o.id}</b> · ${new Date(o.created_at).toLocaleDateString('ru-RU')} <span class="status s-${o.status}">${ORDER_STATUS[o.status] || o.status}</span></div>
      <div class="small left">${o.items.map((i) => `${esc(i.name)} × ${qtyFmt.format(i.qty)}`).join(', ')}</div>
      <b>${rub(o.total)}</b>
    </div>`).join('') : '<p class="small left">Заказов пока нет</p>';
  const f = $('#profile-form');
  f.elements.name.value = me.name;
  for (const r of f.querySelectorAll('input[name="gender"]')) r.checked = r.value === me.gender;
  const [y, m, d] = (me.birthday || '').split('-');
  f.elements.birthday.value = me.birthday ? `${d}.${m}${y !== '0000' ? '.' + y : ''}` : '';
  f.elements.password.value = '';
  f.elements.newPassword.value = '';
}

$('#account-open').addEventListener('click', () => openAccount());
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-account]');
  if (!link) return;
  if ($('#cart').open) $('#cart').close();
  openAccount(link.dataset.account);
});

$('#account [data-view="login"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    loggedIn(await account('login', { phone: f.elements.phone.value, password: f.elements.password.value }), 'Вы вошли');
  } catch (err) { showError(f, err); }
});
$('#account [data-view="register"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['phone', 'name', 'birthday', 'password', 'gender'].map((k) => [k, f.elements[k].value]));
  if (!body.gender) return showError(f, new Error('Укажите пол'));
  try {
    const d = await account('register', body);
    if (d.needCode) return openCode('register', body.phone, d.channel, { body });
    loggedIn(d, 'Готово! Вы зарегистрированы');
  } catch (err) { showError(f, err); }
});
$('#account [data-view="forgot"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await account('reset/request', { phone: f.elements.phone.value });
    openCode('reset', f.elements.phone.value, d.channel);
  } catch (err) { showError(f, err); }
});
$('#account [data-view="code"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const c = state.codeFor;
  try {
    if (c.purpose === 'register') loggedIn(await account('register/confirm', { phone: c.phone, code: f.elements.code.value }), 'Номер подтверждён, вы зарегистрированы');
    else loggedIn(await account('reset', { phone: c.phone, code: f.elements.code.value, password: f.elements.password.value }), 'Пароль изменён, вы вошли');
  } catch (err) { showError(f, err); }
});
$('#account [data-resend]').addEventListener('click', async () => {
  const c = state.codeFor;
  const f = $('#account [data-view="code"]');
  try {
    const d = c.purpose === 'register' ? await account('register', c.body) : await account('reset/request', { phone: c.phone });
    openCode(c.purpose, c.phone, d.channel, c.purpose === 'register' ? { body: c.body } : {});
    toast('Новый код запрошен');
  } catch (err) { showError(f, err); }
});
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await account('me', { name: f.elements.name.value, birthday: f.elements.birthday.value, gender: f.elements.gender.value, password: f.elements.password.value, newPassword: f.elements.newPassword.value }, 'PUT');
    state.me = { ...state.me, ...d.customer };
    renderAccountButton();
    renderProfile();
    toast('Сохранено');
  } catch (err) { showError(f, err); }
});
$('#logout').addEventListener('click', async () => {
  await account('logout').catch(() => {});
  state.me = null;
  state.orders = [];
  renderAccountButton();
  renderCart();
  $('#account').close();
  toast('Вы вышли');
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
    state.categories = data.categories || [];
  } catch {
    document.body.innerHTML = '<p class="empty">Магазин сейчас недоступен. Попробуйте обновить страницу.</p>';
    return;
  }
  renderFrame();
  renderCats();
  renderAll();
  loadMe();
  parent.postMessage({ type: 'shop-ready' }, location.origin);
})();
