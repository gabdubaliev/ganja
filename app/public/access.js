'use strict';

// «Права и доступ»: таблица «право × сотрудник». Клетка — одно право одному сотруднику; «✓ Всем» / «✕ Всем» —
// право всем сотрудникам в таблице (с фильтром по роли — только этой роли). Владелец не показывается: у него всё.

const acView = { data: null, role: '', q: '', busy: false };

async function renderAccess() {
  try { acView.data = await api('/api/access'); } catch (err) { return toast(err.message, 'error'); }
  drawAccess();
}

function acUsers() {
  const d = acView.data;
  return d.users.filter((u) => !acView.role || u.role === acView.role);
}

function drawAccess() {
  const d = acView.data;
  const roles = [...new Set(d.users.map((u) => u.role))];
  $('#ac-role').innerHTML = `<option value="">Все роли (${d.users.length})</option>` + roles.map((r) => `<option value="${esc(r)}" ${r === acView.role ? 'selected' : ''}>${esc(d.roles[r] || r)} (${d.users.filter((u) => u.role === r).length})</option>`).join('');
  const users = acUsers();
  const q = acView.q.trim().toLowerCase();
  const userMatch = (u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  const shownUsers = users.some(userMatch) ? users.filter(userMatch) : users;
  const rightMatch = (r, g) => !q || users.some(userMatch) || r.label.toLowerCase().includes(q) || (r.hint || '').toLowerCase().includes(q) || g.name.toLowerCase().includes(q);
  $('#ac-sub').textContent = `${shownUsers.length} ${plural(shownUsers.length, ['сотрудник', 'сотрудника', 'сотрудников'])}${acView.role ? ` · роль «${d.roles[acView.role] || acView.role}»` : ''}`;
  if (!shownUsers.length) { $('#ac-table').innerHTML = '<p class="empty">Сотрудников нет — их заводят в «Сотрудниках».</p>'; return; }
  const head = `<thead><tr><th class="ac-right">Право</th><th class="ac-all">Всем</th>${shownUsers.map((u) => `<th class="ac-user ${u.disabled ? 'off' : ''}" title="${esc(u.email)}"><b>${esc(u.name)}</b><small>${esc(d.roles[u.role] || u.role)}${u.custom ? ' · свои права' : ''}</small>${u.custom ? `<button type="button" class="link" data-ac-reset="${u.id}" title="Права как у роли «${esc(d.roles[u.role] || u.role)}»">как у роли</button>` : ''}</th>`).join('')}</tr></thead>`;
  const body = d.groups.map((g) => {
    const rows = g.rights.filter((r) => rightMatch(r, g));
    if (!rows.length) return '';
    return `<tr class="ac-group"><th colspan="${shownUsers.length + 2}">${esc(g.name)}</th></tr>` + rows.map((r) => {
      const n = shownUsers.filter((u) => u.rights.includes(r.key)).length;
      return `<tr><th class="ac-right"><b>${esc(r.label)}</b>${r.hint ? `<small class="ac-hint">${esc(r.hint)}</small>` : ''}</th>
        <td class="ac-all"><button type="button" class="btn small" data-ac-all="${r.key}" data-on="1" ${n === shownUsers.length ? 'disabled' : ''} title="Дать всем в таблице">✓</button><button type="button" class="btn small ghost" data-ac-all="${r.key}" data-on="0" ${n === 0 ? 'disabled' : ''} title="Убрать у всех в таблице">✕</button><small>${n}/${shownUsers.length}</small></td>
        ${shownUsers.map((u) => `<td class="ac-cell"><input type="checkbox" data-ac-user="${u.id}" data-ac-right="${r.key}" ${u.rights.includes(r.key) ? 'checked' : ''} aria-label="${esc(u.name)}: ${esc(r.label)}"></td>`).join('')}</tr>`;
    }).join('');
  }).join('');
  $('#ac-table').innerHTML = `<table class="ac-table">${head}<tbody>${body}</tbody></table>`;
  acView.shown = shownUsers.map((u) => u.id);
}

async function acChange(userIds, patch, what) {
  if (acView.busy) return;
  acView.busy = true;
  try {
    const r = await api('/api/access', { method: 'POST', body: { userIds, ...patch } });
    acView.data = r;
    toast(`${what}: изменено у ${r.changed} ${plural(r.changed, ['сотрудника', 'сотрудников', 'сотрудников'])}`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    acView.busy = false;
    drawAccess();
  }
}

$('#ac-table').addEventListener('change', (e) => {
  const box = e.target.closest('[data-ac-user]');
  if (!box) return;
  const label = box.getAttribute('aria-label');
  acChange([Number(box.dataset.acUser)], box.checked ? { add: [box.dataset.acRight] } : { remove: [box.dataset.acRight] }, `${box.checked ? 'Дано' : 'Убрано'} — ${label}`);
});
$('#ac-table').addEventListener('click', (e) => {
  const all = e.target.closest('[data-ac-all]');
  if (all) {
    const on = all.dataset.on === '1';
    const right = acView.data.groups.flatMap((g) => g.rights).find((r) => r.key === all.dataset.acAll);
    if (!confirm(`${on ? 'Дать' : 'Убрать'} право «${right.label}» ${on ? '' : 'у '}всем в таблице (${acView.shown.length})?`)) return;
    return acChange(acView.shown, on ? { add: [right.key] } : { remove: [right.key] }, `${on ? 'Дано всем' : 'Убрано у всех'} — ${right.label}`);
  }
  const reset = e.target.closest('[data-ac-reset]');
  if (reset && confirm('Вернуть этому сотруднику права его роли? Его личные галочки сбросятся.')) acChange([Number(reset.dataset.acReset)], { reset: true }, 'Права как у роли');
});
$('#ac-role').addEventListener('change', (e) => { acView.role = e.target.value; drawAccess(); });
let acTimer = null;
$('#ac-q').addEventListener('input', (e) => { acView.q = e.target.value; clearTimeout(acTimer); acTimer = setTimeout(drawAccess, 200); });

views.access = { show: renderAccess, right: 'staff' };
