'use strict';

// CRM: доска сделок по этапам, карточка клиента с историей, задачами и ответом в Instagram.

const CRM_STAGES = [
  ['new', 'Новые'],
  ['contact', 'Связались'],
  ['offer', 'Предложение'],
  ['waiting', 'Ждём оплату'],
  ['won', 'Купили'],
  ['lost', 'Отказ'],
];
const CRM_SOURCES = ['Instagram', 'WhatsApp', 'Telegram', 'Звонок', 'Витрина', 'Магазин', 'Рекомендация', 'Другое'];
const SOURCE_ICON = { Instagram: '📸', WhatsApp: '💬', Telegram: '✈️', Звонок: '📞', Витрина: '🛒', Магазин: '🏬', Рекомендация: '🤝', Другое: '•' };
const crmView = { q: '', source: '', mine: false, list: [], lead: null, kind: 'note', staff: [] };

const stageName = Object.fromEntries(CRM_STAGES);
const shortTime = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function renderCrm() {
  $('#crm-source').innerHTML = '<option value="">Все источники</option>' + CRM_SOURCES.map((s) => `<option ${s === crmView.source ? 'selected' : ''}>${s}</option>`).join('');
  let summary, tasks;
  try {
    [crmView.list, summary, tasks] = await Promise.all([
      api(`/api/crm/leads?q=${encodeURIComponent(crmView.q)}&source=${encodeURIComponent(crmView.source)}&mine=${crmView.mine ? 1 : 0}`),
      api('/api/crm/summary'),
      api(`/api/crm/tasks?mine=${crmView.mine ? 1 : 0}`),
    ]);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const open = crmView.list.filter((l) => !['won', 'lost'].includes(l.stage));
  const inWork = open.reduce((s, l) => s + l.amount, 0);
  $('#crm-sub').textContent = `${open.length} в работе на ${money(inWork)}${summary.conversion !== null ? ` · конверсия за 30 дней ${pct(summary.conversion)}` : ''}${summary.unread ? ` · новых сообщений: ${summary.unread}` : ''}`;

  // Задачи на сегодня и просроченные — сверху, чтобы ничего не забыть.
  $('#crm-tasks').hidden = !tasks.length;
  const now = Date.now();
  $('#crm-tasks').innerHTML = tasks.length ? `<h2>Задачи на сегодня</h2><div class="task-chips">${tasks.map((t) => `
    <button type="button" class="task-chip ${t.due_at < now ? 'late' : ''}" data-open-lead="${t.lead_id}">
      <b>${new Date(t.due_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${t.due_at < dayStart(now).getTime() ? ' · просрочено' : ''}</b>
      <span>${esc(t.text)}</span><span class="pcat">${esc(t.lead_name || t.lead_title)}${t.user_name ? ' · ' + esc(t.user_name) : ''}</span>
    </button>`).join('')}</div>` : '';

  $('#crm-board').innerHTML = CRM_STAGES.map(([key, label]) => {
    const cards = crmView.list.filter((l) => l.stage === key);
    const sum = cards.reduce((s, l) => s + l.amount, 0);
    return `<section class="kanban-col stage-${key}" data-stage="${key}">
      <header><b>${label}</b><span class="count">${cards.length}</span>${sum ? `<span class="pcat">${money(sum)}</span>` : ''}</header>
      <div class="kanban-cards">${cards.map((l) => `
        <article class="lead-card ${l.unread ? 'unread' : ''}" draggable="true" data-lead="${l.id}">
          <div class="lead-card-top"><span title="${esc(l.source)}">${SOURCE_ICON[l.source] || '•'}</span><b>${esc(l.name || (l.instagram ? '@' + l.instagram : '') || phoneFmt(l.phone) || 'Без имени')}</b>${l.unread ? '<span class="dot-new" title="Новое сообщение"></span>' : ''}</div>
          ${l.title ? `<div class="lead-card-title">${esc(l.title)}</div>` : ''}
          ${l.last_event ? `<div class="pcat lead-card-last">${esc(l.last_event.slice(0, 90))}</div>` : ''}
          <div class="lead-card-foot">
            ${l.amount ? `<b>${money(l.amount)}</b>` : '<span></span>'}
            <span class="pcat">${l.next_task_at ? `⏰ ${shortTime(l.next_task_at)}` : esc(l.user_name || '')}</span>
          </div>
        </article>`).join('') || '<p class="kanban-empty">Перетащите сделку сюда</p>'}</div>
    </section>`;
  }).join('');
}

/* ---------- Перетаскивание по этапам (на компьютере) ---------- */
let dragId = null;
$('#crm-board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-lead]');
  if (!card) return;
  dragId = Number(card.dataset.lead);
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('#crm-board').addEventListener('dragend', (e) => e.target.closest('[data-lead]')?.classList.remove('dragging'));
$('#crm-board').addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-stage]');
  if (!col || !dragId) return;
  e.preventDefault();
  for (const c of document.querySelectorAll('.kanban-col.over')) if (c !== col) c.classList.remove('over');
  col.classList.add('over');
});
$('#crm-board').addEventListener('drop', async (e) => {
  const col = e.target.closest('[data-stage]');
  for (const c of document.querySelectorAll('.kanban-col.over')) c.classList.remove('over');
  if (!col || !dragId) return;
  e.preventDefault();
  const id = dragId;
  dragId = null;
  const lead = crmView.list.find((l) => l.id === id);
  if (!lead || lead.stage === col.dataset.stage) return;
  // Для отказа нужна причина — открываем карточку.
  if (col.dataset.stage === 'lost') return openLead(id, 'lost');
  try {
    await api(`/api/crm/leads/${id}`, { method: 'PUT', body: { stage: col.dataset.stage } });
    toast(`${lead.name || 'Сделка'} → ${stageName[col.dataset.stage]}`);
    renderCrm();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#crm-board').addEventListener('click', (e) => {
  const card = e.target.closest('[data-lead]');
  if (card) openLead(Number(card.dataset.lead));
});
$('#crm-tasks').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open-lead]');
  if (btn) openLead(Number(btn.dataset.openLead));
});

