'use strict';

// «Ещё»: все разделы, кроме главной, товаров и продаж, сгруппированные по смыслу.
// Видны только те, на которые у сотрудника есть право.

const MORE_GROUPS = [
  // Документы: каждый вид открывает общий список документов с этим фильтром (docs:вид).
  ['Документы', [
    ['goods', ['sales', 'docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer'], '🔄', 'Движение товара', 'Все чеки и документы по дням: продажи, закупки, списания, перемещения'],
    ['cashflow', ['accounts', 'reports.money'], '💸', 'Движение денег', 'Каждый приход и расход по счетам: оплаты, комиссии, расходы, внесения, переводы'],
    ['docs', ['docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer'], '📄', 'Документы', 'Все документы списком: проведённые и черновики'],
    ['docs:sale', 'docs.sale', '🧾', 'Продажа через админ-панель', 'Чек без кассы: оптовый клиент, предзаказ'],
    ['receive', 'receive.photo', '📸', 'Приход по фото накладной', 'Сфотографируйте накладную — товар разнесётся сам, цены по курсу доллара'],
    ['docs:purchase', 'arrivals', '📦', 'Закупка', 'Товар от поставщика, себестоимость'],
    ['docs:return', 'refund', '↩️', 'Возврат продажи', 'Покупатель вернул товар и деньги'],
    ['docs:receipt', 'arrivals', '➕', 'Оприходование', 'Товар без поставщика: найденный, подарок'],
    ['docs:writeoff', 'writeoff', '🗑️', 'Списание', 'Брак, просрочка, порча'],
    ['docs:inventory', 'stock', '📋', 'Инвентаризация', 'Пересчёт по факту: недостача и излишек'],
    ['docs:transfer', 'transfer', '🚚', 'Перемещение', 'Товар между магазинами (филиалами)'],
    ['migrate', ['migrate', 'migrate.view'], '📥', 'Перенос из CloudShop', 'Товары из выгрузки CloudShop: проверить, разметить цвета и размеры, перенести (раздел можно скрыть в админ-панели)'],
  ]],
  ['Прочее', [
    ['loyalty', 'customers', '⭐', 'Клиенты', 'Покупатели, рейтинг, бонусы и скидки'],
    ['certificates', 'certificates', '🎁', 'Сертификаты', 'Подарочные сертификаты: кто купил, остаток, срок, история'],
    ['suppliers', ['arrivals', 'transfer', 'stock', 'writeoff'], '🏭', 'Поставщики', 'Контакты, ИНН, закупки по каждому'],
    ['users', 'staff', '👥', 'Сотрудники', 'Роли, права, ставка за смену, процент'],
    ['accounts', 'accounts', '💰', 'Счета', 'Счета и способы оплаты: сколько денег в кассе и на счетах, внесение, изъятие, кнопки оплаты на кассе'],
    ['loyaltyset', 'loyalty', '🎯', 'Лояльность', 'Накопительная система: сколько бонусов с покупки, сколько можно оплатить, скидка в день рождения'],
    ['branches', ['settings', 'staff', 'transfer'], '🏬', 'Магазины', 'Филиалы: у каждого свои товары, сотрудники и кассы'],
    ['registers', ['settings', 'shifts', 'dashboard'], '🖥️', 'Кассы', 'Рабочие места, кто сейчас на кассе, выручка за день'],
  ]],
  ['Онлайн', [
    ['orders', 'orders', '🛒', 'Заказы с витрины', 'Подтвердить, собрать, отправить, выдать'],
    ['shop', 'shop', '🛍️', 'Интернет-витрина', 'Создать и оформить свой интернет-магазин'],
    ['studio', 'studio', '🎨', 'Студия', 'Фото товаров: обработка, задания для ChatGPT, в галерею товара'],
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
    ['reports', 'dashboard', '📈', 'Отчёты', 'Расходы и чистая прибыль, топ товаров и сотрудников, ABC / XYZ матрица, товары и остатки — за период, как на главной'],
    ['kpi', ['kpi', 'salary'], '📊', 'Зарплата и продавцы', 'Зарплата с 1 по 15 и с 16 по конец месяца, топ продавцов, хиты товаров'],
    ['money', 'reports.money', '💹', 'ДДС и прибыль', 'Сколько денег пришло и ушло по месяцам, по статьям; выручка, расходы и чистая прибыль'],
    ['stockreport', 'reports.stock', '📦', 'Товарный отчёт', 'Остаток на начало, приход, расход, остаток на конец; остатки на любую дату'],
    ['deadstock', 'reports.stock', '🐌', 'Неликвиды', 'Что не продаётся 30, 60, 90 дней, сколько денег в этом лежит; уценка и ценники'],
    ['sizes', 'reports.stock', '📉', 'Заканчиваются размеры', 'Каких ходовых размеров не осталось или осталась последняя штука, сколько клиентов ждут — что дозаказать'],
    ['abc', 'abc', '🔠', 'ABC / XYZ анализ', 'Какие товары приносят деньги и как ровно продаются: что держать, что заказывать, что убрать'],
  ]],
  ['Управление', [
    ['access', 'staff', '🔐', 'Права и доступ', 'Все сотрудники и права одной таблицей: дать или убрать право сразу многим'],
    ['audit', ['audit', 'undo.own'], '🛡️', 'Журнал событий', 'Входы, попытки входа и все изменения; отмена изменений'],
    ['design', 'design', '🎨', 'Оформление', 'Название, цвета, шрифт, свой CSS'],
    ['automation', 'automation', '🤖', 'Автоматика', 'Отчёты в Telegram по расписанию и автоуценка неликвидов — без вашего участия'],
    ['print', 'print.design', '🖨️', 'Чеки и этикетки', 'Конструктор чека покупателю и этикеток на товар: что печатать, размер, шрифт'],
    ['settings', ['settings', 'currency'], '⚙️', 'Настройки компании', 'Уведомления в Telegram, курс доллара, SMS, Instagram, WhatsApp'],
  ]],
];

