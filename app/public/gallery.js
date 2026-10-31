'use strict';

// Галерея фото товара: несколько фото, порядок, основное (первое), удаление, предпросмотр как на витрине.
// Изменения копятся в окне и записываются одной кнопкой «Сохранить» (на сервере — всё или ничего).
// Основное фото — то же, что в списке товаров, кассе и каталоге витрины; остальные — только в окне товара на витрине.

const GALLERY_LIMIT = 13; // основное + 12 дополнительных (как на сервере)
const gal = { productId: null, title: '', items: [], start: '', preview: 0, onSaved: null, busy: false };

document.body.insertAdjacentHTML('beforeend', `
<dialog id="gallery-dialog" class="gallery-dialog" aria-labelledby="gal-title">
  <div class="gal-head">
    <div><h2 id="gal-title">Фото товара</h2><p class="sub" id="gal-sub"></p></div>
    <button type="button" class="icon-btn" id="gal-close" aria-label="Закрыть">×</button>
  </div>
  <div class="gal-body">
    <section class="gal-edit">
      <div class="gal-grid" id="gal-grid"></div>
      <div class="gal-tools">
        <button type="button" class="btn" id="gal-add">+ Добавить фото</button>
        <span class="sub" id="gal-count"></span>
      </div>
      <p class="sub gal-help">Первое фото — <b>основное</b> ★: оно в каталоге витрины, в кассе и в списке товаров.
        Остальные видны в окне товара на витрине. Порядок — перетаскиванием или стрелками ← →.
        JPEG, PNG или WebP; большие снимки уменьшаются автоматически.</p>
    </section>
    <section class="gal-preview">
      <h3>Так будет на витрине</h3>
      <div class="gp-main" id="gp-main"></div>
      <div class="gp-thumbs" id="gp-thumbs"></div>
    </section>
  </div>
  <p class="form-error" id="gal-error" role="alert" hidden></p>
  <div class="form-actions">
    <span class="sub" id="gal-state"></span>
    <button type="button" class="btn ghost" id="gal-cancel">Отмена</button>
    <button type="button" class="btn primary" id="gal-save">Сохранить</button>
  </div>
</dialog>`);

const galSig = () => JSON.stringify(gal.items.map((x) => (x.main ? 'm' : x.id ? `i${x.id}` : `n${x.key}`)));
const galDirty = () => galSig() !== gal.start;

