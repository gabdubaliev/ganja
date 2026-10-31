'use strict';

// «Ещё»: все разделы, кроме главной, товаров и продаж, сгруппированные по смыслу.
// Видны только те, на которые у сотрудника есть право.

const MORE_GROUPS = [
  // Документы: каждый вид открывает общий список документов с этим фильтром (docs:вид).
  ['Документы', [
    ['docs:sale', 'docs.sale', '🧾', 'Продажа через админ-панель', 'Чек без кассы: оптовый клиент, предзаказ'],
    ['receive', 'receive.photo', '📸', 'Приход по фото накладной', 'Сфотографируйте накладную — товар разнесётся сам, цены по курсу доллара'],
    ['docs:purchase', 'arrivals', '📦', 'Закупка', 'Товар от поставщика, себестоимость'],
    ['docs:return', 'refund', '↩️', 'Возврат продажи', 'Покупатель вернул товар и деньги'],
    ['docs:receipt', 'arrivals', '➕', 'Оприходование', 'Товар без поставщика: найденный, подарок'],
    ['docs:writeoff', 'writeoff', '🗑️', 'Списание', 'Брак, просрочка, порча'],
    ['docs:inventory', 'stock', '📋', 'Инвентаризация', 'Пересчёт по факту: недостача и излишек'],
    ['docs:transfer', 'transfer', '🚚', 'Перемещение', 'Товар между магазинами (филиалами)'],
  ]],
  ['Прочее', [
    ['loyalty', 'customers', '⭐', 'Клиенты', 'Покупатели, рейтинг, бонусы и скидки'],
    ['certificates', 'certificates', '🎁', 'Сертификаты', 'Подарочные сертификаты: кто купил, остаток, срок, история'],
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
    ['bonuses', ['bonuses', 'salary', 'kpi'], '🎁', 'Бонусы', 'Дать бонус сотруднику вручную: за что, сколько, кто начислил'],
    ['timesheet', 'timesheet', '🗓️', 'Табель', 'Кто в какой день работал и сколько заработал, по 15 дней'],
    ['tasks', '', '✅', 'Задания', 'Задания на день, неделю, месяц; отметка «Выполнено» и проверка'],
  ]],
  ['Отчёты', [
    ['kpi', ['kpi', 'salary'], '📊', 'Отчёты', 'Зарплата с 1 по 15 и с 16 по конец месяца, топ продавцов, хиты товаров'],
    ['abc', 'abc', '🔠', 'ABC / XYZ анализ', 'Какие товары приносят деньги и как ровно продаются: что держать, что заказывать, что убрать'],
  ]],
  ['Управление', [
    ['audit', 'audit', '🛡️', 'Журнал действий', 'Входы, попытки входа и все изменения'],
    ['design', 'design', '🎨', 'Оформление', 'Название, цвета, шрифт, свой CSS'],
    ['settings', 'settings', '⚙️', 'Настройки', 'Уведомления в Telegram'],
  ]],
];

const canAny = (rights) => [rights].flat().some((r) => session.can(r));

// Все разделы программы для админ-панели владельца: верхнее меню и «Ещё».
const MAIN_SECTIONS = [
  ['home', 'dashboard', '🏠', 'Главная', 'Выручка, расходы, чистая прибыль, матрица, остатки'],
  ['products', 'products', '📦', 'Товары', 'Справочник товаров и карточки'],
  ['sales', 'sales', '🧾', 'Продажи', 'Журнал чеков'],
  ['kassa', 'pos', '🖥️', 'Касса', 'Окно кассира'],
];
function allSections() {
  return [['Верхнее меню', MAIN_SECTIONS], ...MORE_GROUPS];
}
// Раздел с настройками владельца: своё название, значок, скрыт ли.
function sectionView([key, right, icon, title, about]) {
  const s = session.layout?.sections?.[key] || {};
  return { key, right, icon: s.icon || icon, title: s.name || title, about, hidden: Boolean(s.hidden), origIcon: icon, origTitle: title };
}
// Порядок разделов внутри группы — как расставил владелец.
function orderedItems(group, items) {
  const order = session.layout?.order?.[group];
  if (!order?.length) return items;
  const pos = (k) => { const i = order.indexOf(k); return i < 0 ? 1e3 : i; };
  return [...items].sort((a, b) => pos(a[0]) - pos(b[0]));
}

function renderMore() {
  $('#more-groups').innerHTML = MORE_GROUPS.map(([group, items]) => {
    const visible = orderedItems(group, items).map(sectionView).filter((x) => canAny(x.right) && (!x.hidden || session.isOwner));
    if (!visible.length) return '';
    return `<section class="more-group">
      <h2>${group}</h2>
      <div class="more-tiles">${visible.map(({ key: view, icon, title, about, hidden }) => `
        <a class="more-tile ${hidden ? 'layout-dim' : ''}" href="#${view.split(':')[0]}" ${view.includes(':') ? `data-doc-kind="${view.split(':')[1]}"` : ''}>
          <span class="more-icon" aria-hidden="true">${esc(icon)}</span>
          <span class="more-text"><b>${esc(title)}${hidden ? ' <span class="role-tag">скрыт от сотрудников</span>' : ''}${view === 'orders' ? ' <span class="badge" data-orders-badge hidden></span>' : view === 'tasks' ? ' <span class="badge" data-task-badge hidden></span>' : ''}</b><span>${about}</span></span>
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

// Разделы, которые владелец закрепил в верхнем меню (рядом с «Главная», «Товары», «Продажи»).
function renderPinned() {
  for (const a of document.querySelectorAll('.nav a.nav-pinned')) a.remove();
  const all = new Map(allSections().flatMap(([, items]) => items).map((x) => [x[0], x]));
  const more = $('#nav-more');
  if (!more) return;
  for (const key of session.layout?.pinned || []) {
    const item = all.get(key);
    if (!item) continue;
    const x = sectionView(item);
    if (!canAny(x.right) || (x.hidden && !session.isOwner)) continue;
    const a = document.createElement('a');
    a.className = 'nav-pinned';
    a.href = `#${key.split(':')[0]}`;
    if (key.includes(':')) a.dataset.docKind = key.split(':')[1];
    a.innerHTML = `<span class="nav-emoji" aria-hidden="true">${esc(x.icon)}</span><span>${esc(x.title)}</span>`;
    a.addEventListener('click', () => { if (a.dataset.docKind) docsView.kind = a.dataset.docKind; });
    more.before(a);
  }
}
session.ready.then(renderPinned);

// Раздел открыт, если есть хоть одно право на что-то внутри.
views.more = { show: renderMore, right: null };
