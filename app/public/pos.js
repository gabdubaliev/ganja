'use strict';

// Касса: подбор товаров в чек и продажа.

const pos = {
  cart: [],          // { productId, qty, price }
  payment: 'card',
  busy: false,
  customer: null,    // покупатель из программы лояльности
  spend: 0,          // сколько бонусов списать
  birthday: true,    // применить скидку именинника, если она действует
  cat: '',           // выбранная категория: показываются только её товары
  cats: [],          // справочник категорий с фото
  shift: null,       // открытая смена кассира
};

// Скидка именинника в %, если она действует и кассир её не снял.
const birthdayRate = () => (pos.customer?.birthdayDiscount && pos.birthday ? pos.customer.birthdayDiscount : 0);
// Цена строки со скидкой — так же, как считает сервер: скидка к цене, округление до тыйына.
const linePrice = (l) => Math.round(l.price * (1 - birthdayRate() / 100) * 100) / 100;

function renderPick() {
  const q = $('#pos-search').value;
  // Без поиска модификации спрятаны в карточку своего товара; при поиске находятся сразу.
  // Поиск ищет по всем товарам; без поиска — товары выбранной категории.
  const list = q.trim() ? groupVariants(catalog.search(q, 40), q) : catalog.list.filter((p) => !p.parent_id && (!pos.cat || p.category === pos.cat));
  renderPosCats(Boolean(q.trim()));
  $('#pos-results').innerHTML = list.length ? list.map((p) => {
    const group = catalog.isGroup(p);
    const inCart = group
      ? pos.cart.filter((l) => catalog.byId(l.productId)?.parent_id === p.id).reduce((s, l) => s + l.qty, 0)
      : pos.cart.find((l) => l.productId === p.id)?.qty || 0;
    const left = catalog.stockOf(p) - inCart;
    // У модификации без своего фото показываем фото товара.
    const photo = photoUrl(p) || (p.parent_id ? photoUrl(catalog.byId(p.parent_id) || {}) : '');
    const prices = group ? catalog.children(p.id).map((k) => k.price) : [p.price];
    const lo = Math.min(...prices);
    return `<button type="button" class="pick ${left <= 0 ? 'out' : ''} ${photo ? 'has-photo' : ''}" data-id="${p.id}">
      ${photo ? `<img class="pick-photo" src="${photo}" alt="" loading="lazy">` : ''}
      <span class="pick-name">${esc(p.name)}${group ? `<span class="pick-meta"> · ${catalog.children(p.id).length} вар.</span>` : ''}</span>
      <span class="pick-price num">${group && Math.max(...prices) !== lo ? 'от ' : ''}${money2(lo)}</span>
      <span class="pick-meta">${esc([p.code, p.category].filter(Boolean).join(' · ') || 'Без категории')}</span>
      <span class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе' : 'осталось ' + qty(left, p.unit)}</span>
    </button>`;
  }).join('') : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет. Их добавляет администратор или кладовщик.'}</p>`;
}

function cartTotal() {
  return Math.round(pos.cart.reduce((s, l) => s + l.qty * linePrice(l), 0) * 100) / 100;
}

