'use strict';

// Секреты отдельно от базы: токены Telegram, Instagram, WhatsApp, SMS, ключ Claude, ключ подписи входа и ключ шифрования.
// Лежат в файле secrets.json рядом с базой (права 600 — читает только программа). В базе вместо них — пустое поле
// или метка «__vault__», поэтому резервная копия базы, скачанная или украденная, ключей не содержит.
//
// Работает незаметно для остального кода: store.setting() возвращает значение вместе с секретами,
// store.setSetting() раскладывает секреты в файл. Старые значения из базы переносятся сами при первом чтении.

const fs = require('node:fs');
const path = require('node:path');

const MARK = '__vault__';
// Ключ настройки → поля JSON с секретами (true — секрет вся настройка целиком).
const SECRET_FIELDS = {
  telegram: ['token'],
  instagram: ['accessToken', 'appSecret', 'pageToken'],
  whatsapp: ['accessToken', 'appSecret'],
  sms: ['password', 'apiKey'],
  anthropic_api_key: true,
  session_secret: true,
  secrets_key: true,
  offsite_backup: ['password'],
};

function createVault(file) {
  let data = { v: 1, stores: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.stores ||= {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Файл секретов ${file} не читается: ${err.message}`);
  }
  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  }
  return {
    file,
    get(ns, key) { return data.stores[ns]?.[key]; },
    set(ns, key, value) {
      const cur = data.stores[ns]?.[key];
      if (JSON.stringify(cur) === JSON.stringify(value)) return;
      (data.stores[ns] ||= {})[key] = value;
      save();
    },
  };
}

// Подменяет setting/setSetting у хранилища магазина (ns — имя базы: shop, branch-2…).
function protectSettings(store, vault, ns) {
  const rawGet = store.setting.bind(store);
  const rawSet = store.setSetting.bind(store);
  const has = (key) => Object.prototype.hasOwnProperty.call(SECRET_FIELDS, key);

  // Разложить значение: секретное — в файл, в базу — без секретов.
  function split(key, value) {
    const spec = SECRET_FIELDS[key];
    if (spec === true) {
      vault.set(ns, key, String(value ?? ''));
      return MARK;
    }
    let obj;
    try { obj = JSON.parse(value); } catch { return value; } // не JSON — оставляем как есть
    if (!obj || typeof obj !== 'object') return value;
    const secret = { ...(vault.get(ns, key) || {}) };
    for (const f of spec) {
      if (obj[f] === undefined) continue;
      secret[f] = obj[f];
      obj[f] = '';
    }
    vault.set(ns, key, secret);
    return JSON.stringify(obj);
  }

  store.setSetting = function setSetting(key, value) {
    return rawSet(key, has(key) ? split(key, value) : value);
  };

  store.setting = function setting(key, fallback) {
    if (!has(key)) return rawGet(key, fallback);
    const spec = SECRET_FIELDS[key];
    if (spec === true) {
      const kept = vault.get(ns, key);
      if (kept !== undefined && kept !== '') return kept;
      const raw = rawGet(key, MARK);
      // Старое значение лежит в базе открыто (или его ещё нет) — переносим в файл.
      const value = raw && raw !== MARK ? raw : fallback;
      if (value !== undefined && value !== null && value !== '') rawSet(key, split(key, value));
      return value;
    }
    const raw = rawGet(key, fallback);
    let obj;
    try { obj = JSON.parse(raw); } catch { return raw; }
    if (!obj || typeof obj !== 'object') return raw;
    const secret = vault.get(ns, key) || {};
    // Секреты, которые ещё лежат в базе открыто, — переносим в файл.
    if (spec.some((f) => typeof obj[f] === 'string' && obj[f] !== '')) {
      rawSet(key, split(key, raw));
      return JSON.stringify({ ...obj, ...Object.fromEntries(spec.filter((f) => obj[f] !== undefined && obj[f] !== '').map((f) => [f, obj[f]])) });
    }
    for (const f of spec) if (secret[f] !== undefined) obj[f] = secret[f];
    return JSON.stringify(obj);
  };

  // Перенести всё, что ещё лежит в базе открыто (вызывается при запуске).
  store.migrateSecrets = function migrateSecrets() {
    let moved = 0;
    for (const key of Object.keys(SECRET_FIELDS)) {
      const row = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) continue;
      const spec = SECRET_FIELDS[key];
      if (spec === true) {
        if (row.value && row.value !== MARK) { store.setting(key, ''); moved++; }
        continue;
      }
      try {
        const obj = JSON.parse(row.value);
        if (obj && spec.some((f) => typeof obj[f] === 'string' && obj[f] !== '')) { store.setting(key, '{}'); moved++; }
      } catch { /* не JSON */ }
    }
    // Старые значения ещё лежат в освободившихся страницах файла базы — пересобираем базу, чтобы их не осталось.
    if (moved) {
      try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.db.exec('VACUUM'); store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* база занята — очистится при следующем запуске */ }
    }
    return moved;
  };
  return store;
}

module.exports = { createVault, protectSettings, SECRET_FIELDS, MARK };
