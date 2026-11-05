'use strict';

// «Ещё» в окне кассы: всё, что не поместилось в нижнее меню (табель, история продаж, фото — если есть право).
const KASSA_MORE = [
  ['sales', 'pos', '🧾', 'История продаж', 'Ваши чеки за смену и за период, возврат'],
  ['mytimesheet', 'mytimesheet', '🗓️', 'Мой табель', 'Ваши смены и заработок за месяц'],
  ['photos', 'photos', '📷', 'Фото товаров', 'Добавить и заменить фото товаров и категорий'],
];

function renderKassaMore() {
  $('#kassa-more').innerHTML = KASSA_MORE.filter(([, right]) => session.can(right)).map(([view, , icon, title, about]) => `
    <a class="more-tile" href="${view.startsWith('#') ? '#more' : '#' + view}">
      <span class="more-icon" aria-hidden="true">${icon}</span>
      <span class="more-text"><b>${esc(title)}</b><span>${esc(about)}</span></span>
    </a>`).join('') || '<p class="empty">Других разделов нет</p>';
}

const KX_CATEGORIES = ['Обед', 'Хозяйственные расходы', 'Доставка', 'Реклама', 'Связь и интернет', 'Ремонт', 'Прочее'];
// «Расход из кассы» — кнопка в блоке «Чек», рядом с «Историей продаж».
function openKassaExpense() {
  const f = $('#kx-form');
  f.reset();
  $('#kx-error').hidden = true;
  f.elements.category.innerHTML = KX_CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  $('#kx-dlg').showModal();
  f.elements.amount.focus();
}
$('#kx-open')?.addEventListener('click', openKassaExpense);
$('#kx-cancel').addEventListener('click', () => $('#kx-dlg').close());
$('#kx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseNum(f.elements.amount.value);
  const note = f.elements.note.value.trim();
  if (!(amount > 0)) return showFormError('#kx-error', new Error('Укажите, сколько денег взяли из кассы'));
  if (note.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '').length < 3) return showFormError('#kx-error', new Error('Напишите причину: на что взяли деньги'));
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/kassa/expense', { method: 'POST', body: { amount, note, category: f.elements.category.value } });
    $('#kx-dlg').close();
    toast(`Расход ${money(amount)} сохранён — деньги в кассе уменьшены`);
  } catch (err) {
    showFormError('#kx-error', err);
  } finally {
    btn.disabled = false;
  }
});

views.more = { show: renderKassaMore, right: null };

/* ---------- Кнопка «+» внизу кассы: товар в чек камерой или поиском ---------- */
const KASSA_PLUS = [
  ['scan', 'pos', '📷', 'Сканировать камерой', 'Наведите камеру на штрихкод — товар сразу в чек'],
  ['search', 'pos', '🔍', 'Найти товар', 'По названию, коду или штрихкоду'],
  ['sales', 'pos', '🧾', 'История продаж', 'Чеки за смену, возврат'],
  ['cert', 'certificates.sell', '🎁', 'Продать сертификат', 'Подарочный сертификат покупателю'],
];
function kassaPlus() {
  let sheet = document.getElementById('plus-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'plus-sheet';
    sheet.className = 'plus-sheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="plus-backdrop" data-plus-close></div><div class="plus-panel" role="dialog" aria-modal="true" aria-label="Добавить товар"><div class="plus-grip" data-plus-close></div><div class="plus-body"></div></div>';
    document.body.append(sheet);
    sheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-plus-close]')) return closeKassaPlus();
      const b = e.target.closest('[data-plus]');
      if (b) { closeKassaPlus(); kassaPlusPick(b.dataset.plus); }
    });
    let y0 = null;
    const panel = sheet.querySelector('.plus-panel');
    panel.addEventListener('touchstart', (e) => { y0 = panel.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    panel.addEventListener('touchmove', (e) => { if (y0 !== null) { const d = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = d ? `translateY(${d}px)` : ''; } }, { passive: true });
    panel.addEventListener('touchend', (e) => { if (y0 === null) return; const d = e.changedTouches[0].clientY - y0; y0 = null; panel.style.transform = ''; if (d > 90) closeKassaPlus(); }, { passive: true });
  }
  const list = KASSA_PLUS.filter(([, right]) => session.can(right));
  sheet.querySelector('.plus-body').innerHTML = `<section><h3>Добавить товар в чек</h3><div class="plus-list">${list.map(([k, , icon, title, about]) => `
    <button type="button" class="plus-item plus-wide" data-plus="${k}"><span class="plus-icon" aria-hidden="true">${icon}</span><span><b>${esc(title)}</b><small>${esc(about)}</small></span></button>`).join('')}</div></section>`;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeKassaPlus() {
  const sheet = document.getElementById('plus-sheet');
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 220);
}
// Код с камеры — как со сканера: в поиск и Enter (товар в чек, модификации — выбор размера).
function kassaScanCode(code) {
  const input = $('#pos-search');
  input.value = code;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const found = catalog.search(code, 2);
  if (found.length === 1) return `✅ В чеке: ${found[0].name}`;
  return found.length ? 'Выберите модификацию на экране' : `Не найден товар с кодом ${code}`;
}
function kassaPlusPick(k) {
  const toPos = () => { if (location.hash !== '#pos') location.hash = 'pos'; };
  if (k === 'scan') { toPos(); return openScanner({ onCode: kassaScanCode }); }
  if (k === 'search') { toPos(); return setTimeout(() => { $('#pos-search').focus(); $('#pos-search').select(); }, 150); }
  if (k === 'sales') { location.hash = 'sales'; return undefined; }
  if (k === 'cert') { toPos(); return setTimeout(() => $('#cert-sell-open')?.click(), 150); }
  return undefined;
}
$('#nav-plus')?.addEventListener('click', () => (document.getElementById('plus-sheet')?.hidden === false ? closeKassaPlus() : kassaPlus()));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKassaPlus(); });
window.addEventListener('hashchange', closeKassaPlus);
