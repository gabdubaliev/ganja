'use strict';

// Прочее: счета (где лежат деньги и сколько) и кассы (рабочие места, на которых открываются смены).

const ACCOUNT_OPS = { deposit: 'Внесение', withdraw: 'Изъятие', transfer: 'Перевод', shift_diff: 'Расхождение в кассе', shift_start: 'Пересчёт кассы' };
const accView = { range: 'month', accounts: [] };

async function renderAccounts() {
  renderRanges($('#acc-ranges'), ['today', 'week', 'month', 'prevMonth'], accView.range);
  const [from, to] = RANGES[accView.range][1]();
  let r;
  try { r = await api(`/api/accounts?from=${from}&to=${to}`); } catch (err) { return toast(err.message, 'error'); }
  accView.accounts = r.accounts;
  const total = r.accounts.reduce((s, a) => s + a.balance, 0);
  $('#acc-sub').textContent = `Всего денег: ${money(total)}`;
  $('#acc-list').innerHTML = r.accounts.map((a) => {
    const p = a.period;
    return `<article class="acc-card ${a.kind === 'cash' ? 'cash' : ''} ${a.active ? '' : 'off'}">
      <div class="acc-head"><b>${a.kind === 'cash' ? '💵' : '💳'} ${esc(a.name)}</b>${a.active ? '' : '<span class="pick-meta">выключен</span>'}${a.pos === 0 ? '<span class="pick-meta">не на кассе</span>' : ''}</div>
      <div class="acc-balance num">${money(a.balance)}</div>
      <dl class="acc-flows">
        <dt>Оплаты чеков</dt><dd class="pos-text">+${money(p.sales)}</dd>
        ${p.commission ? `<dt>Комиссия банка</dt><dd class="neg">−${money(p.commission)}</dd>` : ''}
        ${p.returns ? `<dt>Возвраты</dt><dd class="neg">−${money(p.returns)}</dd>` : ''}
        ${p.purchases ? `<dt>Оплата закупок</dt><dd class="neg">−${money(p.purchases)}</dd>` : ''}
        ${p.ops ? `<dt>Внесения и изъятия</dt><dd class="${p.ops < 0 ? 'neg' : 'pos-text'}">${p.ops > 0 ? '+' : '−'}${money(Math.abs(p.ops))}</dd>` : ''}
        <dt><b>За период</b></dt><dd><b>${p.net >= 0 ? '+' : '−'}${money(Math.abs(p.net))}</b></dd>
      </dl>
      <div class="acc-actions">
        <button type="button" class="btn small" data-acc-op="deposit" data-acc="${a.id}">+ Внести</button>
        <button type="button" class="btn small" data-acc-op="withdraw" data-acc="${a.id}">− Изъять</button>
        <button type="button" class="btn small ghost" data-acc-op="transfer" data-acc="${a.id}">⇄ Перевести</button>
        <button type="button" class="link" data-acc-opening="${a.id}" title="Сколько было на счёте до начала работы в программе">начальный остаток ${money(a.opening)}</button>
      </div>
    </article>`;
  }).join('');
  $('#acc-ops').innerHTML = r.ops.length ? r.ops.map((o) => `<tr>
      <td>${dateTime(o.at)}</td><td>${esc(o.account || '—')}</td><td>${ACCOUNT_OPS[o.kind] || o.kind}</td>
      <td>${esc(o.note || '')}<div class="pcat">${esc(o.user_name || '')}</div></td>
      <td class="num ${o.amount < 0 ? 'neg' : 'pos-text'}">${o.amount > 0 ? '+' : '−'}${money(Math.abs(o.amount))}</td>
      <td><button type="button" class="btn small ghost" data-op-del="${o.id}">Отменить</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">За этот период ручных операций не было</td></tr>';
}

$('#acc-ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  accView.range = b.dataset.range;
  renderAccounts();
});
$('#acc-list').addEventListener('click', async (e) => {
  const op = e.target.closest('[data-acc-op]');
  const opening = e.target.closest('[data-acc-opening]');
  if (opening) {
    const a = accView.accounts.find((x) => x.id === Number(opening.dataset.accOpening));
    const v = prompt(`Начальный остаток «${a.name}» — сколько денег было до начала работы в программе:`, String(a.opening).replace('.', ','));
    if (v === null) return;
    try { await api(`/api/accounts/${a.id}/opening`, { method: 'PUT', body: { opening: parseNum(v) || 0 } }); renderAccounts(); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (!op) return;
  const a = accView.accounts.find((x) => x.id === Number(op.dataset.acc));
  const f = $('#acc-form');
  f.reset();
  f.dataset.acc = a.id;
  f.dataset.kind = op.dataset.accOp;
  $('#acc-title').textContent = `${ACCOUNT_OPS[op.dataset.accOp]}: ${a.name}`;
  $('#acc-to-row').hidden = op.dataset.accOp !== 'transfer';
  f.elements.to.innerHTML = accView.accounts.filter((x) => x.id !== a.id).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  f.elements.note.placeholder = op.dataset.accOp === 'withdraw' ? 'На что: аренда, зарплата, инкассация…' : op.dataset.accOp === 'transfer' ? 'Например: инкассация, сдал в банк' : 'Например: размен на утро';
  $('#acc-error').hidden = true;
  $('#acc-dialog').showModal();
  f.elements.amount.focus();
});
$('#acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/accounts/ops', { method: 'POST', body: { method_id: Number(f.dataset.acc), kind: f.dataset.kind, amount: parseNum(f.elements.amount.value), to_method_id: Number(f.elements.to.value) || null, note: f.elements.note.value } });
    $('#acc-dialog').close();
    toast('Операция записана');
    renderAccounts();
  } catch (err) { showFormError('#acc-error', err); }
});
$('#acc-cancel').addEventListener('click', () => $('#acc-dialog').close());
$('#acc-ops').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-op-del]');
  if (!b) return;
  if (!b.classList.contains('danger')) { b.classList.add('danger'); b.textContent = 'Точно?'; return; }
  try { await api(`/api/accounts/ops/${b.dataset.opDel}`, { method: 'DELETE' }); toast('Операция отменена'); renderAccounts(); } catch (err) { toast(err.message, 'error'); }
});

/* ---------- Кассы ---------- */
async function renderRegisters() {
  let list;
  try { list = await api('/api/registers?overview=1'); } catch (err) { return toast(err.message, 'error'); }
  const edit = session.can('settings');
  $('#reg-add').hidden = !edit;
  api('/api/cash-drawer').then((d) => {
    $('#reg-drawer-row').hidden = !edit;
    $('#reg-drawer').checked = d.one;
  }).catch(() => {});
  const shopName = session.branch?.name || session.design?.name || 'Магазин';
  $('#reg-list').innerHTML = list.map((r) => `
    <article class="acc-card reg-card ${r.active ? '' : 'off'}" data-reg="${r.id}">
      <div class="acc-head">${edit ? `<input class="input" value="${esc(r.name)}" data-reg-name aria-label="Название кассы">` : `<b>${esc(r.name)}</b>`}
        <span class="reg-status ${r.active ? 'on' : ''}">${r.active ? 'Активна' : 'Отключена'}</span>
        ${edit ? `<label class="check" title="Включить или отключить кассу"><input type="checkbox" data-reg-active ${r.active ? 'checked' : ''} aria-label="Касса работает"></label>` : ''}</div>
      <div class="acc-balance num" title="Сколько наличных должно быть в денежном ящике">${r.balance === null || r.balance === undefined ? '—' : money(r.balance)}</div>
      <dl class="acc-flows reg-info">
        <dt>Магазин</dt><dd>🏬 ${esc(shopName)}</dd>
        <dt>Счета на кассе</dt><dd>${r.methods?.length ? r.methods.map(esc).join(', ') : '—'}${r.own ? '' : ' <span class="pcat">(все)</span>'}</dd>
        <dt>Сегодня</dt><dd>${int(r.today.receipts)} ${plural(r.today.receipts, ['чек', 'чека', 'чеков'])} на ${money(r.today.revenue)}</dd>
        <dt>Создана</dt><dd>${r.created_at ? new Date(r.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</dd>
      </dl>
      ${r.open.length ? r.open.map((s) => `<div class="reg-open"><span class="live-dot" aria-hidden="true"></span><b>${esc(s.user)}</b> на смене с ${new Date(s.since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        <div class="pcat">наличными ${money(s.cash)} · безнал ${money(s.card)}</div></div>`).join('') : '<p class="pick-meta">Сейчас смены нет</p>'}
      ${edit && r.all_methods?.length ? `<div class="reg-methods"><b>Какие счета принимает эта касса</b>
        ${r.all_methods.map((m) => `<label class="check"><input type="checkbox" data-reg-method="${m.id}" ${r.method_ids.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}
        <p class="pick-meta">Отмечены все — касса принимает все счета «на кассе», и новые тоже. Снимите лишние, чтобы на этой кассе их не было.</p></div>` : ''}
      <div class="acc-actions"><button type="button" class="btn small" data-reg-sales="${r.id}" data-reg-title="${esc(r.name)}">🧾 Журнал продаж кассы</button></div>
    </article>`).join('');
}

$('#reg-drawer').addEventListener('change', async (e) => {
  try {
    await api('/api/cash-drawer', { method: 'PUT', body: { one: e.target.checked } });
    toast(e.target.checked ? 'Один ящик на все кассы: второй сотрудник деньги не пересчитывает' : 'У каждой кассы свой ящик с деньгами');
  } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
});
$('#reg-add').addEventListener('click', async () => {
  const name = prompt('Название новой кассы, например «Касса 2»:');
  if (!name) return;
  try { await api('/api/registers', { method: 'POST', body: { name } }); toast('Касса добавлена'); renderRegisters(); } catch (err) { toast(err.message, 'error'); }
});
// «Журнал продаж кассы» — журнал продаж только с чеками этой кассы.
$('#reg-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reg-sales]');
  if (!b) return;
  salesView.register = { id: Number(b.dataset.regSales), name: b.dataset.regTitle };
  if (location.hash === '#sales') renderSales(); else location.hash = 'sales';
});
$('#reg-list').addEventListener('change', async (e) => {
  const card = e.target.closest('[data-reg]');
  if (!card) return;
  try {
    const boxes = [...card.querySelectorAll('[data-reg-method]')];
    const on = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.regMethod));
    // Все отмечены — без ограничения (новые счета появятся на кассе сами).
    const methods = !boxes.length || on.length === boxes.length ? null : on;
    await api(`/api/registers/${card.dataset.reg}`, { method: 'PUT', body: { name: card.querySelector('[data-reg-name]').value, active: card.querySelector('[data-reg-active]').checked, methods } });
    toast('Сохранено');
  } catch (err) { toast(err.message, 'error'); }
  renderRegisters();
});

