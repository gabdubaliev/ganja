'use strict';

// Импорт товаров из Excel или CSV: выбор файла → сопоставление столбцов → загрузка.

const IMPORT_FIELDS = [
  { key: 'name', label: 'Название', required: true, words: ['наименование', 'название', 'товар', 'номенклатура', 'name'] },
  { key: 'category', label: 'Категория', words: ['категория', 'группа', 'раздел', 'папка', 'category'] },
  { key: 'code', label: 'Код товара', words: ['код', 'код товара', 'артикул', 'code', 'sku'] },
  { key: 'barcode', label: 'Штрихкод', words: ['штрихкод', 'штрих-код', 'штрих код', 'ean', 'barcode', 'шк'] },
  { key: 'price', label: 'Цена продажи', words: ['цена продажи', 'розничная цена', 'розница', 'цена', 'price'] },
  { key: 'purchase', label: 'Цена закупки', words: ['цена закупки', 'закупочная цена', 'закупочная', 'закупка', 'закуп', 'входная', 'purchase'] },
  { key: 'cost', label: 'Себестоимость', words: ['себестоимость', 'cost'] },
  { key: 'stock', label: 'Остаток', words: ['общий остаток', 'остаток', 'остатки', 'в наличии', 'наличие', 'количество', 'кол-во', 'stock'] },
  { key: 'unit', label: 'Единица', words: ['единица измерения', 'ед. изм.', 'ед. изм', 'ед.изм', 'единица', 'ед', 'unit'] },
  { key: 'color', label: 'Цвет (расцветка)', words: ['расцветка', 'цвет', 'название расцветки', 'color', 'colour'] },
  { key: 'size', label: 'Размер', words: ['размер', 'size'] },
];
// Сначала угадываем самые узнаваемые столбцы, чтобы «цена» не забрала «цену закупки».
const GUESS_ORDER = ['barcode', 'code', 'color', 'size', 'purchase', 'cost', 'stock', 'unit', 'category', 'price', 'name'];

const importState = { step: 'pick', fileName: '', sheets: [], sheet: 0, rows: [], header: 0, map: {}, update: true, result: null, error: '',
  markup: '', round: 10, autoCat: true, barcodes: true, stockMode: 'doc' };

const norm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// filled — номера столбцов, в которых под заголовком есть данные: пустым столбцам
// с подходящим названием (например, пустая «Категория» рядом с «Группой») не отдаём поле.
function guessColumns(headerRow, filled) {
  const map = {};
  const used = new Set();
  for (const key of GUESS_ORDER) {
    const field = IMPORT_FIELDS.find((f) => f.key === key);
    let best = -1, bestScore = 0;
    headerRow.forEach((cell, col) => {
      if (used.has(col)) return;
      const h = norm(cell);
      if (!h) return;
      if (key === 'price' && /закуп|себест|входн/.test(h)) return;
      if (key === 'name' && /групп|категор/.test(h)) return;
      if (key === 'stock' && /мин|макс/.test(h)) return;
      if (key === 'code' && /plu|штрих|расцвет|цвет/.test(h)) return;
      if (key === 'color' && /^код|код /.test(h)) return;
      if (key === 'size' && /ряд/.test(h)) return;
      // Цены в долларах не берём: в программе всё в сомах.
      if (['price', 'purchase', 'cost'].includes(key) && /\$|usd|долл/.test(h)) return;
      if (['price', 'purchase', 'cost', 'stock'].includes(key) && /сумма|итого|всего,? ?сом/.test(h)) return;
      let score = 0;
      for (const w of field.words) {
        if (h === w) score = Math.max(score, 3);
        else if (w.length > 3 && h.includes(w)) score = Math.max(score, 2);
      }
      if (score && filled && !filled.has(col)) score = 1;
      if (score > bestScore) { best = col; bestScore = score; }
    });
    if (best >= 0) { map[key] = best; used.add(best); }
  }
  return map;
}

function filledColumns(rows, header) {
  const filled = new Set();
  for (const row of rows.slice(header + 1, header + 500)) {
    (row || []).forEach((c, col) => { if (String(c).trim() !== '') filled.add(col); });
  }
  return filled;
}

