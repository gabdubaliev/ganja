'use strict';

// Заказы с интернет-витрины: подтвердить, собрать, выдать (пробивается чек) или отменить.

// Предоплата переводом: «Ждёт оплату» → покупатель нажал «Я оплатил» → «Проверить оплату» →
// сотрудник сверил поступление → «Оплачен — упаковать» → «Упакован» → «У курьера» → «Доставлен» (пробивается чек).
const ORDER_STATUS = {
  active: 'Активные',
  checking: 'Проверить оплату',
  unpaid: 'Ждут оплату',
  new: 'Новые',
  confirmed: 'Подтверждены, оплачены',
  ready: 'Собраны',
  shipped: 'У курьера',
  done: 'Выданы',
  cancelled: 'Отменены',
};
const ORDER_ONE = { unpaid: 'Ждёт оплату', checking: 'Проверить оплату', new: 'Новый', confirmed: 'Подтверждён', ready: 'Собран', shipped: 'Передан курьеру', done: 'Выдан', cancelled: 'Отменён' };
const orderOne = (o) => (o.pay_id ? { confirmed: 'Оплачен — упаковать', ready: 'Упакован', done: 'Доставлен' }[o.status] : null) || ORDER_ONE[o.status] || o.status;
// Доставку после сборки передают курьеру, самовывоз сразу выдают.
const orderNext = (o) => ({ new: 'confirmed', confirmed: 'ready', ready: o.delivery === 'delivery' ? 'shipped' : 'done', shipped: 'done' })[o.status];
const orderNextLabel = (o, next) => (o.pay_id ? { ready: 'Упакован', done: 'Доставлен — пробить чек' }[next] : null)
  || { confirmed: 'Подтвердить', ready: 'Собран', shipped: 'Передать курьеру', done: 'Выдать и пробить чек' }[next];
const ordersView = { status: 'active', list: [], confirmCancel: null, methods: [] };

// Кнопки заказа: сверка оплаты, следующий шаг, выдача (способ оплаты — сам, если перевод уже пришёл на известный счёт).
function orderActions(o) {
  if (o.status === 'checking' || o.status === 'unpaid') {
    if (!session.can('orders.payment')) return '<span class="pick-meta">Оплату подтверждает сотрудник с правом «Подтверждать оплату заказов»</span>';
    return `<button type="button" class="btn small primary" data-order="${o.id}" data-to="confirmed">✓ Оплата поступила</button>
      ${o.status === 'checking' ? `<button type="button" class="btn small" data-order="${o.id}" data-to="unpaid">Оплата не найдена</button>` : ''}`;
  }
  const next = orderNext(o);
  if (next !== 'done') return `<button type="button" class="btn small primary" data-order="${o.id}" data-to="${next}">${orderNextLabel(o, next)}</button>`;
  if (o.pay_id && o.pay_method_id) return `<button type="button" class="btn small primary" data-order="${o.id}" data-to="done">${orderNextLabel(o, next)}</button>`;
  return ordersView.methods.length ? `<span class="pick-meta">${o.pay_id ? 'Доставлен, деньги пришли на:' : 'Выдать, оплата:'}</span>` + ordersView.methods.map((m, i) => `
    <button type="button" class="btn small ${i === 0 ? 'primary' : ''}" data-order="${o.id}" data-to="done" data-method="${m.id}">${esc(m.name)}</button>`).join('')
    : '<span class="neg">Нет доступных способов оплаты</span>';
}
const orderPayLine = (o) => (o.pay_id ? `<div class="order-pay">💳 ${esc(o.pay_name)}${o.paid_at ? ` · <b class="pos">оплата подтверждена</b> ${dateTime(o.paid_at)}${o.paid_by ? `, ${esc(o.paid_by)}` : ''}`
  : o.status === 'checking' ? ` · покупатель нажал «Я оплатил» ${o.paid_claimed_at ? dateTime(o.paid_claimed_at) : ''} — <b>сверьте поступление ${money2(o.total)}</b>` : ' · <span class="neg">оплата не получена</span>'}</div>
  ${orderReceipts(o)}` : '');
