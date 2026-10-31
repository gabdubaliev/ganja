'use strict';

// Печать этикеток: название, цена и штрихкод (сам штрихкод — barcode.js).

// Этикетки печатаются по шаблону из конструктора («Ещё» → «Чеки и этикетки»), см. print.js.
// Здесь — окно выбора: сколько штук, на термопринтер (размер из шаблона) или на лист A4.
/* ---------- Окно «Печать этикеток» ---------- */
let labelsItems = [];

function openLabels(products) {
  labelsItems = products;
  const noCode = products.filter((p) => !p.barcode).length;
  $('#labels-sub').textContent = `${products.length} ${plural(products.length, ['товар', 'товара', 'товаров'])}` +
    (noCode ? `. У ${noCode} нет штрихкода — на этикетке будут только название и цена. Сгенерировать штрихкоды можно кнопкой «Штрихкоды».` : '');
  printDesigns().then(({ label: d }) => {
    $('#labels-format').innerHTML = `<option value="thermal">Термопринтер ${d.width}×${d.height} мм (как в конструкторе)</option><option value="a4">Лист A4, 3×8 наклеек</option>`;
    try { $('#labels-format').value = localStorage.getItem('labels.format') === 'a4' ? 'a4' : 'thermal'; } catch { /* без памяти */ }
  }).catch((err) => toast(err.message, 'error'));
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
  const showPrice = f.elements.price.checked;
  printDesigns().then((all) => {
    // Без цены — поля «Цена» и «Старая цена» на этот раз не печатаются.
    if (!showPrice) printDesignsCache = { ...all, label: { ...all.label, fields: all.label.fields.map((x) => (['price', 'oldPrice'].includes(x.key) ? { ...x, on: false } : x)) } };
    return printLabelSheet(items, { sheet: f.elements.format.value === 'a4' }).finally(() => { printDesignsCache = all; });
  }).catch((err) => toast(err.message, 'error'));
  $('#labels-dialog').close();
});
$('#labels-cancel')?.addEventListener('click', () => $('#labels-dialog').close());
$('#labels-form')?.addEventListener('change', (e) => {
  if (e.target.name === 'count') $('#labels-copies').hidden = e.target.value !== 'fixed';
});