const cartFull = () => Math.round(pos.cart.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;

function renderCart() {
  $('#cart').innerHTML = pos.cart.length ? pos.cart.map((l, i) => {
    const p = catalog.byId(l.productId);
    const over = l.qty > p.stock;
    return `<div class="cart-line" data-i="${i}">
      <div class="cart-name">${esc(p.name)}<span class="pick-meta num">${money2(l.price)} за ${esc(p.unit)}</span>${over ? `<span class="neg">На складе ${qty(p.stock, p.unit)}, остаток уйдёт в минус</span>` : ''}</div>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Меньше">−</button>
        <input class="num" inputmode="decimal" value="${qtyFmt.format(l.qty)}" aria-label="Количество ${esc(p.name)}">
        <button type="button" data-step="1" aria-label="Больше">+</button>
      </div>
      <div class="cart-sum num">${money2(l.qty * l.price)}</div>
      <button type="button" class="icon-btn" data-remove aria-label="Убрать ${esc(p.name)} из чека">×</button>
    </div>`;
  }).join('') : '<p class="empty">Выберите товары слева или отсканируйте штрихкод</p>';
  const total = cartTotal();
  const paid = Math.round((total - bonusSpend()) * 100) / 100;
  $('#cart-total').innerHTML = total < cartFull() ? `<s class="old-price">${money2(cartFull())}</s> ${money2(total)}` : money2(total);
  renderCustomer();
  $('#cart-topay').hidden = !bonusSpend();
  $('#cart-paid').textContent = money2(paid);
  $('#checkout').disabled = !pos.cart.length || pos.busy;
  $('#cart-clear').hidden = !pos.cart.length;
  for (const b of document.querySelectorAll('#pay [data-pay]')) b.setAttribute('aria-pressed', b.dataset.pay === pos.payment);
  $('#cash-row').hidden = pos.payment !== 'cash';
  const given = parseNum($('#cash-given').value);
  $('#change').textContent = pos.payment === 'cash' && given > 0
    ? (given >= paid ? `Сдача: ${money2(given - paid)}` : `Не хватает ${money2(paid - given)}`)
    : '';
}

/* ---------- Покупатель и бонусы ---------- */
// Бонусами можно оплатить не больше заданного процента чека и не больше, чем есть у покупателя.
function bonusLimit() {
  if (!pos.customer) return 0;
  return Math.max(0, Math.min(pos.customer.bonus, Math.floor(cartTotal() * session.loyalty.maxPay / 100)));
}
const bonusSpend = () => Math.min(pos.spend, bonusLimit());

function renderCustomer() {
  $('#customer-box').hidden = !session.loyalty.enabled;
  const c = pos.customer;
  $('#customer-find').hidden = Boolean(c) || !$('#customer-new').hidden;
  $('#customer-card').hidden = !c;
  if (!c) return;
  $('#customer-bday-row').hidden = !c.birthdayDiscount;
  if (c.birthdayDiscount) {
    const off = cartFull() - cartTotal();
    $('#customer-bday').checked = pos.birthday;
    $('#customer-bday-text').textContent = `🎂 ${c.birthdayIn === 0 ? 'Сегодня день рождения' : 'Скоро день рождения'} — скидка ${c.birthdayDiscount}%${off > 0 ? ` (−${money2(off)})` : ''}`;
  }
  $('#customer-title').textContent = c.name || phoneFmt(c.phone);
  $('#customer-meta').textContent = ` · ${c.name ? phoneFmt(c.phone) + ' · ' : ''}бонусов ${qtyFmt.format(c.bonus)}`;
  const limit = bonusLimit();
  $('#customer-spend-row').hidden = !c.bonus;
  $('#customer-spend-hint').textContent = limit ? `можно до ${qtyFmt.format(limit)}` : 'добавьте товары в чек';
  const earn = Math.floor((cartTotal() - bonusSpend()) * session.loyalty.percent / 100);
  if (pos.cart.length) $('#customer-meta').textContent += ` · за этот чек +${earn}`;
}

async function lookupCustomer() {
  const phone = $('#customer-phone').value;
  if (!phone.trim()) return;
  try {
    const found = await api('/api/customers/by-phone?phone=' + encodeURIComponent(phone));
    if (found) {
      pos.customer = found;
      pos.spend = 0;
      $('#customer-spend').value = '';
    } else {
      $('#customer-new').hidden = false;
      $('#customer-new-name').focus();
    }
    renderCart();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function clearCustomer() {
  pos.customer = null;
  pos.spend = 0;
  pos.birthday = true;
  $('#customer-new-bday').value = '';
  $('#customer-phone').value = '';
  $('#customer-spend').value = '';
  $('#customer-new').hidden = true;
}

$('#customer-lookup').addEventListener('click', lookupCustomer);
$('#customer-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupCustomer(); } });
$('#customer-create').addEventListener('click', async () => {
  try {
    pos.customer = await api('/api/customers', { method: 'POST', body: { phone: $('#customer-phone').value, name: $('#customer-new-name').value, birthday: $('#customer-new-bday').value } });
    $('#customer-new').hidden = true;
    $('#customer-new-name').value = '';
    toast('Карта покупателя заведена');
    renderCart();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#customer-bday').addEventListener('change', (e) => { pos.birthday = e.target.checked; renderCart(); });
$('#customer-clear').addEventListener('click', () => { clearCustomer(); renderCart(); });
$('#customer-spend').addEventListener('input', (e) => {
  pos.spend = Math.max(0, parseNum(e.target.value) || 0);
  if (pos.spend > bonusLimit()) {
    pos.spend = bonusLimit();
    e.target.value = pos.spend || '';
  }
  renderCart();
});

function addToCart(id, amount = 1) {
  const p = catalog.byId(id);
  if (!p) return;
  const line = pos.cart.find((l) => l.productId === p.id);
  if (line) line.qty += amount;
  else pos.cart.push({ productId: p.id, qty: amount, price: p.price });
  renderCart();
  renderPick();
}

$('#pos-search').addEventListener('input', renderPick);
$('#pos-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const found = catalog.search(e.target.value, 2);
  // Все найденные — модификации одного товара: открываем выбор цвета и размера.
  const bases = new Set(found.map((p) => p.parent_id || p.id));
  if (found.length > 1 && bases.size === 1 && found[0].parent_id) {
    openVariantPicker(catalog.byId(found[0].parent_id));
    return;
  }
  // Сканер штрихкодов вводит код и нажимает Enter.
  if (found.length === 1) {
    addToCart(found[0].id);
    e.target.value = '';
    renderPick();
  } else if (!found.length) {
    toast('Товар не найден', 'error');
  } else {
    toast(`Подходит ${found.length} ${plural(found.length, ['товар', 'товара', 'товаров'])}, выберите нужный`);
  }
});
$('#pos-results').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (!btn) return;
  const p = catalog.byId(btn.dataset.id);
  if (catalog.isGroup(p)) openVariantPicker(p);
  else addToCart(p.id);
});

// В поиске модификации собираются в карточку своего товара: «Кеды» — одна карточка, а не шесть.
// Точное совпадение по штрихкоду или коду остаётся модификацией — её можно сразу положить в чек.
function groupVariants(found, q) {
  const key = q.trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const p of found) {
    const exact = (p.barcode && p.barcode === key) || (p.code && p.code.toLowerCase() === key);
    const item = p.parent_id && !exact ? catalog.byId(p.parent_id) || p : p;
    if (!seen.has(item.id)) { seen.add(item.id); out.push(item); }
  }
  return out;
}

/* ---------- Выбор модификации: сначала цвет, потом размер ---------- */
const picker = { base: null, sel: {}, qty: 1 };
const leftOf = (k) => k.stock - (pos.cart.find((l) => l.productId === k.id)?.qty || 0);
const optsOf = (k) => (k.options ? JSON.parse(k.options) : {});

// Свойства товара в порядке модификаций: «Цвет», «Размер».
function optionNames(base) {
  const names = [];
  for (const k of catalog.children(base.id)) for (const n of Object.keys(optsOf(k))) if (!names.includes(n)) names.push(n);
  return names;
}

const matchVariant = (base, sel) => catalog.children(base.id).find((k) => {
  const o = optsOf(k);
  return Object.entries(sel).every(([n, v]) => o[n] === v);
});

function openVariantPicker(base) {
  picker.base = base;
  picker.qty = 1;
  // Сразу выбрана первая модификация в наличии.
  const kids = catalog.children(base.id);
  const first = kids.find((k) => leftOf(k) > 0) || kids[0];
  picker.sel = first ? optsOf(first) : {};
  const photo = photoUrl(base);
  $('#variant-photo').innerHTML = photo ? `<img src="${photo}" alt="">` : esc(base.name.trim()[0] || '•');
  $('#variant-title').textContent = base.name;
  const total = kids.reduce((s, k) => s + Math.max(0, k.stock), 0);
  $('#variant-sub').textContent = `${kids.length} ${plural(kids.length, ['модификация', 'модификации', 'модификаций'])} · всего на складе ${qty(total, base.unit)}`;
  renderVariantPicker();
  $('#variant-dialog').showModal();
}

function renderVariantPicker() {
  const base = picker.base;
  const names = optionNames(base);
  const kids = catalog.children(base.id);
  $('#variant-options').innerHTML = names.map((name) => {
    const values = [...new Set(kids.map((k) => optsOf(k)[name]).filter(Boolean))];
    return `<div class="variant-opt">
      <div class="variant-opt-name">${esc(name)}${picker.sel[name] ? `: <b>${esc(picker.sel[name])}</b>` : ''}</div>
      <div class="variant-values">${values.map((v) => {
        // Значение «нет», если с остальными выбранными свойствами такой модификации нет на складе.
        const alt = matchVariant(base, { ...picker.sel, [name]: v });
        const stock = alt ? leftOf(alt) : 0;
        return `<button type="button" data-opt="${esc(name)}" data-val="${esc(v)}" aria-pressed="${picker.sel[name] === v}" class="${!alt ? 'none' : stock <= 0 ? 'out' : ''}" title="${!alt ? 'Такого сочетания нет' : stock <= 0 ? 'Нет на складе' : `Осталось ${qtyFmt.format(stock)}`}">${esc(v)}</button>`;
      }).join('')}</div>
    </div>`;
  }).join('');
  const k = matchVariant(base, picker.sel);
  const left = k ? leftOf(k) : 0;
  $('#variant-result').innerHTML = k ? `
    <div><b>${esc(optionsText(k))}</b><div class="pick-meta">${esc(k.barcode || k.code || '')}</div></div>
    <div class="variant-price num">${money2(k.price)}</div>
    <div class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе — продажа уйдёт в минус' : 'осталось ' + qty(left, k.unit)}</div>`
    : '<p class="pick-meta">Такого сочетания нет — выберите другое</p>';
  $('#variant-qty input').value = qtyFmt.format(picker.qty);
  $('#variant-add').disabled = !k;
  $('#variant-add').textContent = k ? `Добавить в чек · ${money2(k.price * picker.qty)}` : 'Добавить в чек';
}

$('#variant-options').addEventListener('click', (e) => {
  const b = e.target.closest('[data-opt]');
  if (!b) return;
  picker.sel[b.dataset.opt] = b.dataset.val;
  // Если такого сочетания нет, берём ближайшее, где выбранное значение есть.
  if (!matchVariant(picker.base, picker.sel)) {
    const alt = catalog.children(picker.base.id).find((k) => optsOf(k)[b.dataset.opt] === b.dataset.val && leftOf(k) > 0)
      || catalog.children(picker.base.id).find((k) => optsOf(k)[b.dataset.opt] === b.dataset.val);
    if (alt) picker.sel = optsOf(alt);
  }
  renderVariantPicker();
});
$('#variant-qty').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vq]');
  if (!b) return;
  picker.qty = Math.max(1, picker.qty + Number(b.dataset.vq));
  renderVariantPicker();
});
$('#variant-qty input').addEventListener('change', (e) => {
  picker.qty = Math.max(0.001, parseNum(e.target.value) || 1);
  renderVariantPicker();
});
$('#variant-add').addEventListener('click', () => {
  const k = matchVariant(picker.base, picker.sel);
  if (!k) return;
  addToCart(k.id, picker.qty);
  $('#variant-dialog').close();
  toast(`${k.name} — в чеке`);
});
$('#variant-close').addEventListener('click', () => $('#variant-dialog').close());
$('#cart').addEventListener('click', (e) => {
  const line = e.target.closest('.cart-line');
  if (!line) return;
  const l = pos.cart[Number(line.dataset.i)];
  if (e.target.closest('[data-remove]')) pos.cart.splice(Number(line.dataset.i), 1);
  else if (e.target.closest('[data-step]')) {
    l.qty = Math.max(0, l.qty + Number(e.target.closest('[data-step]').dataset.step));
    if (!l.qty) pos.cart.splice(Number(line.dataset.i), 1);
  } else return;
  renderCart();
  renderPick();
});
$('#cart').addEventListener('change', (e) => {
  const line = e.target.closest('.cart-line');
  if (!line || e.target.tagName !== 'INPUT') return;
  const value = parseNum(e.target.value);
  if (value > 0) pos.cart[Number(line.dataset.i)].qty = value;
  else pos.cart.splice(Number(line.dataset.i), 1);
  renderCart();
  renderPick();
});
$('#pay').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pay]');
  if (!btn) return;
  pos.payment = btn.dataset.pay;
  renderCart();
  if (pos.payment === 'cash') $('#cash-given').focus();
});
$('#cash-given').addEventListener('input', renderCart);
$('#cart-clear').addEventListener('click', () => { pos.cart = []; $('#cash-given').value = ''; clearCustomer(); renderCart(); renderPick(); });

