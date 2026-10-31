'use strict';

// «Ещё»: все разделы, кроме главной, товаров и продаж, сгруппированные по смыслу.
// Видны только те, на которые у сотрудника есть право.

const MORE_GROUPS = [
  // Документы: каждый вид открывает общий список документов с этим фильтром (docs:вид).
  ['Документы', [
    ['docs:sale', 'docs.sale', '🧾', 'Продажа через админ-панель', 'Чек без кассы: оптовый клиент, предзаказ'],
    ['docs:purchase', 'arrivals', '📦', 'Закупка', 'Товар от поставщика, себестоимость'],
    ['docs:return', 'refund', '↩️', 'Возврат продажи', 'Покупатель вернул товар и деньги'],
    ['docs:receipt', 'arrivals', '➕', 'Оприходование', 'Товар без поставщика: найденный, подарок'],
    ['docs:writeoff', 'writeoff', '🗑️', 'Списание', 'Брак, просрочка, порча'],
    ['docs:inventory', 'stock', '📋', 'Инвентаризация', 'Пересчёт по факту: недостача и излишек'],
    ['docs:transfer', 'transfer', '🚚', 'Перемещение', 'Товар между магазинами (филиалами)'],
  ]],
  ['Прочее', [
    ['loyalty', 'customers', '⭐', 'Клиенты', 'Покупатели, рейтинг, бонусы и скидки'],
    ['suppliers', ['arrivals', 'transfer', 'stock', 'writeoff'], '🏭', 'Поставщики', 'Контакты, ИНН, закупки по каждому'],
    ['users', 'staff', '👥', 'Сотрудники', 'Роли, права, ставка за смену, процент'],
    ['accounts', 'accounts', '💰', 'Счета', 'Сколько денег в кассе и на счетах, внесение, изъятие, инкассация'],
    ['branches', ['settings', 'staff', 'transfer'], '🏬', 'Магазины', 'Филиалы: у каждого свои товары, сотрудники и кассы'],
    ['registers', ['settings', 'shifts', 'dashboard'], '🖥️', 'Кассы', 'Рабочие места, кто сейчас на кассе, выручка за день'],
  ]],
  ['Онлайн', [
    ['orders', 'orders', '🛒', 'Заказы с витрины', 'Подтвердить, собрать, отправить, выдать'],
    ['shop', 'shop', '🛍️', 'Интернет-витрина', 'Создать и оформить свой интернет-магазин'],
  ]],
  ['Покупатели', [
    ['crm', 'crm', '🤝', 'CRM — сделки', 'Заявки из Instagram, WhatsApp, витрины; переписка и задачи'],
  ]],
  ['Персонал', [
    ['shifts', ['shifts', 'kpi'], '🕘', 'Смены', 'Кто когда работал, выходы на смену'],
    ['fines', ['fines', 'kpi'], '⚠️', 'Штрафы', 'Причина, сумма, кто выписал'],
    ['timesheet', 'timesheet', '🗓️', 'Табель', 'Кто в какой день работал и сколько заработал, по 15 дней'],
    ['tasks', '', '✅', 'Задания', 'Задания на день, неделю, месяц; отметка «Выполнено» и проверка'],
  ]],
  ['Отчёты', [
    ['kpi', ['kpi', 'salary'], '📊', 'Отчёты', 'Зарплата с 1 по 15 и с 16 по конец месяца, топ продавцов, хиты товаров'],
    ['abc', ['kpi', 'dashboard'], '🔠', 'ABC / XYZ анализ', 'Какие товары приносят деньги и как ровно продаются: что держать, что заказывать, что убрать'],
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
        <a class="more-tile" href="#${view.split(':')[0]}" ${view.includes(':') ? `data-doc-kind="${view.split(':')[1]}"` : ''}>
          <span class="more-icon" aria-hidden="true">${icon}</span>
          <span class="more-text"><b>${title}${view === 'orders' ? ' <span class="badge" data-orders-badge hidden></span>' : view === 'tasks' ? ' <span class="badge" data-task-badge hidden></span>' : ''}</b><span>${about}</span></span>
        </a>`).join('')}
      </div>
    </section>`;
  }).join('') || '<p class="empty">Других разделов для вашей роли нет</p>';
  setOrdersBadge(session.newOrders || 0);
  if (typeof updateTaskBadge === 'function') updateTaskBadge();
}

// Плитка вида документа открывает список документов с этим фильтром.
$('#more-groups').addEventListener('click', (e) => {
  const a = e.target.closest('[data-doc-kind]');
  if (a) docsView.kind = a.dataset.docKind;
});

// Раздел открыт, если есть хоть одно право на что-то внутри.
views.more = { show: renderMore, right: null };
