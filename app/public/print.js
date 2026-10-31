'use strict';

// Печать по шаблонам из конструктора: чек покупателю (товарный, не фискальный) и этикетки на товар.
// Печатается через скрытую рамку на этой же странице — новая вкладка не открывается.

const LABEL_FIELD_NAMES = {
  shop: 'Название магазина', name: 'Название товара', options: 'Цвет, размер (модификация)', article: 'Артикул',
  code: 'Код товара', category: 'Категория', price: 'Цена', oldPrice: 'Старая цена (если скидка)', barcode: 'Штрихкод', text: 'Свой текст',
};
let printDesignsCache = null;
async function printDesigns(force = false) {
  if (!printDesignsCache || force) printDesignsCache = await api('/api/print-designs');
  return printDesignsCache;
}

// Печать готового HTML: скрытая рамка, окно печати браузера, рамка убирается после печати.
function printHtml(body, css, title = 'Печать') {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.setAttribute('aria-hidden', 'true');
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`);
  doc.close();
  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  // Картинки (логотип) должны успеть загрузиться.
  const imgs = [...doc.images].filter((i) => !i.complete);
  if (!imgs.length) setTimeout(go, 50);
  else Promise.all(imgs.map((i) => new Promise((ok) => { i.onload = ok; i.onerror = ok; }))).then(go);
}

/* ---------- Чек покупателю ---------- */
const RECEIPT_FONT = { small: 10, normal: 11.5, large: 13 };

function receiptCss(d) {
  const w = d.paper === 80 ? 72 : 48;
  return `@page { size: ${d.paper}mm auto; margin: 2mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; background: #fff; font: ${RECEIPT_FONT[d.fontSize] || 11.5}px/1.3 Arial, Helvetica, sans-serif; }
    .rc { width: ${w}mm; margin: 0 auto; }
    .rc-logo { display: block; max-width: 70%; max-height: 22mm; margin: 0 auto 2mm; }
    .rc-title { text-align: center; font-weight: 800; font-size: 1.35em; }
    .rc-head, .rc-foot { text-align: center; white-space: pre-line; }
    .rc-hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
    .rc-row { display: flex; justify-content: space-between; gap: 2mm; }
    .rc-row span:last-child { white-space: nowrap; text-align: right; }
    .rc-item { margin-bottom: 1mm; }
    .rc-item .n { font-weight: 600; }
    .rc-total { font-size: 1.45em; font-weight: 800; }
    .rc-meta { font-size: .92em; }
    .rc-refund { text-align: center; font-weight: 800; border: 1px solid #000; padding: 1mm; margin-bottom: 2mm; }`;
}

// data — из /api/sales/:id/receipt (или пример для предпросмотра).
function receiptHtml(d, data) {
  const m = (v) => money2(v);
  const date = new Date(data.created_at);
  const lines = [];
  if (d.logoId) lines.push(`<img class="rc-logo" src="/img/${d.logoId}" alt="">`);
  lines.push(`<div class="rc-title">${esc(d.title || data.shop || 'Магазин')}</div>`);
  if (d.header) lines.push(`<div class="rc-head">${esc(d.header)}</div>`);
  lines.push('<hr class="rc-hr">');
  if (data.refunded_at) lines.push('<div class="rc-refund">ВОЗВРАТ</div>');
  const meta = [];
  if (d.showNumber) meta.push(`<div class="rc-row"><span>Товарный чек</span><span>№ ${data.id}</span></div>`);
  if (d.showDate) meta.push(`<div class="rc-row"><span>Дата</span><span>${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></div>`);
  if (d.showCashier && data.cashier) meta.push(`<div class="rc-row"><span>Кассир</span><span>${esc(data.cashier)}</span></div>`);
  if (d.showRegister && data.register) meta.push(`<div class="rc-row"><span>Касса</span><span>${esc(data.register)}</span></div>`);
  if (meta.length) lines.push(`<div class="rc-meta">${meta.join('')}</div><hr class="rc-hr">`);
  for (const i of data.items) {
    lines.push(`<div class="rc-item"><div class="n">${esc(i.name)}${d.showItemCodes && i.code ? ` <span class="rc-meta">(${esc(i.code)})</span>` : ''}</div>
      <div class="rc-row"><span>${qtyFmt.format(i.qty)} × ${m(i.price)}</span><span>${m(i.qty * i.price)}</span></div></div>`);
  }
  lines.push('<hr class="rc-hr">');
  if (d.showDiscount && data.discount) lines.push(`<div class="rc-row"><span>Скидка</span><span>−${m(data.discount)}</span></div>`);
  if (d.showBonus && data.bonus_spent) lines.push(`<div class="rc-row"><span>Оплачено бонусами</span><span>−${m(data.bonus_spent)}</span></div>`);
  lines.push(`<div class="rc-row rc-total"><span>ИТОГО</span><span>${m(data.total - (data.bonus_spent || 0))}</span></div>`);
  if (d.showPayments && data.payments?.length) {
    lines.push(`<div class="rc-meta">${data.payments.map((p) => `<div class="rc-row"><span>${esc(p.name)}</span><span>${m(p.amount)}</span></div>`).join('')}</div>`);
  }
  if (d.showCustomer && data.customer) {
    const c = data.customer;
    lines.push(`<hr class="rc-hr"><div class="rc-meta"><div class="rc-row"><span>Покупатель</span><span>${esc(c.name || '')}</span></div>
      ${c.card ? `<div class="rc-row"><span>Карта</span><span>${esc(c.card)}</span></div>` : ''}
      ${d.showBonus && data.bonus_earned ? `<div class="rc-row"><span>Начислено бонусов</span><span>+${qtyFmt.format(data.bonus_earned)}</span></div>` : ''}
      ${d.showBonus ? `<div class="rc-row"><span>Бонусов на карте</span><span>${qtyFmt.format(c.bonus || 0)}</span></div>` : ''}</div>`);
  }
  if (d.footer) lines.push(`<hr class="rc-hr"><div class="rc-foot">${esc(d.footer)}</div>`);
  return `<div class="rc">${lines.join('')}</div>`;
}

async function printReceipt(saleId) {
  try {
    const [{ receipt: d }, data] = await Promise.all([printDesigns(), api(`/api/sales/${saleId}/receipt`)]);
    const one = receiptHtml(d, data);
    printHtml(Array.from({ length: d.copies || 1 }, () => one).join('<div style="page-break-after:always"></div>'), receiptCss(d), `Чек №${saleId}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Этикетки ---------- */
// sheet — лист A4 (3×8 наклеек 70×37 мм) вместо термопринтера.
function labelCss(d, { sheet = false } = {}) {
  const w = sheet ? 70 : d.width, h = sheet ? 37 : d.height;
  return `@page { size: ${sheet ? 'A4' : `${w}mm ${h}mm`}; margin: ${sheet ? '8mm 0' : '0'}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; background: #fff; font-family: Arial, Helvetica, sans-serif; }
    .sheet { display: grid; grid-template-columns: repeat(${sheet ? 3 : 1}, ${w}mm); justify-content: center; }
    .lb { width: ${w}mm; height: ${h}mm; padding: 1.2mm ${w < 35 ? 1.5 : 2.5}mm; display: flex; flex-direction: column; justify-content: space-evenly;
      align-items: ${d.align === 'left' ? 'flex-start' : 'center'}; text-align: ${d.align === 'left' ? 'left' : 'center'}; overflow: hidden;
      break-inside: avoid; page-break-inside: avoid; ${sheet ? '' : 'page-break-after: always;'} ${d.border ? 'border: 0.3mm solid #000;' : ''} }
    .lb:last-child { page-break-after: auto; }
    .lb > div { max-width: 100%; line-height: 1.12; overflow: hidden; }
    .lb .f-name { max-height: 2.3em; }
    .lb .f-shop, .lb .f-options, .lb .f-category { white-space: nowrap; text-overflow: ellipsis; }
    .lb .f-oldPrice { text-decoration: line-through; }
    .lb .barcode { display: block; max-width: 100%; height: auto; }
    .lb .f-barcode { line-height: 1; }`;
}

function labelHtml(d, p, { sheet = false, shop = '' } = {}) {
  const w = sheet ? 70 : d.width;
  let o = p.options;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const opts = o && typeof o === 'object' ? Object.values(o).filter(Boolean).join(' · ') : '';
  // Скидка из карточки товара: цена со скидкой, старая — зачёркнутая.
  const price = p.discount > 0 && typeof salePrice === 'function' ? salePrice(p) : p.price;
  const old = p.oldPrice ?? (p.discount > 0 ? p.price : null);
  const value = {
    shop: () => shop,
    name: () => p.name,
    options: () => opts,
    article: () => (p.article ? `Арт. ${p.article}` : ''),
    code: () => (p.code ? `Код ${p.code}` : ''),
    category: () => p.category || '',
    price: () => money2(price),
    oldPrice: () => (old ? money2(old) : ''),
    text: () => d.text || '',
  };
  return `<div class="lb">${d.fields.filter((f) => f.on).map((f) => {
    const style = `font-size:${f.size}pt;font-weight:${f.bold ? 800 : 400}`;
    if (f.key === 'barcode') {
      if (!p.barcode) return '';
      // EAN-13: 113 модулей с полями. Модуль — не больше 0,375 мм (3 точки 203 dpi), чтобы сканер читал.
      const module = Math.min(0.375, Math.max(0.2, (w - 4) / 113));
      const svg = typeof barcodeSvg === 'function' ? barcodeSvg(p.barcode, { module, barsMm: d.barcodeHeight }) : null;
      return `<div class="f-barcode" style="${style}">${svg || esc(p.barcode)}</div>`;
    }
    const v = value[f.key]?.();
    return v ? `<div class="f-${f.key}" style="${style}">${esc(v)}</div>` : '';
  }).join('')}</div>`;
}

// items — [{ product, count }]. sheet — печать на листе A4.
async function printLabelSheet(items, { sheet = false } = {}) {
  const { label: d } = await printDesigns();
  const shop = session.design?.name || '';
  const body = items.flatMap(({ product, count }) => Array.from({ length: count }, () => labelHtml(d, product, { sheet, shop }))).join('');
  printHtml(`<div class="sheet">${body}</div>`, labelCss(d, { sheet }), 'Этикетки');
}
