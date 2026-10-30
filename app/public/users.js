'use strict';

// Сотрудники: вход по email, роли, оклад, процент от продаж и план.

let usersList = [];
let editingUser = null;
// Владелец смотрит сотрудников любого магазина или всех сразу: 'all' или id магазина.
const usersView = { branch: null };
const multiStore = () => (session.branch?.count || 1) > 1;
const canManageStores = () => multiStore() && session.user?.owner;
const branchName = (id) => session.branch?.allowed?.find((b) => b.id === id)?.name || `Магазин №${id}`;
const branchQuery = (id) => (id && id !== session.branch?.id ? `?branch=${id}` : '');

async function renderUsers() {
  if (usersView.branch === null) usersView.branch = session.branch?.id || 1;
  $('#users-branches').hidden = !canManageStores();
  if (canManageStores()) {
    $('#users-branches').innerHTML = [['all', 'Все магазины'], ...session.branch.allowed.map((b) => [b.id, `🏬 ${b.name}`])]
      .map(([id, l]) => `<button type="button" class="chip" data-users-branch="${id}" aria-pressed="${String(usersView.branch) === String(id)}">${esc(l)}</button>`).join('');
  }
  for (const th of document.querySelectorAll('.users-branch-col')) th.hidden = !multiStore();
  try {
    usersList = await api(usersView.branch === 'all' ? '/api/users?all=1' : `/api/users${branchQuery(usersView.branch)}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const admins = usersList.filter((u) => u.role === 'admin' && !u.disabled).length;
  $('#users-summary').textContent = `${usersList.length} ${plural(usersList.length, ['сотрудник', 'сотрудника', 'сотрудников'])} · ${admins} ${plural(admins, ['администратор', 'администратора', 'администраторов'])}`;
  $('#roles-help').innerHTML = Object.values(session.roles).map((r) => `<li><b>${esc(r.name)}</b> — ${esc(r.about)}</li>`).join('');
  $('#users-body').innerHTML = usersList.length ? usersList.map((u) => `<tr>
      <td><div class="pname">${esc(u.name || u.email)}${session.user?.id === u.id ? ' <span class="muted">(вы)</span>' : ''}</div>${u.name ? `<div class="pcat">${esc(u.email)}</div>` : ''}</td>
      ${multiStore() ? `<td>${esc(u.branchName || '')}${u.stores?.length ? `<div class="pcat">также: ${u.stores.map((id) => esc(branchName(id))).join(', ')}</div>` : ''}</td>` : ''}
      <td><span class="role-tag">${esc(session.roleName(u.role))}</span>${u.rights && u.role !== 'admin' ? '<div class="pcat">свои права</div>' : ''}</td>
      <td>${u.shift_rate ? money(u.shift_rate) : '—'}${u.salary ? `<div class="pcat">+ ${money(u.salary)} в месяц</div>` : ''}</td>
      <td>${u.percent ? u.percent + '%' : '—'}</td>
      <td>${u.plan ? money(u.plan) : '—'}</td>
      <td>${u.disabled ? '<span class="muted">Закрыт</span>' : 'Открыт'}</td>
      <td><button type="button" class="btn small ghost" data-user="${u.id}" data-user-branch="${u.branch || ''}">Изменить</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">Сотрудников пока нет. Пока их нет, программа открывается без входа.</td></tr>';
}

function openUserDialog(user = null) {
  editingUser = user;
  const f = $('#user-form');
  f.reset();
  $('#user-dialog-title').textContent = user ? 'Изменить сотрудника' : 'Новый сотрудник';
  $('#uf-password-label').textContent = user ? 'Новый пароль (пусто — не менять)' : 'Пароль, не короче 8 символов';
  f.elements.password.required = !user;
  $('#uf-pin-label').textContent = user?.hasPin ? 'PIN задан. Новый PIN (пусто — не менять)' : 'PIN для смены кассира, 4–6 цифр';
  $('#uf-pin-clear-row').hidden = !user?.hasPin;
  $('#user-disabled-field').hidden = !user;
  $('#user-delete').hidden = !user || session.user?.id === user.id;
  $('#user-delete').className = 'btn ghost';
  $('#user-delete').textContent = 'Удалить';
  $('#user-error').hidden = true;
  f.elements.role.innerHTML = Object.entries(session.roles).map(([key, r]) => `<option value="${key}">${esc(r.name)}</option>`).join('');
  f.elements.role.value = 'cashier';
  if (user) {
    f.elements.email.value = user.email;
    f.elements.name.value = user.name;
    f.elements.role.value = user.role;
    f.elements.disabled.checked = user.disabled;
    f.elements.salary.value = user.salary || '';
    f.elements.shift_rate.value = user.shift_rate || '';
    f.elements.percent.value = user.percent || '';
    f.elements.plan.value = user.plan || '';
    f.elements.plan_bonus.value = user.plan_bonus || '';
    f.elements.max_discount.value = user.max_discount ?? '';
  }
  showRoleAbout();
  renderRights(user && user.role !== 'admin' ? user.rights : null);
  renderUserMethods(user);
  // Магазин сотрудника — у владельца, когда магазинов несколько.
  $('#uf-branch').hidden = !canManageStores();
  if (canManageStores()) {
    const home = user?.branch || (usersView.branch === 'all' ? session.branch.id : Number(usersView.branch));
    f.elements.home.innerHTML = session.branch.allowed.map((b) => `<option value="${b.id}" ${b.id === home ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
    renderStoreChecks(home, user?.stores || []);
  }
  // Способы оплаты — справочник текущего магазина; у сотрудника другого магазина их не трогаем.
  $('#uf-methods').hidden = Boolean(user && user.branch && user.branch !== session.branch?.id);
  $('#user-dialog').showModal();
}

function renderStoreChecks(home, checked) {
  $('#uf-stores').innerHTML = session.branch.allowed.filter((b) => b.id !== home)
    .map((b) => `<label class="check"><input type="checkbox" value="${b.id}" ${checked.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') || '<span class="pick-meta">других магазинов нет</span>';
}
$('#uf-home').addEventListener('change', (e) => {
  const checked = [...$('#uf-stores').querySelectorAll('input:checked')].map((i) => Number(i.value));
  renderStoreChecks(Number(e.target.value), checked);
});
$('#users-branches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-users-branch]');
  if (!b) return;
  usersView.branch = b.dataset.usersBranch === 'all' ? 'all' : Number(b.dataset.usersBranch);
  renderUsers();
});

function showRoleAbout() {
  $('#uf-role-about').textContent = session.roles[$('#uf-role').value]?.about || '';
}
$('#uf-role').addEventListener('change', () => {
  showRoleAbout();
  // Новая роль — новые галочки по умолчанию.
  renderRights(null);
});

/* ---------- Способы оплаты сотрудника ---------- */
let userMethods = [];

async function renderUserMethods(user) {
  try { userMethods = (await api('/api/payment-methods')).methods; } catch { userMethods = []; }
  const isAdmin = $('#uf-role').value === 'admin';
  const own = user?.payment_methods;
  $('#uf-methods-list').innerHTML = userMethods.map((m) => `
    <label class="check"><input type="checkbox" value="${m.id}" ${isAdmin || !own || own.includes(m.id) ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}> ${esc(m.name)}</label>`).join('')
    + (isAdmin ? '<p class="pcat">Администратор принимает оплату любым способом.</p>' : '');
  $('#uf-methods-all').hidden = isAdmin;
}

// Все галочки стоят — значит «все способы», в том числе те, что добавят позже.
function methodsForSave() {
  if ($('#uf-role').value === 'admin') return null;
  const checked = [...document.querySelectorAll('#uf-methods-list input:checked')].map((i) => Number(i.value));
  if (!checked.length) return [];
  return checked.length === userMethods.length ? null : checked;
}

$('#uf-methods-all').addEventListener('click', () => {
  for (const i of document.querySelectorAll('#uf-methods-list input')) i.checked = true;
});

/* ---------- Права галочками ---------- */
// custom — личный набор прав сотрудника или null (права роли).
function renderRights(custom) {
  const role = $('#uf-role').value;
  const isAdmin = role === 'admin';
  const checked = new Set(isAdmin ? session.rightsList.map((r) => r.key) : custom || session.roles[role].can);
  const groups = groupBy(session.rightsList);
  $('#uf-rights-list').innerHTML = [...groups].map(([group, rights]) => `
    <div class="rights-group"><b>${esc(group)}</b>
      ${rights.map((r) => `<label class="check"><input type="checkbox" value="${r.key}" ${checked.has(r.key) ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}> ${esc(r.label)}</label>`).join('')}
    </div>`).join('');
  $('#uf-rights-reset').hidden = isAdmin;
  markRightsCustom();
}

function groupBy(list) {
  const map = new Map();
  for (const r of list) map.set(r.group, [...(map.get(r.group) || []), r]);
  return map;
}

function checkedRights() {
  return [...document.querySelectorAll('#uf-rights-list input:checked')].map((i) => i.value);
}

// Если галочки совпадают с ролью, сохраняем «как у роли»: тогда изменения роли в будущих версиях дойдут и до сотрудника.
function rightsForSave() {
  const role = $('#uf-role').value;
  if (role === 'admin') return null;
  const mine = checkedRights().sort().join();
  return mine === [...session.roles[role].can].sort().join() ? null : checkedRights();
}

function markRightsCustom() {
  const custom = rightsForSave() !== null;
  $('#uf-rights-reset').textContent = custom ? 'вернуть как у роли' : 'как у роли';
  $('#uf-rights-reset').disabled = !custom;
}

$('#uf-rights-list').addEventListener('change', markRightsCustom);
$('#uf-rights-reset').addEventListener('click', () => renderRights(null));

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    email: f.elements.email.value, name: f.elements.name.value, role: f.elements.role.value,
    shift_rate: parseNum(f.elements.shift_rate.value) || 0, salary: parseNum(f.elements.salary.value) || 0, percent: parseNum(f.elements.percent.value) || 0, plan: parseNum(f.elements.plan.value) || 0, plan_bonus: parseNum(f.elements.plan_bonus.value) || 0,
    max_discount: f.elements.max_discount.value.trim() === '' ? null : parseNum(f.elements.max_discount.value),
    rights: rightsForSave(),
    payment_methods: $('#uf-methods').hidden ? undefined : methodsForSave(),
  };
  if (f.elements.password.value) body.password = f.elements.password.value;
  if (f.elements.pin.value) body.pin = f.elements.pin.value;
  else if (f.elements.clearPin.checked) body.clearPin = true;
  if (editingUser) body.disabled = f.elements.disabled.checked;
  // Магазин: где сотрудник сейчас, куда перевести и куда ещё открыть доступ.
  const stores = canManageStores();
  const from = editingUser?.branch || (stores ? Number(f.elements.home.value) : session.branch?.id);
  const home = stores ? Number(f.elements.home.value) : from;
  const extra = stores ? [...$('#uf-stores').querySelectorAll('input:checked')].map((i) => Number(i.value)) : null;
  try {
    let saved = await api(editingUser ? `/api/users/${editingUser.id}${branchQuery(from)}` : `/api/users${branchQuery(from)}`, { method: editingUser ? 'PUT' : 'POST', body });
    const before = editingUser?.stores || [];
    if (stores && (home !== from || extra.length !== before.length || extra.some((id) => !before.includes(id)))) {
      saved = await api(`/api/users/${saved.id}/branch${branchQuery(from)}`, { method: 'POST', body: { home, stores: extra } });
      if (home !== from) toast(`${saved.name || saved.email} переведён(а) в «${branchName(home)}»`);
    }
    $('#user-dialog').close();
    toast(editingUser ? 'Сотрудник сохранён' : `Сотрудник ${saved.email} добавлен`);
    // Свою роль или email поменяли — перечитываем, кто вошёл.
    if (session.user?.id === saved.id && from === session.branch?.id) return location.reload();
    renderUsers();
  } catch (err) {
    showFormError('#user-error', err);
  }
});

$('#user-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('danger')) {
    btn.className = 'btn danger';
    btn.textContent = 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/users/${editingUser.id}${branchQuery(editingUser.branch)}`, { method: 'DELETE' });
    $('#user-dialog').close();
    toast('Сотрудник удалён');
    renderUsers();
  } catch (err) {
    showFormError('#user-error', err);
  }
});
$('#user-cancel').addEventListener('click', () => $('#user-dialog').close());
$('#user-add').addEventListener('click', () => openUserDialog());
$('#users-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-user]');
  // В списке «Все магазины» id повторяются — сотрудник ищется вместе с магазином.
  if (btn) openUserDialog(usersList.find((u) => u.id === Number(btn.dataset.user) && String(u.branch || '') === btn.dataset.userBranch));
});

views.users = { show: renderUsers, right: 'staff' };