$('#checkout').addEventListener('click', async () => {
  const total = cartTotal() - bonusSpend();
  if (pos.payment === 'cash' && $('#cash-given').value && parseNum($('#cash-given').value) < total) {
    return toast('Получено меньше, чем сумма чека', 'error');
  }
  pos.busy = true;
  renderCart();
  try {
    const sale = await api('/api/sales', {
      method: 'POST',
      body: { payment: pos.payment, items: pos.cart, customerId: pos.customer?.id, bonusSpend: bonusSpend(), birthday: birthdayRate() > 0 },
    });
    toast(`Чек №${sale.id} на ${money2(sale.total)} пробит${sale.discount ? `, скидка ${money2(sale.discount)}` : ''}${sale.bonusEarned ? `, начислено ${sale.bonusEarned} бонусов` : ''}`);
    loadShift();
    pos.cart = [];
    $('#cash-given').value = '';
    clearCustomer();
    await catalog.load();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pos.busy = false;
    renderCart();
    renderPick();
    $('#pos-search').focus();
  }
});

/* ---------- Смена ---------- */
async function loadShift() {
  if (!session.user) return;
  try {
    pos.shift = await api('/api/shift');
  } catch {
    return;
  }
  const sh = pos.shift;
  const bar = $('#shift-bar');
  bar.hidden = false;
  bar.className = 'shift-bar ' + (sh ? 'open' : 'closed');
  bar.innerHTML = sh
    ? `<span>Смена открыта с <b>${new Date(sh.opened_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</b> · ${int(sh.receipts)} ${plural(sh.receipts, ['чек', 'чека', 'чеков'])} на <b>${money2(sh.revenue)}</b> · наличными ${money2(sh.cash)}, картой ${money2(sh.card)}</span>
       <button type="button" class="btn small" id="shift-close">Закрыть смену</button>`
    : `<span>Смена не открыта. Откройте её в начале рабочего дня — по сменам считается зарплата.</span>
       <button type="button" class="btn small primary" id="shift-open">Открыть смену</button>`;
}

