'use strict';

// Обработка фото на устройстве (без сервера и без платных сервисов): поворот и выравнивание, кадрирование
// с увеличением и сдвигом (крупные планы деталей — из настоящего фото), форматы 3:4 / 4:5 / 1:1 / 9:16, поля,
// цвет фона, заливка РОВНОГО однотонного фона от краёв кадра, яркость/контраст/насыщенность, размер, JPEG/WebP.
// Оригинал не меняется: результат сохраняется новым фото («обработка») со ссылкой на исходное.
//
// Честно об ограничениях: «однотонный фон» — это заливка похожих по цвету пикселей от краёв кадра. Она работает
// на ровном студийном фоне. Это НЕ вырезание контура вещи нейросетью: на сложном фоне или если вещь того же цвета,
// что фон, результат будет плохим — для этого есть задание «Удалить или заменить фон» в ChatGPT.

const ED_ASPECTS = { original: 'Как у фото', '3:4': '3:4', '4:5': '4:5', '1:1': '1:1', '9:16': '9:16' };
const ED_DEFAULT = { rot: 0, angle: 0, aspect: 'original', fit: 'crop', zoom: 1, pad: 6, offX: 0, offY: 0, bg: '#ffffff', fillBg: false, tol: 28,
  brightness: 0, contrast: 0, saturate: 0, long: 2048, format: 'image/jpeg', quality: 90 };
