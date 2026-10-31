'use strict';

// Капча для входа и регистрации на витрине: картинка с цифрами, нарисованными линиями (без текста в SVG —
// бот не прочитает код из разметки), с наклоном, искажением и шумовыми кривыми. Код одноразовый, живёт 5 минут.

const crypto = require('node:crypto');

// Цифры как линии в квадрате 0..1 (ширина ~0.6). Без 0 и 1 — их легко спутать с O и I.
const DIGITS = {
  2: 'M0.05 0.25 C0.1 0 0.55 0 0.55 0.28 C0.55 0.5 0.05 0.7 0.02 1 L0.6 1',
  3: 'M0.05 0.12 C0.3 -0.05 0.6 0.05 0.55 0.25 C0.5 0.45 0.25 0.47 0.25 0.47 C0.6 0.47 0.65 0.75 0.5 0.9 C0.35 1.05 0.1 1 0.02 0.88',
  4: 'M0.45 1 L0.45 0 L0.02 0.7 L0.62 0.7',
  5: 'M0.55 0.02 L0.12 0.02 L0.08 0.45 C0.3 0.35 0.6 0.4 0.6 0.7 C0.6 1 0.2 1.05 0.03 0.88',
  6: 'M0.5 0.05 C0.2 0.05 0.03 0.35 0.05 0.65 C0.07 1 0.55 1.05 0.58 0.7 C0.6 0.4 0.15 0.4 0.06 0.62',
  7: 'M0.02 0.02 L0.6 0.02 L0.22 1',
  8: 'M0.3 0.48 C0 0.4 0.05 0.02 0.3 0.02 C0.55 0.02 0.6 0.4 0.3 0.48 C-0.02 0.55 0 1 0.3 1 C0.6 1 0.62 0.55 0.3 0.48 Z',
  9: 'M0.55 0.38 C0.45 0.6 0.02 0.55 0.04 0.3 C0.06 0 0.55 0 0.56 0.32 C0.58 0.7 0.4 1 0.1 0.98',
};
const TTL = 5 * 60_000;
const LIMIT = 5000;
const store = new Map();

const rnd = (a, b) => a + crypto.randomInt(0, 1_000_000) / 1_000_000 * (b - a);
// Чуть сдвинуть каждую точку пути — у каждой картинки цифры немного разные.
const jitter = (path, k) => path.replace(/-?\d*\.?\d+/g, (n) => (Number(n) + rnd(-k, k)).toFixed(3));

function create() {
  const keys = Object.keys(DIGITS);
  const code = Array.from({ length: 5 }, () => keys[crypto.randomInt(0, keys.length)]).join('');
  const W = 150, H = 52;
  const colors = ['#1f2937', '#7c2d12', '#1e3a8a', '#14532d', '#581c87', '#831843'];
  let body = '';
  // Шумовые кривые под цифрами и поверх.
  const curve = () => `<path d="M${rnd(-10, 10)} ${rnd(5, H - 5)} C${rnd(30, 60)} ${rnd(-10, H + 10)} ${rnd(80, 120)} ${rnd(-10, H + 10)} ${W + 10} ${rnd(5, H - 5)}" fill="none" stroke="${colors[crypto.randomInt(0, colors.length)]}" stroke-opacity="${rnd(0.25, 0.5).toFixed(2)}" stroke-width="${rnd(1, 2).toFixed(1)}"/>`;
  for (let i = 0; i < 3; i++) body += curve();
  [...code].forEach((d, i) => {
    const size = rnd(30, 36);
    const x = 10 + i * 27 + rnd(-3, 3), y = 8 + rnd(-3, 3);
    const tr = `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rnd(-14, 14).toFixed(1)} ${(size * 0.3).toFixed(1)} ${(size * 0.5).toFixed(1)}) skewX(${rnd(-8, 8).toFixed(1)}) scale(${size.toFixed(1)} ${(size * rnd(0.95, 1.1)).toFixed(1)})`;
    body += `<path d="${jitter(DIGITS[d], 0.03)}" transform="${tr}" fill="none" stroke="${colors[crypto.randomInt(0, colors.length)]}" stroke-width="${(rnd(2.6, 3.4) / size).toFixed(4)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  for (let i = 0; i < 2; i++) body += curve();
  for (let i = 0; i < 22; i++) body += `<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(0.6, 1.6).toFixed(1)}" fill="${colors[crypto.randomInt(0, colors.length)]}" fill-opacity="0.45"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Код с картинки">${body}</svg>`;
  const id = crypto.randomBytes(12).toString('base64url');
  // Старые коды убираются: и по времени, и чтобы память не росла.
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
  while (store.size >= LIMIT) store.delete(store.keys().next().value);
  store.set(id, { code, exp: now + TTL });
  return { id, svg };
}

// Проверка — один раз: и при верном, и при неверном ответе код больше не действует.
function verify(id, answer) {
  const c = store.get(String(id || ''));
  if (!c) return false;
  store.delete(String(id));
  return c.exp >= Date.now() && String(answer || '').replace(/\D/g, '') === c.code;
}

module.exports = { create, verify };
