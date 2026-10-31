'use strict';

// ДДС (движение денег по счетам) и прибыль по месяцам. Цифры те же, что на главной («Чистая прибыль») и в «Счетах».

const mn = { tab: 'profit', period: 'last12', account: '', profit: null, cash: null };

function mnRange() {
  const d = new Date();
  if (mn.period === 'last12') return [new Date(d.getFullYear(), d.getMonth() - 11, 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
  const y = Number(mn.period);
  return [new Date(y, 0, 1).getTime(), Math.min(new Date(y + 1, 0, 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime())];
}

async function renderMoney() {
  const y = new Date().getFullYear();
  $('#mn-period').innerHTML = [['last12', 'Последние 12 месяцев'], [String(y), `${y} год`], [String(y - 1), `${y - 1} год`], [String(y - 2), `${y - 2} год`]]
    .map(([v, l]) => `<option value="${v}" ${v === mn.period ? 'selected' : ''}>${l}</option>`).join('');
  for (const b of document.querySelectorAll('[data-mn-tab]')) b.setAttribute('aria-pressed', String(b.dataset.mnTab === mn.tab));
  $('#mn-account').hidden = mn.tab !== 'cash';
  const [from, to] = mnRange();
  try {
    if (mn.tab === 'profit') mn.profit = await api(`/api/reports/profit?from=${from}&to=${to}`);
    else mn.cash = await api(`/api/reports/cashflow?from=${from}&to=${to}${mn.account ? `&account=${mn.account}` : ''}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (mn.tab === 'profit') renderProfitTable(); else renderCashTable();
}

const cell = (v, { sign = false, cls = '' } = {}) => {
  if (!v) return `<td class="${cls}">—</td>`;
  return `<td class="${cls} ${v < 0 ? 'neg' : ''}">${sign && v > 0 ? '+' : ''}${money(v)}</td>`;
};

function renderProfitTable() {
  const ms = mn.profit;
  const sum = (f) => ms.reduce((a, m) => a + f(m), 0);
  const tot = { revenue: sum((m) => m.revenue), cost: sum((m) => m.cost), gross: sum((m) => m.gross), costs: sum((m) => m.costs), net: sum((m) => m.net), receipts: sum((m) => m.receipts), salary: sum((m) => m.salary), fee: sum((m) => m.fee) };
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  $('#mn-sub').textContent = `${ms[0]?.label || ''} — ${ms.at(-1)?.label || ''}`;
  $('#mn-hint').textContent = 'Выручка — без комиссии банков. Прибыль считается по цене закупки проданного товара.';
  $('#mn-tiles').innerHTML = `
    <div class="st-tile"><span>Выручка</span><b class="num">${money(tot.revenue)}</b><small>${int(tot.receipts)} чеков · средний ${money(tot.receipts ? tot.revenue / tot.receipts : 0)}</small></div>
    <div class="st-tile"><span>Валовая прибыль</span><b class="num">${money(tot.gross)}</b><small>маржа ${pct(tot.gross, tot.revenue)}</small></div>
    <div class="st-tile"><span>Расходы</span><b class="num">${money(tot.costs)}</b><small>зарплата ${money(tot.salary)}</small></div>
    <div class="st-tile accent"><span>Чистая прибыль</span><b class="num ${tot.net < 0 ? 'neg' : ''}">${money(tot.net)}</b><small>${pct(tot.net, tot.revenue)} от выручки</small></div>`;
  // Строки статей расходов — объединение по всем месяцам.
  const rec = [...new Set(ms.flatMap((m) => m.recurring.map((r) => r.name)))];
  const exp = [...new Set(ms.flatMap((m) => m.expenses.map((e) => e.category)))];
  const val = (m, kind, name) => (kind === 'rec' ? m.recurring.find((r) => r.name === name)?.amount : m.expenses.find((e) => e.category === name)?.amount) || 0;
  const head = `<tr><th>Статья</th>${ms.map((m) => `<th>${esc(m.label)}</th>`).join('')}<th class="tot">Итого</th></tr>`;
  const row = (label, f, opts = {}) => `<tr class="${opts.cls || ''}"><td>${label}</td>${ms.map((m) => cell(f(m), opts)).join('')}${cell(sum(f), { ...opts, cls: 'tot' })}</tr>`;
  const minus = (f) => (m) => -f(m);
  const rows = [
    row('Выручка', (m) => m.revenue, { cls: 'h' }),
    row('Чеков', (m) => m.receipts, { cls: 'sub' }).replace(/ сом/g, ''),
    row('Комиссия банков (уже вычтена)', (m) => m.fee, { cls: 'sub' }),
    row('Цена закупки проданного', minus((m) => m.cost)),
    row('Валовая прибыль', (m) => m.gross, { cls: 'key' }),
    `<tr class="pct"><td>Маржа</td>${ms.map((m) => `<td>${pct(m.gross, m.revenue)}</td>`).join('')}<td class="tot">${pct(tot.gross, tot.revenue)}</td></tr>`,
    row('Зарплата', minus((m) => m.salary)),
    ...rec.map((n) => row(`${esc(n)} <span class="pcat">постоянный</span>`, minus((m) => val(m, 'rec', n)))),
    ...exp.map((n) => row(esc(n), minus((m) => val(m, 'exp', n)))),
    row('Списания (брак, просрочка)', minus((m) => m.writeoffs)),
    row('Расходы всего', minus((m) => m.costs), { cls: 'h' }),
    row('Чистая прибыль', (m) => m.net, { cls: 'key' }),
    `<tr class="pct"><td>Рентабельность</td>${ms.map((m) => `<td>${pct(m.net, m.revenue)}</td>`).join('')}<td class="tot">${pct(tot.net, tot.revenue)}</td></tr>`,
  ];
  $('#mn-head').innerHTML = head;
  $('#mn-body').innerHTML = rows.join('');
  $('#mn-note').textContent = 'Постоянные расходы (аренда и т. п.) делятся по дням месяца; зарплата — по сменам, окладу и проценту, как в «Отчётах». Разовые расходы вносятся на главной в блоке «Расходы».';
}

function renderCashTable() {
  const d = mn.cash;
  const ms = d.months;
  $('#mn-account').innerHTML = '<option value="">Все счета</option>' + d.accounts.map((a) => `<option value="${a.id}" ${String(a.id) === mn.account ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#mn-sub').textContent = `${ms[0]?.label || ''} — ${ms.at(-1)?.label || ''}${mn.account ? ` · ${d.accounts.find((a) => String(a.id) === mn.account)?.name || ''}` : ' · все счета'}`;
  $('#mn-hint').textContent = mn.account ? 'По одному счёту видны и переводы между счетами.' : 'Переводы между своими счетами (касса → МБАНК) здесь не видны: деньги не пришли и не ушли.';
  const sum = (f) => ms.reduce((a, m) => a + f(m), 0);
  $('#mn-tiles').innerHTML = `
    <div class="st-tile"><span>На начало</span><b class="num">${money(ms[0]?.start || 0)}</b><small>${esc(ms[0]?.label || '')}</small></div>
    <div class="st-tile"><span>Пришло</span><b class="num">+${money(sum((m) => m.inflow))}</b><small>за период</small></div>
    <div class="st-tile"><span>Ушло</span><b class="num">−${money(sum((m) => m.outflow))}</b><small>за период</small></div>
    <div class="st-tile accent"><span>На конец</span><b class="num ${(ms.at(-1)?.end || 0) < 0 ? 'neg' : ''}">${money(ms.at(-1)?.end || 0)}</b><small>сходится со «Счетами»</small></div>`;
  // Статьи — в порядке появления, отдельно поступления и выплаты.
  const keys = (g) => { const seen = new Map(); for (const m of ms) for (const r of m.rows) if (r.group === g && !seen.has(r.key)) seen.set(r.key, r.label); return [...seen]; };
  const v = (m, g, k) => m.rows.find((r) => r.group === g && r.key === k)?.amount || 0;
  const head = `<tr><th>Статья</th>${ms.map((m) => `<th>${esc(m.label)}</th>`).join('')}<th class="tot">Итого</th></tr>`;
  const row = (label, f, opts = {}) => `<tr class="${opts.cls || ''}"><td>${label}</td>${ms.map((m) => cell(f(m), opts)).join('')}${opts.noTotal ? '<td class="tot"></td>' : cell(sum(f), { ...opts, cls: 'tot' })}</tr>`;
  const rows = [
    row('Остаток на начало месяца', (m) => m.start, { cls: 'h', noTotal: true }),
    row('Поступления', (m) => m.inflow, { cls: 'key' }),
    ...keys('in').map(([k, l]) => row(esc(l), (m) => v(m, 'in', k), { cls: 'sub' })),
    row('Выплаты', (m) => -m.outflow, { cls: 'key' }),
    ...keys('out').map(([k, l]) => row(esc(l), (m) => -v(m, 'out', k), { cls: 'sub' })),
    row('Чистый денежный поток', (m) => m.flow, { cls: 'key', sign: true }),
    row('Остаток на конец месяца', (m) => m.end, { cls: 'h', noTotal: true }),
  ];
  $('#mn-head').innerHTML = head;
  $('#mn-body').innerHTML = rows.join('');
  const na = ms.reduce((a, m) => ({ count: a.count + (m.noAccount?.count || 0), amount: a.amount + (m.noAccount?.amount || 0) }), { count: 0, amount: 0 });
  $('#mn-note').textContent = na.count
    ? `Ещё ${na.count} ${plural(na.count, ['расход', 'расхода', 'расходов'])} на ${money(na.amount)} внесены без счёта — в ДДС они не попали. Указывайте счёт у расхода, чтобы деньги сходились.`
    : 'Данные — из чеков, закупок, возвратов, расходов, внесений, изъятий и пересчётов кассы.';
}

$('#mn-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-mn-tab]'); if (b) { mn.tab = b.dataset.mnTab; renderMoney(); } });
$('#mn-period').addEventListener('change', (e) => { mn.period = e.target.value; renderMoney(); });
$('#mn-account').addEventListener('change', (e) => { mn.account = e.target.value; renderMoney(); });
$('#mn-export').addEventListener('click', () => {
  // Таблица как есть: строки и месяцы.
  // Суммы — числами для Excel: без «сом», без пробелов между разрядами, минус обычный.
  const clean = (t, first) => {
    const s = t.replace(/\s+/g, ' ').trim();
    if (first) return s;
    const n = s.replace(/\s*сом$/, '').replace(/[\s+]/g, '').replace('\u2212', '-').replace(',', '.');
    return /^-?\d+(\.\d+)?%?$/.test(n) ? n.replace('.', ',') : s;
  };
  const rows = [...document.querySelectorAll('.mn-table tr')].map((tr) => [...tr.children].map((c, i) => clean(c.textContent, i === 0)));
  csvDownload(`${mn.tab === 'profit' ? 'Прибыль' : 'ДДС'} ${$('#mn-sub').textContent}.csv`, rows[0], rows.slice(1));
});
views.money = { show: renderMoney, right: 'reports.money' };
