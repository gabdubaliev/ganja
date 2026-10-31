'use strict';

// Админ-панель владельца: разделы (название, значок, порядок, верхнее меню, скрыть, кому доступно),
// блоки главной, сотрудники (вход, IP, пароли, вход от имени), оформление.

const ownerView = { tab: 'sections', users: [], open: new Set() };
let ownerLayout = {};

const layoutCopy = () => JSON.parse(JSON.stringify(session.layout || {}));
async function saveOwnerLayout(msg = 'Сохранено') {
  try {
    session.layout = await api('/api/layout', { method: 'PUT', body: ownerLayout });
    ownerLayout = layoutCopy();
    toast(msg);
    renderPinned();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renderOwner() {
  ownerLayout = layoutCopy();
  ownerLayout.sections ||= {}; ownerLayout.order ||= {}; ownerLayout.pinned ||= []; ownerLayout.home ||= { order: [], hidden: [] };
  try { ownerView.users = session.auth ? await api('/api/users?all=1') : []; } catch { ownerView.users = []; }
  showOwnerTab(ownerView.tab);
}

function showOwnerTab(tab) {
  ownerView.tab = tab;
  for (const b of document.querySelectorAll('#owner-tabs [data-owner-tab]')) b.setAttribute('aria-pressed', String(b.dataset.ownerTab === tab));
  for (const p of document.querySelectorAll('[data-owner-pane]')) p.hidden = p.dataset.ownerPane !== tab;
  ({ sections: drawOwnerSections, home: drawOwnerHome, staff: drawOwnerStaff, look: () => {} })[tab]();
}

/* ---------- Разделы ---------- */
const rightsOfUser = (u) => (u.role === 'owner' ? null : u.rights || session.roles[u.role]?.can || []);
const hasSection = (u, rights) => u.role === 'owner' || [rights].flat().some((r) => rightsOfUser(u).includes(r));

function drawOwnerSections() {
  const staff = ownerView.users.filter((u) => !u.disabled);
  $('#owner-sections').innerHTML = allSections().map(([group, items]) => {
    const list = orderedItems(group, items);
    return `<div class="panel owner-group"><h2>${esc(group)}</h2>${list.map((item, i) => {
      const x = sectionView(item);
      const pinned = ownerLayout.pinned.includes(x.key);
      const who = staff.filter((u) => hasSection(u, x.right));
      const open = ownerView.open.has(x.key);
      return `<div class="owner-row ${x.hidden ? 'is-hidden' : ''}" data-key="${esc(x.key)}" data-group="${esc(group)}">
        <input class="input owner-icon" data-field="icon" value="${esc(x.icon)}" maxlength="8" aria-label="Значок" title="Значок (эмодзи)">
        <div class="owner-name"><input class="input" data-field="name" value="${esc(x.title)}" maxlength="60" aria-label="Название"><small>${esc(x.about || '')}${x.title !== x.origTitle ? ` · было «${esc(x.origTitle)}»` : ''}</small></div>
        <div class="owner-actions">
          <button type="button" class="icon-btn" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше" title="Выше">↑</button>
          <button type="button" class="icon-btn" data-move="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Ниже" title="Ниже">↓</button>
          ${group !== 'Верхнее меню' ? `<button type="button" class="btn small ${pinned ? 'primary' : 'ghost'}" data-pin title="Показать в верхнем меню рядом с «Главная», «Товары»">📌 ${pinned ? 'В меню' : 'В меню?'}</button>` : ''}
          <button type="button" class="btn small ${x.hidden ? 'danger' : 'ghost'}" data-hide>${x.hidden ? '🚫 Скрыт' : '👁 Виден'}</button>
          ${!session.auth ? '' : [x.right].flat().filter(Boolean).length ? `<button type="button" class="btn small ghost" data-who>Кому: ${who.length} из ${staff.length} ▾</button>` : '<span class="pick-meta">доступен всем</span>'}
        </div>
        ${open ? `<div class="owner-who">${staff.map((u) => `<label class="check"><input type="checkbox" data-user-right="${u.id}" data-branch="${u.branch || 1}" ${hasSection(u, x.right) ? 'checked' : ''} ${u.role === 'owner' ? 'disabled' : ''}> ${esc(u.name || u.email)} <span class="pcat">${esc(session.roleName(u.role))}${u.branchName && (session.branch?.count || 1) > 1 ? ` · ${esc(u.branchName)}` : ''}</span></label>`).join('') || '<span class="pick-meta">Сотрудников нет</span>'}
          <p class="pick-meta">Галочка даёт сотруднику право «${esc(session.rightsList?.find((r) => r.key === [x.right].flat()[0])?.label || [x.right].flat()[0] || '')}». Снятая убирает доступ к разделу (все связанные права).</p></div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }).join('');
}

function sectionSetting(key) {
  return (ownerLayout.sections[key] ||= {});
}

$('#owner-sections').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-key]');
  if (!row) return;
  const key = row.dataset.key;
  const field = e.target.dataset.field;
  if (field) {
    const item = allSections().flatMap(([, items]) => items).find((x) => x[0] === key);
    const s = sectionSetting(key);
    const v = e.target.value.trim();
    const orig = field === 'name' ? item[3] : item[2];
    if (!v || v === orig) delete s[field]; else s[field] = v;
    return saveOwnerLayout(field === 'name' ? 'Название сохранено' : 'Значок сохранён');
  }
  const ur = e.target.closest('[data-user-right]');
  if (ur) {
    const u = ownerView.users.find((x) => x.id === Number(ur.dataset.userRight) && String(x.branch || 1) === ur.dataset.branch);
    const item = allSections().flatMap(([, items]) => items).find((x) => x[0] === key);
    const rights = [item[1]].flat().filter(Boolean);
    const current = new Set(rightsOfUser(u));
    if (ur.checked) current.add(rights[0]); else for (const r of rights) current.delete(r);
    try {
      const saved = await api(`/api/users/${u.id}${branchQuery(u.branch)}`, { method: 'PUT', body: { rights: [...current] } });
      Object.assign(u, { rights: saved.rights });
      toast(`${u.name || u.email}: ${ur.checked ? 'раздел открыт' : 'раздел закрыт'}`);
    } catch (err) {
      toast(err.message, 'error');
    }
    drawOwnerSections();
  }
});

$('#owner-sections').addEventListener('click', (e) => {
  const row = e.target.closest('[data-key]');
  if (!row) return;
  const key = row.dataset.key;
  const group = row.dataset.group;
  if (e.target.closest('[data-who]')) {
    if (ownerView.open.has(key)) ownerView.open.delete(key); else ownerView.open.add(key);
    return drawOwnerSections();
  }
  if (e.target.closest('[data-hide]')) {
    const s = sectionSetting(key);
    if (s.hidden) delete s.hidden; else s.hidden = true;
    saveOwnerLayout(s.hidden ? 'Раздел скрыт от сотрудников' : 'Раздел снова виден').then(drawOwnerSections);
    return;
  }
  if (e.target.closest('[data-pin]')) {
    const i = ownerLayout.pinned.indexOf(key);
    if (i >= 0) ownerLayout.pinned.splice(i, 1);
    else {
      if (ownerLayout.pinned.length >= 8) return toast('В верхнем меню — не больше 8 закреплённых разделов', 'error');
      ownerLayout.pinned.push(key);
    }
    saveOwnerLayout(i >= 0 ? 'Убрано из верхнего меню' : 'Закреплено в верхнем меню').then(drawOwnerSections);
    return;
  }
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const items = allSections().find(([g]) => g === group)[1];
    const keys = orderedItems(group, items).map((x) => x[0]);
    const i = keys.indexOf(key), j = i + Number(mv.dataset.move);
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    ownerLayout.order[group] = keys;
    saveOwnerLayout('Порядок сохранён').then(drawOwnerSections);
  }
});

$('#owner-reset').addEventListener('click', async () => {
  if (!confirm('Вернуть все названия, значки, порядок, верхнее меню и блоки главной как было? Права сотрудников не меняются.')) return;
  ownerLayout = { sections: {}, order: {}, pinned: [], home: { order: [], hidden: [] } };
  await saveOwnerLayout('Расположение сброшено');
  location.reload();
});

/* ---------- Главная ---------- */
function drawOwnerHome() {
  const cfg = ownerLayout.home;
  const ids = [...cfg.order.filter((id) => HOME_BLOCKS.some(([b]) => b === id)), ...HOME_BLOCKS.map(([id]) => id).filter((id) => !cfg.order.includes(id))];
  $('#owner-home').innerHTML = ids.map((id, i) => {
    const name = HOME_BLOCKS.find(([b]) => b === id)[1];
    const hidden = cfg.hidden.includes(id);
    return `<div class="owner-row ${hidden ? 'is-hidden' : ''}" data-block="${id}">
      <div class="owner-name"><b>${esc(name)}</b></div>
      <div class="owner-actions">
        <button type="button" class="icon-btn" data-bmove="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button type="button" class="icon-btn" data-bmove="1" ${i === ids.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
        <button type="button" class="btn small ${hidden ? 'danger' : 'ghost'}" data-bhide>${hidden ? '🚫 Скрыт' : '👁 Виден'}</button>
      </div></div>`;
  }).join('');
  ownerView.homeIds = ids;
}
$('#owner-home').addEventListener('click', (e) => {
  const row = e.target.closest('[data-block]');
  if (!row) return;
  const id = row.dataset.block;
  const cfg = ownerLayout.home;
  if (e.target.closest('[data-bhide]')) {
    const i = cfg.hidden.indexOf(id);
    if (i >= 0) cfg.hidden.splice(i, 1); else cfg.hidden.push(id);
  } else if (e.target.closest('[data-bmove]')) {
    const ids = [...ownerView.homeIds];
    const i = ids.indexOf(id), j = i + Number(e.target.closest('[data-bmove]').dataset.bmove);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    cfg.order = ids;
  } else return;
  saveOwnerLayout('Главная сохранена').then(drawOwnerHome);
});

/* ---------- Сотрудники ---------- */
function drawOwnerStaff() {
  const list = ownerView.users;
  $('#owner-staff').innerHTML = list.length ? list.map((u) => `<tr class="${u.disabled ? 'muted' : ''}">
    <td><b>${esc(u.name || u.email)}</b><div class="pcat">${esc(u.email)}${u.branchName && (session.branch?.count || 1) > 1 ? ` · ${esc(u.branchName)}` : ''}</div></td>
    <td><span class="role-tag ${u.role === 'owner' ? 'owner-tag' : ''}">${esc(session.roleName(u.role))}</span>${u.disabled ? '<div class="pcat">доступ закрыт</div>' : ''}</td>
    <td class="pcat">${esc(loginText(u.lastLogin))}</td>
    <td><div class="actions">
      ${u.role !== 'owner' ? `<button type="button" class="btn small ghost" data-secrets="${u.id}" data-user-branch="${u.branch || ''}">🔑 Пароль</button>` : ''}
      ${u.role !== 'owner' && !u.disabled ? `<button type="button" class="btn small" data-as-user="${u.id}" data-user-branch="${u.branch || ''}">👁 Войти как</button>` : ''}
    </div></td>
  </tr>`).join('') : '<tr><td colspan="4" class="empty">Сотрудников пока нет — программа открывается без входа.</td></tr>';
}
$('#owner-staff').addEventListener('click', (e) => {
  const sec = e.target.closest('[data-secrets]');
  if (sec) return showSecrets(Number(sec.dataset.secrets), Number(sec.dataset.userBranch) || null);
  const as = e.target.closest('[data-as-user]');
  if (as) actAsUser(Number(as.dataset.asUser), Number(as.dataset.userBranch) || null);
});

$('#owner-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-owner-tab]');
  if (b) showOwnerTab(b.dataset.ownerTab);
});

views.owner = { show: renderOwner, right: '__owner' };
