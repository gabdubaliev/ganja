'use strict';

// CRM: сделки (заявки) по воронке, история общения, задачи и связь с Instagram Direct и WhatsApp.
//
// Сделка — это обращение клиента: из Instagram, WhatsApp, звонка, витрины и т.д.
// У неё есть этап воронки, сумма, ответственный сотрудник, лента событий
// (заметки, сообщения, смены этапа) и задачи с датой («перезвонить завтра в 11»).

const crypto = require('node:crypto');
const { UserError, text, number, phone, round2, transaction } = require('./db');

// Воронка по умолчанию — для магазина одежды. Владелец меняет её в CRM → «⚙ Воронка»:
// добавляет, переименовывает, переставляет и красит этапы. «Купили» и «Отказ» — итоговые, есть всегда.
const STAGES = [
  ['new', 'Новое обращение', '#0ea5e9'],
  ['contact', 'Ответили', '#6366f1'],
  ['offer', 'Подобрали размер', '#a855f7'],
  ['waiting', 'Отложили / бронь', '#f59e0b'],
  ['visit', 'Придёт в магазин / доставка', '#14b8a6'],
  ['won', 'Купили', '#16a34a'],
  ['lost', 'Отказ', '#94a3b8'],
];
const CLOSED = new Set(['won', 'lost']);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const { can } = require('./roles');
const SOURCES = ['Instagram', 'WhatsApp', 'Telegram', 'Звонок', 'Витрина', 'Магазин', 'Рекомендация', 'Другое'];
const INSTAGRAM_API = process.env.INSTAGRAM_API_URL || 'https://graph.instagram.com/v21.0';
// Вход через Instagram: окно авторизации, обмен кода и продление маркера.
const INSTAGRAM_OAUTH = process.env.INSTAGRAM_OAUTH_URL || 'https://api.instagram.com';
const INSTAGRAM_GRAPH = process.env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com';
// Единый вход Meta и связка «Facebook-страница + Instagram»: маркеры EAA работают только с graph.facebook.com.
// Единый вход Meta появился в новых версиях API — работаем на v26.0 (как окно входа Meta).
const FACEBOOK_API_DEFAULT = process.env.FACEBOOK_API_URL || 'https://graph.facebook.com/v26.0';
const FACEBOOK_DIALOG = process.env.FACEBOOK_DIALOG_URL || 'https://www.facebook.com/v26.0';
const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