const ed = { asset: null, session: null, img: null, onSaved: null, s: { ...ED_DEFAULT }, ref: null, sizeTimer: null, drag: null };
const canFilter = (() => { try { return typeof document.createElement('canvas').getContext('2d').filter === 'string'; } catch { return false; } })();
const canWebp = (() => { try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();

document.body.insertAdjacentHTML('beforeend', `
<dialog id="st-editor" class="st-dialog wide" aria-labelledby="ed-title">
  <div class="gal-head"><div><h2 id="ed-title">Обработка фото</h2><p class="sub" id="ed-sub"></p></div><button type="button" class="icon-btn" id="ed-close" aria-label="Закрыть">×</button></div>
  <div class="ed-body">
    <div class="ed-stage">
      <canvas id="ed-canvas" aria-label="Предпросмотр"></canvas>
      <p class="sub" id="ed-info"></p>
      <p class="sub ed-hint">В режиме «Кадрировать» фото можно двигать пальцем или мышью.</p>
    </div>
    <div class="ed-controls">
      <fieldset><legend>Поворот</legend>
        <div class="ed-row"><button type="button" class="btn small" data-ed-rot="-90">⟲ 90°</button><button type="button" class="btn small" data-ed-rot="90">⟳ 90°</button></div>
        <label>Выровнять: <span data-out="angle"></span>°<input type="range" data-ed="angle" min="-15" max="15" step="0.5"></label></fieldset>
      <fieldset><legend>Кадр</legend>
        <label>Формат <select class="input" data-ed="aspect">${Object.entries(ED_ASPECTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <div class="seg ed-row" role="group"><button type="button" data-ed-fit="crop">Кадрировать</button><button type="button" data-ed-fit="pad">Целиком с полями</button></div>
        <label data-only="crop">Увеличение: <span data-out="zoom"></span>%<input type="range" data-ed="zoom" min="1" max="4" step="0.05"></label>
        <label data-only="pad">Поля: <span data-out="pad"></span>%<input type="range" data-ed="pad" min="0" max="25" step="1"></label>
        <button type="button" class="btn small ghost" id="ed-center">По центру</button></fieldset>
      <fieldset><legend>Фон</legend>
        <div class="ed-row"><input type="color" data-ed="bg" aria-label="Цвет фона и полей">
          <button type="button" class="ed-sw" data-ed-bg="#ffffff" style="background:#ffffff" title="Белый"></button>
          <button type="button" class="ed-sw" data-ed-bg="#f2f2f2" style="background:#f2f2f2" title="Светло-серый"></button>
          <button type="button" class="ed-sw" data-ed-bg="#efe9e1" style="background:#efe9e1" title="Бежевый"></button></div>
        <label class="check"><input type="checkbox" data-ed="fillBg"> Однотонный фон: залить ровный фон этим цветом</label>
        <label data-only-fill>Чувствительность: <span data-out="tol"></span><input type="range" data-ed="tol" min="6" max="70" step="1"></label>
        <p class="sub" data-only-fill>Заливка похожего цвета от краёв кадра — работает только на ровном фоне. Это не вырезание контура: проверьте края вещи.</p></fieldset>
      <fieldset ${canFilter ? '' : 'hidden'}><legend>Свет и цвет</legend>
        <label>Яркость: <span data-out="brightness"></span><input type="range" data-ed="brightness" min="-40" max="40"></label>
        <label>Контраст: <span data-out="contrast"></span><input type="range" data-ed="contrast" min="-40" max="40"></label>
        <label>Насыщенность: <span data-out="saturate"></span><input type="range" data-ed="saturate" min="-40" max="40"></label>
        <p class="sub">Меняйте осторожно: цвет вещи на фото должен совпадать с настоящим.</p></fieldset>
      ${canFilter ? '' : '<p class="sub">Яркость и контраст недоступны в этом браузере.</p>'}
      <fieldset><legend>Файл</legend>
        <label>Длинная сторона <select class="input" data-ed="long"><option value="1200">1200 px</option><option value="1600">1600 px</option><option value="2048">2048 px</option><option value="2400">2400 px</option><option value="3000">3000 px</option></select></label>
        <label>Формат <select class="input" data-ed="format"><option value="image/jpeg">JPEG</option>${canWebp ? '<option value="image/webp">WebP</option>' : ''}</select></label>
        <label>Качество: <span data-out="quality"></span>%<input type="range" data-ed="quality" min="60" max="95" step="1"></label>
        ${canWebp ? '' : '<p class="sub">WebP этот браузер не сохраняет — только JPEG.</p>'}</fieldset>
    </div>
  </div>
  <p class="form-error" id="ed-error" role="alert" hidden></p>
  <div class="form-actions">
    <button type="button" class="btn ghost" id="ed-reset">Сбросить</button>
    <button type="button" class="btn ghost" id="ed-cancel">Отмена</button>
    <button type="button" class="btn primary" id="ed-save">Сохранить как новое фото</button>
  </div>
</dialog>`);

const edRatio = (s, sw, sh) => (s.aspect === 'original' ? sw / sh : (([a, b]) => a / b)(s.aspect.split(':').map(Number)));
function edGeometry(s, longSide) {
  const iw = ed.img.naturalWidth;
  const ih = ed.img.naturalHeight;
  const swap = s.rot % 180 !== 0;
  const sw = swap ? ih : iw;
  const sh = swap ? iw : ih;
  const r = edRatio(s, sw, sh);
  const W = r >= 1 ? longSide : Math.round(longSide * r);
  const H = r >= 1 ? Math.round(longSide / r) : longSide;
  const a = (s.angle * Math.PI) / 180;
  let scale;
  if (s.fit === 'crop') {
    const cover = Math.max(W / sw, H / sh);
    const extra = Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)) * Math.max(W / H, H / W);
    scale = cover * extra * s.zoom;
  } else {
    scale = Math.min(W / sw, H / sh) * (1 - (2 * s.pad) / 100);
  }
  return { W, H, sw, sh, scale, a, iw, ih };
}
function edClampOffset(s) {
  if (s.fit !== 'crop') { s.offX = 0; s.offY = 0; return; }
  const g = edGeometry(s, 1000);
  const mx = Math.max(0, (g.scale * g.sw - g.W) / (2 * g.W));
  const my = Math.max(0, (g.scale * g.sh - g.H) / (2 * g.H));
  s.offX = Math.min(mx, Math.max(-mx, s.offX));
  s.offY = Math.min(my, Math.max(-my, s.offY));
}

