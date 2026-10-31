'use strict';

// Касса: подбор товаров в чек и продажа.

const pos = {
  cart: [],          // { productId, qty, price, discount?: { type: 'pct' | 'sum' | 'price', value }, sel? }
  checkDiscount: null, // скидка на весь чек { type: 'pct' | 'sum', value }
  split: null,       // смешанная оплата: { [methodId]: 'сумма' }; остаток идёт на pos.methodId
  methods: [],       // способы оплаты, доступные кассиру
  methodId: null,    // выбранный способ
  busy: false,
  customer: null,    // покупатель из программы лояльности
  spend: 0,          // сколько бонусов списать
  birthday: true,    // применить скидку именинника, если она действует
  cat: '',           // выбранная категория: показываются только её товары
  cats: [],          // справочник категорий с фото
  shift: null,       // открытая смена кассира
};

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
    const hidden = catalog.stockOf(p) === null;
    const left = hidden ? Infinity : catalog.stockOf(p) - inCart;
    // У модификации без своего фото показываем фото товара.
    const photo = photoUrl(p) || (p.parent_id ? photoUrl(catalog.byId(p.parent_id) || {}) : '');
    const prices = group ? catalog.children(p.id).map(salePrice) : [salePrice(p)];
    const lo = Math.min(...prices);
    return `<button type="button" class="pick ${left <= 0 ? 'out' : ''} ${photo ? 'has-photo' : ''}" data-id="${p.id}">
      ${photo ? `<img class="pick-photo" src="${photo}" alt="" loading="lazy">` : ''}
      <span class="pick-name">${esc(p.name)}${group ? `<span class="pick-meta"> · ${catalog.children(p.id).length} вар.</span>` : ''}</span>
      <span class="pick-price num">${group && Math.max(...prices) !== lo ? 'от ' : ''}${!group && p.discount > 0 ? `<s class="pick-old">${money2(p.price)}</s> ` : ''}${money2(lo)}</span>
      <span class="pick-meta">${esc([p.code, p.category].filter(Boolean).join(' · ') || 'Без категории')}</span>
      ${hidden ? '' : `<span class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе' : 'осталось ' + qty(left, p.unit)}</span>`}
    </button>`;
  }).join('') : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет. Их добавляет администратор или кладовщик.'}</p>`;
}


// Скидка именинника в %, если она действует и кассир её не снял.
const birthdayRate = () => (pos.customer?.birthdayDiscount && pos.birthday ? pos.customer.birthdayDiscount : 0);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// Считает чек так же, как сервер: скидка именинника → скидки на строки → скидка на чек.
function calcCart() {
  const lines = pos.cart.map((l) => ({ ...l, final: l.price }));
  const bday = birthdayRate();
  if (bday) for (const l of lines) l.final = r4(l.final * (1 - bday / 100));
  const sum = () => r2(lines.reduce((s, l) => s + l.qty * l.final, 0));
  const afterBirthday = sum();
  for (const l of lines) {
    const d = l.discount;
    if (!d || d.value === '' || d.value == null) continue;
    const base = l.qty * l.final;
    const off = d.type === 'pct' ? base * Math.min(100, d.value) / 100
      : d.type === 'price' ? Math.max(0, r2((l.final - d.value) * l.qty)) : Math.min(base, d.value);
    if (off > 0) l.final = r4((base - off) / l.qty);
  }
  const sub = sum();
  const cd = pos.checkDiscount;
  const checkOff = !cd || !sub ? 0 : cd.type === 'pct' ? sub * Math.min(100, cd.value) / 100 : Math.min(sub, cd.value);
  if (checkOff) for (const l of lines) l.final = r4(l.final * (sub - checkOff) / sub);
  const total = sum();
  return { lines, full: r2(pos.cart.reduce((s, l) => s + l.qty * l.price, 0)), total, manual: r2(afterBirthday - total), afterBirthday };
}
const cartTotal = () => calcCart().total;
const cartFull = () => calcCart().full;

function renderCart() {
  const calc = calcCart();
  const canDiscount = session.can('discount');
  $('#cart').innerHTML = pos.cart.length ? pos.cart.map((l, i) => {
    const p = catalog.byId(l.productId);
    const over = p.stock !== null && l.qty > p.stock;
    const c = calc.lines[i];
    const changed = Math.abs(c.final - l.price) > 0.00001;
    return `<div class="cart-line ${canDiscount ? 'with-sel' : ''} ${l.sel ? 'selected' : ''}" data-i="${i}">
      ${canDiscount ? `<input type="checkbox" class="line-sel" data-sel ${l.sel ? 'checked' : ''} aria-label="Выбрать ${esc(p.name)} для скидки">` : ''}
      <div class="cart-name">${esc(p.name)}<span class="pick-meta num">${changed ? `<s>${money2(l.price)}</s> <b class="disc-tag">${money2(c.final)}</b>` : money2(l.price)} за ${esc(p.unit)}${l.discount ? ` · <span class="disc-tag">${discountLabel(l.discount)}</span>` : ''}</span>${over ? `<span class="neg">На складе ${qty(p.stock, p.unit)}, остаток уйдёт в минус</span>` : ''}</div>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Меньше">−</button>
        <input class="num" inputmode="decimal" value="${qtyFmt.format(l.qty)}" aria-label="Количество ${esc(p.name)}">
        <button type="button" data-step="1" aria-label="Больше">+</button>
      </div>
      <div class="cart-sum num">${money2(l.qty * c.final)}</div>
      <button type="button" class="icon-btn" data-remove aria-label="Убрать ${esc(p.name)} из чека">×</button>
    </div>`;
  }).join('') : '<p class="empty">Выберите товары слева или отсканируйте штрихкод</p>';
  const total = calc.total;
  const paid = r2(total - bonusSpend() - certUse());
  renderCertUse();
  $('#cart-total').innerHTML = total < calc.full ? `<s class="old-price">${money2(calc.full)}</s> ${money2(total)}` : money2(total);
  renderDiscountBar(calc);
  renderCustomer();
  $('#cart-topay').hidden = !bonusSpend() && !certUse();
  $('#cart-paid').textContent = money2(paid);
  $('#checkout').disabled = !pos.cart.length || pos.busy;
  $('#cart-clear').hidden = !pos.cart.length;
  renderPayMethods(paid);
  // Сдача считается с наличной части: при смешанной оплате — с той суммы, что идёт наличными.
  const cashPart = cashAmount(paid);
  $('#cash-row').hidden = cashPart === null;
  $('#cash-label').textContent = pos.split ? `Получено наличными (к оплате ${money2(cashPart || 0)})` : 'Получено от покупателя';
  const given = parseNum($('#cash-given').value);
  $('#change').textContent = cashPart !== null && given > 0
    ? (given >= cashPart ? `Сдача: ${money2(given - cashPart)}` : `Не хватает ${money2(cashPart - given)}`)
    : '';
}