// Открыть галерею товара (или модификации). onSaved — что обновить после сохранения.
async function openGallery(productId, { title = '', onSaved = null } = {}) {
  let g;
  try {
    g = await api(`/api/products/${productId}/gallery`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  gal.productId = productId;
  gal.title = title;
  gal.onSaved = onSaved;
  gal.preview = 0;
  gal.items = [
    ...(g.main ? [{ main: true, key: 'main', url: `/api/products/${productId}/photo?v=${g.photoAt}` }] : []),
    ...g.images.map((x) => ({ id: x.id, key: `i${x.id}`, url: `/api/products/${productId}/images/${x.id}?v=${x.created_at}` })),
  ];
  gal.start = galSig();
  $('#gal-sub').textContent = title;
  $('#gal-error').hidden = true;
  renderGallery();
  $('#gallery-dialog').showModal();
}

function renderGallery() {
  const n = gal.items.length;
  $('#gal-grid').innerHTML = n ? gal.items.map((x, i) => `
    <figure class="gal-tile ${i === 0 ? 'main' : ''}" draggable="true" data-gi="${i}">
      <img src="${x.url}" alt="Фото ${i + 1}">
      ${i === 0 ? '<span class="gal-badge">★ Основное</span>' : ''}
      ${x.id || x.main ? '' : '<span class="gal-badge new">новое</span>'}
      <figcaption>
        <button type="button" data-gal="left" data-gi="${i}" ${i ? '' : 'disabled'} title="Левее" aria-label="Левее">←</button>
        ${i ? `<button type="button" data-gal="main" data-gi="${i}" title="Сделать основным" aria-label="Сделать основным">★</button>` : ''}
        <button type="button" data-gal="right" data-gi="${i}" ${i < n - 1 ? '' : 'disabled'} title="Правее" aria-label="Правее">→</button>
        <button type="button" data-gal="del" data-gi="${i}" class="del" title="Удалить фото" aria-label="Удалить фото">✕</button>
      </figcaption>
    </figure>`).join('') : '<p class="empty">Фото пока нет. Нажмите «+ Добавить фото» — можно выбрать сразу несколько.</p>';
  $('#gal-count').textContent = `${n} из ${GALLERY_LIMIT}`;
  $('#gal-add').disabled = n >= GALLERY_LIMIT || gal.busy;
  $('#gal-save').disabled = gal.busy;
  $('#gal-state').textContent = galDirty() ? 'Есть несохранённые изменения' : '';
  // Предпросмотр: большое фото и миниатюры, как в окне товара на витрине.
  gal.preview = Math.min(gal.preview, Math.max(0, n - 1));
  $('#gp-main').innerHTML = n ? `<img src="${gal.items[gal.preview].url}" alt="">` : '<span>Нет фото</span>';
  $('#gp-thumbs').innerHTML = n > 1 ? gal.items.map((x, i) => `<button type="button" data-gp="${i}" aria-pressed="${i === gal.preview}"><img src="${x.url}" alt=""></button>`).join('') : '';
}

function galMove(from, to) {
  if (to < 0 || to >= gal.items.length || from === to) return;
  const [x] = gal.items.splice(from, 1);
  gal.items.splice(to, 0, x);
  gal.preview = to;
  renderGallery();
}

$('#gal-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gal]');
  if (!b) return;
  const i = Number(b.dataset.gi);
  if (b.dataset.gal === 'left') galMove(i, i - 1);
  else if (b.dataset.gal === 'right') galMove(i, i + 1);
  else if (b.dataset.gal === 'main') galMove(i, 0);
  else if (b.dataset.gal === 'del') {
    gal.items.splice(i, 1);
    renderGallery();
  }
});
// Перетаскивание (компьютер).
let galDrag = null;
$('#gal-grid').addEventListener('dragstart', (e) => {
  const t = e.target.closest('[data-gi]');
  if (!t) return;
  galDrag = Number(t.dataset.gi);
  e.dataTransfer.effectAllowed = 'move';
});
$('#gal-grid').addEventListener('dragover', (e) => { if (galDrag !== null) e.preventDefault(); });
$('#gal-grid').addEventListener('drop', (e) => {
  e.preventDefault();
  const t = e.target.closest('.gal-tile');
  if (t && galDrag !== null) galMove(galDrag, Number(t.dataset.gi));
  galDrag = null;
});
$('#gal-grid').addEventListener('dragend', () => { galDrag = null; });
$('#gp-thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gp]');
  if (!b) return;
  gal.preview = Number(b.dataset.gp);
  renderGallery();
});

// Добавить фото: несколько сразу; каждое уменьшается до 1600 px (JPEG) — так база не раздувается.
let galKey = 0;
$('#gal-add').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = [...input.files];
    const room = GALLERY_LIMIT - gal.items.length;
    if (files.length > room) toast(`Можно добавить ещё ${room} — лишние фото пропущены`, 'error');
    gal.busy = true;
    renderGallery();
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast(`${file.name}: подходят только JPEG, PNG и WebP`, 'error'); continue; }
      if (file.size > 30e6) { toast(`${file.name}: файл больше 30 МБ`, 'error'); continue; }
      try {
        const data = await shrinkPhoto(file, 1600);
        gal.items.push({ key: `n${++galKey}`, data, url: `data:image/jpeg;base64,${data}` });
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    gal.busy = false;
    renderGallery();
  });
  input.click();
});

$('#gal-save').addEventListener('click', async () => {
  if (!galDirty()) return $('#gallery-dialog').close();
  gal.busy = true;
  renderGallery();
  try {
    const items = gal.items.map((x) => (x.main ? { main: true } : x.id ? { id: x.id } : { data: x.data }));
    const g = await api(`/api/products/${gal.productId}/gallery`, { method: 'PUT', body: { items } });
    // Основное фото могло смениться — обновляем его метку в общем списке товаров.
    const listed = catalog.byId?.(gal.productId);
    if (listed) listed.photo_at = g.photoAt;
    gal.start = galSig();
    $('#gallery-dialog').close();
    toast(`Фото сохранены: ${(g.main ? 1 : 0) + g.images.length}`);
    gal.onSaved?.(g);
  } catch (err) {
    showFormError('#gal-error', err);
  } finally {
    gal.busy = false;
    if ($('#gallery-dialog').open) renderGallery();
  }
});
const galClose = () => {
  if (galDirty() && !confirm('Закрыть без сохранения? Изменения фото пропадут.')) return;
  gal.items = [];
  $('#gallery-dialog').close();
};
$('#gal-cancel').addEventListener('click', galClose);
$('#gal-close').addEventListener('click', galClose);
$('#gallery-dialog').addEventListener('cancel', (e) => { e.preventDefault(); galClose(); });