const canAny = (rights) => [rights].flat().some((r) => session.can(r));

// Все разделы программы для админ-панели владельца: верхнее меню и «Ещё».
const MAIN_SECTIONS = [
  ['home', 'dashboard', '🏠', 'Главная', 'Выручка и «Касса сейчас»'],
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
// В «Ещё» не показываем: что есть в меню слева (компьютер), в «+», список документов (его заменил «Движение товара»
// со статусом) и то, что открывается из «Настроек компании» (оформление, автоматика).
const MORE_SKIP = new Set(['docs', 'design', 'automation']);
const moreKeep = (key, side) => !(side && SIDE_KEYS.has(key)) && !inPlus(key) && !MORE_SKIP.has(key);
// Осталось ли что-то в «Ещё» (для пункта «Ещё» в меню слева).
function moreHasItems(side) {
  return MORE_GROUPS.some(([, items]) => items.some((it) => moreKeep(it[0], side) && canAny(it[1]) && !sectionHidden(it[0])));
}
// Что есть в «+» (документы, клиенты, сертификаты, сотрудники, счета, штрафы, бонусы, задания), в «Ещё» не повторяется.
// В «+» документ — «doc:вид», в «Ещё» — «docs:вид».
function inPlus(key) {
  const k = key.startsWith('docs:') ? `doc:${key.slice(5)}` : key;
  return PLUS_GROUPS.some(([, items]) => items.some((it) => it[0] === k));
}
// Группы «Ещё» на телефоне — по порядку меню слева; остальные разделы — в своих прежних группах ниже.
const PHONE_GROUPS = [
  ['Касса и смены', ['shifts', 'registers']],
  ['Журналы', ['cashflow', 'goods']],
  ['Отчёты', ['reports', 'money', 'kpi', 'stockreport', 'deadstock', 'sizes', 'abc']],
  ['Контрагенты', ['suppliers', 'loyalty']],
  ['Онлайн', ['shop', 'orders', 'crm']],
  ['Компания', ['settings', 'users', 'branches', 'loyaltyset', 'accounts', 'print']],
  ['Инструменты', ['studio', 'migrate']],
  ['Персонал и доступ', ['timesheet', 'access', 'audit']],
];
function phoneGroups() {
  const all = new Map(MORE_GROUPS.flatMap(([, items]) => items.map((it) => [it[0], it])));
  const used = new Set(PHONE_GROUPS.flatMap(([, keys]) => keys));
  const rest = MORE_GROUPS.map(([g, items]) => [g, items.filter((it) => !used.has(it[0]))]).filter(([, items]) => items.length);
  const out = PHONE_GROUPS.map(([g, keys]) => [g, keys.map((k) => all.get(k)).filter(Boolean)]);
  // Остальное — в одноимённую группу, если она уже есть (например, AI Studio — в «Онлайн»).
  for (const [g, items] of rest) { const same = out.find(([x]) => x === g); if (same) same[1].push(...items); else out.push([g, items]); }
  return out;
}
function orderedItems(group, items) {
  const order = session.layout?.order?.[group];
  if (!order?.length) return items;
  const pos = (k) => { const i = order.indexOf(k); return i < 0 ? 1e3 : i; };
  return [...items].sort((a, b) => pos(a[0]) - pos(b[0]));
}

function renderMore() {
  // «Касса» — первой плиткой (на телефоне её нет в нижней панели).
  // Касса открывается из «Касса и смены» → «Открыть кассу» (компьютер) и из раздела «Кассы» (телефон) — плитки нет.
  const kassa = false ? `<section class="more-group"><div class="more-tiles"><a class="more-tile more-kassa" href="/kassa.html" target="_blank"><span class="more-icon" aria-hidden="true">🖥️</span><span class="more-text"><b>Касса</b><span>Окно кассира: продажа, смена, чеки</span></span></a></div></section>` : '';
  // На компьютере с меню слева — только то, чего в меню нет; на телефоне и планшете — все разделы,
  // сгруппированные так же, как меню слева (Касса и смены, Журналы, Отчёты, Контрагенты, Компания…).
  const side = document.body.classList.contains('ui-side') && typeof SIDE_KEYS !== 'undefined';
  const groups = side ? MORE_GROUPS : phoneGroups();
  $('#more-groups').innerHTML = kassa + groups.map(([group, items]) => {
    const visible = orderedItems(group, items).filter((it) => moreKeep(it[0], side)).map(sectionView).filter((x) => canAny(x.right) && (!x.hidden || session.isOwner));
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

/* ---------- Кнопка «+» внизу (телефон): документы и разделы — окном поверх страницы ---------- */
const PLUS_GROUPS = [
  ['Документы', [
    ['doc:sale', 'docs.sale', '🧾', 'Продажа'], ['doc:purchase', 'arrivals', '📦', 'Закупка'],
    ['doc:return', 'refund', '↩️', 'Возврат продажи'], ['receive', 'receive.photo', '📸', 'Приход по фото'],
    ['doc:receipt', 'arrivals', '➕', 'Оприходование'], ['doc:writeoff', 'writeoff', '🗑️', 'Списание'],
    ['doc:inventory', 'stock', '📋', 'Инвентаризация'], ['doc:transfer', 'transfer', '🚚', 'Перемещение'],
  ]],
  ['Расходы', [
    ['expense-fixed', 'expenses', '🔁', 'Постоянный расход'], ['expense-once', 'expenses', '💸', 'Разовый расход'],
  ]],
  ['Товары', [
    ['new-product', 'products', '🏷️', 'Новый товар'], ['products', 'products', '📦', 'Все товары'],
    ['scan-product', 'products', '📷', 'Найти камерой'],
  ]],
  ['Прочее', [
    ['loyalty', 'customers', '⭐', 'Клиенты'], ['certificates', 'certificates', '🎁', 'Сертификаты'],
    ['users', 'staff', '👥', 'Сотрудники'], ['accounts', 'accounts', '💰', 'Счета'],
    ['fines', ['fines', 'kpi'], '⚠️', 'Штрафы'], ['bonuses', ['bonuses', 'salary', 'kpi'], '🎁', 'Бонусы'],
    ['tasks', '', '✅', 'Задания'],
  ]],
];
function plusSheet() {
  let sheet = document.getElementById('plus-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'plus-sheet';
    sheet.className = 'plus-sheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="plus-backdrop" data-plus-close></div><div class="plus-panel" role="dialog" aria-modal="true" aria-label="Создать"><div class="plus-grip" data-plus-close></div><div class="plus-body"></div></div>';
    document.body.append(sheet);
    sheet.addEventListener('click', onPlusClick);
    // Смахнуть окно вниз — закрыть.
    let y0 = null;
    const panel = sheet.querySelector('.plus-panel');
    panel.addEventListener('touchstart', (e) => { y0 = panel.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    panel.addEventListener('touchmove', (e) => { if (y0 !== null) { const d = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = d ? `translateY(${d}px)` : ''; } }, { passive: true });
    panel.addEventListener('touchend', (e) => { if (y0 === null) return; const d = e.changedTouches[0].clientY - y0; y0 = null; panel.style.transform = ''; if (d > 90) closePlus(); }, { passive: true });
  }
  // Только то, на что у сотрудника есть право (и что владелец не скрыл).
  const hiddenKey = (k) => Boolean(session.layout?.sections?.[k.startsWith('doc:') ? `docs:${k.slice(4)}` : k]?.hidden) && !session.isOwner;
  sheet.querySelector('.plus-body').innerHTML = PLUS_GROUPS.map(([group, items]) => {
    const list = items.filter(([k, right]) => (right === '' || canAny(right)) && !hiddenKey(k));
    if (!list.length) return '';
    return `<section><h3>${group}</h3><div class="plus-grid">${list.map(([k, , icon, title]) => `<button type="button" class="plus-item" data-plus="${k}"><span class="plus-icon" aria-hidden="true">${icon}</span><span>${esc(title)}</span></button>`).join('')}</div></section>`;
  }).join('') || '<p class="empty">Для вашей роли здесь ничего нет</p>';
  return sheet;
}
function openPlus() {
  const sheet = plusSheet();
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  document.body.classList.add('plus-open');
}
function closePlus() {
  const sheet = document.getElementById('plus-sheet');
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove('open');
  document.body.classList.remove('plus-open');
  setTimeout(() => { sheet.hidden = true; }, 220);
}
function onPlusClick(e) {
  if (e.target.closest('[data-plus-close]')) return closePlus();
  const b = e.target.closest('[data-plus]');
  if (!b) return;
  const k = b.dataset.plus;
  closePlus();
  if (k.startsWith('doc:')) return newDoc(k.slice(4)); // сразу новый документ
  if (k === 'scan-product') return openScanner({ onCode: async (code, close) => { if (!catalog.list.length) await catalog.load(); return productByScan(code, close); } });
  // Расходы — окно из «Отчётов» (там же видно, как расход лёг на чистую прибыль).
  if (k === 'expense-fixed' || k === 'expense-once') {
    const btn = k === 'expense-fixed' ? '#np-fixed-add' : '#np-add';
    if (currentView !== 'reports') location.hash = 'reports';
    return setTimeout(() => document.querySelector(btn)?.click(), currentView === 'reports' ? 0 : 400);
  }
  if (k === 'new-product') {
    if (currentView !== 'products') location.hash = 'products';
    return setTimeout(() => openProductDialog(null, typeof renderProducts === 'function' ? renderProducts : () => {}), currentView === 'products' ? 0 : 400);
  }
  location.hash = k;
}
$('#nav-plus')?.addEventListener('click', () => (document.getElementById('plus-sheet')?.hidden === false ? closePlus() : openPlus()));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlus(); });
window.addEventListener('hashchange', closePlus);
