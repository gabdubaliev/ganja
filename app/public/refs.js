'use strict';

// Прочее: счета (где лежат деньги и сколько) и кассы (рабочие места, на которых открываются смены).

const ACCOUNT_OPS = { deposit: 'Внесение', withdraw: 'Изъятие', transfer: 'Перевод' };
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
      <div class="acc-head"><b>${a.kind === 'cash' ? '💵' : '💳'} ${esc(a.name)}</b>${a.active ? '' : '<span class="pick-meta">выключен</span>'}</div>
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
  $('#reg-list').innerHTML = list.map((r) => `
    <article class="acc-card ${r.active ? '' : 'off'}" data-reg="${r.id}">
      <div class="acc-head">${edit ? `<input class="input" value="${esc(r.name)}" data-reg-name aria-label="Название кассы">` : `<b>${esc(r.name)}</b>`}
        ${edit ? `<label class="check"><input type="checkbox" data-reg-active ${r.active ? 'checked' : ''}> работает</label>` : ''}</div>
      ${r.open.length ? r.open.map((s) => `<div class="reg-open"><span class="live-dot" aria-hidden="true"></span><b>${esc(s.user)}</b> с ${new Date(s.since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        <div class="pcat">наличными ${money(s.cash)} · безнал ${money(s.card)}</div></div>`).join('') : '<p class="pick-meta">Сейчас смены нет</p>'}
      <p class="pick-meta">Сегодня: ${int(r.today.receipts)} ${plural(r.today.receipts, ['чек', 'чека', 'чеков'])} на ${money(r.today.revenue)}</p>
    </article>`).join('');
}

$('#reg-add').addEventListener('click', async () => {
  const name = prompt('Название новой кассы, например «Касса 2»:');
  if (!name) return;
  try { await api('/api/registers', { method: 'POST', body: { name } }); toast('Касса добавлена'); renderRegisters(); } catch (err) { toast(err.message, 'error'); }
});
$('#reg-list').addEventListener('change', async (e) => {
  const card = e.target.closest('[data-reg]');
  if (!card) return;
  try {
    await api(`/api/registers/${card.dataset.reg}`, { method: 'PUT', body: { name: card.querySelector('[data-reg-name]').value, active: card.querySelector('[data-reg-active]').checked } });
    toast('Сохранено');
  } catch (err) { toast(err.message, 'error'); }
  renderRegisters();
});

views.accounts = { show: renderAccounts, right: 'accounts' };
views.registers = { show: renderRegisters, right: ['settings', 'shifts', 'dashboard'] };
