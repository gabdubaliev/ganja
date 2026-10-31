'use strict';

// Штрихкоды EAN-13: проверка и картинка SVG (этикетки, карточка товара, сертификаты).

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = EAN_L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).reverse().join(''));
const EAN_R = EAN_L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).join(''));
// Какие цифры левой половины кодируются набором G — определяется первой цифрой.
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function eanValid(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

// SVG штрихкода EAN-13 или null, если код не EAN-13.
// module — ширина самой узкой полосы в миллиметрах для печати. Термопринтер печатает точками
// (203 точки на дюйм = 0,125 мм), и полоса ровно в целое число точек выходит чёткой —
// так сканер читает код увереннее. Без module картинка подстраивается под место на экране.
function barcodeSvg(code, { height = 50, module = 0, barsMm = 0 } = {}) {
  if (!eanValid(code)) return null;
  const d = [...code].map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (EAN_PARITY[d[0]][i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]];
  bits += '101';
  // Охранные полосы (по краям и в середине) длиннее остальных, под ними — цифры.
  const guard = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  const quiet = 9;
  const width = bits.length + quiet * 2;
  let bars = '';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') bars += `<rect x="${i + quiet}" y="0" width="1" height="${guard.has(i) ? height + 5 : height}"/>`;
  }
  const t = (x, s) => `<text x="${x}" y="${height + 12}" font-size="10" text-anchor="middle">${s}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 14}"${module ? ` width="${(width * module).toFixed(3)}mm" height="${barsMm}mm" preserveAspectRatio="none"` : ''} shape-rendering="crispEdges" class="barcode" role="img" aria-label="Штрихкод ${code}">
    <rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g>
    <g font-family="monospace" fill="#000">${t(4, code[0])}${t(quiet + 3 + 21, code.slice(1, 7))}${t(quiet + 50 + 21, code.slice(7))}</g></svg>`;
}