// Цвет фона самого фото: медиана пикселей по краю исходника.
function edRefColor() {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  const x = c.getContext('2d');
  x.drawImage(ed.img, 0, 0, 96, 96);
  const d = x.getImageData(0, 0, 96, 96).data;
  const r = []; const g = []; const b = [];
  for (let i = 0; i < 96; i++) for (const [px, py] of [[i, 0], [i, 95], [0, i], [95, i]]) { const k = (py * 96 + px) * 4; r.push(d[k]); g.push(d[k + 1]); b.push(d[k + 2]); }
  const med = (arr) => arr.sort((p, q) => p - q)[arr.length >> 1];
  return [med(r), med(g), med(b)];
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Заливка ровного фона: от всех краёв кадра расходимся по пикселям, похожим на цвет фона фото (или уже на цвет полей).
function edFillBackground(ctx, W, H, s) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const [rr, rg, rb] = ed.ref;
  const [br, bg, bb] = hexRgb(s.bg);
  const tol2 = s.tol * s.tol;
  const near = (k, r, g, b, t2) => { const dr = d[k] - r; const dg = d[k + 1] - g; const db = d[k + 2] - b; return dr * dr + dg * dg + db * db <= t2; };
  const pass = (k) => near(k, rr, rg, rb, tol2) || near(k, br, bg, bb, 64);
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0; let tail = 0;
  const push = (i) => { if (!seen[i] && pass(i * 4)) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  // Край вещи: пиксели рядом с залитым фоном и близкие к цвету фона — смягчаются наполовину, без ореола.
  const soft2 = tol2 * 2.6;
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    if (seen[i]) { d[k] = br; d[k + 1] = bg; d[k + 2] = bb; d[k + 3] = 255; continue; }
    const x = i % W;
    const edge = (x > 0 && seen[i - 1]) || (x < W - 1 && seen[i + 1]) || (i >= W && seen[i - W]) || (i < W * (H - 1) && seen[i + W]);
    if (edge && near(k, rr, rg, rb, soft2)) { d[k] = (d[k] + br) >> 1; d[k + 1] = (d[k + 1] + bg) >> 1; d[k + 2] = (d[k + 2] + bb) >> 1; }
  }
  ctx.putImageData(img, 0, 0);
  return tail / (W * H);
}

function edRender(canvas, longSide) {
  const s = ed.s;
  const g = edGeometry(s, longSide);
  canvas.width = g.W;
  canvas.height = g.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: s.fillBg });
  ctx.fillStyle = s.bg;
  ctx.fillRect(0, 0, g.W, g.H);
  ctx.save();
  ctx.translate(g.W / 2 + s.offX * g.W, g.H / 2 + s.offY * g.H);
  ctx.rotate((s.rot * Math.PI) / 180 + g.a);
  ctx.scale(g.scale, g.scale);
  if (canFilter) ctx.filter = `brightness(${100 + s.brightness}%) contrast(${100 + s.contrast}%) saturate(${100 + s.saturate}%)`;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ed.img, -g.iw / 2, -g.ih / 2);
  ctx.restore();
  const filled = s.fillBg ? edFillBackground(ctx, g.W, g.H, s) : 0;
  // Во сколько раз растянуты пиксели оригинала: больше 1 — фото станет мягче.
  return { W: g.W, H: g.H, upscale: g.scale, filled };
}

