'use strict';

// Вход по email и паролю. Пароли хранятся как scrypt-хеш с солью.
// Сессия — подписанная cookie с id сотрудника. В подпись входит хеш пароля,
// поэтому смена пароля или удаление сотрудника сразу завершает его сессии.

const crypto = require('node:crypto');

const COOKIE = 'shop_session';
const OWNER_COOKIE = 'shop_owner';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const given = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(given, expected);
}

// users — хранилище сотрудников из db.js, secret — ключ подписи cookie.
function createAuth(users, secret) {
  const failures = new Map(); // ip -> { count, since }
  // Сравнение с несуществующим сотрудником занимает столько же времени, сколько с настоящим.
  const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

  // Ключ сотрудника в cookie: «магазин-id» (у филиалов своя база) или просто id.
  const keyOf = (user) => (users.keyOf ? users.keyOf(user) : user.id);
  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

  function sameText(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  }

  function readCookie(req, cookie = COOKIE) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookie) return rest.join('=');
    }
    return '';
  }

  // Сотрудник по значению cookie сессии (подпись проверяется).
  function userFromValue(value) {
    const [id, expires, signature] = String(value || '').split('.');
    if (!id || !expires || !signature || Number(expires) < Date.now()) return null;
    const user = users.findUser(id);
    if (!user || user.disabled) return null;
    return sameText(signature, sign(`${id}.${expires}.${user.password_hash}`)) ? user : null;
  }

  function sessionCookie(req, user) {
    const expires = String(Date.now() + SESSION_DAYS * 864e5);
    const value = `${keyOf(user)}.${expires}`;
    return `${COOKIE}=${value}.${sign(`${value}.${user.password_hash}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
  }

  function isSecure(req) {
    return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
  }

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  }

  return {
    // Без сотрудников программа открыта всем — так она работает на своём компьютере.
    get enabled() {
      return users.countUsers() > 0;
    },

    // Сотрудник текущей сессии или null.
    currentUser(req) {
      return userFromValue(readCookie(req));
    },

    // Вход владельца от имени сотрудника: сессия сотрудника, а сессия владельца бережётся в cookie shop_owner,
    // чтобы вернуться одной кнопкой. ownerOf — владелец, который сейчас смотрит от имени сотрудника.
    actAsCookies(req, target) {
      const own = readCookie(req, OWNER_COOKIE) || readCookie(req);
      const secure = isSecure(req) ? '; Secure' : '';
      return [sessionCookie(req, target), `${OWNER_COOKIE}=${own}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${86400}${secure}`];
    },
    ownerOf(req) {
      return userFromValue(readCookie(req, OWNER_COOKIE));
    },
    returnCookies(req) {
      const own = readCookie(req, OWNER_COOKIE);
      const secure = isSecure(req) ? '; Secure' : '';
      return [`${COOKIE}=${own}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`, `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`];
    },

    // Возвращает { ok, cookie, user } или { ok: false, error, status }.
    login(req, email, password) {
      const ip = clientIp(req);
      const now = Date.now();
      const f = failures.get(ip);
      if (f && now - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
      if ((failures.get(ip)?.count || 0) >= MAX_FAILURES) {
        return { ok: false, status: 429, error: 'Слишком много неверных попыток. Подождите 15 минут.' };
      }
      const user = users.findUserByEmail(email);
      const valid = checkPassword(password, user?.password_hash || dummyHash) && user && !user.disabled;
      if (!valid) {
        const entry = failures.get(ip) || { count: 0, since: now };
        entry.count++;
        failures.set(ip, entry);
        return { ok: false, status: 401, error: 'Неверный email или пароль' };
      }
      failures.delete(ip);
      const expires = String(now + SESSION_DAYS * 864e5);
      const value = `${keyOf(user)}.${expires}`;
      const cookie = `${COOKIE}=${value}.${sign(`${value}.${user.password_hash}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
      return { ok: true, cookie, user };
    },

    // Быстрая смена кассира на кассе: сотрудник выбран из списка, проверяется его PIN
    // (или пароль, если PIN не задан). Неверные попытки считаются вместе со входом.
    switchUser(req, userId, code) {
      const ip = clientIp(req);
      const now = Date.now();
      const f = failures.get(ip);
      if (f && now - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
      if ((failures.get(ip)?.count || 0) >= MAX_FAILURES) {
        return { ok: false, status: 429, error: 'Слишком много неверных попыток. Подождите 15 минут.' };
      }
      const user = users.findUser(userId);
      const stored = user?.pin_hash || user?.password_hash || dummyHash;
      const valid = checkPassword(code, stored) && user && !user.disabled;
      if (!valid) {
        const entry = failures.get(ip) || { count: 0, since: now };
        entry.count++;
        failures.set(ip, entry);
        return { ok: false, status: 401, error: user?.pin_hash ? 'Неверный PIN-код' : 'Неверный пароль' };
      }
      failures.delete(ip);
      const expires = String(now + SESSION_DAYS * 864e5);
      const value = `${keyOf(user)}.${expires}`;
      const cookie = `${COOKIE}=${value}.${sign(`${value}.${user.password_hash}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
      return { ok: true, cookie, user };
    },

    logoutCookie(req) {
      const secure = isSecure(req) ? '; Secure' : '';
      return [`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`, `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`];
    },
  };
}

module.exports = { createAuth, hashPassword, checkPassword };
