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

views.settings = { show: renderSettings, right: 'settings' };
