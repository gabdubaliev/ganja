'use strict';

// CRM: доска сделок по этапам, карточка клиента с историей, задачами и ответом в Instagram.

// Этапы приходят с сервера (CRM → «⚙ Воронка»); до загрузки — воронка магазина одежды.
const CRM_DEFAULT_STAGES = [
  ['new', 'Новое обращение', '#0ea5e9'],
  ['contact', 'Ответили', '#6366f1'],
  ['offer', 'Подобрали размер', '#a855f7'],
  ['waiting', 'Отложили / бронь', '#f59e0b'],
  ['visit', 'Придёт в магазин / доставка', '#14b8a6'],
  ['won', 'Купили', '#16a34a'],
  ['lost', 'Отказ', '#94a3b8'],
];
let CRM_STAGES = CRM_DEFAULT_STAGES.map((x) => [...x]);
const CRM_SOURCES = ['Instagram', 'WhatsApp', 'Telegram', 'Звонок', 'Витрина', 'Магазин', 'Рекомендация', 'Другое'];
const SOURCE_ICON = { Instagram: '📸', WhatsApp: '💬', Telegram: '✈️', Звонок: '📞', Витрина: '🛒', Магазин: '🏬', Рекомендация: '🤝', Другое: '•' };
const crmView = { q: '', source: '', mine: false, list: [], lead: null, kind: 'note', staff: [] };

