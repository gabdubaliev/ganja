'use strict';

// «Ещё» в окне кассы: всё, что не поместилось в нижнее меню (табель, история продаж, фото — если есть право).
const KASSA_MORE = [
  ['#expense', 'expenses.cash', '💸', 'Расход из кассы', 'Взяли наличные на нужды магазина: сумма и причина'],
  ['sales', 'pos', '🧾', 'История продаж', 'Ваши чеки за смену и за период, возврат'],
  ['mytimesheet', 'mytimesheet', '🗓️', 'Мой табель', 'Ваши смены и заработок за месяц'],
  ['photos', 'photos', '📷', 'Фото товаров', 'Добавить и заменить фото товаров и категорий'],
];

function renderKassaMore() {
  $('#kassa-more').innerHTML = KASSA_MORE.filter(([, right]) => session.can(right)).map(([view, , icon, title, about]) => `
    <a class="more-tile" href="${view.startsWith('#') ? '#more' : '#' + view}" ${view === '#expense' ? 'data-kx-open' : ''}>
      <span class="more-icon" aria-hidden="true">${icon}</span>
      <span class="more-text"><b>${esc(title)}</b><span>${esc(about)}</span></span>
    </a>`).join('') || '<p class="empty">Других разделов нет</p>';
}

const KX_CATEGORIES = ['Хозяйственные расходы', 'Доставка', 'Реклама', 'Связь и интернет', 'Ремонт', 'Прочее'];
$('#kassa-more').addEventListener('click', (e) => {
  if (!e.target.closest('[data-kx-open]')) return;
  e.preventDefault();
  const f = $('#kx-form');
  f.reset();
  $('#kx-error').hidden = true;
  f.elements.category.innerHTML = KX_CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  $('#kx-dlg').showModal();
  f.elements.amount.focus();
});
$('#kx-cancel').addEventListener('click', () => $('#kx-dlg').close());
$('#kx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseNum(f.elements.amount.value);
  const note = f.elements.note.value.trim();
  if (!(amount > 0)) return showFormError('#kx-error', new Error('Укажите, сколько денег взяли из кассы'));
  if (note.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '').length < 3) return showFormError('#kx-error', new Error('Напишите причину: на что взяли деньги'));
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/kassa/expense', { method: 'POST', body: { amount, note, category: f.elements.category.value } });
    $('#kx-dlg').close();
    toast(`Расход ${money(amount)} сохранён — деньги в кассе уменьшены`);
  } catch (err) {
    showFormError('#kx-error', err);
  } finally {
    btn.disabled = false;
  }
});

views.more = { show: renderKassaMore, right: null };
