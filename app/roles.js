'use strict';

// Роли и права. Право — это раздел или действие; маршруты сервера и меню
// интерфейса проверяют права, а не названия ролей.
//
// dashboard  — главная с выручкой и прибылью
// pos        — касса: продавать, заводить покупателей
// sales      — все чеки (без этого права кассир видит только свои)
// refund     — возвраты
// products   — товары: заводить, менять, импорт, пересчёт остатка
// photos     — фото товаров
// arrivals   — приход
// kpi        — эффективность сотрудников и зарплата
// customers  — список покупателей и их бонусы (просмотр)
// loyalty    — правила бонусов и ручное изменение бонусов
// staff      — сотрудники, оклады, проценты, планы
// settings   — настройки, уведомления в Telegram
// notify     — уведомления о каждой продаже

const ROLES = {
  admin: {
    name: 'Администратор',
    about: 'Всё, включая сотрудников, зарплаты, бонусы и настройки.',
    can: ['dashboard', 'pos', 'sales', 'refund', 'products', 'photos', 'arrivals', 'kpi', 'customers', 'loyalty', 'staff', 'settings', 'notify'],
  },
  manager: {
    name: 'Управляющий',
    about: 'Видит всё и ведёт магазин: товары, приход, возвраты, эффективность. Не меняет сотрудников, зарплаты, бонусы и настройки.',
    can: ['dashboard', 'pos', 'sales', 'refund', 'products', 'photos', 'arrivals', 'kpi', 'customers', 'notify'],
  },
  cashier: {
    name: 'Кассир',
    about: 'Работает в окне кассы: продаёт, видит свои чеки, меняет фото товаров.',
    can: ['pos', 'photos'],
  },
  storekeeper: {
    name: 'Кладовщик',
    about: 'Товары, фото, приход и остатки. Не видит продажи и деньги.',
    can: ['products', 'photos', 'arrivals'],
  },
};

const can = (user, right) => !user || Boolean(ROLES[user.role]?.can.includes(right));

module.exports = { ROLES, can };
