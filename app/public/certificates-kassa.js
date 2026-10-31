'use strict';

// Касса: продажа подарочного сертификата и оплата чека сертификатом.

/* ---------- Продажа сертификата ---------- */
const cs = { customer: null, methodId: null, found: [], sold: null };

function openCertSell() {
  const f = $('#cs-form');
  f.reset();
  Object.assign(cs, { customer: null, sold: null });
  cs.methodId = pos.methods.find((m) => m.kind === 'cash')?.id ?? pos.methods[0]?.id ?? null;
  $('#cs-fields').hidden = false;
  $('#cs-done').hidden = true;
  $('#cs-error').hidden = true;
  $('#cs-cust-results').hidden = true;
  drawCertSell();
  $('#cert-sell-dialog').showModal();
  $('#cs-amount').focus();
}

function drawCertSell() {
  const c = cs.customer;
  $('#cs-cust-chosen').hidden = !c;
  $('#cs-cust').closest('.cs-cust-row').hidden = Boolean(c);
  if (c) $('#cs-cust-chosen').innerHTML = `<span>👤 <b>${esc(c.name || phoneFmt(c.phone))}</b> <span class="pick-meta">${c.name ? phoneFmt(c.phone) : ''}${c.card ? ` · карта ${c.card}` : ''}</span></span><button type="button" class="btn small ghost" id="cs-cust-change">Другой</button>`;
  $('#cs-methods').innerHTML = pos.methods.map((m) => `<button type="button" data-cs-method="${m.id}" aria-pressed="${m.id === cs.methodId}"><span aria-hidden="true">${PAY_ICON[m.kind] || '•'}</span>${esc(m.name)}</button>`).join('');
  const m = pos.methods.find((x) => x.id === cs.methodId);
  $('#cs-cash-row').hidden = m?.kind !== 'cash';
  const amount = parseNum($('#cs-amount').value) || 0;
  const given = parseNum($('#cs-given').value);
  $('#cs-change').textContent = m?.kind === 'cash' && given > 0 && amount > 0 ? (given >= amount ? `Сдача: ${money2(given - amount)}` : `Не хватает ${money2(amount - given)}`) : '';
  $('#cs-submit').textContent = amount > 0 ? `Продать сертификат на ${money2(amount)}` : 'Продать сертификат';
}

