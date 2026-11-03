'use strict';

// Настройки: уведомления о продажах в Telegram.

async function renderSettings() {
  if (session.can('currency')) {
    api('/api/settings/currency').then((c) => { $('#currency-form').elements.usdRate.value = c.usdRate ? String(c.usdRate).replace('.', ',') : ''; $('#currency-form').elements.costExtra.value = String(c.costExtra ?? 0).replace('.', ','); }).catch(() => {});
  }
  if (!session.can('settings')) return;
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
  renderTgEvents();
  renderClaudeKey();
}

// Ключ Claude API: для накладных по фото и проверки фото в AI Studio.
async function renderClaudeKey() {
  let st;
  try { st = await api('/api/invoice/status'); } catch { return; }
  $('#claude-status').innerHTML = st.fromEnv ? '✅ Ключ задан на сервере (ANTHROPIC_API_KEY) — здесь вводить не нужно.'
    : st.configured ? '✅ Ключ сохранён. Чтобы заменить — вставьте новый.' : '⬜ Ключ ещё не введён — Claude не работает.';
  $('#claude-key').hidden = st.fromEnv;
  $('#claude-form button[type=submit]').hidden = st.fromEnv;
  $('#claude-clear').hidden = !st.configured || st.fromEnv;
}
$('#claude-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#claude-error').hidden = true;
  const key = $('#claude-key').value.trim();
  if (!/^sk-ant-/.test(key)) return showFormError('#claude-error', new Error('Ключ Claude API начинается с sk-ant- — скопируйте его целиком из console.anthropic.com'));
  try {
    await api('/api/invoice/key', { method: 'PUT', body: { key } });
    $('#claude-key').value = '';
    toast('Ключ Claude сохранён');
    renderClaudeKey();
  } catch (err) { showFormError('#claude-error', err); }
});
$('#claude-clear').addEventListener('click', async () => {
  if (!confirm('Удалить ключ Claude? Распознавание накладных и проверка фото перестанут работать.')) return;
  try { await api('/api/invoice/key', { method: 'PUT', body: { key: '' } }); toast('Ключ удалён'); renderClaudeKey(); } catch (err) { toast(err.message, 'error'); }
});

// Переключатели: какие уведомления присылать в Telegram.
async function renderTgEvents() {
  let d;
  try { d = await api('/api/settings/telegram/events'); } catch { return; }
  $('#tg-events-list').innerHTML = d.groups.map(([group, list]) => `<div class="tg-ev-group"><h4>${esc(group)}</h4>${list.map(([key, label]) => `
    <label class="tg-ev ${d.on[key] ? '' : 'off'}"><span>${esc(label)}</span><span class="tg-switch"><input type="checkbox" data-tg-ev="${key}" ${d.on[key] ? 'checked' : ''} aria-label="${esc(label)}"><i></i></span></label>`).join('')}</div>`).join('');
}
$('#tg-events-list').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-tg-ev]');
  if (!box) return;
  const on = Object.fromEntries([...document.querySelectorAll('[data-tg-ev]')].map((x) => [x.dataset.tgEv, x.checked]));
  box.closest('.tg-ev').classList.toggle('off', !box.checked);
  try {
    await api('/api/settings/telegram/events', { method: 'PUT', body: { on } });
    toast(`${box.checked ? 'Включено' : 'Выключено'}: ${box.closest('.tg-ev').querySelector('span').textContent}`);
  } catch (err) {
    box.checked = !box.checked;
    toast(err.message, 'error');
  }
});