/* ---------- Скидки кассира ---------- */
const discountLabel = (d) => (d.type === 'pct' ? `−${qtyFmt.format(d.value)}%` : d.type === 'price' ? `цена ${money2(d.value)}` : `−${money2(d.value)}`);

function renderDiscountBar(calc) {
  const bar = $('#discount-bar');
  bar.hidden = !session.can('discount') || !pos.cart.length;
  if (bar.hidden) return;
  const selected = pos.cart.filter((l) => l.sel).length;
  const limit = session.user?.max_discount;
  $('#discount-open').textContent = selected ? `% Скидка на выбранные (${selected})` : '% Скидка';
  $('#discount-info').innerHTML = [
    pos.checkDiscount ? `на чек <b>${discountLabel(pos.checkDiscount)}</b>` : '',
    calc.manual > 0 ? `скидка кассира <b class="num">${money2(calc.manual)}</b>` : '',
    limit != null && calc.manual > calc.afterBirthday * limit / 100 + 0.01 ? `<span class="neg">больше вашего предела ${qtyFmt.format(limit)}%</span>` : '',
  ].filter(Boolean).join(' · ');
  $('#discount-select-all').textContent = selected === pos.cart.length ? 'Снять выбор' : 'Выбрать все';
}

// Окно скидки: target — 'check' (весь чек), 'lines' (выбранные строки) или номер строки.
const disc = { target: 'check', type: 'pct' };

function openDiscount(target) {
  disc.target = target;
  const lines = typeof target === 'number' ? [pos.cart[target]] : pos.cart.filter((l) => l.sel);
  const current = target === 'check' ? pos.checkDiscount : lines.length === 1 ? lines[0].discount : null;
  disc.type = current?.type || 'pct';
  $('#discount-value').value = current ? String(current.value).replace('.', ',') : '';
  const names = lines.map((l) => catalog.byId(l.productId).name);
  $('#discount-title').textContent = target === 'check' ? 'Скидка на весь чек' : names.length === 1 ? `Скидка: ${names[0]}` : `Скидка на ${names.length} ${plural(names.length, ['товар', 'товара', 'товаров'])}`;
  $('#discount-sub').textContent = target === 'check' ? 'Делится между всеми товарами чека' : names.length > 1 ? 'Проценты — каждому товару; сумма в сомах делится между ними по стоимости' : '';
  $('#discount-scope').hidden = typeof target === 'number';
  for (const b of $('#discount-scope').querySelectorAll('[data-target]')) {
    b.setAttribute('aria-pressed', String(b.dataset.target === (target === 'check' ? 'check' : 'lines')));
    if (b.dataset.target === 'lines') { b.disabled = !pos.cart.some((l) => l.sel); b.textContent = `Выбранные (${pos.cart.filter((l) => l.sel).length})`; }
  }
  const limit = session.user?.max_discount;
  $('#discount-limit').textContent = limit != null ? `Ваш предел — ${qtyFmt.format(limit)}% от чека` : '';
  renderDiscountTypes();
  $('#discount-dialog').showModal();
  $('#discount-value').focus();
}

function renderDiscountTypes() {
  const single = typeof disc.target === 'number';
  if (disc.type === 'price' && !single) disc.type = 'sum';
  for (const b of $('#discount-types').querySelectorAll('[data-type]')) {
    b.hidden = b.dataset.type === 'price' && !single;
    b.setAttribute('aria-pressed', String(b.dataset.type === disc.type));
  }
  $('#discount-value').placeholder = disc.type === 'pct' ? 'Например, 10' : disc.type === 'price' ? 'Новая цена за единицу' : 'Сумма скидки, сом';
}

function applyDiscount(value) {
  const d = value === null ? null : { type: disc.type, value };
  if (disc.target === 'check') pos.checkDiscount = d && d.type !== 'price' ? d : null;
  else {
    const lines = typeof disc.target === 'number' ? [pos.cart[disc.target]] : pos.cart.filter((l) => l.sel);
    if (d?.type === 'sum' && lines.length > 1) {
      // Сумма на группу делится пропорционально стоимости строк, остаток копеек — последней строке.
      const base = lines.reduce((s, l) => s + l.qty * l.price, 0);
      let left = d.value;
      lines.forEach((l, k) => {
        const part = k === lines.length - 1 ? r2(left) : r2(d.value * l.qty * l.price / base);
        left -= part;
        l.discount = { type: 'sum', value: part };
      });
    } else for (const l of lines) l.discount = d && { ...d };
    for (const l of pos.cart) l.sel = false;
  }
  $('#discount-dialog').close();
  renderCart();
}

