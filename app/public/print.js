'use strict';

// Печать по шаблонам конструктора («Ещё» → «Чеки и этикетки»): этикетки — объекты на холсте в миллиметрах,
// чек покупателю — блоки сверху вниз. Печать — через скрытую рамку на этой же странице, без новых вкладок.

let printDesignsCache = null;
async function printDesigns(force = false) {
  if (!printDesignsCache || force) printDesignsCache = await api('/api/print-designs');
  return printDesignsCache;
}

/* ---------- Поля данных ---------- */
// Этикетка: {name}, {price}… в тексте и в штрихкоде заменяются данными товара.
const LABEL_TOKENS = [
  ['name', 'Название товара'], ['price', 'Цена (со скидкой)'], ['price_num', 'Цена без «сом»'], ['oldPrice', 'Старая цена (если скидка)'],
  ['discount', 'Скидка, %'], ['barcode', 'Штрихкод'], ['code', 'Код товара'], ['article', 'Артикул'], ['category', 'Категория'],
  ['options', 'Модификация (цвет, размер…)'], ['unit', 'Единица'], ['shop', 'Магазин'], ['date', 'Дата печати'],
];
const RECEIPT_TOKENS = [
  ['shop', 'Магазин'], ['number', 'Номер чека'], ['date', 'Дата'], ['time', 'Время'], ['cashier', 'Кассир'], ['register', 'Касса'],
  ['customer', 'Покупатель'], ['card', 'Номер карты'], ['bonus', 'Бонусов на карте'], ['earned', 'Начислено бонусов'],
  ['total', 'Итого'], ['count', 'Товаров в чеке'],
];
const LABEL_FONTS = ['Arial', 'Arial Narrow', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Courier New', 'Impact', 'Roboto', 'Segoe UI'];

function productValues(p, shop = '') {
  let o = p.options;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const opts = o && typeof o === 'object' ? o : {};
  const price = p.discount > 0 && typeof salePrice === 'function' ? salePrice(p) : p.price;
  const old = p.oldPrice ?? (p.discount > 0 ? p.price : null);
  const num = (v) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v);
  const vals = {
    name: p.name || '', price: price === undefined || price === null ? '' : money2(price), price_num: price === undefined || price === null ? '' : num(price),
    oldPrice: old ? money2(old) : '', discount: p.discount > 0 ? `−${num(p.discount)}%` : '', barcode: p.barcode || '', code: p.code || '',
    article: p.article || '', category: p.category || '', options: Object.values(opts).filter(Boolean).join(' · '), unit: p.unit || '',
    shop, date: new Date().toLocaleDateString('ru-RU'),
  };
  for (const [k, v] of Object.entries(opts)) vals[k] = String(v ?? '');
  return vals;
}

// Подстановка полей. Строка, где все поля пустые (нет артикула), убирается целиком — «Арт. » без значения не печатается.
function fillTokens(text, vals) {
  return String(text ?? '').split('\n').map((line) => {
    let used = 0, empty = 0;
    const out = line.replace(/\{([^{}]+)\}/g, (m, key) => {
      if (!(key in vals)) return m;
      used++;
      if (!vals[key]) empty++;
      return vals[key];
    });
    return used && used === empty ? null : out;
  }).filter((l) => l !== null).join('\n');
}

/* ---------- Печать HTML через скрытую рамку ---------- */
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
  const imgs = [...doc.images].filter((i) => !i.complete);
  if (!imgs.length) setTimeout(go, 80);
  else Promise.all(imgs.map((i) => new Promise((ok) => { i.onload = ok; i.onerror = ok; }))).then(go);
}