$('#currency-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#currency-error').hidden = true;
  try {
    const c = await api('/api/settings/currency', { method: 'PUT', body: { usdRate: e.target.elements.usdRate.value.trim(), costExtra: e.target.elements.costExtra.value.trim() } });
    e.target.elements.usdRate.value = c.usdRate ? String(c.usdRate).replace('.', ',') : '';
    e.target.elements.costExtra.value = String(c.costExtra).replace('.', ',');
    toast(`Сохранено: ${c.usdRate ? `1 $ = ${String(c.usdRate).replace('.', ',')} сом` : 'курс доллара не задан'} · себестоимость = закупка + ${c.costExtra} сом`);
  } catch (err) {
    showFormError('#currency-error', err);
  }
});

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
    $('#ig-clear-token').hidden = !s.hasToken;
    f.elements.appId.value = s.appId || '';
    f.elements.configId.value = s.configId || '';
    f.elements.igId.value = s.igId || '';
    $('#ig-redirect').textContent = `${location.origin}/api/instagram/callback`;
    f.elements.autoReply.checked = s.autoReply;
    f.elements.autoText.value = s.autoText || '';
    f.elements.autoHours.value = s.autoHours || 12;
    // Доходят ли сообщения: когда Instagram последний раз присылал событие, были ли отказы и ошибки автоответа.
    const when = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#ig-status').innerHTML = [
      s.mode === 'page' ? `🔗 Подключено через Facebook-страницу «${esc(s.pageName)}»${s.igUsername ? ` → @${esc(s.igUsername)}` : ''}` : '',
      s.mode === 'unified' ? `🔗 Единый вход Meta${s.igUsername ? ` → @${esc(s.igUsername)}` : ''}${s.igId ? '' : ' — ⚠️ впишите «ID аккаунта Instagram»'}` : '',
      s.resolveNote ? `⚠️ ${esc(s.resolveNote)}` : '',
      s.tokenKind === 'instagram' && s.tokenExpires ? `🔑 Маркер Instagram действует до <b>${when(s.tokenExpires)}</b>, программа продлевает его сама` : '',
      s.lastHook ? `✅ Последнее событие от Instagram: <b>${when(s.lastHook)}</b>` : '⏳ От Instagram ещё не приходило ни одного сообщения на этот адрес',
      s.lastDenied ? `⚠️ ${when(s.lastDenied.at)} Instagram прислал сообщение, но программа его отклонила: ${esc(s.lastDenied.details)} (проверьте App Secret и галочку «Принимать сообщения»)` : '',
      s.lastAutoError ? `⚠️ ${when(s.lastAutoError.at)} автоответ не отправлен: ${esc(s.lastAutoError.details)}` : '',
    ].filter(Boolean).map((x) => `<p class="pick-meta">${x}</p>`).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Instagram: автоответ ценой ---------- */
