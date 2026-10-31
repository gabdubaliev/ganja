'use strict';

// Сертификаты: список с остатками и сроками, история списаний, блокировка, срок действия.
const certView = { state: '', q: '', list: [], current: null };
const CERT_STATE = { active: ['Действует', 'ok'], used: ['Потрачен', 'muted'], expired: ['Срок истёк', 'warn'], blocked: ['Заблокирован', 'bad'], deleted: ['Удалён', 'muted'] };

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
  $('#cert-states').innerHTML = [['', 'Все'], ['active', 'Действуют'], ['used', 'Потрачены'], ['expired', 'Срок истёк'], ['blocked', 'Заблокированы'], ['deleted', 'Удалённые']]
    .map(([k, l]) => `<button type="button" class="chip" data-cert-state="${k}" aria-pressed="${certView.state === k}">${l}</button>`).join('');
  $('#cert-body').innerHTML = d.list.length ? d.list.map((c) => `<tr class="clickable" data-cert="${c.id}">
      <td><b>№${esc(c.number.replace(/#.*$/, ''))}</b>${c.free ? ' <span class="role-tag">подарок</span>' : ''}<div class="pcat">${c.free ? 'выдал(а)' : 'продал(а)'} ${esc(c.user_name || '—')}</div></td>
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
  const OPS = { sale: c.free ? 'Выдан бесплатно' : 'Продан', redeem: 'Покупка по сертификату', refund: 'Возврат на сертификат', block: 'Заблокирован', unblock: 'Разблокирован', adjust: 'Изменена сумма', expires: 'Изменён срок', delete: 'Удалён' };
  $('#cd-title').textContent = `Сертификат №${c.number.replace(/#.*$/, '')}${c.free ? ' (подарок от магазина)' : ''}`;
  $('#cd-body').innerHTML = `<div class="pc-grid">
      ${pcCellLite('Номинал', money2(c.amount))}${pcCellLite('Остаток', money2(c.balance))}${pcCellLite('Состояние', CERT_STATE[c.state][0])}
      ${pcCellLite('Покупатель', esc(c.customer_name || '—'), c.customer_phone ? phoneFmt(c.customer_phone) : '')}
      ${pcCellLite(c.free ? 'Выдан бесплатно' : 'Продан', dateOnly(c.sold_at), [esc(c.user_name || ''), c.payments.map((p) => `${esc(p.method_name)} ${money2(p.amount)}`).join(' + ')].filter(Boolean).join(' · '))}
      ${pcCellLite('Действует до', c.expires_at ? dateOnly(c.expires_at) : 'без срока')}
    </div>
    <h3>История</h3>
    <ul class="fb-list">${c.ops.map((o) => `<li class="fb-${o.amount < 0 ? 'fine' : 'bonus'}"><span class="fb-date">${dateTime(o.at)}</span>
      <span class="fb-text"><b>${OPS[o.kind] || o.kind}</b>${o.sale_id ? `, чек №${o.sale_id}` : ''}${o.note ? ` · ${esc(o.note)}` : ''}<small>${esc(o.user_name || '')}</small></span>
      <b class="fb-sum num">${o.amount ? `${o.amount > 0 ? '+' : '−'}${money2(Math.abs(o.amount))}` : ''}</b></li>`).join('')}</ul>`;
  $('#cd-block').textContent = c.status === 'blocked' ? 'Разблокировать' : 'Заблокировать (утерян)';
  const live = c.state !== 'deleted';
  $('#cd-block').hidden = !live;
  $('#cd-edit').hidden = !live || !session.can('certificates.manage');
  $('#cd-delete').hidden = !live || !session.can('certificates.manage');
  $('#cd-delete').textContent = 'Удалить сертификат';
  $('#cd-delete').classList.remove('danger');
  const f = $('#cd-edit');
  f.elements.balance.value = String(c.balance).replace('.', ',');
  f.elements.expires.value = c.expires_at ? dateInput(c.expires_at) : '';
  f.elements.note.value = '';
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

/* ---------- Изменить и удалить ---------- */
$('#cd-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const c = certView.current;
  try {
    await api(`/api/certificates/${c.id}`, { method: 'PUT', body: {
      balance: f.elements.balance.value, note: f.elements.note.value,
      expires_at: f.elements.expires.value ? fromDateInput(f.elements.expires.value) + 864e5 - 1 : null,
    } });
    toast('Сертификат изменён');
    renderCertificates();
    openCertificate(c.id);
  } catch (err) {
    showFormError('#cd-error', err);
  }
});
$('#cd-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const c = certView.current;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = c.balance > 0 ? `Удалить? Остаток ${money2(c.balance)} сгорит — нажмите ещё раз` : 'Нажмите ещё раз, чтобы удалить';
    return;
  }
  try {
    await api(`/api/certificates/${c.id}`, { method: 'DELETE' });
    toast(`Сертификат №${c.number} удалён. Покупатель остался в «Клиентах»`);
    $('#cert-dialog').close();
    renderCertificates();
  } catch (err) {
    showFormError('#cd-error', err);
  }
});

