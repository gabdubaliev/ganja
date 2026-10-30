'use strict';

// Чеки: история продаж и возвраты.

const SALES_RANGES = {
  today: ['Сегодня', 0, 1],
  yesterday: ['Вчера', -1, 0],
  week: ['7 дней', -6, 1],
  month: ['30 дней', -29, 1],
};
const salesView = { range: 'today', confirm: null };

async function renderSales() {
  $('#sales-ranges').innerHTML = Object.entries(SALES_RANGES).map(([key, [label]]) =>
    `<button type="button" data-range="${key}" aria-pressed="${key === salesView.range}">${label}</button>`).join('');
  const [, fromDays, toDays] = SALES_RANGES[salesView.range];
  const today = dayStart(Date.now()).getTime();
  let list;
  try {
    list = await api(`/api/sales?from=${addDays(today, fromDays)}&to=${addDays(today, toDays)}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const done = list.filter((s) => !s.refunded_at);
  // Деньгами — без части, оплаченной бонусами.
  const sum = done.reduce((s, x) => s + x.total - x.bonus_spent, 0);
  const card = done.filter((s) => s.payment === 'card').reduce((s, x) => s + x.total - x.bonus_spent, 0);
  $('#sales-summary').innerHTML = `
    <span><b class="num">${done.length}</b> ${plural(done.length, ['чек', 'чека', 'чеков'])}</span>
    <span>на <b class="num">${money2(sum)}</b></span>
    <span class="pick-meta">картой ${money2(card)} · наличными ${money2(sum - card)}</span>
    ${list.length >= 200 ? '<span class="pick-meta">показаны последние 200</span>' : ''}`;
  $('#sales-list').innerHTML = list.length ? list.map((s) => `
    <details class="doc ${s.refunded_at ? 'refunded' : ''}">
      <summary>
        <span class="num">№${s.id}</span>
        <span>${dateTime(s.created_at)}</span>
        <span class="pick-meta">${s.payment === 'card' ? 'картой' : 'наличными'}${s.user_name ? ' · ' + esc(s.user_name) : ''}${s.refunded_at ? ' · возврат' : ''}</span>
        <b class="num">${money2(s.total)}</b>
      </summary>
      <ul>${s.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qtyFmt.format(i.qty)} × ${money2(i.price)} = ${money2(i.qty * i.price)}</span></li>`).join('')}</ul>
      ${s.customer_id ? `<p class="pick-meta">Покупатель: ${esc(s.customer_name || '+' + s.customer_phone)}${s.bonus_spent ? ` · оплачено бонусами ${money2(s.bonus_spent)}` : ''}${s.bonus_earned ? ` · начислено ${int(s.bonus_earned)} бонусов` : ''}</p>` : ''}
      ${s.refunded_at ? `<p class="pick-meta">Возврат оформлен ${dateTime(s.refunded_at)}, товар вернулся на склад.</p>` : !session.can('refund') ? '' : `
        <div class="doc-actions">
          <button type="button" class="btn small ${salesView.confirm === s.id ? 'danger' : 'ghost'}" data-refund="${s.id}">
            ${salesView.confirm === s.id ? 'Нажмите ещё раз, чтобы вернуть' : 'Оформить возврат'}
          </button>
        </div>`}
    </details>`).join('') : '<p class="empty">Чеков за этот период нет</p>';
  if (salesView.confirm) $(`[data-refund="${salesView.confirm}"]`)?.closest('details')?.setAttribute('open', '');
}

$('#sales-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  salesView.range = btn.dataset.range;
  salesView.confirm = null;
  renderSales();
});
$('#sales-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-refund]');
  if (!btn) return;
  const id = Number(btn.dataset.refund);
  if (salesView.confirm !== id) {
    salesView.confirm = id;
    return renderSales();
  }
  salesView.confirm = null;
  try {
    await api(`/api/sales/${id}/refund`, { method: 'POST' });
    toast(`Возврат по чеку №${id} оформлен`);
  } catch (err) {
    toast(err.message, 'error');
  }
  renderSales();
});

// В окне кассы раздел показывает свои чеки кассира, в программе — все чеки.
views.sales = { show: () => { salesView.confirm = null; renderSales(); }, right: IS_KASSA ? 'pos' : 'sales' };
