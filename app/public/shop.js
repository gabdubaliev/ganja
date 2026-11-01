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

const state = { settings: null, products: [], categories: [], cat: '', query: '', sort: '', way: 'pickup', payId: '', payOrder: null, receiptFile: null, cart: loadCart(), open: null, sel: {}, cardColor: {}, me: null, orders: [], codeFor: null };

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
  if (s.bodyFont) r.setProperty('--font', `"${s.bodyFont}", ${FONTS.system}`);
  r.setProperty('--font-head', s.headingFont ? `"${s.headingFont}", ${FONTS.system}` : 'var(--font)');
  r.setProperty('--mcols', s.mobileColumns || 2);
  r.setProperty('--ratio', (s.cardRatio || '4:5').replace(':', ' / '));
  r.setProperty('--fit', s.imageFit || 'cover');
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

// Шрифты из Google Fonts: заголовки и текст (кириллица подгружается сама).
// Шрифты Google — из списка конструктора; свои (загруженные) описаны в theme.css.
const GOOGLE_FONTS = ['Inter', 'Manrope', 'Montserrat', 'Rubik', 'Nunito', 'Raleway', 'Open Sans', 'Roboto', 'Unbounded', 'Comfortaa',
  'Playfair Display', 'Cormorant Garamond', 'Lora', 'PT Serif', 'Oswald', 'Roboto Condensed', 'Prata', 'Jost'];
function loadFonts(s) {
  const fams = [...new Set([s.headingFont, s.bodyFont].filter((f) => GOOGLE_FONTS.includes(f)))];
  if (!fams.length) return;
  const href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700;800`).join('&')}&display=swap`;
  if ($('#shop-fonts').getAttribute('href') !== href) $('#shop-fonts').setAttribute('href', href);
}

const ICONS = {
  instagram: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3c-.2.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21.5 4.3 18.4 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.4-.9.4l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.6 12.9 2 11.5c-1-.3-1-1 .2-1.4l17.9-6.9c.8-.3 1.6.2 1.4 1.1Z"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.6 3c.3 2.2 1.6 3.6 3.9 3.8v2.6a7 7 0 0 1-3.8-1.2v6.3c0 3.6-2.7 6-6 6a6 6 0 0 1-6-6c0-3.4 2.9-6.1 6.6-5.8v2.8c-1.8-.4-3.6.8-3.6 2.9 0 1.7 1.3 3 3 3 1.8 0 3-1.3 3-3.2V3h2.9Z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z"/></svg>',
};
const PERK_ICONS = ['🚚', '💳', '↺', '★'];

