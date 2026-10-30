'use strict';

// Покупатели: правила бонусов, рейтинг покупателей и ручное изменение бонусов.

const loyaltyView = { query: '', list: [], customer: null };

async function renderLoyalty() {
  const f = $('#loyalty-form');
  const rules = session.loyalty;
  f.elements.enabled.checked = rules.enabled;
  f.elements.percent.value = rules.percent;
  f.elements.maxPay.value = rules.maxPay;
  f.elements.birthdayDiscount.value = rules.birthdayDiscount || '';
  f.elements.birthdayDays.value = rules.birthdayDays || '';
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
// Отдельная подборка, не сегмент: день рождения в ближайшие 14 дней.
const BIRTHDAY_SOON = 14;
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
  const soon = (c) => c.birthdayIn !== null && c.birthdayIn >= 0 && c.birthdayIn <= BIRTHDAY_SOON;
  counts.birthday = all.filter(soon).length;
  $('#segments').innerHTML = [['all', 'Все', ''], ...SEGMENTS, ['birthday', '🎂 ДР скоро', `День рождения в ближайшие ${BIRTHDAY_SOON} дней`]].map(([key, label, hint]) =>
    `<button type="button" class="chip" data-segment="${key}" aria-pressed="${loyaltyView.segment === key}" title="${esc(hint)}">${label} <span class="count">${key === 'all' ? all.length : counts[key]}</span></button>`).join('');

  const q = loyaltyView.query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const [, sortBy] = RATING_SORT[loyaltyView.sort];
  // Место в рейтинге — по сумме покупок среди всех покупателей.
  const place = new Map([...all].sort((x, y) => y.spent - x.spent).map((c, i) => [c.id, c.purchases ? i + 1 : null]));
  const list = all
    .filter((c) => loyaltyView.segment === 'all' || (loyaltyView.segment === 'birthday' ? soon(c) : c.segment === loyaltyView.segment))
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
      <td><div class="pname">${esc(c.name || 'Без имени')}${c.birthdayDiscount ? ' <span title="Действует скидка именинника">🎂</span>' : ''}${c.registered_at ? ` <span class="role-tag" title="Зарегистрирован на витрине">${c.login_disabled ? 'вход закрыт' : 'на витрине'}</span>` : ''}</div><div class="pcat">${phoneFmt(c.phone)}${c.birthday ? ` · ДР ${birthdayText(c)}` : ''}</div></td>
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

// «15 марта», «15 марта, через 3 дня», «15 марта, сегодня».
function birthdayText(c) {
  if (!c.birthday) return '';
  const [y, m, d] = c.birthday.split('-').map(Number);
  const when = c.birthdayIn === 0 ? ', сегодня' : c.birthdayIn > 0 && c.birthdayIn <= BIRTHDAY_SOON ? `, через ${c.birthdayIn} ${plural(c.birthdayIn, ['день', 'дня', 'дней'])}` : '';
  return `${d} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m - 1]}${y ? ' ' + y : ''}${when}`;
}

// 'ГГГГ-ММ-ДД' → 'ДД.ММ.ГГГГ' для поля ввода (год 0000 — без года).
const birthdayInput = (b) => { if (!b) return ''; const [y, m, d] = b.split('-'); return `${d}.${m}${y !== '0000' ? '.' + y : ''}`; };

// Аккаунт покупателя на витрине: зарегистрирован ли, когда входил, его заказы.
async function renderCustomerAccount(c) {
  $('#customer-account-info').innerHTML = c.registered_at
    ? `Зарегистрирован ${new Date(c.registered_at).toLocaleDateString('ru-RU')}${c.last_login_at ? ` · последний вход ${dateTime(c.last_login_at)}` : ''}${c.login_disabled ? ' · <b class="neg">вход закрыт</b>' : ''}`
    : 'Не зарегистрирован на витрине. Покупатель может зарегистрироваться сам по этому номеру — номер подтвердится кодом.';
  $('#customer-block').hidden = !c.registered_at;
  $('#customer-block').textContent = c.login_disabled ? 'Открыть вход' : 'Закрыть вход на витрину';
  $('#customer-temp-pass').textContent = c.registered_at ? 'Выдать временный пароль' : 'Создать аккаунт с временным паролем';
  $('#customer-orders').innerHTML = '';
  try {
    const orders = await api(`/api/customers/${c.id}/orders`);
    $('#customer-orders').innerHTML = orders.length ? '<h3>Заказы с витрины</h3>' + orders.map((o) => `
      <div class="history-row">
        <span>${dateTime(o.created_at)}</span>
        <span>№${o.id} · ${esc(o.items.map((i) => i.name).join(', ')).slice(0, 120)}<span class="pcat"> · ${esc({ new: 'новый', confirmed: 'подтверждён', ready: 'собран', shipped: 'у курьера', done: 'выдан', cancelled: 'отменён' }[o.status] || o.status)}</span></span>
        <b class="num">${money(o.total)}</b>
      </div>`).join('') : '';
  } catch { /* заказы не обязательны для карточки */ }
}

$('#customer-temp-pass').addEventListener('click', async () => {
  const c = loyaltyView.customer;
  try {
    const r = await api(`/api/customers/${c.id}/password`, { method: 'POST' });
    $('#customer-temp-result').innerHTML = `Временный пароль: <b class="num">${esc(r.password)}</b>. Сообщите его покупателю — он войдёт на витрину по номеру ${phoneFmt(r.phone)} и сменит пароль в «Изменить данные или пароль».`;
    $('#customer-temp-result').hidden = false;
    c.registered_at ||= Date.now();
    renderCustomerAccount(c);
  } catch (err) {
    showFormError('#customer-error', err);
  }
});
$('#customer-block').addEventListener('click', async () => {
  const c = loyaltyView.customer;
  try {
    const fresh = await api(`/api/customers/${c.id}/login`, { method: 'PUT', body: { disabled: !c.login_disabled } });
    loyaltyView.customer = { ...c, login_disabled: fresh.login_disabled };
    toast(fresh.login_disabled ? 'Вход на витрину закрыт' : 'Вход на витрину открыт');
    renderCustomerAccount(loyaltyView.customer);
    renderCustomers();
  } catch (err) {
    showFormError('#customer-error', err);
  }
});

/* ---------- Коды подтверждения, которые нужно передать покупателю ---------- */
async function renderCodes() {
  if (!session.can('customers.accounts')) return;
  let list;
  try { list = await api('/api/customers/codes'); } catch { return; }
  $('#codes-panel').hidden = !list.length;
  $('#codes-list').innerHTML = list.map((c) => `
    <div class="code-row ${c.sent_by ? 'sent' : ''}">
      <b class="code-big num">${esc(c.code)}</b>
      <div><div class="pname">${esc(c.name || 'Покупатель')} · <a href="tel:+${esc(c.phone)}">${phoneFmt(c.phone)}</a></div>
        <div class="pcat">${c.purpose === 'reset' ? 'Забыл пароль' : 'Регистрация'} · запрошен ${dateTime(c.created_at)} · действует до ${new Date(c.expires_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${c.sent_by ? ` · передал ${esc(c.sent_by)}` : ''}</div></div>
      <div class="tools">
        <a class="btn small" href="https://wa.me/${esc(c.phone)}?text=${encodeURIComponent('Ваш код подтверждения: ' + c.code)}" target="_blank" rel="noopener">💬 WhatsApp</a>
        ${c.sent_by ? '' : `<button type="button" class="btn small primary" data-code-sent="${c.id}">Передал</button>`}
      </div>
    </div>`).join('');
}
$('#codes-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-code-sent]');
  if (!btn) return;
  try { await api(`/api/customers/codes/${btn.dataset.codeSent}/sent`, { method: 'POST' }); renderCodes(); } catch (err) { toast(err.message, 'error'); }
});
salesFeed.codeListeners.push(() => { if (currentView === 'loyalty') renderCodes(); });

