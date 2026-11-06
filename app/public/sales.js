'use strict';

// Журнал продаж: история, возвраты и удаление чеков.

const SALES_RANGES = {
  today: ['Сегодня', 0, 1],
  yesterday: ['Вчера', -1, 0],
  week: ['7 дней', -6, 1],
  month: ['30 дней', -29, 1],
};
const salesView = { range: 'today', confirm: null, list: [], selected: new Set(), deleting: null, register: null };
// Удалять можно в основной программе, если есть право; в окне кассы — нет.
// Удалять продажи — только владелец и только в админ-панели (не в кассе).
const canDeleteSales = () => !IS_KASSA && (session.isOwner || !session.auth);

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
    list = await api(`/api/sales?from=${from}&to=${to}${salesView.register ? `&register=${salesView.register.id}${salesView.register.branch ? `&branch=${salesView.register.branch}` : ''}` : ''}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  salesView.list = list;
  // Журнал одной кассы (из «Кассы»): плашка с названием и «Все кассы».
  const rf = $('#sales-reg-filter');
  rf.hidden = !salesView.register;
  if (salesView.register) rf.innerHTML = `<span>🖥️ Только касса <b>${esc(salesView.register.name)}</b>${salesView.register.branch ? ` · магазин «${esc(salesView.register.shop)}» — только просмотр` : ''}</span> <button type="button" class="btn small ghost" id="sales-reg-clear">Все кассы ✕</button>`;
  const ids = new Set(list.map((s) => s.id));
  for (const id of salesView.selected) if (!ids.has(id)) salesView.selected.delete(id);
  // Чеки другого магазина — только просмотр: без удаления и возврата.
  const foreign = Boolean(salesView.register?.branch);
  const del = canDeleteSales() && !foreign;
  const done = list.filter((s) => !s.refunded_at);
  // Деньгами — без части, оплаченной бонусами.
  const sum = done.reduce((s, x) => s + x.total - x.bonus_spent, 0);
  // Сколько пришло каждым способом оплаты: «Наличные 12 000 · МБАНК 8 500 · Оптима 3 200».
  // Смешанный чек делится по частям оплаты; комиссия банков — отдельно.
  const byMethod = new Map();
  let fees = 0;
  let cash = 0, cashless = 0;
  const kindOf = new Map(); // выручка справа: наличными и безналом (без возвратов и бонусов)
  for (const x of done) {
    for (const p of x.payments?.length ? x.payments : [{ name: methodName(x), kind: x.payment === 'cash' ? 'cash' : 'card', amount: x.total - x.bonus_spent, commission: 0 }]) {
      if (p.kind === 'cash') cash += p.amount; else cashless += p.amount;
      byMethod.set(p.name, (byMethod.get(p.name) || 0) + p.amount);
      kindOf.set(p.name, p.kind === 'cash' ? 'cash' : 'cashless');
      fees += p.commission;
    }
  }
  // Итоги карточками: наличными, безнал (по банкам), итого — как «Касса сейчас» на главной.
  const methodsOf = (kind) => [...byMethod].filter(([n]) => kindOf.get(n) === kind).sort((a, b) => b[1] - a[1]);
  const lines = (kind) => methodsOf(kind).map(([n, v]) => `<li><span>${esc(n)}</span><b class="num">${money2(v)}</b></li>`).join('');
  const total = cash + cashless;
  const pct = (v) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '');
  $('#sales-summary').innerHTML = `
    <div class="ss-tiles">
      <div class="ss-tile ss-total">
        <span class="ss-label">Итого за ${esc(SALES_RANGES[salesView.range]?.[0]?.toLowerCase() || 'период')}</span>
        <b class="num ss-sum">${money2(total)}</b>
        <span class="ss-meta">${int(done.length)} ${plural(done.length, ['чек', 'чека', 'чеков'])}${done.length ? ` · средний ${money2(Math.round(total / done.length))}` : ''}</span>
      </div>
      <div class="ss-tile ss-cash">
        <span class="ss-label">💵 Наличными <i>${pct(cash)}</i></span>
        <b class="num">${money2(cash)}</b>
        ${methodsOf('cash').length > 1 ? `<ul>${lines('cash')}</ul>` : ''}
      </div>
      <div class="ss-tile ss-cashless">
        <span class="ss-label">💳 Безнал <i>${pct(cashless)}</i></span>
        <b class="num">${money2(cashless)}</b>
        ${methodsOf('cashless').length ? `<ul>${lines('cashless')}</ul>` : '<span class="ss-meta">карты, банки, QR</span>'}
      </div>
    </div>
    ${fees || list.length >= 200 ? `<p class="pick-meta ss-note">${[fees ? `Комиссия банков −${money2(fees)} · к зачислению ${money2(total - fees)}` : '', list.length >= 200 ? 'показаны последние 200 чеков' : ''].filter(Boolean).join(' · ')}</p>` : ''}`;
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
      ${s.refunded_at ? `<p class="pick-meta">Возврат оформлен ${dateTime(s.refunded_at)}, товар вернулся на склад.</p>` : !session.can('refund') || foreign ? '' : `
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
document.addEventListener('click', (e) => { if (e.target.closest('#sales-reg-clear')) { salesView.register = null; renderSales(); } });
views.sales = { show: () => { salesView.confirm = null; renderSales(); }, right: IS_KASSA ? 'pos' : 'sales' };
