'use strict';

// Эффективность: кто сколько продал, выполнение плана и зарплата за период.

const KPI_RANGES = {
  today: 'Сегодня',
  week: '7 дней',
  month: 'Этот месяц',
  prev: 'Прошлый месяц',
  days30: '30 дней',
};
const kpiView = { range: 'month' };

function kpiRange(key) {
  const now = new Date();
  const today = dayStart(now).getTime();
  switch (key) {
    case 'today': return [today, Date.now()];
    case 'week': return [addDays(today, -6), Date.now()];
    case 'prev': return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    case 'days30': return [addDays(today, -29), Date.now()];
    default: return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Date.now()];
  }
}

const staffName = (u) => (u ? u.name || u.email : 'Без сотрудника');

async function renderKpi() {
  $('#kpi-ranges').innerHTML = Object.entries(KPI_RANGES).map(([key, label]) =>
    `<button type="button" data-range="${key}" aria-pressed="${key === kpiView.range}">${label}</button>`).join('');
  const [from, to] = kpiRange(kpiView.range);
  let data;
  try {
    data = await api(`/api/kpi?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const staff = data.staff.sort((a, b) => b.revenue - a.revenue);
  const sum = (key) => staff.reduce((s, r) => s + r[key], 0);
  const best = staff.find((r) => r.user && r.revenue > 0);
  const tile = (label, value, note = '') => `<div class="kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="delta">${note}</div></div>`;
  $('#kpi-sub').textContent = `${new Date(from).toLocaleDateString('ru-RU')} — ${new Date(to - 1).toLocaleDateString('ru-RU')}`;
  $('#kpi-cards').innerHTML = [
    tile('Выручка', money(sum('revenue')), `${int(sum('receipts'))} ${plural(sum('receipts'), ['чек', 'чека', 'чеков'])}`),
    tile('Средний чек', sum('receipts') ? money(sum('revenue') / sum('receipts')) : '—'),
    tile('Возвраты', money(sum('refunded')), `${int(sum('refunds'))} ${plural(sum('refunds'), ['чек', 'чека', 'чеков'])}`),
    tile('Фонд оплаты труда', money(sum('pay')), `оклады ${money(sum('salary'))} · проценты ${money(sum('bonus'))}`),
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

  $('#kpi-note').textContent = `Оклад и план заданы на месяц и посчитаны на этот период: ${data.months.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} мес. Процент считается от выручки. Оклад, процент и план меняются в разделе «Сотрудники».`;
  $('#kpi-body').innerHTML = staff.length ? staff.map((r) => `<tr>
      <td><div class="pname">${esc(staffName(r.user))}</div><div class="pcat">${r.user ? esc(session.roleName(r.user.role)) + (r.user.disabled ? ' · доступ закрыт' : '') : 'Чеки, пробитые без входа'}</div></td>
      <td>${int(r.receipts)}</td>
      <td>${money(r.revenue)}</td>
      <td>${r.receipts ? money(r.avg) : '—'}</td>
      <td>${money(r.profit)}</td>
      <td>${r.refunds ? `${int(r.refunds)} на ${money(r.refunded)}` : '—'}</td>
      <td>${r.receipts ? pct(r.loyaltyReceipts / r.receipts) : '—'}</td>
      <td>${r.plan ? `<span class="${r.planDone >= 1 ? 'good' : ''}">${pct(r.planDone)}</span><div class="pcat">из ${money(r.plan)}</div>` : '—'}</td>
      <td>${r.user ? money(r.salary) : '—'}</td>
      <td>${r.user && r.user.percent ? `${money(r.bonus)}<div class="pcat">${r.user.percent}%</div>` : '—'}</td>
      <td><b>${r.user ? money(r.pay) : '—'}</b></td>
    </tr>`).join('') : '<tr><td colspan="11" class="empty">Сотрудников с доступом к кассе пока нет</td></tr>';
  $('#kpi-foot').innerHTML = staff.length > 1 ? `<tr>
      <td><b>Итого</b></td><td>${int(sum('receipts'))}</td><td>${money(sum('revenue'))}</td><td></td><td>${money(sum('profit'))}</td>
      <td>${money(sum('refunded'))}</td><td></td><td></td><td>${money(sum('salary'))}</td><td>${money(sum('bonus'))}</td><td><b>${money(sum('pay'))}</b></td>
    </tr>` : '';
}

$('#kpi-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  kpiView.range = btn.dataset.range;
  renderKpi();
});
// Новая продажа сразу видна в цифрах.
salesFeed.listeners.push(() => { if (currentView === 'kpi') renderKpi(); });

views.kpi = { show: renderKpi, right: 'kpi' };