const IG_STATUS = { sent: 'отправлено', not_found: 'артикул не найден', error: 'ошибка', repeat: 'повтор, не отвечали' };
let igDefaultTemplate = '';
async function renderIgAuto() {
  const f = $('#igauto-form');
  $('#igauto-error').hidden = true;
  try {
    const { auto } = await api('/api/settings/instagram');
    igDefaultTemplate = auto.defaultTemplate;
    f.elements.autoPrice.checked = auto.autoPrice;
    f.elements.priceWords.value = auto.priceWords;
    f.elements.priceTemplate.value = auto.priceTemplate;
    f.elements.publicReply.value = auto.publicReply;
    f.elements.notifyMissing.checked = auto.notifyMissing;
    const { items, week } = await api('/api/instagram/auto-log?limit=20');
    $('#ia-stats').textContent = `За 7 дней: отправлено ${week.sent || 0}, без артикула или не найдено ${week.not_found || 0}, ошибок ${week.error || 0}.`;
    $('#ia-log').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>Когда</th><th>Кто</th><th>Вопрос</th><th>Артикул</th><th>Итог</th></tr></thead><tbody>${items.map((x) => `
      <tr title="${esc(x.reply || x.error || '')}"><td>${esc(dateTime(x.at))}</td><td>${x.username ? '@' + esc(x.username) : x.kind === 'direct' ? 'Direct' : ''}</td>
      <td>${x.permalink ? `<a href="${esc(x.permalink)}" target="_blank" rel="noopener">${esc(x.question || 'рилс')}</a>` : esc(x.question || '')}</td>
      <td>${esc(x.article || '—')}</td><td>${esc(IG_STATUS[x.status] || x.status)}${x.error ? ': ' + esc(x.error) : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="sub">Пока не было.</p>';
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('#igauto-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#igauto-error').hidden = true;
  try {
    await api('/api/settings/instagram/auto', { method: 'PUT', body: {
      autoPrice: f.elements.autoPrice.checked, priceWords: f.elements.priceWords.value, priceTemplate: f.elements.priceTemplate.value,
      publicReply: f.elements.publicReply.value, notifyMissing: f.elements.notifyMissing.checked } });
    toast('Автоответ ценой сохранён');
    renderIgAuto();
  } catch (err) {
    showFormError('#igauto-error', err);
  }
});
$('#ia-reset').addEventListener('click', () => { $('#igauto-form').elements.priceTemplate.value = igDefaultTemplate; });
$('#ia-preview').addEventListener('click', async () => {
  const out = $('#ia-preview-text');
  $('#igauto-error').hidden = true;
  try {
    const r = await api('/api/settings/instagram/preview', { method: 'POST', body: { article: $('#ia-try').value, template: $('#igauto-form').elements.priceTemplate.value } });
    out.textContent = r.text;
    out.hidden = false;
  } catch (err) {
    out.hidden = true;
    showFormError('#igauto-error', err);
  }
});
// «Подключить Instagram»: сначала сохраняем ID и секрет, потом — в окно Instagram (вернёт обратно в «Настройки»).
$('#ig-connect').addEventListener('click', async () => {
  const f = $('#instagram-form');
  $('#instagram-error').hidden = true;
  try {
    await api('/api/settings/instagram', { method: 'PUT', body: { appId: f.elements.appId.value, configId: f.elements.configId.value, igId: f.elements.igId.value, appSecret: f.elements.appSecret.value, enabled: f.elements.enabled.checked,
      autoReply: f.elements.autoReply.checked, autoText: f.elements.autoText.value, autoHours: f.elements.autoHours.value } });
    location.href = '/api/instagram/connect';
  } catch (err) {
    showFormError('#instagram-error', err);
  }
});
// Вернулись из Instagram: показать итог и убрать его из адреса.
{
  const q = new URLSearchParams(location.search);
  if (q.get('ig')) {
    setTimeout(() => toast(q.get('igmsg') || (q.get('ig') === 'ok' ? 'Instagram подключён' : 'Не получилось подключить Instagram'), q.get('ig') === 'ok' ? undefined : 'error'), 600);
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

$('#ig-clear-token').addEventListener('click', async () => {
  if (!confirm('Удалить сохранённый маркер Instagram? Автоответы перестанут уходить, пока не подключите Instagram заново кнопкой «Подключить Instagram».')) return;
  try {
    await api('/api/settings/instagram', { method: 'PUT', body: { clearToken: true, enabled: $('#instagram-form').elements.enabled.checked } });
    toast('Маркер удалён');
    renderInstagram();
  } catch (err) {
    showFormError('#instagram-error', err);
  }
});

$('#ig-diag').addEventListener('click', async () => {
  const box = $('#ig-diag-out');
  box.hidden = false;
  box.innerHTML = '<p class="pick-meta">Проверяю… (до 30 секунд)</p>';
  try {
    const r = await api('/api/settings/instagram/diagnose', { method: 'POST' });
    box.innerHTML = `<p><b>Диагностика Instagram</b> — ${r.works ? '✅ нашёлся рабочий вариант, программа переключилась на него' : '❌ рабочего варианта нет'}. Пришлите скриншот этого блока.</p>`
      + `<ol>${r.items.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><b>${x.ok ? '✅' : '❌'} ${esc(x.title)}</b><br><code>${esc(x.detail)}</code></li>`).join('')}</ol>`;
    renderInstagram();
  } catch (err) {
    box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
});

$('#ig-check').addEventListener('click', async () => {
  $('#instagram-error').hidden = true;
  try {
    const r = await api('/api/settings/instagram/check', { method: 'POST' });
    toast(`Токен работает: аккаунт @${r.username || r.name || r.id}`);
  } catch (err) {
    showFormError('#instagram-error', err);
  }
});

$('#instagram-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/settings/instagram', { method: 'PUT', body: { appId: f.elements.appId.value, configId: f.elements.configId.value, igId: f.elements.igId.value, appSecret: f.elements.appSecret.value, accessToken: f.elements.accessToken.value, enabled: f.elements.enabled.checked,
      autoReply: f.elements.autoReply.checked, autoText: f.elements.autoText.value, autoHours: f.elements.autoHours.value } });
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
      <label class="pm-fee" title="Сколько процентов удерживает банк">Комиссия <input class="input num" inputmode="decimal" value="${m.commission ? String(m.commission).replace('.', ',') : ''}" placeholder="0" data-pm-fee aria-label="Комиссия, %"> %</label>
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
    await api('/api/payment-methods', { method: 'POST', body: { name: f.elements.name.value, kind: f.elements.kind.value, commission: parseNum(f.elements.commission.value) || 0 } });
    f.elements.commission.value = '';
    f.elements.name.value = '';
    toast('Способ оплаты добавлен');
    renderPaymentMethods();
  } catch (err) { toast(err.message, 'error'); }
});
$('#pm-list').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-pm]');
  if (!row) return;
  const body = { name: row.querySelector('[data-pm-name]').value, kind: row.querySelector('[data-pm-kind]').value, active: row.querySelector('[data-pm-active]').checked,
    commission: parseNum(row.querySelector('[data-pm-fee]').value) || 0 };
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

// Только «Курс доллара» (без права «Настройки») — на странице одна эта карточка.
views.settings = { show: () => { renderSettings(); if (!session.can('settings')) return; renderPaymentMethods(); renderSms(); renderInstagram(); renderIgAuto(); renderWhatsapp(); }, right: ['settings', 'currency'] };
