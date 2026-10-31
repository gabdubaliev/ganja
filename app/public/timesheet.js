'use strict';

// Табель: сотрудники × календарные дни месяца, как в Excel. В ячейке — был ли выход,
// часы смены и заработок за день; справа — итоги выплатного периода (1–15 и 16–конец).

const TS_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const tsView = (() => {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, part: now.getDate() < 16 ? 1 : 2, data: null, sel: new Set() };
})();
// Выбранные для правки дни: ключ «сотрудник|ГГГГ-ММ-ДД».
const tsDayKey = (day) => `${tsView.data.year}-${String(tsView.data.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const tsKey = (userId, day) => `${userId}|${tsDayKey(day)}`;
const tsCanEdit = () => session.can('timesheet.edit');

const hoursOf = (shifts) => shifts.reduce((s, x) => s + ((x.to || Date.now()) - x.from), 0) / 36e5;
const timeOf = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Дни, которые видны при выбранной части месяца.
function tsDays() {
  const d = tsView.data;
  const from = tsView.part === 2 ? 16 : 1;
  const to = tsView.part === 1 ? 15 : d.daysInMonth;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
// Выплатные периоды, итоги которых показываются: 0 — с 1 по 15, 1 — с 16 по конец.
const tsHalves = () => (tsView.part === 0 ? [0, 1] : [tsView.part - 1]);

async function renderTimesheet() {
  const { year, month } = tsView;
  $('#ts-month').textContent = `${TS_MONTHS[month - 1]} ${year}`;
  try {
    const data = await api(`/api/timesheet?year=${year}&month=${month}`);
    // Другой месяц — выбор снимается.
    if (!tsView.data || tsView.data.year !== data.year || tsView.data.month !== data.month) tsView.sel.clear();
    tsView.data = data;
  } catch (err) {
    return toast(err.message, 'error');
  }
  const d = tsView.data;
  const last = d.daysInMonth;
  $('#ts-parts').innerHTML = [[1, '1–15'], [2, `16–${last}`], [0, 'Весь месяц']]
    .map(([k, l]) => `<button type="button" data-part="${k}" aria-pressed="${tsView.part === k}">${l}</button>`).join('');
  drawTimesheet();
}

function tsCell(r, day) {
  const d = tsView.data;
  const date = new Date(d.year, d.month - 1, day);
  const c = r.days[day];
  const mark = c?.mark;
  const past = date.getTime() < new Date().setHours(0, 0, 0, 0);
  const isToday = date.toDateString() === new Date().toDateString();
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const key = tsKey(r.user.id, day);
  const cls = ['ts-cell', weekend ? 'weekend' : '', isToday ? 'today' : '', mark?.color ? `ts-c-${mark.color}` : '', tsView.sel.has(key) ? 'ts-selected' : '', tsCanEdit() ? 'ts-editable' : ''];
  const attrs = `data-ts-user="${r.user.id}" data-ts-day="${day}"`;
  const manual = mark && (mark.status || mark.amount !== null) ? '<span class="ts-manual" aria-label="изменено вручную">✎</span>' : '';
  const markTip = mark ? [mark.status === 'off' ? 'Отмечен выходной' : mark.status === 'work' ? 'Отмечен рабочий день' : '', mark.amount !== null && mark.amount !== undefined ? `Сумма за день вручную: ${money(mark.amount)}${c.calc !== undefined && c.calc !== mark.amount ? ` (по расчёту ${money(c.calc)})` : ''}` : '',
    mark.note ? `Комментарий: ${mark.note}` : '', mark.by ? `Изменил: ${mark.by}` : ''].filter(Boolean) : [];
  if (!c || (!c.worked && !c.revenue && !c.fines && !c.bonuses && !(mark?.amount))) {
    // Выходной — отмеченный выходной или прошедший день без смены и без продаж.
    const off = mark?.status === 'off' || past || isToday;
    cls.push(off ? 'off' : 'future');
    return `<td class="${cls.join(' ')}" ${attrs} title="${esc([date.toLocaleDateString('ru-RU'), off ? 'выходной' : '', ...markTip].filter(Boolean).join('\n'))}">${manual}${off ? 'В' : ''}</td>`;
  }
  cls.push(c.worked ? 'worked' : 'noshift');
  const hours = hoursOf(c.shifts);
  const tip = [
    date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }),
    c.shifts.length ? `Смена: ${c.shifts.map((s) => `${timeOf(s.from)}–${s.to ? timeOf(s.to) : 'не закрыта'}`).join(', ')} (${int(hours)} ч)` : 'Смена не открыта',
    c.revenue ? `Выручка: ${money(c.revenue)}` : '',
    `Заработал за день: ${money(c.earned)}`,
    c.bonuses ? `Бонус: +${money(c.bonuses)}` : '',
    c.fines ? `Штраф: −${money(c.fines)}` : '',
    ...markTip,
  ].filter(Boolean).join('\n');
  return `<td class="${cls.join(' ')}" ${attrs} title="${esc(tip)}">${manual}
    <span class="ts-mark">${c.worked ? (c.shifts.length ? `${int(Math.round(hours * 10) / 10)} ч` : 'рабочий') : mark?.status === 'off' ? 'выходной' : mark?.amount !== null && mark?.amount !== undefined && !c.revenue ? 'вручную' : 'без смены'}</span>
    <b class="ts-money">${moneyFmt.format(Math.round(c.earned))}</b>
    ${c.bonuses || c.fines ? `<span class="ts-dots">${c.bonuses ? '<i class="plus" aria-label="бонус"></i>' : ''}${c.fines ? '<i class="minus" aria-label="штраф"></i>' : ''}</span>` : ''}
  </td>`;
}

function tsTotals(r) {
  const halves = tsHalves().map((i) => r.halves[i]).filter(Boolean);
  const sum = (k) => halves.reduce((s, h) => s + (h[k] || 0), 0);
  const fixed = halves.some((h) => Object.keys(h.overrides || {}).length);
  return `<td class="ts-total">${int(sum('shifts'))}</td>
    <td class="ts-total">${moneyFmt.format(Math.round(sum('salary')))}</td>
    <td class="ts-total">${moneyFmt.format(Math.round(sum('bonus')))}</td>
    <td class="ts-total pos-text">${sum('planBonus') + sum('extra') ? '+' + moneyFmt.format(Math.round(sum('planBonus') + sum('extra'))) : ''}</td>
    <td class="ts-total neg">${sum('fines') ? '−' + moneyFmt.format(Math.round(sum('fines'))) : ''}</td>
    ${tsView.part === 0 ? r.halves.map((h) => `<td class="ts-total">${h ? moneyFmt.format(Math.round(h.pay)) : ''}</td>`).join('') : ''}
    <td class="ts-total ts-pay" ${fixed ? 'title="Есть суммы, исправленные вручную в «Отчёты» → «Зарплата»"' : ''}>${money(sum('pay'))}${fixed ? ' ✎' : ''}</td>`;
}

function drawTimesheet() {
  const d = tsView.data;
  const days = tsDays();
  const rows = d.rows;
  const head = days.map((day) => {
    const date = new Date(d.year, d.month - 1, day);
    const cls = [date.getDay() === 0 || date.getDay() === 6 ? 'weekend' : '', date.toDateString() === new Date().toDateString() ? 'today' : ''].join(' ');
    return `<th class="ts-day ${cls} ${tsCanEdit() ? 'ts-editable' : ''}" data-ts-col="${day}" ${tsCanEdit() ? 'title="Выбрать весь столбец"' : ''}>${day}<small>${WEEKDAYS[date.getDay()]}</small></th>`;
  }).join('');
  const halfHeads = tsView.part === 0 ? `<th class="ts-total">1–15</th><th class="ts-total">16–${d.daysInMonth}</th>` : '';
  $('#ts-table').innerHTML = `
    <thead><tr><th class="ts-name">Сотрудник</th>${head}
      <th class="ts-total">Выходов</th><th class="ts-total">Смены и оклад</th><th class="ts-total">% продаж</th><th class="ts-total">Бонусы</th><th class="ts-total">Штрафы</th>${halfHeads}<th class="ts-total ts-pay">К выплате</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr>
      <th class="ts-name ${tsCanEdit() ? 'ts-editable' : ''}" data-ts-row="${r.user.id}" ${tsCanEdit() ? 'title="Выбрать всю строку"' : ''}><span>${esc(r.user.name || r.user.email)}</span><small>${esc(session.roleName(r.user.role))}${r.user.shift_rate ? ` · ${moneyFmt.format(r.user.shift_rate)} за выход` : ''}${r.user.percent ? ` · ${r.user.percent}%` : ''}</small></th>
      ${days.map((day) => tsCell(r, day)).join('')}
      ${tsTotals(r)}
    </tr>`).join('') : `<tr><td colspan="${days.length + 7}" class="empty">Сотрудников пока нет</td></tr>`}</tbody>
    <tfoot><tr><th class="ts-name">На работе / заработали</th>${days.map((day) => {
      const worked = rows.filter((r) => r.days[day]?.worked).length;
      const earned = rows.reduce((s, r) => s + (r.days[day]?.earned || 0), 0);
      return `<td class="ts-cell foot">${worked ? `<span class="ts-mark">${worked} чел.</span><b class="ts-money">${moneyFmt.format(Math.round(earned))}</b>` : ''}</td>`;
    }).join('')}
      ${(() => {
        const halves = tsHalves();
        const sum = (k) => rows.reduce((s, r) => s + halves.reduce((a, i) => a + (r.halves[i]?.[k] || 0), 0), 0);
        return `<td class="ts-total">${int(sum('shifts'))}</td><td class="ts-total">${moneyFmt.format(Math.round(sum('salary')))}</td><td class="ts-total">${moneyFmt.format(Math.round(sum('bonus')))}</td>
          <td class="ts-total pos-text">${moneyFmt.format(Math.round(sum('planBonus') + sum('extra')))}</td><td class="ts-total neg">${sum('fines') ? '−' + moneyFmt.format(Math.round(sum('fines'))) : ''}</td>
          ${tsView.part === 0 ? [0, 1].map((i) => `<td class="ts-total">${moneyFmt.format(Math.round(rows.reduce((s, r) => s + (r.halves[i]?.pay || 0), 0)))}</td>`).join('') : ''}
          <td class="ts-total ts-pay">${money(sum('pay'))}</td>`;
      })()}</tr></tfoot>`;
  const pay = rows.reduce((s, r) => s + tsHalves().reduce((a, i) => a + (r.halves[i]?.pay || 0), 0), 0);
  const label = tsView.part === 0 ? `за ${TS_MONTHS[d.month - 1].toLowerCase()}` : tsView.part === 1 ? `с 1 по 15 ${TS_MONTHS[d.month - 1].toLowerCase()}` : `с 16 по ${d.daysInMonth}`;
  $('#ts-sub').textContent = `К выплате ${label}: ${money(pay)}`;
  renderTsEditbar();
}

