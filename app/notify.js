'use strict';

// Уведомления о продажах: в открытые окна программы (Server-Sent Events)
// и в Telegram, если администратор подключил бота в настройках.

const { can } = require('./roles');

function createNotifier(store) {
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

  const rub = (n) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' сом';

  // Вызывается после каждого пробитого чека.
  function sale(sale, user) {
    const who = user ? user.name || user.email : 'Без входа';
    const data = { id: sale.id, total: sale.total, paid: sale.paid, user: who, userId: user?.id ?? null, items: sale.items.length, at: Date.now() };
    broadcast('sale', data, 'notify');
    const tg = telegramSettings();
    if (!tg.enabled) return;
    const lines = [
      `🧾 Чек №${sale.id} — ${rub(sale.total)}`,
      `Кассир: ${who}`,
      ...sale.items.slice(0, 10).map((i) => `• ${i.name} × ${i.qty} = ${rub(i.qty * i.price)}`),
      sale.items.length > 10 ? `…и ещё ${sale.items.length - 10}` : '',
      sale.bonusSpent ? `Оплачено бонусами: ${rub(sale.bonusSpent)}` : '',
      sale.customer ? `Покупатель: ${sale.customer.name || '+' + sale.customer.phone}, начислено ${sale.bonusEarned} бонусов` : '',
    ].filter(Boolean);
    sendTelegram(lines.join('\n'), tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  // Новый заказ с интернет-витрины.
  function order(o) {
    broadcast('order', { id: o.id, total: o.total, name: o.name, items: o.items.length, at: Date.now() }, 'orders');
    const tg = telegramSettings();
    if (!tg.enabled) return;
    const lines = [
      `🛒 Новый заказ №${o.id} с витрины — ${rub(o.total)}`,
      `${o.name}, +${o.phone}`,
      o.delivery === 'delivery' ? `Доставка: ${o.address}` : 'Самовывоз',
      ...o.items.slice(0, 15).map((i) => `• ${i.name} × ${i.qty} = ${rub(i.qty * i.price)}`),
      o.items.length > 15 ? `…и ещё ${o.items.length - 15}` : '',
      o.comment ? `Комментарий: ${o.comment}` : '',
    ].filter(Boolean);
    sendTelegram(lines.join('\n'), tg).catch((err) => console.error('Уведомление в Telegram не отправлено:', err.message));
  }

  return { subscribe, broadcast, sale, order, sendTelegram, telegramSettings };
}

module.exports = { createNotifier };