/* ---------- Этикетка ---------- */
const LABEL_BASE_CSS = `
  .lbl { position: relative; overflow: hidden; background: #fff; color: #000; }
  .lo { position: absolute; box-sizing: border-box; }
  .lo-text { display: flex; overflow: hidden; }
  .lo-text > span { display: block; width: 100%; overflow-wrap: anywhere; }
  .lo-text.v-top { align-items: flex-start; } .lo-text.v-middle { align-items: center; } .lo-text.v-bottom { align-items: flex-end; }
  .lo-text.inv { background: #000; color: #fff; }
  .lo-code { display: flex; flex-direction: column; background: #fff; }
  .lo-code svg { flex: 1 1 auto; min-height: 0; display: block; fill: #000; }
  .lo-code .code-text { flex: none; text-align: center; font-family: Arial, sans-serif; line-height: 1.1; letter-spacing: .08em; white-space: nowrap; overflow: hidden; }
  .lo-err { display: flex; align-items: center; justify-content: center; text-align: center; border: 0.2mm dashed #000; font: 2.2mm Arial, sans-serif; }
  .lo-img img { width: 100%; height: 100%; display: block; }
  .lo-img.mono img { filter: grayscale(1) contrast(1.6); }`;

// Один объект этикетки в HTML. vals — значения полей (или null — показывать поля как {имя}).
function labelObjectHtml(o, vals) {
  if (o.hidden) return '';
  const box = `left:${o.x}mm;top:${o.y}mm;width:${o.w}mm;height:${o.h}mm;${o.rot ? `transform:rotate(${o.rot}deg);` : ''}`;
  const attr = `data-oid="${esc(o.id)}"`;
  if (o.type === 'text') {
    let t = vals ? fillTokens(o.text, vals) : o.text;
    if (o.upper) t = t.toUpperCase();
    const deco = [o.underline && 'underline', o.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
    const style = `font-family:'${o.font}',Arial,sans-serif;font-size:${o.size}pt;font-weight:${o.bold ? 700 : 400};font-style:${o.italic ? 'italic' : 'normal'};`
      + `text-decoration:${deco};text-align:${o.align};line-height:${o.lineHeight};letter-spacing:${o.spacing}pt;white-space:${o.wrap ? 'pre-wrap' : 'pre'};`;
    return `<div class="lo lo-text v-${o.valign}${o.invert ? ' inv' : ''}" ${attr} data-fit="${o.fit}" data-size="${o.size}" style="${box}"><span style="${style}">${esc(t)}</span></div>`;
  }
  if (o.type === 'barcode') {
    const v = vals ? fillTokens(o.value, vals) : o.value.replace(/\{barcode\}/, '2000000000015');
    const svg = typeof anyCodeSvg === 'function' ? anyCodeSvg(o.kind, v, o.w, o.h, { showText: o.showText, textMm: o.textSize, ecl: o.ecl }) : null;
    return svg ? `<div class="lo lo-code" ${attr} style="${box}">${svg}</div>`
      : `<div class="lo lo-err" ${attr} style="${box}">${v ? `Не подходит для ${o.kind === 'ean13' ? 'EAN-13' : 'штрихкода'}: ${esc(v)}` : 'Нет штрихкода'}</div>`;
  }
  if (o.type === 'image') {
    return `<div class="lo lo-img${o.mono ? ' mono' : ''}" ${attr} style="${box}">${o.imageId ? `<img src="/img/${o.imageId}" alt="" style="object-fit:${o.fit}">` : '<div class="lo-err" style="position:absolute;inset:0">Картинка</div>'}</div>`;
  }
  const fill = o.fill === 'black' ? '#000' : o.fill === 'white' ? '#fff' : 'transparent';
  if (o.type === 'line') {
    // Линия — по длинной стороне рамки, толщина stroke.
    const horiz = o.w >= o.h;
    return `<div class="lo" ${attr} style="${box}"><div style="position:absolute;${horiz ? `left:0;right:0;top:50%;border-top:${o.stroke}mm ${o.dash} #000;transform:translateY(-50%)` : `top:0;bottom:0;left:50%;border-left:${o.stroke}mm ${o.dash} #000;transform:translateX(-50%)`}"></div></div>`;
  }
  const radius = o.type === 'ellipse' ? '50%' : `${o.radius}mm`;
  return `<div class="lo" ${attr} style="${box}border:${o.stroke}mm ${o.dash} #000;background:${fill};border-radius:${radius}"></div>`;
}

function labelInnerHtml(t, vals) {
  return t.objects.map((o) => labelObjectHtml(o, vals)).join('');
}

// Текст «ужать по рамке» / «растянуть по рамке»: подбирается размер шрифта прямо в документе, где он показан.
function fitLabelTexts(root) {
  for (const el of root.querySelectorAll('.lo-text')) {
    const span = el.firstElementChild;
    const base = Number(el.dataset.size);
    const fits = () => span.scrollWidth <= el.clientWidth + 0.5 && span.scrollHeight <= el.clientHeight + 0.5;
    span.style.fontSize = `${base}pt`;
    if (el.dataset.fit === 'shrink') {
      let s = base;
      while (!fits() && s > 3) { s = Math.max(3, s - Math.max(0.25, s * 0.04)); span.style.fontSize = `${s}pt`; }
    } else if (el.dataset.fit === 'grow') {
      let lo = 3, hi = 200;
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; span.style.fontSize = `${mid}pt`; if (fits()) lo = mid; else hi = mid; }
      span.style.fontSize = `${lo}pt`;
    }
  }
}

