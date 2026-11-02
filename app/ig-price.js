'use strict';

// Автоответ ценой в Instagram.
//
// Клиент пишет «цена» под рилсом → программа берёт подпись этого рилса, находит в ней артикул
// («Кардиган MS-123»), берёт цену и размеры из базы товаров и отправляет клиенту в Direct
// (приватный ответ на комментарий). Под комментарием — короткий публичный ответ «Отправили в Direct».
// Цена публично нигде не появляется.
//
// В Direct то же самое: если клиент прислал артикул или переслал рилс с артикулом в подписи,
// ему сразу приходит цена. Если артикула нет — вопрос остаётся менеджеру в CRM, как раньше.
//
// Каждый автоответ записывается в журнал (ig_price_log) — повторно на тот же комментарий
// или сообщение программа не отвечает, а одному человеку под одним рилсом отвечает раз в сутки.

const INSTAGRAM_API = process.env.INSTAGRAM_API_URL || 'https://graph.instagram.com/v21.0';
const DAY = 864e5;

const DEFAULTS = {
  autoPrice: false,
  priceWords: 'цена, цену, цены, сколько, почем, почём, стоимость, прайс, баасы, баа, канча, price, +',
  priceTemplate: [
    '{name}, арт. {article}',
    'Цена: {price} сом',
    'Без скидки: {oldPrice} сом',
    'Размеры в наличии: {sizes}',
    '',
    'Приходите примерить: пр. Манаса 10 (район Novotel), каждый день 10:00–22:00. Напишите свой размер — отложим его для вас на 24 часа.',
  ].join('\n'),
  publicReply: 'Отправили цену в Direct 📩',
  notifyMissing: true,
};

