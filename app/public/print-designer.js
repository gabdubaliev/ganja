'use strict';

// Конструктор этикеток (как BarTender: холст в миллиметрах, объекты, перетаскивание, привязка, слои, отмена)
// и конструктор чека (блоки сверху вниз с полями данных). Печать — print.js, штрихкоды — codes.js.

const PX_MM = 96 / 25.4;
const pz = {
  tab: 'label', saved: null, labels: null, receipt: null, sizes: {},
  // Этикетки
  cur: null, sel: new Set(), tool: 'select', zoom: 0, grid: true, snap: true, step: 1, raw: false, sample: null,
  hist: [], hi: -1, clip: null, drag: null, fieldTool: null, side: 'props',
  // Чек
  rsel: null,
};
const lt = () => pz.labels.list.find((t) => t.id === pz.cur) || pz.labels.list[0];
const objById = (id) => lt().objects.find((o) => o.id === id);
const selected = () => lt().objects.filter((o) => pz.sel.has(o.id));
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const r2 = (n) => Math.round(n * 100) / 100;
const ppm = () => PX_MM * pz.zoom;

async function renderPrintDesigner() {
  try {
    const all = await printDesigns(true);
    pz.saved = JSON.stringify({ labels: all.labels, receipt: all.receipt });
    pz.labels = structuredClone(all.labels);
    pz.receipt = structuredClone(all.receipt);
    pz.sizes = all.labelSizes;
    await catalog.load();
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (!pz.labels.list.some((t) => t.id === pz.cur)) pz.cur = pz.labels.default;
  pz.sel.clear();
  pz.hist = []; pz.hi = -1;
  commit();
  fillSamples();
  $('#lz-preset').innerHTML = '<option value="">Готовые размеры…</option>' + Object.keys(pz.sizes).map((k) => `<option value="${k}">${k.replace('x', ' × ')} мм</option>`).join('')
    + '<option value="70x37">70 × 37 мм (A4, 3×8)</option><option value="100x50">100 × 50 мм</option><option value="100x100">100 × 100 мм</option><option value="25x15">25 × 15 мм (бижутерия)</option>';
  pz.zoom = 0;
  showPzTab(pz.tab);
}

function showPzTab(tab) {
  pz.tab = tab;
  for (const b of document.querySelectorAll('[data-pz-tab]')) b.setAttribute('aria-pressed', String(b.dataset.pzTab === tab));
  $('#lz').hidden = tab !== 'label';
  $('#rz').hidden = tab !== 'receipt';
  if (tab === 'label') renderLabelEditor(); else renderReceiptEditor();
  markPzDirty();
}

function markPzDirty() {
  const dirty = JSON.stringify({ labels: pz.labels, receipt: pz.receipt }) !== pz.saved;
  $('#pz-dirty').textContent = dirty ? '● Есть несохранённые изменения' : 'Всё сохранено';
  $('#pz-dirty').style.color = dirty ? 'var(--critical)' : '';
}

/* =====================================================================
   ЭТИКЕТКИ
   ===================================================================== */

/* ---------- История: отменить / повторить ---------- */
function commit() {
  const snap = JSON.stringify({ labels: pz.labels, cur: pz.cur });
  if (pz.hist[pz.hi] === snap) return;
  pz.hist = pz.hist.slice(0, pz.hi + 1);
  pz.hist.push(snap);
  if (pz.hist.length > 150) pz.hist.shift();
  pz.hi = pz.hist.length - 1;
  markPzDirty();
}
function undoRedo(dir) {
  const i = pz.hi + dir;
  if (i < 0 || i >= pz.hist.length) return;
  pz.hi = i;
  const s = JSON.parse(pz.hist[i]);
  pz.labels = s.labels;
  pz.cur = s.cur;
  for (const id of [...pz.sel]) if (!objById(id)) pz.sel.delete(id);
  renderLabelEditor();
  markPzDirty();
}

/* ---------- Пример товара ---------- */
function fillSamples() {
  const list = catalog.list.filter((p) => !catalog.isGroup(p)).slice(0, 500);
  const best = list.find((p) => p.barcode && p.parent_id) || list.find((p) => p.barcode && p.discount > 0) || list.find((p) => p.barcode) || list[0];
  if (!pz.sample || !list.some((p) => p.id === pz.sample)) pz.sample = best?.id ?? null;
  $('#lz-sample').innerHTML = list.length
    ? list.map((p) => `<option value="${p.id}" ${p.id === pz.sample ? 'selected' : ''}>${esc(p.name)}${p.barcode ? '' : ' (без штрихкода)'}</option>`).join('')
    : '<option value="">Пример товара</option>';
}
const SAMPLE = { name: 'Платье летнее в цветочек', price: 2500, discount: 20, barcode: '2000000000015', code: '00015', article: 'PL-15', category: 'Платья', unit: 'шт', options: { Цвет: 'Красный', Размер: 'M' } };
const sampleProduct = () => catalog.list.find((p) => p.id === pz.sample) || SAMPLE;
const sampleVals = () => (pz.raw ? null : productValues(sampleProduct(), session.design?.name || 'Мой магазин'));

/* ---------- Отрисовка ---------- */
function renderLabelEditor() {
  const t = lt();
  $('#lz-template').innerHTML = pz.labels.list.map((x) => `<option value="${esc(x.id)}" ${x.id === t.id ? 'selected' : ''}>${x.id === pz.labels.default ? '★ ' : ''}${esc(x.name)} — ${x.width}×${x.height}</option>`).join('');
  if (document.activeElement !== $('#lz-name')) $('#lz-name').value = t.name;
  if (document.activeElement !== $('#lz-w')) $('#lz-w').value = t.width;
  if (document.activeElement !== $('#lz-h')) $('#lz-h').value = t.height;
  $('#lz-rotate').value = String(t.rotate || 0);
  $('#lz-border').checked = Boolean(t.border);
  $('#lz-default').disabled = t.id === pz.labels.default;
  $('#lz-default').textContent = t.id === pz.labels.default ? '★ Основной' : '☆ Сделать основным';
  $('#lz-undo').disabled = pz.hi <= 0;
  $('#lz-redo').disabled = pz.hi >= pz.hist.length - 1;
  if (!pz.zoom) zoomFit(false);
  drawBoard();
  renderProps();
  renderLayers();
}

function drawBoard() {
  const t = lt();
  const k = ppm();
  const board = $('#lz-board');
  const paper = $('#lz-paper');
  paper.style.width = `${t.width * k}px`;
  paper.style.height = `${t.height * k}px`;
  board.style.width = `${t.width}mm`;
  board.style.height = `${t.height}mm`;
  board.style.transform = `scale(${pz.zoom})`;
  board.classList.toggle('grid', pz.grid);
  board.style.backgroundSize = `${pz.step}mm ${pz.step}mm`;
  board.style.outline = t.border ? '0.25mm solid #000' : '';
  board.style.outlineOffset = '-0.25mm';
  board.innerHTML = `<style>${LABEL_BASE_CSS}</style>` + labelInnerHtml(t, sampleVals());
  for (const o of t.objects) {
    const el = board.querySelector(`[data-oid="${CSS.escape(o.id)}"]`);
    if (!el) continue;
    if (o.locked) el.classList.add('locked');
    // Поле, которого нет у этого товара (например, артикул), на холсте показывается серым шаблоном — при печати его не будет.
    if (o.type === 'text' && !el.textContent.trim()) { el.firstElementChild.textContent = o.text || 'Текст'; el.classList.add('ph'); }
  }
  fitLabelTexts(board);
  $('#lz-zoom').textContent = `${Math.round(pz.zoom * 100)}%`;
  drawRulers();
  drawOverlay();
}

function drawRulers() {
  const t = lt(), k = ppm();
  const ticks = (len, horiz) => {
    let h = '';
    const every = k < 3 ? 5 : k < 6 ? 2 : 1;
    for (let mm = 0; mm <= len; mm += every) {
      const big = mm % 10 === 0, mid = mm % 5 === 0;
      const size = big ? 10 : mid ? 7 : 4;
      h += horiz ? `<i style="left:${mm * k}px;bottom:0;width:1px;height:${size}px"></i>` : `<i style="top:${mm * k}px;right:0;height:1px;width:${size}px"></i>`;
      if (big || (mid && k > 6)) h += horiz ? `<b style="left:${mm * k + 2}px;top:0">${mm}</b>` : `<b style="top:${mm * k + 1}px;left:1px">${mm}</b>`;
    }
    return h;
  };
  $('#lz-rx').style.width = `${t.width * k}px`;
  $('#lz-ry').style.height = `${t.height * k}px`;
  $('#lz-rx').innerHTML = ticks(t.width, true);
  $('#lz-ry').innerHTML = ticks(t.height, false);
}

function drawOverlay(guides = [], marquee = null) {
  const k = ppm();
  const sel = selected();
  let h = '';
  for (const o of sel) {
    const st = `left:${o.x * k}px;top:${o.y * k}px;width:${o.w * k}px;height:${o.h * k}px;${o.rot ? `transform:rotate(${o.rot}deg);` : ''}`;
    h += `<div class="lz-sel ${sel.length > 1 ? 'multi' : ''} ${o.locked ? 'locked' : ''}" style="${st}">`;
    if (sel.length === 1 && !o.locked) {
      for (const [d, x, y, cur] of [['nw', 0, 0, 'nwse'], ['n', 50, 0, 'ns'], ['ne', 100, 0, 'nesw'], ['e', 100, 50, 'ew'], ['se', 100, 100, 'nwse'], ['s', 50, 100, 'ns'], ['sw', 0, 100, 'nesw'], ['w', 0, 50, 'ew']]) {
        h += `<span class="lz-h" data-handle="${d}" style="left:${x}%;top:${y}%;cursor:${cur}-resize"></span>`;
      }
      h += '<span class="lz-h rot" data-handle="rot" style="left:50%;top:-22px" title="Повернуть (Shift — свободно)"></span>';
    }
    h += '</div>';
  }
  for (const g of guides) h += g.v ? `<div class="lz-guide" style="left:${g.at * k}px;top:0;bottom:0;width:1px"></div>` : `<div class="lz-guide" style="top:${g.at * k}px;left:0;right:0;height:1px"></div>`;
  if (marquee) h += `<div class="lz-marquee" style="left:${Math.min(marquee.x1, marquee.x2) * k}px;top:${Math.min(marquee.y1, marquee.y2) * k}px;width:${Math.abs(marquee.x2 - marquee.x1) * k}px;height:${Math.abs(marquee.y2 - marquee.y1) * k}px"></div>`;
  $('#lz-overlay').innerHTML = h;
  const one = sel.length === 1 ? sel[0] : null;
  $('#lz-status').textContent = one ? `${typeName(one)} · X ${r2(one.x)} · Y ${r2(one.y)} · ${r2(one.w)} × ${r2(one.h)} мм${one.rot ? ` · ${one.rot}°` : ''}`
    : sel.length ? `Выбрано объектов: ${sel.length}` : 'Двойной щелчок по тексту — редактировать. Стрелки двигают выбранное (Shift — по 5 мм, Alt — по 0,1 мм).';
}

function zoomFit(redraw = true) {
  const t = lt();
  const sc = $('#lz-scroll');
  const w = Math.max(200, (sc.clientWidth || 800) - 110), h = Math.max(200, (sc.clientHeight || 500) - 110);
  pz.zoom = Math.max(0.5, Math.min(12, Math.min(w / (t.width * PX_MM), h / (t.height * PX_MM))));
  pz.zoom = Math.round(pz.zoom * 20) / 20;
  if (redraw) drawBoard();
}
function setZoom(z) { pz.zoom = Math.max(0.5, Math.min(16, Math.round(z * 20) / 20)); drawBoard(); }

const TYPE_NAMES = { text: 'Текст', barcode: 'Штрихкод', line: 'Линия', rect: 'Прямоугольник', ellipse: 'Эллипс', image: 'Картинка' };
const typeName = (o) => (o.type === 'barcode' && o.kind === 'qr' ? 'QR-код' : TYPE_NAMES[o.type]);
const objLabel = (o) => o.name || (o.type === 'text' ? o.text.split('\n')[0].slice(0, 40) || 'Текст' : o.type === 'barcode' ? `${typeName(o)}: ${o.value}` : typeName(o));

/* ---------- Создание объектов ---------- */
function newObject(type, x, y, extra = {}) {
  const t = lt();
  const base = { id: uid('o'), name: '', x, y, rot: 0, locked: false, hidden: false };
  const defs = {
    text: { type: 'text', w: Math.min(30, t.width - x), h: 6, text: 'Текст', font: 'Arial', size: 10, bold: false, italic: false, underline: false, strike: false, upper: false, align: 'left', valign: 'middle', fit: 'shrink', wrap: true, lineHeight: 1.1, spacing: 0, invert: false },
    barcode: { type: 'barcode', w: Math.min(40, t.width - x), h: 14, kind: 'auto', value: '{barcode}', showText: true, textSize: 2.6, ecl: 'M' },
    qr: { type: 'barcode', w: 16, h: 16, kind: 'qr', value: '{barcode}', showText: false, textSize: 2.6, ecl: 'M' },
    line: { type: 'line', w: Math.min(30, t.width - x), h: 1, stroke: 0.3, dash: 'solid', fill: 'none', radius: 0 },
    rect: { type: 'rect', w: 20, h: 12, stroke: 0.3, dash: 'solid', fill: 'none', radius: 0 },
    ellipse: { type: 'ellipse', w: 14, h: 14, stroke: 0.3, dash: 'solid', fill: 'none', radius: 0 },
    image: { type: 'image', w: 15, h: 15, imageId: null, fit: 'contain', mono: false },
  };
  const o = { ...base, ...defs[type], ...extra };
  t.objects.push(o);
  pz.sel = new Set([o.id]);
  return o;
}

function setTool(tool) {
  pz.tool = tool;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  $('#lz-fieldmenu').hidden = tool !== 'field';
  $('#lz-board').style.cursor = tool === 'select' ? '' : 'crosshair';
  if (tool === 'field') {
    $('#lz-fieldmenu').innerHTML = '<div class="lz-hint" style="padding:4px 10px">Выберите поле, затем щёлкните на этикетке</div>'
      + LABEL_TOKENS.map(([k, n]) => `<button type="button" data-ftoken="${k}" aria-pressed="${pz.fieldTool === k}">${esc(n)} <code>{${k}}</code></button>`).join('');
  }
  $('#lz-status').textContent = tool === 'select' ? '' : tool === 'image' ? 'Щёлкните на этикетке — откроется выбор картинки' : 'Щёлкните на этикетке или протяните рамку, чтобы поставить объект. Esc — отмена.';
}

/* ---------- Мышь и палец на холсте ---------- */
function boardPoint(e) {
  const r = $('#lz-paper').getBoundingClientRect();
  return { x: (e.clientX - r.left) / ppm(), y: (e.clientY - r.top) / ppm() };
}
const snapV = (v) => (pz.snap ? Math.round(v / pz.step) * pz.step : v);

// Умные направляющие: края и центры этикетки и других объектов (порог — 6 пикселей экрана).
function guideSnap(box, moving) {
  const t = lt();
  const th = 6 / ppm();
  const xs = [0, t.width / 2, t.width], ys = [0, t.height / 2, t.height];
  for (const o of t.objects) {
    if (moving.has(o.id) || o.hidden || o.rot) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (cands, edges) => {
    let res = null;
    for (const [i, e] of edges.entries()) for (const c of cands) {
      const d = c - e;
      if (Math.abs(d) <= th && (!res || Math.abs(d) < Math.abs(res.d))) res = { d, at: c, i };
    }
    return res;
  };
  const gx = best(xs, [box.x, box.x + box.w / 2, box.x + box.w]);
  const gy = best(ys, [box.y, box.y + box.h / 2, box.y + box.h]);
  return { dx: gx ? gx.d : null, dy: gy ? gy.d : null, guides: [gx && { v: true, at: gx.at }, gy && { v: false, at: gy.at }].filter(Boolean) };
}

$('#lz-scroll').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const handle = e.target.closest('[data-handle]');
  const objEl = e.target.closest('#lz-board [data-oid]');
  const p = boardPoint(e);
  const t = lt();
  $('#lz-fieldmenu').hidden = true;
  // Инструмент: поставить новый объект (щелчок — размер по умолчанию, протянуть — свой размер).
  if (pz.tool !== 'select') {
    if (pz.tool === 'field' && !pz.fieldTool) { $('#lz-fieldmenu').hidden = false; return; }
    if (pz.tool === 'image') { addImageObject(snapV(p.x), snapV(p.y)); setTool('select'); return; }
    const type = pz.tool === 'field' ? 'text' : pz.tool;
    const extra = pz.tool === 'field' ? { text: `{${pz.fieldTool}}`, name: LABEL_TOKENS.find(([k]) => k === pz.fieldTool)?.[1] || '', bold: pz.fieldTool === 'price', size: pz.fieldTool === 'price' ? 16 : 9, align: 'center' } : {};
    const o = newObject(type, snapV(p.x), snapV(p.y), extra);
    pz.drag = { mode: 'create', o, x0: o.x, y0: o.y, def: { w: o.w, h: o.h }, moved: false };
    $('#lz-scroll').setPointerCapture(e.pointerId);
    drawBoard();
    return;
  }
  if (handle) {
    const o = selected()[0];
    if (!o) return;
    pz.drag = { mode: handle.dataset.handle === 'rot' ? 'rotate' : 'resize', dir: handle.dataset.handle, o, start: { ...o }, p0: p };
    $('#lz-scroll').setPointerCapture(e.pointerId);
    return;
  }
  if (objEl) {
    const id = objEl.dataset.oid;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (pz.sel.has(id)) pz.sel.delete(id); else pz.sel.add(id);
    } else if (!pz.sel.has(id)) pz.sel = new Set([id]);
    const moving = selected().filter((o) => !o.locked);
    pz.drag = { mode: 'move', p0: p, primary: objById(id), starts: new Map(moving.map((o) => [o.id, { x: o.x, y: o.y }])), moved: false };
    $('#lz-scroll').setPointerCapture(e.pointerId);
    drawOverlay();
    renderProps();
    renderLayers();
    return;
  }
  // Пусто: рамка выделения.
  if (!e.shiftKey) pz.sel.clear();
  pz.drag = { mode: 'marquee', m: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } };
  $('#lz-scroll').setPointerCapture(e.pointerId);
  drawOverlay();
  renderProps();
  renderLayers();
});

