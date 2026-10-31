'use strict';

// Конструктор чека покупателю и этикеток: настройки слева, живой предпросмотр справа (в масштабе, по миллиметрам).

const pd = { tab: 'receipt', saved: null, draft: null, sizes: {}, sample: null };
const MM = 96 / 25.4; // пикселей в миллиметре на экране

async function renderPrintDesigner() {
  try {
    const all = await printDesigns(true);
    pd.saved = { receipt: all.receipt, label: all.label };
    pd.sizes = all.labelSizes;
    await catalog.load();
  } catch (err) {
    return toast(err.message, 'error');
  }
  pd.draft = structuredClone(pd.saved);
  fillPrintForm();
  showPdTab(pd.tab);
}

function showPdTab(tab) {
  pd.tab = tab;
  for (const b of document.querySelectorAll('[data-pd-tab]')) b.setAttribute('aria-pressed', String(b.dataset.pdTab === tab));
  $('#pd-receipt').hidden = tab !== 'receipt';
  $('#pd-label').hidden = tab !== 'label';
  $('#pd-error').hidden = true;
  renderPdPreview();
  markPdDirty();
}

function fillPrintForm() {
  const f = $('#pd-form');
  const r = pd.draft.receipt, l = pd.draft.label;
  for (const el of $('#pd-receipt').querySelectorAll('[name]')) {
    if (el.type === 'checkbox') el.checked = Boolean(r[el.name]);
    else el.value = r[el.name] ?? '';
  }
  $('#pd-size').innerHTML = Object.keys(pd.sizes).map((k) => `<option value="${k}">${k.replace('x', ' × ')} мм</option>`).join('') + '<option value="custom">Свой размер</option>';
  for (const el of $('#pd-label').querySelectorAll('[name]')) {
    if (el.type === 'checkbox') el.checked = Boolean(l[el.name]);
    else el.value = l[el.name] ?? '';
  }
  $('#pd-custom').hidden = l.size !== 'custom';
  // Пример для этикетки: товар со штрихкодом, лучше с модификацией и скидкой.
  const list = catalog.list.filter((p) => !catalog.isGroup(p)).slice(0, 300);
  const best = list.find((p) => p.barcode && p.parent_id) || list.find((p) => p.barcode) || list[0];
  $('#pd-sample').innerHTML = list.length
    ? list.map((p) => `<option value="${p.id}" ${p === best ? 'selected' : ''}>${esc(p.name)}${p.barcode ? '' : ' (без штрихкода)'}</option>`).join('')
    : '<option value="">Пример: товаров пока нет</option>';
  renderPdLogo();
  renderPdFields();
  f.dataset.ready = '1';
}

function renderPdLogo() {
  const id = pd.draft.receipt.logoId;
  $('#pd-logo').innerHTML = id
    ? `<img src="/img/${id}" alt=""><button type="button" class="btn small ghost" data-pd-logo-del>Убрать</button>`
    : '<button type="button" class="btn small" data-pd-logo-add>Загрузить</button>';
}

function renderPdFields() {
  const fields = pd.draft.label.fields;
  $('#pd-fields').innerHTML = fields.map((f, i) => `<div class="pd-field ${f.on ? '' : 'off'}">
      <input type="checkbox" data-pdf-on="${i}" ${f.on ? 'checked' : ''} aria-label="Печатать: ${esc(LABEL_FIELD_NAMES[f.key])}">
      <span>${esc(LABEL_FIELD_NAMES[f.key])}</span>
      <input class="input num" data-pdf-size="${i}" value="${f.size}" inputmode="decimal" aria-label="Размер шрифта, пт" ${f.key === 'barcode' ? 'title="Размер цифр под штрихкодом"' : ''}>
      <button type="button" class="btn small ghost" data-pdf-bold="${i}" aria-pressed="${f.bold}" title="Жирный">Ж</button>
      <button type="button" class="btn small ghost" data-pdf-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
      <button type="button" class="btn small ghost" data-pdf-down="${i}" ${i === fields.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
    </div>`).join('');
}