/* ---------- Карточка сделки ---------- */
async function openLead(id = null, stage = null) {
  try {
    crmView.staff = await api('/api/staff-list');
    crmView.lead = id ? await api(`/api/crm/leads/${id}`) : null;
  } catch (err) {
    return toast(err.message, 'error');
  }
  const l = crmView.lead;
  const f = $('#lead-form');
  f.reset();
  $('#lead-error').hidden = true;
  $('#lead-title').textContent = l ? l.name || 'Сделка' : 'Новая сделка';
  f.elements.source.innerHTML = CRM_SOURCES.map((s) => `<option>${s}</option>`).join('');
  f.elements.stage.innerHTML = CRM_STAGES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  f.elements.user_id.innerHTML = '<option value="">Никто</option>' + crmView.staff.filter((u) => !u.disabled || u.id === l?.user_id)
    .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  if (l) {
    for (const k of ['title', 'name', 'instagram', 'source', 'stage', 'lost_reason']) f.elements[k].value = l[k] ?? '';
    f.elements.phone.value = l.phone ? phoneFmt(l.phone) : '';
    f.elements.amount.value = l.amount || '';
    f.elements.user_id.value = l.user_id ?? '';
  } else {
    f.elements.user_id.value = session.user?.id ?? '';
    f.elements.stage.value = 'new';
  }
  if (stage) f.elements.stage.value = stage;
  $('#ld-lost-field').hidden = f.elements.stage.value !== 'lost';
  $('#lead-delete').hidden = !l;
  $('#lead-delete').classList.remove('danger');
  $('#lead-delete').textContent = 'Удалить';
  $('#lead-side').hidden = !l;
  $('#lead-dialog').classList.toggle('with-side', Boolean(l));
  renderLeadLinks();
  if (l) {
    renderLeadSide();
    if (l.unread) api(`/api/crm/leads/${l.id}/read`, { method: 'POST' }).then(renderCrm).catch(() => {});
  }
  if (!$('#lead-dialog').open) $('#lead-dialog').showModal();
  if (stage === 'lost') f.elements.lost_reason.focus();
}

