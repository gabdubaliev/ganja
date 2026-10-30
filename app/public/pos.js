'use strict';

// Касса: подбор товаров в чек и продажа.

const pos = {
  cart: [],          // { productId, qty, price }
  payment: 'card',
  busy: false,
};

function renderPick() {
  const q = $('#pos-search').value;
  const list = q.trim() ? catalog.search(q, 40) : catalog.list;
  $('#pos-results').innerHTML = list.length ? list.map((p) => {
    const inCart = pos.cart.find((l) => l.productId === p.id)?.qty || 0;
    const left = p.stock - inCart;
    return `<button type="button" class="pick" data-id="${p.id}" ${left <= 0 ? 'disabled' : ''}>
      <span class="pick-name">${esc(p.name)}</span>
      <span class="pick-price num">${money2(p.price)}</span>
      <span class="pick-meta">${esc(p.category || 'Без категории')}</span>
      <span class="pick-stock num ${left <= 0 ? 'neg' : ''}">${left <= 0 ? 'нет на складе' : 'осталось ' + qty(left, p.unit)}</span>
    </button>`;
  }).join('') : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет. Добавьте их в разделе <a href="#products">«Товары»</a>.'}</p>`;
}

function cartTotal() {
  return Math.round(pos.cart.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
}

function renderCart() {
  $('#cart').innerHTML = pos.cart.length ? pos.cart.map((l, i) => {
    const p = catalog.byId(l.productId);
    const over = l.qty > p.stock;
    return `<div class="cart-line" data-i="${i}">
      <div class="cart-name">${esc(p.name)}<span class="pick-meta num">${money2(l.price)} за ${esc(p.unit)}</span>${over ? `<span class="neg">На складе только ${qty(p.stock, p.unit)}</span>` : ''}</div>
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
  $('#cart-total').textContent = money2(total);
  $('#checkout').disabled = !pos.cart.length || pos.busy;
  $('#cart-clear').hidden = !pos.cart.length;
  for (const b of document.querySelectorAll('#pay [data-pay]')) b.setAttribute('aria-pressed', b.dataset.pay === pos.payment);
  $('#cash-row').hidden = pos.payment !== 'cash';
  const given = parseNum($('#cash-given').value);
  $('#change').textContent = pos.payment === 'cash' && given > 0
    ? (given >= total ? `Сдача: ${money2(given - total)}` : `Не хватает ${money2(total - given)}`)
    : '';
}

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
  if (found.length === 1 || (found.length && found[0].barcode === e.target.value.trim())) {
    addToCart(found[0].id);
    e.target.value = '';
    renderPick();
  } else if (!found.length) {
    toast('Товар не найден', 'error');
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
$('#cart-clear').addEventListener('click', () => { pos.cart = []; $('#cash-given').value = ''; renderCart(); renderPick(); });

$('#checkout').addEventListener('click', async () => {
  const total = cartTotal();
  if (pos.payment === 'cash' && $('#cash-given').value && parseNum($('#cash-given').value) < total) {
    return toast('Получено меньше, чем сумма чека', 'error');
  }
  pos.busy = true;
  renderCart();
  try {
    const sale = await api('/api/sales', { method: 'POST', body: { payment: pos.payment, items: pos.cart } });
    toast(`Чек №${sale.id} на ${money2(sale.total)} пробит`);
    pos.cart = [];
    $('#cash-given').value = '';
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
};
