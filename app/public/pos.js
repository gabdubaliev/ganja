'use strict';

// Касса: подбор товаров в чек и продажа.

const pos = {
  cart: [],          // { productId, qty, price }
  payment: 'card',
  busy: false,
  customer: null,    // покупатель из программы лояльности
  spend: 0,          // сколько бонусов списать
};

function renderPick() {
  const q = $('#pos-search').value;
  const list = q.trim() ? catalog.search(q, 40) : catalog.list;
  $('#pos-results').innerHTML = list.length ? list.map((p) => {
    const inCart = pos.cart.find((l) => l.productId === p.id)?.qty || 0;
    const left = p.stock - inCart;
    const photo = photoUrl(p);
    return `<button type="button" class="pick ${left <= 0 ? 'out' : ''} ${photo ? 'has-photo' : ''}" data-id="${p.id}">
      ${photo ? `<img class="pick-photo" src="${photo}" alt="" loading="lazy">` : ''}
      <span class="pick-name">${esc(p.name)}</span>
      <span class="pick-price num">${money2(p.price)}</span>
      <span class="pick-meta">${esc([p.code, p.category].filter(Boolean).join(' · ') || 'Без категории')}</span>
      <span class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе' : 'осталось ' + qty(left, p.unit)}</span>
    </button>`;
  }).join('') : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет. Их добавляет администратор или кладовщик.'}</p>`;
}

function cartTotal() {
  return Math.round(pos.cart.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
}

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
  $('#cart-total').textContent = money2(total);
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
  $('#customer-title').textContent = c.name || phoneText(c.phone);
  $('#customer-meta').textContent = ` · ${c.name ? phoneText(c.phone) + ' · ' : ''}бонусов ${qtyFmt.format(c.bonus)}`;
  const limit = bonusLimit();
  $('#customer-spend-row').hidden = !c.bonus;
  $('#customer-spend-hint').textContent = limit ? `можно до ${qtyFmt.format(limit)}` : 'добавьте товары в чек';
  const earn = Math.floor((cartTotal() - bonusSpend()) * session.loyalty.percent / 100);
  if (pos.cart.length) $('#customer-meta').textContent += ` · за этот чек +${earn}`;
}

const phoneText = (p) => (p.length === 11 && p[0] === '7' ? `+7 ${p.slice(1, 4)} ${p.slice(4, 7)}-${p.slice(7, 9)}-${p.slice(9)}` : '+' + p);

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
  $('#customer-phone').value = '';
  $('#customer-spend').value = '';
  $('#customer-new').hidden = true;
}

$('#customer-lookup').addEventListener('click', lookupCustomer);
$('#customer-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupCustomer(); } });
$('#customer-create').addEventListener('click', async () => {
  try {
    pos.customer = await api('/api/customers', { method: 'POST', body: { phone: $('#customer-phone').value, name: $('#customer-new-name').value } });
    $('#customer-new').hidden = true;
    $('#customer-new-name').value = '';
    toast('Карта покупателя заведена');
    renderCart();
  } catch (err) {
    toast(err.message, 'error');
  }
});
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
  if (btn) addToCart(Number(btn.dataset.id));
});
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
      body: { payment: pos.payment, items: pos.cart, customerId: pos.customer?.id, bonusSpend: bonusSpend() },
    });
    toast(`Чек №${sale.id} на ${money2(sale.total)} пробит${sale.bonusEarned ? `, начислено ${sale.bonusEarned} бонусов` : ''}`);
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

views.pos = {
  async show() {
    try { await catalog.load(); } catch (err) { toast(err.message, 'error'); }
    renderPick();
    renderCart();
    $('#pos-search').focus();
  },
  right: 'pos',
};