function createCrm(store) {
  // Адрес API Meta: по умолчанию v26.0; «Диагностика» может переключить на сработавший вариант (настройка fbBase).
  const fbBase = () => { try { return JSON.parse(store.setting('instagram', '{}')).fbBase || FACEBOOK_API_DEFAULT; } catch { return FACEBOOK_API_DEFAULT; } };
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
  // Вложения входящих сообщений (фото, видео, пересланные рилсы и посты): [{ type, url }] — ссылки Meta, живут несколько дней.
  if (!db.prepare('PRAGMA table_info(lead_events)').all().some((c) => c.name === 'attach')) db.exec("ALTER TABLE lead_events ADD COLUMN attach TEXT NOT NULL DEFAULT ''");
  // wa_id — номер, с которого клиент написал в WhatsApp: только таким можно ответить из CRM.
  if (!db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'wa_id')) db.exec('ALTER TABLE leads ADD COLUMN wa_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS leads_wa ON leads(wa_id)');

  const who = (user) => (user ? user.name || user.email : '');
  const event = (leadId, kind, body, userName = '', extId = null, attach = []) => {
    const files = (attach || []).filter((a) => /^https:\/\//i.test(a.url || '')).slice(0, 10).map((a) => ({ type: String(a.type || 'file').slice(0, 30), url: String(a.url).slice(0, 2000) }));
    db.prepare('INSERT INTO lead_events (lead_id, at, kind, text, user_name, ext_id, attach) VALUES (?, ?, ?, ?, ?, ?, ?)').run(leadId, Date.now(), kind, String(body).slice(0, 4000), userName, extId, files.length ? JSON.stringify(files) : '');
    db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(Date.now(), leadId);
  };

  const greeting = new Map(); // ig_user_id -> когда начали отправлять приветствие

  function getLead(id) {
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (!l) throw new UserError('Сделка не найдена');
    return l;
  }

  const userName = (id) => (id ? db.prepare("SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = ?").get(id)?.n || '' : '');

  // Воронка и раздача сделок (настройка crm_funnel).
  const DEFAULT_FUNNEL = { stages: STAGES.map(([key, name, color]) => ({ key, name, color })), autoAssign: true, assignFree: true };
  function funnel() {
    let s;
    try { s = JSON.parse(store.setting('crm_funnel', '') || 'null'); } catch { s = null; }
    if (!s || !Array.isArray(s.stages) || !s.stages.length) return { ...DEFAULT_FUNNEL, stages: DEFAULT_FUNNEL.stages.map((x) => ({ ...x })) };
    return { stages: s.stages, autoAssign: s.autoAssign !== false, assignFree: s.assignFree !== false };
  }
  const stageKeys = () => new Set(funnel().stages.map((x) => x.key));
  const stageNames = () => Object.fromEntries(funnel().stages.map((x) => [x.key, x.name]));

  // Кто сейчас на смене и может вести сделки: открытая смена (не старше суток), сотрудник не отключён, есть право «CRM».
  function onShift() {
    const rows = db.prepare(`SELECT DISTINCT u.* FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.closed_at IS NULL AND s.opened_at > ? AND COALESCE(u.disabled, 0) = 0 AND u.moved_to IS NULL ORDER BY u.id`).all(Date.now() - 864e5);
    return rows.filter((u) => can(u, 'crm'));
  }
  // Нагрузка сотрудника — сколько у него открытых сделок на первом этапе («Новое обращение»).
  const loadOf = (id) => db.prepare("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND closed_at IS NULL AND stage = 'new'").get(id).n;
  // Кому отдать новую сделку: тому из смены, у кого меньше новых обращений; при равенстве — по очереди.
  function nextAssignee() {
    const list = onShift();
    if (!list.length) return null;
    const last = Number(store.setting('crm_rr_last', '0')) || 0;
    const order = [...list.filter((x) => x.id > last), ...list.filter((x) => x.id <= last)];
    const loads = new Map(order.map((u) => [u.id, loadOf(u.id)]));
    const u = order.reduce((best, x) => (loads.get(x.id) < loads.get(best.id) ? x : best), order[0]);
    store.setSetting('crm_rr_last', String(u.id));
    return u;
  }
  // Сотрудник ещё не работал со сделкой: нет его сообщений, звонков и заметок (автоответ не в счёт).
  const untouched = (leadId) => !db.prepare(`SELECT 1 FROM lead_events WHERE lead_id = ? AND kind IN ('out', 'call', 'note')
    AND user_name NOT IN ('', 'Автоответ') LIMIT 1`).get(leadId);

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

    // Воронка для экрана: этапы, правила раздачи и кто сейчас получает сделки.
    funnel() {
      const f = funnel();
      const counts = Object.fromEntries(db.prepare('SELECT stage, COUNT(*) AS n FROM leads WHERE closed_at IS NULL OR closed_at > ? GROUP BY stage').all(Date.now() - 30 * 864e5).map((r) => [r.stage, r.n]));
      return { ...f, counts, onShift: onShift().map((u) => ({ id: u.id, name: u.name || u.email })),
        free: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id IS NULL AND closed_at IS NULL').get().n };
    },

    setFunnel(input, user) {
      const cur = funnel();
      const list = Array.isArray(input.stages) ? input.stages : cur.stages;
      const seen = new Set();
      const open = [];
      const fixed = {};
      for (const x of list) {
        const name = text(x?.name, 'Название этапа', { required: true, max: 40 });
        let key = String(x?.key || '').trim();
        if (!/^[a-z0-9_-]{1,24}$/i.test(key) || seen.has(key)) key = `s${crypto.randomBytes(3).toString('hex')}`;
        seen.add(key);
        const st = { key, name, color: COLOR_RE.test(x?.color || '') ? x.color.toLowerCase() : '#64748b' };
        if (CLOSED.has(key)) fixed[key] = st; else open.push(st);
      }
      if (!open.length) throw new UserError('Нужен хотя бы один рабочий этап');
      // Первый этап — куда попадают новые сделки (ключ new): он всегда первый.
      const first = open.findIndex((x) => x.key === 'new');
      if (first > 0) open.unshift(...open.splice(first, 1));
      if (first < 0) open.unshift({ key: 'new', name: 'Новое обращение', color: '#0ea5e9' });
      if (open.length > 15) throw new UserError('Не больше 15 рабочих этапов');
      const stages = [...open, fixed.won || { key: 'won', name: 'Купили', color: '#16a34a' }, fixed.lost || { key: 'lost', name: 'Отказ', color: '#94a3b8' }];
      const next = { stages, autoAssign: input.autoAssign === undefined ? cur.autoAssign : Boolean(input.autoAssign),
        assignFree: input.assignFree === undefined ? cur.assignFree : Boolean(input.assignFree) };
      const keys = new Set(stages.map((x) => x.key));
      transaction(db, () => {
        // Этап убрали — его сделки переходят на первый этап.
        for (const l of db.prepare('SELECT id, stage FROM leads').all()) {
          if (keys.has(l.stage)) continue;
          db.prepare('UPDATE leads SET stage = ? WHERE id = ?').run('new', l.id);
          event(l.id, 'stage', `Этап «${cur.stages.find((x) => x.key === l.stage)?.name || l.stage}» убран из воронки → ${stages[0].name}`, who(user));
        }
        store.setSetting('crm_funnel', JSON.stringify(next));
      });
      return crm.funnel();
    },

    // Сделки без ответственного — раздать по очереди тем, кто на смене (при открытии смены и по кнопке).
    // Поровну между теми, кто на смене: свободные сделки раздаются, а необработанные новые обращения
    // (первый этап, сотрудник ещё не писал, не звонил, не оставлял заметок) перекладываются так,
    // чтобы у всех на смене их было одинаково. Начатые сделки остаются у своего сотрудника.
    assignFree(user = null) {
      const list = onShift();
      if (!list.length) return { assigned: 0, moved: 0 };
      const ids = new Set(list.map((u) => u.id));
      const nameOf = (id) => { const u = list.find((x) => x.id === id); return u ? u.name || u.email : userName(id) || 'никто'; };
      const fresh = db.prepare("SELECT id, user_id, stage FROM leads WHERE closed_at IS NULL AND (user_id IS NULL OR stage = 'new') ORDER BY created_at, id").all();
      const pool = fresh.filter((l) => l.user_id === null || untouched(l.id));
      const poolIds = new Set(pool.map((l) => l.id));
      // Нагрузка без тех, кого перераспределяем: только начатые новые обращения.
      const load = new Map(list.map((u) => [u.id, 0]));
      for (const l of fresh) if (!poolIds.has(l.id) && l.stage === 'new' && load.has(l.user_id)) load.set(l.user_id, load.get(l.user_id) + 1);
      let assigned = 0, moved = 0;
      for (const l of pool) {
        // Меньше всего новых обращений; при равенстве — прежний ответственный (чтобы зря не перекладывать), затем по порядку.
        let best = null;
        for (const u of list) {
          const n = load.get(u.id), bn = best === null ? Infinity : load.get(best);
          if (n < bn || (n === bn && u.id === l.user_id)) best = u.id;
        }
        if (l.stage === 'new') load.set(best, load.get(best) + 1);
        if (best === l.user_id) continue;
        db.prepare('UPDATE leads SET user_id = ?, updated_at = ? WHERE id = ?').run(best, Date.now(), l.id);
        event(l.id, 'system', l.user_id ? `Передана поровну между сменой: ${nameOf(l.user_id)} → ${nameOf(best)}` : `Ответственный по очереди (на смене): ${nameOf(best)}`, who(user));
        if (l.user_id) moved++; else assigned++;
      }
      return { assigned, moved };
    },
    autoAssignFree() {
      return funnel().assignFree ? crm.assignFree() : { assigned: 0 };
    },

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
      const stage = stageKeys().has(input.stage) ? input.stage : 'new';
      const now = Date.now();
      // Сделка пришла сама (Instagram, WhatsApp, витрина) — отдаём по очереди тому, кто на смене.
      let auto = null;
      if (!user && !f.user_id && !CLOSED.has(stage) && funnel().autoAssign) {
        auto = nextAssignee();
        if (auto) f.user_id = auto.id;
      }
      // Клиент с таким телефоном уже есть в программе лояльности — связываем.
      const customer = f.phone ? db.prepare('SELECT id FROM customers WHERE phone = ?').get(f.phone) : null;
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO leads (title, name, phone, instagram, ig_user_id, source, stage, amount, user_id, customer_id, order_id, unread, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.title, f.name, f.phone, f.instagram, input.ig_user_id || null, f.source, stage, f.amount, f.user_id ?? user?.id ?? null,
          customer?.id ?? null, input.order_id || null, input.unread ? 1 : 0, now, now, CLOSED.has(stage) ? now : null);
      if (!quiet) event(lastInsertRowid, 'system', `Сделка создана${user ? '' : ` (${f.source})`}`, who(user));
      if (auto) event(lastInsertRowid, 'system', `Ответственный по очереди (на смене): ${auto.name || auto.email}`);
      return crm.get(lastInsertRowid);
    },

    update(id, input, user) {
      const cur = getLead(id);
      const f = fields(input, cur);
      const stage = input.stage !== undefined ? (stageKeys().has(input.stage) ? input.stage : cur.stage) : cur.stage;
      if (stage === 'lost' && cur.stage !== 'lost' && !f.lost_reason) throw new UserError('Укажите причину отказа — так видно, почему теряем клиентов');
      return transaction(db, () => {
        db.prepare(`UPDATE leads SET title = ?, name = ?, phone = ?, instagram = ?, source = ?, amount = ?, user_id = ?, lost_reason = ?, stage = ?,
          closed_at = ?, updated_at = ? WHERE id = ?`)
          .run(f.title, f.name, f.phone, f.instagram, f.source, f.amount, f.user_id, f.lost_reason, stage,
            CLOSED.has(stage) ? cur.closed_at || Date.now() : null, Date.now(), cur.id);
        const name = stageNames();
        if (stage !== cur.stage) event(cur.id, 'stage', `${name[cur.stage] || cur.stage} → ${name[stage]}${stage === 'lost' && f.lost_reason ? `: ${f.lost_reason}` : ''}`, who(user));
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
      // «Удалить сохранённый маркер»: Instagram остаётся настроенным, но без маркера (подключить заново — кнопкой).
      if (input.clearToken) Object.assign(next, { accessToken: '', tokenExpires: null, tokenLong: false, pageId: '', pageName: '', pageToken: '' });
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
      // ID аккаунта магазина в том виде, в каком его знает Meta (entry.id), — запоминаем: по нему можно писать
      // с маркером единого входа, если ID из панели приложения не подошёл.
      const ids = new Set(JSON.parse(store.setting('instagram_hook_ids', '[]')));
      for (const entry of payload?.entry || []) if (entry?.id) ids.add(String(entry.id));
      store.setSetting('instagram_hook_ids', JSON.stringify([...ids].slice(-10)));
      for (const entry of payload?.entry || []) {
        for (const m of entry.messaging || []) {
          const senderId = String(m.sender?.id || '');
          // Эхо — наши же ответы; сообщения от самого аккаунта не считаем входящими.
          if (!senderId || m.message?.is_echo || senderId === String(entry.id)) continue;
          // Пересланный рилс/публикация — ссылка и подпись видны в переписке, кассир откроет и впишет артикулы.
          const shared = (m.message?.attachments || []).map((a) => a.payload || {}).filter((p) => p.url && /instagram\.com|reel|\/p\//i.test(p.url) || p.title)
            .map((p) => `🔗 Переслал публикацию${p.title ? `: «${String(p.title).slice(0, 300)}»` : ''}${p.url && /instagram\.com/i.test(p.url) ? `\n${p.url}` : ''}`);
          // Ответ на сторис магазина и отметка магазина в сторис клиента — чтобы кассир понимал, о чём речь.
          const story = m.message?.reply_to?.story ? '↩️ Ответ на вашу сторис' : '';
          const mention = (m.message?.attachments || []).some((a) => a.type === 'story_mention') ? '📣 Отметил магазин в своей сторис (откройте в Instagram)' : '';
          const body = [story && m.message?.text ? `${story}: ${m.message.text}` : story || m.message?.text, mention, ...shared].filter(Boolean).join('\n')
            || (m.message?.attachments?.length ? `📎 ${{ image: 'Фото', video: 'Видео', audio: 'Голосовое', ig_reel: 'Рилс', reel: 'Рилс', share: 'Публикация', ig_post: 'Публикация', file: 'Файл' }[m.message.attachments[0].type] || 'Вложение'}` : '');
          const files = (m.message?.attachments || []).map((a) => ({ type: a.type, url: a.payload?.url }));
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
          event(lead.id, 'in', body, lead.name || 'Instagram', mid, files);
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
        path = path.replace(/^\/me\/messages/, `/${self}/messages`).replace(/^\/me\/media/, `/${s.igId || self}/media`).replace(/^\/me(?=\?|$)/, `/${s.igId}`);
      }
      const base = mode === 'instagram' ? INSTAGRAM_API : fbBase();
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
      // Два сообщения подряд (вложение + «здравствуйте») приходят почти одновременно — приветствие одно.
      const busy = greeting.get(l.ig_user_id);
      if (busy && Date.now() - busy < 60_000) return null;
      greeting.set(l.ig_user_id, Date.now());
      if (greeting.size > 1000) greeting.delete(greeting.keys().next().value);
      try { await crm.replyInstagram(l.id, s.autoText, null, 'Автоответ'); } catch (err) { greeting.delete(l.ig_user_id); throw err; }
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
        const r = await fetch(`${fbBase()}/oauth/access_token?${new URLSearchParams({ client_id: s.appId, client_secret: s.appSecret, redirect_uri: redirectUri, code: clean })}`, { signal: AbortSignal.timeout(15_000) });
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
        const r = await fetch(`${fbBase()}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) });
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
        const sub = await fetch(`${fbBase()}/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions&access_token=${encodeURIComponent(page.access_token)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) })
          .then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
        if (sub.error) note = `страница не подписана на сообщения: ${sub.error.message}`;
      } else {
        s = { ...s, pageId: '', pageName: '', pageToken: '' };
        // ID аккаунта Instagram, к которому маркер реально даёт доступ, — по ответу Meta о маркере.
        store.setSetting('instagram', JSON.stringify(s));
        const dbg = await crm.debugFacebookToken().catch(() => null);
        if (dbg?.igIds?.length && !dbg.igIds.includes(s.igId)) s = { ...s, igId: dbg.igIds[0] };
        if (!s.igId) {
          const a = await get('/me/assigned_instagram_accounts?fields=id,username', s.accessToken).catch(() => ({}));
          if (a.data?.[0]) s = { ...s, igId: a.data[0].id, igUsername: a.data[0].username || '' };
        }
      }
      store.setSetting('instagram', JSON.stringify({ ...s, resolveNote: note }));
      return { mode: crm.instagramMode(s), page: page ? page.name : null, note };
    },
    // Что за маркер EAA: спрашиваем у Meta (debug_token, ключ приложения «ID|секрет»). Возвращает тип, разрешения и
    // ID аккаунтов Instagram, к которым маркер даёт доступ (granular_scopes → target_ids).
    async debugFacebookToken() {
      const s = crm.instagramSettings();
      if (!/^EAA/.test(s.accessToken || '')) return null;
      if (!s.appId || !s.appSecret) throw new UserError('Для проверки маркера укажите ID и секрет приложения');
      const r = await fetch(`${fbBase()}/debug_token?${new URLSearchParams({ input_token: s.accessToken, access_token: `${s.appId}|${s.appSecret}` })}`, { signal: AbortSignal.timeout(15_000) });
      const d = (await r.json().catch(() => ({}))).data || {};
      if (d.error) throw new UserError(`Meta: ${d.error.message}`);
      const ig = new Set();
      for (const g of d.granular_scopes || []) if (/^instagram_/.test(g.scope)) for (const t of g.target_ids || []) ig.add(String(t));
      return { valid: d.is_valid !== false, type: d.type || '', app: d.application || '', expires: d.expires_at ? d.expires_at * 1000 : 0,
        scopes: d.scopes || [], igIds: [...ig] };
    },
    // «Диагностика»: все проверочные запросы к Meta с текущим маркером — ответы по пунктам. Если аккаунт Instagram
    // открывается по какому-то адресу (версия API или graph.instagram.com) — программа переключается на него.
    async diagnoseInstagram() {
      const s = crm.instagramSettings();
      if (!s.accessToken) throw new UserError('Маркер не сохранён — нажмите «Подключить Instagram»');
      const out = [];
      const call = async (title, url, token = s.accessToken, method = 'GET') => {
        try {
          const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { method, signal: AbortSignal.timeout(15_000) });
          const d = await r.json().catch(() => ({}));
          const ok = r.ok && !d.error;
          out.push({ title, ok, detail: ok ? JSON.stringify(d).slice(0, 400) : `${d.error?.code || r.status}/${d.error?.error_subcode || ''} ${d.error?.message || ''}`.slice(0, 300) });
          return ok ? d : null;
        } catch (err) {
          out.push({ title, ok: false, detail: `нет связи: ${err.message}` });
          return null;
        }
      };
      const root = 'https://graph.facebook.com';
      const fbRoot = (process.env.FACEBOOK_API_URL || '').replace(/\/v\d+\.\d+$/, '') || root;
      const igRoot = (process.env.INSTAGRAM_API_URL || '').replace(/\/v\d+\.\d+$/, '') || 'https://graph.instagram.com';
      out.push({ title: 'Маркер', ok: true, detail: `${s.accessToken.slice(0, 6)}… (${s.accessToken.length} символов), режим: ${crm.instagramMode(s)}, ID аккаунта: ${s.igId || '—'}` });
      if (s.appId && s.appSecret) await call('Сведения о маркере (debug_token)', `${fbRoot}/v26.0/debug_token?input_token=${encodeURIComponent(s.accessToken)}`, `${s.appId}|${s.appSecret}`);
      await call('Кто владелец маркера (/me)', `${fbRoot}/v26.0/me?fields=id,name`);
      await call('Страницы (/me/accounts)', `${fbRoot}/v26.0/me/accounts?fields=id,name,instagram_business_account{id,username}`);
      await call('Аккаунты Instagram системного пользователя', `${fbRoot}/v26.0/me/assigned_instagram_accounts?fields=id,username`);
      let found = null;
      if (s.igId) {
        for (const v of ['v26.0', 'v25.0', 'v24.0', 'v23.0', 'v22.0']) {
          const d = await call(`Аккаунт ${s.igId} через graph.facebook.com/${v}`, `${fbRoot}/${v}/${s.igId}?fields=id,username`);
          if (d && !found) found = `${fbRoot}/${v}`;
        }
        await call(`Переписки аккаунта (${s.igId}/conversations)`, `${fbRoot}/v26.0/${s.igId}/conversations?platform=instagram&limit=1`);
        const gi = await call(`Аккаунт через graph.instagram.com (маркер EAA)`, `${igRoot}/v26.0/me?fields=user_id,username`);
        if (gi) out.push({ title: 'Подсказка', ok: true, detail: 'маркер работает с graph.instagram.com — сообщите об этом, переключу программу' });
      }
      if (found && found !== fbBase()) {
        store.setSetting('instagram', JSON.stringify({ ...crm.instagramSettings(), fbBase: found }));
        out.push({ title: 'Переключено', ok: true, detail: `программа теперь работает через ${found}` });
      }
      return { items: out, works: Boolean(found) };
    },
    // Подписка на сообщения Direct. Комментарии приходят, а сообщения нет — значит, Meta не шлёт поле «messages»:
    // (1) в приложении (Webhooks → Instagram) не отмечено «messages»; (2) аккаунт/страница не подписаны на приложение.
    // Проверяем оба места и подписываем то, чего не хватает. Возвращает шаги для экрана настроек.
    async subscribeInstagramMessages(host = '') {
      const s = crm.instagramSettings();
      if (!s.accessToken) throw new UserError('Маркер не сохранён — нажмите «Подключить Instagram»');
      const steps = [];
      const req = async (method, url, token) => {
        try {
          const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { method, signal: AbortSignal.timeout(20_000) });
          const d = await r.json().catch(() => ({}));
          return r.ok && !d.error ? { ok: true, d } : { ok: false, err: d.error?.message || `ошибка ${r.status}` };
        } catch (err) { return { ok: false, err: `нет связи: ${err.message}` }; }
      };
      const root = fbBase();
      const want = ['messages', 'comments', 'messaging_postbacks'];
      // 1. Приложение: на какие поля объекта «instagram» оно подписано.
      if (s.appId && s.appSecret) {
        const app = `${s.appId}|${s.appSecret}`;
        const cur = await req('GET', `${root}/${s.appId}/subscriptions`, app);
        const sub = cur.ok ? (cur.d.data || []).find((x) => x.object === 'instagram') : null;
        const has = new Set((sub?.fields || []).map((f) => f.name || f));
        if (!cur.ok) steps.push({ title: 'Вебхуки приложения', ok: false, detail: cur.err });
        else if (want.slice(0, 2).every((f) => has.has(f))) steps.push({ title: 'Вебхуки приложения', ok: true, detail: `подписано: ${[...has].join(', ')}` });
        else {
          const callback = sub?.callback_url || (host ? `https://${host}/webhooks/instagram` : '');
          if (!callback || !s.verifyToken) steps.push({ title: 'Вебхуки приложения', ok: false, detail: `не отмечено «messages» (сейчас: ${[...has].join(', ') || 'ничего'}). Отметьте в developers.facebook.com → приложение → Webhooks → Instagram → messages` });
          else {
            const fields = [...new Set([...has, ...want])].join(',');
            const r = await req('POST', `${root}/${s.appId}/subscriptions?${new URLSearchParams({ object: 'instagram', callback_url: callback, fields, verify_token: s.verifyToken, include_values: 'true' })}`, app);
            steps.push({ title: 'Вебхуки приложения: добавил «messages»', ok: r.ok, detail: r.ok ? `теперь: ${fields}` : `${r.err}. Отметьте вручную: Webhooks → Instagram → messages` });
          }
        }
      } else steps.push({ title: 'Вебхуки приложения', ok: false, detail: 'не указаны ID и секрет приложения — проверить нельзя' });
      // 2. Аккаунт: подписан ли он на приложение (без этого Meta не шлёт сообщения Direct).
      const mode = crm.instagramMode(s);
      if (mode === 'instagram') {
        const r = await req('POST', `${INSTAGRAM_GRAPH}/v21.0/me/subscribed_apps?subscribed_fields=${want.join(',')}`, s.accessToken);
        steps.push({ title: 'Аккаунт Instagram подписан на приложение', ok: r.ok, detail: r.ok ? want.join(', ') : r.err });
      } else if (mode === 'page') {
        const r = await req('POST', `${root}/${s.pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions,feed`, s.pageToken);
        const g = await req('GET', `${root}/${s.pageId}/subscribed_apps`, s.pageToken);
        steps.push({ title: `Страница «${s.pageName}» подписана на приложение`, ok: r.ok, detail: r.ok ? JSON.stringify(g.d?.data || []).slice(0, 300) : r.err });
      } else {
        // Единый вход без страницы: пробуем найти страницу заново (маркеру могли дать доступ).
        const r = await crm.resolveFacebookToken().catch((e) => ({ note: e.message }));
        const again = crm.instagramSettings();
        if (again.pageId) {
          const sub = await req('POST', `${root}/${again.pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions,feed`, again.pageToken);
          steps.push({ title: `Страница «${again.pageName}» подписана на приложение`, ok: sub.ok, detail: sub.ok ? 'messages' : sub.err });
        } else {
          const ig = await req('POST', `${root}/${s.igId}/subscribed_apps?subscribed_fields=messages,comments`, s.accessToken);
          steps.push({ title: 'Подписка аккаунта на сообщения', ok: ig.ok, detail: ig.ok ? 'готово' : `маркеру не видна Facebook-страница магазина (${r?.note || ig.err}). Дайте системному пользователю доступ к странице, к которой привязан Instagram, и нажмите ещё раз` });
        }
      }
      // Meta отказал из-за разрешений — понятной строкой, каких не хватает маркеру.
      for (const st of steps) {
        if (st.ok) continue;
        const need = [...new Set(String(st.detail).match(/pages_[a-z_]+|instagram_[a-z_]+/g) || [])];
        if (need.length) st.detail = `Маркеру не хватает разрешений: ${need.join(', ')}. Выпустите маркер системного пользователя заново (business.facebook.com → Пользователи → Системные пользователи → «Создать маркер»), отметьте эти разрешения, проверьте, что страница «${s.pageName || 'магазина'}» добавлена ему в ресурсы с полным доступом, и вставьте новый маркер в поле «Маркер доступа». Ответ Meta: ${st.detail}`;
      }
      store.setSetting('instagram_sub_check', JSON.stringify({ at: Date.now(), ok: steps.every((x) => x.ok) }));
      return { steps, ok: steps.every((x) => x.ok) };
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
      let s = crm.instagramSettings();
      // Единый вход: подбираем ID аккаунта Instagram, который открывается этим маркером: из ответа Meta о маркере,
      // из вебхуков (entry.id), из аккаунтов системного пользователя, затем вписанный. Сохраняем первый рабочий.
      if (crm.instagramMode(s) === 'unified') {
        const cand = [];
        const d = s.appId && s.appSecret ? await crm.debugFacebookToken().catch(() => null) : null;
        cand.push(...(d?.igIds || []));
        cand.push(...JSON.parse(store.setting('instagram_hook_ids', '[]')));
        for (const path of ['/me/assigned_instagram_accounts?fields=id,username', '/me/instagram_accounts?fields=id,username']) {
          const r = await fetch(`${fbBase()}${path}&access_token=${encodeURIComponent(s.accessToken)}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => ({}));
          cand.push(...(r.data || []).map((a) => String(a.id)));
        }
        if (s.igId) cand.push(s.igId);
        const tried = [];
        for (const id of [...new Set(cand)]) {
          const r = await fetch(`${fbBase()}/${id}?fields=id,username&access_token=${encodeURIComponent(s.accessToken)}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => ({}));
          tried.push(id);
          if (r.id && !r.error) {
            if (id !== s.igId) store.setSetting('instagram', JSON.stringify({ ...crm.instagramSettings(), igId: id, igUsername: r.username || '' }));
            return { username: r.username || '', name: r.name || '', id, mode: 'unified', page: '' };
          }
        }
        store.setSetting('instagram_tried_ids', JSON.stringify(tried));
        s = crm.instagramSettings();
      }
      if (!s.accessToken) throw new UserError('Маркер доступа не указан — нажмите «Подключить Instagram» или вставьте маркер');
      let data;
      try {
        data = await crm.igCall('GET', crm.instagramMode(s) === 'instagram' ? '/me?fields=user_id,username,name' : '/me?fields=id,username');
      } catch (err) {
        // Расшифровка для владельца: что за маркер и к каким аккаунтам у него есть доступ.
        let why = '';
        if (crm.instagramMode(s) !== 'instagram') {
          const d = await crm.debugFacebookToken().catch((e) => ({ error: e.message }));
          if (d?.error) why = ` Проверка маркера: ${d.error}`;
          else if (d) {
            const kind = d.type === 'SYSTEM_USER' ? 'системный (из кнопки «Подключить Instagram»)' : d.type === 'USER' ? 'пользовательский (например, из Graph API Explorer)' : d.type || 'неизвестный';
            why = ` Маркер: ${kind}${d.valid ? '' : ', НЕДЕЙСТВИТЕЛЕН'}; разрешения: ${d.scopes.join(', ') || 'нет'}; доступ к аккаунтам Instagram: ${d.igIds.join(', ') || 'нет'}.`
              + ` Проверены ID: ${JSON.parse(store.setting('instagram_tried_ids', '[]')).join(', ') || '—'}.`
              + (d.igIds.length ? '' : ' Meta не привязала аккаунт Instagram к маркеру: напишите в Direct магазина с другого аккаунта (программа узнает ID из сообщения) и нажмите «Проверить подключение» ещё раз; если не поможет — в Meta Business Suite → Настройки → Пользователи → Системные пользователи дайте пользователю приложения MONT CRM доступ к аккаунту Instagram.');
          }
        }
        throw new UserError(`Instagram не принял маркер: ${err.message}${why}`);
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
