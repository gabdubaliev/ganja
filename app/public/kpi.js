'use strict';

// Отчёты: зарплата за выплатный период, топ продавцов и хиты товаров.
// Зарплата = выходы на смену × ставка + месячный оклад за долю месяца + % от продаж
//   + бонус за выполнение плана + бонусы, начисленные вручную − штрафы.

const kpiView = { tab: 'pay', range: 'half', from: 0, to: 0, data: null, hits: null, hitsSort: 'revenue', hitsQuery: '' };
const staffName = (u) => (u ? u.name || u.email : 'Без сотрудника');

// Последние 12 выплатных периодов для выбора.
function payHalves() {
  const out = [];
  let r = halfOf(Date.now());
  for (let i = 0; i < 12; i++) {
    out.push(r);
    r = halfOf(r[0] - 1);
  }
  return out;
}

function kpiPeriod() {
  if (kpiView.range === 'custom') return [kpiView.from, kpiView.to];
  return RANGES[kpiView.range][1]();
}

async function renderKpi() {
  renderRanges($('#kpi-ranges'), ['today', 'week', 'half', 'prevHalf', 'month', 'prevMonth'], kpiView.range);
  const halves = payHalves();
  const [from, to] = kpiPeriod();
  $('#kpi-halves').innerHTML = '<option value="">Выплатный период…</option>' +
    halves.map((h) => `<option value="${h[0]}" ${h[0] === from && h[1] === to ? 'selected' : ''}>${halfLabel(h)}</option>`).join('');
  $('#kpi-from').value = dateInput(from);
  $('#kpi-to').value = dateInput(to - 1);
  for (const b of document.querySelectorAll('#report-tabs [data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === kpiView.tab);
  for (const el of document.querySelectorAll('[data-report]')) el.hidden = el.dataset.report !== kpiView.tab;
  $('#kpi-sub').textContent = `${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}`;
  // Период передаётся целиком, даже если он ещё не закончился: месячный оклад и план — на весь период.
  try {
    [kpiView.data, kpiView.hits] = await Promise.all([
      api(`/api/kpi?from=${from}&to=${to}`),
      kpiView.tab === 'products' ? api(`/api/reports/products?from=${from}&to=${to}`) : Promise.resolve(kpiView.hits),
    ]);
    if (kpiView.tab === 'pay' && session.can('salary')) kpiView.bonuses = await api(`/api/bonuses?from=${from}&to=${to}`);
    if (kpiView.tab === 'payments') kpiView.payments = await api(`/api/reports/payments?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  ({ pay: renderPay, sellers: renderSellers, products: renderHits, payments: renderPayments })[kpiView.tab]();
}

const tile = (label, value, note = '') => `<div class="kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="delta">${note}</div></div>`;

function renderPay() {
  const staff = kpiView.data.staff.filter((r) => r.user).sort((a, b) => b.pay - a.pay);
  const sum = (k) => staff.reduce((s, r) => s + r[k], 0);
  $('#kpi-cards').innerHTML = [
    tile('К выплате всем', money(sum('pay')), `${staff.length} ${plural(staff.length, ['сотрудник', 'сотрудника', 'сотрудников'])}`),
    tile('За смены и оклад', money(sum('salary')), `${int(sum('shifts'))} ${plural(sum('shifts'), ['выход', 'выхода', 'выходов'])}`),
    tile('Проценты от продаж', money(sum('bonus'))),
    tile('Бонусы', money(sum('planBonus') + sum('extra')), `за план ${money(sum('planBonus'))} · разовые ${money(sum('extra'))}`),
    tile('Штрафы', money(sum('fines')), `${int(sum('finesCount'))} ${plural(sum('finesCount'), ['штраф', 'штрафа', 'штрафов'])}`),
    tile('Выручка сотрудников', money(sum('revenue'))),
  ].join('');
  const edit = session.can('salary');
  $('#kpi-note').textContent = `Выход — день, в который сотрудник открывал смену. ${edit ? 'Ставку, оклад, процент, план и бонус за план меняет кнопка «Изменить ЗП». Чтобы вписать свою сумму за этот период (при ошибке), нажмите на сумму в таблице' : 'Ставка, процент и оклад задаются в карточке сотрудника'}, штрафы — в разделе «Штрафы».`;
  $('#pay-body').innerHTML = staff.length ? staff.map((r) => `<tr>
      <td><div class="pname">${esc(staffName(r.user))}</div><div class="pcat">${esc(session.roleName(r.user.role))}${r.user.shift_rate ? ` · ${money(r.user.shift_rate)} за смену` : ''}${r.user.percent ? ` · ${r.user.percent}%` : ''}</div>
        ${r.plan ? `<div class="pcat">план ${money(r.plan)} · ${r.planDone >= 1 ? '<b class="pos-text">выполнен</b>' : `выполнено ${pct(r.planDone)}`}${r.user.plan_bonus ? ` · бонус ${money(r.user.plan_bonus)}/мес` : ''}</div>` : ''}</td>
      <td>${int(r.shifts)}</td>
      <td>${fixCell(r, 'salary', money(r.salary))}${r.user.shift_rate || r.overrides.rate || edit ? `<div class="pcat">${fixCell(r, 'rate', `по ${money(r.rate)} за выход`)}</div>` : ''}</td>
      <td>${money(r.revenue)}</td>
      <td>${r.user.percent || r.overrides.bonus ? fixCell(r, 'bonus', money(r.bonus)) : edit ? fixCell(r, 'bonus', '—') : '—'}</td>
      <td>${r.planBonus || r.extra ? `<span class="pos-text">+${money(r.planBonus + r.extra)}</span>${r.planBonus ? `<div class="pcat">за план ${money(r.planBonus)}</div>` : ''}${r.extra ? `<div class="pcat">разовые ${money(r.extra)}</div>` : ''}` : '—'}</td>
      <td class="${r.fines ? 'neg' : ''}">${r.fines ? '−' + money(r.fines) : '—'}</td>
      <td>${fixCell(r, 'pay', `<b>${money(r.pay)}</b>`)}</td>
      ${edit ? `<td class="row-actions"><button type="button" class="btn small ghost" data-pay-edit="${r.user.id}">Изменить ЗП</button><button type="button" class="btn small" data-bonus-for="${r.user.id}">+ Бонус</button></td>` : ''}
    </tr>`).join('') : '<tr><td colspan="9" class="empty">Сотрудников пока нет</td></tr>';
  $('#pay-foot').innerHTML = staff.length > 1 ? `<tr><td>Итого</td><td>${int(sum('shifts'))}</td><td>${money(sum('salary'))}</td><td>${money(sum('revenue'))}</td>
    <td>${money(sum('bonus'))}</td><td>${sum('planBonus') + sum('extra') ? '+' + money(sum('planBonus') + sum('extra')) : '—'}</td><td>${sum('fines') ? '−' + money(sum('fines')) : '—'}</td><td><b>${money(sum('pay'))}</b></td>${edit ? '<td></td>' : ''}</tr>` : '';
  renderBonuses();
}

function renderSellers() {
  const staff = kpiView.data.staff.sort((a, b) => b.revenue - a.revenue);
  const sum = (k) => staff.reduce((s, r) => s + r[k], 0);
  const best = staff.find((r) => r.user && r.revenue > 0);
  $('#kpi-cards').innerHTML = [
    tile('Выручка', money(sum('revenue')), `${int(sum('receipts'))} ${plural(sum('receipts'), ['чек', 'чека', 'чеков'])}`),
    tile('Средний чек', sum('receipts') ? money(sum('revenue') / sum('receipts')) : '—'),
    tile('Прибыль', money(sum('profit'))),
    tile('Возвраты', money(sum('refunded')), `${int(sum('refunds'))} ${plural(sum('refunds'), ['чек', 'чека', 'чеков'])}`),
    tile('Лучший продавец', best ? esc(staffName(best.user)) : '—', best ? money(best.revenue) : 'Продаж пока нет'),
  ].join('');
  const max = Math.max(1, ...staff.map((r) => Math.max(r.revenue, r.plan)));
  $('#kpi-bars').innerHTML = staff.some((r) => r.revenue || r.plan) ? staff.filter((r) => r.revenue || r.plan).map((r) => `
    <div class="kpi-bar">
      <span class="kpi-bar-name">${esc(staffName(r.user))}${r.user ? `<span class="pcat">${esc(session.roleName(r.user.role))}</span>` : ''}</span>
      <span class="kpi-bar-track">
        <i style="width:${(r.revenue / max) * 100}%" class="${r.planDone !== null && r.planDone >= 1 ? 'done' : ''}"></i>
        ${r.plan ? `<b class="kpi-bar-plan" style="left:${(r.plan / max) * 100}%" title="План ${money(r.plan)}"></b>` : ''}
      </span>
      <span class="kpi-bar-value num">${money(r.revenue)}${r.planDone !== null ? ` · ${pct(r.planDone)} плана` : ''}</span>
    </div>`).join('') : '<p class="empty">За этот период продаж нет</p>';
  let place = 0;
  $('#kpi-body').innerHTML = staff.length ? staff.map((r) => `<tr>
      <td>${r.user && r.revenue ? `<b>${++place}</b>` : '—'}</td>
      <td><div class="pname">${esc(staffName(r.user))}</div><div class="pcat">${r.user ? esc(session.roleName(r.user.role)) : 'Чеки, пробитые без входа'}</div></td>
      <td>${int(r.receipts)}</td>
      <td>${money(r.revenue)}</td>
      <td>${r.receipts ? money(r.avg) : '—'}</td>
      <td>${money(r.profit)}</td>
      <td>${r.refunds ? `${int(r.refunds)} на ${money(r.refunded)}` : '—'}</td>
      <td>${r.receipts ? pct(r.loyaltyReceipts / r.receipts) : '—'}</td>
      <td>${r.plan ? `<span class="${r.planDone >= 1 ? 'good' : ''}">${pct(r.planDone)}</span><div class="pcat">из ${money(r.plan)}</div>` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">Продаж нет</td></tr>';
}

const PAY_KIND = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', qr: 'QR-код', other: 'Другое' };

function renderPayments() {
  const rows = kpiView.payments || [];
  const total = rows.reduce((s, r) => s + r.money, 0);
  const cash = rows.filter((r) => r.kind === 'cash').reduce((s, r) => s + r.money, 0);
  const top = rows.find((r) => r.kind !== 'cash');
  $('#kpi-cards').innerHTML = [
    tile('Всего деньгами', money(total), `${int(rows.reduce((s, r) => s + r.receipts, 0))} чеков`),
    tile('Наличными', money(cash), total ? pct(cash / total) : ''),
    tile('Безналичными', money(total - cash), total ? pct((total - cash) / total) : ''),
    tile('Комиссия банков', money(rows.reduce((s, r) => s + r.commission, 0)), `к зачислению ${money(rows.reduce((s, r) => s + r.net, 0))}`),
    tile('Больше всего через', top ? esc(top.name) : '—', top ? money(top.money) : ''),
  ].join('');
  const max = Math.max(1, ...rows.map((r) => r.money));
  $('#pay-bars').innerHTML = rows.length ? rows.map((r) => `
    <div class="kpi-bar">
      <span class="kpi-bar-name">${esc(r.name)}<span class="pcat">${PAY_KIND[r.kind] || ''}</span></span>
      <span class="kpi-bar-track"><i style="width:${(r.money / max) * 100}%"></i></span>
      <span class="kpi-bar-value num">${money(r.money)} · ${total ? pct(r.money / total) : ''}</span>
    </div>`).join('') : '<p class="empty">За этот период оплат нет</p>';
  $('#pay-report-body').innerHTML = rows.map((r) => `<tr>
      <td><div class="pname">${esc(r.name)}</div></td><td>${PAY_KIND[r.kind] || '—'}</td><td>${int(r.receipts)}</td>
      <td><b>${money(r.money)}</b></td><td>${r.commission ? `<span class="neg">−${money(r.commission)}</span>${r.rate ? `<div class="pcat">сейчас ${r.rate}%</div>` : ''}` : '—'}</td><td>${money(r.net)}</td><td>${total ? pct(r.money / total) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Оплат нет</td></tr>';
}

const HITS_SORT = { revenue: 'По выручке', qty: 'По количеству', profit: 'По прибыли', receipts: 'По числу чеков' };

function renderHits() {
  const all = kpiView.hits || [];
  const total = all.reduce((s, r) => s + r.revenue, 0);
  const sorted = [...all].sort((a, b) => b[kpiView.hitsSort] - a[kpiView.hitsSort]);
  const q = kpiView.hitsQuery.trim().toLowerCase();
  const top = sorted[0];
  $('#kpi-cards').innerHTML = [
    tile('Продано товаров', int(all.length), 'разных позиций'),
    tile('Выручка', money(total)),
    tile('Прибыль', money(all.reduce((s, r) => s + r.profit, 0))),
    tile('Хит периода', top ? esc(top.name) : '—', top ? `${qty(top.qty, top.unit || 'шт')} · ${money(top.revenue)}` : 'Продаж нет'),
  ].join('');
  $('#hits-sort').innerHTML = Object.entries(HITS_SORT).map(([k, l]) => `<button type="button" class="chip" data-hits="${k}" aria-pressed="${k === kpiView.hitsSort}">${l}</button>`).join('');
  const rows = sorted.map((r, i) => ({ ...r, place: i + 1 })).filter((r) => !q || r.name.toLowerCase().includes(q));
  $('#hits-body').innerHTML = rows.length ? rows.slice(0, 300).map((r) => `<tr>
      <td><b>${r.place}</b></td>
      <td><div class="pname">${esc(r.name)}</div>${r.category ? `<div class="pcat">${esc(r.category)}</div>` : ''}</td>
      <td>${qty(r.qty, r.unit || 'шт')}</td>
      <td>${int(r.receipts)}</td>
      <td>${money(r.revenue)}</td>
      <td>${money(r.profit)}</td>
      <td>${total ? pct(r.revenue / total) : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">За этот период продаж нет</td></tr>';
}

function printPayroll() {
  const staff = kpiView.data.staff.filter((r) => r.user).sort((a, b) => staffName(a.user).localeCompare(staffName(b.user), 'ru'));
  const [from, to] = kpiPeriod();
  const win = window.open('', '_blank');
  if (!win) return toast('Браузер не дал открыть окно печати. Разрешите всплывающие окна для этого сайта.', 'error');
  const rows = staff.map((r) => `<tr><td>${esc(staffName(r.user))}</td><td>${r.shifts}</td><td>${money(r.salary)}</td><td>${money(r.bonus)}</td><td>${r.planBonus + r.extra ? '+' + money(r.planBonus + r.extra) : ''}</td><td>${r.fines ? '−' + money(r.fines) : ''}</td><td><b>${money(r.pay)}</b></td><td></td></tr>`).join('');
  const total = staff.reduce((s, r) => s + r.pay, 0);
  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ведомость</title><style>
    body { font: 13px system-ui, Arial, sans-serif; margin: 16mm; color: #000; }
    h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #000; padding: 6px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; } td:last-child { width: 30mm; }
  </style></head><body>
    <h1>Ведомость на выплату зарплаты — ${esc(session.design?.name || '')}</h1>
    <p>Период: ${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}</p>
    <table><thead><tr><th>Сотрудник</th><th>Выходов</th><th>За смены и оклад</th><th>% от продаж</th><th>Бонусы</th><th>Штрафы</th><th>К выплате</th><th>Подпись</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="6">Итого</td><td><b>${money(total)}</b></td><td></td></tr></tfoot></table>
    <script>addEventListener('load', () => print());<\/script></body></html>`);
  win.document.close();
}

$('#kpi-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  kpiView.range = btn.dataset.range;
  renderKpi();
});
$('#kpi-halves').addEventListener('change', (e) => {
  if (!e.target.value) return;
  const h = halfOf(Number(e.target.value));
  Object.assign(kpiView, { range: 'custom', from: h[0], to: h[1] });
  renderKpi();
});
for (const id of ['#kpi-from', '#kpi-to']) {
  $(id).addEventListener('change', () => {
    if (!$('#kpi-from').value || !$('#kpi-to').value) return;
    const from = fromDateInput($('#kpi-from').value);
    const to = addDays(fromDateInput($('#kpi-to').value), 1);
    if (to <= from) return toast('Дата «по» должна быть не раньше даты «с»', 'error');
    Object.assign(kpiView, { range: 'custom', from, to });
    renderKpi();
  });
}
$('#report-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  kpiView.tab = btn.dataset.tab;
  renderKpi();
});
$('#hits-sort').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-hits]');
  if (!btn) return;
  kpiView.hitsSort = btn.dataset.hits;
  renderHits();
});
$('#hits-search').addEventListener('input', (e) => { kpiView.hitsQuery = e.target.value; renderHits(); });
$('#pay-print').addEventListener('click', printPayroll);
// Новая продажа сразу видна в цифрах.
salesFeed.listeners.push(() => { if (currentView === 'kpi') renderKpi(); });

/* ---------- Изменение зарплаты и бонусы (право «Зарплата») ---------- */
const FIX_NAMES = { rate: 'Ставка за выход', salary: 'За смены и оклад', bonus: '% от продаж', pay: 'К выплате' };

// Сумма в ведомости: с правом «Зарплата» — кнопка для ручного исправления; исправленная помечена «вручную».
function fixCell(r, field, html) {
  const o = r.overrides?.[field];
  const mark = o ? `<span class="fix-mark" title="${esc(`Исправил ${o.by}${o.reason ? ': ' + o.reason : ''}. По расчёту ${money(r.calc[field])}`)}">✎ вручную · расчёт ${money(r.calc[field])}</span>` : '';
  if (!session.can('salary')) return html + (o ? `<div>${mark}</div>` : '');
  return `<button type="button" class="fix-cell ${o ? 'fixed' : ''}" data-fix="${field}" data-user="${r.user.id}" title="Исправить сумму">${html}</button>${o ? `<div>${mark}</div>` : ''}`;
}

function openFix(userId, field) {
  const r = payRow(userId);
  const o = r.overrides[field];
  const [from, to] = kpiPeriod();
  const f = $('#fix-form');
  Object.assign(f.dataset, { user: userId, field });
  $('#fix-title').textContent = `${FIX_NAMES[field]}: ${staffName(r.user)}`;
  $('#fix-sub').innerHTML = `Период ${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}. По расчёту: <b>${money(r.calc[field])}</b>${field === 'rate' ? ` × ${int(r.shifts)} ${plural(r.shifts, ['выход', 'выхода', 'выходов'])}` : ''}.`
    + (field === 'pay' ? ' Итог заменяет всю сумму к выплате, включая бонусы и штрафы.' : ' Итог к выплате пересчитается.');
  f.elements.amount.value = o ? String(o.amount).replace('.', ',') : '';
  f.elements.amount.placeholder = String(r.calc[field]).replace('.', ',');
  f.elements.reason.value = o?.reason || '';
  $('#fix-reset').hidden = !o;
  $('#fix-error').hidden = true;
  $('#fix-dialog').showModal();
  f.elements.amount.focus();
}

async function saveFix(amount) {
  const f = $('#fix-form');
  const [from, to] = kpiPeriod();
  try {
    await api('/api/pay-override', { method: 'PUT', body: { user_id: Number(f.dataset.user), field: f.dataset.field, from, to, amount, reason: f.elements.reason.value } });
    $('#fix-dialog').close();
    toast(amount === null ? 'Вернули сумму по расчёту' : 'Сумма исправлена');
    renderKpi();
  } catch (err) { showFormError('#fix-error', err); }
}

$('#fix-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = e.target.elements.amount.value.trim();
  if (!v) return showFormError('#fix-error', new Error('Впишите сумму или нажмите «Вернуть расчёт»'));
  saveFix(parseNum(v));
});
$('#fix-reset').addEventListener('click', () => saveFix(null));
$('#fix-cancel').addEventListener('click', () => $('#fix-dialog').close());
function renderBonuses() {
  const list = kpiView.bonuses || [];
  $('#bonus-panel').hidden = !session.can('salary') || !list.length;
  $('#bonus-body').innerHTML = list.map((b) => `<tr>
      <td>${new Date(b.at).toLocaleDateString('ru-RU')}</td>
      <td>${esc(b.user_name || '—')}</td>
      <td>${esc(b.reason)}</td>
      <td class="pos-text"><b>+${money(b.amount)}</b></td>
      <td class="pcat">${esc(b.created_by)}<br>${dateTime(b.created_at)}</td>
      <td><button type="button" class="btn small ghost" data-bonus-del="${b.id}">Отменить</button></td>
    </tr>`).join('');
}

const payRow = (id) => kpiView.data.staff.find((r) => r.user?.id === id);

function openBonus(userId) {
  const f = $('#bonus-form');
  f.reset();
  const staff = kpiView.data.staff.filter((r) => r.user && !r.user.disabled);
  f.elements.user_id.innerHTML = staff.map((r) => `<option value="${r.user.id}">${esc(staffName(r.user))}</option>`).join('');
  if (userId) f.elements.user_id.value = userId;
  // По умолчанию — сегодня, но не позже конца выбранного периода, чтобы бонус попал в эту ведомость.
  const [from, to] = kpiPeriod();
  f.elements.date.value = dateInput(Math.max(from, Math.min(Date.now(), to - 1)));
  $('#bonus-error').hidden = true;
  $('#bonus-dialog').showModal();
  f.elements.amount.focus();
}

function openPay(userId) {
  const u = payRow(userId).user;
  const f = $('#pay-form');
  f.dataset.user = userId;
  $('#pay-title').textContent = `Зарплата: ${staffName(u)}`;
  for (const k of ['shift_rate', 'salary', 'percent', 'plan', 'plan_bonus']) f.elements[k].value = u[k] ? String(u[k]).replace('.', ',') : '';
  $('#pay-error').hidden = true;
  $('#pay-dialog').showModal();
}

$('#bonus-add').addEventListener('click', () => openBonus(null));
$('#pay-body').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-pay-edit]');
  const bonus = e.target.closest('[data-bonus-for]');
  const fix = e.target.closest('[data-fix]');
  if (fix) return openFix(Number(fix.dataset.user), fix.dataset.fix);
  if (edit) openPay(Number(edit.dataset.payEdit));
  if (bonus) openBonus(Number(bonus.dataset.bonusFor));
});
$('#bonus-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/bonuses', { method: 'POST', body: { user_id: Number(f.elements.user_id.value), amount: parseNum(f.elements.amount.value), reason: f.elements.reason.value, at: fromDateInput(f.elements.date.value) + 12 * 36e5 } });
    $('#bonus-dialog').close();
    toast('Бонус начислен');
    renderKpi();
  } catch (err) { showFormError('#bonus-error', err); }
});
$('#pay-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['shift_rate', 'salary', 'percent', 'plan', 'plan_bonus'].map((k) => [k, parseNum(f.elements[k].value) || 0]));
  try {
    await api(`/api/users/${f.dataset.user}/pay`, { method: 'PUT', body });
    $('#pay-dialog').close();
    toast('Зарплата сотрудника изменена');
    renderKpi();
  } catch (err) { showFormError('#pay-error', err); }
});
$('#bonus-cancel').addEventListener('click', () => $('#bonus-dialog').close());
$('#pay-cancel').addEventListener('click', () => $('#pay-dialog').close());
$('#bonus-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bonus-del]');
  if (!btn) return;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Точно отменить?';
    return;
  }
  try {
    await api(`/api/bonuses/${btn.dataset.bonusDel}`, { method: 'DELETE' });
    toast('Бонус отменён');
    renderKpi();
  } catch (err) { toast(err.message, 'error'); }
});

views.kpi = { show: renderKpi, right: ['kpi', 'salary'] };
