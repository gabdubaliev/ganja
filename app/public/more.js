'use strict';

// «Ещё»: все разделы, кроме главной, товаров и продаж, сгруппированные по смыслу.
// Видны только те, на которые у сотрудника есть право.

const MORE_GROUPS = [
  ['Склад', [
    ['arrivals', 'arrivals', '📦', 'Приход товара', 'Поступления от поставщиков, себестоимость'],
    ['inventory', 'stock', '📋', 'Инвентаризация', 'Пересчёт товара по факту: недостача и излишек'],
    ['writeoff', 'writeoff', '🗑️', 'Списание', 'Брак, просрочка, порча — потери по себестоимости'],
  ]],
  ['Онлайн', [
    ['orders', 'orders', '🛒', 'Заказы с витрины', 'Подтвердить, собрать, отправить, выдать'],
    ['shop', 'shop', '🛍️', 'Интернет-витрина', 'Создать и оформить свой интернет-магазин'],
  ]],
  ['Покупатели', [
    ['crm', 'crm', '🤝', 'CRM — сделки', 'Заявки из Instagram, WhatsApp, витрины; переписка и задачи'],
    ['loyalty', 'customers', '⭐', 'Покупатели и бонусы', 'Рейтинг, дни рождения, бонусы и скидки'],
  ]],
  ['Персонал', [
    ['users', 'staff', '👥', 'Сотрудники', 'Роли, права, ставка за смену, процент'],
    ['shifts', ['shifts', 'kpi'], '🕘', 'Смены', 'Кто когда работал, выходы на смену'],
    ['fines', ['fines', 'kpi'], '⚠️', 'Штрафы', 'Причина, сумма, кто выписал'],
    ['timesheet', 'timesheet', '🗓️', 'Табель', 'Кто в какой день работал и сколько заработал, по 15 дней'],
    ['tasks', '', '✅', 'Задания', 'Задания на день, неделю, месяц; отметка «Выполнено» и проверка'],
  ]],
  ['Отчёты', [
    ['kpi', ['kpi', 'salary'], '📊', 'Отчёты', 'Зарплата с 1 по 15 и с 16 по конец месяца, топ продавцов, хиты товаров'],
  ]],
  ['Управление', [
    ['audit', 'audit', '🛡️', 'Журнал действий', 'Входы, попытки входа и все изменения'],
    ['design', 'design', '🎨', 'Оформление', 'Название, цвета, шрифт, свой CSS'],
    ['settings', 'settings', '⚙️', 'Настройки', 'Уведомления в Telegram'],
  ]],
];

const canAny = (rights) => [rights].flat().some((r) => session.can(r));

function renderMore() {
  $('#more-groups').innerHTML = MORE_GROUPS.map(([group, items]) => {
    const visible = items.filter(([, right]) => canAny(right));
    if (!visible.length) return '';
    return `<section class="more-group">
      <h2>${group}</h2>
      <div class="more-tiles">${visible.map(([view, , icon, title, about]) => `
        <a class="more-tile" href="#${view}">
          <span class="more-icon" aria-hidden="true">${icon}</span>
          <span class="more-text"><b>${title}${view === 'orders' ? ' <span class="badge" data-orders-badge hidden></span>' : view === 'tasks' ? ' <span class="badge" data-task-badge hidden></span>' : ''}</b><span>${about}</span></span>
        </a>`).join('')}
      </div>
    </section>`;
  }).join('') || '<p class="empty">Других разделов для вашей роли нет</p>';
  setOrdersBadge(session.newOrders || 0);
  if (typeof updateTaskBadge === 'function') updateTaskBadge();
}

// Раздел открыт, если есть хоть одно право на что-то внутри.
views.more = { show: renderMore, right: null };
