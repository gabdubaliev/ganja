'use strict';

// Штрихкоды для конструктора: EAN-13 (из barcode.js), Code 128 (буквы и цифры) и QR-код.
// Всё рисуется в SVG без сторонних библиотек: программа работает и без интернета.

/* ---------- Code 128 ---------- */
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232'];
const C128_STOP = '2331112';

// Значения символов: цифры парами — набор C (вдвое короче), остальное — набор B (латиница, цифры, знаки).
function code128Values(text) {
  const s = String(text);
  if (!s.length || [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126)) return null;
  const vals = [];
  const digitsOnly = /^\d+$/.test(s) && s.length >= 2;
  if (digitsOnly) {
    vals.push(105);
    const even = s.length - (s.length % 2);
    for (let i = 0; i < even; i += 2) vals.push(Number(s.slice(i, i + 2)));
    if (s.length % 2) vals.push(100, s.charCodeAt(s.length - 1) - 32);
  } else {
    vals.push(104);
    for (const ch of s) vals.push(ch.charCodeAt(0) - 32);
  }
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103);
  return vals;
}

// Полосы как строка модулей: 1 — чёрный, 0 — белый.
function code128Bits(text) {
  const vals = code128Values(text);
  if (!vals) return null;
  let bits = '';
  for (const pattern of [...vals.map((v) => C128[v]), C128_STOP]) {
    [...pattern].forEach((w, i) => { bits += (i % 2 ? '0' : '1').repeat(Number(w)); });
  }
  return bits;
}

/* ---------- EAN-13 модулями (для единого рисования) ---------- */
function ean13Bits(code) {
  let s = String(code).replace(/\D/g, '');
  if (s.length === 12) s += (10 - ([...s].reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  if (typeof eanValid !== 'function' || !eanValid(s)) return null;
  const d = [...s].map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (EAN_PARITY[d[0]][i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]];
  bits += '101';
  return { bits, text: s };
}

/* ---------- QR-код (байтовый режим, UTF-8) ---------- */
const QR_ECC = { // кодовых слов коррекции на блок, по версиям 1–40
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const QR_BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const QR_FORMAT = { L: 1, M: 0, Q: 3, H: 2 };

function qrRawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const qrDataCodewords = (ver, ecl) => Math.floor(qrRawModules(ver) / 8) - QR_ECC[ecl][ver - 1] * QR_BLOCKS[ecl][ver - 1];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

// Матрица QR: массив строк из true/false. ecl — уровень коррекции L/M/Q/H.
function qrMatrix(text, ecl = 'M') {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cap = qrDataCodewords(ver, ecl) * 8;
    const need = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= cap) break;
  }
  if (ver > 40) return null;
  // Биты данных: режим «байты», длина, данные, конец, добивка.
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = qrDataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Блоки и коды коррекции, перемежение.
  const nBlocks = QR_BLOCKS[ecl][ver - 1], eccLen = QR_ECC[ecl][ver - 1];
  const raw = Math.floor(qrRawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });
  }
  // Служебные узоры.
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((a, i) => pos.forEach((b, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const format = (mask) => {
    const d = (QR_FORMAT[ecl] << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
    setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
    setF(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const v = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setF(a, c, v); setF(c, a, v);
    }
  }
  // Данные змейкой.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < all.length * 8) { m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
  // Маска: из восьми выбирается та, где меньше «штрафов» (сплошные полосы, квадраты, перекос чёрного/белого).
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const apply = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let a = 0; a < size; a++) {
      for (const line of [(t) => m[a][t], (t) => m[t][a]]) {
        let run = 1;
        for (let t = 1; t < size; t++) {
          if (line(t) === line(t - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    for (const row of m) for (const c of row) if (c) dark++;
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) {
    apply(k); format(k);
    const p = penalty();
    if (p < bestP) { bestP = p; best = k; }
    apply(k);
  }
  apply(best); format(best);
  return m;
}

/* ---------- Рисование в SVG ---------- */
const svgEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Линейный штрихкод в прямоугольник w×h мм: полосы растягиваются по ширине, цифры — снизу (textMm — высота цифр).
function linearCodeSvg(bits, label, w, h, { textMm = 0, quiet = 10 } = {}) {
  const total = bits.length + quiet * 2;
  const bar = Math.max(1, h - (textMm ? textMm * 1.15 : 0));
  let rects = '';
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== '1') { i++; continue; }
    let j = i;
    while (bits[j] === '1') j++;
    rects += `<rect x="${i + quiet}" y="0" width="${j - i}" height="${bar}"/>`;
    i = j;
  }
  // Ширина в модулях, высота в мм: масштаб по X и Y разный, цифры — отдельным SVG поверх, чтобы не растягивались.
  return `<svg class="code" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" preserveAspectRatio="none" width="100%" height="100%" shape-rendering="crispEdges">${rects}</svg>`
    + (textMm ? `<div class="code-text" style="font-size:${textMm}mm">${svgEsc(label)}</div>` : '');
}

function qrSvg(text, ecl = 'M') {
  const m = qrMatrix(text, ecl);
  if (!m) return null;
  const n = m.length, q = 4;
  let path = '';
  m.forEach((row, y) => row.forEach((c, x) => { if (c) path += `M${x + q} ${y + q}h1v1h-1z`; }));
  return `<svg class="code" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" width="100%" height="100%" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
}

// Штрихкод любого вида в рамку w×h мм. kind: ean13 | code128 | qr | auto (EAN-13, если подходит, иначе Code 128).
function anyCodeSvg(kind, value, w, h, { showText = true, textMm = 2.6, ecl = 'M' } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (kind === 'qr') return qrSvg(v, ecl);
  if (kind === 'ean13' || (kind === 'auto' && /^\d{12,13}$/.test(v))) {
    const e = ean13Bits(v);
    if (e) return linearCodeSvg(e.bits, e.text, w, h, { textMm: showText ? textMm : 0 });
    if (kind === 'ean13') return null;
  }
  const bits = code128Bits(v);
  return bits ? linearCodeSvg(bits, v, w, h, { textMm: showText ? textMm : 0 }) : null;
}
