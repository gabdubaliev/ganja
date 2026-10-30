'use strict';

// Лояльность: правила бонусов, покупатели и ручное изменение бонусов.

const loyaltyView = { query: '', list: [], customer: null };
const phoneFmt = (p) => (p.length === 11 && p[0] === '7' ? `+7 ${p.slice(1, 4)} ${p.slice(4, 7)}-${p.slice(7, 9)}-${p.slice(9)}` : '+' + p);

async function renderLoyalty() {
  const f = $('#loyalty-form');
  const rules = session.loyalty;
  f.elements.enabled.checked = rules.enabled;
  f.elements.percent.value = rules.percent;
  f.elements.maxPay.value = rules.maxPay;
  // Управляющий видит правила, но менять их может только администратор.
  for (const el of f.elements) el.disabled = !session.can('loyalty');
  await renderCustomers();
}

async function renderCustomers() {
  try {
    loyaltyView.list = await api('/api/customers?q=' + encodeURIComponent(loyaltyView.query));
  } catch (err) {
    return toast(err.message, 'error');
  }
  const list = loyaltyView.list;
  const total = list.reduce((s, c) => s + c.bonus, 0);
  $('#loyalty-summary').textContent = loyaltyView.query ? `Нашлось: ${list.length}` : `${list.length}${list.length >= 100 ? '+' : ''} ${plural(list.length, ['покупатель', 'покупателя', 'покупателей'])} · бонусов на счетах ${int(total)}`;
  $('#customers-body').innerHTML = list.length ? list.map((c) => `<tr>
      <td><div class="pname">${esc(c.name || 'Без имени')}</div></td>
      <td>${phoneFmt(c.phone)}</td>
      <td><b>${int(c.bonus)}</b></td>
      <td>${new Date(c.created_at).toLocaleDateString('ru-RU')}</td>
      <td><button type="button" class="btn small ghost" data-customer="${c.id}">${session.can('loyalty') ? 'Бонусы и история' : 'История'}</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${loyaltyView.query ? 'Никого не нашлось' : 'Покупателей пока нет. Кассир добавляет их на кассе по номеру телефона.'}</td></tr>`;
}

async function openCustomer(customer) {
  loyaltyView.customer = customer;
  const f = $('#customer-form');
  f.reset();
  $('#customer-dialog-title').textContent = customer ? customer.name || phoneFmt(customer.phone) : 'Новый покупатель';
  $('#customer-error').hidden = true;
  $('#customer-bonus').hidden = !customer;
  const editable = !customer || session.can('loyalty');
  f.elements.phone.disabled = f.elements.name.disabled = !editable;
  $('#customer-save').hidden = !editable;
  if (customer) {
    f.elements.phone.value = phoneFmt(customer.phone);
    f.elements.name.value = customer.name;
    $('#customer-balance').textContent = int(customer.bonus);
    $('#customer-history').innerHTML = '<p class="empty">Загрузка…</p>';
  }
  $('#customer-dialog').showModal();
  if (!customer) return;
  try {
    const history = await api(`/api/customers/${customer.id}/bonus`);
    $('#customer-history').innerHTML = history.length ? history.map((h) => `
      <div class="history-row">
        <span>${dateTime(h.created_at)}</span>
        <span>${esc(h.reason)}${h.user_name ? `<span class="pcat"> · ${esc(h.user_name)}</span>` : ''}</span>
        <b class="num ${h.delta < 0 ? 'neg' : 'good'}">${h.delta > 0 ? '+' : ''}${int(h.delta)}</b>
      </div>`).join('') : '<p class="empty">Бонусов ещё не было</p>';
  } catch (err) {
    $('#customer-history').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

$('#loyalty-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    session.loyalty = await api('/api/loyalty', { method: 'PUT', body: { enabled: f.elements.enabled.checked, percent: parseNum(f.elements.percent.value), maxPay: parseNum(f.elements.maxPay.value) } });
    toast('Правила бонусов сохранены');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#customer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const c = loyaltyView.customer;
  try {
    const body = { phone: f.elements.phone.value, name: f.elements.name.value };
    await api(c ? `/api/customers/${c.id}` : '/api/customers', { method: c ? 'PUT' : 'POST', body });
    $('#customer-dialog').close();
    toast(c ? 'Покупатель сохранён' : 'Покупатель добавлен');
    renderCustomers();
  } catch (err) {
    showFormError('#customer-error', err);
  }
});

$('#bonus-apply').addEventListener('click', async () => {
  const f = $('#customer-form');
  // Минус можно ввести и как длинное тире: так его подставляют некоторые клавиатуры.
  const delta = parseNum(f.elements.delta.value.replace(/[−–—]/g, '-'));
  try {
    const saved = await api(`/api/customers/${loyaltyView.customer.id}/bonus`, { method: 'POST', body: { delta, reason: f.elements.reason.value } });
    toast(`Бонусы изменены: теперь ${int(saved.bonus)}`);
    renderCustomers();
    openCustomer(saved);
  } catch (err) {
    showFormError('#customer-error', err);
  }
});

$('#customer-cancel').addEventListener('click', () => $('#customer-dialog').close());
$('#customer-add').addEventListener('click', () => openCustomer(null));
$('#customers-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-customer]');
  if (btn) openCustomer(loyaltyView.list.find((c) => c.id === Number(btn.dataset.customer)));
});
let customersTimer = null;
$('#customers-search').addEventListener('input', (e) => {
  loyaltyView.query = e.target.value;
  clearTimeout(customersTimer);
  customersTimer = setTimeout(renderCustomers, 250);
});

views.loyalty = { show: renderLoyalty, right: 'customers' };
