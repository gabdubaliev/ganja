'use strict';

// Аккаунты покупателей на интернет-витрине.
//
// Логин — номер телефона, пароль покупатель придумывает сам, дата рождения обязательна.
// Аккаунт — это тот же покупатель из программы лояльности: бонусы, скидка именинника
// и история покупок общие для кассы и витрины.
//
// Номер подтверждается одноразовым кодом: при «Забыл пароль» и при регистрации на номер,
// который уже есть в программе (чтобы по чужому номеру нельзя было забрать чужие бонусы).
// Код уходит в WhatsApp, если это настроено, а иначе его видит сотрудник в программе
// и сообщает покупателю звонком или сообщением.

const crypto = require('node:crypto');
const { UserError, text, phone, birthday } = require('./db');
const { hashPassword, checkPassword } = require('./auth');

const COOKIE = 'shop_customer';
const SESSION_DAYS = 90;
const CODE_TTL = 15 * 60_000;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 3;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60_000;
const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

function createShopAuth(store, { onCodeRequested } = {}) {
  const db = store.db;
  const have = new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name));
  for (const [name, def] of [['password_hash', 'TEXT'], ['registered_at', 'INTEGER'], ['last_login_at', 'INTEGER'], ['login_disabled', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!have.has(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${def}`);
  }
  if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'customer_id')) db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_codes (
      id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code TEXT,
      channel TEXT NOT NULL,
      pending TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used_at INTEGER,
      sent_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS phone_codes_phone ON phone_codes(phone, created_at);
  `);

  const secret = crypto.createHash('sha256').update('shop:' + store.setting('session_secret', crypto.randomBytes(32).toString('base64url'))).digest();
  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const failures = new Map(); // ip -> { count, since }
  const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

  const readCookie = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return '';
  };
  const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
  const findByPhone = (p) => db.prepare('SELECT * FROM customers WHERE phone = ?').get(p) || null;

  function password(value) {
    const s = String(value ?? '');
    if (s.length < 6) throw new UserError('Пароль должен быть не короче 6 символов');
    if (s.length > 100) throw new UserError('Слишком длинный пароль');
    return s;
  }

  // Покупатель для витрины: только то, что ему можно знать о себе.
  const publicCustomer = (c) => c && {
    id: c.id, phone: c.phone, name: c.name, birthday: c.birthday, bonus: c.bonus, registeredAt: c.registered_at,
  };

  function sessionCookie(req, c) {
    const expires = String(Date.now() + SESSION_DAYS * 864e5);
    const value = `${c.id}.${expires}`;
    return `${COOKIE}=${value}.${sign(`${value}.${c.password_hash}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`;
  }

  function loggedIn(c) {
    db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?').run(Date.now(), c.id);
    return findByPhone(c.phone);
  }

  /* ---------- Коды подтверждения ---------- */

  const codeSettings = () => {
    const wa = JSON.parse(store.setting('whatsapp', '{}'));
    return { whatsapp: Boolean(wa.enabled && wa.otpEnabled && wa.otpTemplate && wa.accessToken && wa.phoneNumberId), wa };
  };

  // Код в WhatsApp шаблоном «Аутентификация»: в тексте и в кнопке «Скопировать код» — сам код.
  async function sendWhatsappCode(wa, to, code) {
    const res = await fetch(`${WHATSAPP_API}/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wa.accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: wa.otpTemplate, language: { code: wa.otpLang || 'ru' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || `ошибка ${res.status}`);
  }

  // purpose: reset — сменить пароль, register — регистрация на номер, который уже есть в программе.
  async function issueCode(p, purpose, pending = null) {
    const hourAgo = Date.now() - 36e5;
    const recent = db.prepare('SELECT COUNT(*) AS n FROM phone_codes WHERE phone = ? AND created_at > ?').get(p, hourAgo).n;
    if (recent >= CODES_PER_HOUR) throw new UserError('Слишком много запросов кода. Попробуйте через час или позвоните нам.');
    // Прежние неиспользованные коды этого номера больше не действуют.
    db.prepare('UPDATE phone_codes SET used_at = ? WHERE phone = ? AND used_at IS NULL').run(Date.now(), p);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const { whatsapp, wa } = codeSettings();
    let channel = 'manual';
    if (whatsapp) {
      try {
        await sendWhatsappCode(wa, p, code);
        channel = 'whatsapp';
      } catch (err) {
        console.error('Код в WhatsApp не отправлен, передадим через сотрудника:', err.message);
      }
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO phone_codes (phone, purpose, code_hash, code, channel, pending, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p, purpose, hashPassword(code), channel === 'manual' ? code : null, channel, pending ? JSON.stringify(pending) : null, Date.now(), Date.now() + CODE_TTL);
    // Код для ручной передачи хранится, пока действует, — его видит сотрудник.
    if (channel === 'manual') onCodeRequested?.({ id: Number(lastInsertRowid), phone: p, purpose, code, name: pending?.name || findByPhone(p)?.name || '' });
    return { channel, expiresIn: CODE_TTL / 60_000 };
  }

  function checkCode(p, code, purpose) {
    const row = db.prepare('SELECT * FROM phone_codes WHERE phone = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(p, purpose);
    if (!row || row.expires_at < Date.now()) throw new UserError('Код устарел. Запросите новый.');
    if (row.attempts >= CODE_ATTEMPTS) throw new UserError('Слишком много неверных попыток. Запросите новый код.');
    if (!checkPassword(String(code ?? '').replace(/\D/g, ''), row.code_hash)) {
      db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      throw new UserError(`Неверный код. Осталось попыток: ${CODE_ATTEMPTS - row.attempts - 1}`);
    }
    db.prepare('UPDATE phone_codes SET used_at = ?, code = NULL WHERE id = ?').run(Date.now(), row.id);
    return row;
  }

  return {
    COOKIE,
    publicCustomer,

    current(req) {
      const [id, expires, sig] = readCookie(req).split('.');
      if (!id || !expires || !sig || Number(expires) < Date.now()) return null;
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
      if (!c || !c.password_hash || c.login_disabled) return null;
      const expected = sign(`${id}.${expires}.${c.password_hash}`);
      return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? c : null;
    },

    logoutCookie: (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`,

    // Регистрация. Новый номер — сразу вход. Номер, который уже есть в программе (покупал на кассе),
    // — сначала код подтверждения: { needCode: true }.
    async register(input, req) {
      const p = phone(input.phone);
      const name = text(input.name, 'Имя', { required: true, max: 80 });
      const bday = birthday(input.birthday);
      if (!bday) throw new UserError('Укажите дату рождения — в день рождения у нас скидка');
      const pass = password(input.password);
      const existing = findByPhone(p);
      if (existing?.password_hash) throw new UserError('Этот номер уже зарегистрирован. Войдите или нажмите «Забыл пароль».');
      if (existing) {
        const sent = await issueCode(p, 'register', { name, birthday: bday, hash: hashPassword(pass) });
        return { needCode: true, ...sent };
      }
      store.createCustomer({ phone: p, name, birthday: bday });
      db.prepare('UPDATE customers SET password_hash = ?, registered_at = ? WHERE phone = ?').run(hashPassword(pass), Date.now(), p);
      const c = loggedIn(findByPhone(p));
      return { ok: true, customer: publicCustomer(c), cookie: sessionCookie(req, c) };
    },

    confirmRegistration(input, req) {
      const p = phone(input.phone);
      const row = checkCode(p, input.code, 'register');
      const pending = JSON.parse(row.pending || '{}');
      const c = findByPhone(p);
      if (!c) throw new UserError('Покупатель не найден');
      db.prepare('UPDATE customers SET password_hash = ?, registered_at = ?, name = ?, birthday = ? WHERE id = ?')
        .run(pending.hash, Date.now(), pending.name || c.name, pending.birthday || c.birthday, c.id);
      const fresh = loggedIn(findByPhone(p));
      return { ok: true, customer: publicCustomer(fresh), cookie: sessionCookie(req, fresh) };
    },

    login(input, req, ip) {
      const now = Date.now();
      const f = failures.get(ip);
      if (f && now - f.since > FAILURE_WINDOW) failures.delete(ip);
      if ((failures.get(ip)?.count || 0) >= MAX_FAILURES) throw new UserError('Слишком много неверных попыток. Подождите 15 минут.');
      let p = '';
      try { p = phone(input.phone); } catch { /* неверный номер — просто неудачный вход */ }
      const c = p ? findByPhone(p) : null;
      const ok = checkPassword(String(input.password ?? ''), c?.password_hash || dummyHash) && c?.password_hash;
      if (!ok || c.login_disabled) {
        const entry = failures.get(ip) || { count: 0, since: now };
        entry.count++;
        failures.set(ip, entry);
        throw new UserError(c?.login_disabled ? 'Вход для этого номера закрыт. Позвоните нам.' : 'Неверный номер или пароль');
      }
      failures.delete(ip);
      const fresh = loggedIn(c);
      return { ok: true, customer: publicCustomer(fresh), cookie: sessionCookie(req, fresh) };
    },

    // «Забыл пароль»: код на номер. Отвечаем одинаково, есть номер или нет, — чтобы нельзя было
    // перебором узнать, кто у нас зарегистрирован.
    async requestReset(input) {
      const p = phone(input.phone);
      const c = findByPhone(p);
      if (c?.password_hash && !c.login_disabled) return issueCode(p, 'reset');
      return { channel: codeSettings().whatsapp ? 'whatsapp' : 'manual', expiresIn: CODE_TTL / 60_000 };
    },

    resetPassword(input, req) {
      const p = phone(input.phone);
      const pass = password(input.password);
      checkCode(p, input.code, 'reset');
      const c = findByPhone(p);
      if (!c) throw new UserError('Покупатель не найден');
      db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(pass), c.id);
      const fresh = loggedIn(findByPhone(p));
      return { ok: true, customer: publicCustomer(fresh), cookie: sessionCookie(req, fresh) };
    },

    // Заказы покупателя: оформленные из аккаунта и раньше на тот же номер.
    myOrders(c) {
      return db.prepare('SELECT id FROM orders WHERE customer_id = ? OR phone = ? ORDER BY created_at DESC LIMIT 50').all(c.id, c.phone)
        .map((r) => store.getOrder(r.id));
    },

    updateProfile(c, input) {
      const name = text(input.name, 'Имя', { required: true, max: 80 });
      const bday = birthday(input.birthday);
      if (!bday) throw new UserError('Укажите дату рождения');
      db.prepare('UPDATE customers SET name = ?, birthday = ? WHERE id = ?').run(name, bday, c.id);
      if (input.newPassword) {
        if (!checkPassword(String(input.password ?? ''), c.password_hash)) throw new UserError('Текущий пароль указан неверно');
        db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(password(input.newPassword)), c.id);
      }
      return findByPhone(c.phone);
    },

    /* ---------- Для сотрудников ---------- */

    // Коды, которые сотрудник должен передать покупателю сам (WhatsApp не настроен).
    pendingCodes() {
      return db.prepare(`SELECT pc.id, pc.phone, pc.purpose, pc.code, pc.created_at, pc.expires_at, pc.sent_by, c.name
        FROM phone_codes pc LEFT JOIN customers c ON c.phone = pc.phone
        WHERE pc.channel = 'manual' AND pc.used_at IS NULL AND pc.expires_at > ? ORDER BY pc.created_at DESC`).all(Date.now())
        .map((r) => ({ ...r, name: r.name || JSON.parse(db.prepare('SELECT pending FROM phone_codes WHERE id = ?').get(r.id).pending || '{}').name || '' }));
    },

    markCodeSent(id, user) {
      db.prepare('UPDATE phone_codes SET sent_by = ? WHERE id = ?').run(user ? user.name || user.email : '', Number(id));
      return { ok: true };
    },

    // Сотрудник выдаёт временный пароль: покупатель входит с ним и меняет на свой.
    adminResetPassword(customerId) {
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
      if (!c) throw new UserError('Покупатель не найден');
      const temp = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
      db.prepare('UPDATE customers SET password_hash = ?, registered_at = COALESCE(registered_at, ?) WHERE id = ?').run(hashPassword(temp), Date.now(), c.id);
      return { password: temp, phone: c.phone };
    },

    setLoginDisabled(customerId, disabled) {
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
      if (!c) throw new UserError('Покупатель не найден');
      db.prepare('UPDATE customers SET login_disabled = ? WHERE id = ?').run(disabled ? 1 : 0, c.id);
      return store.findCustomer(c.id);
    },
  };
}

module.exports = { createShopAuth };
