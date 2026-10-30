'use strict';

// Покупатели: правила бонусов, рейтинг покупателей и ручное изменение бонусов.

const loyaltyView = { query: '', list: [], customer: null };

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

// Сегменты рейтинга. Каждый покупатель попадает в один — первый подходящий сверху.
const SEGMENTS = [
  ['vip', 'VIP', 'Топ-10% по сумме покупок'],
  ['regular', 'Постоянные', '5 и больше покупок, последняя — не раньше 45 дней назад'],
  ['leaving', 'Уходят', 'Покупали 2 и больше раз, но не были 45–90 дней'],
  ['sleeping', 'Давно не были', 'Последняя покупка больше 90 дней назад'],
  ['once', 'Купили один раз', 'Одна покупка'],
  ['growing', 'Возвращаются', '2–4 покупки, недавно'],
  ['none', 'Без покупок', 'Карта заведена, покупок нет'],
];
const RATING_SORT = {
  spent: ['Сумма покупок', (c) => c.spent],
  purchases: ['Покупок', (c) => c.purchases],
  avg: ['Средний чек', (c) => c.avg],
  last_at: ['Последняя покупка', (c) => c.last_at || 0],
  bonus: ['Бонусы', (c) => c.bonus],
};
Object.assign(loyaltyView, { segment: 'all', sort: 'spent', shown: 50 });

function segmentOf(c, vipFrom) {
  const days = c.last_at ? (Date.now() - c.last_at) / 864e5 : Infinity;
  if (!c.purchases) return 'none';
  if (c.spent >= vipFrom && c.spent > 0) return 'vip';
  if (c.purchases >= 5 && days <= 45) return 'regular';
  if (days > 90) return 'sleeping';
  if (c.purchases >= 2 && days > 45) return 'leaving';
  if (c.purchases === 1) return 'once';
  return 'growing';
}

function daysAgo(t) {
  if (!t) return '—';
  const d = Math.floor((Date.now() - t) / 864e5);
  return d === 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} ${plural(d, ['день', 'дня', 'дней'])} назад`;
}

async function renderCustomers() {
  try {
    loyaltyView.all = await api('/api/customers/rating');
  } catch (err) {
    return toast(err.message, 'error');
  }
  const all = loyaltyView.all;
  // Порог VIP — сумма, с которой начинаются лучшие 10% покупателей с покупками.
  const buyers = all.filter((c) => c.purchases).map((c) => c.spent).sort((x, y) => y - x);
  const vipFrom = buyers.length >= 10 ? buyers[Math.floor(buyers.length * 0.1) - 1] : Infinity;
  for (const c of all) c.segment = segmentOf(c, vipFrom);
  const counts = Object.fromEntries(SEGMENTS.map(([k]) => [k, all.filter((c) => c.segment === k).length]));
  $('#segments').innerHTML = [['all', 'Все', ''], ...SEGMENTS].map(([key, label, hint]) =>
    `<button type="button" class="chip" data-segment="${key}" aria-pressed="${loyaltyView.segment === key}" title="${esc(hint)}">${label} <span class="count">${key === 'all' ? all.length : counts[key]}</span></button>`).join('');

  const q = loyaltyView.query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const [, sortBy] = RATING_SORT[loyaltyView.sort];
  // Место в рейтинге — по сумме покупок среди всех покупателей.
  const place = new Map([...all].sort((x, y) => y.spent - x.spent).map((c, i) => [c.id, c.purchases ? i + 1 : null]));
  const list = all
    .filter((c) => loyaltyView.segment === 'all' || c.segment === loyaltyView.segment)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (digits && c.phone.includes(digits)))
    .sort((x, y) => sortBy(y) - sortBy(x));
  loyaltyView.list = list;
  const total = all.reduce((s, c) => s + c.bonus, 0);
  $('#loyalty-summary').textContent = `${all.length} ${plural(all.length, ['покупатель', 'покупателя', 'покупателей'])} · бонусов на счетах ${int(total)}`;
  const segName = Object.fromEntries(SEGMENTS.map(([k, l]) => [k, l]));
  $('#customers-head').innerHTML = `<th>Место</th><th>Покупатель</th>` +
    Object.entries(RATING_SORT).map(([key, [label]]) => `<th aria-sort="${loyaltyView.sort === key ? 'descending' : 'none'}"><button type="button" data-sort="${key}">${label}${loyaltyView.sort === key ? ' ↓' : ''}</button></th>`).join('') +
    '<th>Первая покупка</th><th>Группа</th><th></th>';
  $('#customers-body').innerHTML = list.length ? list.slice(0, loyaltyView.shown).map((c) => `<tr>
      <td>${place.get(c.id) ? `<b>${place.get(c.id)}</b>` : '—'}</td>
      <td><div class="pname">${esc(c.name || 'Без имени')}</div><div class="pcat">${phoneFmt(c.phone)}</div></td>
      <td>${money(c.spent)}</td>
      <td>${int(c.purchases)}</td>
      <td>${c.purchases ? money(c.avg) : '—'}</td>
      <td>${daysAgo(c.last_at)}</td>
      <td>${int(c.bonus)}</td>
      <td>${c.first_at ? new Date(c.first_at).toLocaleDateString('ru-RU') : '—'}</td>
      <td><span class="seg-tag ${c.segment}">${segName[c.segment]}</span></td>
      <td><button type="button" class="btn small ghost" data-customer="${c.id}">${session.can('loyalty') ? 'Бонусы' : 'История'}</button></td>
    </tr>`).join('') : `<tr><td colspan="10" class="empty">${all.length ? 'Никого не нашлось' : 'Покупателей пока нет. Кассир добавляет их на кассе по номеру телефона.'}</td></tr>`;
  $('#customers-more').hidden = list.length <= loyaltyView.shown;
}

$('#segments').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-segment]');
  if (!btn) return;
  loyaltyView.segment = btn.dataset.segment;
  loyaltyView.shown = 50;
  renderCustomers();
});
$('#customers-head').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  loyaltyView.sort = btn.dataset.sort;
  renderCustomers();
});
$('#customers-more-btn').addEventListener('click', () => { loyaltyView.shown += 100; renderCustomers(); });

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
  loyaltyView.shown = 50;
  customersTimer = setTimeout(renderCustomers, 200);
});

views.loyalty = { show: renderLoyalty, right: 'customers' };
