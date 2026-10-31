'use strict';

// Фото товаров и категорий в окне кассы: добавить, заменить, удалить.

const photosView = { query: '', missing: false };

async function renderPhotos() {
  try { await Promise.all([catalog.load(), loadGalleryCounts()]); } catch (err) { return toast(err.message, 'error'); }
  const q = photosView.query.trim().toLowerCase();
  const list = catalog.list.filter((p) => (!photosView.missing || !p.photo_at)
    && (!q || p.name.toLowerCase().includes(q) || p.barcode.includes(q) || p.code.toLowerCase().includes(q)));
  const withPhoto = catalog.list.filter((p) => p.photo_at).length;
  $('#photos-summary').textContent = `С фото ${withPhoto} из ${catalog.list.length}`;
  $('#photos-grid').innerHTML = list.length ? list.slice(0, 120).map((p) => `
    <div class="photo-card">
      ${photoCell(p)}
      <div class="pname">${esc(p.name)}</div>
      <div class="pcat">${esc([p.code, p.barcode].filter(Boolean).join(' · ') || p.category || '')}</div>
      ${session.can('photos') && typeof openGallery === 'function' ? `<button type="button" class="link gal-open" data-gallery="${p.id}">🖼 Все фото товара</button>` : ''}
    </div>`).join('') + (list.length > 120 ? `<p class="empty">Показаны первые 120 из ${list.length}. Уточните поиск.</p>` : '')
    : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет'}</p>`;
}

/* ---------- Фото категорий ---------- */
async function renderCategoryPhotos() {
  let list;
  try { list = await api('/api/categories'); } catch (err) { return toast(err.message, 'error'); }
  $('#photos-cats').innerHTML = list.length ? list.map((c) => `
    <div class="photo-cat">
      <span class="thumb-wrap">
        <button type="button" class="cat-img big" data-cat-photo="${c.id}" title="${c.image_id ? 'Заменить фото' : 'Добавить фото'}">${c.image_id ? `<img src="/img/${c.image_id}" alt="">` : '<span aria-hidden="true">📷</span>'}</button>
        ${c.image_id ? `<button type="button" class="thumb-del" data-cat-photo-del="${c.id}" aria-label="Удалить фото ${esc(c.name)}">×</button>` : ''}
      </span>
      <div class="pname">${esc(c.name)}</div>
      <div class="pcat">${int(c.count)} ${plural(c.count, ['товар', 'товара', 'товаров'])}</div>
    </div>`).join('') : '<p class="empty">Категорий пока нет</p>';
}

$('#photos-cats').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-cat-photo]');
  const del = e.target.closest('[data-cat-photo-del]');
  try {
    if (add) {
      const file = await pickFile();
      if (!file) return;
      await api(`/api/categories/${add.dataset.catPhoto}/image`, { method: 'PUT', body: { mime: 'image/jpeg', data: await shrinkPhoto(file, 600) } });
      toast('Фото категории сохранено');
    } else if (del) {
      await api(`/api/categories/${del.dataset.catPhotoDel}/image`, { method: 'PUT', body: {} });
      toast('Фото категории удалено');
    } else return;
    renderCategoryPhotos();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#photos-grid').addEventListener('click', (e) => {
  const g = e.target.closest('[data-gallery]');
  if (g) return openGallery(Number(g.dataset.gallery), { title: catalog.byId(Number(g.dataset.gallery))?.name || '', onSaved: renderPhotos });
  handlePhotoClick(e, renderPhotos);
});
$('#photos-search').addEventListener('input', (e) => { photosView.query = e.target.value; renderPhotos(); });
$('#photos-missing').addEventListener('change', (e) => { photosView.missing = e.target.checked; renderPhotos(); });

views.photos = { show: () => { renderPhotos(); renderCategoryPhotos(); }, right: 'photos' };
