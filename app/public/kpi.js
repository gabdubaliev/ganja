'use strict';

// Отчёты: зарплата за выплатный период, топ продавцов и хиты товаров.
// Зарплата = выходы на смену × ставка + месячный оклад за долю месяца + % от продаж − штрафы.

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
    tile('Штрафы', money(sum('fines')), `${int(sum('finesCount'))} ${plural(sum('finesCount'), ['штраф', 'штрафа', 'штрафов'])}`),
    tile('Выручка сотрудников', money(sum('revenue'))),
  ].join('');
  $('#kpi-note').textContent = 'Выход — день, в который сотрудник открывал смену. Ставка, процент и оклад задаются в карточке сотрудника, штрафы — в разделе «Штрафы».';
  $('#pay-body').innerHTML = staff.length ? staff.map((r) => `<tr>
      <td><div class="pname">${esc(staffName(r.user))}</div><div class="pcat">${esc(session.roleName(r.user.role))}${r.user.shift_rate ? ` · ${money(r.user.shift_rate)} за смену` : ''}${r.user.percent ? ` · ${r.user.percent}%` : ''}</div></td>
      <td>${int(r.shifts)}</td>
      <td>${money(r.salary)}</td>
      <td>${money(r.revenue)}</td>
      <td>${r.user.percent ? money(r.bonus) : '—'}</td>
      <td class="${r.fines ? 'neg' : ''}">${r.fines ? '−' + money(r.fines) : '—'}</td>
      <td><b>${money(r.pay)}</b></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Сотрудников пока нет</td></tr>';
  $('#pay-foot').innerHTML = staff.length > 1 ? `<tr><td>Итого</td><td>${int(sum('shifts'))}</td><td>${money(sum('salary'))}</td><td>${money(sum('revenue'))}</td>
    <td>${money(sum('bonus'))}</td><td>${sum('fines') ? '−' + money(sum('fines')) : '—'}</td><td><b>${money(sum('pay'))}</b></td></tr>` : '';
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
      <td><b>${money(r.money)}</b></td><td>${money(r.total)}</td><td>${total ? pct(r.money / total) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">Оплат нет</td></tr>';
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
  const rows = staff.map((r) => `<tr><td>${esc(staffName(r.user))}</td><td>${r.shifts}</td><td>${money(r.salary)}</td><td>${money(r.bonus)}</td><td>${r.fines ? '−' + money(r.fines) : ''}</td><td><b>${money(r.pay)}</b></td><td></td></tr>`).join('');
  const total = staff.reduce((s, r) => s + r.pay, 0);
  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ведомость</title><style>
    body { font: 13px system-ui, Arial, sans-serif; margin: 16mm; color: #000; }
    h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #000; padding: 6px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; } td:last-child { width: 30mm; }
  </style></head><body>
    <h1>Ведомость на выплату зарплаты — ${esc(session.design?.name || '')}</h1>
    <p>Период: ${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}</p>
    <table><thead><tr><th>Сотрудник</th><th>Выходов</th><th>За смены и оклад</th><th>% от продаж</th><th>Штрафы</th><th>К выплате</th><th>Подпись</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="5">Итого</td><td><b>${money(total)}</b></td><td></td></tr></tfoot></table>
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

views.kpi = { show: renderKpi, right: 'kpi' };
