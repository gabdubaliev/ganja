'use strict';

// CRM: сделки (заявки) по воронке, история общения, задачи и связь с Instagram Direct и WhatsApp.
//
// Сделка — это обращение клиента: из Instagram, WhatsApp, звонка, витрины и т.д.
// У неё есть этап воронки, сумма, ответственный сотрудник, лента событий
// (заметки, сообщения, смены этапа) и задачи с датой («перезвонить завтра в 11»).

const crypto = require('node:crypto');
const { UserError, text, number, phone, round2, transaction } = require('./db');

const STAGES = [
  ['new', 'Новые'],
  ['contact', 'Связались'],
  ['offer', 'Предложение'],
  ['waiting', 'Ждём оплату'],
  ['won', 'Купили'],
  ['lost', 'Отказ'],
];
const STAGE_KEYS = new Set(STAGES.map(([k]) => k));
const CLOSED = new Set(['won', 'lost']);
const SOURCES = ['Instagram', 'WhatsApp', 'Telegram', 'Звонок', 'Витрина', 'Магазин', 'Рекомендация', 'Другое'];
const INSTAGRAM_API = process.env.INSTAGRAM_API_URL || 'https://graph.instagram.com/v21.0';
// Вход через Instagram: окно авторизации, обмен кода и продление маркера.
const INSTAGRAM_OAUTH = process.env.INSTAGRAM_OAUTH_URL || 'https://api.instagram.com';
const INSTAGRAM_GRAPH = process.env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com';
// Единый вход Meta и связка «Facebook-страница + Instagram»: маркеры EAA работают только с graph.facebook.com.
const FACEBOOK_API = process.env.FACEBOOK_API_URL || 'https://graph.facebook.com/v21.0';
const FACEBOOK_DIALOG = process.env.FACEBOOK_DIALOG_URL || 'https://www.facebook.com/v21.0';
const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