$('#discount-open').addEventListener('click', () => openDiscount(pos.cart.some((l) => l.sel) ? 'lines' : 'check'));
$('#discount-select-all').addEventListener('click', () => {
  const all = pos.cart.every((l) => l.sel);
  for (const l of pos.cart) l.sel = !all;
  renderCart();
});
$('#discount-scope').addEventListener('click', (e) => {
  const b = e.target.closest('[data-target]');
  if (!b || b.disabled) return;
  disc.target = b.dataset.target;
  openDiscount(disc.target);
});
$('#discount-types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  disc.type = b.dataset.type;
  renderDiscountTypes();
  $('#discount-value').focus();
});
$('#discount-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseNum($('#discount-value').value);
  if (!(v >= 0) || (disc.type !== 'price' && !v)) return toast('Введите размер скидки', 'error');
  if (disc.type === 'pct' && v > 100) return toast('Скидка не может быть больше 100%', 'error');
  applyDiscount(v);
});
$('#discount-remove').addEventListener('click', () => applyDiscount(null));
$('#discount-cancel').addEventListener('click', () => $('#discount-dialog').close());

/* ---------- Способы оплаты ---------- */
const PAY_ICON = { cash: '💵', card: '💳', transfer: '🏦', qr: '📱', other: '•' };
const currentMethod = () => pos.methods.find((m) => m.id === pos.methodId);
const isCash = () => currentMethod()?.kind === 'cash';

async function loadPayMethods() {
  try { pos.methods = await api('/api/payment-methods?mine=1'); } catch { pos.methods = []; }
  if (!pos.methods.some((m) => m.id === pos.methodId)) pos.methodId = pos.methods[0]?.id ?? null;
}

// Части оплаты: введённые суммы и остаток на выбранный способ.
function payParts(paid) {
  if (!pos.split) return [{ method: currentMethod(), amount: paid }];
  const parts = pos.methods.map((m) => ({ method: m, amount: m.id === pos.methodId ? null : parseNum(pos.split[m.id] || '') || 0 }));
  const rest = r2(paid - parts.reduce((s, x) => s + (x.amount || 0), 0));
  for (const x of parts) if (x.amount === null) x.amount = rest;
  return parts;
}
// Сколько платят наличными; null — наличных в чеке нет.
function cashAmount(paid) {
  const cash = payParts(paid).filter((x) => x.method?.kind === 'cash' && x.amount > 0);
  return cash.length ? r2(cash.reduce((s, x) => s + x.amount, 0)) : null;
}
const fee = (m, amount) => (m?.commission ? r2(amount * m.commission / 100) : 0);

