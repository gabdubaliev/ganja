'use strict';

// MONT AI Studio: съёмки товара → исходные фото → задание (промпт) для ChatGPT → результат обратно →
// сравнение с оригиналом → одобрение → в конец галереи товара. Платных API нет: в ChatGPT владелец работает сам,
// своей подпиской. Локальная обработка (кадр, поворот, формат, однотонный фон) — в ai-studio-editor.js.

const st = { meta: null, list: [], session: null, sessionId: null, filter: 'open', op: 'catalog', newProduct: null };
const STATUS_TASK = { prepared: 'подготовлено', sent: 'отправлено в ChatGPT', result: 'есть результат', retried: 'отклонено → новая попытка', done: 'в каталоге', cancelled: 'отменено' };
const STATUS_ASSET = { new: '', pending: 'на согласовании', approved: 'одобрено', rejected: 'отклонено', attached: 'в галерее товара' };
const studioFileUrl = (id) => `/api/studio/assets/${id}/file`;
const fmtKb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const when = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

document.querySelector('[data-view="studio"]').innerHTML = `
  <header class="top">
    <div class="title"><h1>🎨 MONT AI Studio</h1><span class="source" id="st-sub">Фото товаров: обработка на устройстве и задания для ChatGPT</span></div>
    <div class="tools" id="st-tools"></div>
  </header>
  <div id="st-body"></div>`;

document.body.insertAdjacentHTML('beforeend', `
<dialog id="st-new" class="st-dialog" aria-labelledby="st-new-title">
  <form method="dialog" id="st-new-form">
    <h2 id="st-new-title">Новая съёмка</h2>
    <p class="sub">Выберите товар из каталога — новый товар не создаётся. Фото потом можно добавить в галерею этого товара или его модификации.</p>
    <div class="field"><label for="st-new-q">Товар</label><input id="st-new-q" class="input" placeholder="Название, код или штрихкод" autocomplete="off"></div>
    <div class="st-pick" id="st-new-list"></div>
    <div class="field" id="st-new-variant-box" hidden><label for="st-new-variant">Модификация</label><select id="st-new-variant" class="input"></select></div>
    <div class="field"><label for="st-new-title-in">Название съёмки (необязательно)</label><input id="st-new-title-in" class="input" maxlength="120" placeholder="Например: куртка хаки, осень"></div>
    <p class="form-error" id="st-new-error" role="alert" hidden></p>
    <div class="form-actions"><button type="button" class="btn ghost" id="st-new-cancel">Отмена</button><button type="submit" class="btn primary" id="st-new-ok" disabled>Создать</button></div>
  </form>
</dialog>
<dialog id="st-compare" class="st-dialog wide" aria-labelledby="st-cmp-title">
  <div class="gal-head"><div><h2 id="st-cmp-title">Сравнение с оригиналом</h2><p class="sub" id="st-cmp-sub"></p></div><button type="button" class="icon-btn" data-close aria-label="Закрыть">×</button></div>
  <div class="st-cmp-tools">
    <div class="seg" role="group" id="st-cmp-mode"><button type="button" data-mode="side" aria-pressed="true">Рядом</button><button type="button" data-mode="overlay" aria-pressed="false">Наложение</button></div>
    <label class="check"><input type="checkbox" id="st-cmp-zoom"> Увеличить (1:1)</label>
    <select id="st-cmp-orig" class="input" aria-label="Оригинал для сравнения"></select>
  </div>
  <div class="st-cmp" id="st-cmp"></div>
  <input type="range" id="st-cmp-slider" min="0" max="100" value="50" hidden aria-label="Граница наложения">
  <p class="st-warn">Результат ChatGPT может отличаться от настоящей вещи. Одобряйте, только если всё совпадает с оригиналом — покупатель увидит именно это фото.</p>
  <div class="st-checklist" id="st-cmp-check"></div>
  <div class="field"><label for="st-cmp-note">Что не так (для отклонения — обязательно)</label><textarea id="st-cmp-note" class="input" rows="2" maxlength="500" placeholder="Например: цвет темнее оригинала, пропал левый нагрудный карман, логотип искажён"></textarea>
    <small class="sub">Чтобы отклонить, достаточно комментария — пункты выше отмечать не нужно. Отмеченные пункты новый промпт попросит сохранить, а комментарий станет исправлением в следующей попытке.</small></div>
  <p class="form-error" id="st-cmp-error" role="alert" hidden></p>
  <div class="form-actions">
    <button type="button" class="btn ghost" id="st-cmp-reject">Отклонить</button>
    <button type="button" class="btn primary" id="st-cmp-approve" disabled>Одобрить</button>
  </div>
</dialog>
<dialog id="st-attach" class="st-dialog" aria-labelledby="st-att-title">
  <h2 id="st-att-title">Добавить в галерею товара</h2>
  <div class="st-att-preview" id="st-att-preview"></div>
  <div class="field"><label for="st-att-target">Куда</label><select id="st-att-target" class="input"></select></div>
  <p class="sub" id="st-att-info"></p>
  <p class="st-ok">Фото добавится <b>в конец</b> галереи. Основное фото товара и остальные фото не изменятся.</p>
  <p class="form-error" id="st-att-error" role="alert" hidden></p>
  <div class="form-actions"><button type="button" class="btn ghost" data-close>Отмена</button><button type="button" class="btn primary" id="st-att-ok">Добавить</button></div>
</dialog>`);
for (const d of document.querySelectorAll('.st-dialog')) {
  d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close(); });
}

