'use strict';

// Бот магазина слушает сообщения (длинный опрос getUpdates — без вебхука и без открытых портов).
// Нужен для кодов покупателям витрины («Поделиться номером» → код) и для подключения входа владельца с кодом.
// Последние сообщения хранятся в памяти: подключение 2FA ищет в них «/start код».

function createTgBot({ token, onMessage, log = console }) {
  let offset = 0;
  let running = false;
  let stopped = false;
  let warned = '';
  const recent = []; // последние 200 сообщений { message, at }

  async function call(method, body, timeoutMs = 15_000) {
    const t = token();
    if (!t) throw new Error('нет токена бота');
    const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) { const err = new Error(data.description || `ошибка ${res.status}`); err.code = data.error_code; throw err; }
    return data.result;
  }

  async function loop() {
    if (running) return;
    running = true;
    while (!stopped) {
      if (!token()) { await sleep(30_000); continue; }
      try {
        const began = Date.now();
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
        warned = '';
        // Telegram держит запрос до 25 секунд; если ответ пустой и мгновенный — пауза, чтобы не крутить цикл вхолостую.
        if (!updates.length && Date.now() - began < 500) await sleep(2000);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (!u.message) continue;
          recent.push({ message: u.message, at: Date.now() });
          if (recent.length > 200) recent.shift();
          try { await onMessage(u.message); } catch (err) { log.error('Бот: сообщение не обработано:', err.message); }
        }
      } catch (err) {
        // 409 — у бота настроен вебхук или его опрашивает другая программа: ждём и пробуем снова, пишем один раз.
        if (warned !== err.message) { warned = err.message; log.error('Бот Telegram не получает сообщения:', err.message); }
        await sleep(err.code === 409 ? 60_000 : 10_000);
      }
    }
    running = false;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

  return {
    start() { stopped = false; loop(); },
    stop() { stopped = true; },
    call,
    send: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra }),
    // Сообщения за последние minutes минут (для подключения входа владельца).
    recent: (minutes = 30) => recent.filter((x) => Date.now() - x.at < minutes * 60_000).map((x) => x.message),
    get problem() { return warned; },
  };
}

module.exports = { createTgBot };