// Кандидаты в артикулы: «MS-123», «MS 123», «ms123», «Арт. 214», «арт: K-7».
function articleCandidates(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/арт(?:икул)?\.?\s*[:№#]?\s*([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-\/]{0,30})/gi)) out.push(m[1]);
  for (const m of s.matchAll(/(?<![A-Za-zА-Яа-яЁё0-9])([A-Za-zА-Яа-яЁё]{1,6}[\s\-]?\d{1,8}[A-Za-zА-Яа-я]?)(?![A-Za-zА-Яа-яЁё0-9])/g)) out.push(m[1]);
  return [...new Set(out)];
}

const money = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');

// Шаблон ответа: строка с пустой подстановкой ({oldPrice} без скидки, {sizes} без размеров) убирается целиком.
function renderPrice(template, p) {
  const values = {
    name: p.name,
    article: p.article || '',
    price: p.maxPrice > p.price ? `${money(p.price)}–${money(p.maxPrice)}` : money(p.price),
    oldPrice: p.oldPrice ? money(p.oldPrice) : '',
    sizes: p.sizes.join(', '),
  };
  const lines = [];
  for (const line of String(template || DEFAULTS.priceTemplate).split('\n')) {
    const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in values);
    if (used.includes('sizes') && !p.inStock) { lines.push('Сейчас этой модели нет в наличии — напишите, и мы сообщим, когда она поступит.'); continue; }
    if (used.some((k) => !values[k])) continue;
    lines.push(line.replace(/\{(\w+)\}/g, (all, k) => (k in values ? values[k] : all)));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function asksPrice(text, words) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  const list = String(words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true; // слов нет — отвечаем на любой комментарий
  return list.some((w) => t.includes(w));
}

function createIgPrice({ store, crm, notifier }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ig_price_log (
      id INTEGER PRIMARY KEY,
      ext_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      ig_user_id TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      media_id TEXT NOT NULL DEFAULT '',
      permalink TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '',
      article TEXT NOT NULL DEFAULT '',
      product_id INTEGER,
      status TEXT NOT NULL,
      reply TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ig_price_log_at ON ig_price_log(at);
    CREATE INDEX IF NOT EXISTS ig_price_log_user ON ig_price_log(ig_user_id, media_id, at);
  `);

  const captions = new Map(); // media id -> { caption, permalink, at }

  function settings() {
    const s = crm.instagramSettings();
    return { ...DEFAULTS, ...Object.fromEntries(Object.keys(DEFAULTS).filter((k) => s[k] !== undefined).map((k) => [k, s[k]])), accessToken: s.accessToken, enabled: s.enabled };
  }

  // Запрос к Instagram — через общий слой CRM: он сам выбирает способ подключения (маркер IGAA, страница Facebook
  // или единый вход Meta) и подставляет нужный адрес и маркер. token оставлен для совместимости вызовов.
  async function call(method, pathname, token, body) {
    return crm.igCall(method, pathname, body);
  }

  // Подпись рилса — у Instagram, с запасом на 10 минут: под популярным роликом спрашивают часто.
  async function media(mediaId, token) {
    if (!mediaId) return { caption: '', permalink: '' };
    const hit = captions.get(mediaId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    const m = await call('GET', `/${encodeURIComponent(mediaId)}?fields=caption,permalink`, token);
    const found = { caption: m.caption || '', permalink: m.permalink || '', at: Date.now() };
    captions.set(mediaId, found);
    if (captions.size > 500) captions.delete(captions.keys().next().value);
    return found;
  }

  // Первый артикул из текстов, который есть в базе. Возвращает и то, что искали, — для журнала.
  function productFrom(...texts) {
    const tried = [];
    for (const t of texts) {
      for (const c of articleCandidates(t)) {
        tried.push(c);
        const p = store.findByArticle(c);
        if (p) return { product: p, article: c, tried };
      }
    }
    return { product: null, article: '', tried };
  }

  function claim(extId, row) {
    const r = db.prepare(`INSERT OR IGNORE INTO ig_price_log (ext_id, kind, at, ig_user_id, username, media_id, question, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`).run(extId, row.kind, Date.now(), row.igUserId || '', row.username || '', row.mediaId || '', String(row.question || '').slice(0, 1000));
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  const finish = (id, f) => db.prepare(`UPDATE ig_price_log SET status = ?, article = ?, product_id = ?, reply = ?, error = ?, permalink = ? WHERE id = ?`)
    .run(f.status, f.article || '', f.productId ?? null, f.reply || '', String(f.error || '').slice(0, 500), f.permalink || '', id);

  async function tellManager(text) {
    try {
      const tg = notifier.telegramSettings();
      if (tg.enabled) await notifier.sendTelegram(text, tg);
    } catch (err) {
      console.error('Автоответ: уведомление в Telegram не отправлено:', err.message);
    }
  }

  async function onComment(ownId, v, s) {
    const fromId = String(v.from?.id || '');
    if (!v.id || !fromId || fromId === String(ownId)) return; // свои ответы не трогаем
    if (!asksPrice(v.text, s.priceWords)) return;
    const mediaId = String(v.media?.id || '');
    // Одному человеку под одним рилсом — раз в сутки, даже если он написал «цена» трижды.
    // 'new' — ответ на прошлый комментарий ещё отправляется (комментарии приходят почти одновременно).
    const recent = db.prepare("SELECT 1 FROM ig_price_log WHERE ig_user_id = ? AND media_id = ? AND status IN ('sent', 'new') AND at > ?").get(fromId, mediaId, Date.now() - DAY);
    const logId = claim(`c:${v.id}`, { kind: 'comment', igUserId: fromId, username: v.from?.username, mediaId, question: v.text });
    if (!logId) return;
    if (recent) return finish(logId, { status: 'repeat' });
    let m = { caption: '', permalink: '' };
    try {
      m = await media(mediaId, s.accessToken);
    } catch (err) {
      return finish(logId, { status: 'error', error: `подпись рилса: ${err.message}` });
    }
    const { product, article, tried } = productFrom(m.caption, v.text);
    if (!product) {
      finish(logId, { status: 'not_found', article: tried.join(', '), permalink: m.permalink });
      if (s.notifyMissing) {
        await tellManager(`💬 @${v.from?.username || 'клиент'} спросил цену под рилсом, но ${tried.length ? `артикула ${tried.join(', ')} нет в базе` : 'в подписи нет артикула'}.\n«${String(v.text).slice(0, 200)}»\n${m.permalink}\nОтветьте клиенту сами.`);
      }
      return;
    }
    const reply = renderPrice(s.priceTemplate, product);
    try {
      await call('POST', '/me/messages', s.accessToken, { recipient: { comment_id: v.id }, message: { text: reply } });
    } catch (err) {
      finish(logId, { status: 'error', article, productId: product.id, reply, error: err.message, permalink: m.permalink });
      await tellManager(`⚠️ Не получилось отправить цену @${v.from?.username || 'клиенту'} (${product.name}): ${err.message}\n${m.permalink}`);
      return;
    }
    finish(logId, { status: 'sent', article, productId: product.id, reply, permalink: m.permalink });
    if (s.publicReply) {
      call('POST', `/${encodeURIComponent(v.id)}/replies`, s.accessToken, { message: s.publicReply })
        .catch((err) => console.error('Автоответ: публичный ответ не опубликован:', err.message));
    }
    crm.logInstagramAuto({ igUserId: fromId, username: v.from?.username, inText: `Комментарий под рилсом: ${v.text}`, outText: reply, amount: product.price, title: product.name });
  }

  async function onDirect(ownId, msg, s) {
    const fromId = String(msg.sender?.id || '');
    const m = msg.message;
    if (!m || m.is_echo || !fromId || fromId === String(ownId) || !m.mid) return;
    // Что прислали: текст и подписи пересланных рилсов/постов (если Instagram их передал).
    const texts = [m.text || ''];
    const mediaIds = [];
    for (const a of m.attachments || []) {
      const p = a.payload || {};
      if (p.title) texts.push(p.title);
      if (p.reel_video_id) mediaIds.push(String(p.reel_video_id));
      else if (p.id && /reel|share|post|media/i.test(a.type || '')) mediaIds.push(String(p.id));
    }
    for (const id of mediaIds) {
      try { texts.push((await media(id, s.accessToken)).caption); } catch {} // чужой рилс или удалён — пропускаем
    }
    const { product, article } = productFrom(...texts);
    if (!product) return; // без артикула — вопрос менеджеру в CRM, как раньше
    const logId = claim(`d:${m.mid}`, { kind: 'direct', igUserId: fromId, mediaId: mediaIds[0], question: m.text || '📎 рилс' });
    if (!logId) return;
    const reply = renderPrice(s.priceTemplate, product);
    try {
      await call('POST', '/me/messages', s.accessToken, { recipient: { id: fromId }, message: { text: reply } });
    } catch (err) {
      return finish(logId, { status: 'error', article, productId: product.id, reply, error: err.message });
    }
    finish(logId, { status: 'sent', article, productId: product.id, reply });
    crm.logInstagramAuto({ igUserId: fromId, outText: reply, amount: product.price, title: product.name });
  }

  return {
    defaults: DEFAULTS,

    // Вебхук Instagram: комментарии (changes, field = comments) и сообщения Direct (messaging).
    async handle(payload) {
      const s = settings();
      if (!s.enabled || !s.autoPrice || !s.accessToken) return;
      for (const entry of payload?.entry || []) {
        for (const ch of entry.changes || []) {
          if (ch.field !== 'comments') continue;
          try { await onComment(entry.id, ch.value || {}, s); } catch (err) { console.error('Автоответ на комментарий:', err.message); }
        }
        for (const msg of entry.messaging || []) {
          try { await onDirect(entry.id, msg, s); } catch (err) { console.error('Автоответ в Direct:', err.message); }
        }
      }
    },

    // Проверка из настроек: какой ответ получит клиент на артикул.
    preview(article, template) {
      const p = store.findByArticle(article);
      if (!p) return { found: false };
      return { found: true, product: p, text: renderPrice(template || settings().priceTemplate, p) };
    },

    log({ limit = 50 } = {}) {
      return db.prepare(`SELECT id, kind, at, username, permalink, question, article, status, reply, error FROM ig_price_log
        WHERE status <> 'new' ORDER BY at DESC LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)));
    },

    stats(days = 7) {
      const since = Date.now() - days * DAY;
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM ig_price_log WHERE at > ? GROUP BY status').all(since);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
  };
}

module.exports = { createIgPrice, articleCandidates, renderPrice, asksPrice, IG_PRICE_DEFAULTS: DEFAULTS };