$('#lz-scroll').addEventListener('pointermove', (e) => {
  const d = pz.drag;
  if (!d) return;
  const p = boardPoint(e);
  if (d.mode === 'create') {
    const w = p.x - d.x0, h = p.y - d.y0;
    if (Math.abs(w) * ppm() > 6 || Math.abs(h) * ppm() > 6) {
      d.moved = true;
      d.o.x = snapV(Math.min(d.x0, p.x)); d.o.y = snapV(Math.min(d.y0, p.y));
      d.o.w = Math.max(1, snapV(Math.abs(w))); d.o.h = Math.max(1, snapV(Math.abs(h)));
      if (d.o.kind === 'qr') d.o.h = d.o.w;
      drawBoard();
    }
    return;
  }
  if (d.mode === 'marquee') {
    d.m.x2 = p.x; d.m.y2 = p.y;
    const [x1, x2] = [Math.min(d.m.x1, d.m.x2), Math.max(d.m.x1, d.m.x2)], [y1, y2] = [Math.min(d.m.y1, d.m.y2), Math.max(d.m.y1, d.m.y2)];
    pz.sel = new Set(lt().objects.filter((o) => !o.hidden && o.x < x2 && o.x + o.w > x1 && o.y < y2 && o.y + o.h > y1).map((o) => o.id));
    drawOverlay([], d.m);
    return;
  }
  if (d.mode === 'move') {
    if (!d.starts.size) return;
    let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    if (!d.moved && Math.hypot(dx, dy) * ppm() < 3) return;
    d.moved = true;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const pr = d.primary && d.starts.get(d.primary.id) ? d.primary : objById([...d.starts.keys()][0]);
    const st = d.starts.get(pr.id);
    let nx = st.x + dx, ny = st.y + dy;
    let guides = [];
    if (!e.altKey) {
      const g = guideSnap({ x: nx, y: ny, w: pr.w, h: pr.h }, new Set(d.starts.keys()));
      if (g.dx !== null) nx += g.dx; else nx = snapV(nx);
      if (g.dy !== null) ny += g.dy; else ny = snapV(ny);
      guides = g.guides;
    }
    const ddx = nx - st.x, ddy = ny - st.y;
    for (const [id, s] of d.starts) { const o = objById(id); o.x = r2(s.x + ddx); o.y = r2(s.y + ddy); }
    moveRendered();
    drawOverlay(guides);
    return;
  }
  if (d.mode === 'rotate') {
    const o = d.o;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    let a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    a = e.shiftKey ? Math.round(a) : Math.round(a / 15) * 15;
    o.rot = ((a % 360) + 360) % 360;
    if (o.rot > 180) o.rot -= 360;
    drawBoard();
    return;
  }
  if (d.mode === 'resize') {
    const o = d.o, s = d.start, dir = d.dir;
    const a = (s.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    let L = -s.w / 2, R = s.w / 2, T = -s.h / 2, B = s.h / 2;
    if (dir.includes('w')) L += lx;
    if (dir.includes('e')) R += lx;
    if (dir.includes('n')) T += ly;
    if (dir.includes('s')) B += ly;
    let w = Math.max(0.5, R - L), h = Math.max(0.5, B - T);
    const keep = e.shiftKey || (o.type === 'barcode' && o.kind === 'qr');
    if (keep && dir.length === 2) { const k = Math.max(w / s.w, h / s.h); w = s.w * k; h = s.h * k; if (dir.includes('w')) L = R - w; else R = L + w; if (dir.includes('n')) T = B - h; else B = T + h; }
    const cx = s.x + s.w / 2 + ((L + R) / 2) * cos - ((T + B) / 2) * sin;
    const cy = s.y + s.h / 2 + ((L + R) / 2) * sin + ((T + B) / 2) * cos;
    o.w = r2(w); o.h = r2(h); o.x = r2(cx - w / 2); o.y = r2(cy - h / 2);
    // Без поворота — привязка краёв к сетке.
    if (!s.rot && pz.snap && !e.altKey) {
      if (dir.includes('e')) o.w = Math.max(0.5, r2(snapV(o.x + o.w) - o.x));
      if (dir.includes('s')) o.h = Math.max(0.5, r2(snapV(o.y + o.h) - o.y));
      if (dir.includes('w')) { const nx = snapV(o.x); o.w = Math.max(0.5, r2(o.w + o.x - nx)); o.x = nx; }
      if (dir.includes('n')) { const ny = snapV(o.y); o.h = Math.max(0.5, r2(o.h + o.y - ny)); o.y = ny; }
    }
    drawBoard();
  }
});

// Быстрое перемещение: двигаем готовые элементы, без перерисовки всей этикетки.
function moveRendered() {
  for (const o of selected()) {
    const el = $('#lz-board').querySelector(`[data-oid="${CSS.escape(o.id)}"]`);
    if (el) { el.style.left = `${o.x}mm`; el.style.top = `${o.y}mm`; }
  }
}

$('#lz-scroll').addEventListener('pointerup', () => {
  const d = pz.drag;
  pz.drag = null;
  if (!d) return;
  if (d.mode === 'create') {
    if (!d.moved) {
      const t = lt();
      // Щелчок без протягивания: размер по умолчанию, но в пределах этикетки.
      d.o.w = r2(Math.min(d.def.w, Math.max(3, t.width - d.o.x)));
      d.o.h = r2(Math.min(d.def.h, Math.max(1, t.height - d.o.y)));
      if (d.o.kind === 'qr') d.o.w = d.o.h = Math.min(d.o.w, d.o.h);
    }
    setTool('select');
    pz.fieldTool = null;
  }
  drawBoard();
  renderProps();
  renderLayers();
  commit();
});

$('#lz-scroll').addEventListener('dblclick', (e) => {
  const el = e.target.closest('#lz-board [data-oid]');
  if (!el) return;
  const o = objById(el.dataset.oid);
  pz.sel = new Set([o.id]);
  showSide('props');
  renderProps();
  const ta = $('#lz-props textarea[data-p="text"], #lz-props input[data-p="value"]');
  if (ta) { ta.focus(); ta.select(); }
});

$('#lz-scroll').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(pz.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });

/* ---------- Картинка ---------- */
async function addImageObject(x, y, replace = null) {
  const file = await pickFile();
  if (!file) return;
  try {
    const data = await shrinkPhoto(file, 1000, 'image/png');
    const { id } = await api('/api/images', { method: 'POST', body: { mime: 'image/png', data } });
    const img = new Image();
    img.src = `/img/${id}`;
    await img.decode().catch(() => {});
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 1;
    if (replace) replace.imageId = id;
    else { const w = Math.min(20, lt().width - x); newObject('image', x, y, { imageId: id, w, h: r2(w * ratio) }); }
    drawBoard(); renderProps(); renderLayers(); commit();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Панель свойств ---------- */
const FONT_OPTIONS = () => LABEL_FONTS.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('');
const tokenSelect = (target) => `<select class="input" data-insert="${target}"><option value="">＋ Вставить поле…</option>${LABEL_TOKENS.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select>`;
const num = (p, v, label, step = 0.5) => `<div class="field"><label>${label}</label><input class="input num" data-p="${p}" data-num="1" value="${v}" inputmode="decimal" data-step="${step}"></div>`;
const btnTog = (p, on, label, title) => `<button type="button" data-tog="${p}" aria-pressed="${Boolean(on)}" title="${title || ''}">${label}</button>`;
const btnSet = (p, v, cur, label, title) => `<button type="button" data-set="${p}" data-v="${v}" aria-pressed="${cur === v}" title="${title || ''}">${label}</button>`;

function renderProps() {
  if (pz.side !== 'props') return;
  const sel = selected();
  const t = lt();
  const box = $('#lz-props');
  if (!sel.length) {
    box.innerHTML = `<h3>Этикетка «${esc(t.name)}»</h3>
      <div class="lz-grid2">${num('_tw', t.width, 'Ширина, мм', 1)}${num('_th', t.height, 'Высота, мм', 1)}</div>
      <p class="lz-hint">Слева — инструменты: <b>Текст</b>, <b>Поле</b> (название, цена, артикул… подставятся из товара), <b>Штрихкод</b>, <b>QR</b>, линии, рамки, картинки.
      Выберите инструмент и щёлкните на этикетке или протяните рамку.</p>
      <p class="lz-hint">Клавиши: <kbd>Ctrl</kbd>+<kbd>Z</kbd> отменить, <kbd>Ctrl</kbd>+<kbd>Y</kbd> повторить, <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> копировать/вставить,
      <kbd>Ctrl</kbd>+<kbd>D</kbd> дублировать, <kbd>Del</kbd> удалить, стрелки — сдвиг, <kbd>Ctrl</kbd>+колесо — масштаб, <kbd>Alt</kbd> при перетаскивании — без привязки.</p>
      <p class="lz-hint">В тексте поля пишутся в фигурных скобках: <code>Арт. {article}</code>. Если поля у товара нет, строка не печатается.</p>`;
    return;
  }
  if (sel.length > 1) {
    box.innerHTML = `<h3>Выбрано: ${sel.length}</h3><p class="lz-hint">Выровняйте и распределите кнопками над холстом. Перетаскивайте все вместе. Свойства — у каждого объекта по отдельности.</p>
      <div class="lz-btns"><button type="button" data-multi="group-lock">🔒 Закрепить все</button><button type="button" data-multi="delete">🗑 Удалить все</button></div>`;
    return;
  }
  const o = sel[0];
  let h = `<h3>${typeName(o)}</h3>
    <div class="field"><label>Имя (для слоёв)</label><input class="input" data-p="name" value="${esc(o.name)}" maxlength="60"></div>
    <div class="lz-grid4">${num('x', o.x, 'X')}${num('y', o.y, 'Y')}${num('w', o.w, 'Ширина')}${num('h', o.h, 'Высота')}</div>
    <div class="lz-grid2">${num('rot', o.rot, 'Поворот, °', 1)}<div class="field"><label>&nbsp;</label><div class="lz-btns">${btnTog('locked', o.locked, '🔒', 'Закрепить')}${btnTog('hidden', o.hidden, '🙈', 'Скрыть (не печатать)')}</div></div></div>`;
  if (o.type === 'text') {
    h += `<div class="field"><label>Текст и поля</label><textarea class="input" data-p="text" rows="3">${esc(o.text)}</textarea>${tokenSelect('text')}</div>
      <div class="lz-grid2"><div class="field"><label>Шрифт</label><select class="input" data-p="font">${FONT_OPTIONS()}</select></div>${num('size', o.size, 'Размер, пт')}</div>
      <div class="lz-btns">${btnTog('bold', o.bold, '<b>Ж</b>', 'Жирный')}${btnTog('italic', o.italic, '<i>К</i>', 'Курсив')}${btnTog('underline', o.underline, '<u>Ч</u>', 'Подчёркнутый')}${btnTog('strike', o.strike, '<s>З</s>', 'Зачёркнутый (старая цена)')}${btnTog('upper', o.upper, 'АА', 'Заглавными')}${btnTog('invert', o.invert, '◼', 'Белым по чёрному')}</div>
      <div class="field"><span class="lab">По горизонтали</span><div class="lz-btns">${btnSet('align', 'left', o.align, '⯇ Слева')}${btnSet('align', 'center', o.align, '≡ Центр')}${btnSet('align', 'right', o.align, 'Справа ⯈')}${btnSet('align', 'justify', o.align, '☰ По ширине')}</div></div>
      <div class="field"><span class="lab">По вертикали</span><div class="lz-btns">${btnSet('valign', 'top', o.valign, 'Верх')}${btnSet('valign', 'middle', o.valign, 'Середина')}${btnSet('valign', 'bottom', o.valign, 'Низ')}</div></div>
      <div class="field"><span class="lab">Если текст не влезает в рамку</span><div class="lz-btns">${btnSet('fit', 'shrink', o.fit, 'Уменьшать шрифт')}${btnSet('fit', 'grow', o.fit, 'Заполнять рамку')}${btnSet('fit', 'none', o.fit, 'Как есть')}</div></div>
      <label class="check"><input type="checkbox" data-chk="wrap" ${o.wrap ? 'checked' : ''}> Переносить по словам</label>
      <div class="lz-grid2">${num('lineHeight', o.lineHeight, 'Межстрочный', 0.05)}${num('spacing', o.spacing, 'Межбуквенный, пт', 0.1)}</div>`;
  } else if (o.type === 'barcode') {
    h += `<div class="field"><label>Вид кода</label><select class="input" data-p="kind">
        <option value="auto">Авто: EAN-13, если подходит, иначе Code 128</option><option value="ean13">EAN-13 (товары, 13 цифр)</option>
        <option value="code128">Code 128 (буквы, цифры, знаки)</option><option value="qr">QR-код (ссылка, любой текст)</option></select></div>
      <div class="field"><label>Что закодировать</label><input class="input" data-p="value" value="${esc(o.value)}">${tokenSelect('value')}</div>
      ${o.kind === 'qr' ? `<div class="field"><label>Надёжность QR (чем выше — тем больше код)</label><select class="input" data-p="ecl"><option value="L">Низкая (7%)</option><option value="M">Средняя (15%)</option><option value="Q">Высокая (25%)</option><option value="H">Максимальная (30%)</option></select></div>`
        : `<label class="check"><input type="checkbox" data-chk="showText" ${o.showText ? 'checked' : ''}> Цифры под штрихкодом</label>${num('textSize', o.textSize, 'Высота цифр, мм', 0.1)}`}
      <p class="lz-hint">${o.kind === 'qr' ? 'В QR можно положить ссылку на витрину: <code>https://montshop.kg/shop</code>.' : 'Самая узкая полоса должна быть не тоньше 0,25 мм — иначе сканер может не прочитать. Делайте штрихкод шире.'}</p>`;
  } else if (o.type === 'image') {
    h += `<div class="lz-btns"><button type="button" data-img="replace">🖼 Заменить картинку</button></div>
      <div class="field"><span class="lab">Вписать</span><div class="lz-btns">${btnSet('fit', 'contain', o.fit, 'Целиком')}${btnSet('fit', 'cover', o.fit, 'Заполнить')}${btnSet('fit', 'fill', o.fit, 'Растянуть')}</div></div>
      <label class="check"><input type="checkbox" data-chk="mono" ${o.mono ? 'checked' : ''}> Чёрно-белая (для термопринтера)</label>`;
  } else {
    h += `<div class="lz-grid2">${num('stroke', o.stroke, 'Толщина линии, мм', 0.05)}${o.type === 'rect' ? num('radius', o.radius, 'Скругление, мм', 0.5) : '<span></span>'}</div>
      <div class="field"><span class="lab">Линия</span><div class="lz-btns">${btnSet('dash', 'solid', o.dash, '━ Сплошная')}${btnSet('dash', 'dashed', o.dash, '┅ Штрих')}${btnSet('dash', 'dotted', o.dash, '┈ Точки')}</div></div>
      ${o.type !== 'line' ? `<div class="field"><span class="lab">Заливка</span><div class="lz-btns">${btnSet('fill', 'none', o.fill, 'Нет')}${btnSet('fill', 'black', o.fill, '◼ Чёрная')}${btnSet('fill', 'white', o.fill, '◻ Белая')}</div></div>` : '<p class="lz-hint">Горизонтальная или вертикальная — по длинной стороне рамки.</p>'}`;
  }
  box.innerHTML = h;
  for (const el of box.querySelectorAll('select[data-p]')) el.value = o[el.dataset.p];
}

function showSide(side) {
  pz.side = side;
  for (const b of document.querySelectorAll('[data-side]')) b.setAttribute('aria-pressed', String(b.dataset.side === side));
  $('#lz-props').hidden = side !== 'props';
  $('#lz-layers').hidden = side !== 'layers';
  if (side === 'props') renderProps(); else renderLayers();
}

function applyProp(o, p, v) {
  if (p === '_tw' || p === '_th') {
    const t = lt();
    t[p === '_tw' ? 'width' : 'height'] = Math.max(10, Math.min(300, v));
    drawBoard();
    renderLabelEditor();
    return;
  }
  if (o.type === 'barcode' && o.kind === 'qr' && (p === 'w' || p === 'h')) { o.w = v; o.h = v; } else o[p] = v;
  if (p === 'kind' && v === 'qr') { o.h = o.w = Math.min(o.w, o.h, 20); }
  drawBoard();
  renderLayers();
}

$('#lz-props').addEventListener('input', (e) => {
  const el = e.target;
  const o = selected()[0];
  if (el.dataset.p) {
    const v = el.dataset.num ? parseNum(el.value) : el.value;
    if (el.dataset.num && !Number.isFinite(v)) return;
    applyProp(o, el.dataset.p, el.dataset.num ? r2(v) : v);
    if (el.tagName === 'SELECT' && el.dataset.p === 'kind') renderProps();
  }
});
$('#lz-props').addEventListener('change', (e) => {
  const el = e.target;
  const o = selected()[0];
  if (el.dataset.chk) { o[el.dataset.chk] = el.checked; drawBoard(); }
  if (el.dataset.insert && el.value) {
    const f = $(`#lz-props [data-p="${el.dataset.insert}"]`);
    const ins = `{${el.value}}`;
    const s = f.selectionStart ?? f.value.length, en = f.selectionEnd ?? f.value.length;
    f.value = f.value.slice(0, s) + ins + f.value.slice(en);
    o[el.dataset.insert] = f.value;
    el.value = '';
    drawBoard();
    f.focus();
  }
  commit();
  renderLabelEditorBar();
});
$('#lz-props').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const o = selected()[0];
  if (b.dataset.tog) o[b.dataset.tog] = !o[b.dataset.tog];
  else if (b.dataset.set) o[b.dataset.set] = b.dataset.v;
  else if (b.dataset.img) return addImageObject(0, 0, o);
  else if (b.dataset.multi === 'delete') return deleteSelected();
  else if (b.dataset.multi === 'group-lock') { for (const x of selected()) x.locked = true; }
  else return;
  drawBoard(); renderProps(); renderLayers(); commit();
});
// Колесо мыши и стрелки в числовых полях — плюс/минус шаг.
$('#lz-props').addEventListener('keydown', (e) => {
  const el = e.target;
  if (!el.dataset.num || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const step = Number(el.dataset.step) * (e.shiftKey ? 10 : 1);
  el.value = r2((parseNum(el.value) || 0) + (e.key === 'ArrowUp' ? step : -step));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  commit();
});

function renderLabelEditorBar() {
  const t = lt();
  $('#lz-template').innerHTML = pz.labels.list.map((x) => `<option value="${esc(x.id)}" ${x.id === t.id ? 'selected' : ''}>${x.id === pz.labels.default ? '★ ' : ''}${esc(x.name)} — ${x.width}×${x.height}</option>`).join('');
  $('#lz-undo').disabled = pz.hi <= 0;
  $('#lz-redo').disabled = pz.hi >= pz.hist.length - 1;
}

/* ---------- Слои ---------- */
const TYPE_ICON = { text: 'T', barcode: '▥', line: '╱', rect: '▭', ellipse: '◯', image: '🖼' };
function renderLayers() {
  if (pz.side !== 'layers') return;
  const objs = [...lt().objects].reverse();
  $('#lz-layers').innerHTML = objs.length ? `<p class="lz-hint">Сверху — передний план. Порядок — кнопками ⬆ ⬇ над холстом.</p>` + objs.map((o) => `<div class="lz-layer ${pz.sel.has(o.id) ? 'on' : ''}" data-layer="${esc(o.id)}">
      <b>${o.type === 'barcode' && o.kind === 'qr' ? '▦' : TYPE_ICON[o.type]}</b><span>${esc(objLabel(o))}</span>
      <button type="button" data-lhide="${esc(o.id)}" class="${o.hidden ? 'off' : ''}" title="Показать / скрыть">👁</button>
      <button type="button" data-llock="${esc(o.id)}" class="${o.locked ? '' : 'off'}" title="Закрепить">🔒</button></div>`).join('')
    : '<p class="lz-hint">На этикетке пока ничего нет.</p>';
}
$('#lz-layers').addEventListener('click', (e) => {
  const hide = e.target.closest('[data-lhide]'), lock = e.target.closest('[data-llock]'), row = e.target.closest('[data-layer]');
  if (hide) { const o = objById(hide.dataset.lhide); o.hidden = !o.hidden; commit(); }
  else if (lock) { const o = objById(lock.dataset.llock); o.locked = !o.locked; commit(); }
  else if (row) { if (e.shiftKey) pz.sel.add(row.dataset.layer); else pz.sel = new Set([row.dataset.layer]); }
  else return;
  drawBoard(); renderLayers();
});

/* ---------- Выравнивание, порядок, правка ---------- */
function alignSelected(how) {
  const sel = selected().filter((o) => !o.locked);
  if (!sel.length) return;
  const t = lt();
  // Один объект — по этикетке; несколько — по общей рамке выделения.
  const one = sel.length === 1;
  const bx = one ? { x: 0, y: 0, w: t.width, h: t.height } : (() => {
    const x1 = Math.min(...sel.map((o) => o.x)), y1 = Math.min(...sel.map((o) => o.y));
    return { x: x1, y: y1, w: Math.max(...sel.map((o) => o.x + o.w)) - x1, h: Math.max(...sel.map((o) => o.y + o.h)) - y1 };
  })();
  for (const o of sel) {
    if (how === 'left') o.x = bx.x;
    if (how === 'right') o.x = r2(bx.x + bx.w - o.w);
    if (how === 'hcenter') o.x = r2(bx.x + (bx.w - o.w) / 2);
    if (how === 'top') o.y = bx.y;
    if (how === 'bottom') o.y = r2(bx.y + bx.h - o.h);
    if (how === 'vcenter') o.y = r2(bx.y + (bx.h - o.h) / 2);
    if (how === 'fullw') { o.x = 1; o.w = r2(t.width - 2); }
  }
  if ((how === 'hdist' || how === 'vdist') && sel.length > 2) {
    const k = how === 'hdist' ? ['x', 'w'] : ['y', 'h'];
    const s = [...sel].sort((a, b) => a[k[0]] - b[k[0]]);
    const span = s.at(-1)[k[0]] + s.at(-1)[k[1]] - s[0][k[0]];
    const gap = (span - s.reduce((a, o) => a + o[k[1]], 0)) / (s.length - 1);
    let at = s[0][k[0]];
    for (const o of s) { o[k[0]] = r2(at); at += o[k[1]] + gap; }
  }
  drawBoard(); renderProps(); commit();
}

function deleteSelected() {
  const t = lt();
  t.objects = t.objects.filter((o) => !pz.sel.has(o.id) || o.locked);
  pz.sel = new Set([...pz.sel].filter((id) => objById(id)));
  drawBoard(); renderProps(); renderLayers(); commit();
}
function duplicateSelected(dx = 2, dy = 2, list = selected()) {
  const t = lt();
  const copies = list.map((o) => ({ ...structuredClone(o), id: uid('o'), x: r2(o.x + dx), y: r2(o.y + dy), locked: false }));
  t.objects.push(...copies);
  pz.sel = new Set(copies.map((o) => o.id));
  drawBoard(); renderProps(); renderLayers(); commit();
}

document.querySelector('.lz-arrange').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.align) return alignSelected(b.dataset.align);
  const t = lt();
  if (b.dataset.order) {
    const sel = t.objects.filter((o) => pz.sel.has(o.id)), rest = t.objects.filter((o) => !pz.sel.has(o.id));
    t.objects = b.dataset.order === 'front' ? [...rest, ...sel] : [...sel, ...rest];
    drawBoard(); renderLayers(); commit();
    return;
  }
  switch (b.id) {
    case 'lz-undo': return undoRedo(-1);
    case 'lz-redo': return undoRedo(1);
    case 'lz-del': return deleteSelected();
    case 'lz-dup': return duplicateSelected();
    case 'lz-lock': { const sel = selected(); const v = !sel.every((o) => o.locked); for (const o of sel) o.locked = v; drawBoard(); renderProps(); renderLayers(); return commit(); }
    case 'lz-rot90': { for (const o of selected().filter((x) => !x.locked)) { o.rot = (((o.rot || 0) + 90 + 180) % 360) - 180; } drawBoard(); renderProps(); return commit(); }
    case 'lz-zin': return setZoom(pz.zoom * 1.25);
    case 'lz-zout': return setZoom(pz.zoom / 1.25);
    case 'lz-zfit': return zoomFit();
    default:
  }
});
$('#lz-grid').addEventListener('change', (e) => { pz.grid = e.target.checked; drawBoard(); });
$('#lz-snap').addEventListener('change', (e) => { pz.snap = e.target.checked; });
$('#lz-step').addEventListener('change', (e) => { pz.step = Number(e.target.value); drawBoard(); });
$('#lz-sample').addEventListener('change', (e) => { pz.sample = Number(e.target.value); drawBoard(); });
$('#lz-raw').addEventListener('change', (e) => { pz.raw = e.target.checked; drawBoard(); });

