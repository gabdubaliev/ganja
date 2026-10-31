'use strict';

// Мой табель (окно кассы): сотрудник видит только свой табель за месяц — календарём, без правок.

const MTS_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const mts = (() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1, data: null }; })();
const mtsTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

async function renderMyTimesheet() {
  $('#mts-month').textContent = `${MTS_MONTHS[mts.month - 1]} ${mts.year}`;
  try {
    mts.data = await api(`/api/my-timesheet?year=${mts.year}&month=${mts.month}`);
  } catch (err) {
    $('#mts-grid').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    $('#mts-totals').innerHTML = '';
    return;
  }
  const d = mts.data;
  const row = d.row;
  const u = d.user;
  $('#mts-sub').textContent = [u.name, u.shift_rate ? `${moneyFmt.format(u.shift_rate)} сом за выход` : '', u.percent ? `${u.percent}% от продаж` : '', u.salary ? `оклад ${money(u.salary)} в месяц` : ''].filter(Boolean).join(' · ');

  // Итоги: по выплатным периодам 1–15 и 16–конец и за месяц.
  const halves = row ? row.halves : [null, null];
  const sum = (k) => halves.reduce((s, h) => s + (h?.[k] || 0), 0);
  const tile = (label, value, note = '', cls = '') => `<div class="st-tile ${cls}"><span>${label}</span><b class="num">${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  const half = (h) => (h ? `${int(h.shifts)} ${plural(h.shifts, ['выход', 'выхода', 'выходов'])}${h.fines ? ` · штрафы −${money(h.fines)}` : ''}` : 'нет данных');
  $('#mts-totals').innerHTML = [
    tile('Выходов за месяц', int(sum('shifts')), `смены и оклад ${money(sum('salary'))}`),
    tile('% от продаж и бонусы', money(sum('bonus') + sum('planBonus') + sum('extra')), sum('fines') ? `штрафы −${money(sum('fines'))}` : 'штрафов нет'),
    tile('К выплате 1–15', money(halves[0]?.pay || 0), half(halves[0])),
    tile(`К выплате 16–${d.daysInMonth}`, money(halves[1]?.pay || 0), half(halves[1])),
    tile('Всего за месяц', money(sum('pay')), '', 'accent'),
  ].join('');

  // Календарь: неделя с понедельника.
  const first = new Date(d.year, d.month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const cells = Array.from({ length: lead }, () => '<div class="mts-day empty"></div>');
  for (let day = 1; day <= d.daysInMonth; day++) {
    const date = new Date(d.year, d.month - 1, day);
    const c = row?.days[day];
    const mark = c?.mark;
    const past = date.getTime() < todayStart;
    const isToday = date.getTime() === todayStart;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const cls = ['mts-day', weekend ? 'weekend' : '', isToday ? 'today' : '', mark?.color ? `ts-c-${mark.color}` : ''];
    let body = '';
    const tip = [date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })];
    if (c && (c.worked || c.revenue || c.fines || c.bonuses || (mark?.amount !== null && mark?.amount !== undefined))) {
      cls.push(c.worked ? 'worked' : 'noshift');
      const hours = c.shifts.reduce((s, x) => s + ((x.to || Date.now()) - x.from), 0) / 36e5;
      body = `<span class="mts-status">${c.worked ? (c.shifts.length ? `${int(Math.round(hours * 10) / 10)} ч` : 'рабочий') : mark?.status === 'off' ? 'выходной' : 'без смены'}</span>
        <b class="mts-money num">${moneyFmt.format(Math.round(c.earned))}<small class="mts-cur"> сом</small></b>
        ${c.bonuses || c.fines ? `<span class="ts-dots">${c.bonuses ? '<i class="plus"></i>' : ''}${c.fines ? '<i class="minus"></i>' : ''}</span>` : ''}`;
      if (c.shifts.length) tip.push(`Смена: ${c.shifts.map((s) => `${mtsTime(s.from)}–${s.to ? mtsTime(s.to) : 'не закрыта'}`).join(', ')}`);
      if (c.revenue) tip.push(`Ваши продажи: ${money(c.revenue)}`);
      tip.push(`Заработок за день: ${money(c.earned)}`);
      tip.push(...fineTipLines(c.items));
    } else if (mark?.status === 'off' || past || isToday) {
      cls.push('off');
      body = '<span class="mts-off">В</span>';
      tip.push('выходной');
    } else {
      cls.push('future');
    }
    if (mark?.note) tip.push(`Комментарий: ${mark.note}`);
    cells.push(`<div class="${cls.join(' ')}" title="${esc(tip.join('\n'))}"><span class="mts-num">${day}</span>${body}${mark?.note ? '<span class="mts-note-dot" aria-label="есть комментарий">💬</span>' : ''}</div>`);
  }
  $('#mts-grid').innerHTML = cells.join('');
  const fb = row ? Object.values(row.days).flatMap((c) => c.items || []).sort((a, b) => b.at - a.at) : [];
  $('#mts-fines').innerHTML = `<h2>Штрафы и бонусы за месяц</h2>${finesListHtml(fb, { empty: 'В этом месяце штрафов и бонусов нет' })}`;
}

$('#mts-prev').addEventListener('click', () => { if (--mts.month < 1) { mts.month = 12; mts.year--; } renderMyTimesheet(); });
$('#mts-next').addEventListener('click', () => { if (++mts.month > 12) { mts.month = 1; mts.year++; } renderMyTimesheet(); });

views.mytimesheet = { show: renderMyTimesheet, right: 'mytimesheet' };