// Пример чека для предпросмотра: три товара из справочника, покупатель с бонусами, смешанная оплата.
function sampleReceipt() {
  const goods = catalog.list.filter((p) => !catalog.isGroup(p) && p.price > 0).slice(0, 3);
  const items = (goods.length ? goods : [{ name: 'Футболка белая', price: 1200, code: '00001' }, { name: 'Джинсы синие', price: 3500, code: '00002' }])
    .map((p, i) => ({ name: p.name, qty: i === 0 ? 2 : 1, price: p.price, code: p.code }));
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const bonus = Math.min(100, Math.floor(total * 0.1));
  return {
    id: 1024, created_at: Date.now(), total, discount: 0, bonus_spent: bonus, bonus_earned: Math.floor((total - bonus) * 0.05),
    cashier: session.user?.name || 'Кассир', register: 'Касса 1', shop: session.design?.name || 'Мой магазин',
    items, payments: [{ name: 'Наличные', amount: 1000 }, { name: 'МБАНК', amount: total - bonus - 1000 }].filter((p) => p.amount > 0),
    customer: { name: 'Айгерим Токтогулова', card: '35841023', bonus: 450 },
  };
}

function renderPdPreview() {
  if (!pd.draft) return;
  const frame = $('#pd-frame');
  let css, body, wMm, hMm, scale;
  if (pd.tab === 'receipt') {
    const d = pd.draft.receipt;
    css = receiptCss(d) + ' body { padding: 3mm 0; }';
    body = receiptHtml(d, sampleReceipt());
    wMm = d.paper; hMm = null; scale = d.paper === 80 ? 1.15 : 1.4;
    $('#pd-preview-title').textContent = `Чек на ленте ${d.paper} мм`;
    $('#pd-preview-note').textContent = 'Пример: товары из вашего справочника, покупатель для примера. Чек — товарный, не фискальный.';
  } else {
    const d = pd.draft.label;
    const p = catalog.list.find((x) => x.id === Number($('#pd-sample').value)) || { name: 'Платье летнее', price: 2500, discount: 20, barcode: '2000000000015', code: '00015', article: 'PL-15', category: 'Платья', options: { Цвет: 'Красный', Размер: 'M' } };
    css = labelCss(d) + ' .lb { page-break-after: auto; }';
    body = labelHtml(d, p, { shop: session.design?.name || 'Мой магазин' });
    wMm = d.width; hMm = d.height; scale = Math.min(4, 340 / (d.width * MM));
    $('#pd-preview-title').textContent = `Этикетка ${d.width} × ${d.height} мм`;
    $('#pd-preview-note').textContent = 'Так этикетка выглядит в увеличении. Что не поместилось — обрежется: уменьшите шрифт или уберите поле.';
  }
  frame.style.width = `${wMm * MM}px`;
  frame.style.height = hMm ? `${hMm * MM}px` : '200px';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
  frame.onload = () => {
    if (!hMm) frame.style.height = `${frame.contentDocument.documentElement.scrollHeight}px`;
    const paper = $('#pd-paper');
    paper.style.transform = `scale(${scale})`;
    // Масштаб не меняет место в разметке — добавляем отступ снизу, чтобы увеличенный лист не наезжал.
    paper.style.marginBottom = `${frame.offsetHeight * (scale - 1)}px`;
    paper.style.marginInline = `${(frame.offsetWidth * (scale - 1)) / 2}px`;
  };
}

function markPdDirty() {
  const dirty = JSON.stringify(pd.draft?.[pd.tab]) !== JSON.stringify(pd.saved?.[pd.tab]);
  $('#pd-dirty').textContent = dirty ? 'Есть несохранённые изменения' : 'Всё сохранено';
}

function readPdForm() {
  const r = pd.draft.receipt, l = pd.draft.label;
  for (const el of $('#pd-receipt').querySelectorAll('[name]')) r[el.name] = el.type === 'checkbox' ? el.checked : el.name === 'paper' || el.name === 'copies' ? Number(el.value) : el.value;
  for (const el of $('#pd-label').querySelectorAll('[name]')) l[el.name] = el.type === 'checkbox' ? el.checked : ['width', 'height', 'barcodeHeight'].includes(el.name) ? parseNum(el.value) || 0 : el.value;
  if (l.size !== 'custom' && pd.sizes[l.size]) [l.width, l.height] = pd.sizes[l.size];
  $('#pd-custom').hidden = l.size !== 'custom';
}