function renderPayMethods(paid = 0) {
  const el = $('#pay');
  el.classList.toggle('split', Boolean(pos.split));
  $('#split-toggle').hidden = pos.methods.length < 2;
  $('#split-toggle').textContent = pos.split ? 'Одним способом' : 'Разделить оплату';
  if (!pos.methods.length) {
    el.innerHTML = '<p class="neg">Вам не открыт ни один способ оплаты — обратитесь к администратору.</p>';
    return;
  }
  if (!pos.split) {
    const m = currentMethod();
    el.innerHTML = pos.methods.map((x) => `
      <button type="button" data-method="${x.id}" aria-pressed="${x.id === pos.methodId}"><span aria-hidden="true">${PAY_ICON[x.kind] || '•'}</span>${esc(x.name)}</button>`).join('');
    $('#pay-fee').hidden = !fee(m, paid);
    $('#pay-fee').innerHTML = `Комиссия ${esc(m?.name || '')} ${qtyFmt.format(m?.commission || 0)}%: <b class="num">−${money2(fee(m, paid))}</b> · к зачислению <b class="num">${money2(paid - fee(m, paid))}</b>`;
    return;
  }
  // Смешанная оплата: суммы вводятся во все поля, кроме одного — туда идёт остаток.
  const parts = payParts(paid);
  const active = document.activeElement?.dataset?.splitAmount;
  el.innerHTML = parts.map(({ method: m, amount }) => {
    const rest = m.id === pos.methodId;
    return `<div class="split-row ${rest ? 'rest' : ''}">
      <button type="button" data-method="${m.id}" aria-pressed="${rest}" title="Остаток чека — на этот способ"><span aria-hidden="true">${PAY_ICON[m.kind] || '•'}</span>${esc(m.name)}</button>
      ${rest ? `<b class="num split-rest ${amount < 0 ? 'neg' : ''}">${amount < 0 ? `перебор ${money2(-amount)}` : money2(amount)}<small>остаток</small></b>`
        : `<input class="input num" inputmode="decimal" placeholder="0" data-split-amount="${m.id}" value="${esc(pos.split[m.id] || '')}" aria-label="Сумма: ${esc(m.name)}">`}
      ${m.commission && amount > 0 ? `<span class="pick-meta split-fee">комиссия −${money2(fee(m, amount))}</span>` : ''}
    </div>`;
  }).join('');
  if (active) {
    const input = el.querySelector(`[data-split-amount="${active}"]`);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  const total = parts.reduce((s, x) => s + fee(x.method, Math.max(0, x.amount)), 0);
  $('#pay-fee').hidden = !total;
  $('#pay-fee').innerHTML = `Комиссия банков: <b class="num">−${money2(total)}</b> · к зачислению <b class="num">${money2(paid - total)}</b>`;
}

/* ---------- Покупатель и бонусы ---------- */
// Бонусами можно оплатить не больше заданного процента чека и не больше, чем есть у покупателя.
function bonusLimit() {
  if (!pos.customer) return 0;
  return Math.max(0, Math.min(pos.customer.bonus, Math.floor(cartTotal() * session.loyalty.maxPay / 100)));
}
const bonusSpend = () => Math.min(pos.spend, bonusLimit());
// Сколько списать с сертификата: не больше остатка на нём и не больше суммы чека после бонусов.
const certUse = () => (pos.cert ? Math.max(0, Math.min(pos.cert.amount, r2(cartTotal() - bonusSpend()))) : 0);
function renderCertUse() {
  const el = $('#cert-use');
  el.hidden = !pos.cert;
  if (!pos.cert) return;
  const use = certUse();
  el.innerHTML = `<span>🎁 Сертификат №${esc(pos.cert.number)}${pos.cert.customer_name ? ` · ${esc(pos.cert.customer_name)}` : ''}<small>на сертификате ${money2(pos.cert.balance)} · останется ${money2(r2(pos.cert.balance - use))}</small></span>
    <b class="num">−${money2(use)}</b><button type="button" class="icon-btn" id="cert-use-clear" aria-label="Убрать сертификат из оплаты">×</button>`;
}

function renderCustomer() {
  $('#customer-box').hidden = !session.loyalty.enabled && !session.can('customers.create');
  const c = pos.customer;
  $('#customer-find').hidden = Boolean(c);
  $('#customer-card').hidden = !c;
  if (!c) return;
  $('#customer-bday-row').hidden = !c.birthdayDiscount;
  if (c.birthdayDiscount) {
    const off = cartFull() - cartTotal();
    $('#customer-bday').checked = pos.birthday;
    $('#customer-bday-text').textContent = `🎂 ${c.birthdayIn === 0 ? 'Сегодня день рождения' : 'Скоро день рождения'} — скидка ${c.birthdayDiscount}%${off > 0 ? ` (−${money2(off)})` : ''}`;
  }
  renderCustomerCerts(c);
  $('#customer-title').textContent = c.name || phoneFmt(c.phone);
  $('#customer-meta').textContent = ` · ${c.name ? phoneFmt(c.phone) + ' · ' : ''}${c.card ? `карта ${c.card} · ` : ''}бонусов ${qtyFmt.format(c.bonus)}`;
  const limit = bonusLimit();
  $('#customer-spend-row').hidden = !c.bonus;
  $('#customer-spend-hint').textContent = limit ? `можно до ${qtyFmt.format(limit)}` : 'добавьте товары в чек';
  const earn = Math.floor((cartTotal() - bonusSpend()) * session.loyalty.percent / 100);
  if (pos.cart.length) $('#customer-meta').textContent += ` · за этот чек +${earn}`;
}

// Бонусы и сертификаты покупателя — вместе: его действующие сертификаты (общие для всех магазинов)
// показываются под бонусами, оплатить ими — одной кнопкой.
function renderCustomerCerts(c) {
  const box = $('#customer-certs');
  const list = pos.customerCerts?.id === c.id ? pos.customerCerts.list : [];
  box.hidden = !list.length;
  box.innerHTML = list.map((x) => {
    const used = pos.cert?.number === x.number;
    return `<div class="customer-cert-row"><span>🎁 Сертификат №${esc(x.number)} · <b>${money2(x.balance)}</b>${x.expires_at ? `<span class="pick-meta"> до ${new Date(x.expires_at).toLocaleDateString('ru-RU')}</span>` : ''}</span>
      ${used ? '<span class="pick-meta">✓ в оплате</span>' : `<button type="button" class="btn small" data-cust-cert="${esc(x.number)}">Оплатить</button>`}</div>`;
  }).join('');
}
async function loadCustomerCerts(c) {
  pos.customerCerts = { id: c.id, list: [] };
  if (!session.can('certificates.accept')) return;
  try {
    const list = await api(`/api/customers/${c.id}/certificates`);
    if (pos.customer?.id === c.id) { pos.customerCerts = { id: c.id, list }; renderCart(); }
  } catch { /* без сертификатов */ }
}
$('#customer-certs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cust-cert]');
  if (!b) return;
  const x = pos.customerCerts.list.find((y) => y.number === b.dataset.custCert);
  if (!x) return;
  pos.cert = { number: x.number, amount: x.balance, balance: x.balance, customer_name: pos.customer?.name || '' };
  renderCart();
});

