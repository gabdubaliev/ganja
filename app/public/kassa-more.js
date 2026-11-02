'use strict';

// «Ещё» в окне кассы: всё, что не поместилось в нижнее меню (табель, история продаж, фото — если есть право).
const KASSA_MORE = [
  ['sales', 'pos', '🧾', 'История продаж', 'Ваши чеки за смену и за период, возврат'],
  ['mytimesheet', 'mytimesheet', '🗓️', 'Мой табель', 'Ваши смены и заработок за месяц'],
  ['photos', 'photos', '📷', 'Фото товаров', 'Добавить и заменить фото товаров и категорий'],
];

function renderKassaMore() {
  $('#kassa-more').innerHTML = KASSA_MORE.filter(([, right]) => session.can(right)).map(([view, , icon, title, about]) => `
    <a class="more-tile" href="#${view}">
      <span class="more-icon" aria-hidden="true">${icon}</span>
      <span class="more-text"><b>${esc(title)}</b><span>${esc(about)}</span></span>
    </a>`).join('') || '<p class="empty">Других разделов нет</p>';
}

views.more = { show: renderKassaMore, right: null };
