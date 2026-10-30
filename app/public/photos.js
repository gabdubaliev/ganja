'use strict';

// Фото товаров в окне кассы: добавить, заменить, удалить.

const photosView = { query: '', missing: false };

async function renderPhotos() {
  try { await catalog.load(); } catch (err) { return toast(err.message, 'error'); }
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
    </div>`).join('') + (list.length > 120 ? `<p class="empty">Показаны первые 120 из ${list.length}. Уточните поиск.</p>` : '')
    : `<p class="empty">${catalog.list.length ? 'Ничего не нашлось' : 'Товаров пока нет'}</p>`;
}

$('#photos-grid').addEventListener('click', (e) => handlePhotoClick(e, renderPhotos));
$('#photos-search').addEventListener('input', (e) => { photosView.query = e.target.value; renderPhotos(); });
$('#photos-missing').addEventListener('change', (e) => { photosView.missing = e.target.checked; renderPhotos(); });

views.photos = { show: renderPhotos, right: 'photos' };
