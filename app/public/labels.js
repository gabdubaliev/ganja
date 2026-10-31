'use strict';

// Печать этикеток: название, цена и штрихкод (сам штрихкод — barcode.js).

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
