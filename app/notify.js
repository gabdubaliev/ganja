'use strict';

// Уведомления о продажах: в открытые окна программы (Server-Sent Events)
// и в Telegram, если администратор подключил бота в настройках.

const { can } = require('./roles');

// Виды уведомлений в Telegram — каждое владелец включает и выключает в «Настройках» (по умолчанию все включены).
const TG_EVENTS = [
  ['Продажи и касса', [
    ['sale', '🧾 Каждая продажа на кассе (чек, товары, бонусы)'],
    ['refund', '↩️ Возврат чека'],
    ['shift_open', '🟢 Открытие смены: кто, когда, деньги на начало'],
    ['shift_close', '🔴 Закрытие смены и подробный отчёт дня'],
    ['cash_diff', '⚠️ Деньги в кассе не сошлись (недостача или излишек)'],
    ['chef_change', '🤝 «Сдача от шефа»: перевести сдачу клиенту'],
    ['expense_cash', '💸 Расход из кассы кассиром'],
  ]],
  ['Деньги', [
    ['expense', '💸 Расходы (аренда, доставка и т.д.)'],
    ['account', '🏦 Внесения, изъятия и переводы между счетами'],
    ['deleted', '⚠️ Удаление расходов и операций по счетам'],
    ['certificate', '🎁 Сертификаты: продажа, выдача, удаление'],
  ]],
  ['Товар и документы', [
    ['doc_purchase', '📦 Закупка'],
    ['doc_receipt', '➕ Оприходование'],
    ['doc_writeoff', '🗑️ Списание'],
    ['doc_inventory', '📋 Инвентаризация'],
    ['doc_transfer', '🚚 Перемещение между магазинами'],
    ['doc_return', '↩️ Возврат продажи (документ)'],
    ['doc_sale', '🧾 Продажа через админ-панель (документ)'],
    ['invoice', '📸 Приход по фото накладной'],
    ['doc_unpost', '⚠️ Отмена проведения документа'],
  ]],
  ['Интернет-витрина и Instagram', [
    ['order', '🛒 Новый заказ с витрины'],
    ['order_paid', '💳 Покупатель оплатил заказ или прикрепил чек'],
    ['codes', '🔑 Коды подтверждения для покупателей витрины'],
    ['ig_missing', '💬 Instagram: спросили цену, а артикула нет в базе'],
  ]],
];
const TG_KEYS = TG_EVENTS.flatMap(([, list]) => list.map(([k]) => k));