/* ---------- Правка табеля: выбор дней и действия над ними ---------- */
function renderTsEditbar() {
  $('#ts-editbar').hidden = !tsCanEdit();
  const n = tsView.sel.size;
  $('#ts-edit-actions').hidden = !n;
  $('#ts-edit-hint').hidden = Boolean(n);
  $('#ts-sel-count').textContent = `Выбрано: ${n} ${plural(n, ['день', 'дня', 'дней'])}`;
}

function tsToggle(keys) {
  // Если выбраны уже все — снимаем, иначе добавляем все.
  const all = keys.every((k) => tsView.sel.has(k));
  for (const k of keys) if (all) tsView.sel.delete(k); else tsView.sel.add(k);
  drawTimesheet();
}

$('#ts-table').addEventListener('click', (e) => {
  if (!tsCanEdit()) return;
  const cell = e.target.closest('[data-ts-user]');
  const row = e.target.closest('[data-ts-row]');
  const col = e.target.closest('[data-ts-col]');
  const days = tsDays();
  if (cell) tsToggle([tsKey(cell.dataset.tsUser, Number(cell.dataset.tsDay))]);
  else if (row) tsToggle(days.map((d) => tsKey(row.dataset.tsRow, d)));
  else if (col) tsToggle(tsView.data.rows.map((r) => tsKey(r.user.id, Number(col.dataset.tsCol))));
});