let stageName = Object.fromEntries(CRM_STAGES);
function applyFunnel(f) {
  if (!f?.stages?.length) return;
  CRM_STAGES = f.stages.map((x) => [x.key, x.name, x.color]);
  stageName = Object.fromEntries(CRM_STAGES);
}
const crmLocalInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 6e4); return d.toISOString().slice(0, 16); };
const shortTime = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function renderCrm() {
  $('#crm-source').innerHTML = '<option value="">Все источники</option>' + CRM_SOURCES.map((s) => `<option ${s === crmView.source ? 'selected' : ''}>${s}</option>`).join('');
  let summary, tasks, funnel;
  try {
    [crmView.list, summary, tasks, funnel] = await Promise.all([
      api(`/api/crm/leads?q=${encodeURIComponent(crmView.q)}&source=${encodeURIComponent(crmView.source)}&mine=${crmView.mine ? 1 : 0}`),
      api('/api/crm/summary'),
      api(`/api/crm/tasks?mine=${crmView.mine ? 1 : 0}`),
      api('/api/crm/funnel'),
    ]);
    applyFunnel(funnel);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const open = crmView.list.filter((l) => !['won', 'lost'].includes(l.stage));
  const inWork = open.reduce((s, l) => s + l.amount, 0);
  updateCrmBadge();
  $('#crm-sub').textContent = `${open.length} в работе на ${money(inWork)}${summary.conversion !== null ? ` · конверсия за 30 дней ${pct(summary.conversion)}` : ''}${summary.unread ? ` · новых сообщений: ${summary.unread}` : ''}`;

  // Задачи на сегодня и просроченные — сверху, чтобы ничего не забыть.
  $('#crm-tasks').hidden = !tasks.length;
  const now = Date.now();
  $('#crm-tasks').innerHTML = tasks.length ? `<h2>Задачи на сегодня</h2><div class="task-chips">${tasks.map((t) => `
    <button type="button" class="task-chip ${t.due_at < now ? 'late' : ''}" data-open-lead="${t.lead_id}">
      <b>${new Date(t.due_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${t.due_at < dayStart(now).getTime() ? ' · просрочено' : ''}</b>
      <span>${esc(t.text)}</span><span class="pcat">${esc(t.lead_name || t.lead_title)}${t.user_name ? ' · ' + esc(t.user_name) : ''}</span>
    </button>`).join('')}</div>` : '';

  const known = new Set(CRM_STAGES.map(([k]) => k));
  $('#crm-board').innerHTML = CRM_STAGES.map(([key, label, color]) => {
    const cards = crmView.list.filter((l) => l.stage === key || (key === 'new' && !known.has(l.stage)));
    const sum = cards.reduce((s, l) => s + l.amount, 0);
    return `<section class="kanban-col stage-${esc(key)}" data-stage="${esc(key)}">
      <header style="border-color:${esc(color || '#64748b')}"><b>${esc(label)}</b><span class="count">${cards.length}</span>${sum ? `<span class="pcat">${money(sum)}</span>` : ''}</header>
      <div class="kanban-cards">${cards.map((l) => `
        <article class="lead-card ${l.unread ? 'unread' : ''}" draggable="true" data-lead="${l.id}">
          <div class="lead-card-top"><span title="${esc(l.source)}">${SOURCE_ICON[l.source] || '•'}</span><b>${esc(l.name || (l.instagram ? '@' + l.instagram : '') || phoneFmt(l.phone) || 'Без имени')}</b>${l.unread ? '<span class="dot-new" title="Новое сообщение"></span>' : ''}</div>
          ${l.title ? `<div class="lead-card-title">${esc(l.title)}</div>` : ''}
          ${l.last_event ? `<div class="pcat lead-card-last">${esc(l.last_event.slice(0, 90))}</div>` : ''}
          <div class="lead-card-foot">
            ${l.amount ? `<b>${money(l.amount)}</b>` : '<span></span>'}
            <span class="pcat">${l.next_task_at ? `⏰ ${shortTime(l.next_task_at)}` : l.user_name ? '👤 ' + esc(l.user_name) : (['won', 'lost'].includes(l.stage) ? '' : '🆓 свободна')}</span>
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
  const prevId = $('#lead-dialog').open ? crmView.lead?.id : null;
  try {
    crmView.staff = await api('/api/staff-list');
    crmView.lead = id ? await api(`/api/crm/leads/${id}`) : null;
  } catch (err) {
    return toast(err.message, 'error');
  }
  const l = crmView.lead;
  // Открыли другую сделку — по умолчанию ответ туда, откуда писал клиент; заметку и звонок кассир выберет сам.
  if (l && l.id !== prevId) crmView.kind = defaultKind(l);
  if (l && l.id !== prevId) prevPriceLead = null;
  const f = $('#lead-form');
  f.reset();
  $('#lead-error').hidden = true;
  $('#lead-title').textContent = l ? l.name || 'Сделка' : 'Новая сделка';
  f.elements.source.innerHTML = CRM_SOURCES.map((s) => `<option>${s}</option>`).join('');
  f.elements.stage.innerHTML = CRM_STAGES.map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('');
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
  $('#lead-task-form').elements.due.value = crmLocalInput(due.getTime());
  $('#lead-timeline').innerHTML = l.events.map((e) => `
    <div class="tl tl-${e.kind}">
      <div class="tl-meta">${{ in: '📩', out: '📤', call: '📞', note: '📝', stage: '➡️', system: '•' }[e.kind] || '•'} ${esc(e.user_name || '')} · ${shortTime(e.at)}</div>
      <div class="tl-text">${esc(e.text)}</div>${leadFiles(e.attach, e.id)}
    </div>`).join('') || '<p class="pcat">Пока пусто</p>';
  const tl = $('#lead-timeline');
  tl.scrollTop = tl.scrollHeight;
  $('#compose-ig').hidden = !l.ig_user_id;
  $('#compose-wa').hidden = !l.wa_id;
  const pf = $('#lead-price-form');
  pf.hidden = !l.ig_user_id && !l.wa_id;
  if (l.id !== prevPriceLead) { pf.reset(); $('#lead-price-preview').hidden = true; prevPriceLead = l.id; }
  // Клиент ответил на сторис — галочка «запомнить для этой сторис» (следующим бот ответит сам).
  let sw = $('#lead-price-story');
  if (!sw) {
    sw = document.createElement('label');
    sw.className = 'check price-ask-story';
    sw.id = 'lead-price-story';
    sw.innerHTML = '<input type="checkbox" checked> Запомнить для этой сторис — следующим, кто ответит на неё, бот пришлёт цену сам';
    $('#lead-price-send').before(sw);
  }
  sw.dataset.story = leadStoryId(l);
  sw.hidden = !sw.dataset.story;
  renderLeadWaits(l);
  if ((!l.ig_user_id && crmView.kind === 'instagram') || (!l.wa_id && crmView.kind === 'whatsapp')) crmView.kind = 'note';
  renderComposeKind();
}

// Вложения из Instagram/WhatsApp: фото и пересланные посты — картинкой, видео и рилсы — плеером, голосовые — аудио.
function leadFiles(raw, eventId) {
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { return ''; }
  if (!list.length) return '';
  const one = (a, i) => {
    // Файлы Meta — через наш сервер (так видео играет и на iPhone); страницы instagram.com — ссылкой.
    const meta = /^https:\/\/[^/]*(fbsbx\.com|fbcdn\.net|cdninstagram\.com|whatsapp\.net)\//i.test(a.url);
    const u = esc(meta ? `/api/crm/file/${eventId}/${i}` : a.url);
    // Ссылка на страницу Instagram (рилс, пост) — файла нет, поэтому показываем встроенный плеер Instagram.
    if (/^https:\/\/(www\.)?instagram\.com\//i.test(a.url)) {
      const code = a.url.match(/\/(p|reels?|tv)\/([A-Za-z0-9_-]+)/);
      const what = ['ig_reel', 'reel'].includes(a.type) || /reel/.test(a.url) ? 'рилс' : 'публикацию';
      const embed = code ? `https://www.instagram.com/${code[1] === 'p' ? 'p' : 'reel'}/${code[2]}/embed/` : '';
      return `<span class="tl-file"><span class="tl-btns">${embed ? `<button type="button" class="btn tl-embed" data-embed="${esc(embed)}">▶ Смотреть ${what} здесь</button>` : ''}<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">↗ Перейти в Instagram</a></span></span>`;
    }
    // Сторис бывает фото или видео (репост рилса) — сначала пробуем картинкой, не вышло — плеером.
    if (a.type === 'story') return `<span class="tl-file" data-story-file="${u}"><button type="button" class="tl-img tl-story" data-full="${u}" aria-label="Сторис, на которую ответил клиент"><img src="${u}" alt="Сторис" loading="lazy" referrerpolicy="no-referrer" onerror="storyAsVideo(this)"></button></span>`;
    if (['video', 'ig_reel', 'reel'].includes(a.type)) return `<span class="tl-file"><video src="${u}" controls preload="metadata" playsinline></video><a href="${u}" target="_blank" rel="noopener noreferrer">Не играет? Открыть видео</a></span>`;
    if (a.type === 'audio') return `<audio src="${u}" controls preload="metadata"></audio>`;
    if (a.type === 'file') return `<a href="${u}" target="_blank" rel="noopener noreferrer">📄 Открыть файл</a>`;
    return `<button type="button" class="tl-img" data-full="${u}" aria-label="Открыть фото крупно"><img src="${u}" alt="Фото клиента" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('button').outerHTML='<span class=&quot;pcat&quot;>Фото не загрузилось — ссылка устарела, смотрите в Instagram</span>'"></button>`;
  };
  return `<div class="tl-files">${list.map(one).join('')}</div>`;
}

function storyAsVideo(img) {
  const box = img.closest('[data-story-file]');
  if (!box) return;
  box.innerHTML = `<video src="${esc(box.dataset.storyFile)}" controls preload="metadata" playsinline></video>`;
  box.querySelector('video').addEventListener('error', () => { box.innerHTML = '<span class="pcat">Сторис уже недоступна (прошли сутки) — смотрите в Instagram</span>'; }, { once: true });
}

// Последняя сторис, на которую ответил клиент (id из вложения), — чтобы запомнить к ней артикулы.
function leadStoryId(l) {
  for (const e of [...(l?.events || [])].reverse()) {
    if (e.kind !== 'in' || !e.attach) continue;
    try { const st = JSON.parse(e.attach).find((a) => a.type === 'story' && a.id); if (st) return st.id; } catch {}
  }
  return '';
}

// Просмотр фото поверх карточки сделки: нажатие — приблизить в этом месте, ещё раз — обратно;
// на телефоне работает и щипок двумя пальцами. Закрыть — ×, Esc или нажатие на тёмный фон.
function crmLightbox(src) {
  let d = document.getElementById('crm-lightbox');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'crm-lightbox';
    d.className = 'lightbox';
    d.innerHTML = '<button type="button" class="lightbox-close" aria-label="Закрыть">×</button><div class="lightbox-stage"><img alt="Фото клиента"></div>';
    document.body.append(d);
    const img = d.querySelector('img');
    d.addEventListener('click', (e) => {
      if (e.target === img) {
        // Приближаем в 2,5 раза к точке нажатия; дальше фото двигается пальцем или прокруткой.
        const r = img.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;
        const fy = (e.clientY - r.top) / r.height;
        const zoomed = img.classList.toggle('zoomed');
        if (zoomed) {
          img.style.width = `${r.width * 2.5}px`;
          const stage = d.querySelector('.lightbox-stage');
          requestAnimationFrame(() => {
            stage.scrollLeft = img.offsetLeft + img.offsetWidth * fx - stage.clientWidth / 2;
            stage.scrollTop = img.offsetTop + img.offsetHeight * fy - stage.clientHeight / 2;
          });
        } else img.style.width = '';
        return;
      }
      d.close();
    });
    d.addEventListener('close', () => { img.classList.remove('zoomed'); img.style.width = ''; });
  }
  const img = d.querySelector('img');
  img.classList.remove('zoomed');
  img.style.width = '';
  img.src = src;
  d.showModal();
}

$('#lead-timeline').addEventListener('click', (e) => {
  const pic = e.target.closest('.tl-img');
  if (pic) return crmLightbox(pic.dataset.full);
  const emb = e.target.closest('.tl-embed');
  if (emb) {
    const f = document.createElement('iframe');
    f.src = emb.dataset.embed;
    f.className = 'tl-embed-frame';
    f.title = 'Рилс из Instagram';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.loading = 'lazy';
    emb.closest('.tl-file').prepend(f);
    emb.remove();
  }
});

function defaultKind(l) {
  if (l.wa_id && (l.source === 'WhatsApp' || !l.ig_user_id)) return 'whatsapp';
  if (l.ig_user_id) return 'instagram';
  return 'note';
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

/* ---------- Лист ожидания в карточке сделки ---------- */
// Клиент ждёт размер, которого нет: выбираем модификацию — когда она поступит, программа сама напишет клиенту.
async function renderLeadWaits(l) {
  let box = $('#lead-waits');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lead-waits';
    box.className = 'lead-waits';
    $('#lead-timeline').previousElementSibling.before(box);
  }
  box.dataset.lead = l.id;
  let list = [];
  try { list = (await api(`/api/waitlist?lead=${l.id}&status=all`)).list; } catch { /* нет права */ return; }
  if (box.dataset.lead !== String(l.id)) return;
  const st = { waiting: '⏳ ждёт', notified: '✅ сообщили', cancelled: 'отменено', bought: '🛍️ купил' };
  box.innerHTML = `<h3>Ждёт размер</h3>
    ${list.length ? `<ul class="wait-list">${list.map((w) => `<li><span>${esc(w.product)} <span class="pcat">· ${st[w.status] || w.status}${w.status === 'waiting' ? ` · на складе ${w.stock}` : w.result ? ` · ${esc(w.result)}` : ''}</span></span>
      ${w.status === 'waiting' ? `<button type="button" class="btn small ghost" data-wait-cancel="${w.id}">Отменить</button>` : ''}</li>`).join('')}</ul>` : ''}
    <div class="wait-add"><input class="input" id="wait-q" placeholder="Артикул или название, например MS-33807 L" autocomplete="off" aria-label="Какой размер ждёт клиент">
    <div class="wait-found" id="wait-found"></div></div>`;
}
let waitTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'wait-q') return;
  clearTimeout(waitTimer);
  waitTimer = setTimeout(async () => {
    const out = $('#wait-found');
    const q = e.target.value.trim();
    if (q.length < 2) { out.innerHTML = ''; return; }
    try {
      const list = await api(`/api/waitlist/search?q=${encodeURIComponent(q)}`);
      out.innerHTML = list.length ? list.map((p) => `<button type="button" class="wait-pick" data-wait-add="${p.id}"><b>${esc(p.label)}</b><span class="pcat">${p.article ? esc(p.article) + ' · ' : ''}${p.stock > 0 ? `есть ${p.stock} шт` : 'нет в наличии'} · ${money(p.price)}</span></button>`).join('')
        : '<p class="pcat">Не нашёл. Попробуйте артикул или часть названия.</p>';
    } catch (err) { out.innerHTML = `<p class="pcat">${esc(err.message)}</p>`; }
  }, 300);
});
document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-wait-add]');
  const cancel = e.target.closest('[data-wait-cancel]');
  if (!add && !cancel) return;
  try {
    if (add) {
      const w = await api('/api/waitlist', { method: 'POST', body: { productId: Number(add.dataset.waitAdd), leadId: crmView.lead.id } });
      toast(w.stock > 0 ? `Добавлено. Этот размер уже есть (${w.stock} шт) — программа напишет клиенту в ближайшие минуты` : 'Добавлено: когда размер поступит, клиенту напишут сами');
    } else {
      await api(`/api/waitlist/${cancel.dataset.waitCancel}/status`, { method: 'POST', body: { status: 'cancelled' } });
    }
    crmView.lead = await api(`/api/crm/leads/${crmView.lead.id}`);
    renderLeadSide();
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------- Окно «Ждут размер»: все клиенты в листе ожидания ---------- */
{
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.id = 'crm-waits';
  btn.textContent = '⏳ Ждут размер';
  $('#crm-add').before(btn);
  btn.addEventListener('click', openWaits);
}
async function openWaits() {
  let d = document.getElementById('waits-dlg');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'waits-dlg';
    d.className = 'stories-dlg';
    d.innerHTML = `<div class="dlg-head"><h2>Лист ожидания</h2><button type="button" class="btn ghost" data-close aria-label="Закрыть">×</button></div>
      <p class="sub">Клиенты, которые ждут размер. Когда товар оприходуют, программа сама пишет клиенту в Instagram или WhatsApp (проверка — каждые 5 минут). Если Instagram не даёт написать (прошло больше суток с последнего сообщения клиента), в сделке появится задача «сообщить клиенту», а в Telegram — уведомление. Добавить клиента — в карточке его сделки, блок «Ждёт размер».</p>
      <div class="seg" id="waits-tabs"><button type="button" data-ws="waiting" aria-pressed="true">Ждут</button><button type="button" data-ws="done" aria-pressed="false">Сообщили / закрыто</button></div>
      <div id="waits-list"><p class="sub">Загружаю…</p></div>
      <details class="waits-text" data-can="crm.settings"><summary>Текст сообщения «Поступил ваш размер»</summary>
        <textarea class="input" id="waits-tpl" rows="4"></textarea>
        <p class="sub">{name} — товар с размером, {price} — цена, {article} — артикул.</p>
        <button type="button" class="btn small primary" id="waits-tpl-save">Сохранить текст</button></details>`;
    document.body.append(d);
    d.addEventListener('click', async (e) => {
      if (e.target === d || e.target.closest('[data-close]')) return d.close();
      const tab = e.target.closest('[data-ws]');
      if (tab) { d.dataset.ws = tab.dataset.ws; return drawWaits(); }
      const set = e.target.closest('[data-wset]');
      if (set) {
        try { await api(`/api/waitlist/${set.dataset.id}/status`, { method: 'POST', body: { status: set.dataset.wset } }); drawWaits(); } catch (err) { toast(err.message, 'error'); }
      }
      const open = e.target.closest('[data-wlead]');
      if (open) { d.close(); openLead(Number(open.dataset.wlead)); }
      if (e.target.id === 'waits-tpl-save') {
        try { await api('/api/waitlist/text', { method: 'PUT', body: { text: $('#waits-tpl').value } }); toast('Текст сохранён'); } catch (err) { toast(err.message, 'error'); }
      }
    });
    for (const el of d.querySelectorAll('[data-can]')) el.hidden = !session.can(el.dataset.can);
  }
  d.dataset.ws = d.dataset.ws || 'waiting';
  d.showModal();
  drawWaits();
}
async function drawWaits() {
  const d = document.getElementById('waits-dlg');
  for (const b of d.querySelectorAll('[data-ws]')) b.setAttribute('aria-pressed', String(b.dataset.ws === d.dataset.ws));
  const box = d.querySelector('#waits-list');
  try {
    const r = await api(`/api/waitlist?status=${d.dataset.ws}`);
    if (document.activeElement !== $('#waits-tpl')) $('#waits-tpl').value = r.text;
    const st = { notified: '✅ сообщили', cancelled: 'отменено', bought: '🛍️ купил' };
    box.innerHTML = r.list.length ? `<ul class="wait-list">${r.list.map((w) => `<li>
        <span><b>${esc(w.product)}</b><br><span class="pcat">${esc(w.lead_name || w.name || 'клиент')}${w.contact ? ' · ' + esc(w.contact) : ''} · с ${shortTime(w.created_at)}${w.status === 'waiting' ? ` · на складе ${w.stock}` : ` · ${st[w.status] || w.status}${w.result ? ' (' + esc(w.result) + ')' : ''}`}</span></span>
        <span class="wait-acts">${w.lead_id ? `<button type="button" class="btn small" data-wlead="${w.lead_id}">Сделка</button>` : ''}
        ${w.status === 'waiting' ? `<button type="button" class="btn small" data-wset="notified" data-id="${w.id}" title="Сообщили сами — убрать из ожидания">Сообщили</button><button type="button" class="btn small ghost" data-wset="cancelled" data-id="${w.id}">Отменить</button>`
          : `<button type="button" class="btn small ghost" data-wset="bought" data-id="${w.id}">Купил</button>`}</span></li>`).join('')}</ul>`
      : `<p class="sub">${d.dataset.ws === 'waiting' ? 'Сейчас никто не ждёт.' : 'Пока пусто.'}</p>`;
  } catch (err) { box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
}

/* ---------- Цена по артикулам с фото клиента ---------- */
let prevPriceLead = null;
// Куда отправить: выбранный канал ответа, иначе — откуда писал клиент.
const priceChannel = () => (['instagram', 'whatsapp'].includes(crmView.kind) ? crmView.kind : defaultKind(crmView.lead));
$('#lead-price-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const articles = e.target.elements.articles.value.trim();
  const box = $('#lead-price-preview');
  if (!articles) return toast('Впишите артикул', 'error');
  try {
    const r = await api(`/api/crm/leads/${crmView.lead.id}/price-preview`, { method: 'POST', body: { articles } });
    box.hidden = false;
    $('#lead-price-text').textContent = r.text || 'Ни один артикул не найден в базе товаров.';
    const miss = $('#lead-price-miss');
    miss.hidden = !r.notFound.length;
    miss.textContent = r.notFound.length ? `Не нашёл в базе: ${r.notFound.join(', ')} — проверьте артикул` : '';
    const send = $('#lead-price-send');
    send.hidden = !r.products.length;
    send.textContent = `Отправить в ${priceChannel() === 'whatsapp' ? 'WhatsApp' : 'Instagram'}`;
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#lead-price-articles').addEventListener('input', () => { $('#lead-price-preview').hidden = true; });
$('#lead-price-send').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const f = $('#lead-price-form');
  btn.disabled = true;
  try {
    const channel = priceChannel();
    const sw = $('#lead-price-story');
    const storyId = sw && !sw.hidden && sw.querySelector('input').checked ? sw.dataset.story : '';
    const r = await api(`/api/crm/leads/${crmView.lead.id}/price-reply`, { method: 'POST', body: { articles: f.elements.articles.value, channel, storyId } });
    crmView.lead = r.lead;
    f.reset();
    $('#lead-price-preview').hidden = true;
    toast(`Цена отправлена в ${channel === 'whatsapp' ? 'WhatsApp' : 'Instagram'}${storyId ? ' · сторис запомнена' : ''}`);
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

/* ---------- Сторис: какие вещи в какой сторис (Instagram не отдаёт программе подпись сторис) ---------- */
{
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.id = 'crm-stories';
  btn.textContent = '📖 Сторис';
  btn.title = 'Указать артикулы к сторис — бот ответит ценой тем, кто ответит на сторис';
  $('#crm-add').before(btn);
  btn.addEventListener('click', openStories);
}
async function openStories() {
  let d = document.getElementById('stories-dlg');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'stories-dlg';
    d.className = 'stories-dlg';
    d.innerHTML = `<div class="dlg-head"><h2>Сторис и артикулы</h2><button type="button" class="btn ghost" data-close aria-label="Закрыть">×</button></div>
      <p class="sub">Instagram не показывает программе подпись сторис — даже если в сторис репост рилса. Впишите к сторис артикулы (MS-101, 69225) или вставьте ссылку на рилс — тогда на «Цена?» в ответ на эту сторис бот сам пришлёт цену. Сторис живёт сутки, привязка — тоже.</p>
      <div id="stories-list"><p class="sub">Загружаю…</p></div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
    d.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-story-save]');
      if (save) {
        const row = save.closest('.story-row');
        const out = row.querySelector('.story-out');
        save.disabled = true;
        try {
          const r = await api(`/api/crm/stories/${row.dataset.id}`, { method: 'PUT', body: { text: row.querySelector('input').value } });
          out.className = 'story-out sub';
          out.textContent = r.products.length ? `✅ Бот ответит: ${r.products.map((p) => `${p.name} — ${Number(p.price).toLocaleString('ru-RU')} сом`).join('; ')}${r.notFound.length ? ` · не нашёл: ${r.notFound.join(', ')}` : ''}` : r.notFound.length ? `⚠️ Не нашёл: ${r.notFound.join(', ')}` : 'Привязка снята';
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          save.disabled = false;
        }
      }
      const pic = e.target.closest('.story-img');
      if (pic) crmLightbox(pic.dataset.full);
    });
  }
  d.showModal();
  const box = d.querySelector('#stories-list');
  box.innerHTML = '<p class="sub">Загружаю…</p>';
  try {
    const list = await api('/api/crm/stories');
    box.innerHTML = list.length ? list.map((x) => `
      <div class="story-row" data-id="${esc(x.id)}">
        ${x.image ? `<button type="button" class="story-img" data-full="${esc(x.image)}" aria-label="Открыть сторис"><img src="${esc(x.image)}" alt="Сторис" referrerpolicy="no-referrer" loading="lazy"></button>` : '<span class="story-img"></span>'}
        <div class="story-body">
          <span class="sub">${x.at ? shortTime(x.at) : ''}${x.type === 'VIDEO' ? ' · видео' : ''}</span>
          <div class="input-row"><input class="input" value="${esc(x.text)}" placeholder="MS-101, 69225 или ссылка на рилс" autocomplete="off"><button type="button" class="btn primary" data-story-save>Сохранить</button></div>
          <p class="story-out sub">${x.text ? '✅ Привязано' : 'Не привязано — бот не знает, что в этой сторис'}</p>
        </div>
      </div>`).join('') : '<p class="sub">Сейчас нет активных сторис (сторис живёт 24 часа).</p>';
  } catch (err) {
    box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

// Значок непрочитанных сделок в меню окна кассы.
function updateCrmBadge() {
  const b = document.getElementById('crm-badge');
  if (!b || !session.can('crm')) return;
  api('/api/crm/summary').then((s) => { b.hidden = !s.unread; b.textContent = s.unread || ''; }).catch(() => {});
}
session.ready.then(updateCrmBadge);

// Новое сообщение клиента: обновить доску и открытую карточку.
salesFeed.leadListeners.push((lead) => {
  updateCrmBadge();
  if (currentView === 'crm') renderCrm();
  if ($('#lead-dialog').open && crmView.lead?.id === lead.id) openLead(lead.id);
});

/* ---------- Настройка воронки и раздачи ---------- */
const cfView = { stages: [], counts: {} };
function cfRender() {
  const open = cfView.stages.filter((x) => !['won', 'lost'].includes(x.key));
  const row = (x, i, fixed) => `<div class="cf-stage ${fixed ? 'fixed' : ''}" data-i="${i}">
      <input type="color" value="${esc(x.color || '#64748b')}" data-cf="color" aria-label="Цвет этапа">
      <input class="input" value="${esc(x.name)}" data-cf="name" maxlength="40" aria-label="Название этапа">
      <span class="pcat">${cfView.counts[x.key] ? `${cfView.counts[x.key]} сд.` : ''}</span>
      ${fixed || i === 0 ? '<span class="pcat cf-tag">' + (i === 0 && !fixed ? 'первый' : 'итог') + '</span>' : `
      <button type="button" class="icon-btn" data-cf-up="${i}" aria-label="Выше" ${i <= 1 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-cf-del="${i}" aria-label="Удалить этап">×</button>`}
    </div>`;
  $('#cf-stages').innerHTML = open.map((x, i) => row(x, i, false)).join('')
    + cfView.stages.filter((x) => ['won', 'lost'].includes(x.key)).map((x) => row(x, cfView.stages.indexOf(x), true)).join('');
}
// Перед перерисовкой — забрать введённые названия и цвета.
function cfCollect() {
  for (const el of $('#cf-stages').querySelectorAll('[data-i]')) {
    const x = cfView.stages[Number(el.dataset.i)];
    if (!x) continue;
    x.name = el.querySelector('[data-cf=name]').value;
    x.color = el.querySelector('[data-cf=color]').value;
  }
}
async function openFunnel() {
  let f;
  try { f = await api('/api/crm/funnel'); } catch (err) { return toast(err.message, 'error'); }
  // Рабочие этапы — сначала, итоговые — в конце; индексы в cfView.stages совпадают с порядком на экране.
  cfView.stages = [...f.stages.filter((x) => !['won', 'lost'].includes(x.key)), ...f.stages.filter((x) => ['won', 'lost'].includes(x.key))].map((x) => ({ ...x }));
  cfView.counts = f.counts || {};
  $('#cf-auto').checked = f.autoAssign;
  $('#cf-free').checked = f.assignFree;
  $('#cf-shift').innerHTML = (f.onShift.length ? `Сейчас на смене и получают сделки: <b>${f.onShift.map((u) => esc(u.name)).join(', ')}</b>.` : 'Сейчас на смене никого нет — новые сделки останутся свободными, пока кто-нибудь не откроет смену.')
    + ' Получают сделки только сотрудники с правом «CRM».'
    + (f.free ? ` Без ответственного: ${f.free}.` : '')
    + (f.onShift.length ? ` <button type="button" class="btn small" id="cf-assign">Распределить поровну сейчас</button>` : '');
  cfRender();
  $('#crm-funnel-dlg').showModal();
}
$('#crm-funnel-btn').addEventListener('click', openFunnel);
$('#cf-cancel').addEventListener('click', () => $('#crm-funnel-dlg').close());
$('#cf-add').addEventListener('click', () => {
  cfCollect();
  const at = cfView.stages.findIndex((x) => ['won', 'lost'].includes(x.key));
  cfView.stages.splice(at < 0 ? cfView.stages.length : at, 0, { key: '', name: 'Новый этап', color: '#64748b' });
  cfRender();
  const inputs = $('#cf-stages').querySelectorAll('[data-cf=name]');
  inputs[Math.max(0, at)]?.select();
});
$('#cf-default').addEventListener('click', () => {
  cfCollect();
  const keep = new Set(CRM_DEFAULT_STAGES.map(([k]) => k));
  const lost = cfView.stages.filter((x) => x.key && !keep.has(x.key) && cfView.counts[x.key]).reduce((s, x) => s + cfView.counts[x.key], 0);
  if (lost && !confirm(`Сделки из убранных этапов (${lost}) перейдут в «${CRM_DEFAULT_STAGES[0][1]}». Продолжить?`)) return;
  cfView.stages = CRM_DEFAULT_STAGES.map(([key, name, color]) => ({ key, name, color }));
  cfRender();
});
$('#cf-stages').addEventListener('click', (e) => {
  const up = e.target.closest('[data-cf-up]');
  const del = e.target.closest('[data-cf-del]');
  if (!up && !del) return;
  cfCollect();
  if (up) {
    const i = Number(up.dataset.cfUp);
    if (i > 1) [cfView.stages[i - 1], cfView.stages[i]] = [cfView.stages[i], cfView.stages[i - 1]];
  } else {
    const i = Number(del.dataset.cfDel);
    const x = cfView.stages[i];
    const n = cfView.counts[x.key] || 0;
    if (n && !confirm(`В этапе «${x.name}» ${n} сделок — они перейдут в «${cfView.stages[0].name}». Удалить этап?`)) return;
    cfView.stages.splice(i, 1);
  }
  cfRender();
});
$('#cf-shift').addEventListener('click', async (e) => {
  if (e.target.id !== 'cf-assign') return;
  try {
    const r = await api('/api/crm/assign-free', { method: 'POST' });
    toast(`Раздано свободных: ${r.assigned}, передано для равновесия: ${r.moved}`);
    $('#crm-funnel-dlg').close();
    renderCrm();
  } catch (err) { toast(err.message, 'error'); }
});
$('#crm-funnel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  cfCollect();
  try {
    applyFunnel(await api('/api/crm/funnel', { method: 'PUT', body: { stages: cfView.stages, autoAssign: $('#cf-auto').checked, assignFree: $('#cf-free').checked } }));
    $('#crm-funnel-dlg').close();
    toast('Воронка сохранена');
    renderCrm();
  } catch (err) { toast(err.message, 'error'); }
});

views.crm = { show: renderCrm, right: 'crm' };