// Чеки об оплате от покупателя: миниатюра открывает чек целиком.
const orderReceipts = (o) => (o.receipts?.length ? `<div class="order-receipts">${o.receipts.map((r) => {
  const url = `/api/orders/${o.id}/receipts/${r.id}`;
  return r.mime === 'application/pdf'
    ? `<a class="btn small" href="${url}" target="_blank" rel="noopener">📄 Чек PDF</a>`
    : `<a href="${url}" target="_blank" rel="noopener" title="Чек от ${dateTime(r.created_at)}"><img class="receipt-thumb" src="${url}" alt="Чек об оплате"></a>`;
}).join('')}</div>` : (o.pay_id && !o.paid_at ? '<div class="pick-meta">Чек покупатель не прикрепил</div>' : ''));

async function renderOrders() {
  try { ordersView.methods = await api('/api/payment-methods?mine=1'); } catch { ordersView.methods = []; }
  $('#orders-filter').innerHTML = [['', 'Все'], ...Object.entries(ORDER_STATUS)].map(([key, label]) =>
    `<button type="button" data-status="${key}" aria-pressed="${ordersView.status === key}">${label}</button>`).join('');
  try {
    ordersView.list = await api('/api/orders?status=' + ordersView.status);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const list = ordersView.list;
  if (ordersView.status === 'active') setOrdersBadge(list.filter((o) => o.status === 'new' || o.status === 'checking').length);
  $('#orders-summary').textContent = `${list.length} ${plural(list.length, ['заказ', 'заказа', 'заказов'])}`;
  $('#orders-list').innerHTML = list.length ? list.map((o) => {
    const open = o.status !== 'done' && o.status !== 'cancelled';
    return `<article class="order ${o.status}">
      <header>
        <b class="num">№${o.id}</b>
        <span>${dateTime(o.created_at)}</span>
        <span class="seg-tag ${o.status}">${orderOne(o)}</span>
        <b class="num order-total">${money2(o.total)}</b>
      </header>
      <div class="order-body">
        <div class="order-who">
          <div class="pname">${esc(o.name)}</div>
          <a href="tel:+${esc(o.phone)}">${phoneFmt(o.phone)}</a>
          <div>${o.delivery === 'delivery' ? `🚚 Доставка: ${esc(o.address)}` : '🏬 Самовывоз'}</div>
          ${o.comment ? `<div class="pick-meta">«${esc(o.comment)}»</div>` : ''}
          ${orderPayLine(o)}
        </div>
        <ul class="order-items">${o.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qtyFmt.format(i.qty)} × ${money2(i.price)}</span></li>`).join('')}</ul>
      </div>
      ${open ? `<div class="doc-actions">
        ${orderActions(o)}
        <button type="button" class="btn small ${ordersView.confirmCancel === o.id ? 'danger' : 'ghost'}" data-order="${o.id}" data-to="cancelled">${ordersView.confirmCancel === o.id ? 'Точно отменить?' : 'Отменить'}</button>
      </div>` : `<p class="pick-meta">${o.status === 'done' ? `Выдан ${o.updated_at ? dateTime(o.updated_at) : ''}${o.updated_by ? ', ' + esc(o.updated_by) : ''}${o.sale_id ? ` · чек №${o.sale_id}` : ''}` : `Отменён ${o.updated_by ? esc(o.updated_by) : ''}`}</p>`}
    </article>`;
  }).join('') : `<p class="empty">${ordersView.status === 'active' || ordersView.status === 'new' ? 'Открытых заказов нет. Как только покупатель оформит заказ на витрине, он появится здесь.' : 'Заказов нет'}</p>`;
}

$('#orders-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  ordersView.status = btn.dataset.status;
  renderOrders();
});
$('#orders-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-order]');
  if (!btn) return;
  const id = Number(btn.dataset.order);
  if (btn.dataset.to === 'cancelled' && ordersView.confirmCancel !== id) {
    ordersView.confirmCancel = id;
    return renderOrders();
  }
  ordersView.confirmCancel = null;
  try {
    const o = await api(`/api/orders/${id}`, { method: 'PUT', body: { status: btn.dataset.to, methodId: btn.dataset.method ? Number(btn.dataset.method) : undefined } });
    toast(o.status === 'done' ? `Заказ №${o.id} выдан, чек №${o.sale_id} пробит` : `Заказ №${o.id}: ${orderOne(o).toLowerCase()}`);
    renderOrders();
  } catch (err) {
    toast(err.message, 'error');
  }
});
salesFeed.orderListeners.push(() => {
  if (currentView === 'orders') renderOrders();
  else api('/api/status').then((s) => setOrdersBadge(s.newOrders)).catch(() => {});
});

views.orders = { show: renderOrders, right: 'orders' };