// Готовый HTML этикеток для печати: тексты подгоняются в скрытом месте этой страницы, размеры шрифтов «запекаются».
function renderLabelsForPrint(t, products, shop) {
  const meas = document.createElement('div');
  meas.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
  meas.innerHTML = `<style>${LABEL_BASE_CSS}</style>` + products.map((p) => `<div class="lbl" style="width:${t.width}mm;height:${t.height}mm">${labelInnerHtml(t, productValues(p, shop))}</div>`).join('');
  document.body.append(meas);
  fitLabelTexts(meas);
  const html = [...meas.querySelectorAll('.lbl')].map((el) => el.innerHTML);
  meas.remove();
  return html;
}

function labelPrintCss(t, { sheet = false } = {}) {
  const rot = t.rotate === 90 || t.rotate === 270;
  const pw = rot ? t.height : t.width, ph = rot ? t.width : t.height;
  return `@page { size: ${sheet ? 'A4' : `${pw}mm ${ph}mm`}; margin: ${sheet ? '8mm 5mm' : '0'}; }
    * { box-sizing: border-box; } body { margin: 0; font-family: Arial, sans-serif; }
    ${LABEL_BASE_CSS}
    .sheet { display: flex; flex-wrap: wrap; ${sheet ? 'gap: 0; justify-content: center;' : ''} }
    .page { width: ${pw}mm; height: ${ph}mm; overflow: hidden; position: relative; break-inside: avoid; page-break-inside: avoid; ${sheet ? '' : 'page-break-after: always;'} }
    .page:last-child { page-break-after: auto; }
    .page .lbl { width: ${t.width}mm; height: ${t.height}mm; position: absolute; left: 0; top: 0; ${t.border ? 'outline: 0.25mm solid #000; outline-offset: -0.25mm;' : ''}
      ${t.rotate ? `transform-origin: 0 0; transform: ${t.rotate === 90 ? `translateX(${pw}mm) rotate(90deg)` : t.rotate === 180 ? `translate(${pw}mm, ${ph}mm) rotate(180deg)` : `translateY(${ph}mm) rotate(270deg)`};` : ''} }`;
}

// items — [{ product, count }]. templateId — шаблон (по умолчанию — основной). sheet — лист A4.
async function printLabelSheet(items, { templateId = null, sheet = false } = {}) {
  const { labels } = await printDesigns();
  const t = labels.list.find((x) => x.id === templateId) || labels.list.find((x) => x.id === labels.default) || labels.list[0];
  const shop = session.design?.name || '';
  const products = items.flatMap(({ product, count }) => Array.from({ length: count }, () => product));
  const pages = renderLabelsForPrint(t, products, shop).map((h) => `<div class="page"><div class="lbl">${h}</div></div>`).join('');
  printHtml(`<div class="sheet">${pages}</div>`, labelPrintCss(t, { sheet }), 'Этикетки');
}

