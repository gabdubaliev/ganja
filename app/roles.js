'use strict';

// Права и роли. Право — это раздел или действие; маршруты сервера и меню
// интерфейса проверяют права, а не названия ролей.
//
// Роль — готовый набор прав. Администратор может поставить или снять любые
// галочки конкретному сотруднику: тогда действует его личный набор.
// У роли «Администратор» всегда все права, чтобы программой было кому управлять.

const RIGHTS = [
  { key: 'dashboard', group: 'Отчёты', label: 'Главная: выручка, прибыль, хиты и остатки' },
  { key: 'kpi', group: 'Отчёты', label: 'Отчёты: хиты товаров, топ продавцов, зарплата' },
  { key: 'pos', group: 'Касса', label: 'Продавать на кассе и заводить покупателей' },
  { key: 'sales', group: 'Касса', label: 'Видеть все чеки (без этого — только свои)' },
  { key: 'refund', group: 'Касса', label: 'Оформлять возвраты: по чеку и документом «Возврат продажи»' },
  { key: 'discount', group: 'Касса', label: 'Давать скидку на кассе (на товар и на чек; предел — в карточке сотрудника)' },
  { key: 'sales.delete', group: 'Касса', label: 'Удалять продажи: по одной, выбранные и все сразу' },
  { key: 'products', group: 'Товары', label: 'Заводить и менять товары, цены, групповое изменение' },
  { key: 'products.delete', group: 'Товары', label: 'Удалять товары' },
  { key: 'import', group: 'Товары', label: 'Импорт товаров из Excel' },
  { key: 'stock.view', group: 'Товары', label: 'Видеть остатки товаров (на кассе, в товарах, на главной)' },
  { key: 'photos', group: 'Товары', label: 'Добавлять, менять и удалять фото товаров' },
  { key: 'docs.sale', group: 'Документы', label: 'Продажа через админ-панель (документ «Продажа»)' },
  { key: 'arrivals', group: 'Документы', label: 'Закупка и оприходование товара, поставщики' },
  { key: 'transfer', group: 'Документы', label: 'Перемещение товара между магазинами' },
  { key: 'docs.unpost', group: 'Документы', label: 'Отменять проведение документов («Не проведён»)' },
  { key: 'stock', group: 'Документы', label: 'Инвентаризация: пересчитывать остатки по факту' },
  { key: 'writeoff', group: 'Документы', label: 'Списание: брак, просрочка, порча' },
  { key: 'crm', group: 'Покупатели', label: 'CRM: сделки, переписка с клиентами, задачи' },
  { key: 'customers', group: 'Покупатели', label: 'Список покупателей, рейтинг и история бонусов' },
  { key: 'customers.accounts', group: 'Покупатели', label: 'Аккаунты покупателей на витрине: коды подтверждения, сброс пароля, блокировка' },
  { key: 'loyalty', group: 'Покупатели', label: 'Правила бонусов и ручное изменение бонусов' },
  { key: 'orders', group: 'Интернет-витрина', label: 'Заказы с витрины' },
  { key: 'shop', group: 'Интернет-витрина', label: 'Создавать витрину и менять её оформление' },
  { key: 'staff', group: 'Персонал', label: 'Сотрудники, их права и ставки' },
  { key: 'shifts', group: 'Персонал', label: 'Смены всех сотрудников: открыть, закрыть, исправить' },
  { key: 'fines', group: 'Персонал', label: 'Штрафы: выписывать и отменять' },
  { key: 'timesheet', group: 'Персонал', label: 'Табель: кто в какой день работал и сколько заработал' },
  { key: 'timesheet.edit', group: 'Персонал', label: 'Табель: менять — рабочие дни и выходные, сумма за день, цвет ячеек (в том числе группами)' },
  { key: 'tasks', group: 'Персонал', label: 'Задания: давать сотрудникам и проверять выполнение (свои задания видит каждый)' },
  { key: 'salary', group: 'Персонал', label: 'Зарплата: менять ставку, оклад, процент, план и бонус за план; начислять бонусы' },
  { key: 'expenses', group: 'Управление', label: 'Расходы: аренда, доставка, налоги и другие — для чистой прибыли на главной' },
  { key: 'accounts', group: 'Управление', label: 'Счета: остатки денег, внесение, изъятие, переводы между счетами' },
  { key: 'design', group: 'Управление', label: 'Оформление программы: цвета, шрифт, название' },
  { key: 'settings', group: 'Управление', label: 'Настройки и уведомления в Telegram' },
  { key: 'notify', group: 'Управление', label: 'Уведомления о каждой продаже и заказе' },
  { key: 'audit', group: 'Управление', label: 'Журнал действий: входы, попытки входа, изменения' },
];
const ALL = RIGHTS.map((r) => r.key);

const ROLES = {
  admin: {
    name: 'Администратор',
    about: 'Все права без исключений. Права администратора не урезаются.',
    can: ALL,
  },
  manager: {
    name: 'Управляющий',
    about: 'Видит всё и ведёт магазин, выписывает штрафы, правит смены, ведёт табель, даёт и проверяет задания. По умолчанию не меняет сотрудников, бонусы, оформление, настройки и не видит журнал действий.',
    can: ['dashboard', 'kpi', 'pos', 'sales', 'refund', 'discount', 'products', 'stock.view', 'products.delete', 'import', 'stock', 'photos', 'arrivals', 'crm', 'customers', 'customers.accounts', 'orders', 'notify', 'shifts', 'fines', 'timesheet', 'timesheet.edit', 'tasks', 'writeoff', 'docs.sale', 'transfer', 'docs.unpost', 'expenses'],
  },
  cashier: {
    name: 'Кассир',
    about: 'Работает в окне кассы: открывает смену, продаёт, видит свои чеки, отправляет онлайн-заказы, меняет фото товаров.',
    can: ['pos', 'photos', 'orders', 'discount', 'stock.view'],
  },
  storekeeper: {
    name: 'Кладовщик',
    about: 'Товары, фото, приход и остатки. Не видит продажи и деньги.',
    can: ['products', 'stock.view', 'stock', 'writeoff', 'photos', 'arrivals', 'transfer'],
  },
};

// Права сотрудника: личный набор, если администратор его задал, иначе — набор роли.
function rightsOf(user) {
  if (!user) return ALL; // сотрудников ещё нет — программа открыта, как у администратора
  if (user.role === 'admin') return ALL;
  const custom = typeof user.rights === 'string' && user.rights ? JSON.parse(user.rights) : user.rights;
  const list = Array.isArray(custom) ? custom.filter((r) => ALL.includes(r)) : ROLES[user.role]?.can || [];
  // Кто может менять табель, тот его и видит.
  return list.includes('timesheet.edit') && !list.includes('timesheet') ? [...list, 'timesheet'] : list;
}

const can = (user, right) => rightsOf(user).includes(right);

module.exports = { RIGHTS, ROLES, rightsOf, can };