function renderFrame() {
  const s = state.settings;
  document.title = s.title;
  loadFonts(s);
  const b = document.body.dataset;
  b.btn = s.buttonStyle || 'pill'; b.shadow = s.cardShadow || 'soft'; b.hero = s.heroStyle || 'image';
  b.heroh = s.heroHeight || 'large'; b.align = s.heroAlign || 'left'; b.head = s.headerStyle || 'left';
  b.look = s.look || 'modern';
  $('#preview-note').hidden = !s.preview;
  $('#title').textContent = s.title;
  $('#logo').hidden = !s.logoId;
  if (s.logoId) $('#logo').src = `/img/${s.logoId}`;
  $('#title').hidden = Boolean(s.logoId) && s.headerStyle === 'center';
  // Бегущая строка: текст повторяется, чтобы лента шла без разрыва.
  $('#announce').hidden = !s.announce;
  $('#announce-text').textContent = s.announce || '';
  $('#announce-text2').textContent = s.announce || '';
  $('#hero-title').textContent = s.title;
  $('#slogan').textContent = s.slogan;
  // «Текст слева, фото справа»: фото — в сетке рядом с текстом, иначе — фоном на весь баннер.
  const media = $('#hero-media');
  const inner = $('#hero .hero-inner');
  if (s.heroStyle === 'split' ? media.parentElement !== inner : media.parentElement !== $('#hero')) {
    if (s.heroStyle === 'split') inner.append(media); else $('#hero').prepend(media);
  }
  $('#hero').classList.toggle('has-image', Boolean(s.bannerId));
  $('#hero').style.setProperty('--banner', s.bannerId ? `url(/img/${s.bannerId})` : 'none');
  $('#hero-btn').textContent = s.heroButton || 'Смотреть каталог';
  $('#hero-btn').hidden = !s.heroButton;
  const phone = s.phone.replace(/[^\d+]/g, '');
  const wa = s.whatsapp.replace(/\D/g, '');
  $('#hero-wa').hidden = !wa;
  if (wa) $('#hero-wa').href = `https://wa.me/${wa}`;
  $('#wa-float').hidden = !wa || s.whatsappButton === false;
  if (wa) $('#wa-float').href = `https://wa.me/${wa}`;
  // Преимущества под баннером.
  // Старый формат — строки, новый — {icon, text, on}.
  const perks = (s.perks || []).map((x, i) => (typeof x === 'string' ? { icon: PERK_ICONS[i] || '✓', text: x, on: true } : x)).filter((x) => x.on !== false && x.text);
  $('#perks').hidden = !perks.length;
  $('#perks').innerHTML = perks.map((x) => `<div class="perk">${x.icon ? `<i>${esc(x.icon)}</i>` : ''}<span>${esc(x.text)}</span></div>`).join('');
  $('#head-contacts').innerHTML = phone ? `<a href="tel:${esc(phone)}">${ICONS.phone.replace('<svg', '<svg width="15" height="15"')}${esc(s.phone)}</a>` : '';
  $('#foot-title').textContent = s.title;
  $('#about').textContent = s.about;
  const social = [
    s.instagram && ['instagram', `https://instagram.com/${encodeURIComponent(s.instagram)}`],
    wa && ['whatsapp', `https://wa.me/${wa}`],
    s.telegram && ['telegram', `https://t.me/${encodeURIComponent(s.telegram)}`],
    s.tiktok && ['tiktok', `https://www.tiktok.com/@${encodeURIComponent(s.tiktok)}`],
  ].filter(Boolean);
  $('#foot-social').innerHTML = social.map(([k, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener" aria-label="${k}">${ICONS[k]}</a>`).join('');
  $('#foot-contacts').innerHTML = [
    phone && `<a href="tel:${esc(phone)}">${esc(s.phone)}</a>`,
    wa && `<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>`,
    s.telegram && `<a href="https://t.me/${esc(s.telegram)}" target="_blank" rel="noopener">Telegram</a>`,
    s.instagram && `<a href="https://instagram.com/${esc(s.instagram)}" target="_blank" rel="noopener">Instagram</a>`,
  ].filter(Boolean).join('') || '<span>—</span>';
  $('#foot-info').innerHTML = [
    s.address && `<span>📍 ${esc(s.address)}</span>`,
    s.hours && `<span>🕘 ${esc(s.hours)}</span>`,
    s.delivery && `<span>🚚 Доставка${s.deliveryPrice ? ` — ${rub(s.deliveryPrice)}` : ' бесплатно'}</span>`,
    s.payments?.length && `<span>💳 Оплата переводом по QR</span>`,
  ].filter(Boolean).join('') || '<span>—</span>';
  $('#foot-copy').textContent = `© ${new Date().getFullYear()} ${s.title}`;
  $('#foot-note').textContent = s.footerNote || '';
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
  // Категории текстом в шапке (на компьютере).
  $('#head-nav').innerHTML = cats.length > 1 ? ['', ...cats].map((c) => `<button type="button" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${c ? esc(c) : 'Все'}</button>`).join('') : '';
  $('#cats').innerHTML = ['', ...cats].map((c) => {
    const img = meta.get(c)?.image;
    // «Все товары» — коллаж из картинок первых категорий.
    const all = !c && withImages ? cats.map((x) => meta.get(x)?.image).filter(Boolean).slice(0, 4) : [];
    const pic = img ? `<img src="${img}" alt="" loading="lazy">` : all.length >= 2 ? `<span class="collage">${all.map((u) => `<img src="${u}" alt="" loading="lazy">`).join('')}</span>` : c ? esc(c.trim()[0].toUpperCase()) : '★';
    return `<button type="button" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${withImages ? `<span class="cat-pic">${pic}</span>` : ''}<span>${c ? esc(c) : 'Все товары'}</span></button>`;
  }).join('');
}

function priceHtml(p) {
  if (!p.hasVariants) return rub(p.price);
  const prices = variantsOf(p).map((v) => v.price);
  const lo = Math.min(...prices);
  return Math.max(...prices) === lo ? rub(lo) : `от ${rub(lo)}`;
}

// Значки: скидка в процентах, «Новинка» — товар заведён недавно (дней — в настройках витрины).
function badgesHtml(p) {
  const s = state.settings;
  const list = p.hasVariants ? variantsOf(p) : [p];
  const sale = s.showSaleBadge !== false ? Math.max(0, ...list.map((v) => (v.oldPrice ? Math.round((1 - v.price / v.oldPrice) * 100) : 0))) : 0;
  const fresh = s.newDays > 0 && p.created_at && Date.now() - p.created_at < s.newDays * 864e5;
  return sale || fresh ? `<div class="badges">${sale ? `<span class="badge sale">−${sale}%</span>` : ''}${fresh ? '<span class="badge new">Новинка</span>' : ''}</div>` : '';
}

// Таблица размеров из конструктора: первая строка — заголовки, столбцы через «;», «|» или табуляцию.
// Показывается у товаров с вариантами (размерами).
function sizeChartHtml(chart, p, open) {
  if (!chart || !p.hasVariants) return '';
  const rows = chart.split('\n').map((l) => l.split(/\s*[;|\t]\s*/)).filter((r) => r.some(Boolean));
  if (rows.length < 2) return '';
  const [head, ...body] = rows;
  return `<details class="size-chart" ${open ? 'open' : ''}><summary>📏 Таблица размеров</summary>
    <div class="size-wrap"><table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${body.map((r) => `<tr>${head.map((_, i) => r[i] ?? '').map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

// Размеры по порядку: XS, S, M, L, XL, XXL, 3XL…; числа — по возрастанию; остальное (цвета) — как было.
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
function sortSizes(values) {
  const rank = (v) => {
    const u = String(v).toUpperCase().replace(/\s/g, '');
    const i = SIZE_ORDER.indexOf(u === '2XL' ? 'XXL' : u === 'XXXL' ? '3XL' : u);
    if (i >= 0) return i;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? 100 + n : null;
  };
  return values.every((v) => rank(v) !== null) ? [...values].sort((a, b) => rank(a) - rank(b)) : values;
}

/* ---------- Расцветки на карточке (как кружки цветов в больших магазинах одежды) ---------- */
// Свойство «Цвет» товара и его значения в порядке модификаций; для каждого — фото первой модификации этого цвета.
const colorOptOf = (p) => (p.hasVariants ? detectColorOption(variantsOf(p).map((v) => v.options || {}), state.settings?.colorMap || {}) : null);
function colorsOf(p) {
  const opt = colorOptOf(p);
  if (!opt) return [];
  const seen = new Map();
  for (const v of variantsOf(p)) {
    const c = v.options?.[opt];
    if (!c) continue;
    const cur = seen.get(c) || { name: c, stock: 0, pic: '' };
    cur.stock += Math.max(0, v.stock);
    if (!cur.pic && v.photo) cur.pic = photo(v);
    seen.set(c, cur);
  }
  return [...seen.values()];
}
const swatchStyle = (c) => {
  const bg = swatchBg(c.name, state.settings.colorMap || {});
  // Неизвестный цвет, но есть фото — кружок с кусочком фото.
  return !colorHex(c.name, state.settings.colorMap || {}) && c.pic ? `background-image:url('${c.pic}')` : `background:${bg}`;
};
function swatchesHtml(p) {
  if (state.settings.showSwatches === false) return '';
  const colors = colorsOf(p);
  // Кружки видны всегда, когда у товара есть свойство «цвет» — даже если цвет один.
  if (!colors.length) return '';
  const active = state.cardColor[p.id];
  const max = 7;
  return `<div class="swatches" role="group" aria-label="Расцветки">${colors.slice(0, max).map((c) => `<button type="button" class="sw ${c.stock > 0 ? '' : 'na'}" data-swatch="${p.id}" data-color="${esc(c.name)}" aria-pressed="${active === c.name}" title="${esc(c.name)}${c.stock > 0 ? '' : ' — нет в наличии'}" aria-label="${esc(c.name)}"><i style="${swatchStyle(c)}"></i></button>`).join('')}${colors.length > max ? `<span class="sw-more">+${colors.length - max}</span>` : ''}</div>`;
}
// Показать фото выбранной расцветки на карточке (без перерисовки всей сетки).
function showCardColor(id, color) {
  const p = byId(id);
  const card = document.querySelector(`.card[data-open="${id}"]`);
  if (!p || !card) return;
  const c = colorsOf(p).find((x) => x.name === color);
  const img = card.querySelector('.pic img');
  if (c?.pic && img && img.getAttribute('src') !== c.pic) img.src = c.pic;
  for (const b of card.querySelectorAll('[data-swatch]')) b.setAttribute('aria-pressed', String(b.dataset.color === color));
  const label = card.querySelector('.sw-name');
  if (label) label.textContent = color || '';
}

function cardHtml(p, i = 0) {
  const inCart = p.hasVariants ? variantsOf(p).reduce((sum, v) => sum + (state.cart[v.id] || 0), 0) : state.cart[p.id] || 0;
  const chosen = state.cardColor[p.id] && colorsOf(p).find((c) => c.name === state.cardColor[p.id]);
  const pic = chosen?.pic || photo(p) || colorsOf(p).find((c) => c.pic)?.pic || '';
  const s = state.settings;
  const available = inStock(p);
  const old = p.hasVariants ? null : p.oldPrice;
  // Под названием — размеры (не цвета: цвета видны кружками).
  const firstOpt = p.hasVariants ? optionNames(p).find((n) => n !== colorOptOf(p)) || optionNames(p)[0] : null;
  const values = firstOpt ? sortSizes([...new Set(variantsOf(p).filter((v) => v.stock > 0).map((v) => v.options?.[firstOpt]).filter(Boolean))]) : [];
  const meta = p.hasVariants ? values.slice(0, 6).join(' · ') + (values.length > 6 ? ' …' : '')
    : s.showStock && p.stock > 0 ? `В наличии: ${qtyFmt.format(p.stock)} ${esc(p.unit)}` : p.unit !== 'шт' ? `за ${esc(p.unit)}` : '';
  const btn = !available ? '' : p.hasVariants
    ? `<button type="button" class="quick ${inCart ? 'in' : ''}" data-open="${p.id}">${inCart ? `В корзине: ${qtyFmt.format(inCart)}` : 'Выбрать размер'}</button>`
    : `<button type="button" class="quick ${inCart ? 'in' : ''}" data-add="${p.id}">${inCart ? `✓ В корзине: ${qtyFmt.format(inCart)}` : 'В корзину'}</button>`;
  return `<article class="card ${available ? '' : 'out'}" role="button" tabindex="0" data-open="${p.id}" style="--i:${Math.min(i, 12)}">
    <div class="pic">${pic ? `<img src="${pic}" alt="${esc(p.name)}" loading="lazy">` : initial(p)}${badgesHtml(p)}${available ? '' : '<span class="soldout">Нет в наличии</span>'}${btn}</div>
    ${swatchesHtml(p)}
    <div class="info">
      <div class="name">${esc(p.name)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      <div class="price-row"><span class="price ${old ? 'sale' : ''}">${priceHtml(p)}</span>${old ? `<s class="old-price">${rub(old)}</s>` : ''}</div>
    </div>
  </article>`;
}

// Сортировка: по умолчанию — как в каталоге (по категориям), иначе общим списком.
function sortList(list) {
  const price = (p) => (p.hasVariants ? Math.min(...variantsOf(p).map((v) => v.price)) : p.price);
  const sale = (p) => (p.hasVariants ? variantsOf(p).some((v) => v.oldPrice) : Boolean(p.oldPrice));
  if (state.sort === 'cheap') return [...list].sort((a, b) => price(a) - price(b));
  if (state.sort === 'dear') return [...list].sort((a, b) => price(b) - price(a));
  if (state.sort === 'new') return [...list].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (state.sort === 'sale') return list.filter(sale);
  return list;
}

function renderGrid() {
  const q = state.query.trim().toLowerCase();
  const list = sortList(state.products.filter((p) => !p.parent_id && (!state.cat || p.category === state.cat) && (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))));
  const grid = $('#grid');
  grid.className = 'grid ' + state.settings.cardStyle;
  $('#count').textContent = list.length ? `${list.length} ${['товар', 'товара', 'товаров'][list.length % 10 === 1 && list.length % 100 !== 11 ? 0 : [2, 3, 4].includes(list.length % 10) && ![12, 13, 14].includes(list.length % 100) ? 1 : 2]}` : '';
  if (!list.length) {
    grid.innerHTML = `<p class="empty">${state.products.length ? (state.sort === 'sale' ? 'Сейчас товаров со скидкой нет' : 'Ничего не нашлось — попробуйте другой запрос') : 'Товары скоро появятся'}</p>`;
    return;
  }
  // На «Все товары» без поиска и сортировки товары разбиты по категориям.
  if (!state.cat && !q && !state.sort && new Set(list.map((p) => p.category)).size > 1) {
    let html = '';
    let current = null;
    let n = 0;
    for (const p of list) {
      if (p.category !== current) {
        current = p.category;
        n = 0;
        html += `<h2 class="cat-title">${esc(current || 'Другое')}<small>${list.filter((x) => x.category === current).length}</small></h2>`;
      }
      html += cardHtml(p, n++);
    }
    grid.innerHTML = html;
  } else {
    grid.innerHTML = list.map((p, i) => cardHtml(p, i)).join('');
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
    // Если на карточке выбрали расцветку — модификация этого цвета.
    const opt = colorOptOf(p);
    const want = opt && state.cardColor[p.id];
    const ofColor = want ? variantsOf(p).filter((v) => v.options?.[opt] === want) : [];
    const first = ofColor.find((v) => v.stock > 0) || ofColor[0] || variantsOf(p).find((v) => v.stock > 0) || variantsOf(p)[0];
    state.sel = p.hasVariants && first ? { ...first.options } : {};
  }
  const v = p.hasVariants ? matchVariant(p, state.sel) : p;
  const shown = v && v !== p && v.photo ? v : p;
  // У модификации нет своего фото — фото другой модификации того же цвета.
  const colorPic = colorOptOf(p) && state.sel[colorOptOf(p)] ? colorsOf(p).find((c) => c.name === state.sel[colorOptOf(p)])?.pic : '';
  const pic = shown === p && colorPic ? colorPic : photo(shown);
  const s = state.settings;
  const pickers = p.hasVariants ? optionNames(p).map((name) => {
    const values = sortSizes([...new Set(variantsOf(p).map((x) => x.options?.[name]).filter(Boolean))]);
    return `<div class="opt"><div class="opt-name">${esc(name)}${state.sel[name] ? `: <b>${esc(state.sel[name])}</b>` : ''}</div><div class="opt-values">
      ${values.map((val) => {
        // Значение недоступно, если с остальными выбранными свойствами такого товара нет в наличии.
        const alt = matchVariant(p, { ...state.sel, [name]: val });
        const cls = alt && alt.stock > 0 ? '' : 'na';
        // Цвет — кружком, название цвета — над кружками.
        if (name === colorOptOf(p)) {
          const c = colorsOf(p).find((x) => x.name === val) || { name: val, pic: '' };
          return `<button type="button" data-opt="${esc(name)}" data-val="${esc(val)}" aria-pressed="${state.sel[name] === val}" class="sw big ${cls}" title="${esc(val)}" aria-label="${esc(val)}"><i style="${swatchStyle(c)}"></i></button>`;
        }
        return `<button type="button" data-opt="${esc(name)}" data-val="${esc(val)}" aria-pressed="${state.sel[name] === val}" class="${cls}">${esc(val)}</button>`;
      }).join('')}
    </div></div>`;
  }).join('') : '';
  const can = v && v.stock > 0;
  const old = v && v !== p ? v.oldPrice : !p.hasVariants ? p.oldPrice : null;
  const perks = (s.productNotes || []).filter((x) => x.on !== false && x.text).map((x) => x.text);
  const chartOpen = Boolean($('#product-body .size-chart')?.open);
  // Галерея: фото выбранной модификации/цвета, иначе общая галерея товара. Без фото — как раньше (буква).
  const urls = galleryOf(p, v);
  const galKey = urls.join('|');
  const keepAt = galKey === state.galKey ? state.galAt : 0;
  state.galKey = galKey;
  state.galAt = keepAt;
  state.galUrls = urls;
  $('#product-body').innerHTML = `<div class="pd">
    <div class="pd-pic ${urls.length ? 'pd-gal' : ''}">${urls.length ? galleryHtml(urls, p.name) : pic ? `<img src="${pic}" alt="${esc(p.name)}">` : initial(p)}${badgesHtml(p)}</div>
    <div class="pd-info">
      ${p.category ? `<div class="pd-cat">${esc(p.category)}</div>` : ''}
      <h2 id="product-name">${esc(p.name)}</h2>
      <div class="pd-price"><span class="price ${old ? 'sale' : ''}">${v ? rub(v.price) : priceHtml(p)}${p.unit !== 'шт' ? ` <span class="small">за ${esc(p.unit)}</span>` : ''}</span>${old ? `<s>${rub(old)}</s>` : ''}</div>
      ${pickers}
      ${sizeChartHtml(s.sizeChart, p, chartOpen)}
      ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ''}
      ${s.showStock && can ? `<p class="small" style="text-align:left">В наличии: ${qtyFmt.format(v.stock)} ${esc(p.unit)}</p>` : ''}
      ${perks.length ? `<div class="pd-perks">${perks.map((t) => `<div>${esc(t)}</div>`).join('')}</div>` : ''}
      <div class="pd-buy">
        ${can ? `<button type="button" class="primary" data-add="${v.id}">${state.cart[v.id] ? `✓ В корзине: ${qtyFmt.format(state.cart[v.id])} · добавить ещё` : 'Добавить в корзину'}</button>`
          : `<span class="out-tag">${p.hasVariants && !v ? 'Такого сочетания нет' : 'Нет в наличии'}</span>`}
      </div>
    </div>
  </div>`;
  if (!$('#product').open) $('#product').showModal();
  if (urls.length > 1) galGo(keepAt, false);
}

/* ---------- Галерея в окне товара ---------- */
// Какие фото показать (первое — основное):
// 1) у выбранной модификации или другой модификации того же цвета есть своя галерея — только её фото;
// 2) есть только своё основное фото — оно (под цвет), затем общие дополнительные фото товара;
// 3) своих фото нет — общая галерея товара: основное фото товара и его дополнительные.
function galleryOf(p, v) {
  const opt = colorOptOf(p);
  const color = opt && state.sel[opt];
  const own = [v && v !== p ? v : null, ...(color ? variantsOf(p).filter((x) => x.options?.[opt] === color) : [])].filter(Boolean);
  const extra = (x) => (x.gallery || []).map((g) => `/shop/photo/${x.id}/${g.id}?v=${g.v}`);
  const withGallery = own.find((x) => x.gallery?.length);
  if (withGallery) return [...(withGallery.photo ? [photo(withGallery)] : []), ...extra(withGallery)];
  const ownMain = own.find((x) => x.photo);
  return [...(ownMain ? [photo(ownMain)] : p.photo ? [photo(p)] : []), ...extra(p)];
}
function galleryHtml(urls, name) {
  const many = urls.length > 1;
  return `<div class="pd-track" id="pd-track">${urls.map((u, i) => `<img src="${u}" alt="${esc(name)}${many ? ` — фото ${i + 1}` : ''}" data-zoom="${i}" ${i ? 'loading="lazy"' : ''} draggable="false">`).join('')}</div>
    ${many ? `<button type="button" class="pd-arrow prev" data-gal-step="-1" aria-label="Предыдущее фото">‹</button>
      <button type="button" class="pd-arrow next" data-gal-step="1" aria-label="Следующее фото">›</button>
      <div class="pd-thumbs" role="tablist" aria-label="Фото товара">${urls.map((u, i) => `<button type="button" role="tab" data-gal-go="${i}" aria-selected="${i === 0}" aria-label="Фото ${i + 1}"><img src="${u}" alt="" loading="lazy"></button>`).join('')}</div>
      <div class="pd-dots" aria-hidden="true">${urls.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}`;
}
// Перейти к фото i (листание и миниатюры работают через одну ленту с прокруткой).
function galGo(i, smooth = true) {
  const track = $('#pd-track');
  if (!track) return;
  const n = track.children.length;
  const at = (i + n) % n;
  track.scrollTo({ left: at * track.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  galMark(at);
}
function galMark(at) {
  state.galAt = at;
  document.querySelectorAll('#product [data-gal-go]').forEach((b, i) => b.setAttribute('aria-selected', String(i === at)));
  document.querySelectorAll('#product .pd-dots i').forEach((d, i) => d.classList.toggle('on', i === at));
}
// Листание пальцем: какое фото сейчас в ленте.
document.addEventListener('scroll', (e) => {
  if (e.target.id !== 'pd-track') return;
  const t = e.target;
  const at = Math.round(t.scrollLeft / Math.max(1, t.clientWidth));
  if (at !== state.galAt) galMark(at);
}, true);

// Увеличение по нажатию: фото на весь экран, листание пальцем или стрелками, закрыть — × или по фону.
document.body.insertAdjacentHTML('beforeend', `<dialog id="zoom" class="zoom" aria-label="Фото товара">
  <div class="zoom-track" id="zoom-track"></div>
  <button type="button" class="zoom-close" data-zoom-close aria-label="Закрыть">×</button>
  <button type="button" class="pd-arrow prev" data-zoom-step="-1" aria-label="Предыдущее фото">‹</button>
  <button type="button" class="pd-arrow next" data-zoom-step="1" aria-label="Следующее фото">›</button>
  <div class="zoom-count" id="zoom-count"></div>
</dialog>`);
function openZoom(i) {
  const urls = state.galUrls || [];
  if (!urls.length) return;
  $('#zoom-track').innerHTML = urls.map((u) => `<div class="zoom-slide"><img src="${u}" alt="" draggable="false"></div>`).join('');
  $('#zoom').classList.toggle('single', urls.length < 2);
  $('#zoom').showModal();
  zoomGo(i, false);
}
function zoomGo(i, smooth = true) {
  const t = $('#zoom-track');
  const n = t.children.length;
  const at = (i + n) % n;
  t.scrollTo({ left: at * t.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  $('#zoom-count').textContent = n > 1 ? `${at + 1} / ${n}` : '';
}
$('#zoom-track').addEventListener('scroll', () => {
  const t = $('#zoom-track');
  const n = t.children.length;
  $('#zoom-count').textContent = n > 1 ? `${Math.round(t.scrollLeft / Math.max(1, t.clientWidth)) + 1} / ${n}` : '';
});
$('#zoom').addEventListener('click', (e) => {
  const step = e.target.closest('[data-zoom-step]');
  if (step) {
    const t = $('#zoom-track');
    return zoomGo(Math.round(t.scrollLeft / t.clientWidth) + Number(step.dataset.zoomStep));
  }
  // Закрыть: крестик или нажатие мимо фото.
  if (e.target.closest('[data-zoom-close]') || !e.target.closest('img')) closeZoom();
});
// Окно товара после увеличения показывает то же фото, что смотрели (номер — до закрытия, пока лента видна).
function closeZoom() {
  const t = $('#zoom-track');
  const at = Math.round(t.scrollLeft / Math.max(1, t.clientWidth));
  $('#zoom').close();
  galGo(at, false);
}
$('#zoom').addEventListener('cancel', (e) => {
  e.preventDefault();
  closeZoom();
});
document.addEventListener('keydown', (e) => {
  if ($('#zoom').open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const t = $('#zoom-track');
    zoomGo(Math.round(t.scrollLeft / t.clientWidth) + (e.key === 'ArrowLeft' ? -1 : 1));
  } else if ($('#product').open && $('#pd-track') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.matches('input, textarea, select')) {
    galGo(state.galAt + (e.key === 'ArrowLeft' ? -1 : 1));
  }
});

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
  if (delta > 0) { const c = $('#cart-count'); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
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
      <div class="cart-thumb">${photo(l.p) ? `<img src="${photo(l.p)}" alt="">` : initial(l.p)}</div>
      <div class="info"><div class="name">${esc(l.p.name)}</div><div class="meta">${rub(l.p.price)} за ${esc(l.p.unit)}</div>
        <div class="row"><div class="stepper"><button type="button" data-add="${l.p.id}" data-delta="-1" aria-label="Меньше">−</button><span>${qtyFmt.format(l.qty)}</span><button type="button" data-add="${l.p.id}" aria-label="Больше">+</button></div>
        <div class="line-sum">${rub(l.qty * l.p.price)}</div></div></div>
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
  // Предоплата: способ оплаты, QR-код и сумма — до оформления. Заказ уходит, когда покупатель нажал «Я оплатил».
  const pays = s.payments || [];
  if (pays.length && !pays.some((x) => x.id === state.payId)) state.payId = pays[0].id;
  $('#pay-box').hidden = guest || !pays.length;
  if (pays.length && !guest) $('#pay-box').innerHTML = payBoxHtml(pays, state.payId, goods + delivery, 'checkout');
  $('#checkout-note').textContent = pays.length
    ? `${s.delivery && !s.pickup ? 'Доставка только по предоплате. ' : ''}После проверки оплаты мы упакуем заказ и передадим курьеру.`
    : 'Оплата при получении. Мы позвоним, чтобы подтвердить заказ.';
  const short = s.minOrder && goods < s.minOrder;
  const submit = $('#checkout button[type=submit]');
  submit.disabled = Boolean(short);
  submit.textContent = short ? `Минимальный заказ — ${rub(s.minOrder)}` : pays.length ? '✅ Я оплатил — оформить заказ' : 'Оформить заказ';
}

// Блок оплаты: выбор способа, сумма, QR-код (можно сохранить и открыть в приложении банка) и реквизиты.
function payBoxHtml(pays, payId, amount, where) {
  const p = pays.find((x) => x.id === payId) || pays[0];
  return `<h3>Оплата</h3>
    ${pays.length > 1 ? `<div class="pay-ways">${pays.map((x) => `<button type="button" data-pay="${esc(x.id)}" data-pay-where="${where}" aria-pressed="${x.id === p.id}">${esc(x.name)}</button>`).join('')}</div>` : `<div><b>${esc(p.name)}</b></div>`}
    <div class="pay-amount">Переведите <b>${rub(amount)}</b></div>
    ${p.qr ? `<img class="pay-qr" src="${p.qr}" alt="QR-код для оплаты: ${esc(p.name)}">
      <div class="pay-links"><a href="${p.qr}" download="qr-oplata.jpg">⬇ Сохранить QR-код</a></div>` : ''}
    ${p.details ? `<div class="pay-details">${esc(p.details)}</div><div class="pay-links"><button type="button" data-copy="${esc(p.details)}">Скопировать реквизиты</button></div>` : ''}
    <ol class="pay-steps">
      <li>Отсканируйте QR-код в приложении банка${p.qr ? ' (с телефона — сохраните картинку и выберите её в приложении)' : ''}.</li>
      <li>Переведите ${rub(amount)}.</li>
      <li>Прикрепите чек об оплате (скриншот из банка) — без него заказ не оформить.</li>
      <li>Нажмите «Я оплатил» — мы проверим поступление.</li>
    </ol>
    ${where === 'checkout' ? receiptPickHtml('checkout', state.receiptFile ? [state.receiptFile.name] : []) : ''}`;
}

// Прикрепить чек: кнопка-выбор файла (фото из галереи, скриншот или PDF).
function receiptPickHtml(target, names = [], count = 0) {
  return `<label class="receipt-pick">
      <input type="file" accept="image/*,application/pdf" data-receipt="${target}" hidden>
      <span class="receipt-btn">📎 ${names.length ? 'Заменить чек' : count ? 'Прикрепить ещё чек' : `Прикрепить чек об оплате${target === 'checkout' ? ' *' : ''}`}</span>
    </label>
    ${names.length ? `<div class="receipt-names">${names.map((n) => `✓ ${esc(n)}`).join('<br>')}</div>` : ''}
    ${count ? `<div class="receipt-names">✓ Чек прикреплён${count > 1 ? ` (${count})` : ''}</div>` : ''}`;
}

// Файл чека → данные для отправки: картинка уменьшается до 1600 px (JPEG), PDF — как есть.
async function receiptPayload(file) {
  const toBase64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(blob); });
  if (file.type === 'application/pdf') {
    if (file.size > 5e6) throw new Error('PDF больше 5 МБ');
    return { mime: 'application/pdf', data: await toBase64(file) };
  }
  if (!file.type.startsWith('image/')) throw new Error('Прикрепите картинку или PDF');
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  return { mime: 'image/jpeg', data: await toBase64(blob) };
}

async function uploadReceipt(orderId, file) {
  const res = await fetch(`/shop/order/${orderId}/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await receiptPayload(file)) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не получилось прикрепить чек');
  return data;
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-receipt]');
  if (!input || !input.files[0]) return;
  const file = input.files[0];
  if (input.dataset.receipt === 'checkout') {
    state.receiptFile = file;
    return renderCart();
  }
  try {
    await uploadReceipt(Number(input.dataset.receipt), file);
    toast('Чек прикреплён. Спасибо!');
    await loadMe();
    renderProfile();
  } catch (err) {
    toast(err.message);
  }
});

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
  // Галерея в окне товара: миниатюры, стрелки, увеличение.
  const galStep = e.target.closest('[data-gal-step]');
  if (galStep) return galGo(state.galAt + Number(galStep.dataset.galStep));
  const galTo = e.target.closest('[data-gal-go]');
  if (galTo) return galGo(Number(galTo.dataset.galGo));
  const zoomImg = e.target.closest('#pd-track [data-zoom]');
  if (zoomImg) return openZoom(Number(zoomImg.dataset.zoom));
  // Кружок расцветки на карточке: показать фото этого цвета, товар не открывать.
  const sw = e.target.closest('[data-swatch]');
  if (sw) {
    e.stopPropagation();
    state.cardColor[sw.dataset.swatch] = sw.dataset.color;
    return showCardColor(sw.dataset.swatch, sw.dataset.color);
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    state.sel[opt.dataset.opt] = opt.dataset.val;
    if (opt.dataset.opt === colorOptOf(byId(state.open))) state.cardColor[state.open] = opt.dataset.val;
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
  const pay = e.target.closest('[data-pay]');
  if (pay) {
    state.payId = pay.dataset.pay;
    if (pay.dataset.payWhere === 'checkout') return renderCart();
    return renderProfile();
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Реквизиты скопированы'), () => toast('Выделите реквизиты и скопируйте вручную'));
    return;
  }
  const claim = e.target.closest('[data-paid]');
  if (claim) return claimPaid(Number(claim.dataset.paid), claim);
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
// Наведение мышью на кружок — сразу фото этого цвета (на телефоне — по нажатию).
document.addEventListener('mouseover', (e) => {
  const sw = e.target.closest?.('[data-swatch]');
  if (!sw || !matchMedia('(hover: hover)').matches) return;
  state.cardColor[sw.dataset.swatch] = sw.dataset.color;
  showCardColor(sw.dataset.swatch, sw.dataset.color);
});
// Клик по затемнению закрывает окно.
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
$('#cart-open').addEventListener('click', () => { renderCart(); $('#cart').showModal(); });
$('#brand').addEventListener('click', (e) => { e.preventDefault(); scrollTo({ top: 0 }); });
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderGrid(); });
// Категория из шапки — сразу к каталогу.
$('#head-nav').addEventListener('click', (e) => { if (e.target.closest('[data-cat]')) $('#catalog').scrollIntoView({ behavior: 'smooth' }); });
addEventListener('scroll', () => $('#site-head').classList.toggle('scrolled', scrollY > 8), { passive: true });