function onPdChange(e) {
  const t = e.target;
  const i = Number(t.dataset.pdfOn ?? t.dataset.pdfSize);
  if (t.dataset.pdfOn !== undefined) { pd.draft.label.fields[i].on = t.checked; t.closest('.pd-field').classList.toggle('off', !t.checked); }
  else if (t.dataset.pdfSize !== undefined) pd.draft.label.fields[i].size = parseNum(t.value) || pd.draft.label.fields[i].size;
  else if (t.id !== 'pd-sample') {
    const before = pd.draft.label.height;
    readPdForm();
    // Другой размер этикетки — шрифты и штрихкод меняются в той же пропорции, чтобы всё поместилось.
    const k = pd.draft.label.height / before;
    if (t.name === 'size' && k && k !== 1 && pd.draft.label.size !== 'custom') {
      for (const f of pd.draft.label.fields) f.size = Math.max(5, Math.round(f.size * k * 2) / 2);
      pd.draft.label.barcodeHeight = Math.max(5, Math.round(pd.draft.label.barcodeHeight * k));
      $('#pd-form').elements.barcodeHeight.value = pd.draft.label.barcodeHeight;
      renderPdFields();
    }
  }
  if (t.name === 'size' && pd.draft.label.size !== 'custom') {
    $('#pd-form').elements.width.value = pd.draft.label.width;
    $('#pd-form').elements.height.value = pd.draft.label.height;
  }
  renderPdPreview();
  markPdDirty();
}
$('#pd-form').addEventListener('input', onPdChange);
$('#pd-form').addEventListener('change', onPdChange);

$('#pd-form').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const fields = pd.draft.label.fields;
  const move = (i, to) => { const [x] = fields.splice(i, 1); fields.splice(to, 0, x); };
  if (t.dataset.pdfBold !== undefined) fields[Number(t.dataset.pdfBold)].bold = !fields[Number(t.dataset.pdfBold)].bold;
  else if (t.dataset.pdfUp !== undefined) move(Number(t.dataset.pdfUp), Number(t.dataset.pdfUp) - 1);
  else if (t.dataset.pdfDown !== undefined) move(Number(t.dataset.pdfDown), Number(t.dataset.pdfDown) + 1);
  else if (t.dataset.pdLogoDel !== undefined) { pd.draft.receipt.logoId = null; renderPdLogo(); }
  else if (t.dataset.pdLogoAdd !== undefined) {
    const file = await pickFile();
    if (!file) return;
    try {
      const { id } = await api('/api/images', { method: 'POST', body: { mime: 'image/png', data: await shrinkPhoto(file, 600, 'image/png') } });
      pd.draft.receipt.logoId = id;
      renderPdLogo();
    } catch (err) {
      return toast(err.message, 'error');
    }
  } else if (t.id === 'pd-test') {
    return pdTestPrint();
  } else return;
  if (t.dataset.pdfBold !== undefined || t.dataset.pdfUp !== undefined || t.dataset.pdfDown !== undefined) renderPdFields();
  renderPdPreview();
  markPdDirty();
});

// Пробная печать — по черновику, ещё до сохранения.
function pdTestPrint() {
  if (pd.tab === 'receipt') {
    const d = pd.draft.receipt;
    return printHtml(receiptHtml(d, sampleReceipt()), receiptCss(d), 'Пробный чек');
  }
  const d = pd.draft.label;
  const p = catalog.list.find((x) => x.id === Number($('#pd-sample').value));
  if (!p) return toast('Выберите товар для примера', 'error');
  printHtml(`<div class="sheet">${labelHtml(d, p, { shop: session.design?.name || '' })}</div>`, labelCss(d), 'Пробная этикетка');
}

$('#pd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pd-error').hidden = true;
  try {
    const all = await api(`/api/print-designs/${pd.tab}`, { method: 'PUT', body: pd.draft[pd.tab] });
    pd.saved[pd.tab] = all[pd.tab];
    pd.draft[pd.tab] = structuredClone(all[pd.tab]);
    printDesignsCache = all;
    toast(pd.tab === 'receipt' ? 'Шаблон чека сохранён' : 'Шаблон этикетки сохранён');
    markPdDirty();
  } catch (err) {
    showFormError('#pd-error', err);
  }
});

$('#pd-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pd-tab]');
  if (b) showPdTab(b.dataset.pdTab);
});

views.print = { show: renderPrintDesigner, right: 'print.design' };
