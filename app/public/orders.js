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
  ${orderReceipts(o)}
  ${o.paid_at && ['confirmed', 'ready', 'shipped'].includes(o.status) ? `<a class="btn small ghost" href="https://wa.me/${esc(o.phone)}?text=${encodeURIComponent(`Здравствуйте, ${o.name}! Оплата заказа №${o.id} на ${o.total} сом подтверждена. Упаковываем и скоро передадим курьеру.`)}" target="_blank" rel="noopener">💬 Написать покупателю в WhatsApp</a>` : ''}` : '');
// Чеки об оплате от покупателя: миниатюра открывает чек крупно поверх страницы (без новой вкладки).
const orderReceipts = (o) => (o.receipts?.length ? `<div class="order-receipts">${o.receipts.map((r) => {
  const url = `/api/orders/${o.id}/receipts/${r.id}`;
  return r.mime === 'application/pdf'
    ? `<button type="button" class="btn small" data-receipt-view="${url}" data-receipt-order="${o.id}" data-pdf="1">📄 Чек PDF</button>`
    : `<button type="button" class="receipt-open" data-receipt-view="${url}" data-receipt-order="${o.id}" title="Чек от ${dateTime(r.created_at)} — нажмите, чтобы увеличить"><img class="receipt-thumb" src="${url}" alt="Чек об оплате" draggable="false"></button>`;
}).join('')}</div>` : (o.pay_id && !o.paid_at ? '<div class="pick-meta">Чек покупатель не прикрепил</div>' : ''));

// Чек крупно поверх страницы: закрывается нажатием в любое место или клавишей Esc.
// Сверху — «Переслать в WhatsApp»: системное меню «Поделиться» (выбрать группу магазина).
function openReceiptView(url, pdf, order) {
  const box = document.createElement('div');
  box.className = 'receipt-view';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Чек об оплате');
  box.innerHTML = `<div class="receipt-view-bar">
      <button type="button" class="btn small primary" data-receipt-share>📤 Переслать в WhatsApp</button>
      <button type="button" class="btn small" data-receipt-close>✕ Закрыть</button>
    </div>
    ${pdf ? `<iframe src="${url}" title="Чек об оплате"></iframe>` : `<img src="${url}" alt="Чек об оплате" draggable="false">`}
    <span class="receipt-view-hint">${pdf ? 'Нажмите рядом с чеком, чтобы закрыть' : 'Нажмите в любое место, чтобы закрыть'}</span>`;
  const close = () => { box.classList.remove('on'); setTimeout(() => box.remove(), 180); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-receipt-share]')) return shareReceipt(url, pdf, order);
    close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add('on'));
}

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
// Переслать чек: на телефоне и планшете — меню «Поделиться» с файлом (выбрать WhatsApp → группу магазина).
// Где так нельзя (компьютер) — файл скачивается и открывается WhatsApp с текстом: чек прикрепить вручную.
async function shareReceipt(url, pdf, order) {
  const text = order ? `Чек об оплате заказа №${order.id} — ${money2(order.total)}, ${order.name}, ${phoneFmt(order.phone)}${order.pay_name ? `, ${order.pay_name}` : ''}` : 'Чек об оплате';
  try {
    const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error('Чек не загрузился'); return r.blob(); });
    const file = new File([blob], `chek-zakaz-${order?.id || ''}.${pdf ? 'pdf' : 'jpg'}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    toast('Чек скачан. В WhatsApp выберите группу и прикрепите файл');
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message || 'Не получилось переслать', 'error');
  }
}

$('#orders-list').addEventListener('click', async (e) => {
  const view = e.target.closest('[data-receipt-view]');
  if (view) return openReceiptView(view.dataset.receiptView, Boolean(view.dataset.pdf), ordersView.list.find((o) => o.id === Number(view.dataset.receiptOrder)));
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
    toast(o.status === 'done' ? `Заказ №${o.id} выдан, чек №${o.sale_id} пробит`
      : o.notified === 'sms' ? `Заказ №${o.id}: оплата подтверждена, покупателю отправлено SMS`
      : `Заказ №${o.id}: ${orderOne(o).toLowerCase()}${o.paid_at && btn.dataset.to === 'confirmed' ? '. Покупатель увидит уведомление на витрине' : ''}`);
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
