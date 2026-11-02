'use strict';

// Импорт товаров из Excel или CSV: выбор файла → сопоставление столбцов → загрузка.

const IMPORT_FIELDS = [
  { key: 'name', label: 'Название', required: true, words: ['наименование', 'название', 'товар', 'номенклатура', 'name'] },
  { key: 'category', label: 'Категория', words: ['категория', 'группа', 'раздел', 'папка', 'category'] },
  { key: 'code', label: 'Код товара', words: ['код', 'код товара', 'артикул', 'code', 'sku'] },
  { key: 'barcode', label: 'Штрихкод', words: ['штрихкод', 'штрих-код', 'штрих код', 'ean', 'barcode', 'шк'] },
  { key: 'price', label: 'Цена продажи', words: ['цена продажи', 'розничная цена', 'розница', 'цена', 'price'] },
  { key: 'cost', label: 'Себестоимость', words: ['себестоимость', 'закупочная цена', 'цена закупки', 'закупка', 'закуп', 'входная', 'cost'] },
  { key: 'stock', label: 'Остаток', words: ['общий остаток', 'остаток', 'остатки', 'в наличии', 'наличие', 'количество', 'кол-во', 'stock'] },
  { key: 'unit', label: 'Единица', words: ['единица измерения', 'ед. изм.', 'ед. изм', 'ед.изм', 'единица', 'ед', 'unit'] },
];
// Сначала угадываем самые узнаваемые столбцы, чтобы «цена» не забрала «цену закупки».
const GUESS_ORDER = ['barcode', 'code', 'cost', 'stock', 'unit', 'category', 'price', 'name'];

const importState = { step: 'pick', fileName: '', rows: [], header: 0, map: {}, update: true, result: null, error: '' };

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
      if (key === 'code' && /plu|штрих/.test(h)) return;
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
  return guessColumns(rows[header] || [], filledColumns(rows, header));
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
      cost: map.cost === undefined ? '' : cleanNumber(cell(row, 'cost')),
      stock: map.stock === undefined ? '' : cleanNumber(cell(row, 'stock')),
    });
  }
  return out;
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
  body.innerHTML = `
    <h2>Какой столбец что означает</h2>
    <p class="sub">Файл «${esc(s.fileName)}»: ${items.length} ${plural(items.length, ['строка', 'строки', 'строк'])} с товарами. Проверьте столбцы, программа угадала их по заголовкам.</p>
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
    <p class="sub">Так будут выглядеть первые товары:</p>
    <div class="table-wrap import-preview"><table>
      <thead><tr>${IMPORT_FIELDS.map((f) => `<th>${f.label}</th>`).join('')}</tr></thead>
      <tbody>${preview.map((r) => `<tr>${IMPORT_FIELDS.map((f) => `<td>${esc(r[f.key] === '' ? '—' : r[f.key])}</td>`).join('')}</tr>`).join('') ||
        `<tr><td colspan="${IMPORT_FIELDS.length}" class="empty">Под заголовками нет строк</td></tr>`}</tbody>
    </table></div>
    <label class="check"><input type="checkbox" id="import-update" ${s.update ? 'checked' : ''}>
      Если товар уже есть в программе (тот же код, а без кода — то же название и штрихкод), обновить его цену, себестоимость и остаток</label>
    ${s.map.name === undefined ? '<p class="form-error">Выберите столбец с названием товара</p>' : ''}
    ${s.error ? `<p class="form-error" role="alert">${esc(s.error)}</p>` : ''}
    <div class="form-actions">
      <button type="button" class="btn ghost" data-import="again">Другой файл</button>
      <button type="button" class="btn primary" data-import="run" ${s.map.name === undefined || !valid ? 'disabled' : ''}>Загрузить ${valid} ${plural(valid, ['товар', 'товара', 'товаров'])}</button>
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
      s.rows = await readTableFile(file);
      if (!s.rows.some((r) => r.some((c) => String(c).trim()))) throw new Error('Файл пустой');
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
  }
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