// Поиск покупателя: телефон, ФИО или номер карты (сканер карты вводит 8 цифр и Enter).
let custFound = [];
function pickCustomer(c) {
  loadCustomerCerts(c);
  pos.customer = c;
  pos.spend = 0;
  $('#customer-spend').value = '';
  $('#customer-results').hidden = true;
  renderCart();
}
function renderCustomerResults(list, q) {
  custFound = list;
  const canAdd = session.can('customers.create');
  $('#customer-results').innerHTML = list.map((c, i) => `<button type="button" class="suggest" data-cust="${i}">
      <span><b>${esc(c.name || phoneFmt(c.phone))}</b><span class="pick-meta"> ${c.name ? phoneFmt(c.phone) : ''}${c.card ? ` · карта ${c.card}` : ''}</span></span>
      <span class="pick-meta">бонусов ${qtyFmt.format(c.bonus)}</span></button>`).join('')
    + (!list.length ? `<div class="suggest muted">Никого не нашли</div>` : '')
    + (canAdd ? `<button type="button" class="suggest new" data-cust-new>+ Новый клиент${q ? `: ${esc(q)}` : ''}</button>` : '');
  $('#customer-results').hidden = false;
}
let custTimer = null;
async function lookupCustomer({ enter = false } = {}) {
  const q = $('#customer-phone').value.trim();
  if (!q) { $('#customer-results').hidden = true; return; }
  try {
    const list = await api('/api/customers/search?q=' + encodeURIComponent(q));
    if (q !== $('#customer-phone').value.trim()) return;
    const digits = q.replace(/\D/g, '');
    const exact = list.find((c) => c.card === digits || c.phone.endsWith(digits.slice(-9)) && digits.length >= 9);
    // Отсканированная карта или полный телефон — сразу в чек.
    if (enter && (exact || list.length === 1)) return pickCustomer(exact || list[0]);
    renderCustomerResults(list, q);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function clearCustomer() {
  pos.customer = null;
  pos.spend = 0;
  pos.birthday = true;
  $('#customer-phone').value = '';
  $('#customer-spend').value = '';
  $('#customer-results').hidden = true;
}

$('#customer-lookup').addEventListener('click', () => lookupCustomer({ enter: true }));
$('#customer-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(custTimer); lookupCustomer({ enter: true }); } });
$('#customer-phone').addEventListener('input', () => { clearTimeout(custTimer); custTimer = setTimeout(lookupCustomer, 250); });
$('#customer-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cust]');
  if (b) return pickCustomer(custFound[Number(b.dataset.cust)]);
  if (e.target.closest('[data-cust-new]')) openCustomerDialog($('#customer-phone').value.trim());
});
document.addEventListener('click', (e) => { if (!e.target.closest('#customer-find')) $('#customer-results').hidden = true; });

/* ---------- Новый клиент: ФИО, телефон, карта, дата рождения, пол ---------- */
let custGender = '';
let custOnSaved = null; // куда отдать нового клиента (окно сертификата) вместо чека
function openCustomerDialog(q = '') {
  const f = $('#cust-form');
  f.reset();
  custGender = '';
  for (const b of document.querySelectorAll('#cu-gender [data-g]')) b.setAttribute('aria-pressed', 'false');
  // Что ввели в поиск — в нужное поле: цифры 8 — карта, другие цифры — телефон, буквы — ФИО.
  const digits = q.replace(/\D/g, '');
  if (q && digits.length === q.replace(/[\s()+-]/g, '').length) {
    if (digits.length === 8 && !digits.startsWith('0')) f.elements.card.value = digits; else f.elements.phone.value = q;
  } else if (q) f.elements.name.value = capitalizeWords(q);
  $('#cust-error').hidden = true;
  $('#customer-results').hidden = true;
  $('#cust-dialog').showModal();
  (f.elements.name.value ? f.elements.phone : f.elements.name).focus();
}
$('#customer-add').addEventListener('click', () => openCustomerDialog($('#customer-phone').value.trim()));
$('#cust-cancel').addEventListener('click', () => { custOnSaved = null; $('#cust-dialog').close(); });
$('#cu-gender').addEventListener('click', (e) => {
  const b = e.target.closest('[data-g]');
  if (!b) return;
  custGender = custGender === b.dataset.g ? '' : b.dataset.g;
  for (const x of document.querySelectorAll('#cu-gender [data-g]')) x.setAttribute('aria-pressed', String(x.dataset.g === custGender));
});
$('#cu-card-new').addEventListener('click', async () => {
  try { $('#cu-card').value = (await api('/api/customers/new-card')).card; } catch (err) { showFormError('#cust-error', err); }
});
$('#cu-card').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8); });
// Дата: точки ставятся сами — 15031990 → 15.03.1990.
$('#cu-bday').addEventListener('input', (e) => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 8);
  e.target.value = [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('.');
});
$('#cust-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.elements.phone.value.trim()) return showFormError('#cust-error', new Error('Укажите номер телефона'));
  try {
    const c = await api('/api/customers', { method: 'POST', body: { name: f.elements.name.value, phone: f.elements.phone.value, card: f.elements.card.value, birthday: f.elements.birthday.value, gender: custGender } });
    $('#cust-dialog').close();
    toast(`Клиент заведён, карта ${c.card}`);
    // Клиента заводили из окна сертификата — он становится покупателем сертификата, а не чека.
    if (custOnSaved) { const fn = custOnSaved; custOnSaved = null; return fn(c); }
    $('#customer-phone').value = '';
    pickCustomer(c);
  } catch (err) {
    showFormError('#cust-error', err);
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
  else pos.cart.push({ productId: p.id, qty: amount, price: salePrice(p) });
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
const leftOf = (k) => (k.stock === null ? Infinity : k.stock) - (pos.cart.find((l) => l.productId === k.id)?.qty || 0);
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
        const title = !alt ? 'Такого сочетания нет' : stock <= 0 ? 'Нет на складе' : stock === Infinity ? '' : `Осталось ${qtyFmt.format(stock)}`;
        return `<button type="button" data-opt="${esc(name)}" data-val="${esc(v)}" aria-pressed="${picker.sel[name] === v}" class="${!alt ? 'none' : stock <= 0 ? 'out' : ''}" title="${title}">${esc(v)}</button>`;
      }).join('')}</div>
    </div>`;
  }).join('');
  const k = matchVariant(base, picker.sel);
  const left = k ? leftOf(k) : 0;
  $('#variant-result').innerHTML = k ? `
    <div><b>${esc(optionsText(k))}</b><div class="pick-meta">${esc(k.barcode || k.code || '')}</div></div>
    <div class="variant-price num">${money2(salePrice(k))}</div>
    ${left === Infinity ? '' : `<div class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе — продажа уйдёт в минус' : 'осталось ' + qty(left, k.unit)}</div>`}`
    : '<p class="pick-meta">Такого сочетания нет — выберите другое</p>';
  $('#variant-qty input').value = qtyFmt.format(picker.qty);
  $('#variant-add').disabled = !k;
  $('#variant-add').textContent = k ? `Добавить в чек · ${money2(salePrice(k) * picker.qty)}` : 'Добавить в чек';
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
  if (e.target.closest('[data-sel]')) { l.sel = e.target.checked; return renderCart(); }
  if (e.target.closest('.cart-name') && session.can('discount')) return openDiscount(Number(line.dataset.i));
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
  if (!line || e.target.tagName !== 'INPUT' || e.target.dataset.sel !== undefined) return;
  const value = parseNum(e.target.value);
  if (value > 0) pos.cart[Number(line.dataset.i)].qty = value;
  else pos.cart.splice(Number(line.dataset.i), 1);
  renderCart();
  renderPick();
});
$('#pay').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-method]');
  if (!btn) return;
  if (pos.split) delete pos.split[btn.dataset.method];
  pos.methodId = Number(btn.dataset.method);
  renderCart();
  if (!pos.split && isCash()) $('#cash-given').focus();
});
$('#pay').addEventListener('input', (e) => {
  const id = e.target.dataset.splitAmount;
  if (!id) return;
  pos.split[id] = e.target.value;
  renderCart();
});
$('#split-toggle').addEventListener('click', () => {
  pos.split = pos.split ? null : {};
  renderCart();
  if (pos.split) $('#pay').querySelector('[data-split-amount]')?.focus();
});
$('#cash-given').addEventListener('input', renderCart);
$('#cart-clear').addEventListener('click', () => { resetCheck(); renderCart(); renderPick(); });

function resetCheck() {
  pos.cart = [];
  pos.cert = null;
  pos.checkDiscount = null;
  pos.split = null;
  $('#cash-given').value = '';
  clearCustomer();
}

$('#checkout').addEventListener('click', async () => {
  const paid = r2(cartTotal() - bonusSpend() - certUse());
  if (!currentMethod()) return toast('Выберите способ оплаты', 'error');
  const parts = payParts(paid);
  if (pos.split && parts.some((x) => x.amount < 0)) return toast('Суммы частей больше суммы чека', 'error');
  const cash = cashAmount(paid);
  if (cash !== null && $('#cash-given').value && parseNum($('#cash-given').value) < cash) {
    return toast('Получено меньше, чем нужно наличными', 'error');
  }
  pos.busy = true;
  renderCart();
  try {
    const sale = await api('/api/sales', {
      method: 'POST',
      body: {
        methodId: pos.methodId,
        // Остаток (способ pos.methodId) уходит без суммы — его досчитает сервер.
        payments: pos.split ? parts.filter((x) => x.method.id === pos.methodId || x.amount > 0).map((x) => ({ methodId: x.method.id, amount: x.method.id === pos.methodId ? null : x.amount })) : undefined,
        items: pos.cart.map((l) => ({ productId: l.productId, qty: l.qty, discount: l.discount || undefined })),
        checkDiscount: pos.checkDiscount || undefined,
        customerId: pos.customer?.id, bonusSpend: bonusSpend(), birthday: birthdayRate() > 0,
        certificate: pos.cert ? { number: pos.cert.number, amount: certUse() } : undefined,
      },
    });
    const how = sale.payments.length > 1 ? sale.payments.map((x) => `${x.name} ${money2(x.amount)}`).join(' + ') : sale.method;
    toast(`Чек №${sale.id} на ${money2(sale.total)} (${how}) пробит${sale.discount ? `, скидка ${money2(sale.discount)}` : ''}${sale.bonusEarned ? `, начислено ${sale.bonusEarned} бонусов` : ''}${sale.certificate ? `. На сертификате осталось ${money2(sale.certificate.balance)}` : ''}`);
    loadShift();
    resetCheck();
    afterSalePrint(sale.id);
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

/* ---------- Печать чека покупателю (шаблон — «Чеки и этикетки») ---------- */
async function afterSalePrint(saleId) {
  pos.lastSale = saleId;
  const btn = $('#cart-print');
  btn.hidden = false;
  btn.textContent = `🖨️ Печать чека №${saleId}`;
  let mode = 'off';
  try { mode = (await printDesigns()).receipt.autoPrint; } catch { /* шаблон не загрузился — только кнопка */ }
  btn.classList.toggle('primary', mode === 'ask');
  if (mode === 'always') printReceipt(saleId);
  if (mode === 'ask') toast(`Чек №${saleId}: нажмите «🖨️ Печать чека», если покупателю нужен чек`);
}
$('#cart-print').addEventListener('click', () => {
  if (!pos.lastSale) return;
  $('#cart-print').classList.remove('primary');
  printReceipt(pos.lastSale);
});

/* ---------- Смена ---------- */
async function loadShift() {
  if (!session.user) return;
  try {
    [pos.shift, pos.registers] = await Promise.all([api('/api/shift'), api('/api/registers')]);
  } catch {
    return;
  }
  const sh = pos.shift;
  // Касса запоминается в этом браузере: на одном компьютере обычно одна и та же касса.
  let saved = null;
  try { saved = Number(localStorage.getItem('kassa.register')) || null; } catch {}
  const regs = pos.registers;
  const bar = $('#shift-bar');
  bar.hidden = false;
  bar.className = 'shift-bar ' + (sh ? 'open' : 'closed');
  bar.innerHTML = sh
    ? `<span>${sh.register_name ? `<b>${esc(sh.register_name)}</b> · ` : ''}Смена открыта с <b>${new Date(sh.opened_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</b> · ${int(sh.receipts)} ${plural(sh.receipts, ['чек', 'чека', 'чеков'])} на <b>${money2(sh.revenue)}</b>${sh.byMethod.length ? ' · ' + sh.byMethod.map((m) => `${esc(m.name)} <b>${money2(m.sum)}</b>${m.commission ? ` <small>(комиссия −${money2(m.commission)})</small>` : ''}`).join(', ') : ''}</span>
       <button type="button" class="btn small" id="shift-close">Закрыть смену</button>`
    : `<span>Смена не открыта. Откройте её в начале рабочего дня — по сменам считается зарплата.</span>
       <span class="shift-actions"><button type="button" class="btn small primary" id="shift-open">Открыть смену</button></span>`;
  pos.savedRegister = saved;
}

/* Открытие: кассир пересчитывает наличные. Не сходится с тем, что оставили при закрытии, — ошибка с разницей;
   открыть можно, только пересчитав или написав причину (её увидит владелец). */
const moneyNum = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
function mismatchHtml(m, when) {
  return `${m.diff < 0 ? 'Не хватает' : 'Лишние'} <b>${money2(Math.abs(m.diff))}</b><br>
    ${when === 'open' ? 'При закрытии оставили' : 'По программе должно быть'} ${money2(m.expected)}, вы насчитали ${money2(m.counted)}.<br>
    Пересчитайте деньги ещё раз. Если сумма верная — напишите причину.`;
}
function resetCashForm(prefix) {
  for (const id of ['mismatch', 'note-row', 'error']) $(`#${prefix}-${id}`).hidden = true;
  $(`#${prefix}-note`).value = '';
  $(`#${prefix}-submit`).classList.remove('danger');
}
async function openShiftCashDialog() {
  let info = { busyRegisters: [] };
  try { info = await api('/api/shift/info'); } catch {}
  pos.shiftInfo = info;
  const regs = pos.registers || [];
  $('#so-register-row').hidden = regs.length < 2;
  $('#so-register').innerHTML = regs.map((r) => `<option value="${r.id}" ${r.id === pos.savedRegister ? 'selected' : ''}>${esc(r.name)}${info.busyRegisters.includes(r.id) ? ' — уже открыта' : ''}</option>`).join('');
  $('#so-cash').value = '';
  resetCashForm('so');
  $('#so-submit').textContent = 'Открыть смену';
  syncOpenBusy();
  $('#shift-open-dialog').showModal();
  if (!$('#so-cash-row').hidden) $('#so-cash').focus();
}
function syncOpenBusy() {
  const reg = Number($('#so-register').value) || pos.registers?.[0]?.id;
  const busy = (pos.shiftInfo?.busyRegisters || []).includes(reg);
  $('#so-cash-row').hidden = busy;
  $('#so-busy').hidden = !busy;
}
$('#so-register').addEventListener('change', () => { resetCashForm('so'); syncOpenBusy(); });
$('#so-cash').addEventListener('input', () => { if (!$('#so-mismatch').hidden) { resetCashForm('so'); $('#so-submit').textContent = 'Открыть смену'; } });
$('#so-cancel').addEventListener('click', () => $('#shift-open-dialog').close());
$('#so-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const registerId = Number($('#so-register').value) || null;
  const busy = !$('#so-busy').hidden;
  if (!busy && $('#so-cash').value.trim() === '') return showFormError('#so-error', new Error('Пересчитайте наличные и введите сумму (если денег нет — 0)'));
  try {
    if (registerId) try { localStorage.setItem('kassa.register', registerId); } catch {}
    const sh = await api('/api/shift/open', { method: 'POST', body: { register_id: registerId, cash: busy ? undefined : moneyNum($('#so-cash').value), note: $('#so-note').value } });
    $('#shift-open-dialog').close();
    toast(`Смена открыта${sh.register_name ? ` на «${sh.register_name}»` : ''}${sh.open_diff ? ` с расхождением ${money2(sh.open_diff)} — владелец увидит причину` : ''}. Хорошей работы!`);
    loadShift();
  } catch (err) {
    if (err.data?.cashMismatch) {
      $('#so-error').hidden = true;
      $('#so-mismatch').innerHTML = mismatchHtml(err.data.cashMismatch, 'open');
      $('#so-mismatch').hidden = false;
      $('#so-note-row').hidden = false;
      $('#so-submit').textContent = 'Открыть с расхождением';
      $('#so-submit').classList.add('danger');
      return $('#so-note').focus();
    }
    showFormError('#so-error', err);
  }
});