$('#lz-tools').addEventListener('click', (e) => {
  const tok = e.target.closest('[data-ftoken]');
  if (tok) { pz.fieldTool = tok.dataset.ftoken; $('#lz-fieldmenu').hidden = true; $('#lz-status').textContent = `Поле {${pz.fieldTool}}: щёлкните на этикетке или протяните рамку`; return; }
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  if (b.dataset.tool === 'field') pz.fieldTool = null;
  setTool(b.dataset.tool);
});

/* ---------- Шаблоны ---------- */
$('#lz-template').addEventListener('change', (e) => { pz.cur = e.target.value; pz.sel.clear(); pz.zoom = 0; renderLabelEditor(); commit(); });
$('#lz-name').addEventListener('input', (e) => { lt().name = e.target.value; markPzDirty(); });
$('#lz-name').addEventListener('change', () => { renderLabelEditorBar(); commit(); });
for (const id of ['#lz-w', '#lz-h']) {
  $(id).addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    if (!(v >= 10 && v <= 300)) { toast('Размер — от 10 до 300 мм', 'error'); return renderLabelEditor(); }
    lt()[id === '#lz-w' ? 'width' : 'height'] = r2(v);
    pz.zoom = 0; renderLabelEditor(); commit();
  });
}
$('#lz-preset').addEventListener('change', (e) => {
  if (!e.target.value) return;
  const [w, h] = e.target.value.split('x').map(Number);
  const t = lt();
  // Объекты масштабируются вместе с этикеткой.
  const kx = w / t.width, ky = h / t.height;
  for (const o of t.objects) {
    o.x = r2(o.x * kx); o.y = r2(o.y * ky); o.w = r2(o.w * kx); o.h = r2(o.h * ky);
    if (o.type === 'text') o.size = r2(Math.max(4, o.size * Math.min(kx, ky)));
    if (o.type === 'barcode' && o.kind === 'qr') o.h = o.w = r2(Math.min(o.w, o.h));
  }
  t.width = w; t.height = h;
  e.target.value = '';
  pz.zoom = 0; renderLabelEditor(); commit();
});
$('#lz-rotate').addEventListener('change', (e) => { lt().rotate = Number(e.target.value); commit(); });
$('#lz-border').addEventListener('change', (e) => { lt().border = e.target.checked; drawBoard(); commit(); });
$('#lz-new').addEventListener('click', () => {
  const t = lt();
  const n = { id: uid('t'), name: `Новая этикетка ${t.width}×${t.height}`, width: t.width, height: t.height, rotate: 0, border: false, objects: [] };
  pz.labels.list.push(n);
  pz.cur = n.id; pz.sel.clear(); pz.zoom = 0;
  renderLabelEditor(); commit();
  setTool('text');
});
$('#lz-copy').addEventListener('click', () => {
  const t = structuredClone(lt());
  t.id = uid('t'); t.name = `${t.name} (копия)`;
  for (const o of t.objects) o.id = uid('o');
  pz.labels.list.push(t);
  pz.cur = t.id; pz.sel.clear();
  renderLabelEditor(); commit();
});
$('#lz-default').addEventListener('click', () => { pz.labels.default = lt().id; renderLabelEditor(); commit(); toast('Этот шаблон печатается по умолчанию'); });
$('#lz-delete').addEventListener('click', (e) => {
  if (pz.labels.list.length < 2) return toast('Должен остаться хотя бы один шаблон', 'error');
  const b = e.currentTarget;
  if (!b.classList.contains('danger')) { b.classList.add('danger'); b.textContent = 'Точно удалить?'; setTimeout(() => { b.classList.remove('danger'); b.textContent = 'Удалить'; }, 3000); return; }
  b.classList.remove('danger'); b.textContent = 'Удалить';
  pz.labels.list = pz.labels.list.filter((t) => t.id !== pz.cur);
  if (!pz.labels.list.some((t) => t.id === pz.labels.default)) pz.labels.default = pz.labels.list[0].id;
  pz.cur = pz.labels.default; pz.sel.clear(); pz.zoom = 0;
  renderLabelEditor(); commit();
});

