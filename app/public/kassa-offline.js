'use strict';

// Касса без интернета. Окно кассы и справочник товаров сохраняются на устройстве (сервис-воркер kassa-sw.js),
// поэтому касса открывается и ищет товары даже без связи. Чек, пробитый без интернета, кладётся в очередь
// на этом устройстве и отправляется сам, когда связь вернётся, — с тем временем, когда его пробили на самом деле.
// Повторно тот же чек не пробьётся: у каждого свой номер (clientId), сервер его запоминает.

const newClientId = () => `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const offlineQueue = {
  KEY: 'kassa.offlineQueue',
  syncing: false,
  all() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list)); } catch { toast('Не получилось сохранить чек на устройстве — память браузера заполнена', 'error'); }
    renderOfflineBar();
  },
  // Чеки вошедшего сотрудника: отправляются от его имени (чек другого кассира ждёт, пока тот войдёт).
  mine() {
    return this.all().filter((x) => x.userId === (session.user?.id ?? null));
  },
  add(body, total) {
    const list = this.all();
    list.push({ clientId: body.clientId, offlineAt: Date.now(), body, total, userId: session.user?.id ?? null, userName: session.user?.name || session.user?.email || '', error: '' });
    this.save(list);
  },
  remove(clientId) {
    this.save(this.all().filter((x) => x.clientId !== clientId));
  },
  async sync() {
    if (this.syncing || navigator.onLine === false || !this.mine().length) return;
    this.syncing = true;
    renderOfflineBar();
    let sent = 0;
    try {
      for (const item of this.mine()) {
        try {
          await api('/api/sales', { method: 'POST', body: { ...item.body, clientId: item.clientId, offlineAt: item.offlineAt } });
          this.remove(item.clientId);
          sent++;
        } catch (err) {
          if (err.offline) break; // связь снова пропала — попробуем позже
          // Сервер не принял чек (товар удалён, нет права и т.п.) — оставляем с причиной, кассир решит.
          this.save(this.all().map((x) => (x.clientId === item.clientId ? { ...x, error: err.message } : x)));
        }
      }
    } finally {
      this.syncing = false;
      renderOfflineBar();
    }
    if (sent) {
      toast(`✅ Связь есть: отправлено чеков без интернета — ${sent}`);
      if (typeof loadShift === 'function') loadShift();
      catalog.load().catch(() => {});
    }
  },
};

function renderOfflineBar() {
  let bar = document.getElementById('offline-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offline-bar';
    bar.className = 'offline-bar';
    document.body.prepend(bar);
  }
  const mine = offlineQueue.mine();
  const others = offlineQueue.all().length - mine.length;
  const failed = mine.filter((x) => x.error);
  const offline = navigator.onLine === false;
  const sum = mine.reduce((a, x) => a + (x.total || 0), 0);
  bar.hidden = !offline && !mine.length && !others;
  bar.className = `offline-bar ${offline ? 'off' : failed.length ? 'bad' : 'wait'}`;
  bar.innerHTML = `<div class="ob-line">${offline
    ? `📴 <b>Нет интернета.</b> Продавайте как обычно: чеки сохраняются на этом устройстве и пробьются сами, когда появится связь, с верным временем.`
    : offlineQueue.syncing ? '⏳ Отправляем чеки, пробитые без интернета…' : mine.length ? '⏳ Есть чеки, пробитые без интернета — отправляются автоматически.' : ''}
    ${mine.length ? ` В очереди: <b>${mine.length}</b> на <b>${money2(sum)}</b>.` : ''}${others ? ` <span class="pcat">Чеков других кассиров: ${others} — отправятся, когда они войдут.</span>` : ''}
    ${!offline && mine.length && !offlineQueue.syncing ? '<button type="button" class="btn small" data-ob-sync>Отправить сейчас</button>' : ''}</div>
    ${failed.map((x) => `<div class="ob-err">❌ Чек от ${new Date(x.offlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} на ${money2(x.total || 0)} не принят: ${esc(x.error)}
      <button type="button" class="btn small" data-ob-retry="${x.clientId}">Повторить</button>
      <button type="button" class="btn small ghost danger-text" data-ob-del="${x.clientId}">Удалить чек</button></div>`).join('')}`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-ob-sync]')) return offlineQueue.sync();
  const retry = e.target.closest('[data-ob-retry]');
  if (retry) {
    offlineQueue.save(offlineQueue.all().map((x) => (x.clientId === retry.dataset.obRetry ? { ...x, error: '' } : x)));
    return offlineQueue.sync();
  }
  const del = e.target.closest('[data-ob-del]');
  if (del && confirm('Удалить этот чек из очереди? Он не попадёт в программу — товар и деньги придётся провести вручную.')) offlineQueue.remove(del.dataset.obDel);
});

addEventListener('online', () => { renderOfflineBar(); offlineQueue.sync(); });
addEventListener('offline', renderOfflineBar);
setInterval(() => offlineQueue.sync(), 20_000);
session.ready.then(() => { renderOfflineBar(); offlineQueue.sync(); }).catch(() => renderOfflineBar());

// Окно кассы и справочник — в память устройства, чтобы касса открывалась без интернета.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/kassa-sw.js', { scope: '/kassa' }).catch(() => {});