// «+ Создать счёт»: счёт для денег (прибыль, сейф, зарплата) — по желанию и кнопкой оплаты на кассе.
$('#acc-new').addEventListener('click', () => {
  const f = $('#acc-new-form');
  f.reset();
  $('#an-error').hidden = true;
  $('#an-fee-row').hidden = true;
  $('#acc-new-dlg').showModal();
  f.elements.name.focus();
});
$('#an-cancel').addEventListener('click', () => $('#acc-new-dlg').close());
$('#acc-new-form').addEventListener('change', (e) => { if (e.target.name === 'pos') $('#an-fee-row').hidden = !e.target.checked; });
$('#acc-new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const m = await api('/api/payment-methods', { method: 'POST', body: { name: f.elements.name.value, kind: f.elements.kind.value, pos: f.elements.pos.checked,
      commission: parseNum(f.elements.commission.value) || 0, opening: parseNum(f.elements.opening.value) || 0 } });
    $('#acc-new-dlg').close();
    toast(`Счёт «${m.name}» создан${m.pos ? ' и появится на кассе' : ''}`);
    renderAccounts();
  } catch (err) { showFormError('#an-error', err); }
});

// Способы оплаты — это и есть счета: настраиваются здесь же (название, тип, комиссия, на кассе ли, порядок).
views.accounts = { show: () => { renderAccounts(); if (session.can('settings')) renderPaymentMethods(); }, right: 'accounts' };
views.registers = { show: renderRegisters, right: ['settings', 'shifts', 'dashboard'] };