/* ---------- Чек покупателю ---------- */
function receiptValues(data) {
  const d = new Date(data.created_at);
  return {
    shop: data.shop || '', number: String(data.id), date: d.toLocaleDateString('ru-RU'), time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    cashier: data.cashier || '', register: data.register || '', customer: data.customer?.name || '', card: data.customer?.card || '',
    bonus: data.customer ? qtyFmt.format(data.customer.bonus || 0) : '', earned: data.bonus_earned ? qtyFmt.format(data.bonus_earned) : '',
    total: money2(data.total - (data.bonus_spent || 0)), count: String(data.items.reduce((s, i) => s + i.qty, 0)),
  };
}

function receiptCss(r) {
  const w = r.paper - r.margin * 2 - (r.paper === 58 ? 6 : 4);
  return `@page { size: ${r.paper}mm auto; margin: ${r.margin}mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; background: #fff; font-family: '${r.font}', Arial, sans-serif; line-height: ${r.lineHeight}; }
    .rc { width: ${w}mm; margin: 0 auto; }
    .rb { white-space: pre-line; overflow-wrap: anywhere; }
    .rb.inv { background: #000; color: #fff; padding: 0.6mm 1mm; }
    .rb-line { border: 0; margin: 1.5mm 0; }
    .rb-line.dashed { border-top: 0.3mm dashed #000; } .rb-line.solid { border-top: 0.3mm solid #000; }
    .rb-line.double { border-top: 0.9mm double #000; } .rb-line.dotted { border-top: 0.4mm dotted #000; }
    .rb-stars { text-align: center; letter-spacing: .2em; overflow: hidden; white-space: nowrap; }
    .row { display: flex; justify-content: space-between; gap: 2mm; }
    .row > span:last-child { white-space: nowrap; text-align: right; }
    .it { margin-bottom: .8mm; }
    .rb-img img { display: inline-block; max-width: 100%; }
    .rb-code { display: inline-flex; flex-direction: column; }
    .rb-code svg { display: block; width: 100%; flex: 1 1 auto; }
    .rb-code .code-text { text-align: center; font-family: Arial, sans-serif; letter-spacing: .08em; }
    table.rt { width: 100%; border-collapse: collapse; } table.rt td { padding: .3mm 0; vertical-align: top; } table.rt td.n { text-align: right; white-space: nowrap; padding-left: 1.5mm; }`;
}

