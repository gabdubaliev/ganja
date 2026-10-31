'use strict';

// Сертификаты: список с остатками и сроками, история списаний, блокировка, срок действия.
const certView = { state: '', q: '', list: [], current: null };
const CERT_STATE = { active: ['Действует', 'ok'], used: ['Потрачен', 'muted'], expired: ['Срок истёк', 'warn'], blocked: ['Заблокирован', 'bad'] };

async function renderCertificates() {
  let d;
  try { d = await api(`/api/certificates?state=${certView.state}&q=${encodeURIComponent(certView.q)}`); } catch (err) { return toast(err.message, 'error'); }
  certView.list = d.list;
  $('#cert-months').value = String(d.settings.months);
  const all = certView.state || certView.q ? null : d.list;
  const active = d.list.filter((c) => c.state === 'active');
  $('#cert-sub').textContent = `${d.list.length} ${plural(d.list.length, ['сертификат', 'сертификата', 'сертификатов'])}`;
  $('#cert-tiles').innerHTML = all ? `
    <div class="st-tile"><span>Продано всего</span><b class="num">${money(all.reduce((s, c) => s + c.amount, 0))}</b><small>${all.length} шт.</small></div>
    <div class="st-tile"><span>Куплено товара по ним</span><b class="num">${money(all.reduce((s, c) => s + c.amount - c.balance, 0))}</b><small>уже в выручке</small></div>
    <div class="st-tile accent"><span>Не потрачено</span><b class="num">${money(active.reduce((s, c) => s + c.balance, 0))}</b><small>${active.length} действующих</small></div>
    <div class="st-tile"><span>Сгорело (истёк срок)</span><b class="num">${money(all.filter((c) => c.state === 'expired').reduce((s, c) => s + c.balance, 0))}</b><small>остатки просроченных</small></div>` : '';
  $('#cert-states').innerHTML = [['', 'Все'], ['active', 'Действуют'], ['used', 'Потрачены'], ['expired', 'Срок истёк'], ['blocked', 'Заблокированы']]
    .map(([k, l]) => `<button type="button" class="chip" data-cert-state="${k}" aria-pressed="${certView.state === k}">${l}</button>`).join('');
  $('#cert-body').innerHTML = d.list.length ? d.list.map((c) => `<tr class="clickable" data-cert="${c.id}">
      <td><b>№${esc(c.number)}</b><div class="pcat">продал(а) ${esc(c.user_name || '—')}</div></td>
      <td>${esc(c.customer_name || '—')}<div class="pcat">${c.customer_phone ? phoneFmt(c.customer_phone) : ''}</div></td>
      <td>${dateOnly(c.sold_at)}</td>
      <td class="num">${money2(c.amount)}</td>
      <td class="num"><b>${money2(c.balance)}</b></td>
      <td>${c.expires_at ? dateOnly(c.expires_at) : 'без срока'}</td>
      <td><span class="cert-state ${CERT_STATE[c.state][1]}">${CERT_STATE[c.state][0]}</span></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Сертификатов нет. Их продают на кассе кнопкой «🎁 Сертификат».</td></tr>';
}

async function openCertificate(id) {
  let c;
  try { c = await api(`/api/certificates/${id}`); } catch (err) { return toast(err.message, 'error'); }
  certView.current = c;
  const OPS = { sale: 'Продан', redeem: 'Покупка по сертификату', refund: 'Возврат на сертификат', block: 'Заблокирован', unblock: 'Разблокирован' };
  $('#cd-title').textContent = `Сертификат №${c.number}`;
  $('#cd-body').innerHTML = `<div class="pc-grid">
      ${pcCellLite('Номинал', money2(c.amount))}${pcCellLite('Остаток', money2(c.balance))}${pcCellLite('Состояние', CERT_STATE[c.state][0])}
      ${pcCellLite('Покупатель', esc(c.customer_name || '—'), c.customer_phone ? phoneFmt(c.customer_phone) : '')}
      ${pcCellLite('Продан', dateOnly(c.sold_at), `${esc(c.user_name || '')} · ${c.payments.map((p) => `${esc(p.method_name)} ${money2(p.amount)}`).join(' + ')}`)}
      ${pcCellLite('Действует до', c.expires_at ? dateOnly(c.expires_at) : 'без срока')}
    </div>
    <h3>История</h3>
    <ul class="fb-list">${c.ops.map((o) => `<li class="fb-${o.amount < 0 ? 'fine' : 'bonus'}"><span class="fb-date">${dateTime(o.at)}</span>
      <span class="fb-text"><b>${OPS[o.kind] || o.kind}</b>${o.sale_id ? `, чек №${o.sale_id}` : ''}${o.note ? ` · ${esc(o.note)}` : ''}<small>${esc(o.user_name || '')}</small></span>
      <b class="fb-sum num">${o.amount ? `${o.amount > 0 ? '+' : '−'}${money2(Math.abs(o.amount))}` : ''}</b></li>`).join('')}</ul>`;
  $('#cd-block').textContent = c.status === 'blocked' ? 'Разблокировать' : 'Заблокировать (утерян)';
  $('#cd-error').hidden = true;
  $('#cert-dialog').showModal();
}
const pcCellLite = (label, value, note = '') => `<div class="pc-cell"><span>${label}</span><b class="num">${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;

$('#cert-states').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cert-state]');
  if (b) { certView.state = b.dataset.certState; renderCertificates(); }
});
let certTimer = null;
$('#cert-search').addEventListener('input', (e) => { certView.q = e.target.value; clearTimeout(certTimer); certTimer = setTimeout(renderCertificates, 250); });
$('#cert-body').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-cert]');
  if (tr) openCertificate(Number(tr.dataset.cert));
});
$('#cd-close').addEventListener('click', () => $('#cert-dialog').close());
$('#cd-block').addEventListener('click', async () => {
  const c = certView.current;
  const block = c.status !== 'blocked';
  const note = block ? prompt('Почему блокируем? Например: утерян, украден') : '';
  if (block && note === null) return;
  try {
    await api(`/api/certificates/${c.id}/block`, { method: 'PUT', body: { blocked: block, note } });
    toast(block ? 'Сертификат заблокирован — на кассе его не примут' : 'Сертификат снова действует');
    $('#cert-dialog').close();
    renderCertificates();
  } catch (err) {
    showFormError('#cd-error', err);
  }
});
$('#cert-months').addEventListener('change', async (e) => {
  try {
    await api('/api/certificates-settings', { method: 'PUT', body: { months: Number(e.target.value) } });
    toast('Срок сохранён — для новых сертификатов');
  } catch (err) { toast(err.message, 'error'); }
});

views.certificates = { show: renderCertificates, right: 'certificates' };