/* Закрытие: насчитано = сдано на счёт + оставлено в кассе. Насчитанное сверяется с программой. */
async function closeShiftCashDialog() {
  let info = { accounts: [] };
  try { info = await api('/api/shift/info'); } catch {}
  const sh = pos.shift;
  $('#sc-summary').textContent = `${int(sh.receipts)} ${plural(sh.receipts, ['чек', 'чека', 'чеков'])} на ${money2(sh.revenue)}${sh.byMethod.length ? ' · ' + sh.byMethod.map((m) => `${m.name} ${money2(m.sum)}`).join(', ') : ''}`;
  $('#sc-count').hidden = info.sharedDrawer;
  $('#sc-busy').hidden = !info.sharedDrawer;
  $('#sc-account').innerHTML = info.accounts.length ? info.accounts.map((a) => `<option value="${a.id}" ${a.id === info.defaultDeposit ? 'selected' : ''}>${esc(a.name)}</option>`).join('') : '<option value="">Нет безналичных счетов</option>';
  for (const id of ['#sc-counted', '#sc-deposited', '#sc-left']) $(id).value = '';
  $('#sc-left').dataset.touched = '';
  $('#sc-left-hint').textContent = '';
  resetCashForm('sc');
  $('#sc-submit').textContent = 'Закрыть смену';
  $('#shift-close-dialog').showModal();
  if (!info.sharedDrawer) $('#sc-counted').focus();
}
// «Оставляю» подставляется само: насчитано − сдано (можно поправить вручную).
function syncLeft() {
  const c = moneyNum($('#sc-counted').value) || 0;
  const d = moneyNum($('#sc-deposited').value) || 0;
  if (!$('#sc-left').dataset.touched) $('#sc-left').value = $('#sc-counted').value.trim() ? String(Math.round((c - d) * 100) / 100) : '';
  const l = moneyNum($('#sc-left').value) || 0;
  const off = Math.round((c - d - l) * 100) / 100;
  $('#sc-left-hint').textContent = off ? `Не сходится: ${money2(c)} − ${money2(d)} − ${money2(l)} = ${money2(off)}` : '';
  $('#sc-left-hint').className = off ? 'neg' : 'pick-meta';
}
$('#sc-counted').addEventListener('input', () => { if (!$('#sc-mismatch').hidden) { resetCashForm('sc'); $('#sc-submit').textContent = 'Закрыть смену'; } syncLeft(); });
$('#sc-deposited').addEventListener('input', syncLeft);
$('#sc-left').addEventListener('input', () => { $('#sc-left').dataset.touched = '1'; syncLeft(); });
$('#sc-cancel').addEventListener('click', () => $('#shift-close-dialog').close());
$('#sc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shared = !$('#sc-busy').hidden;
  if (!shared && $('#sc-counted').value.trim() === '') return showFormError('#sc-error', new Error('Пересчитайте наличные и введите сумму'));
  try {
    const body = shared ? {} : { counted: moneyNum($('#sc-counted').value), deposited: moneyNum($('#sc-deposited').value) || 0,
      depositMethodId: Number($('#sc-account').value) || null, left: moneyNum($('#sc-left').value) || 0, note: $('#sc-note').value };
    const sh = await api('/api/shift/close', { method: 'POST', body });
    $('#shift-close-dialog').close();
    toast(`Смена закрыта: ${sh.receipts} ${plural(sh.receipts, ['чек', 'чека', 'чеков'])} на ${money2(sh.revenue)}`
      + (sh.close_counted !== null && sh.close_counted !== undefined ? `. Сдано ${money2(sh.deposited || 0)}, в кассе оставлено ${money2(sh.left_cash)}` : '')
      + (sh.close_diff ? `. Расхождение ${money2(sh.close_diff)} — владелец увидит причину` : ''));
    loadShift();
  } catch (err) {
    if (err.data?.cashMismatch) {
      $('#sc-error').hidden = true;
      $('#sc-mismatch').innerHTML = mismatchHtml(err.data.cashMismatch, 'close');
      $('#sc-mismatch').hidden = false;
      $('#sc-note-row').hidden = false;
      $('#sc-submit').textContent = 'Закрыть с расхождением';
      $('#sc-submit').classList.add('danger');
      return $('#sc-note').focus();
    }
    showFormError('#sc-error', err);
  }
});

