'use strict';

// Смены и штрафы сотрудников.

const shiftsView = { range: 'half', list: [], editing: null };
const finesView = { range: 'half', list: [] };
let staffList = [];

async function loadStaff() {
  staffList = await api('/api/staff-list');
  return staffList;
}

const staffOptions = (selected) => staffList.filter((u) => !u.disabled || u.id === selected)
  .map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)} · ${esc(session.roleName(u.role))}</option>`).join('');

// Значение для <input type="datetime-local"> в местном времени.
const localInput = (t) => (t ? `${dateInput(t)}T${new Date(t).toTimeString().slice(0, 5)}` : '');
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

function duration(ms) {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
}

/* ---------- Смены ---------- */
async function renderShifts() {
  renderRanges($('#shifts-ranges'), ['today', 'week', 'half', 'prevHalf', 'month', 'prevMonth'], shiftsView.range);
  const [from, to] = RANGES[shiftsView.range][1]();
  try {
    shiftsView.list = await api(`/api/shifts?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const list = shiftsView.list;
  const people = new Set(list.map((s) => s.user_id)).size;
  $('#shifts-sub').textContent = `${list.length} ${plural(list.length, ['смена', 'смены', 'смен'])} · ${people} ${plural(people, ['сотрудник', 'сотрудника', 'сотрудников'])}`;
  const edit = session.can('shifts');
  $('#shifts-body').innerHTML = list.length ? list.map((s) => `<tr>
      <td><div class="pname">${esc(s.user_name)}</div>${s.note ? `<div class="pcat">${esc(s.note)}</div>` : ''}${s.edited_by ? `<div class="pcat">исправил: ${esc(s.edited_by)}</div>` : ''}</td>
      <td>${dateTime(s.opened_at)}</td>
      <td>${s.closed_at ? dateTime(s.closed_at) : '<span class="seg-tag regular">идёт сейчас</span>'}</td>
      <td>${duration((s.closed_at || Date.now()) - s.opened_at)}</td>
      <td>${int(s.receipts)}</td>
      <td>${money(s.revenue)}</td>
      <td class="pcat">${money(s.cash)} / ${money(s.card)}</td>
      <td class="shift-cash">${shiftCashCell(s)}</td>
      <td>${edit ? `<button type="button" class="btn small ghost" data-shift="${s.id}">Изменить</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">За этот период смен нет</td></tr>';
}

// Деньги в кассе: при открытии насчитали, при закрытии насчитали / сдали на счёт / оставили; расхождения красным.
function shiftCashCell(s) {
  const diff = (d, note) => (d ? `<div class="${d < 0 ? 'neg' : 'pos'}">${d < 0 ? 'недостача' : 'излишек'} ${money2(Math.abs(d))}${note ? `: ${esc(note)}` : ''}</div>` : '');
  const lines = [];
  if (s.open_cash !== null && s.open_cash !== undefined) lines.push(`<div>открыли: ${money2(s.open_cash)}</div>${diff(s.open_diff, s.open_note)}`);
  if (s.close_counted !== null && s.close_counted !== undefined) {
    lines.push(`<div>насчитали: ${money2(s.close_counted)}</div>${s.deposited ? `<div>сдали на счёт: ${money2(s.deposited)}</div>` : ''}<div>оставили: ${money2(s.left_cash)}</div>${diff(s.close_diff, s.close_note)}`);
  }
  return lines.join('') || '<span class="pcat">—</span>';
}

async function openShiftDialog(shift = null) {
  shiftsView.editing = shift;
  try { await loadStaff(); } catch (err) { return toast(err.message, 'error'); }
  const f = $('#shift-form');
  f.reset();
  $('#shift-title').textContent = shift ? `Смена: ${shift.user_name}` : 'Добавить смену';
  f.elements.user_id.innerHTML = staffOptions(shift?.user_id);
  f.elements.user_id.disabled = Boolean(shift);
  f.elements.opened.value = localInput(shift?.opened_at || dayStart(Date.now()).getTime() + 9 * 36e5);
  f.elements.closed.value = localInput(shift ? shift.closed_at : dayStart(Date.now()).getTime() + 21 * 36e5);
  f.elements.note.value = shift?.note || '';
  $('#shift-delete').hidden = !shift;
  $('#shift-delete').classList.remove('danger');
  $('#shift-delete').textContent = 'Удалить';
  $('#shift-error').hidden = true;
  $('#shift-dialog').showModal();
}

$('#shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { user_id: Number(f.elements.user_id.value), opened_at: fromLocalInput(f.elements.opened.value), closed_at: fromLocalInput(f.elements.closed.value), note: f.elements.note.value };
  const s = shiftsView.editing;
  try {
    await api(s ? `/api/shifts/${s.id}` : '/api/shifts', { method: s ? 'PUT' : 'POST', body });
    $('#shift-dialog').close();
    toast('Смена сохранена');
    renderShifts();
  } catch (err) {
    showFormError('#shift-error', err);
  }
});
$('#shift-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/shifts/${shiftsView.editing.id}`, { method: 'DELETE' });
    $('#shift-dialog').close();
    toast('Смена удалена');
    renderShifts();
  } catch (err) {
    showFormError('#shift-error', err);
  }
});
$('#shift-cancel').addEventListener('click', () => $('#shift-dialog').close());
$('#shift-add').addEventListener('click', () => openShiftDialog());
$('#shifts-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-shift]');
  if (btn) openShiftDialog(shiftsView.list.find((s) => s.id === Number(btn.dataset.shift)));
});
$('#shifts-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  shiftsView.range = btn.dataset.range;
  renderShifts();
});