function createNotifier(store) {
  // Включено ли уведомление этого вида (и Telegram вообще). Без настройки — включено.
  function eventOn(key) {
    let map = {};
    try { map = JSON.parse(store.setting('tg_events', '{}')) || {}; } catch { map = {}; }
    return map[key] !== false;
  }
  function tgFor(key) {
    const tg = telegramSettings();
    return tg.enabled && eventOn(key) ? tg : null;
  }
  function setEvents(input) {
    const next = Object.fromEntries(TG_KEYS.map((k) => [k, input?.[k] !== false]));
    store.setSetting('tg_events', JSON.stringify(next));
    return next;
  }
  function events() {
    return Object.fromEntries(TG_KEYS.map((k) => [k, eventOn(k)]));
  }
  const clients = new Set(); // { res, user }

  // Окно программы подписывается на события: соединение держится открытым.
  function subscribe(req, res, user) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 5000\n\n');
    const client = { res, user };
    clients.add(client);
    // Прокси на хостинге закрывают молчащие соединения, поэтому раз в 25 секунд шлём пустую строку.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  }

  function broadcast(event, data, right) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      // Права проверяются заново: сотрудника могли отключить, пока окно было открыто.
      const fresh = c.user && store.findUser(c.user.id);
      if (c.user && (!fresh || fresh.disabled)) continue;
      if (can(fresh || null, right)) c.res.write(message);
    }
  }

  function telegramSettings() {
    return JSON.parse(store.setting('telegram', JSON.stringify({ token: '', chatId: '', enabled: false })));
  }

  async function sendTelegram(text, settings = telegramSettings()) {
    if (!settings.token || !settings.chatId) throw new Error('Укажите токен бота и ID чата');
    const res = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Telegram ответил: ${body.description || res.status}`);
  }

  // Файл в Telegram (таблица отчёта): CSV открывается в Excel.
  async function sendTelegramFile(name, content, caption = '', settings = telegramSettings()) {
    if (!settings.token || !settings.chatId) throw new Error('Укажите токен бота и ID чата');
    const form = new FormData();
    form.append('chat_id', settings.chatId);
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([content], { type: 'text/csv' }), name);
    const res = await fetch(`https://api.telegram.org/bot${settings.token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Telegram ответил: ${body.description || res.status}`);
  }

  const rub = (n) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' сом';

  // Вызывается после каждого пробитого чека.
  function sale(sale, user) {
    const who = user ? user.name || user.email : 'Без входа';
    const data = { id: sale.id, total: sale.total, paid: sale.paid, user: who, userId: user?.id ?? null, items: sale.items.length, at: Date.now() };
    broadcast('sale', data, 'notify');
    const tg = tgFor('sale');
    if (!tg) return;
    const lines = [
      `🧾 Чек №${sale.id} — ${rub(sale.total)}`,
      sale.offlineAt ? `📴 Пробит без интернета в ${new Date(sale.offlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, отправлен, когда появилась связь` : '',
      `Кассир: ${who}`,
      ...sale.items.slice(0, 10).map((i) => `• ${i.name} × ${i.qty} = ${rub(i.qty * i.price)}`),
      sale.items.length > 10 ? `…и ещё ${sale.items.length - 10}` : '',
      sale.bonusSpent ? `Оплачено бонусами: ${rub(sale.bonusSpent)}` : '',
      sale.changeKept ? `Сдачу ${rub(sale.changeKept)} не выдали — оставили в кассе` : '',
      sale.chefChange ? `Сдачу ${rub(sale.chefChange)} переводит шеф` : '',
      sale.customer ? `Покупатель: ${sale.customer.name || '+' + sale.customer.phone}, начислено ${sale.bonusEarned} бонусов` : '',
    ].filter(Boolean);
    sendTelegram(lines.join('\n'), tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  // Новый заказ с интернет-витрины.
  function order(o) {
    broadcast('order', { id: o.id, total: o.total, name: o.name, items: o.items.length, at: Date.now() }, 'orders');
    const tg = tgFor('order');
    if (!tg) return;
    const lines = [
      `🛒 Новый заказ №${o.id} с витрины — ${rub(o.total)}`,
      `${o.name}, +${o.phone}`,
      o.delivery === 'delivery' ? `Доставка: ${o.address}` : 'Самовывоз',
      o.pay_name ? `Оплата: ${o.pay_name}${o.status === 'checking' ? ' — покупатель отметил «Я оплатил», проверьте поступление' : ''}` : '',
      ...o.items.slice(0, 15).map((i) => `• ${i.name} × ${i.qty} = ${rub(i.qty * i.price)}`),
      o.items.length > 15 ? `…и ещё ${o.items.length - 15}` : '',
      o.comment ? `Комментарий: ${o.comment}` : '',
    ].filter(Boolean);
    sendTelegram(lines.join('\n'), tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  // Покупатель нажал «Я оплатил» — сверить поступление денег.
  function orderPaid(o) {
    broadcast('order', { id: o.id, total: o.total, name: o.name, items: o.items.length, at: Date.now() }, 'orders');
    const tg = tgFor('order_paid');
    if (!tg) return;
    sendTelegram(`💳 Заказ №${o.id}: покупатель отметил оплату ${rub(o.total)} (${o.pay_name}). Проверьте поступление и подтвердите в «Заказах».\n${o.name}, +${o.phone}`, tg)
      .catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  // Покупатель прикрепил чек об оплате.
  function orderReceipt(o) {
    broadcast('order', { id: o.id, total: o.total, name: o.name, items: o.items.length, at: Date.now() }, 'orders');
    const tg = tgFor('order_paid');
    if (!tg) return;
    sendTelegram(`📎 Заказ №${o.id}: покупатель прикрепил чек об оплате ${rub(o.total)}. Проверьте в «Заказах».\n${o.name}, +${o.phone}`, tg)
      .catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  return { subscribe, broadcast, sale, order, orderPaid, orderReceipt, sendTelegram, sendTelegramFile, telegramSettings, eventOn, tgFor, setEvents, events };
}

module.exports = { createNotifier, TG_EVENTS };