$('#checkout').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#checkout-error');
  err.hidden = true;
  if (!state.me) return openAccount('login');
  const prepay = Boolean(state.settings.payments?.length);
  if (prepay && !state.receiptFile) {
    err.textContent = 'Прикрепите чек об оплате — скриншот перевода из приложения банка.';
    err.hidden = false;
    $('#pay-box .receipt-btn')?.classList.add('need');
    return;
  }
  const submit = f.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    // Чек уходит вместе с заказом: без него заказ с предоплатой не оформляется.
    const receipt = prepay ? await receiptPayload(state.receiptFile) : undefined;
    const res = await fetch('/shop/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: f.elements.address.value,
        comment: f.elements.comment.value, website: f.elements.website.value, delivery: state.way,
        payId: state.payId, receipt,
        items: cartLines().map((l) => ({ productId: l.p.id, qty: l.qty })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.me = null; renderAccountButton(); openAccount('login'); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || 'Не получилось оформить заказ');
    state.receiptFile = null;
    await loadMe();
    state.cart = {};
    saveCart();
    renderAll();
    $('#cart').close();
    $('#done-text').textContent = data.status === 'checking'
      ? `Номер заказа: ${data.id}. Сумма: ${rub(data.total)}. Мы проверим поступление оплаты, упакуем заказ и передадим курьеру. Статус — в «Моих заказах».`
      : `Номер заказа: ${data.id}. Сумма: ${rub(data.total)}. Мы скоро позвоним, чтобы подтвердить.`;
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
const ORDER_STATUS = { unpaid: 'Ждём оплату', checking: 'Проверяем оплату', new: 'Принят', confirmed: 'Подтверждён', ready: 'Собран', shipped: 'Передан курьеру', done: 'Получен', cancelled: 'Отменён' };
// У оплаченного заказа «подтверждён» — значит, оплата пришла и заказ упаковывают.
const orderStatusText = (o) => (o.pay_id && o.status === 'confirmed' ? 'Оплачен, упаковываем' : o.pay_id && o.status === 'ready' ? 'Упакован' : ORDER_STATUS[o.status] || o.status);

// «Я оплатил» по заказу, где оплата не нашлась или покупатель ещё не платил.
async function claimPaid(id, btn) {
  btn.disabled = true;
  try {
    await account(`../order/${id}/paid`);
    toast('Спасибо! Проверим поступление оплаты');
    await loadMe();
    renderProfile();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

async function account(path, body, method = 'POST') {
  const res = await fetch('/shop/account/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

// Уведомление «Оплата подтверждена»: один раз на заказ (запоминается в браузере), за последние 7 дней.
function paidNotice() {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem('paidSeen') || '[]'); } catch { /* без памяти браузера */ }
  const fresh = (state.orders || []).filter((o) => o.paid_at && Date.now() - o.paid_at < 7 * 864e5 && !seen.includes(o.id)
    && !['done', 'cancelled'].includes(o.status));
  if (!fresh.length || $('#paid-notice').open) return;
  $('#paid-text').textContent = fresh.length === 1
    ? `Мы получили оплату заказа №${fresh[0].id} на ${rub(fresh[0].total)}. Упаковываем заказ и скоро передадим курьеру.`
    : `Мы получили оплату заказов ${fresh.map((o) => '№' + o.id).join(', ')}. Упаковываем и скоро передадим курьеру.`;
  $('#paid-notice').showModal();
  try { localStorage.setItem('paidSeen', JSON.stringify([...seen, ...fresh.map((o) => o.id)].slice(-100))); } catch { /* ничего */ }
}
// Пока витрина открыта, раз в минуту проверяем, не подтвердили ли оплату.
setInterval(() => {
  if (state.me && document.visibilityState === 'visible' && (state.orders || []).some((o) => ['checking', 'unpaid'].includes(o.status))) loadMe();
}, 60_000);

async function loadMe() {
  try {
    const d = await fetch('/shop/account/me').then((r) => r.json());
    state.me = d.customer;
    state.orders = d.orders || [];
    state.purchases = d.purchases || [];
    state.bonusLog = d.bonusLog || [];
    state.loyalty = d.loyalty || null;
    state.certificates = d.certificates || [];
    state.certificateOps = d.certificateOps || [];
    state.manyStores = (d.stores || 1) > 1;
    if ($('#account').open && !$('#account [data-view="profile"]').hidden) renderProfile();
    paidNotice();
  } catch {
    state.me = null;
  }
  renderAccountButton();
  renderCart();
}

function renderAccountButton() {
  $('#account-label').textContent = state.me ? state.me.name.split(' ')[0] + (state.me.bonus ? ` · ${new Intl.NumberFormat('ru-RU').format(state.me.bonus)} Б` : '') : 'Войти';
}

// Капча: картинка с цифрами (с сервера), кнопка «другая картинка» и поле для ответа. Код одноразовый.
async function loadCaptcha(form) {
  const box = form?.querySelector('[data-captcha]');
  if (!box) return;
  if (!box.firstChild) {
    box.innerHTML = `<span class="cap-label">Введите цифры с картинки — так мы отличаем людей от программ-спамеров</span>
      <div class="captcha-img"></div><button type="button" class="captcha-new" title="Другая картинка" aria-label="Другая картинка">↻</button>
      <input name="captcha" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="Цифры" aria-label="Цифры с картинки" required>`;
  }
  box.querySelector('input').value = '';
  try {
    const c = await fetch('/shop/account/captcha', { cache: 'no-store' }).then((r) => r.json());
    box.dataset.id = c.id;
    box.querySelector('.captcha-img').innerHTML = c.svg;
  } catch {
    box.querySelector('.captcha-img').textContent = 'Нет связи';
  }
}
const captchaOf = (form) => {
  const box = form.querySelector('[data-captcha]');
  return box ? { captchaId: box.dataset.id || '', captcha: box.querySelector('input')?.value || '' } : {};
};
document.addEventListener('click', (e) => { const b = e.target.closest('.captcha-new'); if (b) loadCaptcha(b.closest('form')); });

function openAccount(view) {
  if (!view) view = state.me ? 'profile' : 'login';
  for (const el of document.querySelectorAll('#account .acc')) el.hidden = el.dataset.view !== view;
  for (const e of document.querySelectorAll('#account .error')) e.hidden = true;
  if (['login', 'register', 'forgot', 'code'].includes(view)) loadCaptcha($(`#account [data-view="${view}"]`));
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
  renderPurchases();
  renderBonusLog();
  $('#profile-orders').innerHTML = state.orders.length ? state.orders.map((o) => `
    <div class="profile-order">
      <div><b>№${o.id}</b> · ${new Date(o.created_at).toLocaleDateString('ru-RU')} <span class="status s-${o.status}">${orderStatusText(o)}</span></div>
      <div class="small left">${o.items.map((i) => `${esc(i.name)} × ${qtyFmt.format(i.qty)}`).join(', ')}</div>
      <b>${rub(o.total)}</b>
      ${o.status === 'unpaid' && state.settings?.payments?.length ? `<p class="small left">Мы не нашли оплату по этому заказу. Если вы уже перевели деньги — свяжитесь с нами${state.settings.phone ? `: ${esc(state.settings.phone)}` : ''}. Если нет — оплатите и нажмите «Я оплатил».</p>
        <div class="pay-box">${payBoxHtml(state.settings.payments, state.payId, o.total, 'profile')}${receiptPickHtml(o.id, [], o.receipts?.length || 0)}<button type="button" class="primary" data-paid="${o.id}">✅ Я оплатил</button></div>` : ''}
      ${o.pay_id && ['checking', 'confirmed', 'ready', 'shipped'].includes(o.status) ? receiptPickHtml(o.id, [], o.receipts?.length || 0) : ''}
    </div>`).join('') : '<p class="small left">Онлайн-заказов пока нет</p>';
  const f = $('#profile-form');
  f.elements.name.value = me.name;
  for (const r of f.querySelectorAll('input[name="gender"]')) r.checked = r.value === me.gender;
  const [y, m, d] = (me.birthday || '').split('-');
  f.elements.birthday.value = me.birthday ? `${d}.${m}${y !== '0000' ? '.' + y : ''}` : '';
  f.elements.password.value = '';
  f.elements.newPassword.value = '';
}

const dayText = (t) => { const d = new Date(t); return d.toLocaleDateString('ru-RU', d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' }); };
const bonusFmt = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);

// Покупки в магазине и выданные онлайн-заказы.
function renderPurchases() {
  const list = state.purchases || [];
  const paid = list.filter((s) => !s.refunded_at);
  $('#profile-purchases-sum').textContent = paid.length
    ? `Покупок: ${paid.length} на ${rub(paid.reduce((sum, s) => sum + s.total, 0))}`
    : '';
  $('#profile-purchases').innerHTML = list.length ? list.map((s) => `
    <div class="profile-order${s.refunded_at ? ' refunded' : ''}">
      <div class="row"><span><b>Чек №${s.id}</b> · ${dayText(s.created_at)}${state.manyStores ? `<br><span class="bonus-tag">🏬 ${esc(s.store)}</span>` : ''}${s.order_id ? ` <span class="status">заказ №${s.order_id}</span>` : ''}${s.refunded_at ? ' <span class="status s-cancelled">Возврат</span>' : ''}</span><b>${rub(s.total)}</b></div>
      <div class="small left">${s.items.map((i) => `${esc(i.name)} × ${qtyFmt.format(i.qty)} — ${rub(i.price)}`).join('<br>')}</div>
      ${s.bonus_spent || s.bonus_earned ? `<div class="bonus-tag">${s.bonus_spent ? `<span class="bonus-minus">−${bonusFmt(s.bonus_spent)}</span> бонусов списано` : ''}${s.bonus_spent && s.bonus_earned ? ' · ' : ''}${s.bonus_earned ? `<span class="bonus-plus">+${bonusFmt(s.bonus_earned)}</span> бонусов начислено` : ''}</div>` : ''}
    </div>`).join('') : '<p class="small left">Покупок пока нет. Назовите номер телефона на кассе — покупка появится здесь, и вам начислятся бонусы.</p>';
}

// Как работают бонусы и история: начисления и списания.
function renderBonusLog() {
  const l = state.loyalty;
  $('#profile-bonus-rules').textContent = l && l.enabled
    ? `С каждой покупки возвращается ${l.percent}% бонусами. 1 бонус = 1 сом: бонусами можно оплатить до ${l.maxPay}% покупки. Назовите номер телефона на кассе.`
    : 'Бонусная программа сейчас не действует.';
  if (state.manyStores) $('#profile-bonus-rules').textContent += ' Бонусы и сертификаты действуют во всех наших магазинах.';
  // Сертификаты покупателя: остаток и срок.
  const CERT_STATE = { active: 'Действует', used: 'Потрачен', expired: 'Срок истёк', blocked: 'Заблокирован' };
  const certs = state.certificates || [];
  $('#profile-certs').hidden = !certs.length;
  $('#profile-certs').innerHTML = certs.map((c) => `
    <div class="profile-cert${c.state === 'active' ? '' : ' off'}">
      <div class="row"><span>🎁 Сертификат <b>№${esc(c.number)}</b></span><b>${rub(c.balance)}</b></div>
      <div class="bonus-tag">${CERT_STATE[c.state] || ''}${c.state === 'active' && c.balance < c.amount ? ` · номинал ${rub(c.amount)}` : ''}${c.state === 'active' && c.expires_at ? ` · до ${dayText(c.expires_at)}` : ''}</div>
    </div>`).join('');
  // Общая история: бонусы и сертификаты вместе, новые сверху.
  const CERT_OP = { sale: 'Куплен сертификат', redeem: 'Оплата сертификатом', refund: 'Возврат на сертификат' };
  const rows = [
    ...(state.bonusLog || []).map((b) => ({ at: b.created_at, title: b.reason || (b.delta > 0 ? 'Начислено' : 'Списано'), store: b.store, value: b.delta, unit: 'bonus' })),
    ...(state.certificateOps || []).map((o) => ({ at: o.at, title: `${CERT_OP[o.kind]}${o.sale_id ? ` · чек №${o.sale_id}` : ''}`, store: o.store, value: o.amount, unit: 'cert', number: o.number })),
  ].sort((a, b) => b.at - a.at);
  $('#profile-bonus-log').innerHTML = rows.length ? rows.map((r) => `
    <div class="profile-order"><div class="row">
      <span>${r.unit === 'cert' ? '🎁 ' : ''}${esc(r.title)}<br><span class="bonus-tag">${dayText(r.at)}${state.manyStores && r.store ? ` · ${esc(r.store)}` : ''}${r.unit === 'cert' ? ` · №${esc(r.number)}` : ''}</span></span>
      <span class="${r.value > 0 ? 'bonus-plus' : 'bonus-minus'}">${r.value > 0 ? '+' : '−'}${r.unit === 'cert' ? rub(Math.abs(r.value)) : bonusFmt(Math.abs(r.value)) + ' Б'}</span>
    </div></div>`).join('') : '<p class="small left">Начислений и списаний пока не было.</p>';
}

$('#account .profile-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ptab]');
  if (b) showProfileTab(b.dataset.ptab);
});
function showProfileTab(tab) {
  for (const b of document.querySelectorAll('#account [data-ptab]')) b.setAttribute('aria-selected', String(b.dataset.ptab === tab));
  for (const p of document.querySelectorAll('#account [data-pane]')) p.hidden = p.dataset.pane !== tab;
}

$('#account-open').addEventListener('click', () => { if (state.me) loadMe(); openAccount(); });
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
    loggedIn(await account('login', { phone: f.elements.phone.value, password: f.elements.password.value, ...captchaOf(f) }), 'Вы вошли');
  } catch (err) { showError(f, err); loadCaptcha(f); }
});
$('#account [data-view="register"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['phone', 'name', 'birthday', 'password', 'gender'].map((k) => [k, f.elements[k].value]));
  if (!body.gender) return showError(f, new Error('Укажите пол'));
  try {
    const d = await account('register', { ...body, ...captchaOf(f) });
    if (d.needCode) return openCode('register', body.phone, d.channel, { body });
    loggedIn(d, 'Готово! Вы зарегистрированы');
  } catch (err) { showError(f, err); loadCaptcha(f); }
});
$('#account [data-view="forgot"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await account('reset/request', { phone: f.elements.phone.value, ...captchaOf(f) });
    openCode('reset', f.elements.phone.value, d.channel);
  } catch (err) { showError(f, err); loadCaptcha(f); }
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
    const d = c.purpose === 'register' ? await account('register', { ...c.body, ...captchaOf(f) }) : await account('reset/request', { phone: c.phone, ...captchaOf(f) });
    openCode(c.purpose, c.phone, d.channel, c.purpose === 'register' ? { body: c.body } : {});
    toast('Новый код запрошен');
  } catch (err) { showError(f, err); loadCaptcha(f); }
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
  state.purchases = [];
  state.bonusLog = [];
  state.certificates = [];
  state.certificateOps = [];
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
