'use strict';

// Задания сотрудникам. Каждый видит свои и отмечает «Выполнено»; с правом «Задания» —
// даёт задания, видит все и проверяет: принимает или возвращает на доработку.

const TASK_STATUS = { open: 'В работе', done: 'На проверке', returned: 'На доработке', approved: 'Принято' };
const TASK_PERIOD = { day: 'на день', week: 'на неделю', month: 'на месяц', date: 'к дате' };
const tasksView = { filter: null, list: [], counts: { mine: 0, review: 0 }, period: 'day' };

// Вкладки: свои задания есть у всех, остальные — у того, кто даёт задания.
function taskFilters() {
  const f = [['mine', 'Мои задания', tasksView.counts.mine]];
  if (session.can('tasks')) f.push(['review', 'На проверке', tasksView.counts.review], ['active', 'Все в работе'], ['approved', 'Принятые']);
  return f;
}

async function loadTasks() {
  // Пока сотрудник сам не выбрал вкладку: проверяющему — «На проверке», если есть что проверять, иначе свои.
  const auto = !tasksView.picked;
  const f = auto ? (session.can('tasks') && (tasksView.counts.review || !session.can('pos')) ? 'review' : 'mine') : tasksView.filter;
  tasksView.filter = f;
  const q = f === 'mine' ? 'status=active' : f === 'review' ? 'all=1&status=done' : f === 'approved' ? 'all=1&status=approved' : 'all=1&status=active';
  const r = await api('/api/tasks?' + q);
  tasksView.list = r.tasks;
  const before = tasksView.counts.review;
  tasksView.counts = r.counts;
  updateTaskBadge();
  if (auto && f === 'mine' && session.can('tasks') && r.counts.review && !before) return loadTasks();
}

function updateTaskBadge() {
  const n = tasksView.counts.mine + (session.can('tasks') ? tasksView.counts.review : 0);
  for (const el of document.querySelectorAll('[data-task-badge]')) {
    el.hidden = !n;
    el.textContent = n;
  }
}

const dueText = (t) => {
  const due = new Date(t.due_at - 1);
  const label = t.period === 'day' ? `до конца дня ${due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
    : `до ${due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
  return `${TASK_PERIOD[t.period] || ''} · ${label}`;
};

async function renderTasks() {
  try { await loadTasks(); } catch (err) { return toast(err.message, 'error'); }
  $('#task-add').hidden = !session.can('tasks');
  $('#tasks-filter').innerHTML = taskFilters().map(([k, l, n]) =>
    `<button type="button" data-tf="${k}" aria-pressed="${tasksView.filter === k}">${l}${n ? ` <span class="badge">${n}</span>` : ''}</button>`).join('');
  const reviewer = session.can('tasks');
  const mine = (t) => t.assignee_id === session.user?.id;
  $('#tasks-list').innerHTML = tasksView.list.length ? tasksView.list.map((t) => {
    const overdue = t.status !== 'approved' && t.status !== 'done' && t.due_at < Date.now();
    return `<article class="staff-task ${t.status} ${overdue ? 'overdue' : ''}" data-task="${t.id}">
      ${mine(t) && t.status !== 'approved'
        ? `<label class="task-check" title="${t.status === 'done' ? 'Снять отметку' : 'Отметить выполненным'}"><input type="checkbox" data-task-done ${t.status === 'done' ? 'checked' : ''}><span>Выполнено</span></label>`
        : `<span class="task-check static">${t.status === 'approved' ? '✔' : t.status === 'done' ? '✓' : ''}</span>`}
      <div class="task-body">
        <div class="task-head"><b>${esc(t.title)}</b><span class="task-status ${t.status}">${TASK_STATUS[t.status]}</span>${overdue ? '<span class="task-status overdue">Просрочено</span>' : ''}</div>
        ${t.description ? `<p>${esc(t.description)}</p>` : ''}
        <div class="pick-meta">${tasksView.filter === 'mine' ? '' : `👤 ${esc(t.assignee_name || '—')} · `}${dueText(t)} · дал(а) ${esc(t.created_by || '—')}</div>
        ${t.done_at ? `<div class="task-note">Отмечено ${dateTime(t.done_at)}${t.done_comment ? `: «${esc(t.done_comment)}»` : ''}</div>` : ''}
        ${t.checked_at && t.status !== 'done' ? `<div class="task-note ${t.status}">${t.status === 'approved' ? 'Принял(а)' : 'Вернул(а)'} ${esc(t.checked_by)} ${dateTime(t.checked_at)}${t.check_comment ? `: «${esc(t.check_comment)}»` : ''}</div>` : ''}
        ${reviewer && t.status === 'done' ? `<div class="task-review">
          <input class="input" data-review-comment placeholder="Комментарий (обязателен, если возвращаете)" aria-label="Комментарий к проверке">
          <button type="button" class="btn small primary" data-review="1">Принять</button>
          <button type="button" class="btn small" data-review="0">Вернуть на доработку</button>
        </div>` : ''}
      </div>
      ${reviewer ? `<button type="button" class="icon-btn" data-task-del aria-label="Удалить задание">×</button>` : ''}
    </article>`;
  }).join('') : `<p class="empty">${tasksView.filter === 'mine' ? 'Заданий нет — всё сделано 👍' : tasksView.filter === 'review' ? 'Нечего проверять' : 'Заданий нет'}</p>`;
}

$('#tasks-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tf]');
  if (!b) return;
  tasksView.filter = b.dataset.tf;
  tasksView.picked = true;
  renderTasks();
});

