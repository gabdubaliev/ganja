'use strict';

// Вход по одному паролю из переменной APP_PASSWORD.
// Сессия — подписанная cookie: смена пароля сразу завершает все старые сессии.

const crypto = require('node:crypto');

const COOKIE = 'shop_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

function createAuth(password) {
  const enabled = Boolean(password);
  const secret = crypto.createHash('sha256').update('session:' + password).digest();
  const failures = new Map(); // ip -> { count, since }

  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

  function sameText(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  }

  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return '';
  }

  function isSecure(req) {
    return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
  }

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  }

  return {
    enabled,

    isLoggedIn(req) {
      if (!enabled) return true;
      const [expires, signature] = readCookie(req).split('.');
      if (!expires || !signature || Number(expires) < Date.now()) return false;
      return sameText(signature, sign(expires));
    },

    // Возвращает { ok, cookie } или { ok: false, error, status }.
    login(req, given) {
      const ip = clientIp(req);
      const now = Date.now();
      const f = failures.get(ip);
      if (f && now - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
      if ((failures.get(ip)?.count || 0) >= MAX_FAILURES) {
        return { ok: false, status: 429, error: 'Слишком много неверных попыток. Подождите 15 минут.' };
      }
      if (!enabled || !sameText(given, password)) {
        const entry = failures.get(ip) || { count: 0, since: now };
        entry.count++;
        failures.set(ip, entry);
        return { ok: false, status: 401, error: 'Неверный пароль' };
      }
      failures.delete(ip);
      const expires = String(now + SESSION_DAYS * 864e5);
      const cookie = `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
      return { ok: true, cookie };
    },

    logoutCookie(req) {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;
    },
  };
}

module.exports = { createAuth };