$('#shift-bar').addEventListener('click', (e) => {
  if (e.target.closest('#shift-open')) return openShiftCashDialog();
  if (e.target.closest('#shift-close')) return closeShiftCashDialog();
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

/* ---------- Смена кассира ---------- */
// Два кассира на одной кассе: выбрать себя и ввести PIN (или пароль, если PIN не задан).
// Чек, который собирали, не теряется — он переходит к новому кассиру.
const CART_KEY = 'kassa.cart';
const sw = { users: [], user: null };

async function openSwitch() {
  try { sw.users = await api('/api/kassa/users'); } catch (err) { return toast(err.message, 'error'); }
  sw.user = null;
  renderSwitchUsers();
  $('#switch-dialog').showModal();
}

function renderSwitchUsers() {
  $('#switch-form').hidden = true;
  $('#switch-users').hidden = false;
  $('#switch-users').innerHTML = sw.users.map((u) => `
    <button type="button" class="switch-user ${u.id === session.user?.id ? 'current' : ''}" data-user="${u.id}" ${u.id === session.user?.id ? 'disabled' : ''}>
      <span class="avatar" aria-hidden="true">${esc((u.name || '?').trim()[0].toUpperCase())}</span>
      <b>${esc(u.name)}</b><span class="pick-meta">${u.id === session.user?.id ? 'сейчас на кассе' : esc(session.roleName(u.role))}</span>
    </button>`).join('') || '<p class="empty">Других кассиров нет</p>';
}

function pickSwitchUser(id) {
  sw.user = sw.users.find((u) => u.id === id);
  $('#switch-users').hidden = true;
  $('#switch-form').hidden = false;
  $('#switch-who').innerHTML = `<span class="avatar" aria-hidden="true">${esc(sw.user.name.trim()[0].toUpperCase())}</span><b>${esc(sw.user.name)}</b>`;
  const code = $('#switch-code');
  code.value = '';
  // С PIN — цифровая клавиатура; без PIN — обычный пароль.
  code.inputMode = sw.user.hasPin ? 'numeric' : 'text';
  code.placeholder = sw.user.hasPin ? 'PIN-код' : 'Пароль';
  $('#pin-pad').hidden = !sw.user.hasPin;
  $('#switch-hint').textContent = sw.user.hasPin ? '' : 'PIN-код не задан — введите пароль. Задать PIN: нажмите на своё имя вверху → «PIN-код».';
  $('#switch-error').hidden = true;
  code.focus();
}

$('#switch-user').addEventListener('click', openSwitch);
$('#switch-close').addEventListener('click', () => $('#switch-dialog').close());
$('#switch-back').addEventListener('click', renderSwitchUsers);
$('#switch-users').addEventListener('click', (e) => {
  const b = e.target.closest('[data-user]');
  if (b && !b.disabled) pickSwitchUser(Number(b.dataset.user));
});
$('#pin-pad').addEventListener('click', (e) => {
  const k = e.target.closest('[data-key]')?.dataset.key;
  if (!k) return;
  const code = $('#switch-code');
  code.value = k === 'clear' ? '' : k === 'back' ? code.value.slice(0, -1) : (code.value + k).slice(0, 6);
  // Шесть цифр — входим сразу, без кнопки.
  if (code.value.length === 6) $('#switch-form').requestSubmit();
});
$('#switch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#switch-code').value;
  if (!code) return;
  try {
    const res = await fetch('/api/switch-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: sw.user.id, code }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не получилось сменить кассира');
    try { sessionStorage.setItem(CART_KEY, JSON.stringify({ cart: pos.cart })); } catch {}
    location.reload();
  } catch (err) {
    $('#switch-code').value = '';
    showFormError('#switch-error', err);
  }
});

// Чек, оставшийся от предыдущего кассира.
function restoreCart() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(CART_KEY) || 'null'); sessionStorage.removeItem(CART_KEY); } catch {}
  if (!saved?.cart?.length) return;
  pos.cart = saved.cart.filter((l) => catalog.byId(l.productId));
  if (pos.cart.length) toast(`Чек предыдущего кассира перенесён: ${pos.cart.length} ${plural(pos.cart.length, ['позиция', 'позиции', 'позиций'])}`);
}

views.pos = {
  async show() {
    try { await Promise.all([catalog.load(), loadPosCats(), loadPayMethods()]); } catch (err) { toast(err.message, 'error'); }
    if (!pos.restored) { pos.restored = true; restoreCart(); }
    renderPick();
    renderCart();
    loadShift();
    $('#pos-search').focus();
  },
  right: 'pos',
};