// Быстрые связи с клиентом: позвонить, WhatsApp, Instagram, карта покупателя.
function renderLeadLinks() {
  const l = crmView.lead;
  const f = $('#lead-form');
  const tel = (l?.phone || '').replace(/\D/g, '') || f.elements.phone.value.replace(/\D/g, '');
  const ig = (l?.instagram || f.elements.instagram.value).replace(/^@/, '');
  $('#lead-links').innerHTML = [
    tel && `<a class="btn small" href="tel:+${tel}">📞 Позвонить</a>`,
    tel && `<a class="btn small" href="https://wa.me/${tel}" target="_blank" rel="noopener">💬 WhatsApp</a>`,
    ig && `<a class="btn small" href="https://instagram.com/${encodeURIComponent(ig)}" target="_blank" rel="noopener">📸 Instagram</a>`,
    l && (l.customer ? `<span class="role-tag">⭐ Покупатель: бонусов ${int(l.customer.bonus)}</span>` : l.phone ? '<button type="button" class="btn small" id="lead-to-customer">⭐ В покупатели</button>' : ''),
  ].filter(Boolean).join('');
}

function renderLeadSide() {
  const l = crmView.lead;
  const now = Date.now();
  $('#lead-task-list').innerHTML = l.tasks.length ? l.tasks.map((t) => `
    <label class="task ${t.done_at ? 'done' : t.due_at < now ? 'late' : ''}">
      <input type="checkbox" data-task="${t.id}" ${t.done_at ? 'checked' : ''}>
      <span><b>${shortTime(t.due_at)}</b> ${esc(t.text)}${t.user_name ? `<span class="pcat"> · ${esc(t.user_name)}</span>` : ''}</span>
    </label>`).join('') : '<p class="pcat">Задач нет</p>';
  const due = new Date(now + 864e5);
  due.setHours(11, 0, 0, 0);
  $('#lead-task-form').elements.due.value = localInput(due.getTime());
  $('#lead-timeline').innerHTML = l.events.map((e) => `
    <div class="tl tl-${e.kind}">
      <div class="tl-meta">${{ in: '📩', out: '📤', call: '📞', note: '📝', stage: '➡️', system: '•' }[e.kind] || '•'} ${esc(e.user_name || '')} · ${shortTime(e.at)}</div>
      <div class="tl-text">${esc(e.text)}</div>
    </div>`).join('') || '<p class="pcat">Пока пусто</p>';
  const tl = $('#lead-timeline');
  tl.scrollTop = tl.scrollHeight;
  $('#compose-ig').hidden = !l.ig_user_id;
  $('#compose-wa').hidden = !l.wa_id;
  if ((!l.ig_user_id && crmView.kind === 'instagram') || (!l.wa_id && crmView.kind === 'whatsapp')) crmView.kind = 'note';
  renderComposeKind();
}

function renderComposeKind() {
  for (const b of document.querySelectorAll('#compose-kind [data-kind]')) b.setAttribute('aria-pressed', b.dataset.kind === crmView.kind);
  $('#lead-note-form').elements.text.placeholder = { note: 'Что обсудили, о чём договорились', call: 'Итог звонка', instagram: 'Сообщение клиенту в Direct', whatsapp: 'Сообщение клиенту в WhatsApp' }[crmView.kind];
  $('#lead-note-form button[type=submit]').textContent = { instagram: 'Отправить в Instagram', whatsapp: 'Отправить в WhatsApp' }[crmView.kind] || 'Добавить';
}

