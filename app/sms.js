'use strict';

// Отправка SMS: коды подтверждения для покупателей витрины.
//
// Поддерживаются:
//   nikita  — SMSPRO (Nikita, Кыргызстан), XML API smspro.nikita.kg;
//   smsru   — SMS.ru (отправляет и в Кыргызстан);
//   twilio  — Twilio (международный);
//   custom  — любой провайдер с HTTP-запросом: адрес и тело с подстановками {phone}, {text}, {sender}.
// Номер передаётся в международном виде без «+»: 996700123456.

const crypto = require('node:crypto');

const PROVIDERS = {
  nikita: 'SMSPRO (Nikita, Кыргызстан)',
  smsru: 'SMS.ru',
  twilio: 'Twilio',
  custom: 'Другой провайдер (HTTP-запрос)',
};

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tag = (xml, name) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

// Статусы SMSPRO: 0 — принято. Остальные коды переведены для понятной ошибки.
const NIKITA_STATUS = {
  1: 'неверный формат запроса', 2: 'неверный логин или пароль', 3: 'неверный IP-адрес (добавьте IP сервера в кабинете SMSPRO)',
  4: 'недостаточно средств на счёте', 5: 'неверный отправитель (имя отправителя должно быть одобрено)', 6: 'сообщение заблокировано по стоп-словам',
  7: 'неверный номер телефона', 8: 'неверное время отправки', 9: 'сообщение уже отправлено (повтор id)', 10: 'нет номеров телефонов', 11: 'сообщение слишком длинное',
};

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`нет связи с провайдером: ${err.message}`);
  }
  const body = await res.text();
  return { res, body };
}

// s — настройки SMS из программы, to — номер, text — текст сообщения.
async function sendSms(s, to, text) {
  switch (s.provider) {
    case 'nikita': {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><message><login>${xmlEscape(s.login)}</login><pwd>${xmlEscape(s.password)}</pwd>`
        + `<id>${crypto.randomBytes(6).toString('hex')}</id><sender>${xmlEscape(s.sender)}</sender><text>${xmlEscape(text)}</text>`
        + `<phones><phone>${to}</phone></phones>${s.test ? '<test>1</test>' : ''}</message>`;
      const { res, body } = await request(s.url || 'https://smspro.nikita.kg/api/message', { method: 'POST', headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: xml });
      const status = Number(tag(body, 'status'));
      if (!res.ok || status !== 0) throw new Error(`SMSPRO: ${NIKITA_STATUS[status] || body.slice(0, 200) || `ошибка ${res.status}`}`);
      return;
    }
    case 'smsru': {
      const params = new URLSearchParams({ api_id: s.apiKey, to, msg: text, json: '1' });
      if (s.sender) params.set('from', s.sender);
      if (s.test) params.set('test', '1');
      const { body } = await request(`https://sms.ru/sms/send?${params}`, { method: 'GET' });
      let data = {};
      try { data = JSON.parse(body); } catch { /* разберём ниже */ }
      const one = data.sms?.[to];
      if (data.status !== 'OK' || (one && one.status !== 'OK')) throw new Error(`SMS.ru: ${one?.status_text || data.status_text || body.slice(0, 200)}`);
      return;
    }
    case 'twilio': {
      const form = new URLSearchParams({ To: '+' + to, Body: text });
      if (s.sender.startsWith('MG')) form.set('MessagingServiceSid', s.sender); else form.set('From', s.sender);
      const { res, body } = await request(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.login)}/Messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${s.login}:${s.password}`).toString('base64') },
        body: form,
      });
      if (!res.ok) {
        let msg = body.slice(0, 200);
        try { msg = JSON.parse(body).message || msg; } catch { /* как есть */ }
        throw new Error(`Twilio: ${msg}`);
      }
      return;
    }
    case 'custom': {
      // Подстановки: в адресе — с кодированием для ссылки, в теле — как есть (JSON-строки экранируются).
      const fill = (tpl, enc) => tpl.replace(/\{(phone|text|sender|login|password|apiKey)\}/g, (_, k) => enc({ phone: to, text, sender: s.sender, login: s.login, password: s.password, apiKey: s.apiKey }[k] ?? ''));
      const url = fill(s.url, encodeURIComponent);
      const json = /^\s*[{[]/.test(s.body || '');
      const body = s.body ? fill(s.body, json ? (v) => JSON.stringify(String(v)).slice(1, -1) : (v) => v) : undefined;
      const { res, body: answer } = await request(url, {
        method: s.method === 'GET' ? 'GET' : 'POST',
        headers: body ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' } : undefined,
        body: s.method === 'GET' ? undefined : body,
      });
      if (!res.ok) throw new Error(`провайдер ответил ${res.status}: ${answer.slice(0, 200)}`);
      // Если задано слово успеха — ответ должен его содержать.
      if (s.successText && !answer.includes(s.successText)) throw new Error(`провайдер не подтвердил отправку: ${answer.slice(0, 200)}`);
      return;
    }
    default:
      throw new Error('провайдер SMS не выбран');
  }
}

module.exports = { sendSms, PROVIDERS };
