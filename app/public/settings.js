'use strict';

// Настройки: уведомления о продажах в Telegram.

async function renderSettings() {
  const f = $('#telegram-form');
  $('#telegram-error').hidden = true;
  try {
    const t = await api('/api/settings/telegram');
    f.elements.token.value = '';
    f.elements.token.placeholder = t.hasToken ? 'Токен сохранён. Введите новый, чтобы заменить' : '123456789:AAE…';
    f.elements.chatId.value = t.chatId;
    f.elements.enabled.checked = t.enabled;
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#telegram-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#telegram-error').hidden = true;
  try {
    await api('/api/settings/telegram', { method: 'PUT', body: { token: f.elements.token.value, chatId: f.elements.chatId.value, enabled: f.elements.enabled.checked } });
    toast('Настройки уведомлений сохранены');
    renderSettings();
  } catch (err) {
    showFormError('#telegram-error', err);
  }
});

$('#telegram-test').addEventListener('click', async () => {
  $('#telegram-error').hidden = true;
  try {
    await api('/api/settings/telegram/test', { method: 'POST' });
    toast('Пробное сообщение отправлено, проверьте Telegram');
  } catch (err) {
    showFormError('#telegram-error', err);
  }
});

/* ---------- Instagram ---------- */
async function renderInstagram() {
  const f = $('#instagram-form');
  $('#instagram-error').hidden = true;
  try {
    const s = await api('/api/settings/instagram');
    $('#ig-webhook').value = location.origin + s.webhookPath;
    $('#ig-verify').value = s.verifyToken;
    f.elements.appSecret.value = '';
    f.elements.accessToken.value = '';
    f.elements.appSecret.placeholder = s.hasSecret ? 'Сохранён. Введите новый, чтобы заменить' : '';
    f.elements.accessToken.placeholder = s.hasToken ? 'Сохранён. Введите новый, чтобы заменить' : 'IGAA…';
    f.elements.enabled.checked = s.enabled;
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#instagram-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/settings/instagram', { method: 'PUT', body: { appSecret: f.elements.appSecret.value, accessToken: f.elements.accessToken.value, enabled: f.elements.enabled.checked } });
    toast('Настройки Instagram сохранены');
    renderInstagram();
  } catch (err) {
    showFormError('#instagram-error', err);
  }
});
$('#instagram-form').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const value = $(btn.dataset.copy).value;
  try { await navigator.clipboard.writeText(value); toast('Скопировано'); } catch { $(btn.dataset.copy).select(); }
});

/* ---------- WhatsApp ---------- */
async function renderWhatsapp() {
  const f = $('#whatsapp-form');
  $('#whatsapp-error').hidden = true;
  try {
    const s = await api('/api/settings/whatsapp');
    $('#wa-webhook').value = location.origin + s.webhookPath;
    $('#wa-verify').value = s.verifyToken;
    f.elements.phoneNumberId.value = s.phoneNumberId;
    f.elements.appSecret.value = '';
    f.elements.accessToken.value = '';
    f.elements.appSecret.placeholder = s.hasSecret ? 'Сохранён. Введите новый, чтобы заменить' : '';
    f.elements.accessToken.placeholder = s.hasToken ? 'Сохранён. Введите новый, чтобы заменить' : 'EAAG…';
    f.elements.enabled.checked = s.enabled;
    f.elements.otpEnabled.checked = s.otpEnabled;
    f.elements.otpTemplate.value = s.otpTemplate;
    f.elements.otpLang.value = s.otpLang;
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#whatsapp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/settings/whatsapp', { method: 'PUT', body: {
      phoneNumberId: f.elements.phoneNumberId.value, appSecret: f.elements.appSecret.value, accessToken: f.elements.accessToken.value, enabled: f.elements.enabled.checked,
      otpEnabled: f.elements.otpEnabled.checked, otpTemplate: f.elements.otpTemplate.value, otpLang: f.elements.otpLang.value,
    } });
    toast('Настройки WhatsApp сохранены');
    renderWhatsapp();
  } catch (err) {
    showFormError('#whatsapp-error', err);
  }
});
$('#whatsapp-form').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try { await navigator.clipboard.writeText($(btn.dataset.copy).value); toast('Скопировано'); } catch { $(btn.dataset.copy).select(); }
});

/* ---------- SMS ---------- */
// Какие поля нужны каждому провайдеру и как они называются у него.
const SMS_FIELDS = {
  nikita: { login: 'Логин SMSPRO', password: 'Пароль SMSPRO', sender: 'Имя отправителя (одобренное в SMSPRO)',
    help: 'Договор и кабинет — на smspro.nikita.kg. В кабинете возьмите логин и пароль для API, согласуйте имя отправителя и, если просят, добавьте IP-адрес сервера в разрешённые.' },
  smsru: { apiKey: true, sender: 'Имя отправителя (необязательно)',
    help: 'Кабинет — на sms.ru. API-ключ — в разделе «Программистам». Перед отправкой в Кыргызстан проверьте цену SMS на номера +996.' },
  twilio: { login: 'Account SID', password: 'Auth Token', sender: 'Номер Twilio (+1…) или Messaging Service SID (MG…)',
    help: 'Кабинет — на twilio.com: Account SID и Auth Token на главной странице консоли. Отправка в Кыргызстан должна быть включена в Geo Permissions.' },
  custom: { login: 'Логин (если нужен)', password: 'Пароль (если нужен)', apiKey: true, sender: 'Отправитель (если нужен)', custom: true,
    help: 'Для любого провайдера: возьмите из его документации адрес запроса и вставьте подстановки.' },
};