$('#lead-form').addEventListener('change', (e) => {
  if (e.target.name === 'stage') $('#ld-lost-field').hidden = e.target.value !== 'lost';
  if (['phone', 'instagram'].includes(e.target.name)) renderLeadLinks();
});
$('#lead-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['title', 'name', 'phone', 'instagram', 'source', 'stage', 'lost_reason'].map((k) => [k, f.elements[k].value]));
  body.amount = parseNum(f.elements.amount.value) || 0;
  body.user_id = f.elements.user_id.value ? Number(f.elements.user_id.value) : null;
  const l = crmView.lead;
  try {
    crmView.lead = await api(l ? `/api/crm/leads/${l.id}` : '/api/crm/leads', { method: l ? 'PUT' : 'POST', body });
    toast(l ? 'Сделка сохранена' : 'Сделка создана');
    renderCrm();
    if (l) $('#lead-dialog').close();
    else openLead(crmView.lead.id);
  } catch (err) {
    showFormError('#lead-error', err);
  }
});
$('#lead-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/crm/leads/${crmView.lead.id}`, { method: 'DELETE' });
    $('#lead-dialog').close();
    toast('Сделка удалена');
    renderCrm();
  } catch (err) {
    showFormError('#lead-error', err);
  }
});
$('#lead-close').addEventListener('click', () => $('#lead-dialog').close());
$('#lead-links').addEventListener('click', async (e) => {
  if (e.target.id !== 'lead-to-customer') return;
  try {
    crmView.lead = await api(`/api/crm/leads/${crmView.lead.id}/customer`, { method: 'POST' });
    toast('Клиент добавлен в покупатели');
    renderLeadLinks();
    renderLeadSide();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#lead-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    crmView.lead = await api(`/api/crm/leads/${crmView.lead.id}/tasks`, { method: 'POST', body: { text: f.elements.text.value, due_at: new Date(f.elements.due.value).getTime() } });
    f.elements.text.value = '';
    renderLeadSide();
    renderCrm();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#lead-task-list').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-task]');
  if (!box) return;
  try {
    crmView.lead = await api(`/api/crm/tasks/${box.dataset.task}/toggle`, { method: 'POST' });
    renderLeadSide();
    renderCrm();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#compose-kind').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  crmView.kind = b.dataset.kind;
  renderComposeKind();
});
$('#lead-note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const text = f.elements.text.value;
  const id = crmView.lead.id;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const channel = ['instagram', 'whatsapp'].includes(crmView.kind) ? crmView.kind : null;
    crmView.lead = channel
      ? await api(`/api/crm/leads/${id}/${channel}`, { method: 'POST', body: { text } })
      : await api(`/api/crm/leads/${id}/events`, { method: 'POST', body: { kind: crmView.kind, text } });
    f.elements.text.value = '';
    if (channel) toast(`Сообщение отправлено в ${channel === 'instagram' ? 'Instagram' : 'WhatsApp'}`);
    renderLeadSide();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Поиск и фильтры ---------- */
let crmTimer = null;
$('#crm-search').addEventListener('input', (e) => {
  crmView.q = e.target.value;
  clearTimeout(crmTimer);
  crmTimer = setTimeout(renderCrm, 250);
});
$('#crm-source').addEventListener('change', (e) => { crmView.source = e.target.value; renderCrm(); });
$('#crm-mine').addEventListener('change', (e) => { crmView.mine = e.target.checked; renderCrm(); });
$('#crm-add').addEventListener('click', () => openLead());

// Новое сообщение клиента: обновить доску и открытую карточку.
salesFeed.leadListeners.push((lead) => {
  if (currentView === 'crm') renderCrm();
  if ($('#lead-dialog').open && crmView.lead?.id === lead.id) openLead(lead.id);
});

views.crm = { show: renderCrm, right: 'crm' };