$('#cert-sell-open').addEventListener('click', async () => {
  if (!pos.methods.length) await loadPayMethods();
  openCertSell();
});
$('#cs-form').addEventListener('input', (e) => {
  if (e.target.id === 'cs-cust') { clearTimeout(cs.timer); cs.timer = setTimeout(searchCertCustomer, 250); return; }
  if (e.target.id === 'cs-number') e.target.value = e.target.value.replace(/\s/g, '');
  drawCertSell();
});
async function searchCertCustomer() {
  const q = $('#cs-cust').value.trim();
  if (!q) { $('#cs-cust-results').hidden = true; return; }
  try { cs.found = await api('/api/customers/search?q=' + encodeURIComponent(q)); } catch (err) { return showFormError('#cs-error', err); }
  $('#cs-cust-results').innerHTML = cs.found.map((c, i) => `<button type="button" class="suggest" data-cs-cust="${i}"><span><b>${esc(c.name || phoneFmt(c.phone))}</b><span class="pick-meta"> ${c.name ? phoneFmt(c.phone) : ''}${c.card ? ` · карта ${c.card}` : ''}</span></span></button>`).join('')
    || `<div class="suggest muted">Никого не нашли${session.can('customers.create') ? ' — нажмите «+ Новый клиент»' : ''}</div>`;
  $('#cs-cust-results').hidden = false;
}
$('#cs-form').addEventListener('click', async (e) => {
  const m = e.target.closest('[data-cs-method]');
  if (m) { cs.methodId = Number(m.dataset.csMethod); drawCertSell(); if ($('#cs-cash-row').hidden === false) $('#cs-given').focus(); return; }
  const c = e.target.closest('[data-cs-cust]');
  if (c) { cs.customer = cs.found[Number(c.dataset.csCust)]; $('#cs-cust-results').hidden = true; $('#cs-cust').value = ''; return drawCertSell(); }
  if (e.target.closest('#cs-cust-change')) { cs.customer = null; drawCertSell(); return $('#cs-cust').focus(); }
});
$('#cs-cust').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (cs.found.length === 1) { cs.customer = cs.found[0]; $('#cs-cust-results').hidden = true; $('#cs-cust').value = ''; drawCertSell(); }
});
$('#cs-cust-new').addEventListener('click', () => {
  // Новый клиент из окна сертификата: после сохранения он становится покупателем сертификата.
  custOnSaved = (c) => { cs.customer = c; drawCertSell(); };
  openCustomerDialog($('#cs-cust').value.trim());
});
$('#cs-number-new').addEventListener('click', async () => {
  try { $('#cs-number').value = (await api('/api/certificates/new-number')).number; } catch (err) { showFormError('#cs-error', err); }
});
$('#cs-cancel').addEventListener('click', () => $('#cert-sell-dialog').close());
$('#cs-close').addEventListener('click', () => $('#cert-sell-dialog').close());
$('#cs-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseNum($('#cs-amount').value);
  if (!(amount > 0)) return showFormError('#cs-error', new Error('Укажите сумму сертификата'));
  if (!cs.customer) return showFormError('#cs-error', new Error('Выберите покупателя или нажмите «+ Новый клиент»'));
  const m = pos.methods.find((x) => x.id === cs.methodId);
  if (!m) return showFormError('#cs-error', new Error('Выберите способ оплаты'));
  if (m.kind === 'cash' && $('#cs-given').value && parseNum($('#cs-given').value) < amount) return showFormError('#cs-error', new Error('Получено меньше суммы сертификата'));
  $('#cs-submit').disabled = true;
  try {
    const c = await api('/api/certificates', { method: 'POST', body: { number: $('#cs-number').value.trim(), amount, customerId: cs.customer.id, methodId: cs.methodId } });
    cs.sold = c;
    $('#cs-fields').hidden = true;
    $('#cs-done').hidden = false;
    $('#cs-done-box').innerHTML = `<div class="cs-done-amount">${money2(c.amount)}</div>
      <p>Сертификат <b>№${esc(c.number)}</b> продан · ${esc(c.customer_name || phoneFmt(c.customer_phone || ''))}</p>
      <p class="pick-meta">${c.expires_at ? `Действует до ${new Date(c.expires_at).toLocaleDateString('ru-RU')}` : 'Без срока действия'} · ${esc(m.name)}</p>
      ${typeof barcodeSvg === 'function' && barcodeSvg(c.number) ? `<div class="cs-barcode">${barcodeSvg(c.number)}</div>` : ''}`;
    toast(`Сертификат №${c.number} на ${money2(c.amount)} продан`);
    loadShift();
  } catch (err) {
    showFormError('#cs-error', err);
  } finally {
    $('#cs-submit').disabled = false;
  }
});