$('#tasks-list').addEventListener('change', async (e) => {
  if (!e.target.matches('[data-task-done]')) return;
  const id = e.target.closest('[data-task]').dataset.task;
  const done = e.target.checked;
  const comment = done ? (prompt('Комментарий для проверяющего (необязательно):') ?? '') : '';
  try {
    await api(`/api/tasks/${id}/done`, { method: 'PUT', body: { done, comment } });
    toast(done ? 'Отмечено. Задание ушло на проверку' : 'Отметка снята');
  } catch (err) { toast(err.message, 'error'); }
  renderTasks();
});

$('#tasks-list').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-task]');
  if (!card) return;
  const review = e.target.closest('[data-review]');
  const del = e.target.closest('[data-task-del]');
  try {
    if (review) {
      const approve = review.dataset.review === '1';
      await api(`/api/tasks/${card.dataset.task}/review`, { method: 'PUT', body: { approve, comment: card.querySelector('[data-review-comment]').value } });
      toast(approve ? 'Задание принято' : 'Задание возвращено на доработку');
    } else if (del) {
      if (!del.classList.contains('danger')) { del.classList.add('danger'); del.textContent = 'Удалить?'; return; }
      await api(`/api/tasks/${card.dataset.task}`, { method: 'DELETE' });
      toast('Задание удалено');
    } else return;
  } catch (err) { return toast(err.message, 'error'); }
  renderTasks();
});

/* ---------- Новое задание ---------- */
$('#task-add').addEventListener('click', async () => {
  let staff;
  try { staff = (await api('/api/staff-list')).filter((u) => !u.disabled); } catch (err) { return toast(err.message, 'error'); }
  const f = $('#task-form');
  f.reset();
  tasksView.period = 'day';
  $('#tk-staff').innerHTML = staff.map((u) => `<label class="check"><input type="checkbox" name="assignees" value="${u.id}"> ${esc(u.name)} <span class="pick-meta">${esc(session.roleName(u.role))}</span></label>`).join('');
  renderTaskPeriod();
  $('#task-error').hidden = true;
  $('#task-dialog').showModal();
  f.elements.title.focus();
});

function renderTaskPeriod() {
  for (const b of $('#tk-period').querySelectorAll('[data-period]')) b.setAttribute('aria-pressed', String(b.dataset.period === tasksView.period));
  $('#tk-date-row').hidden = tasksView.period !== 'date';
}
$('#tk-period').addEventListener('click', (e) => {
  const b = e.target.closest('[data-period]');
  if (!b) return;
  tasksView.period = b.dataset.period;
  renderTaskPeriod();
});
$('#tk-all').addEventListener('click', () => {
  const boxes = [...$('#tk-staff').querySelectorAll('input')];
  const all = boxes.every((i) => i.checked);
  for (const i of boxes) i.checked = !all;
});
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const assignees = [...$('#tk-staff').querySelectorAll('input:checked')].map((i) => Number(i.value));
  // Срок «к дате» — до конца выбранного дня.
  const due = tasksView.period === 'date' && f.elements.due.value ? fromDateInput(f.elements.due.value) + 864e5 : undefined;
  try {
    const made = await api('/api/tasks', { method: 'POST', body: { title: f.elements.title.value, description: f.elements.description.value, assignees, period: tasksView.period, due_at: due } });
    $('#task-dialog').close();
    toast(made.length > 1 ? `Задание дано ${made.length} сотрудникам` : `Задание дано: ${made[0].assignee}`);
    tasksView.filter = 'active';
    tasksView.picked = true;
    renderTasks();
  } catch (err) { showFormError('#task-error', err); }
});
$('#task-cancel').addEventListener('click', () => $('#task-dialog').close());

views.tasks = { show: renderTasks, right: '' };
// Счётчик заданий в меню — сразу после входа.
session.ready.then(() => session.user && loadTasks().catch(() => {}));