function renderSmsFields() {
  const f = $('#sms-form');
  const conf = SMS_FIELDS[f.elements.provider.value] || {};
  for (const el of f.querySelectorAll('[data-sms]')) el.hidden = !conf[el.dataset.sms];
  if (conf.login) $('#sms-login-label').textContent = conf.login;
  if (conf.password) $('#sms-password-label').textContent = conf.password;
  if (conf.sender) $('#sms-sender-label').textContent = conf.sender;
  $('#sms-help').textContent = conf.help || 'Выберите провайдера, с которым у вас договор.';
}

async function renderSms() {
  const f = $('#sms-form');
  $('#sms-error').hidden = true;
  try {
    const s = await api('/api/settings/sms');
    f.elements.provider.innerHTML = '<option value="">— выберите —</option>' + Object.entries(s.providers).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('');
    for (const k of ['provider', 'login', 'sender', 'url', 'method', 'body', 'successText', 'template']) f.elements[k].value = s[k] || (k === 'method' ? 'POST' : '');
    f.elements.password.value = '';
    f.elements.apiKey.value = '';
    f.elements.password.placeholder = s.hasPassword ? 'Сохранён. Введите новый, чтобы заменить' : '';
    f.elements.apiKey.placeholder = s.hasApiKey ? 'Сохранён. Введите новый, чтобы заменить' : '';
    f.elements.test.checked = s.test;
    f.elements.enabled.checked = s.enabled;
    renderSmsFields();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#sms-form').addEventListener('change', (e) => { if (e.target.name === 'provider') renderSmsFields(); });
$('#sms-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['provider', 'login', 'password', 'apiKey', 'sender', 'url', 'method', 'body', 'successText', 'template'].map((k) => [k, f.elements[k].value]));
  try {
    await api('/api/settings/sms', { method: 'PUT', body: { ...body, test: f.elements.test.checked, enabled: f.elements.enabled.checked } });
    toast('Настройки SMS сохранены');
    renderSms();
  } catch (err) {
    showFormError('#sms-error', err);
  }
});
$('#sms-test').addEventListener('click', async () => {
  $('#sms-error').hidden = true;
  try {
    const r = await api('/api/settings/sms/test', { method: 'POST', body: { phone: $('#sms-test-phone').value } });
    toast(`Пробное SMS отправлено на ${phoneFmt(r.to)} — проверьте телефон`);
  } catch (err) {
    showFormError('#sms-error', err);
  }
});

/* ---------- Способы оплаты ---------- */
const PM_KINDS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', qr: 'QR-код', other: 'Другое' };
let pmList = [];

async function renderPaymentMethods() {
  try { pmList = (await api('/api/payment-methods?all=1')).methods; } catch (err) { return toast(err.message, 'error'); }
  const kindOptions = (sel) => Object.entries(PM_KINDS).map(([k, n]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${n}</option>`).join('');
  $('#pm-add').elements.kind.innerHTML = kindOptions('card');
  $('#pm-list').innerHTML = pmList.map((m, i) => `
    <div class="pm-row ${m.active ? '' : 'off'}" data-pm="${m.id}">
      <input class="input" value="${esc(m.name)}" data-pm-name aria-label="Название">
      <select class="input" data-pm-kind aria-label="Тип">${kindOptions(m.kind)}</select>
      <label class="check"><input type="checkbox" data-pm-active ${m.active ? 'checked' : ''}> Включён</label>
      <span class="cat-actions">
        <button type="button" class="icon-btn" data-pm-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button type="button" class="icon-btn" data-pm-move="1" ${i === pmList.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
      </span>
    </div>`).join('');
}

$('#pm-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/payment-methods', { method: 'POST', body: { name: f.elements.name.value, kind: f.elements.kind.value } });
    f.elements.name.value = '';
    toast('Способ оплаты добавлен');
    renderPaymentMethods();
  } catch (err) { toast(err.message, 'error'); }
});
$('#pm-list').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-pm]');
  if (!row) return;
  const body = { name: row.querySelector('[data-pm-name]').value, kind: row.querySelector('[data-pm-kind]').value, active: row.querySelector('[data-pm-active]').checked };
  try {
    await api(`/api/payment-methods/${row.dataset.pm}`, { method: 'PUT', body });
    toast('Сохранено');
  } catch (err) { toast(err.message, 'error'); }
  renderPaymentMethods();
});
$('#pm-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pm-move]');
  if (!btn) return;
  const ids = pmList.map((m) => m.id);
  const i = ids.indexOf(Number(btn.closest('[data-pm]').dataset.pm)), j = i + Number(btn.dataset.pmMove);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { await api('/api/payment-methods-order', { method: 'PUT', body: { ids } }); renderPaymentMethods(); } catch (err) { toast(err.message, 'error'); }
});

views.settings = { show: () => { renderSettings(); renderPaymentMethods(); renderSms(); renderInstagram(); renderWhatsapp(); }, right: 'settings' };