// Печать на чековом принтере (58/80 мм) или обычном: название магазина, сумма, номер со штрихкодом, срок.
function printCertificate(c) {
  const shop = session.design?.name || 'Магазин';
  const bar = typeof barcodeSvg === 'function' ? barcodeSvg(c.number, { module: 0.375, barsMm: 14 }) : null;
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) return toast('Браузер не дал открыть окно печати — разрешите всплывающие окна', 'error');
  w.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сертификат ${esc(c.number)}</title>
    <style>@page { size: 58mm auto; margin: 3mm; } body { font-family: Arial, sans-serif; text-align: center; margin: 0; width: 52mm; }
    h1 { font-size: 15px; margin: 4px 0; } .t { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; margin-top: 6px; }
    .sum { font-size: 28px; font-weight: 800; margin: 6px 0; } .n { font-family: monospace; font-size: 13px; } p { font-size: 11px; margin: 4px 0; }
    svg { max-width: 100%; height: auto; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }</style></head>
    <body><h1>${esc(shop)}</h1><div class="t">Подарочный сертификат</div><div class="sum">${esc(money2(c.amount))}</div>
    ${bar || `<div class="n">№ ${esc(c.number)}</div>`}
    <p>${c.expires_at ? `Действует до ${new Date(c.expires_at).toLocaleDateString('ru-RU')}` : 'Без срока действия'}</p><hr>
    <p>Предъявите сертификат на кассе. Можно тратить частями — остаток сохраняется.</p>
    <p>Продан ${new Date(c.sold_at).toLocaleDateString('ru-RU')}</p>
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };<\/script></body></html>`);
  w.document.close();
}
$('#cs-print').addEventListener('click', () => cs.sold && printCertificate(cs.sold));

/* ---------- Оплата чека сертификатом ---------- */
let cpFound = null;
$('#cert-pay-open').addEventListener('click', () => {
  if (!pos.cart.length) return toast('Сначала добавьте товары в чек', 'error');
  $('#cp-form').reset();
  cpFound = null;
  $('#cp-info').hidden = true;
  $('#cp-amount-row').hidden = true;
  $('#cp-error').hidden = true;
  $('#cp-apply').disabled = true;
  $('#cert-pay-dialog').showModal();
  $('#cp-number').focus();
});
async function findCertForPay() {
  const num = $('#cp-number').value.trim();
  if (!num) return;
  $('#cp-error').hidden = true;
  try {
    const c = await api('/api/certificates/lookup?number=' + encodeURIComponent(num));
    cpFound = c;
    const toPay = r2(cartTotal() - bonusSpend());
    const states = { active: '✅ действует', used: '⛔ потрачен полностью', expired: '⛔ срок истёк', blocked: '⛔ заблокирован' };
    $('#cp-info').innerHTML = `<div class="cp-balance">${money2(c.balance)}<small>остаток из ${money2(c.amount)}</small></div>
      <p>${states[c.state]} · ${c.expires_at ? `до ${new Date(c.expires_at).toLocaleDateString('ru-RU')}` : 'без срока'}${c.customer_name ? ` · купил(а) ${esc(c.customer_name)}` : ''}</p>`;
    $('#cp-info').hidden = false;
    const ok = c.state === 'active';
    $('#cp-amount-row').hidden = !ok;
    $('#cp-amount').value = ok ? String(Math.min(c.balance, toPay)).replace('.', ',') : '';
    $('#cp-apply').disabled = !ok;
    if (ok) $('#cp-amount').select();
  } catch (err) {
    cpFound = null;
    $('#cp-info').hidden = true;
    $('#cp-amount-row').hidden = true;
    $('#cp-apply').disabled = true;
    showFormError('#cp-error', err);
  }
}
$('#cp-find').addEventListener('click', findCertForPay);
$('#cp-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findCertForPay(); } });
$('#cp-cancel').addEventListener('click', () => $('#cert-pay-dialog').close());
$('#cp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!cpFound) return;
  const amount = parseNum($('#cp-amount').value);
  if (!(amount > 0)) return showFormError('#cp-error', new Error('Укажите сумму'));
  if (amount > cpFound.balance + 0.001) return showFormError('#cp-error', new Error(`На сертификате только ${money2(cpFound.balance)}`));
  pos.cert = { number: cpFound.number, amount, balance: cpFound.balance, customer_name: cpFound.customer_name };
  $('#cert-pay-dialog').close();
  renderCart();
  toast(`Сертификат №${cpFound.number}: −${money2(certUse())}${r2(cartTotal() - bonusSpend() - certUse()) > 0 ? ', остальное оплатите деньгами' : ''}`);
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#cert-use-clear')) { pos.cert = null; renderCart(); }
});