function edSyncControls() {
  const s = ed.s;
  const dlg = $('#st-editor');
  for (const el of dlg.querySelectorAll('[data-ed]')) {
    const k = el.dataset.ed;
    if (el.type === 'checkbox') el.checked = Boolean(s[k]); else el.value = String(s[k]);
  }
  for (const o of dlg.querySelectorAll('[data-out]')) {
    const k = o.dataset.out;
    o.textContent = k === 'zoom' ? Math.round(s.zoom * 100) : k === 'brightness' || k === 'contrast' || k === 'saturate' ? (s[k] > 0 ? `+${s[k]}` : s[k]) : s[k];
  }
  for (const b of dlg.querySelectorAll('[data-ed-fit]')) b.setAttribute('aria-pressed', String(b.dataset.edFit === s.fit));
  for (const el of dlg.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== s.fit;
  for (const el of dlg.querySelectorAll('[data-only-fill]')) el.hidden = !s.fillBg;
}

function edPreview() {
  edClampOffset(ed.s);
  edSyncControls();
  const r = edRender($('#ed-canvas'), 720);
  const g = edGeometry(ed.s, ed.s.long);
  const warn = [];
  if (g.scale > 1.05) warn.push('⚠ фото растянуто больше оригинала — станет мягче, уменьшите увеличение или размер');
  if (ed.s.fillBg) warn.push(r.filled > 0.92 ? '⚠ залито почти всё — уменьшите чувствительность' : r.filled < 0.02 ? 'фон не найден: он неровный или другого цвета' : `залито ${Math.round(r.filled * 100)}% кадра`);
  $('#ed-info').textContent = `${g.W}×${g.H} · ${ed.s.format === 'image/webp' ? 'WebP' : 'JPEG'} · считаю размер…${warn.length ? ` · ${warn.join(' · ')}` : ''}`;
  clearTimeout(ed.sizeTimer);
  ed.sizeTimer = setTimeout(async () => {
    try {
      const blob = await edExport();
      $('#ed-info').textContent = $('#ed-info').textContent.replace('считаю размер…', `~${fmtKb(blob.size)}`);
    } catch { /* размер не важен */ }
  }, 450);
}

function edExport() {
  const c = document.createElement('canvas');
  edRender(c, ed.s.long);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Браузер не сохранил картинку'))), ed.s.format, ed.s.quality / 100));
}

async function openStudioEditor(asset, session, onSaved) {
  ed.asset = asset;
  ed.session = session;
  ed.onSaved = onSaved;
  ed.s = { ...ED_DEFAULT, format: 'image/jpeg' };
  $('#ed-sub').textContent = `Исходное фото №${asset.id} (${asset.width}×${asset.height}) — оригинал не меняется, результат сохранится новым фото`;
  $('#ed-error').hidden = true;
  ed.img = new Image();
  ed.img.decoding = 'async';
  try {
    await new Promise((resolve, reject) => { ed.img.onload = resolve; ed.img.onerror = () => reject(new Error('Фото не открылось')); ed.img.src = studioFileUrl(asset.id); });
  } catch (err) {
    return toast(err.message, 'error');
  }
  // Размер по умолчанию — не больше оригинала (иначе фото растянется и станет мягче).
  const srcLong = Math.max(ed.img.naturalWidth, ed.img.naturalHeight);
  ed.s.long = [3000, 2400, 2048, 1600, 1200].find((v) => v <= srcLong) || 1200;
  ed.ref = edRefColor();
  $('#st-editor').showModal();
  edPreview();
}

$('#st-editor').addEventListener('input', (e) => {
  const el = e.target.closest('[data-ed]');
  if (!el) return;
  const k = el.dataset.ed;
  ed.s[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' || k === 'long' ? Number(el.value) : el.value;
  edPreview();
});
$('#st-editor').addEventListener('click', (e) => {
  const rot = e.target.closest('[data-ed-rot]');
  const fit = e.target.closest('[data-ed-fit]');
  const bg = e.target.closest('[data-ed-bg]');
  if (rot) ed.s.rot = (ed.s.rot + Number(rot.dataset.edRot) + 360) % 360;
  else if (fit) ed.s.fit = fit.dataset.edFit;
  else if (bg) ed.s.bg = bg.dataset.edBg;
  else if (e.target.closest('#ed-center')) { ed.s.offX = 0; ed.s.offY = 0; }
  else if (e.target.closest('#ed-reset')) ed.s = { ...ED_DEFAULT, long: ed.s.long };
  else return;
  edPreview();
});
// Сдвиг кадра пальцем или мышью.
$('#ed-canvas').addEventListener('pointerdown', (e) => {
  if (ed.s.fit !== 'crop') return;
  ed.drag = { x: e.clientX, y: e.clientY, offX: ed.s.offX, offY: ed.s.offY, w: e.target.clientWidth, h: e.target.clientHeight };
  e.target.setPointerCapture(e.pointerId);
});
$('#ed-canvas').addEventListener('pointermove', (e) => {
  if (!ed.drag) return;
  ed.s.offX = ed.drag.offX + (e.clientX - ed.drag.x) / ed.drag.w;
  ed.s.offY = ed.drag.offY + (e.clientY - ed.drag.y) / ed.drag.h;
  edPreview();
});
for (const ev of ['pointerup', 'pointercancel']) $('#ed-canvas').addEventListener(ev, () => { ed.drag = null; });
const edClose = () => $('#st-editor').close();
$('#ed-close').addEventListener('click', edClose);
$('#ed-cancel').addEventListener('click', edClose);
$('#ed-save').addEventListener('click', async () => {
  $('#ed-save').disabled = true;
  try {
    let blob = await edExport();
    // Студия хранит файлы до 8 МБ — если больше, чуть снижаем качество.
    const keep = ed.s.quality;
    while (blob.size > 7.8e6 && ed.s.quality > 60) { ed.s.quality -= 8; blob = await edExport(); }
    const { long, format, quality, ...rest } = ed.s;
    const g = edGeometry(ed.s, long);
    await api(`/api/studio/sessions/${ed.session.id}/assets`, { method: 'POST', body: {
      kind: 'edit', parentId: ed.asset.id, data: await fileBase64(blob),
      meta: { tool: 'local', params: rest, output: { width: g.W, height: g.H, format, quality } },
    } });
    ed.s.quality = keep;
    edClose();
    toast('Сохранено новым фото — одобрите его в разделе «Обработанные здесь»');
    ed.onSaved?.();
  } catch (err) {
    showFormError('#ed-error', err);
  } finally {
    $('#ed-save').disabled = false;
  }
});
