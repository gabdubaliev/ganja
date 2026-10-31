'use strict';

// Окно «Печать этикеток»: шаблон из конструктора («Ещё» → «Чеки и этикетки»), сколько штук,
// на термопринтер (рулон, размер из шаблона) или на лист A4. Сама печать — print.js.
/* ---------- Окно «Печать этикеток» ---------- */
let labelsItems = [];

function openLabels(products) {
  labelsItems = products;
  const noCode = products.filter((p) => !p.barcode).length;
  $('#labels-sub').textContent = `${products.length} ${plural(products.length, ['товар', 'товара', 'товаров'])}` +
    (noCode ? `. У ${noCode} нет штрихкода — на месте штрихкода будет пусто. Сгенерировать штрихкоды можно кнопкой «Штрихкоды».` : '');
  printDesigns().then(({ labels }) => {
    let saved = null;
    try { saved = localStorage.getItem('labels.template'); } catch { /* без памяти */ }
    const cur = labels.list.some((t) => t.id === saved) ? saved : labels.default;
    $('#labels-template').innerHTML = labels.list.map((t) => `<option value="${esc(t.id)}" ${t.id === cur ? 'selected' : ''}>${esc(t.name)} — ${t.width}×${t.height} мм${t.id === labels.default ? ' (основной)' : ''}</option>`).join('');
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
  try { localStorage.setItem('labels.format', f.elements.format.value); localStorage.setItem('labels.template', f.elements.template.value); } catch { /* без памяти */ }
  printLabelSheet(items, { templateId: f.elements.template.value, sheet: f.elements.format.value === 'a4' }).catch((err) => toast(err.message, 'error'));
  $('#labels-dialog').close();
});
$('#labels-cancel')?.addEventListener('click', () => $('#labels-dialog').close());
$('#labels-form')?.addEventListener('change', (e) => {
  if (e.target.name === 'count') $('#labels-copies').hidden = e.target.value !== 'fixed';
});
