'use strict';

// Журнал действий: входы, неудачные попытки входа, действия без права и все изменения.

const AUDIT_KINDS = {
  '': 'Всё',
  login: 'Входы',
  login_failed: 'Неудачные попытки входа',
  denied: 'Без права',
  change: 'Изменения',
  logout: 'Выходы',
};
const auditView = { range: 'today', kind: '', q: '' };

async function renderAudit() {
  // Без права «Журнал» сотрудник видит только свои изменения и может их отменить.
  const own = !session.can('audit');
  $('#audit-kinds').hidden = own;
  document.querySelector('[data-view="audit"] h1').textContent = own ? 'Мои действия' : 'Журнал действий';
  if (own) auditView.kind = '';
  renderRanges($('#audit-ranges'), ['today', 'yesterday', 'week', 'month', 'prevMonth'], auditView.range);
  $('#audit-kinds').innerHTML = Object.entries(AUDIT_KINDS).map(([k, l]) => `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === auditView.kind}">${l}</button>`).join('');
  const [from, to] = RANGES[auditView.range][1]();
  let list;
  try {
    list = await api(`/api/audit?from=${from}&to=${to}&kind=${auditView.kind}&q=${encodeURIComponent(auditView.q)}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const failed = list.filter((a) => a.kind === 'login_failed').length;
  $('#audit-sub').textContent = `${list.length}${list.length >= 500 ? '+' : ''} ${plural(list.length, ['запись', 'записи', 'записей'])}${failed ? ` · неудачных входов: ${failed}` : ''}`;
  $('#audit-body').innerHTML = list.length ? list.map((a) => `<tr class="audit-${a.kind}">
      <td class="num">${new Date(a.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      <td><div class="pname">${esc(a.user_name || '—')}</div></td>
      <td>${a.kind === 'login_failed' || a.kind === 'denied' ? `<span class="seg-tag sleeping">${esc(a.action)}</span>` : a.kind === 'login' ? `<span class="seg-tag regular">${esc(a.action)}</span>` : esc(a.action)}</td>
      <td class="details">${esc(a.details)}</td>
      <td>${undoCell(a)}</td>
      <td class="num">${esc(a.ip)}</td>
      <td class="pcat">${esc(a.device)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">За этот период записей нет</td></tr>';
}

$('#audit-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  auditView.range = btn.dataset.range;
  renderAudit();
});
$('#audit-kinds').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-kind]');
  if (!btn) return;
  auditView.kind = btn.dataset.kind;
  renderAudit();
});
let auditTimer = null;
$('#audit-search').addEventListener('input', (e) => {
  auditView.q = e.target.value;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(renderAudit, 250);
});

/* ---------- Отмена действий сотрудника ---------- */
// Кнопка у действий, которые можно отменить: товары, категории, поставщики, документы склада, расходы.
function undoCell(a) {
  if (a.undone_at) return `<span class="undo-done" title="${esc(a.undone_by)}">↶ отменено ${new Date(a.undone_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${a.undone_by ? `, ${esc(a.undone_by)}` : ''}</span>`;
  if (!a.undoable) return '';
  return `<button type="button" class="btn small" data-undo="${a.id}">↶ ${a.undo_of ? 'Вернуть обратно' : 'Отменить'}</button>`;
}
const undoState = { id: null, entry: null };
async function loadUndoPlan() {
  const scope = $('#undo-form').elements.scope.value;
  $('#undo-error').hidden = true;
  $('#undo-plan').innerHTML = '<p class="pick-meta">Проверяю…</p>';
  try {
    const plan = await api(`/api/audit/${undoState.id}/undo`, { method: 'POST', body: { scope, dryRun: true } });
    const counts = Object.entries(plan.counts).map(([k, n]) => `${k}: ${n}`).join(', ');
    $('#undo-plan').innerHTML = `
      ${plan.audits.length > 1 ? `<p><b>Действий будет отменено: ${plan.audits.length}</b></p><ul class="undo-list">${plan.audits.map((x) => `<li>${new Date(x.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${esc(x.action)}</li>`).join('')}</ul>` : ''}
      <p class="pick-meta">Изменится: ${esc(counts || 'ничего')}</p>
      ${plan.sample.length ? `<ul class="undo-list">${plan.sample.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${plan.conflicts.length ? `<div class="undo-conflicts"><b>Отменить нельзя:</b><ul>${plan.conflicts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}`;
    $('#undo-go').disabled = plan.conflicts.length > 0;
    $('#undo-go').textContent = plan.audits.length > 1 ? `Отменить ${plan.audits.length} ${plural(plan.audits.length, ['действие', 'действия', 'действий'])}` : 'Отменить';
  } catch (err) {
    $('#undo-plan').innerHTML = '';
    $('#undo-go').disabled = true;
    showFormError('#undo-error', err);
  }
}
$('#audit-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-undo]');
  if (!b) return;
  undoState.id = Number(b.dataset.undo);
  const tr = b.closest('tr');
  const cells = [...tr.children].map((td) => td.textContent.trim());
  $('#undo-what').textContent = `${cells[1]} · ${cells[0]} · ${cells[2]}${cells[3] ? ` — ${cells[3]}` : ''}`;
  $('#undo-after-label').textContent = `Это и все следующие действия: ${cells[1]}`;
  $('#undo-form').elements.scope.value = 'one';
  $('#undo-dialog').showModal();
  loadUndoPlan();
});
$('#undo-form').addEventListener('change', (e) => { if (e.target.name === 'scope') loadUndoPlan(); });
$('#undo-cancel').addEventListener('click', () => $('#undo-dialog').close());
$('#undo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#undo-go');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const res = await api(`/api/audit/${undoState.id}/undo`, { method: 'POST', body: { scope: $('#undo-form').elements.scope.value } });
    $('#undo-dialog').close();
    toast(res.audits.length > 1 ? `Отменено действий: ${res.audits.length}` : 'Действие отменено');
    catalog.load?.().catch(() => {});
    renderAudit();
  } catch (err) {
    showFormError('#undo-error', err);
    btn.disabled = false;
  }
});

views.audit = { show: renderAudit, right: ['audit', 'undo.own'] };
