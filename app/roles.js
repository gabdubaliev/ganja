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
  { key: 'refund', group: 'Касса', label: 'Оформлять возвраты' },
  { key: 'products', group: 'Товары', label: 'Заводить и менять товары, цены, групповое изменение' },
  { key: 'products.delete', group: 'Товары', label: 'Удалять товары' },
  { key: 'import', group: 'Товары', label: 'Импорт товаров из Excel' },
  { key: 'stock', group: 'Товары', label: 'Пересчитывать остаток (инвентаризация)' },
  { key: 'photos', group: 'Товары', label: 'Добавлять, менять и удалять фото товаров' },
  { key: 'arrivals', group: 'Склад', label: 'Приход товара от поставщика' },
  { key: 'customers', group: 'Покупатели', label: 'Список покупателей, рейтинг и история бонусов' },
  { key: 'loyalty', group: 'Покупатели', label: 'Правила бонусов и ручное изменение бонусов' },
  { key: 'orders', group: 'Интернет-витрина', label: 'Заказы с витрины' },
  { key: 'shop', group: 'Интернет-витрина', label: 'Создавать витрину и менять её оформление' },
  { key: 'staff', group: 'Персонал', label: 'Сотрудники, их права и ставки' },
  { key: 'shifts', group: 'Персонал', label: 'Смены всех сотрудников: открыть, закрыть, исправить' },
  { key: 'fines', group: 'Персонал', label: 'Штрафы: выписывать и отменять' },
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
    about: 'Видит всё и ведёт магазин, выписывает штрафы и правит смены. По умолчанию не меняет сотрудников, бонусы, оформление, настройки и не видит журнал действий.',
    can: ['dashboard', 'kpi', 'pos', 'sales', 'refund', 'products', 'products.delete', 'import', 'stock', 'photos', 'arrivals', 'customers', 'orders', 'notify', 'shifts', 'fines'],
  },
  cashier: {
    name: 'Кассир',
    about: 'Работает в окне кассы: открывает смену, продаёт, видит свои чеки, отправляет онлайн-заказы, меняет фото товаров.',
    can: ['pos', 'photos', 'orders'],
  },
  storekeeper: {
    name: 'Кладовщик',
    about: 'Товары, фото, приход и остатки. Не видит продажи и деньги.',
    can: ['products', 'stock', 'photos', 'arrivals'],
  },
};

// Права сотрудника: личный набор, если администратор его задал, иначе — набор роли.
function rightsOf(user) {
  if (!user) return ALL; // сотрудников ещё нет — программа открыта, как у администратора
  if (user.role === 'admin') return ALL;
  const custom = typeof user.rights === 'string' && user.rights ? JSON.parse(user.rights) : user.rights;
  return Array.isArray(custom) ? custom.filter((r) => ALL.includes(r)) : ROLES[user.role]?.can || [];
}

const can = (user, right) => rightsOf(user).includes(right);

module.exports = { RIGHTS, ROLES, rightsOf, can };
