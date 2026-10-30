'use strict';

// Штрихкоды EAN-13 и печать этикеток: название, цена и штрихкод.

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = EAN_L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).reverse().join(''));
const EAN_R = EAN_L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).join(''));
// Какие цифры левой половины кодируются набором G — определяется первой цифрой.
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function eanValid(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

// SVG штрихкода EAN-13 или null, если код не EAN-13.
// module — ширина самой узкой полосы в миллиметрах для печати. Термопринтер печатает точками
// (203 точки на дюйм = 0,125 мм), и полоса ровно в целое число точек выходит чёткой —
// так сканер читает код увереннее. Без module картинка подстраивается под место на экране.
function barcodeSvg(code, { height = 50, module = 0, barsMm = 0 } = {}) {
  if (!eanValid(code)) return null;
  const d = [...code].map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (EAN_PARITY[d[0]][i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]];
  bits += '101';
  // Охранные полосы (по краям и в середине) длиннее остальных, под ними — цифры.
  const guard = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  const quiet = 9;
  const width = bits.length + quiet * 2;
  let bars = '';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') bars += `<rect x="${i + quiet}" y="0" width="1" height="${guard.has(i) ? height + 5 : height}"/>`;
  }
  const t = (x, s) => `<text x="${x}" y="${height + 12}" font-size="10" text-anchor="middle">${s}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 14}"${module ? ` width="${(width * module).toFixed(3)}mm" height="${barsMm}mm" preserveAspectRatio="none"` : ''} shape-rendering="crispEdges" class="barcode" role="img" aria-label="Штрихкод ${code}">
    <rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g>
    <g font-family="monospace" fill="#000">${t(4, code[0])}${t(quiet + 3 + 21, code.slice(1, 7))}${t(quiet + 50 + 21, code.slice(7))}</g></svg>`;
}

// module: 3 точки термоголовки 203 dpi = 0,375 мм — штрихкод 42 мм, помещается на 58 мм с полями.
// Для 40×30 — 2 точки (0,25 мм, код 28 мм). Для A4 (лазерный или струйный) — стандартные 0,33 мм.
const LABEL_FORMATS = {
  thermal: { name: 'Термопринтер 58×40 мм (Xprinter XP-365B и похожие)', page: '58mm 40mm', cols: 1, w: '58mm', h: '40mm', module: 0.375, bars: 13 },
  small: { name: 'Термопринтер 40×30 мм', page: '40mm 30mm', cols: 1, w: '40mm', h: '30mm', module: 0.25, bars: 9 },
  a4: { name: 'Лист A4, 3×8 наклеек', page: 'A4', cols: 3, w: '70mm', h: '37mm', module: 0.33, bars: 14 },
};

// Окно печати этикеток. items — [{ product, count }].
function printLabels(items, format = 'thermal', { showPrice = true } = {}) {
  const f = LABEL_FORMATS[format];
  const shop = session.design?.name || '';
  const labels = items.flatMap(({ product: p, count }) => Array.from({ length: count }, () => {
    const svg = p.barcode ? barcodeSvg(p.barcode, { module: f.module, barsMm: f.bars }) : null;
    return `<div class="label">
      <div class="shop">${esc(shop)}</div>
      <div class="name">${esc(p.name)}</div>
      ${showPrice ? `<div class="price">${money2(p.price)}</div>` : ''}
      ${svg || (p.barcode ? `<div class="code">${esc(p.barcode)}</div>` : '')}
    </div>`;
  })).join('');
  const win = window.open('', '_blank');
  if (!win) return toast('Браузер не дал открыть окно печати. Разрешите всплывающие окна для этого сайта.', 'error');
  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Этикетки</title><style>
    @page { size: ${f.page}; margin: ${format === 'a4' ? '8mm 0' : '0'}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, Arial, sans-serif; color: #000; }
    .sheet { display: grid; grid-template-columns: repeat(${f.cols}, ${f.w}); justify-content: center; }
    .label { width: ${f.w}; height: ${f.h}; padding: 1.5mm 3mm; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; break-inside: avoid; page-break-inside: avoid; ${f.cols === 1 ? 'page-break-after: always;' : ''} }
    /* После последней этикетки разрыв не нужен, иначе принтер прогонит пустую. */
    .label:last-child { page-break-after: auto; }
    /* Термопринтер не печатает серый — только чёрный. */
    .shop { font-size: 7pt; color: #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name { font-size: ${format === 'small' ? '7pt' : '8.5pt'}; font-weight: 600; line-height: 1.15; max-height: 2.4em; overflow: hidden; }
    .price { font-size: ${format === 'small' ? '12pt' : '15pt'}; font-weight: 800; }
    .barcode { display: block; margin: 0 auto; }
    .code { font: 9pt monospace; }
    .hint { font: 14px system-ui; padding: 12px; text-align: center; background: #fff7d6; }
    @media print { .hint { display: none; } }
  </style></head><body>
    <p class="hint">В окне печати выберите принтер, размер бумаги ${esc(f.name.split(' (')[0].replace(/^Термопринтер /, ''))}, поля «Нет», масштаб 100% и отключите «Верхние и нижние колонтитулы». Нажмите «Печать», если окно не открылось само.</p>
    <div class="sheet">${labels}</div>
    <script>addEventListener('load', () => setTimeout(() => print(), 300));<\/script>
  </body></html>`);
  win.document.close();
}

/* ---------- Окно «Печать этикеток» ---------- */
let labelsItems = [];

function openLabels(products) {
  labelsItems = products;
  const noCode = products.filter((p) => !p.barcode).length;
  $('#labels-sub').textContent = `${products.length} ${plural(products.length, ['товар', 'товара', 'товаров'])}` +
    (noCode ? `. У ${noCode} нет штрихкода — на этикетке будут только название и цена. Сгенерировать штрихкоды можно кнопкой «Штрихкоды».` : '');
  $('#labels-format').innerHTML = Object.entries(LABEL_FORMATS).map(([k, f]) => `<option value="${k}">${f.name}</option>`).join('');
  try { $('#labels-format').value = localStorage.getItem('labels.format') || 'thermal'; } catch { /* без памяти */ }
  $('#labels-dialog').showModal();
}

$('#labels-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const per = f.elements.count.value;
  const fixed = Math.max(1, Math.min(500, parseInt(f.elements.copies.value, 10) || 1));
  const items = labelsItems.map((p) => ({ product: p, count: per === 'stock' ? Math.max(0, Math.ceil(p.stock)) : fixed })).filter((i) => i.count);
  const total = items.reduce((s, i) => s + i.count, 0);
  if (!total) return toast('Нечего печатать: у выбранных товаров нет остатка', 'error');
  if (total > 2000) return toast(`Слишком много этикеток за раз (${total}). Выберите меньше товаров.`, 'error');
  try { localStorage.setItem('labels.format', f.elements.format.value); } catch { /* без памяти */ }
  printLabels(items, f.elements.format.value, { showPrice: f.elements.price.checked });
  $('#labels-dialog').close();
});
$('#labels-cancel')?.addEventListener('click', () => $('#labels-dialog').close());
$('#labels-form')?.addEventListener('change', (e) => {
  if (e.target.name === 'count') $('#labels-copies').hidden = e.target.value !== 'fixed';
});