async function tsApply(body, done = 'Табель изменён') {
  const cells = [...tsView.sel].map((k) => { const [user_id, day] = k.split('|'); return { user_id: Number(user_id), day }; });
  try {
    const r = await api('/api/timesheet/marks', { method: 'PUT', body: { cells, ...body } });
    toast(`${done}: ${r.count} ${plural(r.count, ['день', 'дня', 'дней'])}`);
    // После действия выбор снимается сам.
    tsView.sel.clear();
    await renderTimesheet();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

$('#ts-edit-actions').addEventListener('click', (e) => {
  const sw = e.target.closest('[data-ts-color]');
  if (sw) return tsApply({ color: sw.dataset.tsColor }, sw.dataset.tsColor ? 'Цвет поставлен' : 'Цвет убран');
  const b = e.target.closest('[data-ts-act]');
  if (!b) return;
  const act = b.dataset.tsAct;
  if (act === 'unselect') { tsView.sel.clear(); return drawTimesheet(); }
  if (act === 'work') return tsApply({ status: 'work' }, 'Отмечен рабочий день');
  if (act === 'off') return tsApply({ status: 'off' }, 'Отмечен выходной');
  if (act === 'auto') return tsApply({ status: '' }, 'Выходы — по сменам');
  if (act === 'clear') {
    if (!confirm('Убрать все правки с выбранных дней: отметки, суммы, цвета и комментарии?')) return;
    return tsApply({ clear: true }, 'Правки сняты');
  }
  if (act === 'amount') {
    const f = $('#ts-amount-form');
    f.reset();
    // Если выбран один день со своей суммой — показываем её.
    const [only] = tsView.sel.size === 1 ? [...tsView.sel] : [];
    if (only) {
      const [uid, day] = only.split('|');
      const r = tsView.data.rows.find((x) => x.user.id === Number(uid));
      const c = r?.days[Number(day.slice(8))];
      if (c?.mark?.amount !== null && c?.mark?.amount !== undefined) f.elements.amount.value = String(c.mark.amount).replace('.', ',');
      if (c?.mark?.note) f.elements.note.value = c.mark.note;
      $('#ts-amount-sub').textContent = `${r?.user.name || ''}, ${new Date(fromDateInput(day)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}${c?.calc !== undefined ? ` · по расчёту ${money(c.calc)}` : ''}`;
    } else {
      $('#ts-amount-sub').textContent = `Одна сумма для каждого из выбранных дней: ${tsView.sel.size}.`;
    }
    $('#ts-amount-error').hidden = true;
    $('#ts-amount-dialog').showModal();
    f.elements.amount.focus();
  }
});
$('#ts-amount-cancel').addEventListener('click', () => $('#ts-amount-dialog').close());
$('#ts-amount-reset').addEventListener('click', async () => {
  if (await tsApply({ amount: null }, 'Сумма — снова по расчёту')) $('#ts-amount-dialog').close();
});
$('#ts-amount-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.amount.value.trim() === '') return showFormError('#ts-amount-error', new Error('Впишите сумму или нажмите «Вернуть расчёт»'));
  if (await tsApply({ amount: f.elements.amount.value, note: f.elements.note.value }, 'Сумма за день сохранена')) $('#ts-amount-dialog').close();
});

// Табель в Excel: CSV с разделителем «;» и BOM — Excel открывает его с русскими буквами.
function exportTimesheet() {
  const d = tsView.data;
  const days = tsDays();
  const cellText = (r, day) => {
    const c = r.days[day];
    const past = new Date(d.year, d.month - 1, day).getTime() < Date.now();
    if (!c || (!c.worked && !c.revenue)) return past ? 'В' : '';
    return `${c.worked ? 'Р' : 'б/с'} ${Math.round(c.earned)}`;
  };
  const halves = tsHalves();
  const sum = (r, k) => halves.reduce((a, i) => a + (r.halves[i]?.[k] || 0), 0);
  const lines = [
    [`Табель ${TS_MONTHS[d.month - 1]} ${d.year}`, ...days.map(() => '')],
    ['Сотрудник', ...days.map((day) => `${day} ${WEEKDAYS[new Date(d.year, d.month - 1, day).getDay()]}`), 'Выходов', 'Смены и оклад', '% продаж', 'Бонусы', 'Штрафы', 'К выплате'],
    ...d.rows.map((r) => [r.user.name || r.user.email, ...days.map((day) => cellText(r, day)),
      sum(r, 'shifts'), Math.round(sum(r, 'salary')), Math.round(sum(r, 'bonus')), Math.round(sum(r, 'planBonus') + sum(r, 'extra')), Math.round(sum(r, 'fines')), Math.round(sum(r, 'pay'))]),
    [],
    ['Р — рабочий день и заработок за день, В — выходной, б/с — продажи без открытой смены'],
  ];
  const csv = '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `Табель ${TS_MONTHS[d.month - 1]} ${d.year}${tsView.part ? (tsView.part === 1 ? ' 1-15' : ' 16-' + d.daysInMonth) : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#ts-prev').addEventListener('click', () => {
  if (--tsView.month < 1) { tsView.month = 12; tsView.year--; }
  renderTimesheet();
});
$('#ts-next').addEventListener('click', () => {
  if (++tsView.month > 12) { tsView.month = 1; tsView.year++; }
  renderTimesheet();
});
$('#ts-parts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-part]');
  if (!b) return;
  tsView.part = Number(b.dataset.part);
  renderTimesheet();
});
$('#ts-export').addEventListener('click', () => tsView.data && exportTimesheet());

views.timesheet = { show: renderTimesheet, right: 'timesheet' };