function guessFor(rows, header) {
  const map = guessColumns(rows[header] || [], filledColumns(rows, header));
  // Накладная с цветом и размером: «Цена» без слова «продажа» — это цена закупки.
  const h = (k) => norm((rows[header] || [])[map[k]]);
  if ((map.color !== undefined || map.size !== undefined) && map.price !== undefined && map.purchase === undefined && !/продаж|розн/.test(h('price'))) {
    map.purchase = map.price;
    delete map.price;
  }
  return map;
}

function findHeader(rows) {
  let bestRow = rows.findIndex((r) => r.some((c) => String(c).trim()));
  let bestCount = 0;
  rows.slice(0, 15).forEach((row, i) => {
    const count = Object.keys(guessColumns(row)).length;
    if (count > bestCount) { bestRow = i; bestCount = count; }
  });
  return Math.max(0, bestRow);
}

function cleanNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[^\d,.\-]/g, '');
  return s === '' || s === '-' ? '' : s;
}

function mappedRows() {
  const { rows, header, map } = importState;
  const cell = (row, key) => (map[key] === undefined ? '' : row[map[key]] ?? '');
  const out = [];
  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.some((c) => String(c).trim())) continue;
    const barcode = cell(row, 'barcode');
    const code = cell(row, 'code');
    out.push({
      line: i + 1,
      name: String(cell(row, 'name')).trim(),
      category: String(cell(row, 'category')).trim(),
      barcode: typeof barcode === 'number' && Number.isInteger(barcode) ? barcode.toFixed(0) : String(barcode).trim(),
      code: String(code).trim(),
      unit: norm(cell(row, 'unit')).replace(/\.$/, '').slice(0, 10),
      price: cleanNumber(cell(row, 'price')),
      purchase: map.purchase === undefined ? '' : cleanNumber(cell(row, 'purchase')),
      cost: map.cost === undefined ? '' : cleanNumber(cell(row, 'cost')),
      color: String(cell(row, 'color')).trim(),
      size: typeof cell(row, 'size') === 'number' ? String(cell(row, 'size')) : String(cell(row, 'size')).trim(),
      stock: map.stock === undefined ? '' : cleanNumber(cell(row, 'stock')),
    });
  }
  return out;
}

