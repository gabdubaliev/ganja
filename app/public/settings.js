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

views.settings = { show: () => { renderSettings(); renderInstagram(); }, right: 'settings' };
