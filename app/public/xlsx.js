'use strict';

// Чтение таблиц .xlsx и .csv прямо в браузере, без сторонних библиотек.
// Возвращает массив строк, каждая строка — массив значений ячеек (строки или числа).

async function readTableFile(file) {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(decodeText(bytes));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes);
  if (name.endsWith('.xls')) {
    throw new Error('Это файл старого формата .xls. Откройте его в Google Таблицах или Excel и сохраните как .xlsx, затем загрузите снова.');
  }
  throw new Error('Не получилось прочитать файл. Подходят таблицы .xlsx и .csv.');
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const delimiter = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------- ZIP ---------- */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл повреждён или это не таблица Excel');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => files.has(name),
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      const start = f.offset + 30 + view.getUint16(f.offset + 26, true) + view.getUint16(f.offset + 28, true);
      const data = bytes.subarray(start, start + f.size);
      if (f.method === 0) return utf8.decode(data);
      if (f.method !== 8) throw new Error('Неподдерживаемое сжатие внутри файла');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    },
  };
}

/* ---------- XLSX ---------- */
function xml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

// Ищем по локальному имени, чтобы не зависеть от пространств имён.
function tags(node, name) {
  return [...node.getElementsByTagName('*')].filter((el) => el.localName === name);
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

async function readXlsx(bytes) {
  const zip = await unzip(bytes);
  const shared = [];
  const sst = await zip.text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of tags(xml(sst), 'si')) shared.push(tags(si, 't').map((t) => t.textContent).join(''));
  }

  // Первый лист книги.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const first = tags(xml(workbook), 'sheet')[0];
    const rid = first && [...first.attributes].find((a) => a.localName === 'id')?.value;
    const rel = tags(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) {
      const target = rel.getAttribute('Target').replace(/^\//, '');
      sheetPath = target.startsWith('xl/') ? target : 'xl/' + target;
    }
  }
  const sheet = await zip.text(sheetPath);
  if (!sheet) throw new Error('В файле не нашлось листа с данными');

  const rows = [];
  for (const r of tags(xml(sheet), 'row')) {
    const rowNum = Number(r.getAttribute('r')) || rows.length + 1;
    const row = [];
    let col = 0;
    for (const c of tags(r, 'c')) {
      const ref = c.getAttribute('r');
      if (ref) col = columnIndex(ref);
      const type = c.getAttribute('t');
      const v = tags(c, 'v')[0]?.textContent;
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = tags(c, 't').map((t) => t.textContent).join('');
      else if (type === 'str' || type === 'e') value = v ?? '';
      else if (type === 'b') value = v === '1' ? 'да' : 'нет';
      else if (v !== undefined && v !== '') value = Number(v);
      row[col] = value;
      col++;
    }
    rows[rowNum - 1] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x ?? []);
}