/* ---------- Товары с модификациями: строка файла = товар + цвет + размер ---------- */
const variantMode = () => importState.map.color !== undefined || importState.map.size !== undefined;
const impNum = (v) => (v === '' || v === null || v === undefined ? NaN : Number(String(v).replace(',', '.')));
// Категория по первому слову названия: «Кардиганы MS-6348» → «Кардиган», если в файле или в программе есть такая форма.
function autoCategories(names) {
  const first = (n) => { const w = String(n).trim().split(/\s+/)[0].replace(/[^а-яёa-z-]/gi, ''); return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''; };
  const known = new Map();
  for (const c of categories.list || []) known.set(norm(c.name), c.name);
  const words = new Set(names.map(first).filter(Boolean));
  const pick = (w) => {
    if (!w) return '';
    if (known.has(norm(w))) return known.get(norm(w));
    const stem = /[ыи]$/i.test(w) ? w.slice(0, -1) : null;
    const forms = stem ? [stem, stem + 'а', stem + 'я', stem + 'ь'] : [];
    for (const f of forms) if (known.has(norm(f))) return known.get(norm(f));
    for (const f of forms) if (words.has(f)) return f;
    return w;
  };
  return (n) => pick(first(n));
}
// Строки → товары: группа по коду товара (без кода — по названию). Повтор «цвет + размер» внутри товара
// складывается (количество суммируется, цена закупки — средняя по количеству) и попадает в предупреждения.
function buildGroups() {
  const s = importState;
  const rows = mappedRows().filter((r) => r.name);
  const cat = autoCategories(rows.map((r) => r.name));
  const markup = impNum(s.markup);
  const round = Number(s.round) || 1;
  const groups = new Map();
  const warnings = [];
  for (const r of rows) {
    const key = r.code ? `code:${r.code}` : `name:${norm(r.name)}`;
    let g = groups.get(key);
    if (!g) {
      g = { name: r.name, code: r.code, category: r.category || (s.autoCat ? cat(r.name) : ''), variants: new Map(), lines: [] };
      groups.set(key, g);
    } else if (norm(g.name) !== norm(r.name)) warnings.push(`Строка ${r.line}: код ${r.code} уже у «${g.name}», а здесь «${r.name}» — объединено в «${g.name}»`);
    const opts = {};
    if (r.color) opts['Цвет'] = r.color;
    if (r.size) opts['Размер'] = r.size;
    const okey = norm(Object.values(opts).join('|'));
    const qty = Math.max(0, impNum(r.stock) || 0);
    const purchase = impNum(r.purchase) || impNum(r.cost) || 0;
    const v = g.variants.get(okey);
    if (v) {
      warnings.push(`«${g.name}» ${Object.values(opts).join(', ')}: повтор в строке ${r.line}${v.purchase !== purchase ? ` (другая цена закупки ${purchase} и ${v.purchase})` : ''} — количество сложено: ${v.qty} + ${qty}`);
      v.purchase = v.qty + qty > 0 ? Math.round(((v.purchase * v.qty + purchase * qty) / (v.qty + qty)) * 100) / 100 : purchase;
      v.qty += qty;
      v.lines.push(r.line);
    } else {
      g.variants.set(okey, { options: opts, qty, purchase, price: impNum(r.price) || 0, barcode: r.barcode, lines: [r.line] });
    }
  }
  const list = [...groups.values()].map((g) => {
    const variants = [...g.variants.values()].map((v) => {
      const price = v.price || (Number.isFinite(markup) && v.purchase ? Math.round((v.purchase * (1 + markup / 100)) / round) * round : 0);
      return { ...v, price };
    });
    return { ...g, variants };
  });
  return { list, warnings };
}
function renderVariantImport(body) {
  const s = importState;
  const { list, warnings } = buildGroups();
  const nVar = list.reduce((n, g) => n + g.variants.length, 0);
  const qty = list.reduce((n, g) => n + g.variants.reduce((m, v) => m + v.qty, 0), 0);
  const noPrice = list.some((g) => g.variants.some((v) => !v.price));
  const uniq = (a) => [...new Set(a)];
  const sizes = (g) => (typeof sizeSort === 'function' ? sizeSort : (x) => x)(uniq(g.variants.map((v) => v.options['Размер']).filter(Boolean)));
  const range = (a) => { const v = a.filter((x) => x); if (!v.length) return '—'; const lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? money2(lo) : `${money2(lo)}–${money2(hi)}`; };
  return `
    <div class="import-variant">
      <p class="sub"><b>Товары с модификациями:</b> ${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])}, ${nVar} ${plural(nVar, ['модификация', 'модификации', 'модификаций'])} (цвет и размер), ${qtyFmt.format(qty)} шт.
        Строки с одним кодом (или названием) соберутся в один товар.</p>
      <div class="map-grid">
        ${s.map.price === undefined ? `<div class="field"><label for="imp-markup">Наценка на цену закупки, % *</label><input id="imp-markup" class="input num" inputmode="decimal" value="${esc(s.markup)}" placeholder="Например, 100"></div>
        <div class="field"><label for="imp-round">Цену продажи округлить</label><select id="imp-round" class="input">${[1, 10, 50, 100].map((r) => `<option value="${r}" ${Number(s.round) === r ? 'selected' : ''}>до ${r} сом</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Количество из файла</label>
          <label class="check"><input type="radio" name="imp-stock" value="doc" ${s.stockMode === 'doc' ? 'checked' : ''}> Черновик закупки — проверить по размерам и провести</label>
          <label class="check"><input type="radio" name="imp-stock" value="stock" ${s.stockMode === 'stock' ? 'checked' : ''}> Сразу в остаток</label>
          <label class="check"><input type="radio" name="imp-stock" value="none" ${s.stockMode === 'none' ? 'checked' : ''}> Не загружать</label></div>
      </div>
      <label class="check"><input type="checkbox" id="imp-autocat" ${s.autoCat ? 'checked' : ''} ${s.map.category !== undefined ? 'disabled' : ''}> Категория по первому слову названия (Кардиган, Кофта, Футболка…)</label>
      <label class="check"><input type="checkbox" id="imp-barcodes" ${s.barcodes ? 'checked' : ''}> Создать каждой модификации свой штрихкод (для этикеток и сканера)</label>
      ${warnings.length ? `<details class="imp-warn" open><summary>Проверьте: ${warnings.length} ${plural(warnings.length, ['замечание', 'замечания', 'замечаний'])}</summary><ul>${warnings.slice(0, 60).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      <div class="table-wrap import-preview"><table>
        <thead><tr><th>Товар</th><th>Код</th><th>Категория</th><th>Цвета</th><th>Размеры</th><th class="num">Модиф.</th><th class="num">Шт</th><th class="num">Закупка</th><th class="num">Продажа</th></tr></thead>
        <tbody>${list.map((g) => `<tr><td>${esc(g.name)}</td><td>${esc(g.code || '—')}</td><td>${esc(g.category || '—')}</td>
          <td>${esc(uniq(g.variants.map((v) => v.options['Цвет']).filter(Boolean)).join(', ') || '—')}</td><td>${esc(sizes(g).join(', ') || '—')}</td>
          <td class="num">${g.variants.length}</td><td class="num">${qtyFmt.format(g.variants.reduce((m, v) => m + v.qty, 0))}</td>
          <td class="num">${range(g.variants.map((v) => v.purchase))}</td><td class="num">${range(g.variants.map((v) => v.price))}</td></tr>`).join('')}</tbody>
      </table></div>
      ${noPrice ? `<p class="form-error">${s.map.price === undefined ? 'Укажите наценку — по ней посчитается цена продажи' : 'У некоторых строк нет цены продажи'}</p>` : ''}
    </div>`;
}

function renderImport() {
  const s = importState;
  const body = $('#import-body');
  if (s.step === 'pick') {
    body.innerHTML = `
      <h2>Импорт товаров из Excel</h2>
      <p class="sub">Выгрузите список товаров из CloudShop (или любой другой программы) в Excel и выберите файл.
        Подходят таблицы .xlsx и .csv. Первая строка с заголовками столбцов найдётся сама.</p>
      <label class="file-pick">
        <input type="file" id="import-file" accept=".xlsx,.csv,.xls,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
        <span class="btn primary big">Выбрать файл</span>
      </label>
      ${s.error ? `<p class="form-error" role="alert">${esc(s.error)}</p>` : ''}
      <div class="form-actions"><button type="button" class="btn ghost" data-import="close">Отмена</button></div>`;
    return;
  }
  if (s.step === 'busy') {
    body.innerHTML = '<h2>Импорт товаров из Excel</h2><p class="sub">Загружаю товары…</p>';
    return;
  }
  if (s.step === 'done' && s.result?.variantMode) {
    const r = s.result;
    body.innerHTML = `
      <h2>Импорт завершён</h2>
      <div class="import-stats">
        <div><b class="num">${r.products}</b><span>новых товаров</span></div>
        <div><b class="num">${r.variants}</b><span>новых модификаций</span></div>
        <div><b class="num">${r.productsFound + r.variantsFound}</b><span>уже было (не изменены)</span></div>
      </div>
      ${r.docId ? `<p class="sub">Количество (${qtyFmt.format(r.qty)} шт) — в черновике закупки №${r.docNumber}. Сверьте размеры с пачками, поправьте и нажмите «Провести» — тогда товар появится в остатке.</p>` : ''}
      ${r.skipped.length ? `<p class="sub">Пропущено: ${r.skipped.map((x) => `${esc(x.name)} — ${esc(x.reason)}`).join('; ')}</p>` : ''}
      <p class="pick-meta">Если что-то не так — импорт можно отменить целиком в «Журнале действий».</p>
      <div class="form-actions">${r.docId ? '<button type="button" class="btn" data-import="open-doc">Открыть черновик закупки</button>' : ''}<button type="button" class="btn primary" data-import="close">Готово</button></div>`;
    return;
  }
  if (s.step === 'done') {
    const r = s.result;
    body.innerHTML = `
      <h2>Импорт завершён</h2>
      <div class="import-stats">
        <div><b class="num">${r.created}</b><span>добавлено</span></div>
        <div><b class="num">${r.updated}</b><span>обновлено</span></div>
        <div><b class="num">${r.skipped.length}</b><span>пропущено</span></div>
      </div>
      ${r.skipped.length ? `
        <p class="sub">Пропущенные строки:</p>
        <div class="table-wrap import-preview"><table>
          <thead><tr><th>Строка</th><th>Товар</th><th>Причина</th></tr></thead>
          <tbody>${r.skipped.slice(0, 200).map((x) => `<tr><td class="num">${x.line}</td><td>${esc(x.name || '—')}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${r.skipped.length > 200 ? `<p class="pick-meta">и ещё ${r.skipped.length - 200}</p>` : ''}` : ''}
      <div class="form-actions"><button type="button" class="btn primary" data-import="close">Готово</button></div>`;
    return;
  }

  // Шаг сопоставления столбцов.
  const headerRow = s.rows[s.header] || [];
  const width = Math.max(...s.rows.slice(s.header, s.header + 50).map((r) => r.length), 0);
  const options = (key) => `<option value="">— нет —</option>` + Array.from({ length: width }, (_, col) =>
    `<option value="${col}" ${s.map[key] === col ? 'selected' : ''}>${esc(String(headerRow[col] ?? '').trim() || `Столбец ${col + 1}`)}</option>`).join('');
  const items = mappedRows();
  const valid = items.filter((r) => r.name).length;
  const preview = items.slice(0, 6);
  const vm = variantMode();
  const groups = vm ? buildGroups().list : [];
  const vmReady = vm && groups.length && !groups.some((g) => g.variants.some((v) => !v.price));
  body.innerHTML = `
    <h2>Какой столбец что означает</h2>
    <p class="sub">Файл «${esc(s.fileName)}»: ${items.length} ${plural(items.length, ['строка', 'строки', 'строк'])} с товарами. Проверьте столбцы, программа угадала их по заголовкам.</p>
    ${s.sheets.length > 1 ? `<div class="field"><label for="imp-sheet">Лист файла</label><select id="imp-sheet" class="input">${s.sheets.map((sh, i) => `<option value="${i}" ${i === s.sheet ? 'selected' : ''}>${esc(sh.name)}</option>`).join('')}</select></div>` : ''}
    <div class="map-grid">
      ${IMPORT_FIELDS.map((f) => `
        <div class="field">
          <label for="map-${f.key}">${f.label}${f.required ? ' *' : ''}</label>
          <select id="map-${f.key}" class="input" data-map="${f.key}">${options(f.key)}</select>
        </div>`).join('')}
      <div class="field">
        <label for="map-header">Строка с заголовками</label>
        <input id="map-header" class="input num" inputmode="numeric" value="${s.header + 1}">
      </div>
    </div>
    ${vm ? renderVariantImport(body) : `<p class="sub">Так будут выглядеть первые товары:</p>
    <div class="table-wrap import-preview"><table>
      <thead><tr>${IMPORT_FIELDS.map((f) => `<th>${f.label}</th>`).join('')}</tr></thead>
      <tbody>${preview.map((r) => `<tr>${IMPORT_FIELDS.map((f) => `<td>${esc(r[f.key] === '' ? '—' : r[f.key])}</td>`).join('')}</tr>`).join('') ||
        `<tr><td colspan="${IMPORT_FIELDS.length}" class="empty">Под заголовками нет строк</td></tr>`}</tbody>
    </table></div>
    <label class="check"><input type="checkbox" id="import-update" ${s.update ? 'checked' : ''}>
      Если товар уже есть в программе (тот же код, а без кода — то же название и штрихкод), обновить его цену, себестоимость и остаток</label>`}
    ${s.map.name === undefined ? '<p class="form-error">Выберите столбец с названием товара</p>' : ''}
    ${s.error ? `<p class="form-error" role="alert">${esc(s.error)}</p>` : ''}
    <div class="form-actions">
      <button type="button" class="btn ghost" data-import="again">Другой файл</button>
      ${vm ? `<button type="button" class="btn primary" data-import="run-variants" ${s.map.name === undefined || !vmReady ? 'disabled' : ''}>Загрузить ${groups.length} ${plural(groups.length, ['товар', 'товара', 'товаров'])} с модификациями</button>`
        : `<button type="button" class="btn primary" data-import="run" ${s.map.name === undefined || !valid ? 'disabled' : ''}>Загрузить ${valid} ${plural(valid, ['товар', 'товара', 'товаров'])}</button>`}
    </div>`;
}

function openImport() {
  Object.assign(importState, { step: 'pick', fileName: '', rows: [], map: {}, result: null, error: '' });
  renderImport();
  $('#import-dialog').showModal();
}

$('#import-body').addEventListener('change', async (e) => {
  const s = importState;
  if (e.target.id === 'import-file') {
    const file = e.target.files[0];
    if (!file) return;
    try {
      s.sheets = (await readTableSheets(file)).filter((sh) => sh.rows.some((r) => r.some((c) => String(c).trim())));
      if (!s.sheets.length) throw new Error('Файл пустой');
      // Лист, где больше всего узнаваемых столбцов (лист с цветом и размером — в приоритете).
      const score = (sh) => { const h = findHeader(sh.rows); const m = guessFor(sh.rows, h); return Object.keys(m).length + (m.name !== undefined ? 2 : 0) + (m.color !== undefined && m.size !== undefined ? 3 : 0); };
      s.sheet = s.sheets.map(score).reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
      s.rows = s.sheets[s.sheet].rows;
      s.fileName = file.name;
      s.header = findHeader(s.rows);
      s.map = guessFor(s.rows, s.header);
      s.step = 'map';
      s.error = '';
    } catch (err) {
      s.error = err.message;
    }
  } else if (e.target.dataset.map) {
    const v = e.target.value;
    // Один столбец — одно поле.
    for (const k of Object.keys(s.map)) if (String(s.map[k]) === v) delete s.map[k];
    if (v === '') delete s.map[e.target.dataset.map];
    else s.map[e.target.dataset.map] = Number(v);
  } else if (e.target.id === 'map-header') {
    const n = Math.round(parseNum(e.target.value));
    if (n >= 1 && n <= s.rows.length) {
      s.header = n - 1;
      s.map = guessFor(s.rows, s.header);
    }
  } else if (e.target.id === 'import-update') {
    s.update = e.target.checked;
    return;
  } else if (e.target.id === 'imp-sheet') {
    s.sheet = Number(e.target.value);
    s.rows = s.sheets[s.sheet].rows;
    s.header = findHeader(s.rows);
    s.map = guessFor(s.rows, s.header);
  } else if (e.target.id === 'imp-round') s.round = Number(e.target.value);
  else if (e.target.id === 'imp-autocat') s.autoCat = e.target.checked;
  else if (e.target.id === 'imp-barcodes') { s.barcodes = e.target.checked; return; }
  else if (e.target.name === 'imp-stock') { s.stockMode = e.target.value; return; }
  else if (e.target.id === 'imp-markup') s.markup = e.target.value;
  renderImport();
});

$('#import-body').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-import]')?.dataset.import;
  const s = importState;
  if (action === 'close') {
    $('#import-dialog').close();
  } else if (action === 'again') {
    Object.assign(s, { step: 'pick', error: '' });
    renderImport();
  } else if (action === 'run-variants') {
    const { list } = buildGroups();
    s.step = 'busy';
    renderImport();
    try {
      const groups = list.map((g) => ({ name: g.name, code: g.code, category: g.category, variants: g.variants.map((v) => ({ options: v.options, qty: v.qty, purchase: v.purchase, price: v.price, barcode: v.barcode })) }));
      s.result = await api('/api/products/import-variants', { method: 'POST', body: { groups, barcodes: s.barcodes, stockMode: s.stockMode, note: `Импорт из Excel «${s.fileName}»: проверьте количество по размерам и проведите` } });
      s.result.variantMode = true;
      s.step = 'done';
      s.error = '';
      renderProducts();
    } catch (err) {
      s.step = 'map';
      s.error = err.message;
    }
    renderImport();
  } else if (action === 'open-doc') {
    $('#import-dialog').close();
    openDoc(s.result.docId);
  } else if (action === 'run') {
    const rows = mappedRows();
    s.step = 'busy';
    renderImport();
    try {
      s.result = await api('/api/products/import', { method: 'POST', body: { rows, update: s.update } });
      s.step = 'done';
      s.error = '';
      renderProducts();
    } catch (err) {
      s.step = 'map';
      s.error = err.message;
    }
    renderImport();
  }
});

$('#product-import').addEventListener('click', openImport);
