'use strict';

// MONT AI Studio: съёмки товаров, исходные фото, локальная обработка, задания для ChatGPT (вручную, без API),
// результаты генерации, согласование и добавление в галерею товара.
//
// Хранится в отдельной базе studio.db рядом с shop.db: исходники и черновики много весят, основная база
// не раздувается. Товары здесь не копируются — только ссылки «магазин + номер товара».

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { imageMime, transaction } = require('./db');
const prompts = require('./studio-prompts');

const ASSET_MAX = 8e6; // байт на один файл студии
const KINDS = ['source', 'edit', 'result'];
// Что проверяет человек перед одобрением результата из ChatGPT.
const CHECKLIST = {
  color: 'Цвет и оттенок совпадают',
  fabric: 'Фактура ткани та же',
  cut: 'Крой и посадка те же',
  length: 'Длина изделия и рукавов та же',
  pockets: 'Карманы: количество и расположение',
  fasteners: 'Пуговицы, молнии, швы',
  prints: 'Принты, надписи, логотипы без изменений',
  nothingNew: 'Ничего лишнего не добавлено',
};

// Размеры картинки из заголовка файла (без декодирования).
function dimensions(b, mime) {
  try {
    if (mime === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const type = b.subarray(12, 16).toString('latin1');
      if (type === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (type === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
      if (type === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* неизвестно */ }
  return null;
}

function createStudio(file, { UserError }) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_sessions (
      id INTEGER PRIMARY KEY,
      branch_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_sessions_branch ON studio_sessions (branch_id, updated_at);
    CREATE TABLE IF NOT EXISTS studio_tasks (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES studio_sessions(id),
      operation TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      prompt TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'prepared',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_assets (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES studio_sessions(id),
      kind TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      parent_id INTEGER,
      task_id INTEGER,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      checklist TEXT NOT NULL DEFAULT '{}',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at INTEGER,
      attached_branch_id INTEGER,
      attached_product_id INTEGER,
      attached_image_id INTEGER,
      attached_by TEXT NOT NULL DEFAULT '',
      attached_at INTEGER,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_assets_session ON studio_assets (session_id, kind, id);
    CREATE TABLE IF NOT EXISTS studio_log (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      user TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS studio_log_session ON studio_log (session_id, at);
  `);

  // Цепочка попыток (повторная генерация после отклонения): колонки добавляются к уже созданной базе.
  const taskCols = new Set(db.prepare('PRAGMA table_info(studio_tasks)').all().map((c) => c.name));
  for (const [name, type] of [['root_id', 'INTEGER'], ['parent_id', 'INTEGER'], ['attempt', 'INTEGER NOT NULL DEFAULT 1'], ['prev_result_id', 'INTEGER'], ['feedback', "TEXT NOT NULL DEFAULT ''"], ['keep_ok', "TEXT NOT NULL DEFAULT '[]'"], ['followup', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!taskCols.has(name)) db.exec(`ALTER TABLE studio_tasks ADD COLUMN ${name} ${type}`);
  }
  db.exec('UPDATE studio_tasks SET root_id = id WHERE root_id IS NULL');

  const who = (user) => String(user?.name || user?.email || '');
  const now = () => Date.now();
  const log = (sessionId, user, action, details = '') => db.prepare('INSERT INTO studio_log (session_id, at, user, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, now(), who(user), action, String(details).slice(0, 500));
  const touch = (sessionId) => db.prepare('UPDATE studio_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
  const assetMeta = (a) => ({
    id: a.id, kind: a.kind, role: a.role, parentId: a.parent_id, taskId: a.task_id, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes,
    sha256: a.sha256, meta: JSON.parse(a.meta || '{}'), status: a.status, checklist: JSON.parse(a.checklist || '{}'), reviewNote: a.review_note,
    reviewedBy: a.reviewed_by, reviewedAt: a.reviewed_at, attached: a.attached_image_id ? { branchId: a.attached_branch_id, productId: a.attached_product_id, imageId: a.attached_image_id, by: a.attached_by, at: a.attached_at } : null,
    createdBy: a.created_by, createdAt: a.created_at,
  });
  // История замечаний цепочки: все отклонённые результаты попыток до этой включительно.
  const chainNotes = (t) => db.prepare(`SELECT t.attempt, a.id AS result_id, a.review_note AS note, a.reviewed_by, a.reviewed_at FROM studio_tasks t
      JOIN studio_assets a ON a.task_id = t.id AND a.kind = 'result' AND a.status = 'rejected' AND a.review_note <> ''
      WHERE t.root_id = ? AND t.attempt < ? ORDER BY t.attempt, a.id`).all(t.root_id ?? t.id, t.attempt ?? 1).map((r) => ({ ...r }));
  const taskOut = (t) => ({ id: t.id, operation: t.operation, operationName: prompts.OPERATIONS[t.operation], params: JSON.parse(t.params), prompt: t.prompt, sourceIds: JSON.parse(t.source_ids), status: t.status, createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at,
    rootId: t.root_id ?? t.id, parentId: t.parent_id, attempt: t.attempt ?? 1, prevResultId: t.prev_result_id, feedback: t.feedback || '', followup: t.followup || '', keepOk: JSON.parse(t.keep_ok || '[]'),
    notes: (t.attempt ?? 1) > 1 ? chainNotes(t) : [] });

  function session(id, branchId) {
    const s = db.prepare('SELECT * FROM studio_sessions WHERE id = ?').get(Number(id));
    if (!s) throw new UserError('Съёмка не найдена');
    if (branchId !== undefined && s.branch_id !== branchId) throw new UserError('Эта съёмка в другом магазине — переключитесь на него');
    return s;
  }
  function asset(id) {
    const a = db.prepare('SELECT id, session_id, kind, role, parent_id, task_id, mime, width, height, bytes, sha256, meta, status, checklist, review_note, reviewed_by, reviewed_at, attached_branch_id, attached_product_id, attached_image_id, attached_by, attached_at, created_by, created_at FROM studio_assets WHERE id = ?').get(Number(id));
    if (!a) throw new UserError('Файл не найден');
    return a;
  }

  return {
    db,
    CHECKLIST,

    listSessions(branchId, { status = 'open' } = {}) {
      const rows = db.prepare(`SELECT s.*,
          (SELECT COUNT(*) FROM studio_assets a WHERE a.session_id = s.id AND a.kind = 'source') AS sources,
          (SELECT COUNT(*) FROM studio_assets a WHERE a.session_id = s.id AND a.kind = 'result' AND a.status = 'pending') AS pending,
          (SELECT COUNT(*) FROM studio_assets a WHERE a.session_id = s.id AND a.attached_image_id IS NOT NULL) AS attached,
          (SELECT id FROM studio_assets a WHERE a.session_id = s.id AND a.kind = 'source' ORDER BY id LIMIT 1) AS cover_id
        FROM studio_sessions s WHERE s.branch_id = ? ${status === 'all' ? '' : "AND s.status = 'open'"} ORDER BY s.updated_at DESC LIMIT 300`).all(branchId);
      return rows.map((r) => ({ ...r }));
    },

    createSession({ branchId, product, variant, title }, user) {
      const t = now();
      const { lastInsertRowid } = db.prepare('INSERT INTO studio_sessions (branch_id, product_id, variant_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(branchId, product.id, variant?.id ?? null, String(title || '').trim().slice(0, 120), who(user), t, t);
      const id = Number(lastInsertRowid);
      log(id, user, 'Создана съёмка', `${product.name}${variant ? ` · ${variant.label}` : ''}`);
      return this.getSession(id, branchId);
    },

    getSession(id, branchId) {
      const s = session(id, branchId);
      const assets = db.prepare("SELECT id, session_id, kind, role, parent_id, task_id, mime, width, height, bytes, sha256, meta, status, checklist, review_note, reviewed_by, reviewed_at, attached_branch_id, attached_product_id, attached_image_id, attached_by, attached_at, created_by, created_at FROM studio_assets WHERE session_id = ? ORDER BY id").all(s.id);
      const tasks = db.prepare('SELECT * FROM studio_tasks WHERE session_id = ? ORDER BY id DESC').all(s.id);
      const history = db.prepare('SELECT at, user, action, details FROM studio_log WHERE session_id = ? ORDER BY id DESC LIMIT 200').all(s.id);
      return { ...s, assets: assets.map(assetMeta), tasks: tasks.map(taskOut), history: history.map((h) => ({ ...h })), checklist: CHECKLIST };
    },

    updateSession(id, branchId, patch, user, { variant } = {}) {
      const s = session(id, branchId);
      const next = {
        title: patch.title === undefined ? s.title : String(patch.title).trim().slice(0, 120),
        note: patch.note === undefined ? s.note : String(patch.note).slice(0, 1000),
        status: patch.status === undefined ? s.status : patch.status === 'archived' ? 'archived' : 'open',
        variant_id: patch.variantId === undefined ? s.variant_id : variant ? variant.id : null,
      };
      db.prepare('UPDATE studio_sessions SET title = ?, note = ?, status = ?, variant_id = ?, updated_at = ? WHERE id = ?').run(next.title, next.note, next.status, next.variant_id, now(), s.id);
      if (patch.status !== undefined && patch.status !== s.status) log(s.id, user, next.status === 'archived' ? 'Съёмка в архиве' : 'Съёмка снова открыта');
      if (patch.variantId !== undefined && next.variant_id !== s.variant_id) log(s.id, user, 'Выбрана модификация', variant ? variant.label : 'весь товар');
      return this.getSession(s.id, branchId);
    },

    // Новый файл: исходник, локальная обработка (edit) или результат из ChatGPT (result). Файлы не перезаписываются.
    addAsset(sessionId, branchId, { kind, role, parentId, taskId, data, meta }, user) {
      const s = session(sessionId, branchId);
      if (!KINDS.includes(kind)) throw new UserError('Неизвестный вид файла');
      const bytes = Buffer.from(String(data || ''), 'base64');
      if (!bytes.length) throw new UserError('Файл пустой');
      if (bytes.length > ASSET_MAX) throw new UserError(`Файл больше ${ASSET_MAX / 1e6} МБ — уменьшите фото`);
      const mime = imageMime(bytes);
      if (!mime) throw new UserError('Файл повреждён или это не картинка — подходят только JPEG, PNG и WebP (до 10000 px по стороне)');
      const own = (aid) => {
        if (aid === undefined || aid === null || aid === '') return null;
        const a = db.prepare('SELECT id, kind FROM studio_assets WHERE id = ? AND session_id = ?').get(Number(aid), s.id);
        if (!a) throw new UserError('Исходное фото не из этой съёмки');
        return a;
      };
      const parent = own(parentId);
      let task = null;
      if (taskId !== undefined && taskId !== null && taskId !== '') {
        task = db.prepare('SELECT * FROM studio_tasks WHERE id = ? AND session_id = ?').get(Number(taskId), s.id);
        if (!task) throw new UserError('Задание не из этой съёмки');
      }
      if (kind === 'edit' && !parent) throw new UserError('Для обработки нужно исходное фото');
      if (kind === 'result' && !task) throw new UserError('Результат загружается в конкретное задание');
      const dim = dimensions(bytes, mime) || {};
      const status = kind === 'source' ? 'new' : 'pending';
      const safeRole = prompts.ROLES[role] ? role : kind === 'source' ? 'other' : '';
      const { lastInsertRowid } = db.prepare(`INSERT INTO studio_assets (session_id, kind, role, parent_id, task_id, mime, width, height, bytes, sha256, data, meta, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.id, kind, safeRole, parent?.id ?? null, task?.id ?? null, mime, dim.width ?? null, dim.height ?? null, bytes.length,
          crypto.createHash('sha256').update(bytes).digest('hex'), bytes, JSON.stringify(meta && typeof meta === 'object' ? meta : {}).slice(0, 4000), status, who(user), now());
      const id = Number(lastInsertRowid);
      if (task && task.status !== 'cancelled') db.prepare("UPDATE studio_tasks SET status = 'result', updated_at = ? WHERE id = ?").run(now(), task.id);
      touch(s.id);
      const label = { source: `Загружено исходное фото (${prompts.ROLES[safeRole] || 'фото'})`, edit: `Сохранена локальная обработка фото №${parent?.id}`, result: `Загружен результат из ChatGPT к заданию №${task?.id}` }[kind];
      log(s.id, user, label, `файл №${id}, ${dim.width || '?'}×${dim.height || '?'}, ${(bytes.length / 1024).toFixed(0)} КБ`);
      return assetMeta(asset(id));
    },

    // Файл для показа и скачивания (только для своей съёмки текущего магазина).
    assetFile(id, branchId) {
      const a = db.prepare('SELECT s.branch_id, a.mime, a.data FROM studio_assets a JOIN studio_sessions s ON s.id = a.session_id WHERE a.id = ?').get(Number(id));
      if (!a || a.branch_id !== branchId) return null;
      return { mime: a.mime, data: a.data };
    },

    setRole(id, branchId, role, user) {
      const a = asset(id);
      session(a.session_id, branchId);
      if (a.kind !== 'source') throw new UserError('Роль задаётся только исходному фото');
      if (!prompts.ROLES[role]) throw new UserError('Неизвестная роль фото');
      db.prepare('UPDATE studio_assets SET role = ? WHERE id = ?').run(role, a.id);
      log(a.session_id, user, `Фото №${a.id}: ${prompts.ROLES[role]}`);
      return assetMeta(asset(a.id));
    },

    // Удалить можно то, что не добавлено в каталог и не нужно другим файлам и заданиям.
    deleteAsset(id, branchId, user) {
      const a = asset(id);
      session(a.session_id, branchId);
      if (a.attached_image_id) throw new UserError('Это фото уже добавлено в галерею товара — удалить его можно только там, в окне «Фото товара»');
      if (db.prepare('SELECT 1 FROM studio_assets WHERE parent_id = ?').get(a.id)) throw new UserError('Из этого фото уже сделана обработка — сначала удалите её');
      if (a.kind === 'source' && db.prepare('SELECT source_ids FROM studio_tasks WHERE session_id = ? AND status <> ?').all(a.session_id, 'cancelled').some((t) => JSON.parse(t.source_ids).includes(a.id))) {
        throw new UserError('Это фото используется в задании — сначала отмените задание');
      }
      db.prepare('DELETE FROM studio_assets WHERE id = ?').run(a.id);
      touch(a.session_id);
      log(a.session_id, user, `Удалён файл №${a.id}`, { source: 'исходное фото', edit: 'обработка', result: 'результат' }[a.kind]);
      return { ok: true };
    },

    // Задание для ChatGPT: текст собирается здесь, из данных товара и выбранных фото.
    createTask(sessionId, branchId, { operation, params, sourceIds }, product, user) {
      const s = session(sessionId, branchId);
      if (!prompts.OPERATIONS[operation]) throw new UserError('Выберите операцию');
      const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).map(Number))];
      if (!ids.length) throw new UserError('Отметьте хотя бы одно фото для задания');
      if (ids.length > 10) throw new UserError('Не больше 10 фото в одном задании');
      const sources = ids.map((aid) => {
        const a = db.prepare("SELECT id, kind, role FROM studio_assets WHERE id = ? AND session_id = ? AND kind IN ('source', 'edit')").get(aid, s.id);
        if (!a) throw new UserError('Фото для задания — только исходные и обработанные фото этой съёмки');
        const role = a.kind === 'edit' ? db.prepare('SELECT role FROM studio_assets WHERE id = (SELECT parent_id FROM studio_assets WHERE id = ?)').get(a.id)?.role || 'other' : a.role;
        return { id: a.id, role };
      });
      const { prompt, params: norm } = prompts.buildPrompt(operation, params || {}, product, sources);
      const t = now();
      const { lastInsertRowid } = db.prepare('INSERT INTO studio_tasks (session_id, operation, params, prompt, source_ids, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, operation, JSON.stringify(norm), prompt, JSON.stringify(sources.map((x) => x.id)), 'prepared', who(user), t, t);
      db.prepare('UPDATE studio_tasks SET root_id = id WHERE id = ?').run(Number(lastInsertRowid));
      touch(s.id);
      log(s.id, user, `Подготовлено задание №${lastInsertRowid}: ${prompts.OPERATIONS[operation]}`, `фото: ${sources.map((x) => `№${x.id}`).join(', ')}`);
      return taskOut(db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(Number(lastInsertRowid)));
    },

    updateTask(id, branchId, patch, user) {
      const t = db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(Number(id));
      if (!t) throw new UserError('Задание не найдено');
      session(t.session_id, branchId);
      const prompt = patch.prompt === undefined ? t.prompt : String(patch.prompt).slice(0, 8000);
      if (!prompt.trim()) throw new UserError('Текст задания пустой');
      let status = t.status;
      if (patch.status === 'sent' && t.status === 'prepared') status = 'sent';
      if (patch.status === 'cancelled') status = 'cancelled';
      if (patch.status === 'reopen' && t.status === 'cancelled') status = 'prepared';
      db.prepare('UPDATE studio_tasks SET prompt = ?, status = ?, updated_at = ? WHERE id = ?').run(prompt, status, now(), t.id);
      touch(t.session_id);
      if (prompt !== t.prompt) log(t.session_id, user, `Задание №${t.id}: текст изменён вручную`);
      if (status !== t.status) log(t.session_id, user, `Задание №${t.id}: ${{ sent: 'отправлено в ChatGPT', cancelled: 'отменено', prepared: 'снова открыто' }[status] || status}`);
      if (patch.event && ['copied', 'shared', 'downloaded', 'opened'].includes(patch.event)) {
        log(t.session_id, user, `Задание №${t.id}: ${{ copied: 'промпт скопирован', shared: 'отправлено через «Поделиться»', downloaded: 'фото скачаны для ChatGPT', opened: 'открыт ChatGPT' }[patch.event]}`);
      }
      return taskOut(db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(t.id));
    },

    // Согласование. Результат из ChatGPT одобряется только после проверки всех пунктов списка;
    // локальную обработку (кадр, поворот, фон) — одной кнопкой.
    review(id, branchId, { decision, checklist, note }, user) {
      const a = asset(id);
      session(a.session_id, branchId);
      if (a.kind === 'source') throw new UserError('Исходные фото не согласуются');
      if (a.attached_image_id) throw new UserError('Фото уже добавлено в галерею — решение не меняется');
      if (!['approved', 'rejected', 'pending'].includes(decision)) throw new UserError('Неизвестное решение');
      const marks = Object.fromEntries(Object.keys(CHECKLIST).map((k) => [k, Boolean(checklist?.[k])]));
      if (decision === 'approved' && a.kind === 'result') {
        const missing = Object.entries(marks).filter(([, v]) => !v).map(([k]) => CHECKLIST[k]);
        if (missing.length) throw new UserError(`Сначала сравните с оригиналом и отметьте: ${missing.join('; ')}`);
      }
      // Отклонение: нужен только комментарий. Пункты списка не обязательны — отмеченные попадут в новый промпт как «сохранить».
      const text = String(note ?? '').trim().slice(0, 500);
      if (decision === 'rejected' && a.kind === 'result' && !text) throw new UserError('Напишите, что не так — по этому комментарию составится новый промпт');
      let retryTask = null;
      transaction(db, () => {
        db.prepare('UPDATE studio_assets SET status = ?, checklist = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
          .run(decision, JSON.stringify(marks), text, decision === 'pending' ? '' : who(user), decision === 'pending' ? null : now(), a.id);
        touch(a.session_id);
        log(a.session_id, user, `${a.kind === 'result' ? 'Результат' : 'Обработка'} №${a.id}: ${{ approved: 'одобрено', rejected: 'отклонено', pending: 'снова на согласовании' }[decision]}`, text);
        if (decision === 'rejected' && a.kind === 'result') retryTask = this.retry(a.id, branchId, user);
      });
      return { ...assetMeta(asset(a.id)), retryTask };
    },

    // Повторная генерация: новое задание (следующая попытка) из исходного задания цепочки + все замечания + что было верно.
    // Если по этому результату попытка уже есть и не отменена — возвращается она (без дублей).
    retry(resultId, branchId, user) {
      const a = asset(resultId);
      session(a.session_id, branchId);
      if (a.kind !== 'result' || !a.task_id) throw new UserError('Повторить можно только результат из задания ChatGPT');
      if (a.status !== 'rejected') throw new UserError('Сначала отклоните результат и напишите, что не так');
      const existing = db.prepare("SELECT * FROM studio_tasks WHERE prev_result_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1").get(a.id);
      if (existing) return taskOut(existing);
      const prev = db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(a.task_id);
      const root = db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(prev.root_id ?? prev.id);
      const attempt = (prev.attempt ?? 1) + 1;
      // Замечания всей цепочки до этой попытки (включая только что отклонённый результат).
      const corrections = db.prepare(`SELECT t.attempt, a.review_note AS note FROM studio_tasks t
          JOIN studio_assets a ON a.task_id = t.id AND a.kind = 'result' AND a.status = 'rejected' AND a.review_note <> ''
          WHERE t.root_id = ? AND t.attempt < ? ORDER BY t.attempt, a.id`).all(root.id, attempt).map((r) => ({ attempt: r.attempt, note: r.note }));
      const marks = JSON.parse(a.checklist || '{}');
      const keepOk = Object.keys(CHECKLIST).filter((k) => marks[k]).map((k) => CHECKLIST[k]);
      const prompt = prompts.buildRetryPrompt({ basePrompt: root.prompt, attempt, corrections, keepOk, withPrevious: true });
      const followup = prompts.buildFollowup({ note: a.review_note, keepOk });
      const t = now();
      const { lastInsertRowid } = db.prepare(`INSERT INTO studio_tasks (session_id, operation, params, prompt, source_ids, status, created_by, created_at, updated_at,
          root_id, parent_id, attempt, prev_result_id, feedback, keep_ok, followup) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(a.session_id, root.operation, root.params, prompt, root.source_ids, who(user), t, t, root.id, prev.id, attempt, a.id, a.review_note, JSON.stringify(keepOk), followup);
      db.prepare("UPDATE studio_tasks SET status = 'retried', updated_at = ? WHERE id = ? AND status NOT IN ('done', 'cancelled')").run(t, prev.id);
      touch(a.session_id);
      log(a.session_id, user, `Повторная генерация: задание №${lastInsertRowid} (попытка ${attempt}) по замечанию к результату №${a.id}`, a.review_note);
      return taskOut(db.prepare('SELECT * FROM studio_tasks WHERE id = ?').get(Number(lastInsertRowid)));
    },

    // Проверки перед добавлением в галерею (сама запись — в базе магазина, см. server.js).
    attachable(id, branchId) {
      const a = asset(id);
      const s = session(a.session_id, branchId);
      if (a.kind === 'source') throw new UserError('Исходное фото не добавляется — добавляйте одобренную обработку или результат');
      if (a.status !== 'approved') throw new UserError('Сначала одобрите фото');
      if (a.attached_image_id) throw new UserError('Это фото уже добавлено в галерею товара');
      return { asset: assetMeta(a), session: s };
    },

    markAttached(id, { branchId, productId, imageId }, user, label) {
      const a = asset(id);
      db.prepare("UPDATE studio_assets SET status = 'attached', attached_branch_id = ?, attached_product_id = ?, attached_image_id = ?, attached_by = ?, attached_at = ? WHERE id = ?")
        .run(branchId, productId, imageId, who(user), now(), a.id);
      if (a.task_id) db.prepare("UPDATE studio_tasks SET status = 'done', updated_at = ? WHERE id = ? AND status <> 'cancelled'").run(now(), a.task_id);
      touch(a.session_id);
      log(a.session_id, user, `Фото №${a.id} добавлено в конец галереи`, label);
      return assetMeta(asset(a.id));
    },

    transaction: (fn) => transaction(db, fn),
  };
}

module.exports = { createStudio, dimensions, CHECKLIST };