async function openCustomer(customer) {
  loyaltyView.customer = customer;
  const f = $('#customer-form');
  f.reset();
  $('#customer-dialog-title').textContent = customer ? customer.name || phoneFmt(customer.phone) : 'Новый покупатель';
  $('#customer-error').hidden = true;
  $('#customer-bonus').hidden = !customer;
  $('#customer-account').hidden = !customer;
  $('#customer-temp-result').hidden = true;
  if (customer) renderCustomerAccount(customer);
  const editable = !customer || session.can('loyalty');
  f.elements.phone.disabled = f.elements.name.disabled = f.elements.birthday.disabled = !editable;
  $('#customer-save').hidden = !editable;
  if (customer) {
    f.elements.phone.value = phoneFmt(customer.phone);
    f.elements.name.value = customer.name;
    f.elements.birthday.value = birthdayInput(customer.birthday);
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
    session.loyalty = await api('/api/loyalty', { method: 'PUT', body: {
      enabled: f.elements.enabled.checked, percent: parseNum(f.elements.percent.value), maxPay: parseNum(f.elements.maxPay.value),
      birthdayDiscount: parseNum(f.elements.birthdayDiscount.value) || 0, birthdayDays: parseNum(f.elements.birthdayDays.value) || 0,
    } });
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
    const body = { phone: f.elements.phone.value, name: f.elements.name.value, birthday: f.elements.birthday.value };
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

views.loyalty = { show: () => { renderLoyalty(); renderCodes(); }, right: 'customers' };
