'use strict';

// Магазины (филиалы): у каждого своя база товаров, сотрудников, касс, продаж и документов.
// Заводит и переименовывает магазины владелец — администратор основного магазина; он же переключается между ними.

async function renderBranches() {
  let r;
  try { r = await api('/api/branches'); } catch (err) { return toast(err.message, 'error'); }
  $('#branch-add').hidden = !r.canManage;
  $('#branches-list').innerHTML = r.branches.map((b) => `
    <article class="acc-card ${b.current ? 'current-branch' : ''}" data-branch="${b.id}">
      <div class="acc-head"><b>🏬 ${esc(b.name)}</b>${b.main ? '<span class="role-tag">основной</span>' : ''}${b.current ? '<span class="doc-status posted">вы здесь</span>' : ''}</div>
      ${r.canManage ? `
        <input class="input" data-b="name" value="${esc(b.name)}" aria-label="Название">
        ${b.main ? '<p class="pick-meta">Название основного магазина — это название из «Оформления».</p>' : `
        <input class="input" data-b="address" value="${esc(b.address)}" placeholder="Адрес" aria-label="Адрес">
        <input class="input" data-b="phone" value="${esc(b.phone)}" placeholder="Телефон" aria-label="Телефон">`}
        <div class="acc-actions">
          <button type="button" class="btn small" data-branch-save>Сохранить</button>
          ${b.current ? '' : `<button type="button" class="btn small primary" data-branch-go>Перейти в этот магазин</button>`}
        </div>`
        : `<p class="pick-meta">${esc([b.address, b.phone].filter(Boolean).join(' · ') || '')}</p>`}
    </article>`).join('');
}

$('#branch-add').addEventListener('click', () => {
  $('#branch-form').reset();
  $('#branch-error').hidden = true;
  $('#branch-dialog').showModal();
});
$('#branch-cancel').addEventListener('click', () => $('#branch-dialog').close());
$('#branch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const b = await api('/api/branches', { method: 'POST', body: { name: f.elements.name.value, address: f.elements.address.value, phone: f.elements.phone.value, copyProducts: f.elements.copy.checked } });
    $('#branch-dialog').close();
    toast(`Магазин «${b.name}» открыт${b.products ? `, товаров скопировано: ${b.products}` : ''}. Заведите в нём сотрудников и кассы.`);
    renderBranches();
  } catch (err) { showFormError('#branch-error', err); }
});
$('#branches-list').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-branch]');
  if (!card) return;
  const id = Number(card.dataset.branch);
  if (e.target.closest('[data-branch-go]')) return switchBranch(id);
  if (e.target.closest('[data-branch-save]')) {
    const body = Object.fromEntries([...card.querySelectorAll('[data-b]')].map((i) => [i.dataset.b, i.value]));
    try { await api(`/api/branches/${id}`, { method: 'PUT', body }); toast('Сохранено'); renderBranches(); } catch (err) { toast(err.message, 'error'); }
  }
});

views.branches = { show: renderBranches, right: ['settings', 'staff', 'transfer'] };
