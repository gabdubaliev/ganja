'use strict';

// Журнал продаж: история, возвраты и удаление чеков.

const SALES_RANGES = {
  today: ['Сегодня', 0, 1],
  yesterday: ['Вчера', -1, 0],
  week: ['7 дней', -6, 1],
  month: ['30 дней', -29, 1],
};
const salesView = { range: 'today', confirm: null, list: [], selected: new Set(), deleting: null };
// Удалять можно в основной программе, если есть право; в окне кассы — нет.
const canDeleteSales = () => !IS_KASSA && session.can('sales.delete');

function salesPeriod() {
  const [, fromDays, toDays] = SALES_RANGES[salesView.range];
  const today = dayStart(Date.now()).getTime();
  return [addDays(today, fromDays), addDays(today, toDays)];
}

// Название способа оплаты чека; у чеков из старых версий — «Наличные» или «Карта».
const methodName = (s) => s.method_name || (s.payment === 'cash' ? 'Наличные' : 'Карта');

async function renderSales() {
  $('#sales-ranges').innerHTML = Object.entries(SALES_RANGES).map(([key, [label]]) =>
    `<button type="button" data-range="${key}" aria-pressed="${key === salesView.range}">${label}</button>`).join('');
  const [from, to] = salesPeriod();
  let list;
  try {
    list = await api(`/api/sales?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  salesView.list = list;
  const ids = new Set(list.map((s) => s.id));
  for (const id of salesView.selected) if (!ids.has(id)) salesView.selected.delete(id);
  const del = canDeleteSales();
  const done = list.filter((s) => !s.refunded_at);
  // Деньгами — без части, оплаченной бонусами.
  const sum = done.reduce((s, x) => s + x.total - x.bonus_spent, 0);
  // Сколько пришло каждым способом оплаты: «Наличные 12 000 · МБАНК 8 500 · Оптима 3 200».
  // Смешанный чек делится по частям оплаты; комиссия банков — отдельно.
  const byMethod = new Map();
  let fees = 0;
  for (const x of done) {
    for (const p of x.payments?.length ? x.payments : [{ name: methodName(x), amount: x.total - x.bonus_spent, commission: 0 }]) {
      byMethod.set(p.name, (byMethod.get(p.name) || 0) + p.amount);
      fees += p.commission;
    }
  }
  $('#sales-summary').innerHTML = `
    <span><b class="num">${done.length}</b> ${plural(done.length, ['чек', 'чека', 'чеков'])}</span>
    <span>на <b class="num">${money2(sum)}</b></span>
    <span class="pay-split">${[...byMethod].sort((a, b) => b[1] - a[1]).map(([n, v]) => `<span class="pay-chip">${esc(n)} <b class="num">${money2(v)}</b></span>`).join('')}</span>
    ${fees ? `<span class="pick-meta">комиссия банков −${money2(fees)} · к зачислению ${money2(sum - fees)}</span>` : ''}
    ${list.length >= 200 ? '<span class="pick-meta">показаны последние 200</span>' : ''}`;
  $('#sales-list').innerHTML = list.length ? list.map((s) => `
    <div class="sale-row ${del ? 'with-select' : ''} ${salesView.selected.has(s.id) ? 'selected' : ''}">
    ${del ? `<input type="checkbox" class="sale-check" data-sale-select="${s.id}" ${salesView.selected.has(s.id) ? 'checked' : ''} aria-label="Выбрать чек №${s.id}">` : ''}
    <details class="doc ${s.refunded_at ? 'refunded' : ''}">
      <summary>
        <span class="num">№${s.id}</span>
        <span>${dateTime(s.created_at)}</span>
        <span class="pick-meta">${s.payments?.length > 1 ? s.payments.map((p) => `${esc(p.name)} ${money2(p.amount)}`).join(' + ') : esc(methodName(s))}${s.discount ? ` · скидка ${money2(s.discount)}` : ''}${s.user_name ? ' · ' + esc(s.user_name) : ''}${s.refunded_at ? ' · возврат' : ''}</span>
        <b class="num">${money2(s.total)}</b>
      </summary>
      <ul>${s.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qtyFmt.format(i.qty)} × ${money2(i.price)} = ${money2(i.qty * i.price)}</span></li>`).join('')}</ul>
      ${s.payments?.length > 1 || s.payments?.some((p) => p.commission) ? `<p class="pick-meta">Оплата: ${s.payments.map((p) => `${esc(p.name)} ${money2(p.amount)}${p.commission ? ` (комиссия −${money2(p.commission)})` : ''}`).join(' + ')}</p>` : ''}
      ${s.discount ? `<p class="pick-meta">Скидка ${money2(s.discount)}${s.discount_reason ? ` · ${esc(s.discount_reason)}` : ''}</p>` : ''}
      ${s.customer_id ? `<p class="pick-meta">Покупатель: ${esc(s.customer_name || '+' + s.customer_phone)}${s.bonus_spent ? ` · оплачено бонусами ${money2(s.bonus_spent)}` : ''}${s.bonus_earned ? ` · начислено ${int(s.bonus_earned)} бонусов` : ''}</p>` : ''}
      ${s.refunded_at ? `<p class="pick-meta">Возврат оформлен ${dateTime(s.refunded_at)}, товар вернулся на склад.</p>` : !session.can('refund') ? '' : `
        <div class="doc-actions">
          <button type="button" class="btn small ${salesView.confirm === s.id ? 'danger' : 'ghost'}" data-refund="${s.id}">
            ${salesView.confirm === s.id ? 'Нажмите ещё раз, чтобы вернуть' : 'Оформить возврат'}
          </button>
        </div>`}
      <div class="doc-actions"><button type="button" class="btn small" data-sale-print="${s.id}">🖨️ Печать чека</button></div>
      ${del ? `<div class="doc-actions"><button type="button" class="btn small ghost danger-text" data-sale-delete="${s.id}">Удалить чек</button></div>` : ''}
    </details>
    </div>`).join('') : '<p class="empty">Чеков за этот период нет</p>';
  renderSalesTools();
  if (salesView.confirm) $(`[data-refund="${salesView.confirm}"]`)?.closest('details')?.setAttribute('open', '');
}

function renderSalesTools() {
  const tools = $('#sales-tools');
  if (!tools) return;
  tools.hidden = !canDeleteSales();
  const n = salesView.selected.size;
  $('#sales-del-selected').disabled = !n;
  $('#sales-del-selected').textContent = n ? `Удалить выбранные (${n})` : 'Удалить выбранные';
  $('#sales-all').checked = n > 0 && n === salesView.list.length;
  $('#sales-all').indeterminate = n > 0 && n < salesView.list.length;
}

/* ---------- Удаление продаж ---------- */
// mode: { ids } — выбранные или один чек; { bulk: true } — все за период или за всё время.
async function openSaleDelete(mode) {
  salesView.deleting = mode;
  const f = $('#sale-delete-form');
  f.reset();
  $('#sd-error').hidden = true;
  $('#sd-scope').hidden = !mode.bulk;
  $('#sd-period-label').textContent = `За период «${SALES_RANGES[salesView.range][0]}»`;
  $('#sd-title').textContent = mode.bulk ? 'Удалить все продажи' : mode.ids.length === 1 ? `Удалить чек №${mode.ids[0]}` : 'Удалить выбранные продажи';
  $('#sale-delete-dialog').showModal();
  await countSaleDelete();
}

function saleDeleteBody() {
  const m = salesView.deleting;
  if (!m.bulk) return { ids: m.ids };
  if ($('#sale-delete-form').elements.scope.value === 'all') return { all: true };
  const [from, to] = salesPeriod();
  return { from, to };
}

// Сколько чеков удалится: считает сервер, ничего не удаляя. Одному чеку подтверждение словом не нужно.
async function countSaleDelete() {
  const body = saleDeleteBody();
  const needWord = !(body.ids && body.ids.length === 1);
  $('#sd-confirm-field').hidden = !needWord;
  $('#sd-count').textContent = 'Считаю…';
  try {
    const r = await api('/api/sales/delete', { method: 'POST', body: { ...body, dryRun: true } });
    salesView.deleting.count = r.count;
    $('#sd-count').innerHTML = r.count
      ? `Будет удалено <b>${int(r.count)} ${plural(r.count, ['чек', 'чека', 'чеков'])}</b> на <b>${money2(r.total)}</b>.`
      : 'Удалять нечего: продаж нет.';
    $('#sd-submit').disabled = !r.count;
  } catch (err) {
    showFormError('#sd-error', err);
  }
}

$('#sale-delete-form')?.addEventListener('change', (e) => { if (e.target.name === 'scope') countSaleDelete(); });
$('#sale-delete-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!$('#sd-confirm-field').hidden && f.elements.confirm.value.trim().toUpperCase() !== 'УДАЛИТЬ') {
    return showFormError('#sd-error', new Error('Напишите слово УДАЛИТЬ, чтобы подтвердить'));
  }
  try {
    const r = await api('/api/sales/delete', { method: 'POST', body: { ...saleDeleteBody(), restock: f.elements.restock.checked } });
    $('#sale-delete-dialog').close();
    toast(`Удалено ${int(r.count)} ${plural(r.count, ['чек', 'чека', 'чеков'])} на ${money2(r.total)}`);
    salesView.selected.clear();
    renderSales();
  } catch (err) {
    showFormError('#sd-error', err);
  }
});
$('#sd-cancel')?.addEventListener('click', () => $('#sale-delete-dialog').close());
$('#sales-del-selected')?.addEventListener('click', () => openSaleDelete({ ids: [...salesView.selected] }));
$('#sales-del-all')?.addEventListener('click', () => openSaleDelete({ bulk: true }));
$('#sales-all')?.addEventListener('change', (e) => {
  for (const s of salesView.list) {
    if (e.target.checked) salesView.selected.add(s.id); else salesView.selected.delete(s.id);
  }
  renderSales();
});

$('#sales-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  salesView.range = btn.dataset.range;
  salesView.confirm = null;
  salesView.selected.clear();
  renderSales();
});
$('#sales-list').addEventListener('click', async (e) => {
  const printBtn = e.target.closest('[data-sale-print]');
  if (printBtn) return printReceipt(Number(printBtn.dataset.salePrint));
  const pick = e.target.closest('[data-sale-select]');
  if (pick) {
    const id = Number(pick.dataset.saleSelect);
    if (pick.checked) salesView.selected.add(id); else salesView.selected.delete(id);
    pick.closest('.sale-row').classList.toggle('selected', pick.checked);
    return renderSalesTools();
  }
  const one = e.target.closest('[data-sale-delete]');
  if (one) return openSaleDelete({ ids: [Number(one.dataset.saleDelete)] });
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