/* ---------- Штрафы ---------- */
async function renderFines() {
  renderRanges($('#fines-ranges'), ['week', 'half', 'prevHalf', 'month', 'prevMonth'], finesView.range);
  const [from, to] = RANGES[finesView.range][1]();
  try {
    finesView.list = await api(`/api/fines?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const list = finesView.list;
  const total = list.reduce((s, f) => s + f.amount, 0);
  $('#fines-sub').textContent = `${list.length} ${plural(list.length, ['штраф', 'штрафа', 'штрафов'])} на ${money(total)}`;
  const edit = session.can('fines');
  $('#fines-body').innerHTML = list.length ? list.map((f) => `<tr>
      <td>${new Date(f.at).toLocaleDateString('ru-RU')}</td>
      <td><div class="pname">${esc(f.user_name || '—')}</div></td>
      <td class="reason">${esc(f.reason)}</td>
      <td class="neg">${money(f.amount)}</td>
      <td class="pcat">${esc(f.created_by)}<br>${dateTime(f.created_at)}</td>
      <td>${edit ? `<button type="button" class="btn small ghost" data-fine-del="${f.id}">Отменить</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">За этот период штрафов нет</td></tr>';
}

$('#fine-add').addEventListener('click', async () => {
  try { await loadStaff(); } catch (err) { return toast(err.message, 'error'); }
  const f = $('#fine-form');
  f.reset();
  f.elements.user_id.innerHTML = staffOptions();
  f.elements.date.value = dateInput(Date.now());
  $('#fine-error').hidden = true;
  $('#fine-dialog').showModal();
});
$('#fine-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  // Время — полдень выбранного дня: штраф точно попадает в нужный выплатный период.
  const at = fromDateInput(f.elements.date.value) + 12 * 36e5;
  try {
    await api('/api/fines', { method: 'POST', body: { user_id: Number(f.elements.user_id.value), amount: parseNum(f.elements.amount.value), reason: f.elements.reason.value, at } });
    $('#fine-dialog').close();
    toast('Штраф выписан');
    renderFines();
  } catch (err) {
    showFormError('#fine-error', err);
  }
});
$('#fine-cancel').addEventListener('click', () => $('#fine-dialog').close());
$('#fines-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fine-del]');
  if (!btn) return;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Точно отменить?';
    return;
  }
  try {
    await api(`/api/fines/${btn.dataset.fineDel}`, { method: 'DELETE' });
    toast('Штраф отменён');
    renderFines();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#fines-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  finesView.range = btn.dataset.range;
  renderFines();
});

/* ---------- Бонусы сотрудникам ---------- */
const sbonusView = { range: 'half', list: [] };
async function renderBonuses() {
  renderRanges($('#sbonus-ranges'), ['week', 'half', 'prevHalf', 'month', 'prevMonth'], sbonusView.range);
  const [from, to] = RANGES[sbonusView.range][1]();
  try {
    sbonusView.list = await api(`/api/bonuses?from=${from}&to=${to}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const list = sbonusView.list;
  const total = list.reduce((s, f) => s + f.amount, 0);
  $('#sbonus-sub').textContent = `${list.length} ${plural(list.length, ['бонус', 'бонуса', 'бонусов'])} на ${money(total)}`;
  const edit = session.can('bonuses') || session.can('salary');
  $('#sbonus-add').hidden = !edit;
  $('#sbonus-body').innerHTML = list.length ? list.map((f) => `<tr>
      <td>${new Date(f.at).toLocaleDateString('ru-RU')}</td>
      <td><div class="pname">${esc(f.user_name || '—')}</div></td>
      <td class="reason">${esc(f.reason)}</td>
      <td class="pos-text">+${money(f.amount)}</td>
      <td class="pcat">${esc(f.created_by)}<br>${dateTime(f.created_at)}</td>
      <td>${edit ? `<button type="button" class="btn small ghost" data-sbonus-del="${f.id}">Отменить</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">За этот период бонусов нет. Нажмите «🎁 Дать бонус».</td></tr>';
}
$('#sbonus-add').addEventListener('click', async () => {
  try { await loadStaff(); } catch (err) { return toast(err.message, 'error'); }
  const f = $('#sbonus-form');
  f.reset();
  f.elements.user_id.innerHTML = staffOptions();
  f.elements.date.value = dateInput(Date.now());
  $('#sbonus-error').hidden = true;
  $('#sbonus-dialog').showModal();
});
$('#sbonus-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const at = fromDateInput(f.elements.date.value) + 12 * 36e5;
  try {
    await api('/api/bonuses', { method: 'POST', body: { user_id: Number(f.elements.user_id.value), amount: parseNum(f.elements.amount.value), reason: f.elements.reason.value, at } });
    $('#sbonus-dialog').close();
    toast('Бонус начислен');
    renderBonuses();
  } catch (err) {
    showFormError('#sbonus-error', err);
  }
});
$('#sbonus-cancel').addEventListener('click', () => $('#sbonus-dialog').close());
$('#sbonus-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sbonus-del]');
  if (!btn) return;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Точно отменить?';
    return;
  }
  try {
    await api(`/api/bonuses/${btn.dataset.sbonusDel}`, { method: 'DELETE' });
    toast('Бонус отменён');
    renderBonuses();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#sbonus-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  sbonusView.range = btn.dataset.range;
  renderBonuses();
});
views.bonuses = { show: renderBonuses, right: ['bonuses', 'salary', 'kpi'] };

views.shifts = { show: renderShifts, right: ['shifts', 'kpi'] };
views.fines = { show: renderFines, right: ['fines', 'kpi'] };
