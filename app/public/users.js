'use strict';

// Сотрудники: вход по email, роли, оклад, процент от продаж и план.

let usersList = [];
let editingUser = null;

async function renderUsers() {
  try {
    usersList = await api('/api/users');
  } catch (err) {
    return toast(err.message, 'error');
  }
  const admins = usersList.filter((u) => u.role === 'admin' && !u.disabled).length;
  $('#users-summary').textContent = `${usersList.length} ${plural(usersList.length, ['сотрудник', 'сотрудника', 'сотрудников'])} · ${admins} ${plural(admins, ['администратор', 'администратора', 'администраторов'])}`;
  $('#roles-help').innerHTML = Object.values(session.roles).map((r) => `<li><b>${esc(r.name)}</b> — ${esc(r.about)}</li>`).join('');
  $('#users-body').innerHTML = usersList.length ? usersList.map((u) => `<tr>
      <td><div class="pname">${esc(u.name || u.email)}${session.user?.id === u.id ? ' <span class="muted">(вы)</span>' : ''}</div>${u.name ? `<div class="pcat">${esc(u.email)}</div>` : ''}</td>
      <td><span class="role-tag">${esc(session.roleName(u.role))}</span></td>
      <td>${u.salary ? money(u.salary) : '—'}</td>
      <td>${u.percent ? u.percent + '%' : '—'}</td>
      <td>${u.plan ? money(u.plan) : '—'}</td>
      <td>${u.disabled ? '<span class="muted">Закрыт</span>' : 'Открыт'}</td>
      <td><button type="button" class="btn small ghost" data-user="${u.id}">Изменить</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Сотрудников пока нет. Пока их нет, программа открывается без входа.</td></tr>';
}

function openUserDialog(user = null) {
  editingUser = user;
  const f = $('#user-form');
  f.reset();
  $('#user-dialog-title').textContent = user ? 'Изменить сотрудника' : 'Новый сотрудник';
  $('#uf-password-label').textContent = user ? 'Новый пароль (пусто — не менять)' : 'Пароль, не короче 8 символов';
  f.elements.password.required = !user;
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
    f.elements.percent.value = user.percent || '';
    f.elements.plan.value = user.plan || '';
  }
  showRoleAbout();
  $('#user-dialog').showModal();
}

function showRoleAbout() {
  $('#uf-role-about').textContent = session.roles[$('#uf-role').value]?.about || '';
}
$('#uf-role').addEventListener('change', showRoleAbout);

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    email: f.elements.email.value, name: f.elements.name.value, role: f.elements.role.value,
    salary: parseNum(f.elements.salary.value) || 0, percent: parseNum(f.elements.percent.value) || 0, plan: parseNum(f.elements.plan.value) || 0,
  };
  if (f.elements.password.value) body.password = f.elements.password.value;
  if (editingUser) body.disabled = f.elements.disabled.checked;
  try {
    const saved = await api(editingUser ? `/api/users/${editingUser.id}` : '/api/users', { method: editingUser ? 'PUT' : 'POST', body });
    $('#user-dialog').close();
    toast(editingUser ? 'Сотрудник сохранён' : `Сотрудник ${saved.email} добавлен`);
    // Свою роль или email поменяли — перечитываем, кто вошёл.
    if (session.user?.id === saved.id) return location.reload();
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
    await api(`/api/users/${editingUser.id}`, { method: 'DELETE' });
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
  if (btn) openUserDialog(usersList.find((u) => u.id === Number(btn.dataset.user)));
});

views.users = { show: renderUsers, right: 'staff' };