function createCrm(store) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      instagram TEXT NOT NULL DEFAULT '',
      ig_user_id TEXT,
      source TEXT NOT NULL DEFAULT 'Другое',
      stage TEXT NOT NULL DEFAULT 'new',
      amount REAL NOT NULL DEFAULT 0,
      user_id INTEGER,
      customer_id INTEGER,
      order_id INTEGER,
      lost_reason TEXT NOT NULL DEFAULT '',
      unread INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage, updated_at);
    CREATE INDEX IF NOT EXISTS leads_ig ON leads(ig_user_id);
    CREATE TABLE IF NOT EXISTS lead_events (
      id INTEGER PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS lead_events_lead ON lead_events(lead_id, at);
    CREATE TABLE IF NOT EXISTS lead_tasks (
      id INTEGER PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      due_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      user_id INTEGER,
      done_at INTEGER,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_tasks_due ON lead_tasks(done_at, due_at);
  `);
  // Номер сообщения Instagram: Meta иногда присылает одно сообщение повторно — второй раз не записываем.
  if (!db.prepare('PRAGMA table_info(lead_events)').all().some((c) => c.name === 'ext_id')) db.exec('ALTER TABLE lead_events ADD COLUMN ext_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS lead_events_ext ON lead_events(ext_id) WHERE ext_id IS NOT NULL');
  // wa_id — номер, с которого клиент написал в WhatsApp: только таким можно ответить из CRM.
  if (!db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'wa_id')) db.exec('ALTER TABLE leads ADD COLUMN wa_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS leads_wa ON leads(wa_id)');

  const who = (user) => (user ? user.name || user.email : '');
  const event = (leadId, kind, body, userName = '', extId = null) => {
    db.prepare('INSERT INTO lead_events (lead_id, at, kind, text, user_name, ext_id) VALUES (?, ?, ?, ?, ?, ?)').run(leadId, Date.now(), kind, String(body).slice(0, 4000), userName, extId);
    db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(Date.now(), leadId);
  };

  function getLead(id) {
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (!l) throw new UserError('Сделка не найдена');
    return l;
  }

  const userName = (id) => (id ? db.prepare("SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = ?").get(id)?.n || '' : '');

  function fields(input, cur = {}) {
    const pick = (k, f) => (input[k] === undefined ? cur[k] : f(input[k]));
    const out = {
      title: pick('title', (v) => text(v, 'Что хочет клиент', { max: 200 })) ?? '',
      name: pick('name', (v) => text(v, 'Имя', { max: 80 })) ?? '',
      phone: pick('phone', (v) => (String(v ?? '').trim() ? phone(v) : '')) ?? '',
      instagram: pick('instagram', (v) => text(v, 'Instagram', { max: 60 }).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '')) ?? '',
      source: pick('source', (v) => (SOURCES.includes(v) ? v : 'Другое')) ?? 'Другое',
      amount: pick('amount', (v) => round2(number(v || 0, 'Сумма'))) ?? 0,
      user_id: pick('user_id', (v) => (v ? Number(v) : null)) ?? null,
      lost_reason: pick('lost_reason', (v) => text(v, 'Причина отказа', { max: 300 })) ?? '',
    };
    if (out.user_id && !store.findUser(out.user_id)) throw new UserError('Ответственный не найден');
    return out;
  }

  const crm = {
    STAGES,
    SOURCES,

    // Все открытые сделки и закрытые за последние 30 дней — для доски.
    list({ q = '', source = '', userId = null } = {}) {
      const like = `%${String(q).trim()}%`;
      const digits = String(q).replace(/\D/g, '');
      const rows = db.prepare(`
        SELECT l.*, COALESCE(NULLIF(u.name, ''), u.email, '') AS user_name,
          (SELECT MIN(due_at) FROM lead_tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL) AS next_task_at,
          (SELECT text FROM lead_events e WHERE e.lead_id = l.id AND e.kind IN ('in', 'out', 'note', 'call') ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_event
        FROM leads l LEFT JOIN users u ON u.id = l.user_id
        WHERE (l.closed_at IS NULL OR l.closed_at > ?)
          AND (? = '' OR l.source = ?)
          AND (? IS NULL OR l.user_id = ?)
          AND (? = '%%' OR l.name LIKE ? OR l.title LIKE ? OR l.instagram LIKE ? OR (? <> '' AND l.phone LIKE ?))
        ORDER BY l.unread DESC, l.updated_at DESC LIMIT 1000`)
        .all(Date.now() - 30 * 864e5, source, source, userId, userId, like, like, like, like, digits, `%${digits}%`);
      return rows;
    },

    get(id) {
      const l = getLead(id);
      return {
        ...l,
        user_name: userName(l.user_id),
        customer: l.customer_id ? store.findCustomer(l.customer_id) : null,
        events: db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at, id').all(l.id),
        tasks: db.prepare(`SELECT t.*, COALESCE(NULLIF(u.name, ''), u.email, '') AS user_name FROM lead_tasks t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.lead_id = ? ORDER BY t.done_at IS NOT NULL, t.due_at`).all(l.id),
      };
    },

    create(input, user, { quiet = false } = {}) {
      const f = fields(input);
      if (!f.name && !f.phone && !f.instagram && !f.title) throw new UserError('Укажите хотя бы имя, телефон или Instagram клиента');
      const stage = STAGE_KEYS.has(input.stage) ? input.stage : 'new';
      const now = Date.now();
      // Клиент с таким телефоном уже есть в программе лояльности — связываем.
      const customer = f.phone ? db.prepare('SELECT id FROM customers WHERE phone = ?').get(f.phone) : null;
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO leads (title, name, phone, instagram, ig_user_id, source, stage, amount, user_id, customer_id, order_id, unread, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.title, f.name, f.phone, f.instagram, input.ig_user_id || null, f.source, stage, f.amount, f.user_id ?? user?.id ?? null,
          customer?.id ?? null, input.order_id || null, input.unread ? 1 : 0, now, now, CLOSED.has(stage) ? now : null);
      if (!quiet) event(lastInsertRowid, 'system', `Сделка создана${user ? '' : ` (${f.source})`}`, who(user));
      return crm.get(lastInsertRowid);
    },

    update(id, input, user) {
      const cur = getLead(id);
      const f = fields(input, cur);
      const stage = input.stage !== undefined ? (STAGE_KEYS.has(input.stage) ? input.stage : cur.stage) : cur.stage;
      if (stage === 'lost' && cur.stage !== 'lost' && !f.lost_reason) throw new UserError('Укажите причину отказа — так видно, почему теряем клиентов');
      return transaction(db, () => {
        db.prepare(`UPDATE leads SET title = ?, name = ?, phone = ?, instagram = ?, source = ?, amount = ?, user_id = ?, lost_reason = ?, stage = ?,
          closed_at = ?, updated_at = ? WHERE id = ?`)
          .run(f.title, f.name, f.phone, f.instagram, f.source, f.amount, f.user_id, f.lost_reason, stage,
            CLOSED.has(stage) ? cur.closed_at || Date.now() : null, Date.now(), cur.id);
        const name = Object.fromEntries(STAGES);
        if (stage !== cur.stage) event(cur.id, 'stage', `${name[cur.stage]} → ${name[stage]}${stage === 'lost' && f.lost_reason ? `: ${f.lost_reason}` : ''}`, who(user));
        if (f.user_id !== cur.user_id) event(cur.id, 'system', `Ответственный: ${userName(f.user_id) || 'никто'}`, who(user));
        return crm.get(cur.id);
      });
    },

    remove(id) {
      const l = getLead(id);
      transaction(db, () => {
        db.prepare('DELETE FROM lead_events WHERE lead_id = ?').run(l.id);
        db.prepare('DELETE FROM lead_tasks WHERE lead_id = ?').run(l.id);
        db.prepare('DELETE FROM leads WHERE id = ?').run(l.id);
      });
      return l;
    },

    // kind: note — заметка, call — звонок, out — сообщение клиенту, in — сообщение от клиента.
    addEvent(id, { kind = 'note', text: body }, user) {
      const l = getLead(id);
      const t = text(body, 'Текст', { required: true, max: 4000 });
      event(l.id, ['note', 'call', 'out', 'in'].includes(kind) ? kind : 'note', t, who(user));
      return crm.get(l.id);
    },

    markRead(id) {
      db.prepare('UPDATE leads SET unread = 0 WHERE id = ?').run(getLead(id).id);
      return { ok: true };
    },

    addTask(id, input, user) {
      const l = getLead(id);
      const due = number(input.due_at, 'Когда', { positive: true });
      const t = text(input.text, 'Что сделать', { required: true, max: 300 });
      const assignee = input.user_id ? Number(input.user_id) : l.user_id ?? user?.id ?? null;
      db.prepare('INSERT INTO lead_tasks (lead_id, due_at, text, user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(l.id, due, t, assignee, who(user), Date.now());
      event(l.id, 'system', `Задача: ${t} — до ${new Date(due).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, who(user));
      return crm.get(l.id);
    },

    toggleTask(taskId, user) {
      const t = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(Number(taskId));
      if (!t) throw new UserError('Задача не найдена');
      db.prepare('UPDATE lead_tasks SET done_at = ? WHERE id = ?').run(t.done_at ? null : Date.now(), t.id);
      if (!t.done_at) event(t.lead_id, 'system', `Выполнено: ${t.text}`, who(user));
      return crm.get(t.lead_id);
    },

    // Открытые задачи на сегодня и просроченные: всех или одного сотрудника.
    tasks({ userId = null } = {}) {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      return db.prepare(`
        SELECT t.*, l.name AS lead_name, l.title AS lead_title, l.stage, COALESCE(NULLIF(u.name, ''), u.email, '') AS user_name
        FROM lead_tasks t JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.user_id
        WHERE t.done_at IS NULL AND t.due_at <= ? AND (? IS NULL OR t.user_id = ?)
        ORDER BY t.due_at LIMIT 200`).all(end.getTime(), userId, userId);
    },

    // Сводка воронки: сколько сделок и на какую сумму на каждом этапе, конверсия за 30 дней.
    summary() {
      const since = Date.now() - 30 * 864e5;
      const byStage = Object.fromEntries(db.prepare(`SELECT stage, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM leads
        WHERE closed_at IS NULL OR closed_at > ? GROUP BY stage`).all(since).map((r) => [r.stage, { n: r.n, sum: round2(r.sum) }]));
      const closed = db.prepare(`SELECT stage, COUNT(*) AS n FROM leads WHERE closed_at > ? GROUP BY stage`).all(since);
      const won = closed.find((r) => r.stage === 'won')?.n || 0;
      const lost = closed.find((r) => r.stage === 'lost')?.n || 0;
      return { byStage, won, lost, conversion: won + lost ? won / (won + lost) : null, unread: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE unread = 1').get().n };
    },

    // Клиент из сделки → в программу лояльности (нужен телефон).
    toCustomer(id, user) {
      const l = getLead(id);
      if (l.customer_id) return crm.get(l.id);
      if (!l.phone) throw new UserError('Чтобы завести карту покупателя, укажите телефон клиента');
      const c = store.findCustomerByPhone(l.phone) || store.createCustomer({ phone: l.phone, name: l.name });
      db.prepare('UPDATE leads SET customer_id = ? WHERE id = ?').run(c.id, l.id);
      event(l.id, 'system', 'Клиент добавлен в покупатели', who(user));
      return crm.get(l.id);
    },

    // Заказ с витрины сразу попадает в CRM новой сделкой.
    fromOrder(order) {
      const lines = order.items.map((i) => `${i.name} × ${i.qty}`).join(', ');
      const lead = crm.create({ title: `Заказ №${order.id} с витрины`, name: order.name, phone: order.phone, source: 'Витрина', amount: order.total, order_id: order.id, unread: true }, null, { quiet: true });
      event(lead.id, 'in', `Заказ №${order.id}: ${lines}. ${order.delivery === 'delivery' ? `Доставка: ${order.address}` : 'Самовывоз'}${order.comment ? `. Комментарий: ${order.comment}` : ''}`, order.name);
      return lead;
    },

    /* ---------- Instagram ---------- */

    instagramSettings() {
      const saved = JSON.parse(store.setting('instagram', '{}'));
      // Токен проверки для вебхука придумываем сами один раз.
      if (!saved.verifyToken) {
        saved.verifyToken = crypto.randomBytes(12).toString('hex');
        store.setSetting('instagram', JSON.stringify(saved));
      }
      return { enabled: false, appSecret: '', accessToken: '', appId: '', configId: '', igId: '', pageId: '', pageName: '', pageToken: '', tokenExpires: null, autoReply: false, autoText: '', autoHours: 12, ...saved };
    },

    setInstagram(input) {
      const cur = crm.instagramSettings();
      const next = {
        ...cur,
        enabled: Boolean(input.enabled),
        appSecret: input.appSecret ? text(input.appSecret, 'App Secret', { max: 100 }) : cur.appSecret,
        accessToken: input.accessToken ? text(input.accessToken, 'Токен доступа', { max: 1000 }) : cur.accessToken,
        appId: input.appId !== undefined ? String(input.appId).replace(/\D/g, '').slice(0, 30) : cur.appId,
      };
      if (input.configId !== undefined) next.configId = String(input.configId).replace(/\D/g, '').slice(0, 30);
      if (input.igId !== undefined) next.igId = String(input.igId).replace(/\D/g, '').slice(0, 30);
      // Новый маркер вручную: срок и привязка к странице определяются заново.
      if (input.accessToken) Object.assign(next, { tokenExpires: null, tokenLong: false, pageId: '', pageName: '', pageToken: '' });
      // Автоответ: на сообщение в Direct клиенту уходит этот текст — не чаще раза в autoHours часов одному человеку.
      if ('autoReply' in input) {
        next.autoReply = Boolean(input.autoReply);
        next.autoText = text(input.autoText, 'Текст автоответа', { max: 1000 });
        const h = Number(input.autoHours);
        next.autoHours = Number.isFinite(h) && h >= 1 && h <= 168 ? Math.round(h) : 12;
        if (next.autoReply && !next.autoText) throw new UserError('Напишите текст автоответа');
      }
      if (next.enabled && !next.appSecret) throw new UserError('Чтобы включить Instagram, укажите секрет приложения (по нему программа проверяет, что сообщения пришли от Meta)');
      store.setSetting('instagram', JSON.stringify(next));
      return next;
    },

    // Автоответ ценой (ig-price.js): включение, слова-вопросы о цене, шаблон ответа, публичный ответ.
    // Хранится вместе с остальными настройками Instagram; ключи и токен здесь не меняются.
    setInstagramAuto(input) {
      const cur = crm.instagramSettings();
      const next = {
        ...cur,
        autoPrice: Boolean(input.autoPrice),
        priceWords: text(input.priceWords ?? cur.priceWords ?? '', 'Слова-вопросы о цене', { max: 500 }),
        priceTemplate: text(input.priceTemplate ?? cur.priceTemplate ?? '', 'Шаблон ответа', { max: 1000 }),
        publicReply: text(input.publicReply ?? cur.publicReply ?? '', 'Публичный ответ', { max: 300 }),
        notifyMissing: input.notifyMissing === undefined ? cur.notifyMissing !== false : Boolean(input.notifyMissing),
      };
      if (next.autoPrice && !next.priceTemplate.includes('{price}')) throw new UserError('В шаблоне ответа должна быть цена — {price}');
      store.setSetting('instagram', JSON.stringify(next));
      return next;
    },

    // Автоответ в CRM: клиент — в открытую сделку (или новую), вопрос и ответ — в ленту событий.
    logInstagramAuto({ igUserId, username = '', inText = '', outText, amount = 0, title = '' }) {
      let lead = db.prepare('SELECT * FROM leads WHERE ig_user_id = ? AND closed_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(String(igUserId));
      if (!lead) {
        lead = crm.create({ title: title ? `Спросил цену: ${title}`.slice(0, 200) : 'Вопрос о цене в Instagram', source: 'Instagram', ig_user_id: String(igUserId),
          name: username ? `@${username}` : 'Клиент из Instagram', instagram: username || '', amount: amount || 0, unread: false }, null, { quiet: true });
      }
      if (inText) event(lead.id, 'in', inText, username ? `@${username}` : 'Instagram');
      event(lead.id, 'out', outText, 'Автоответ');
      return lead.id;
    },

    // Проверка подписи Meta (Instagram и WhatsApp): HMAC-SHA256 тела запроса ключом App Secret.
    verifySignature(raw, header, appSecret) {
      if (!appSecret || !header?.startsWith('sha256=')) return false;
      const expected = crypto.createHmac('sha256', appSecret).update(raw).digest();
      const given = Buffer.from(header.slice(7), 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    },

    // Входящие сообщения из вебхука: каждое — в открытую сделку этого человека или в новую.
    receiveInstagram(payload) {
      const received = [];
      for (const entry of payload?.entry || []) {
        for (const m of entry.messaging || []) {
          const senderId = String(m.sender?.id || '');
          // Эхо — наши же ответы; сообщения от самого аккаунта не считаем входящими.
          if (!senderId || m.message?.is_echo || senderId === String(entry.id)) continue;
          const body = m.message?.text || (m.message?.attachments?.length ? '📎 Вложение (фото, видео или голосовое — откройте в Instagram)' : '');
          if (!body) continue;
          const mid = m.message?.mid ? String(m.message.mid) : null;
          if (mid && db.prepare('SELECT 1 FROM lead_events WHERE ext_id = ?').get(mid)) continue;
          let lead = db.prepare('SELECT * FROM leads WHERE ig_user_id = ? AND closed_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(senderId);
          if (!lead) {
            lead = crm.create({ title: 'Сообщение в Instagram', source: 'Instagram', ig_user_id: senderId, name: 'Клиент из Instagram', unread: true }, null, { quiet: true });
            received.push({ lead, isNew: true });
          } else {
            received.push({ lead, isNew: false });
          }
          event(lead.id, 'in', body, lead.name || 'Instagram', mid);
          db.prepare('UPDATE leads SET unread = 1 WHERE id = ?').run(lead.id);
        }
      }
      return received;
    },

    /* ---------- Запросы к Instagram: три способа подключения ---------- */
    // instagram — маркер IGAA (вход через Instagram, graph.instagram.com, «/me»);
    // page — маркер EAA и Facebook-страница, связанная с Instagram (graph.facebook.com, от имени страницы);
    // unified — маркер EAA «единого входа» без страницы (graph.facebook.com, по ID аккаунта Instagram).
    instagramMode(s = crm.instagramSettings()) {
      if (!s.accessToken) return null;
      if (!/^EAA/.test(s.accessToken)) return 'instagram';
      return s.pageId && s.pageToken ? 'page' : 'unified';
    },
    async igCall(method, pathname, body = null) {
      const s = crm.instagramSettings();
      const mode = crm.instagramMode(s);
      if (!mode) throw new UserError('Instagram не подключён: нет маркера доступа');
      let path = pathname;
      let token = s.accessToken;
      if (mode !== 'instagram') {
        const self = mode === 'page' ? s.pageId : s.igId;
        if (!s.igId && mode === 'unified') throw new UserError('Укажите «ID аккаунта Instagram» (например, 17841464829611662) — без него маркер единого входа не знает, от чьего имени писать');
        if (mode === 'page') token = s.pageToken;
        // «/me/messages» — от имени страницы (или аккаунта Instagram); «/me?fields» — сведения об аккаунте Instagram.
        path = path.replace(/^\/me\/messages/, `/${self}/messages`).replace(/^\/me(?=\?|$)/, `/${s.igId}`);
      }
      const base = mode === 'instagram' ? INSTAGRAM_API : FACEBOOK_API;
      let res, data;
      try {
        res = await fetch(`${base}${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        throw new UserError(`Нет связи с Instagram: ${err.message}`);
      }
      if (!res.ok || data.error) throw new UserError(data.error?.message || `ошибка ${res.status}`);
      return data;
    },

    // Имя и ник отправителя — отдельным запросом к Instagram, если токен позволяет.
    async fillInstagramProfile(leadId) {
      const l = getLead(leadId);
      if (!l.ig_user_id || !crm.instagramSettings().accessToken || l.instagram) return;
      try {
        const p = await crm.igCall('GET', `/${encodeURIComponent(l.ig_user_id)}?fields=name,username`);
        if (p.username || p.name) {
          db.prepare('UPDATE leads SET instagram = ?, name = CASE WHEN name = ? THEN ? ELSE name END WHERE id = ?')
            .run(p.username || '', 'Клиент из Instagram', p.name || p.username || 'Клиент из Instagram', l.id);
        }
      } catch (err) {
        console.error('Instagram: не получилось узнать имя отправителя:', err.message);
      }
    },

    // Автоответ на входящее сообщение: если включён и этому человеку автоответ не уходил последние autoHours часов.
    // Возвращает отправленный текст, null (не нужно) или бросает ошибку (Instagram не принял).
    async instagramAutoReply(leadId) {
      const s = crm.instagramSettings();
      if (!s.enabled || !s.autoReply || !s.autoText || !s.accessToken) return null;
      const l = getLead(leadId);
      if (!l.ig_user_id) return null;
      const last = db.prepare(`SELECT MAX(e.at) AS at FROM lead_events e JOIN leads l ON l.id = e.lead_id
        WHERE l.ig_user_id = ? AND e.kind = 'out' AND e.user_name = 'Автоответ'`).get(l.ig_user_id).at;
      if (last && Date.now() - last < s.autoHours * 3600e3) return null;
      await crm.replyInstagram(l.id, s.autoText, null, 'Автоответ');
      return s.autoText;
    },

    // «Подключить Instagram». С «ID конфигурации» — единый вход Meta (окно Facebook, маркер EAA),
    // без него — вход через Instagram (окно Instagram, маркер IGAA).
    instagramAuthUrl(redirectUri) {
      const s = crm.instagramSettings();
      if (!s.appId) throw new UserError('Укажите «ID приложения» (номер приложения MONT CRM, например 1572299708264451) и сохраните');
      if (!s.appSecret) throw new UserError('Укажите «Секрет приложения» и сохраните');
      const state = crypto.randomBytes(16).toString('hex');
      store.setSetting('instagram_oauth_state', JSON.stringify({ state, at: Date.now() }));
      if (s.configId) {
        const q = new URLSearchParams({ client_id: s.appId, redirect_uri: redirectUri, config_id: s.configId, response_type: 'code', state });
        return `${FACEBOOK_DIALOG}/dialog/oauth?${q}`;
      }
      const q = new URLSearchParams({ client_id: s.appId, redirect_uri: redirectUri, response_type: 'code', state,
        scope: 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments' });
      return `https://www.instagram.com/oauth/authorize?${q}`;
    },
    async instagramConnect(code, state, redirectUri) {
      const saved = JSON.parse(store.setting('instagram_oauth_state', '{}'));
      store.setSetting('instagram_oauth_state', '{}');
      if (!state || state !== saved.state || Date.now() - saved.at > 30 * 60e3) throw new UserError('Ссылка входа устарела — нажмите «Подключить Instagram» ещё раз');
      const s = crm.instagramSettings();
      const clean = String(code || '').replace(/#_$/, '');
      if (s.configId) {
        const r = await fetch(`${FACEBOOK_API}/oauth/access_token?${new URLSearchParams({ client_id: s.appId, client_secret: s.appSecret, redirect_uri: redirectUri, code: clean })}`, { signal: AbortSignal.timeout(15_000) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.access_token) throw new UserError(`Meta не выдала маркер: ${d.error?.message || `ошибка ${r.status}`}`);
        store.setSetting('instagram', JSON.stringify({ ...crm.instagramSettings(), accessToken: d.access_token, tokenExpires: d.expires_in ? Date.now() + d.expires_in * 1000 : null, pageId: '', pageToken: '', enabled: true }));
        await crm.resolveFacebookToken();
        return crm.checkInstagram();
      }
      const form = new URLSearchParams({ client_id: s.appId, client_secret: s.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: clean });
      const r1 = await fetch(`${INSTAGRAM_OAUTH}/oauth/access_token`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
      const d1 = await r1.json().catch(() => ({}));
      if (!r1.ok || !d1.access_token) throw new UserError(`Instagram не выдал маркер: ${d1.error_message || d1.error?.message || `ошибка ${r1.status}`}`);
      const r2 = await fetch(`${INSTAGRAM_GRAPH}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: s.appSecret, access_token: d1.access_token })}`, { signal: AbortSignal.timeout(15_000) });
      const d2 = await r2.json().catch(() => ({}));
      const token = d2.access_token || d1.access_token;
      store.setSetting('instagram', JSON.stringify({ ...crm.instagramSettings(), accessToken: token, tokenExpires: d2.expires_in ? Date.now() + d2.expires_in * 1000 : Date.now() + 3600e3, enabled: true }));
      return crm.checkInstagram();
    },
    // Маркер EAA: короткий (из Graph API Explorer) — продлеваем до долгого; ищем Facebook-страницу со связанным Instagram
    // (тогда пишем от имени страницы и подписываем страницу на сообщения). Без страницы — единый вход по ID аккаунта Instagram.
    async resolveFacebookToken() {
      let s = crm.instagramSettings();
      if (!/^EAA/.test(s.accessToken || '')) return null;
      const get = async (path, token) => {
        const r = await fetch(`${FACEBOOK_API}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) });
        return r.json().catch(() => ({}));
      };
      if (s.appId && s.appSecret && !s.tokenLong) {
        const d = await get(`/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: s.appId, client_secret: s.appSecret, fb_exchange_token: s.accessToken })}`, s.accessToken).catch(() => ({}));
        if (d.access_token) s = { ...s, accessToken: d.access_token, tokenExpires: d.expires_in ? Date.now() + d.expires_in * 1000 : null };
        s.tokenLong = true;
      }
      const pages = await get('/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100', s.accessToken).catch(() => ({}));
      const withIg = (pages.data || []).filter((p) => p.instagram_business_account);
      const page = withIg.find((p) => p.instagram_business_account.id === s.igId) || withIg[0];
      let note = '';
      if (page) {
        s = { ...s, pageId: page.id, pageName: page.name, pageToken: page.access_token, igId: page.instagram_business_account.id, igUsername: page.instagram_business_account.username || '' };
        // Подписка страницы на сообщения (иначе вебхуки Direct от неё не приходят). Без права — только предупреждение.
        const sub = await fetch(`${FACEBOOK_API}/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions&access_token=${encodeURIComponent(page.access_token)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) })
          .then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
        if (sub.error) note = `страница не подписана на сообщения: ${sub.error.message}`;
      } else {
        s = { ...s, pageId: '', pageName: '', pageToken: '' };
        if (!s.igId) {
          const a = await get('/me/assigned_instagram_accounts?fields=id,username', s.accessToken).catch(() => ({}));
          if (a.data?.[0]) s = { ...s, igId: a.data[0].id, igUsername: a.data[0].username || '' };
        }
      }
      store.setSetting('instagram', JSON.stringify({ ...s, resolveNote: note }));
      return { mode: crm.instagramMode(s), page: page ? page.name : null, note };
    },
    // Продление долгого маркера IGAA (раз в 6 часов; продлевается, если до конца < 20 дней).
    async refreshInstagramToken() {
      const s = crm.instagramSettings();
      if (!s.accessToken || !/^IG/.test(s.accessToken)) return null;
      if (s.tokenExpires && s.tokenExpires - Date.now() > 20 * 864e5) return null;
      const r = await fetch(`${INSTAGRAM_GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: s.accessToken })}`, { signal: AbortSignal.timeout(15_000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new UserError(d.error?.message || `ошибка ${r.status}`);
      store.setSetting('instagram', JSON.stringify({ ...crm.instagramSettings(), accessToken: d.access_token, tokenExpires: Date.now() + (d.expires_in || 5184000) * 1000 }));
      return true;
    },

    // Проверка: какой аккаунт Instagram стоит за подключением.
    async checkInstagram() {
      const s = crm.instagramSettings();
      if (!s.accessToken) throw new UserError('Маркер доступа не указан — нажмите «Подключить Instagram» или вставьте маркер');
      let data;
      try {
        data = await crm.igCall('GET', crm.instagramMode(s) === 'instagram' ? '/me?fields=user_id,username,name' : '/me?fields=id,username,name');
      } catch (err) {
        throw new UserError(`Instagram не принял маркер: ${err.message}`);
      }
      return { username: data.username || '', name: data.name || '', id: data.user_id || data.id || '', mode: crm.instagramMode(s), page: s.pageName || '' };
    },

    // Ответ клиенту в Direct. Instagram разрешает писать в течение 24 часов после его последнего сообщения.
    async replyInstagram(id, body, user, author = null) {
      const l = getLead(id);
      const t = text(body, 'Сообщение', { required: true, max: 1000 });
      const { enabled, accessToken } = crm.instagramSettings();
      if (!enabled || !accessToken) throw new UserError('Instagram не подключён: «Ещё» → «Настройки» → Instagram');
      if (!l.ig_user_id) throw new UserError('Этот клиент не писал в Instagram Direct — ответить можно только тому, кто написал первым');
      try {
        await crm.igCall('POST', '/me/messages', { recipient: { id: l.ig_user_id }, message: { text: t } });
      } catch (err) {
        const msg = err.message;
        throw new UserError(/24|window|outside/i.test(msg) ? 'Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт написать первым. Ответьте, когда клиент напишет снова.' : `Instagram не принял сообщение: ${msg}`);
      }
      event(l.id, 'out', t, author || who(user));
      return crm.get(l.id);
    },

    /* ---------- WhatsApp (WhatsApp Business Cloud API) ---------- */

    whatsappSettings() {
      const saved = JSON.parse(store.setting('whatsapp', '{}'));
      if (!saved.verifyToken) {
        saved.verifyToken = crypto.randomBytes(12).toString('hex');
        store.setSetting('whatsapp', JSON.stringify(saved));
      }
      return { enabled: false, appSecret: '', accessToken: '', phoneNumberId: '', ...saved };
    },

    setWhatsapp(input) {
      const cur = crm.whatsappSettings();
      const next = {
        ...cur,
        enabled: Boolean(input.enabled),
        appSecret: input.appSecret ? text(input.appSecret, 'App Secret', { max: 100 }) : cur.appSecret,
        accessToken: input.accessToken ? text(input.accessToken, 'Токен доступа', { max: 1000 }) : cur.accessToken,
        phoneNumberId: input.phoneNumberId !== undefined ? text(input.phoneNumberId, 'ID номера телефона', { max: 40 }).replace(/\D/g, '') : cur.phoneNumberId,
        // Коды подтверждения для покупателей витрины — одобренным шаблоном категории «Аутентификация».
        otpEnabled: input.otpEnabled === undefined ? Boolean(cur.otpEnabled) : Boolean(input.otpEnabled),
        otpTemplate: input.otpTemplate !== undefined ? text(input.otpTemplate, 'Название шаблона', { max: 100 }) : cur.otpTemplate || '',
        otpLang: input.otpLang !== undefined ? text(input.otpLang, 'Язык шаблона', { max: 10 }) || 'ru' : cur.otpLang || 'ru',
      };
      if (next.otpEnabled && !next.otpTemplate) throw new UserError('Укажите название одобренного шаблона для кодов');
      if (next.enabled && (!next.appSecret || !next.accessToken || !next.phoneNumberId)) {
        throw new UserError('Чтобы включить WhatsApp, укажите App Secret, токен доступа и ID номера телефона');
      }
      store.setSetting('whatsapp', JSON.stringify(next));
      return next;
    },

    // Входящие из вебхука WhatsApp: entry[].changes[].value.messages[]. Статусы доставки пропускаем.
    receiveWhatsapp(payload) {
      const received = [];
      const ATTACH = { image: '🖼 Фото', video: '🎬 Видео', audio: '🎤 Голосовое', voice: '🎤 Голосовое', document: '📄 Документ', sticker: 'Стикер', location: '📍 Геолокация', contacts: '👤 Контакт' };
      for (const entry of payload?.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const names = Object.fromEntries((value.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || '']));
          for (const m of value.messages || []) {
            const from = String(m.from || '').replace(/\D/g, '');
            if (!from) continue;
            const body = m.type === 'text' ? m.text?.body
              : m.type === 'button' ? m.button?.text
              : m.type === 'interactive' ? m.interactive?.button_reply?.title || m.interactive?.list_reply?.title
              : `${ATTACH[m.type] || '📎 Вложение'} — откройте в WhatsApp${m[m.type]?.caption ? `: ${m[m.type].caption}` : ''}`;
            if (!body) continue;
            const mid = m.id ? `wa:${m.id}` : null;
            if (mid && db.prepare('SELECT 1 FROM lead_events WHERE ext_id = ?').get(mid)) continue;
            const name = names[from] || '';
            // Открытая сделка с этого номера или с тем же телефоном, внесённым вручную.
            let lead = db.prepare('SELECT * FROM leads WHERE (wa_id = ? OR phone = ?) AND closed_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(from, from);
            const isNew = !lead;
            if (!lead) {
              lead = crm.create({ title: 'Сообщение в WhatsApp', source: 'WhatsApp', phone: from, name: name || 'Клиент из WhatsApp', unread: true }, null, { quiet: true });
            }
            db.prepare("UPDATE leads SET wa_id = ?, unread = 1, name = CASE WHEN name IN ('', 'Клиент из WhatsApp') AND ? <> '' THEN ? ELSE name END WHERE id = ?")
              .run(from, name, name, lead.id);
            event(lead.id, 'in', body, name || '+' + from, mid);
            received.push({ lead, isNew });
          }
        }
      }
      return received;
    },

    // Ответ клиенту в WhatsApp. Свободным текстом можно писать 24 часа после последнего сообщения клиента,
    // позже — только одобренным шаблоном (в Meta Business Manager).
    async replyWhatsapp(id, body, user) {
      const l = getLead(id);
      const t = text(body, 'Сообщение', { required: true, max: 4096 });
      const { enabled, accessToken, phoneNumberId } = crm.whatsappSettings();
      if (!enabled || !accessToken || !phoneNumberId) throw new UserError('WhatsApp не подключён: «Ещё» → «Настройки» → WhatsApp');
      if (!l.wa_id) throw new UserError('Этот клиент не писал в WhatsApp. Напишите ему по кнопке «WhatsApp» — откроется чат в приложении.');
      let res, data;
      try {
        res = await fetch(`${WHATSAPP_API}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: l.wa_id, type: 'text', text: { preview_url: false, body: t } }),
          signal: AbortSignal.timeout(15_000),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        throw new UserError(`Нет связи с WhatsApp: ${err.message}`);
      }
      if (!res.ok || data.error) {
        const msg = data.error?.error_data?.details || data.error?.message || `ошибка ${res.status}`;
        throw new UserError(data.error?.code === 131047 || /24|re-engagement|window/i.test(msg)
          ? 'Прошло больше 24 часов с последнего сообщения клиента — WhatsApp разрешает писать только шаблоном. Позвоните клиенту или дождитесь, когда он напишет.'
          : `WhatsApp не принял сообщение: ${msg}`);
      }
      event(l.id, 'out', t, who(user));
      return crm.get(l.id);
    },
  };
  return crm;
}

module.exports = { createCrm, STAGES, SOURCES };