$('#shift-bar').addEventListener('click', async (e) => {
  const open = e.target.closest('#shift-open');
  const close = e.target.closest('#shift-close');
  if (!open && !close) return;
  if (close && !close.classList.contains('danger')) {
    close.classList.add('danger');
    close.textContent = 'Нажмите ещё раз, чтобы закрыть';
    return;
  }
  try {
    const sh = await api(open ? '/api/shift/open' : '/api/shift/close', { method: 'POST' });
    toast(open ? 'Смена открыта. Хорошей работы!' : `Смена закрыта: ${sh.receipts} ${plural(sh.receipts, ['чек', 'чека', 'чеков'])} на ${money2(sh.revenue)}, в кассе наличными ${money2(sh.cash)}`);
    loadShift();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ---------- Категории с фото над товарами ---------- */
async function loadPosCats() {
  try { pos.cats = await api('/api/categories'); } catch { pos.cats = []; }
}

function renderPosCats(searching) {
  const used = new Set(catalog.list.filter((p) => !p.parent_id).map((p) => p.category).filter(Boolean));
  const cats = pos.cats.filter((c) => used.has(c.name));
  if (pos.cat && !used.has(pos.cat)) pos.cat = '';
  const el = $('#pos-cats');
  // При поиске категории не нужны; одна категория — тоже.
  el.hidden = searching || cats.length < 2;
  if (el.hidden) return;
  el.innerHTML = [{ name: '', label: 'Все' }, ...cats].map((c) => `
    <button type="button" class="pos-cat" data-pos-cat="${esc(c.name)}" aria-pressed="${pos.cat === c.name}">
      <span class="pos-cat-pic">${c.image_id ? `<img src="/img/${c.image_id}" alt="" loading="lazy">` : esc(c.name ? c.name.trim()[0].toUpperCase() : '★')}</span>
      <span class="pos-cat-name">${esc(c.label || c.name)}</span>
    </button>`).join('');
}

$('#pos-cats').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pos-cat]');
  if (!btn) return;
  pos.cat = btn.dataset.posCat;
  renderPick();
});

views.pos = {
  async show() {
    try { await Promise.all([catalog.load(), loadPosCats()]); } catch (err) { toast(err.message, 'error'); }
    renderPick();
    renderCart();
    loadShift();
    $('#pos-search').focus();
  },
  right: 'pos',
};