/* ---------- Список съёмок ---------- */
async function renderStudio() {
  try {
    st.meta ||= await api('/api/studio/meta');
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (st.sessionId) return openStudioSession(st.sessionId);
  $('#st-tools').innerHTML = `
    <div class="seg" role="group"><button type="button" data-st-filter="open" aria-pressed="${st.filter === 'open'}">В работе</button><button type="button" data-st-filter="all" aria-pressed="${st.filter === 'all'}">Все</button></div>
    <button type="button" class="btn primary" id="st-new-btn">+ Новая съёмка</button>`;
  try {
    st.list = await api(`/api/studio/sessions?status=${st.filter}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  $('#st-body').innerHTML = `
    <section class="panel st-intro">
      <b>Как это работает.</b> 1) Создайте съёмку товара и загрузите фото: спереди, сзади, детали, ткань, принт.
      2) Простое — кадр, поворот, формат 3:4 / 4:5 / 1:1, однотонный фон — делается прямо здесь, бесплатно.
      3) Для фона, каталожного фото, модели, рекламы и детальных фото программа готовит задание для ChatGPT:
      вы копируете его, прикладываете фото в ChatGPT и сохраняете результат. 4) Загружаете результат сюда, сравниваете с
      оригиналом и одобряете. 5) Одобренное фото добавляется в конец галереи товара — основное фото не меняется.
    </section>
    <section class="st-sessions">${st.list.length ? st.list.map((s) => `
      <button type="button" class="st-session-card" data-st-open="${s.id}">
        <span class="st-cover">${s.cover_id ? `<img src="${studioFileUrl(s.cover_id)}" alt="" loading="lazy">` : s.product?.photoAt ? `<img src="/api/products/${s.product.id}/photo?v=${s.product.photoAt}" alt="" loading="lazy">` : '📷'}</span>
        <span class="st-sc-body">
          <b>${esc(s.title || s.product?.name || 'Съёмка')}</b>
          <small>${esc(s.product?.name || '')}${s.product?.variant ? ` · ${esc(s.product.variant.label)}` : ''}${s.status === 'archived' ? ' · в архиве' : ''}</small>
          <small>${s.sources} фото${s.pending ? ` · <span class="st-chip warn">${s.pending} на согласовании</span>` : ''}${s.attached ? ` · ${s.attached} в каталоге` : ''} · ${when(s.updated_at)}</small>
        </span>
      </button>`).join('') : '<p class="empty">Съёмок пока нет. Нажмите «+ Новая съёмка» или кнопку «✨ AI Studio» в карточке товара.</p>'}</section>`;
  if (st.newProduct) { const id = st.newProduct; st.newProduct = null; openNewSession(id); }
}

$('[data-view="studio"]').addEventListener('click', (e) => {
  const f = e.target.closest('[data-st-filter]');
  if (f) { st.filter = f.dataset.stFilter; return renderStudio(); }
  if (e.target.closest('#st-new-btn')) return openNewSession();
  const o = e.target.closest('[data-st-open]');
  if (o) return openStudioSession(Number(o.dataset.stOpen));
  if (e.target.closest('#st-back')) { st.sessionId = null; st.session = null; return renderStudio(); }
});

/* ---------- Новая съёмка ---------- */
let stNewPick = null;
async function openNewSession(productId = null) {
  try { await catalog.load(); } catch (err) { return toast(err.message, 'error'); }
  stNewPick = null;
  $('#st-new-q').value = '';
  $('#st-new-title-in').value = '';
  $('#st-new-error').hidden = true;
  $('#st-new-variant-box').hidden = true;
  $('#st-new-ok').disabled = true;
  renderNewList();
  $('#st-new').showModal();
  if (productId) {
    const p = catalog.byId(productId);
    if (p) pickNewProduct(p.parent_id ? catalog.byId(p.parent_id) : p, p.parent_id ? p.id : null);
  } else $('#st-new-q').focus();
}
function renderNewList() {
  const q = $('#st-new-q').value.trim().toLowerCase();
  const list = catalog.list.filter((p) => !p.parent_id && !p.archived && (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.barcode || '').includes(q) || p.category.toLowerCase().includes(q))).slice(0, 30);
  $('#st-new-list').innerHTML = list.map((p) => `<button type="button" class="st-pick-row ${stNewPick?.id === p.id ? 'on' : ''}" data-st-pick="${p.id}">
    <span class="thumb">${p.photo_at ? `<img src="${photoUrl(p)}" alt="" loading="lazy">` : '📦'}</span><span>${esc(p.name)}<small>${esc([p.category, catalog.isGroup(p) ? `${catalog.children(p.id).length} модиф.` : ''].filter(Boolean).join(' · '))}</small></span></button>`).join('')
    || '<p class="empty">Ничего не найдено</p>';
}
// Расцветки товара по модификациям: [{ color, sizes }] — фото делается на цвет, а не на каждый размер.
function stColorsOf(kids) {
  const opts = (k) => { try { return JSON.parse(k.options || '{}'); } catch { return {}; } };
  const name = typeof detectColorOption === 'function' ? detectColorOption(kids.map(opts)) : null;
  if (!name) return [];
  const map = new Map();
  for (const k of kids) {
    const c = opts(k)[name];
    if (!c) continue;
    const sizes = map.get(c) || [];
    sizes.push(Object.entries(opts(k)).filter(([n]) => n !== name).map(([, v]) => v).join(', '));
    map.set(c, sizes);
  }
  return [...map.entries()].map(([color, sizes]) => ({ color, sizes: typeof sizeSort === 'function' ? sizeSort(sizes.filter(Boolean)) : sizes.filter(Boolean) }));
}
const stColorOption = (c, selected) => `<option value="c:${esc(c.color)}" ${selected ? 'selected' : ''}>${esc(c.color)}${c.sizes?.length ? ` — все размеры (${esc(c.sizes.join(', '))})` : ''}</option>`;
// Значение выбора: '' — весь товар, 'c:Цвет' — расцветка, число — отдельная модификация.
const stPickBody = (v) => (String(v).startsWith('c:') ? { color: String(v).slice(2), variantId: null } : { variantId: Number(v) || null, color: '' });

function pickNewProduct(p, variantId = null) {
  stNewPick = p;
  const kids = catalog.children(p.id);
  const colors = stColorsOf(kids);
  $('#st-new-variant-box').hidden = !kids.length;
  $('#st-new-variant-box label').textContent = colors.length ? 'Расцветка' : 'Модификация';
  const pre = variantId && colors.length ? (() => { const k = catalog.byId(variantId); return colors.find((c) => k && optionsText(k).includes(c.color)); })() : null;
  $('#st-new-variant').innerHTML = '<option value="">Весь товар</option>' + (colors.length
    ? colors.map((c) => stColorOption(c, pre === c)).join('')
    : kids.map((k) => `<option value="${k.id}" ${k.id === variantId ? 'selected' : ''}>${esc(optionsText(k) || k.name)}</option>`).join(''));
  $('#st-new-q').value = p.name;
  $('#st-new-ok').disabled = false;
  renderNewList();
}
$('#st-new-q').addEventListener('input', () => { stNewPick = null; $('#st-new-ok').disabled = true; $('#st-new-variant-box').hidden = true; renderNewList(); });
$('#st-new-list').addEventListener('click', (e) => { const b = e.target.closest('[data-st-pick]'); if (b) pickNewProduct(catalog.byId(Number(b.dataset.stPick))); });
$('#st-new-cancel').addEventListener('click', () => $('#st-new').close());
$('#st-new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!stNewPick) return;
  try {
    const s = await api('/api/studio/sessions', { method: 'POST', body: { productId: stNewPick.id, ...stPickBody($('#st-new-variant').value), title: $('#st-new-title-in').value } });
    $('#st-new').close();
    openStudioSession(s.id, s);
  } catch (err) {
    showFormError('#st-new-error', err);
  }
});

/* ---------- Съёмка ---------- */
async function openStudioSession(id, preloaded = null) {
  try {
    st.session = preloaded || await api(`/api/studio/sessions/${id}`);
  } catch (err) {
    st.sessionId = null;
    toast(err.message, 'error');
    return renderStudio();
  }
  st.sessionId = st.session.id;
  renderSession();
}
const reloadSession = () => openStudioSession(st.sessionId);

function assetTile(a, extra = '') {
  const parent = a.parentId ? ` · из фото №${a.parentId}` : '';
  return `<figure class="st-tile ${a.status}" data-asset="${a.id}">
    <button type="button" class="st-img" data-st-view="${a.id}" title="Открыть крупно"><img src="${studioFileUrl(a.id)}" alt="Фото №${a.id}" loading="lazy"></button>
    <figcaption>
      <small>№${a.id} · ${a.width || '?'}×${a.height || '?'} · ${fmtKb(a.bytes)}${parent}</small>
      ${a.kind !== 'source' && STATUS_ASSET[a.status] ? `<span class="st-chip ${a.status}">${STATUS_ASSET[a.status]}</span>` : ''}
      ${extra}
    </figcaption>
  </figure>`;
}

function renderSession() {
  const s = st.session;
  const m = st.meta;
  const p = s.product;
  const sources = s.assets.filter((a) => a.kind === 'source');
  const edits = s.assets.filter((a) => a.kind === 'edit');
  const results = s.assets.filter((a) => a.kind === 'result');
  const variant = p.variants?.find((v) => v.id === s.variant_id);
  $('#st-sub').textContent = `${p.name}${s.color ? ` · ${s.color} (все размеры)` : variant ? ` · ${variant.label}` : ''}`;
  $('#st-tools').innerHTML = `<button type="button" class="btn" id="st-back">← Все съёмки</button>
    <button type="button" class="btn ghost" id="st-archive">${s.status === 'archived' ? 'Вернуть в работу' : 'В архив'}</button>
    <button type="button" class="btn ghost danger" id="st-delete">Удалить</button>`;
  const roleSelect = (a) => `<select class="input small" data-st-role="${a.id}" aria-label="Что на фото">${Object.entries(m.roles).map(([k, v]) => `<option value="${k}" ${a.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const pickable = [...sources, ...edits.filter((e) => e.status !== 'rejected')];
  $('#st-body').innerHTML = `
    ${p.deleted ? '<p class="st-warn">Товар удалён из каталога — добавлять фото в галерею нельзя.</p>' : ''}
    <section class="panel st-head">
      <span class="thumb big">${p.photoAt ? `<img src="/api/products/${p.id}/photo?v=${p.photoAt}" alt="">` : '📦'}</span>
      <div class="st-head-body">
        <input class="input st-title-in" id="st-title" value="${esc(s.title)}" placeholder="Название съёмки" maxlength="120">
        <div class="st-head-line"><b>${esc(p.name)}</b>${p.category ? ` · ${esc(p.category)}` : ''} · основное фото и галерея товара меняются только вами, по кнопке «Добавить в галерею»</div>
        ${p.colors?.length ? `<label class="st-head-line">Расцветка: <select class="input small" id="st-variant"><option value="">Весь товар</option>${p.colors.map((c) => stColorOption(c, c.color === s.color)).join('')}${!s.color && s.variant_id ? `<option value="${s.variant_id}" selected>${esc(variant?.label || 'модификация')}</option>` : ''}</select> <small>(цвет попадёт в задание; фото — для всех размеров этого цвета)</small></label>`
          : p.variants?.length ? `<label class="st-head-line">Модификация: <select class="input small" id="st-variant"><option value="">Весь товар</option>${p.variants.map((v) => `<option value="${v.id}" ${v.id === s.variant_id ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select> <small>(свойства попадут в задание)</small></label>` : ''}
      </div>
    </section>

    <section class="panel">
      <div class="st-sec-head"><h2>1. Исходные фото <small>${sources.length}</small></h2>
        <div class="st-upload"><select class="input small" id="st-up-role" aria-label="Что на загружаемых фото">${Object.entries(m.roles).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button type="button" class="btn primary" id="st-up">+ Загрузить фото</button></div></div>
      <p class="sub">Оригиналы хранятся без изменений. Обработка создаёт новое фото рядом.</p>
      <div class="st-grid">${sources.map((a) => assetTile(a, `${roleSelect(a)}<span class="st-acts">
        <button type="button" class="btn small" data-st-edit="${a.id}">✂ Обработать</button>
        <button type="button" class="btn small ghost" data-st-dl="${a.id}" title="Скачать">⬇</button>
        <button type="button" class="btn small ghost" data-st-del="${a.id}" title="Удалить">✕</button></span>`)).join('') || '<p class="empty">Загрузите фото товара: спереди, сзади, детали, ткань, принт.</p>'}</div>
      ${edits.length ? `<h3>Обработанные здесь <small>${edits.length}</small></h3><div class="st-grid">${edits.map((a) => assetTile(a, `<span class="st-acts">
        ${a.status === 'pending' ? `<button type="button" class="btn small primary" data-st-ok-edit="${a.id}">Одобрить</button>` : ''}
        ${a.status === 'approved' && m.canAttach && !p.deleted ? `<button type="button" class="btn small primary" data-st-attach="${a.id}">В галерею товара</button>` : ''}
        ${a.status === 'attached' ? `<small>в галерее (фото №${a.attached.imageId})</small>` : ''}
        <button type="button" class="btn small ghost" data-st-dl="${a.id}" title="Скачать">⬇</button>
        ${a.status !== 'attached' ? `<button type="button" class="btn small ghost" data-st-del="${a.id}" title="Удалить">✕</button>` : ''}</span>`)).join('')}</div>` : ''}
    </section>

    <section class="panel">
      <h2>2. Задание для ChatGPT</h2>
      <div class="st-ops" role="radiogroup">${Object.entries(m.operations).map(([k, v]) => `<button type="button" class="st-op" role="radio" data-st-op="${k}" aria-checked="${st.op === k}"><span>${{ background: '🧼', catalog: '🗂', model: '🧍', ad: '📣', details: '🔍' }[k]}</span>${v}</button>`).join('')}</div>
      <div id="st-op-form"></div>
      <div class="field"><label>Фото для задания (прикладываете их в ChatGPT)</label>
        <div class="st-src-pick">${pickable.map((a) => `<label class="st-src"><input type="checkbox" value="${a.id}" ${a.kind === 'source' ? 'checked' : ''}><img src="${studioFileUrl(a.id)}" alt=""><small>№${a.id} ${a.kind === 'edit' ? 'обработка' : esc(m.roles[a.role] || '')}</small></label>`).join('') || '<span class="sub">Сначала загрузите фото.</span>'}</div></div>
      <div class="form-actions start"><button type="button" class="btn primary" id="st-make-task" ${pickable.length ? '' : 'disabled'}>Подготовить промпт</button></div>
    </section>

    <section class="panel">
      <h2>3. Задания и результаты <small>${s.tasks.length}</small></h2>
      ${s.tasks.length ? s.tasks.map((t) => taskCard(t, results.filter((r) => r.taskId === t.id))).join('') : '<p class="empty">Заданий пока нет.</p>'}
    </section>

    <section class="panel"><details><summary><h2 class="inline">История <small>${s.history.length}</small></h2></summary>
      <ul class="st-history">${s.history.map((h) => `<li><time>${when(h.at)}</time> <b>${esc(h.action)}</b>${h.details ? ` — ${esc(h.details)}` : ''}${h.user ? ` <small>(${esc(h.user)})</small>` : ''}</li>`).join('')}</ul></details></section>`;
  renderOpForm();
}

function taskCard(t, results) {
  const m = st.meta;
  const canShare = typeof navigator.canShare === 'function';
  return `<article class="st-task ${t.status}" data-task="${t.id}">
    <header><b>№${t.id} · ${esc(t.operationName)}${t.attempt > 1 ? ` · попытка ${t.attempt}` : ''}</b> <span class="st-chip ${t.status}">${STATUS_TASK[t.status] || t.status}</span> <small>${when(t.createdAt)} · фото: ${t.sourceIds.map((x) => `№${x}`).join(', ')}${t.attempt > 1 ? ` · повтор задания №${t.rootId}` : ''}</small></header>
    ${t.notes?.length ? `<div class="st-retry-notes"><b>Замечания по прошлым попыткам (вошли в новый промпт):</b><ol>${t.notes.map((n) => `<li>${esc(n.note)} <small>— попытка ${n.attempt}, результат №${n.result_id}${n.reviewed_by ? `, ${esc(n.reviewed_by)}` : ''}</small></li>`).join('')}</ol>
      ${t.keepOk?.length ? `<small>Сохранить, что было верно: ${t.keepOk.map(esc).join('; ')}</small>` : ''}</div>` : ''}
    ${t.status === 'cancelled' ? `<div class="st-acts"><button type="button" class="btn small" data-st-reopen="${t.id}">Вернуть задание</button></div>` : `
    <ol class="st-steps">
      <li><button type="button" class="btn small primary" data-st-copy="${t.id}">📋 Копировать ${t.attempt > 1 ? 'новый ' : ''}промпт</button>
        ${t.followup ? `<button type="button" class="btn small" data-st-followup="${t.id}" title="Если продолжаете в том же чате ChatGPT">💬 Поправка для того же чата</button>` : ''}</li>
      <li><button type="button" class="btn small" data-st-dlsrc="${t.id}">⬇ Скачать фото (${t.sourceIds.length})</button>
        ${t.prevResultId ? `<button type="button" class="btn small ghost" data-st-dl="${t.prevResultId}" title="Необязательно: приложите, чтобы ChatGPT видел, что исправить">⬇ Прошлый результат</button>` : ''}
        ${canShare ? `<button type="button" class="btn small" data-st-share="${t.id}">📤 Поделиться в ChatGPT…</button>` : ''}</li>
      <li><button type="button" class="btn small" data-st-chatgpt="${t.id}">↗ Открыть ChatGPT</button> <small>приложите фото, вставьте промпт, отправьте; готовую картинку сохраните на устройство</small></li>
      <li><button type="button" class="btn small primary" data-st-result="${t.id}">⬆ Загрузить результат</button></li>
    </ol>
    <details class="st-prompt"><summary>Текст задания (можно поправить)</summary>
      <textarea class="input code" rows="12" data-st-prompt="${t.id}" spellcheck="false">${esc(t.prompt)}</textarea>
      <div class="st-acts"><button type="button" class="btn small" data-st-save-prompt="${t.id}">Сохранить текст</button>
      <button type="button" class="btn small ghost" data-st-cancel="${t.id}">Отменить задание</button></div>
    </details>`}
    ${results.length ? `<div class="st-grid">${results.map((a) => assetTile(a, `<span class="st-acts">
      ${['pending', 'rejected', 'approved'].includes(a.status) ? `<button type="button" class="btn small ${a.status === 'pending' ? 'primary' : ''}" data-st-compare="${a.id}">Сравнить${a.status === 'pending' ? ' и согласовать' : ''}</button>` : ''}
      ${a.status === 'approved' && m.canAttach && !st.session.product.deleted ? `<button type="button" class="btn small primary" data-st-attach="${a.id}">В галерею товара</button>` : ''}
      ${a.status === 'attached' ? `<small>в галерее (фото №${a.attached.imageId})</small>` : ''}
      ${a.reviewNote ? `<small class="st-note">«${esc(a.reviewNote)}»</small>` : ''}
      ${a.status === 'rejected' ? (() => { const next = st.session.tasks.find((x) => x.prevResultId === a.id && x.status !== 'cancelled'); return next
        ? `<button type="button" class="btn small" data-st-goto-task="${next.id}">→ Попытка ${next.attempt} (задание №${next.id})</button>`
        : `<button type="button" class="btn small primary" data-st-retry="${a.id}">🔁 Повторить генерацию</button>`; })() : ''}
      <button type="button" class="btn small ghost" data-st-dl="${a.id}" title="Скачать">⬇</button>
      ${a.status !== 'attached' ? `<button type="button" class="btn small ghost" data-st-del="${a.id}" title="Удалить">✕</button>` : ''}</span>`)).join('')}</div>` : ''}
  </article>`;
}

// Параметры операции: фон, формат, модель, площадка, деталь.
function renderOpForm() {
  const m = st.meta;
  const opt = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  const bg = (def) => `<div class="field"><label>Фон</label><select class="input" name="background">${opt(m.backgrounds, def)}<option value="custom">Свой цвет…</option></select></div>
    <div class="field" data-custom-bg hidden><label>Цвет фона</label><input type="color" name="bgColor" value="#ffffff"></div>`;
  const aspect = (def) => `<div class="field"><label>Формат</label><select class="input" name="aspect">${opt(m.aspects, def)}</select></div>`;
  const note = '<div class="field wide"><label>Дополнительно (необязательно)</label><input class="input" name="note" maxlength="400" placeholder="Например: без складок на рукавах"></div>';
  const f = {
    background: `<p class="st-tip">Ровный однотонный фон часто можно сделать здесь же, бесплатно: «✂ Обработать» → «Однотонный фон». Это заливка ровного фона от краёв кадра, а не вырезание контура — для сложного фона нужен ChatGPT.</p>${bg('white')}${aspect('3:4')}${note}`,
    catalog: `${bg('white')}${aspect('1:1')}${note}`,
    model: `<p class="st-tip">Модель — вымышленный человек. Промпт требует сохранить цвет, ткань, крой, длину, карманы, пуговицы, швы, принты и логотипы — но проверка результата всё равно обязательна.</p>
      <div class="field"><label>Модель</label><select class="input" name="gender">${opt(m.genders, 'male')}</select></div>
      <div class="field"><label>Возраст</label><select class="input" name="age">${opt(m.ages, '25-35')}</select></div>
      <div class="field"><label>Телосложение</label><select class="input" name="build">${opt(m.builds, 'regular')}</select></div>
      <div class="field"><label>Поза</label><select class="input" name="pose">${opt(m.poses, 'standing')}</select></div>
      <div class="field"><label>Место</label><select class="input" name="setting">${opt(m.settings, 'studio')}</select></div>
      ${bg('light')}${aspect('1:1')}${note}`,
    ad: `<div class="field"><label>Площадка</label><select class="input" name="platform">${Object.entries(m.platforms).map(([k, v]) => `<option value="${k}">${v.label} (${v.aspect})</option>`).join('')}</select></div>
      <div class="field"><label>Стиль</label><select class="input" name="style">${opt(m.adStyles, 'minimal')}</select></div>
      <div class="field"><label>Заголовок на картинке</label><input class="input" name="headline" maxlength="60" placeholder="Пусто — без текста"></div>
      <div class="field"><label>Цена на картинке</label><input class="input" name="price" maxlength="30" placeholder="${st.session.product.price ? `${st.session.product.price} сом` : 'Пусто — без цены'}"></div>
      <label class="check"><input type="checkbox" name="withModel"> На модели</label>${bg('light')}${note}`,
    details: `<p class="st-tip">Самое честное детальное фото — крупный план, вырезанный из оригинала: «✂ Обработать» → увеличьте и сдвиньте кадр на деталь. Ничего не дорисовывается. ChatGPT нужен, только если надо улучшить свет и чёткость — промпт запрещает менять и придумывать детали.</p>
      <div class="field"><label>Что показать крупно</label><select class="input" name="detail">${opt(m.details, 'fabric')}</select></div>${bg('white')}${aspect('1:1')}${note}`,
  }[st.op];
  $('#st-op-form').innerHTML = `<div class="form-grid st-op-grid">${f}</div>`;
}

function opParams() {
  const out = {};
  for (const el of $('#st-op-form').querySelectorAll('[name]')) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (out.background === 'custom') { out.background = ''; } else delete out.bgColor;
  return out;
}

/* ---------- Действия в съёмке ---------- */
const findAsset = (id) => st.session.assets.find((a) => a.id === Number(id));
const findTask = (id) => st.session.tasks.find((t) => t.id === Number(id));
async function fetchBlob(id) {
  const r = await fetch(studioFileUrl(id));
  if (!r.ok) throw new Error('Файл не скачался');
  return r.blob();
}
const extOf = (mime) => ({ 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const assetName = (a) => `mont-${st.session.id}-${a.id}${a.role ? `-${a.role}` : ''}.${extOf(a.mime)}`;

// Копирование: Clipboard API (нужен https или localhost), иначе — через выделение текста.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
const taskEvent = (id, body) => api(`/api/studio/tasks/${id}`, { method: 'PUT', body }).catch(() => null);

// Загрузка фото: оригинал как есть (JPEG/PNG/WebP до 8 МБ), иначе — уменьшенная копия в JPEG.
async function prepareUpload(file) {
  const okType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (okType && file.size <= 8e6) return { data: await fileBase64(file), note: '' };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`${file.name}: не удалось открыть — возможно, формат HEIC. Сохраните фото как JPEG и загрузите снова.`); }
  const scale = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.92; let blob;
  do { blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); q -= 0.08; } while (blob.size > 8e6 && q > 0.5);
  return { data: await fileBase64(blob), note: 'уменьшена копия (оригинал был больше 8 МБ или в другом формате)' };
}
function pickImages(multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}
async function uploadAssets(files, body) {
  let n = 0;
  for (const file of files) {
    try {
      const { data, note } = await prepareUpload(file);
      await api(`/api/studio/sessions/${st.session.id}/assets`, { method: 'POST', body: { ...body, data, meta: { fileName: file.name, note } } });
      n++;
      if (note) toast(`${file.name}: ${note}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  return n;
}

// Для галереи: JPEG до 2048 px и до 3 МБ (прозрачность заливается белым).
async function galleryJpeg(id) {
  const bmp = await createImageBitmap(await fetchBlob(id));
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.9; let blob;
  do { blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); q -= 0.1; } while (blob.size > 2.9e6 && q > 0.4);
  return fileBase64(blob);
}

$('[data-view="studio"]').addEventListener('change', async (e) => {
  const role = e.target.closest('[data-st-role]');
  if (role) {
    try { await api(`/api/studio/assets/${role.dataset.stRole}`, { method: 'PUT', body: { role: role.value } }); toast('Сохранено'); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (e.target.id === 'st-variant') {
    try { st.session = await api(`/api/studio/sessions/${st.session.id}`, { method: 'PUT', body: stPickBody(e.target.value) }); renderSession(); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (e.target.id === 'st-title') {
    try { await api(`/api/studio/sessions/${st.session.id}`, { method: 'PUT', body: { title: e.target.value } }); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (e.target.name === 'background') {
    const box = $('#st-op-form [data-custom-bg]');
    if (box) box.hidden = e.target.value !== 'custom';
  }
});

$('[data-view="studio"]').addEventListener('click', async (e) => {
  if (!st.session) return;
  const b = (sel) => e.target.closest(sel);
  let x;
  try {
    if ((x = b('#st-delete'))) {
      const files = st.session.assets.length;
      const kept = st.session.assets.filter((a) => a.attached).length;
      if (!confirm(`Удалить навсегда? Файл нельзя будет восстановить.\n\nБудут удалены: фото и результаты съёмки (${files}), задания (${st.session.tasks.length}) и история.${kept ? `\nФото, уже добавленные в галерею товаров (${kept}), останутся в каталоге.` : ''}`)) return;
      x.disabled = true;
      try {
        const r = await api(`/api/studio/sessions/${st.session.id}`, { method: 'DELETE' });
        st.sessionId = null;
        st.session = null;
        toast(`Съёмка удалена навсегда: файлов ${r.files}, заданий ${r.tasks}${r.attachedKept ? `; в каталоге осталось фото: ${r.attachedKept}` : ''}`);
        return renderStudio();
      } catch (err) {
        x.disabled = false;
        throw err;
      }
    }
    if (b('#st-archive')) {
      st.session = await api(`/api/studio/sessions/${st.session.id}`, { method: 'PUT', body: { status: st.session.status === 'archived' ? 'open' : 'archived' } });
      return renderSession();
    }
    if (b('#st-up')) {
      const files = await pickImages(true);
      if (!files.length) return;
      const n = await uploadAssets(files, { kind: 'source', role: $('#st-up-role').value });
      if (n) toast(`Загружено фото: ${n}`);
      return reloadSession();
    }
    if ((x = b('[data-st-op]'))) { st.op = x.dataset.stOp; for (const o of document.querySelectorAll('[data-st-op]')) o.setAttribute('aria-checked', String(o === x)); return renderOpForm(); }
    if (b('#st-make-task')) {
      const sourceIds = [...document.querySelectorAll('.st-src-pick input:checked')].map((i) => Number(i.value));
      const t = await api(`/api/studio/sessions/${st.session.id}/tasks`, { method: 'POST', body: { operation: st.op, params: opParams(), sourceIds } });
      toast('Промпт готов — дальше по шагам в карточке задания');
      await reloadSession();
      document.querySelector(`[data-task="${t.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if ((x = b('[data-st-copy]'))) {
      const t = findTask(x.dataset.stCopy);
      const text = document.querySelector(`[data-st-prompt="${t.id}"]`)?.value || t.prompt;
      if (await copyText(text)) { toast('Промпт скопирован — вставьте его в ChatGPT'); await taskEvent(t.id, { status: 'sent', event: 'copied' }); }
      else { document.querySelector(`[data-task="${t.id}"] details`).open = true; toast('Не получилось скопировать автоматически — выделите текст задания и скопируйте вручную', 'error'); }
      return;
    }
    if ((x = b('[data-st-followup]'))) {
      const t = findTask(x.dataset.stFollowup);
      if (await copyText(t.followup)) { toast('Поправка скопирована — вставьте её в тот же чат ChatGPT'); await taskEvent(t.id, { status: 'sent', event: 'copied' }); }
      else toast('Не получилось скопировать — откройте текст задания и скопируйте вручную', 'error');
      return;
    }
    if ((x = b('[data-st-retry]'))) {
      const t = await api(`/api/studio/assets/${x.dataset.stRetry}/retry`, { method: 'POST' });
      toast(`Новый промпт готов — попытка ${t.attempt}`);
      await reloadSession();
      return showTask(t.id);
    }
    if ((x = b('[data-st-goto-task]'))) return showTask(Number(x.dataset.stGotoTask));
    if ((x = b('[data-st-dlsrc]'))) {
      const t = findTask(x.dataset.stDlsrc);
      for (const id of t.sourceIds) { const a = findAsset(id); if (a) saveBlob(await fetchBlob(id), assetName(a)); }
      toast(`Скачано фото: ${t.sourceIds.length}. Приложите их в ChatGPT.`);
      await taskEvent(t.id, { event: 'downloaded' });
      return;
    }
    if ((x = b('[data-st-share]'))) {
      const t = findTask(x.dataset.stShare);
      const text = document.querySelector(`[data-st-prompt="${t.id}"]`)?.value || t.prompt;
      const files = [];
      for (const id of t.sourceIds) { const a = findAsset(id); if (a) files.push(new File([await fetchBlob(id)], assetName(a), { type: a.mime })); }
      if (!navigator.canShare?.({ files })) return toast('Это устройство не умеет отправлять фото через «Поделиться». Скачайте фото и откройте ChatGPT.', 'error');
      await copyText(text);
      try {
        await navigator.share({ files, text });
        toast('Если текст не подставился в ChatGPT — вставьте его: он скопирован');
        await taskEvent(t.id, { status: 'sent', event: 'shared' });
      } catch (err) {
        if (err.name !== 'AbortError') toast(`«Поделиться» не сработало: ${err.message}. Скачайте фото и откройте ChatGPT.`, 'error');
      }
      return;
    }
    if ((x = b('[data-st-chatgpt]'))) {
      window.open('https://chatgpt.com/', '_blank', 'noopener');
      await taskEvent(x.dataset.stChatgpt, { event: 'opened' });
      return;
    }
    if ((x = b('[data-st-result]'))) {
      const files = await pickImages(false);
      if (!files.length) return;
      if (await uploadAssets(files, { kind: 'result', taskId: Number(x.dataset.stResult) })) toast('Результат загружен — сравните его с оригиналом');
      await reloadSession();
      const last = st.session.assets.filter((a) => a.kind === 'result').at(-1);
      if (last) openCompare(last.id);
      return;
    }
    if ((x = b('[data-st-save-prompt]'))) {
      const id = x.dataset.stSavePrompt;
      await api(`/api/studio/tasks/${id}`, { method: 'PUT', body: { prompt: document.querySelector(`[data-st-prompt="${id}"]`).value } });
      toast('Текст задания сохранён');
      return reloadSession();
    }
    if ((x = b('[data-st-cancel]'))) {
      if (!confirm('Отменить задание? Его результаты останутся в съёмке.')) return;
      await api(`/api/studio/tasks/${x.dataset.stCancel}`, { method: 'PUT', body: { status: 'cancelled' } });
      return reloadSession();
    }
    if ((x = b('[data-st-reopen]'))) { await api(`/api/studio/tasks/${x.dataset.stReopen}`, { method: 'PUT', body: { status: 'reopen' } }); return reloadSession(); }
    if ((x = b('[data-st-dl]'))) { const a = findAsset(x.dataset.stDl); return saveBlob(await fetchBlob(a.id), assetName(a)); }
    if ((x = b('[data-st-view]'))) return window.open(studioFileUrl(x.dataset.stView), '_blank', 'noopener');
    if ((x = b('[data-st-del]'))) {
      if (!confirm('Удалить этот файл из съёмки? Галерея товара не изменится.')) return;
      await api(`/api/studio/assets/${x.dataset.stDel}`, { method: 'DELETE' });
      return reloadSession();
    }
    if ((x = b('[data-st-edit]'))) return openStudioEditor(findAsset(x.dataset.stEdit), st.session, reloadSession);
    if ((x = b('[data-st-ok-edit]'))) {
      await api(`/api/studio/assets/${x.dataset.stOkEdit}/review`, { method: 'POST', body: { decision: 'approved' } });
      toast('Обработка одобрена');
      return reloadSession();
    }
    if ((x = b('[data-st-compare]'))) return openCompare(Number(x.dataset.stCompare));
    if ((x = b('[data-st-attach]'))) return openAttach(Number(x.dataset.stAttach));
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ---------- Сравнение и согласование ---------- */
let cmp = null;
function openCompare(id) {
  const a = findAsset(id);
  const t = findTask(a.taskId);
  const origs = (t?.sourceIds || []).map(findAsset).filter(Boolean);
  if (!origs.length) origs.push(...st.session.assets.filter((x) => x.kind === 'source').slice(0, 1));
  cmp = { a, origId: origs[0]?.id, mode: 'side' };
  $('#st-cmp-sub').textContent = `Результат №${a.id}${t ? ` · задание №${t.id}: ${t.operationName}` : ''}`;
  $('#st-cmp-orig').innerHTML = origs.map((o) => `<option value="${o.id}">Оригинал №${o.id} — ${esc(st.meta.roles[o.role] || 'обработка')}</option>`).join('');
  const locked = a.status === 'attached';
  $('#st-cmp-check').innerHTML = `<b>Сравните с оригиналом и отметьте, что совпадает:</b>` + Object.entries(st.meta.checklist).map(([k, v]) => `<label class="check"><input type="checkbox" data-chk="${k}" ${a.checklist?.[k] ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${v}</label>`).join('');
  $('#st-cmp-note').value = a.reviewNote || '';
  $('#st-cmp-error').hidden = true;
  $('#st-cmp-zoom').checked = false;
  $('#st-cmp-approve').hidden = locked;
  $('#st-cmp-reject').hidden = locked;
  renderCompare();
  syncApprove();
  $('#st-compare').showModal();
}
function renderCompare() {
  const zoom = $('#st-cmp-zoom').checked;
  $('#st-cmp').className = `st-cmp ${cmp.mode} ${zoom ? 'zoom' : ''}`;
  for (const btn of document.querySelectorAll('#st-cmp-mode [data-mode]')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === cmp.mode));
  $('#st-cmp-slider').hidden = cmp.mode !== 'overlay';
  $('#st-cmp').innerHTML = cmp.mode === 'side'
    ? `<figure><figcaption>Оригинал</figcaption><img src="${studioFileUrl(cmp.origId)}" alt="Оригинал"></figure><figure><figcaption>Результат</figcaption><img src="${studioFileUrl(cmp.a.id)}" alt="Результат"></figure>`
    : `<div class="st-overlay"><img src="${studioFileUrl(cmp.origId)}" alt="Оригинал"><img class="top" src="${studioFileUrl(cmp.a.id)}" alt="Результат" style="clip-path: inset(0 0 0 ${$('#st-cmp-slider').value}%)"><span class="lbl l">Оригинал</span><span class="lbl r">Результат</span></div>`;
}
const syncApprove = () => {
  const all = [...document.querySelectorAll('#st-cmp-check [data-chk]')].every((c) => c.checked);
  $('#st-cmp-approve').disabled = !all;
  $('#st-cmp-approve').title = all ? '' : 'Сначала отметьте все пункты сравнения';
};
$('#st-cmp-check').addEventListener('change', syncApprove);
$('#st-cmp-mode').addEventListener('click', (e) => { const m = e.target.closest('[data-mode]'); if (m) { cmp.mode = m.dataset.mode; renderCompare(); } });
$('#st-cmp-zoom').addEventListener('change', renderCompare);
$('#st-cmp-orig').addEventListener('change', (e) => { cmp.origId = Number(e.target.value); renderCompare(); });
$('#st-cmp-slider').addEventListener('input', (e) => { const top = $('#st-cmp .top'); if (top) top.style.clipPath = `inset(0 0 0 ${e.target.value}%)`; });
async function sendReview(decision) {
  const checklist = Object.fromEntries([...document.querySelectorAll('#st-cmp-check [data-chk]')].map((c) => [c.dataset.chk, c.checked]));
  if (decision === 'rejected' && !$('#st-cmp-note').value.trim()) {
    $('#st-cmp-note').focus();
    return showFormError('#st-cmp-error', new Error('Напишите, что не так — по этому комментарию составится новый промпт. Пункты отмечать не нужно.'));
  }
  try {
    const r = await api(`/api/studio/assets/${cmp.a.id}/review`, { method: 'POST', body: { decision, checklist, note: $('#st-cmp-note').value } });
    $('#st-compare').close();
    if (decision === 'rejected' && r.retryTask) {
      toast(`Отклонено. Готов новый промпт — попытка ${r.retryTask.attempt}: скопируйте его и снова откройте ChatGPT`);
      await reloadSession();
      return showTask(r.retryTask.id);
    }
    toast(decision === 'approved' ? 'Одобрено — теперь можно добавить в галерею товара' : 'Отклонено');
    reloadSession();
  } catch (err) {
    showFormError('#st-cmp-error', err);
  }
}
// Показать задание: прокрутить к нему и подсветить.
function showTask(id) {
  const card = document.querySelector(`[data-task="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2500);
}
$('#st-cmp-approve').addEventListener('click', () => sendReview('approved'));
$('#st-cmp-reject').addEventListener('click', () => sendReview('rejected'));

/* ---------- В галерею товара ---------- */
let attachId = null;
function openAttach(id) {
  const a = findAsset(id);
  const p = st.session.product;
  attachId = id;
  $('#st-att-preview').innerHTML = `<img src="${studioFileUrl(a.id)}" alt="">`;
  // Цели: весь товар и расцветки (фото видно для всех размеров цвета); без цветов — модификации по отдельности.
  const s = st.session;
  const targets = [{ value: String(p.id), label: `${p.name} — весь товар`, gallery: p.gallery, on: !s.color && !s.variant_id },
    ...(p.colors?.length
      ? p.colors.map((c) => ({ value: `c:${c.color}`, label: `${p.name} · ${c.color} — все размеры${c.sizes?.length ? ` (${c.sizes.join(', ')})` : ''}`, gallery: c.gallery, on: s.color === c.color }))
      : (p.variants || []).map((v) => ({ value: String(v.id), label: `${p.name} · ${v.label}`, gallery: v.gallery, on: v.id === s.variant_id })))];
  if (p.colors?.length && !s.color && s.variant_id) { const v = p.variants.find((x) => x.id === s.variant_id); if (v) targets.push({ value: String(v.id), label: `${p.name} · ${v.label} (только эта модификация)`, gallery: v.gallery, on: true }); }
  $('#st-att-target').innerHTML = targets.map((t) => `<option value="${esc(t.value)}" ${t.on ? 'selected' : ''}>${esc(t.label)} (доп. фото: ${t.gallery}/12)</option>`).join('');
  $('#st-att-info').textContent = p.colors?.length
    ? 'Фото расцветки увидят покупатели на витрине при любом размере этого цвета. Сделать его основным можно потом в окне «Фото товара».'
    : 'В карточке товара на витрине фото появится среди дополнительных. Сделать его основным можно потом в окне «Фото товара».';
  $('#st-att-error').hidden = true;
  $('#st-att-ok').disabled = false;
  $('#st-attach').showModal();
}
$('#st-att-ok').addEventListener('click', async () => {
  $('#st-att-ok').disabled = true;
  try {
    const data = await galleryJpeg(attachId);
    const v = $('#st-att-target').value;
    const r = await api(`/api/studio/assets/${attachId}/attach`, { method: 'POST', body: { ...(v.startsWith('c:') ? { color: v.slice(2) } : { productId: Number(v), color: '' }), data } });
    $('#st-attach').close();
    toast(`Добавлено в галерею товара: фото №${r.gallery.imageId}, ${r.gallery.count}-е дополнительное`);
    reloadSession();
  } catch (err) {
    showFormError('#st-att-error', err);
    $('#st-att-ok').disabled = false;
  }
});

// Открыть студию с товаром из карточки товара.
function openStudioForProduct(productId) {
  st.sessionId = null;
  st.newProduct = productId;
  if (location.hash === '#studio') renderStudio(); else location.hash = 'studio';
}

views.studio = { show: renderStudio, right: 'studio' };
