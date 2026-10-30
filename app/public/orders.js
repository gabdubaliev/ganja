'use strict';

// Заказы с интернет-витрины: подтвердить, собрать, выдать (пробивается чек) или отменить.

const ORDER_STATUS = {
  new: 'Новые',
  confirmed: 'Подтверждены',
  ready: 'Собраны',
  shipped: 'У курьера',
  done: 'Выданы',
  cancelled: 'Отменены',
};
const ORDER_ONE = { new: 'Новый', confirmed: 'Подтверждён', ready: 'Собран', shipped: 'Передан курьеру', done: 'Выдан', cancelled: 'Отменён' };
// Доставку после сборки передают курьеру, самовывоз сразу выдают.
const orderNext = (o) => ({ new: 'confirmed', confirmed: 'ready', ready: o.delivery === 'delivery' ? 'shipped' : 'done', shipped: 'done' })[o.status];
const ORDER_NEXT_LABEL = { confirmed: 'Подтвердить', ready: 'Собран', shipped: 'Передать курьеру', done: 'Выдать и пробить чек' };
const ordersView = { status: 'new', list: [], confirmCancel: null, methods: [] };

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
  if (ordersView.status === 'new') setOrdersBadge(list.length);
  $('#orders-summary').textContent = `${list.length} ${plural(list.length, ['заказ', 'заказа', 'заказов'])}`;
  $('#orders-list').innerHTML = list.length ? list.map((o) => {
    const next = orderNext(o);
    const open = o.status !== 'done' && o.status !== 'cancelled';
    return `<article class="order ${o.status}">
      <header>
        <b class="num">№${o.id}</b>
        <span>${dateTime(o.created_at)}</span>
        <span class="seg-tag ${o.status}">${ORDER_ONE[o.status]}</span>
        <b class="num order-total">${money2(o.total)}</b>
      </header>
      <div class="order-body">
        <div class="order-who">
          <div class="pname">${esc(o.name)}</div>
          <a href="tel:+${esc(o.phone)}">${phoneFmt(o.phone)}</a>
          <div>${o.delivery === 'delivery' ? `🚚 Доставка: ${esc(o.address)}` : '🏬 Самовывоз'}</div>
          ${o.comment ? `<div class="pick-meta">«${esc(o.comment)}»</div>` : ''}
        </div>
        <ul class="order-items">${o.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qtyFmt.format(i.qty)} × ${money2(i.price)}</span></li>`).join('')}</ul>
      </div>
      ${open ? `<div class="doc-actions">
        ${next === 'done' ? (ordersView.methods.length ? `<span class="pick-meta">Выдать, оплата:</span>` + ordersView.methods.map((m, i) => `
          <button type="button" class="btn small ${i === 0 ? 'primary' : ''}" data-order="${o.id}" data-to="done" data-method="${m.id}">${esc(m.name)}</button>`).join('')
          : '<span class="neg">Нет доступных способов оплаты</span>')
        : `<button type="button" class="btn small primary" data-order="${o.id}" data-to="${next}">${ORDER_NEXT_LABEL[next]}</button>`}
        <button type="button" class="btn small ${ordersView.confirmCancel === o.id ? 'danger' : 'ghost'}" data-order="${o.id}" data-to="cancelled">${ordersView.confirmCancel === o.id ? 'Точно отменить?' : 'Отменить'}</button>
      </div>` : `<p class="pick-meta">${o.status === 'done' ? `Выдан ${o.updated_at ? dateTime(o.updated_at) : ''}${o.updated_by ? ', ' + esc(o.updated_by) : ''}${o.sale_id ? ` · чек №${o.sale_id}` : ''}` : `Отменён ${o.updated_by ? esc(o.updated_by) : ''}`}</p>`}
    </article>`;
  }).join('') : `<p class="empty">${ordersView.status === 'new' ? 'Новых заказов нет. Как только покупатель оформит заказ на витрине, он появится здесь.' : 'Заказов нет'}</p>`;
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
    toast(o.status === 'done' ? `Заказ №${o.id} выдан, чек №${o.sale_id} пробит` : `Заказ №${o.id}: ${ORDER_ONE[o.status].toLowerCase()}`);
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
