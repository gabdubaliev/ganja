'use strict';

// Сотрудники: вход по email, роли «администратор» и «продавец», смена пароля.

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
  $('#users-body').innerHTML = usersList.length ? usersList.map((u) => `<tr>
      <td><div class="pname">${esc(u.name || u.email)}${session.user?.id === u.id ? ' <span class="muted">(вы)</span>' : ''}</div>${u.name ? `<div class="pcat">${esc(u.email)}</div>` : ''}</td>
      <td><span class="role-tag">${ROLE_NAMES[u.role]}</span></td>
      <td>${u.disabled ? '<span class="muted">Закрыт</span>' : 'Открыт'}</td>
      <td>${new Date(u.created_at).toLocaleDateString('ru-RU')}</td>
      <td><button type="button" class="btn small ghost" data-user="${u.id}">Изменить</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Сотрудников пока нет. Пока их нет, программа открывается без входа.</td></tr>';
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
  if (user) {
    f.elements.email.value = user.email;
    f.elements.name.value = user.name;
    f.elements.role.value = user.role;
    f.elements.disabled.checked = user.disabled;
  }
  $('#user-dialog').showModal();
}

function showFormError(id, err) {
  $(id).textContent = err.message;
  $(id).hidden = false;
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { email: f.elements.email.value, name: f.elements.name.value, role: f.elements.role.value };
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

/* ---------- Свой пароль ---------- */
$('#me-password').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-error').hidden = true;
  $('#password-dialog').showModal();
});
$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me/password', { method: 'PUT', body: { current: e.target.elements.current.value, password: e.target.elements.password.value } });
    // Сессия подписана старым паролем и закончилась — входим заново.
    location.replace('/login.html');
  } catch (err) {
    showFormError('#password-error', err);
  }
});
$('#password-cancel').addEventListener('click', () => $('#password-dialog').close());

views.users = { show: renderUsers };