/* ---------- Клавиатура ---------- */
document.addEventListener('keydown', (e) => {
  if (currentView !== 'print' || pz.tab !== 'label') return;
  const typing = e.target.matches('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return savePz(); }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (mod && (k === 'z' || k === 'я')) { e.preventDefault(); return undoRedo(e.shiftKey ? 1 : -1); }
  if (mod && (k === 'y' || k === 'н')) { e.preventDefault(); return undoRedo(1); }
  if (mod && (k === 'a' || k === 'ф')) { e.preventDefault(); pz.sel = new Set(lt().objects.map((o) => o.id)); drawOverlay(); renderProps(); return renderLayers(); }
  if (mod && (k === 'c' || k === 'с')) { pz.clip = structuredClone(selected()); return; }
  if (mod && (k === 'v' || k === 'м')) { if (pz.clip?.length) duplicateSelected(2, 2, pz.clip.map((o) => ({ ...o, x: o.x, y: o.y }))); return; }
  if (mod && (k === 'd' || k === 'в')) { e.preventDefault(); return duplicateSelected(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return deleteSelected(); }
  if (e.key === 'Escape') { setTool('select'); pz.sel.clear(); drawOverlay(); renderProps(); return renderLayers(); }
  if (e.key.startsWith('Arrow') && pz.sel.size) {
    e.preventDefault();
    const st = e.shiftKey ? 5 : e.altKey ? 0.1 : 0.5;
    const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    for (const o of selected().filter((x) => !x.locked)) { o.x = r2(o.x + dx); o.y = r2(o.y + dy); }
    moveRendered(); drawOverlay(); renderProps();
    clearTimeout(pz.nudgeTimer);
    pz.nudgeTimer = setTimeout(commit, 400);
    return;
  }
  if (mod) return;
  const tools = { v: 'select', t: 'text', f: 'field', b: 'barcode', q: 'qr', l: 'line', r: 'rect', e: 'ellipse', i: 'image', м: 'select', е: 'text', а: 'field', и: 'barcode', й: 'qr', д: 'line', к: 'rect', у: 'ellipse', ш: 'image' };
  if (tools[k]) { if (tools[k] === 'field') pz.fieldTool = null; setTool(tools[k]); }
});

$('.lz-sidetabs').addEventListener('click', (e) => { const b = e.target.closest('[data-side]'); if (b) showSide(b.dataset.side); });

/* =====================================================================
   ЧЕК ИЗ БЛОКОВ
   ===================================================================== */
const BLOCK_NAMES = { text: 'Текст', image: 'Картинка', line: 'Разделитель', items: 'Товары', totals: 'Итого', payments: 'Способы оплаты', customer: 'Покупатель и бонусы', code: 'Штрихкод / QR', spacer: 'Отступ' };
const BLOCK_DEFAULTS = {
  text: { text: 'Спасибо за покупку!', size: 10, align: 'center' }, image: { imageId: null, width: 60, align: 'center' }, line: { style: 'dashed' },
  items: { layout: 'two-lines', size: 9.5, align: 'left', nameBold: true }, totals: { size: 9.5, align: 'left', showDiscount: true, showBonus: true, totalSize: 15, label: 'ИТОГО' },
  payments: { size: 9, align: 'left' }, customer: { size: 9, align: 'left', showCard: true, showEarned: true, showBalance: true },
  code: { kind: 'code128', value: '{number}', height: 12, width: 80, showText: true, size: 8, align: 'center' }, spacer: { height: 3 },
};
const blockLabel = (b) => (b.type === 'text' ? (b.text.split('\n')[0] || 'Текст').slice(0, 40) : b.type === 'code' ? `${b.kind === 'qr' ? 'QR' : 'Штрихкод'}: ${b.value}` : BLOCK_NAMES[b.type]);

function sampleReceiptData() {
  const goods = catalog.list.filter((p) => !catalog.isGroup(p) && p.price > 0).slice(0, 3);
  const items = (goods.length ? goods : [{ name: 'Футболка белая', price: 1200, code: '00001', unit: 'шт' }, { name: 'Джинсы синие', price: 3500, code: '00002', unit: 'шт' }])
    .map((p, i) => ({ name: p.name, qty: i === 0 ? 2 : 1, price: p.discount > 0 ? salePrice(p) : p.price, code: p.code, unit: p.unit }));
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const bonus = Math.min(100, Math.floor(total * 0.1));
  return {
    id: 1024, created_at: Date.now(), total, discount: 300, bonus_spent: bonus, bonus_earned: Math.floor((total - bonus) * 0.05),
    cashier: session.user?.name || 'Кассир', register: 'Касса 1', shop: session.design?.name || 'Мой магазин',
    items, payments: [{ name: 'Наличные', amount: 1000 }, { name: 'МБАНК', amount: total - bonus - 1000 }].filter((p) => p.amount > 0),
    customer: { name: 'Айгерим Токтогулова', card: '35841023', bonus: 450, phone: '996700123456' },
  };
}

function renderReceiptEditor() {
  const r = pz.receipt;
  if (!r.blocks.some((b) => b.id === pz.rsel)) pz.rsel = null;
  $('#rz-list').innerHTML = r.blocks.map((b, i) => `<div class="rz-item ${b.id === pz.rsel ? 'on' : ''} ${b.hidden ? 'hid' : ''}" draggable="true" data-bid="${esc(b.id)}">
      <span class="grip" title="Перетащите">⠿</span><span>${esc(blockLabel(b))}</span>
      <span class="tools"><button type="button" data-bup="${i}" title="Выше">↑</button><button type="button" data-bdown="${i}" title="Ниже">↓</button><button type="button" data-bhide="${i}" title="Показать / скрыть">${b.hidden ? '🙈' : '👁'}</button></span></div>`).join('');
  renderReceiptPreview();
  renderReceiptProps();
}

function renderReceiptPreview() {
  const r = pz.receipt;
  const frame = $('#rz-frame');
  const data = sampleReceiptData();
  const vals = receiptValues(data);
  const body = `<div class="rc">${r.blocks.map((b) => `<div data-bid="${esc(b.id)}" class="pv ${b.id === pz.rsel ? 'pv-on' : ''}">${receiptBlockHtml(b, data, vals, r) || (b.hidden ? '' : `<div class="pv-empty">${esc(BLOCK_NAMES[b.type])}</div>`)}</div>`).join('')}</div>`;
  const css = receiptCss(r) + ` body { padding: ${r.margin}mm 0; } .pv { cursor: pointer; outline-offset: 0.5mm; } .pv:hover { outline: 1px dashed #8aa0ff; } .pv-on { outline: 2px solid #4f6bed !important; } .pv-empty { color: #aaa; font: 9pt Arial; text-align: center; border: 1px dashed #ccc; }`;
  frame.style.width = `${r.paper * PX_MM}px`;
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
  frame.onload = () => {
    const doc = frame.contentDocument;
    frame.style.height = `${doc.documentElement.scrollHeight}px`;
    const k = r.paper === 80 ? 1.2 : 1.5;
    $('#rz-paper').style.transform = `scale(${k})`;
    $('#rz-paper').style.marginBottom = `${frame.offsetHeight * (k - 1)}px`;
    $('#rz-paper').style.marginInline = `${(frame.offsetWidth * (k - 1)) / 2}px`;
    doc.addEventListener('click', (e) => { const el = e.target.closest('[data-bid]'); if (el) { pz.rsel = el.dataset.bid; renderReceiptEditor(); } });
  };
  $('#rz-title').textContent = `Чек на ленте ${r.paper} мм — пример с товарами из вашего справочника`;
}

function renderReceiptProps() {
  const r = pz.receipt;
  const b = r.blocks.find((x) => x.id === pz.rsel);
  const rtokens = (t) => `<select class="input" data-rinsert="${t}"><option value="">＋ Вставить поле…</option>${RECEIPT_TOKENS.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select>`;
  const bnum = (p, v, label, step = 0.5) => `<div class="field"><label>${label}</label><input class="input num" data-rp="${p}" data-num="1" data-step="${step}" value="${v}" inputmode="decimal"></div>`;
  const tog = (p, on, label, title) => `<button type="button" data-rtog="${p}" aria-pressed="${Boolean(on)}" title="${title || ''}">${label}</button>`;
  const set = (p, v, cur, label) => `<button type="button" data-rset="${p}" data-v="${v}" aria-pressed="${cur === v}">${label}</button>`;
  const chk = (p, on, label) => `<label class="check"><input type="checkbox" data-rchk="${p}" ${on ? 'checked' : ''}> ${label}</label>`;
  let h = `<h3>Чек целиком</h3>
    <div class="lz-grid2"><div class="field"><label>Лента</label><select class="input" data-rg="paper"><option value="58">58 мм</option><option value="80">80 мм</option></select></div>
      <div class="field"><label>Шрифт</label><select class="input" data-rg="font">${FONT_OPTIONS()}</select></div></div>
    <div class="lz-grid2"><div class="field"><label>Поля, мм</label><input class="input num" data-rg="margin" data-num="1" value="${r.margin}"></div>
      <div class="field"><label>Межстрочный</label><input class="input num" data-rg="lineHeight" data-num="1" value="${r.lineHeight}"></div></div>
    <div class="field"><label>После продажи на кассе</label><select class="input" data-rg="autoPrint"><option value="off">Не печатать — кнопкой «Печать чека»</option><option value="ask">Спрашивать кассира</option><option value="always">Печатать сразу</option></select></div>
    <div class="field"><label>Копий</label><select class="input" data-rg="copies"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></div>`;
  if (b) {
    h += `<h3>Блок: ${BLOCK_NAMES[b.type]}</h3>`;
    if (b.type === 'text') h += `<div class="field"><label>Текст и поля</label><textarea class="input" data-rp="text" rows="4">${esc(b.text)}</textarea>${rtokens('text')}</div>`;
    if (b.type === 'code') {
      h += `<div class="field"><label>Вид</label><select class="input" data-rp="kind"><option value="code128">Code 128 (номер чека — для возврата по сканеру)</option><option value="qr">QR-код (ссылка на Instagram, витрину, отзыв)</option><option value="ean13">EAN-13</option></select></div>
        <div class="field"><label>Что закодировать</label><input class="input" data-rp="value" value="${esc(b.value)}">${rtokens('value')}</div>
        <div class="lz-grid2">${bnum('width', b.width, 'Ширина, %', 5)}${b.kind === 'qr' ? '' : bnum('height', b.height, 'Высота, мм', 1)}</div>${b.kind === 'qr' ? '' : chk('showText', b.showText, 'Цифры под штрихкодом')}`;
    }
    if (b.type === 'image') h += `<div class="lz-btns"><button type="button" data-rimg="1">🖼 ${b.imageId ? 'Заменить' : 'Загрузить'} картинку</button></div>${bnum('width', b.width, 'Ширина, % ленты', 5)}`;
    if (b.type === 'line') h += `<div class="field"><span class="lab">Вид</span><div class="lz-btns">${set('style', 'dashed', b.style, '- - -')}${set('style', 'solid', b.style, '———')}${set('style', 'double', b.style, '═══')}${set('style', 'dotted', b.style, '· · ·')}${set('style', 'stars', b.style, '* * *')}</div></div>`;
    if (b.type === 'spacer') h += bnum('height', b.height, 'Высота, мм', 1);
    if (b.type === 'items') {
      h += `<div class="field"><span class="lab">Как печатать товары</span><div class="lz-btns">${set('layout', 'two-lines', b.layout, 'Название / цена × кол-во')}${set('layout', 'one-line', b.layout, 'В одну строку')}${set('layout', 'table', b.layout, 'Таблицей')}</div></div>
        ${chk('nameBold', b.nameBold, 'Название жирным')}${chk('numbered', b.numbered, 'Нумерация 1, 2, 3')}${chk('showCode', b.showCode, 'Код товара')}${chk('showUnit', b.showUnit, 'Единица (шт, кг)')}`;
    }
    if (b.type === 'totals') h += `<div class="field"><label>Подпись итога</label><input class="input" data-rp="label" value="${esc(b.label)}" maxlength="40"></div>${bnum('totalSize', b.totalSize, 'Размер итога, пт', 1)}${chk('showSubtotal', b.showSubtotal, 'Сумма до скидки')}${chk('showDiscount', b.showDiscount, 'Скидка')}${chk('showBonus', b.showBonus, 'Оплачено бонусами')}`;
    if (b.type === 'customer') h += `${chk('showCard', b.showCard, 'Номер карты')}${chk('showPhone', b.showPhone, 'Телефон')}${chk('showEarned', b.showEarned, 'Начислено бонусов')}${chk('showBalance', b.showBalance, 'Бонусов на карте')}`;
    if (!['image', 'line', 'spacer'].includes(b.type)) {
      h += `<div class="lz-grid2">${bnum('size', b.size, 'Размер шрифта, пт')}<span></span></div>
        <div class="lz-btns">${tog('bold', b.bold, '<b>Ж</b>', 'Жирный')}${tog('italic', b.italic, '<i>К</i>', 'Курсив')}${tog('upper', b.upper, 'АА', 'Заглавными')}${tog('invert', b.invert, '◼', 'Белым по чёрному')}</div>`;
    }
    if (!['line', 'spacer'].includes(b.type)) h += `<div class="field"><span class="lab">Выравнивание</span><div class="lz-btns">${set('align', 'left', b.align, '⯇ Слева')}${set('align', 'center', b.align, '≡ Центр')}${set('align', 'right', b.align, 'Справа ⯈')}</div></div>`;
    h += `<div class="lz-btns"><button type="button" data-rdup="1">⧉ Дублировать</button><button type="button" data-rdel="1" class="danger-text">🗑 Удалить блок</button></div>`;
  } else {
    h += '<p class="lz-hint">Нажмите на блок слева или прямо на чеке, чтобы настроить его. Поля в тексте пишутся в фигурных скобках: <code>Кассир: {cashier}</code>.</p>';
  }
  $('#rz-props').innerHTML = h;
  for (const el of $('#rz-props').querySelectorAll('select[data-rg]')) el.value = String(r[el.dataset.rg]);
  if (b) for (const el of $('#rz-props').querySelectorAll('select[data-rp]')) el.value = b[el.dataset.rp];
}

const curBlock = () => pz.receipt.blocks.find((x) => x.id === pz.rsel);
$('#rz-props').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.rg) { const v = el.dataset.num || el.dataset.rg === 'paper' || el.dataset.rg === 'copies' ? parseNum(el.value) : el.value; if (Number.isNaN(v)) return; pz.receipt[el.dataset.rg] = v; }
  else if (el.dataset.rp) { const v = el.dataset.num ? parseNum(el.value) : el.value; if (Number.isNaN(v)) return; curBlock()[el.dataset.rp] = v; if (el.dataset.rp === 'kind') renderReceiptProps(); }
  else return;
  renderReceiptPreview();
  if (el.dataset.rp === 'text' || el.dataset.rp === 'value') $(`#rz-list [data-bid="${CSS.escape(pz.rsel)}"] span:nth-child(2)`).textContent = blockLabel(curBlock());
  markPzDirty();
});
$('#rz-props').addEventListener('change', (e) => {
  const el = e.target, b = curBlock();
  if (el.dataset.rchk) { b[el.dataset.rchk] = el.checked; renderReceiptPreview(); }
  if (el.dataset.rinsert && el.value) {
    const f = $(`#rz-props [data-rp="${el.dataset.rinsert}"]`);
    const s = f.selectionStart ?? f.value.length, en = f.selectionEnd ?? f.value.length;
    f.value = f.value.slice(0, s) + `{${el.value}}` + f.value.slice(en);
    b[el.dataset.rinsert] = f.value;
    el.value = '';
    renderReceiptEditor();
  }
  markPzDirty();
});
$('#rz-props').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const b = curBlock();
  if (t.dataset.rtog) b[t.dataset.rtog] = !b[t.dataset.rtog];
  else if (t.dataset.rset) b[t.dataset.rset] = t.dataset.v;
  else if (t.dataset.rdel) { pz.receipt.blocks = pz.receipt.blocks.filter((x) => x !== b); pz.rsel = null; }
  else if (t.dataset.rdup) { const c = { ...structuredClone(b), id: uid('b') }; pz.receipt.blocks.splice(pz.receipt.blocks.indexOf(b) + 1, 0, c); pz.rsel = c.id; }
  else if (t.dataset.rimg) {
    const file = await pickFile();
    if (!file) return;
    try {
      const { id } = await api('/api/images', { method: 'POST', body: { mime: 'image/png', data: await shrinkPhoto(file, 800, 'image/png') } });
      b.imageId = id;
    } catch (err) { return toast(err.message, 'error'); }
  } else return;
  renderReceiptEditor();
  markPzDirty();
});
$('#rz-add').addEventListener('change', (e) => {
  const type = e.target.value;
  if (!type) return;
  const b = { id: uid('b'), type, hidden: false, align: 'center', size: 9.5, bold: false, italic: false, upper: false, invert: false, ...BLOCK_DEFAULTS[type] };
  const at = pz.rsel ? pz.receipt.blocks.findIndex((x) => x.id === pz.rsel) + 1 : pz.receipt.blocks.length;
  pz.receipt.blocks.splice(at, 0, b);
  pz.rsel = b.id;
  e.target.value = '';
  renderReceiptEditor();
  markPzDirty();
});
$('#rz-list').addEventListener('click', (e) => {
  const blocks = pz.receipt.blocks;
  const up = e.target.closest('[data-bup]'), down = e.target.closest('[data-bdown]'), hide = e.target.closest('[data-bhide]');
  const swap = (i, j) => { if (j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; };
  if (up) swap(Number(up.dataset.bup), Number(up.dataset.bup) - 1);
  else if (down) swap(Number(down.dataset.bdown), Number(down.dataset.bdown) + 1);
  else if (hide) blocks[Number(hide.dataset.bhide)].hidden = !blocks[Number(hide.dataset.bhide)].hidden;
  else { const row = e.target.closest('[data-bid]'); if (!row) return; pz.rsel = row.dataset.bid; }
  renderReceiptEditor();
  markPzDirty();
});
// Перетаскивание блоков мышью.
let rzDrag = null;
$('#rz-list').addEventListener('dragstart', (e) => { rzDrag = e.target.closest('[data-bid]')?.dataset.bid; e.dataTransfer.effectAllowed = 'move'; });
$('#rz-list').addEventListener('dragover', (e) => {
  e.preventDefault();
  for (const el of $('#rz-list').querySelectorAll('.drag-over')) el.classList.remove('drag-over');
  e.target.closest('[data-bid]')?.classList.add('drag-over');
});
$('#rz-list').addEventListener('drop', (e) => {
  e.preventDefault();
  const to = e.target.closest('[data-bid]')?.dataset.bid;
  const blocks = pz.receipt.blocks;
  const from = blocks.findIndex((b) => b.id === rzDrag);
  if (from < 0 || !to || to === rzDrag) return renderReceiptEditor();
  const [b] = blocks.splice(from, 1);
  blocks.splice(blocks.findIndex((x) => x.id === to), 0, b);
  rzDrag = null;
  renderReceiptEditor();
  markPzDirty();
});

/* =====================================================================
   Сохранение и пробная печать
   ===================================================================== */
async function savePz() {
  try {
    const kind = pz.tab === 'label' ? 'labels' : 'receipt';
    const all = await api(`/api/print-designs/${kind}`, { method: 'PUT', body: pz.tab === 'label' ? pz.labels : pz.receipt });
    printDesignsCache = all;
    const saved = JSON.parse(pz.saved);
    if (kind === 'labels') { pz.labels = structuredClone(all.labels); saved.labels = all.labels; } else { pz.receipt = structuredClone(all.receipt); saved.receipt = all.receipt; }
    pz.saved = JSON.stringify(saved);
    toast(kind === 'labels' ? 'Шаблоны этикеток сохранены' : 'Шаблон чека сохранён');
    if (kind === 'labels') { pz.hist = []; pz.hi = -1; commit(); renderLabelEditor(); } else renderReceiptEditor();
    markPzDirty();
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('#pz-save').addEventListener('click', savePz);
$('#pz-test').addEventListener('click', () => {
  if (pz.tab === 'receipt') return printHtml(receiptHtml(pz.receipt, sampleReceiptData()), receiptCss(pz.receipt), 'Пробный чек');
  const t = lt();
  const html = renderLabelsForPrint(t, [sampleProduct()], session.design?.name || '');
  printHtml(`<div class="sheet">${html.map((h) => `<div class="page"><div class="lbl">${h}</div></div>`).join('')}</div>`, labelPrintCss(t), 'Пробная этикетка');
});
$('#pz-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-pz-tab]'); if (b) showPzTab(b.dataset.pzTab); });
addEventListener('resize', () => { if (currentView === 'print' && pz.tab === 'label' && pz.labels) drawBoard(); });

views.print = { show: renderPrintDesigner, right: 'print.design' };