function receiptBlockHtml(b, data, vals, r) {
  if (b.hidden) return '';
  const font = `font-size:${b.size}pt;font-weight:${b.bold ? 700 : 400};font-style:${b.italic ? 'italic' : 'normal'};text-align:${b.align};${b.upper ? 'text-transform:uppercase;' : ''}`;
  const cls = `rb${b.invert ? ' inv' : ''}`;
  const m = money2;
  const qty = (v) => qtyFmt.format(v);
  switch (b.type) {
    case 'text': {
      const t = fillTokens(b.text, vals);
      return t ? `<div class="${cls}" style="${font}">${esc(t)}</div>` : '';
    }
    case 'image': return b.imageId ? `<div class="rb rb-img" style="text-align:${b.align}"><img src="/img/${b.imageId}" alt="" style="width:${b.width}%"></div>` : '';
    case 'line': return b.style === 'stars' ? `<div class="rb-stars" style="font-size:${b.size}pt">${'*'.repeat(60)}</div>` : `<hr class="rb-line ${b.style}">`;
    case 'spacer': return `<div style="height:${b.height}mm"></div>`;
    case 'code': {
      const v = fillTokens(b.value, vals);
      const svg = typeof anyCodeSvg === 'function' ? anyCodeSvg(b.kind, v, 40, b.height, { showText: b.showText, textMm: Math.max(1.8, b.size * 0.3) }) : null;
      return svg ? `<div class="rb" style="text-align:${b.align}"><div class="rb-code" style="width:${b.kind === 'qr' ? Math.min(b.width, 60) : b.width}%;height:${b.kind === 'qr' ? 'auto' : `${b.height}mm`}">${svg}</div></div>` : '';
    }
    case 'items': {
      const name = (i, n) => `${b.numbered ? `${n}. ` : ''}${esc(i.name)}${b.showCode && i.code ? ` (${esc(i.code)})` : ''}`;
      const unit = (i) => (b.showUnit && i.unit ? ` ${esc(i.unit)}` : '');
      const nb = b.nameBold ? 'font-weight:700' : '';
      if (b.layout === 'table') {
        return `<table class="rt" style="${font}"><tbody>${data.items.map((i, n) => `<tr><td style="${nb}">${name(i, n + 1)}</td><td class="n">${qty(i.qty)}${unit(i)}</td><td class="n">${m(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>`;
      }
      if (b.layout === 'one-line') {
        return `<div style="${font}">${data.items.map((i, n) => `<div class="row it"><span style="${nb}">${name(i, n + 1)} × ${qty(i.qty)}${unit(i)}</span><span>${m(i.qty * i.price)}</span></div>`).join('')}</div>`;
      }
      return `<div style="${font}">${data.items.map((i, n) => `<div class="it"><div style="${nb}">${name(i, n + 1)}</div><div class="row"><span>${qty(i.qty)}${unit(i)} × ${m(i.price)}</span><span>${m(i.qty * i.price)}</span></div></div>`).join('')}</div>`;
    }
    case 'totals': {
      const rows = [];
      if (b.showSubtotal) rows.push(`<div class="row"><span>Сумма</span><span>${m(data.total + (data.discount || 0))}</span></div>`);
      if (b.showDiscount && data.discount) rows.push(`<div class="row"><span>Скидка</span><span>−${m(data.discount)}</span></div>`);
      if (b.showBonus && data.bonus_spent) rows.push(`<div class="row"><span>Оплачено бонусами</span><span>−${m(data.bonus_spent)}</span></div>`);
      rows.push(`<div class="row" style="font-size:${b.totalSize}pt;font-weight:800"><span>${esc(b.label)}</span><span>${m(data.total - (data.bonus_spent || 0))}</span></div>`);
      return `<div style="${font}">${rows.join('')}</div>`;
    }
    case 'payments': return data.payments?.length ? `<div style="${font}">${data.payments.map((p) => `<div class="row"><span>${esc(p.name)}</span><span>${m(p.amount)}</span></div>`).join('')}</div>` : '';
    case 'customer': {
      const c = data.customer;
      if (!c) return '';
      const rows = [`<div>Покупатель: ${esc(c.name || '')}</div>`];
      if (b.showPhone && c.phone) rows.push(`<div class="row"><span>Телефон</span><span>+${esc(c.phone)}</span></div>`);
      if (b.showCard && c.card) rows.push(`<div class="row"><span>Карта</span><span>${esc(c.card)}</span></div>`);
      if (b.showEarned && data.bonus_earned) rows.push(`<div class="row"><span>Начислено бонусов</span><span>+${qty(data.bonus_earned)}</span></div>`);
      if (b.showBalance) rows.push(`<div class="row"><span>Бонусов на карте</span><span>${qty(c.bonus || 0)}</span></div>`);
      return `<div style="${font}">${rows.join('')}</div>`;
    }
    default: return '';
  }
}

function receiptHtml(r, data) {
  const vals = receiptValues(data);
  return `<div class="rc">${data.refunded_at ? '<div class="rb inv" style="text-align:center;font-weight:800">ВОЗВРАТ</div>' : ''}${r.blocks.map((b) => receiptBlockHtml(b, data, vals, r)).join('')}</div>`;
}

async function printReceipt(saleId) {
  try {
    const [{ receipt: r }, data] = await Promise.all([printDesigns(), api(`/api/sales/${saleId}/receipt`)]);
    const one = receiptHtml(r, data);
    printHtml(Array.from({ length: r.copies || 1 }, () => one).join('<div style="page-break-after:always"></div>'), receiptCss(r), `Чек №${saleId}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}