/* ---------- Новый сертификат (в том числе бесплатно) ---------- */
const ci = { customer: null, found: [], timer: null };
async function openCertIssue() {
  const f = $('#ci-form');
  f.reset();
  ci.customer = null;
  let methods = [];
  try { methods = (await api('/api/payment-methods')).methods; } catch { /* без способов — только бесплатно */ }
  f.elements.pay.innerHTML = methods.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('') + '<option value="free">🎁 Без оплаты — подарок от магазина</option>';
  const months = Number($('#cert-months').value) || 0;
  if (months) { const d = new Date(); d.setMonth(d.getMonth() + months); f.elements.expires.value = dateInput(d.getTime()); }
  $('#ci-error').hidden = true;
  drawCertIssue();
  $('#cert-issue-dialog').showModal();
  f.elements.amount.focus();
}
function drawCertIssue() {
  const c = ci.customer;
  $('#ci-cust-chosen').hidden = !c;
  $('#ci-cust').closest('.suggest-wrap').hidden = Boolean(c);
  if (c) $('#ci-cust-chosen').innerHTML = `<span>👤 <b>${esc(c.name || phoneFmt(c.phone))}</b> <span class="pick-meta">${c.name ? phoneFmt(c.phone) : ''}${c.card ? ` · карта ${c.card}` : ''}</span></span><button type="button" class="btn small ghost" id="ci-cust-change">Другой</button>`;
  if (c) $('#ci-newcust').hidden = true;
}
$('#cert-issue-open').addEventListener('click', openCertIssue);
$('#ci-cancel').addEventListener('click', () => $('#cert-issue-dialog').close());
$('#ci-number-new').addEventListener('click', async () => {
  try { $('#ci-number').value = (await api('/api/certificates/new-number')).number; } catch (err) { showFormError('#ci-error', err); }
});
$('#ci-cust').addEventListener('input', () => {
  clearTimeout(ci.timer);
  ci.timer = setTimeout(async () => {
    const q = $('#ci-cust').value.trim();
    if (!q) { $('#ci-cust-results').hidden = true; return; }
    try { ci.found = await api('/api/customers/search?q=' + encodeURIComponent(q)); } catch (err) { return showFormError('#ci-error', err); }
    $('#ci-cust-results').innerHTML = ci.found.map((c, i) => `<button type="button" class="suggest" data-ci-cust="${i}"><span><b>${esc(c.name || phoneFmt(c.phone))}</b><span class="pick-meta"> ${c.name ? phoneFmt(c.phone) : ''}${c.card ? ` · карта ${c.card}` : ''}</span></span></button>`).join('')
      + '<button type="button" class="suggest new" data-ci-new>+ Новый покупатель</button>';
    $('#ci-cust-results').hidden = false;
  }, 250);
});
$('#ci-form').addEventListener('click', (e) => {
  const c = e.target.closest('[data-ci-cust]');
  if (c) { ci.customer = ci.found[Number(c.dataset.ciCust)]; $('#ci-cust-results').hidden = true; $('#ci-cust').value = ''; return drawCertIssue(); }
  if (e.target.closest('[data-ci-new]')) {
    const q = $('#ci-cust').value.trim();
    const f = $('#ci-form');
    $('#ci-newcust').hidden = false;
    $('#ci-cust-results').hidden = true;
    if (/\d{5,}/.test(q.replace(/\D/g, ''))) f.elements.newPhone.value = q; else f.elements.newName.value = capitalizeWords(q);
    return;
  }
  if (e.target.closest('#ci-cust-change')) { ci.customer = null; drawCertIssue(); }
});
$('#ci-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    // Новый покупатель заводится и остаётся в «Клиентах».
    if (!ci.customer && !$('#ci-newcust').hidden && f.elements.newPhone.value.trim()) {
      ci.customer = await api('/api/customers', { method: 'POST', body: { name: f.elements.newName.value, phone: f.elements.newPhone.value } });
    }
    if (!ci.customer) throw new Error('Выберите покупателя или заведите нового');
    const free = f.elements.pay.value === 'free';
    const c = await api('/api/certificates/issue', { method: 'POST', body: {
      amount: f.elements.amount.value, number: f.elements.number.value.trim(), customerId: ci.customer.id,
      free, methodId: free ? null : Number(f.elements.pay.value), note: f.elements.note.value,
      expiresAt: f.elements.expires.value ? fromDateInput(f.elements.expires.value) + 864e5 - 1 : null,
    } });
    $('#cert-issue-dialog').close();
    toast(`Сертификат №${c.number} на ${money2(c.amount)} ${free ? 'выдан бесплатно' : 'создан'}`);
    renderCertificates();
  } catch (err) {
    showFormError('#ci-error', err);
  }
});

views.certificates = { show: renderCertificates, right: 'certificates' };
