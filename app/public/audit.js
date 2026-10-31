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
      <td class="num">${esc(a.ip)}</td>
      <td class="pcat">${esc(a.device)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">За этот период записей нет</td></tr>';
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

views.audit = { show: renderAudit, right: 'audit' };
