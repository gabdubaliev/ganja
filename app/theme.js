'use strict';

// Оформление: из настроек собирается CSS с переменными, который подключается после style.css
// (программа) или shop.css (витрина) и переопределяет цвета, шрифт и скругления.

const FONT_STACKS = {
  system: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif',
};

// Палитры программы — те же, что в style.css. Нужны, чтобы включить светлую или тёмную тему принудительно.
const LIGHT = {
  'color-scheme': 'light', '--bg': '#f4f5fa', '--surface': '#ffffff', '--surface-2': '#f6f7fb', '--ink': '#141625', '--ink-2': '#4a4f66', '--muted': '#8a8fa6',
  '--grid': '#eceef5', '--axis': '#d3d6e3', '--border': 'rgba(20, 22, 37, 0.08)', '--hover': 'rgba(91, 91, 246, 0.06)', '--rest': '#d9dbe7',
  '--good-ink': '#15803d', '--critical': '#e11d48',
};
const DARK = {
  'color-scheme': 'dark', '--bg': '#0e1018', '--surface': '#171a26', '--surface-2': '#1d2130', '--ink': '#eef0f8', '--ink-2': '#b9bdd2', '--muted': '#7f849c',
  '--grid': '#252a3b', '--axis': '#333a50', '--border': 'rgba(255, 255, 255, 0.08)', '--hover': 'rgba(129, 129, 255, 0.10)', '--rest': '#3a4058',
  '--good-ink': '#4ade80', '--critical': '#fb7185',
  '--shadow': '0 2px 4px rgba(0, 0, 0, 0.25), 0 8px 24px rgba(0, 0, 0, 0.35)', '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.3)',
};

const block = (vars) => Object.entries(vars).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `  ${k}: ${v};`).join('\n');

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Оформление программы сверх цветов: плотность, вид панелей, фон и верхнее меню.
const DENSITY = {
  compact: `.btn { padding: 7px 12px; } .btn.small { padding: 5px 9px; } .input { padding: 8px 10px; } th, td { padding: 7px 8px; } .panel { padding: 14px; } .nav a { padding: 6px 10px; } .page { padding-top: 14px; }`,
  comfortable: `.btn { padding: 12px 20px; } .input { padding: 12px 14px; } th, td { padding: 14px 12px; } .panel { padding: 26px; } body { font-size: 15.5px; }`,
};
const CARDS = {
  flat: `:root { --shadow: none; --shadow-sm: none; --shadow-lg: 0 12px 40px rgba(0,0,0,.12); } .panel, .st-tile, .tile { box-shadow: none !important; }`,
  outline: `:root { --shadow: none; --shadow-sm: none; } .panel, .st-tile, .tile { box-shadow: none !important; border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent) !important; }`,
  glass: `.panel, .st-tile, .tile { background: color-mix(in srgb, var(--surface) 72%, transparent) !important; backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4); border: 1px solid color-mix(in srgb, #fff 40%, transparent) !important; }`,
};
const BACKGROUNDS = {
  plain: `body { background-image: none !important; }`,
  gradient: `body { background-image: linear-gradient(160deg, color-mix(in srgb, var(--series) 16%, var(--bg)) 0%, var(--bg) 45%, color-mix(in srgb, var(--series) 8%, var(--bg)) 100%) !important; }`,
  mesh: `body { background-image: radial-gradient(700px 500px at 0% 0%, color-mix(in srgb, var(--series) 26%, transparent), transparent 60%), radial-gradient(600px 500px at 100% 20%, color-mix(in srgb, var(--series-2, #ec4899) 20%, transparent), transparent 60%), radial-gradient(800px 600px at 50% 110%, color-mix(in srgb, var(--series) 18%, transparent), transparent 60%) !important; }`,
};
const NAV_KEEP = `.nav a.nav-owner, .nav a.nav-owner:hover { color: #6b4300 !important; }`;
const NAVS = {
  dark: `.nav { background: #12141f !important; border-color: #12141f !important; } .nav a, .nav .logo { color: #e7e9f3 !important; } .nav a:hover { background: rgba(255,255,255,.08) !important; } .nav a[aria-current="page"] { background: rgba(255,255,255,.14) !important; color: #fff !important; } .nav .btn.ghost { color: #e7e9f3; background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.16); }`,
  accent: `.nav { background: var(--series) !important; border-color: transparent !important; } .nav a, .nav .logo { color: rgba(255,255,255,.9) !important; } .nav a:hover { background: rgba(255,255,255,.14) !important; } .nav a[aria-current="page"] { background: rgba(255,255,255,.22) !important; color: #fff !important; } .nav .logo::before { background: #fff !important; color: var(--series) !important; } .nav .btn.ghost { color: #fff; background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.24); }`,
};
const googleFontUrl = (f) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700;800&display=swap`;

// @font-face для загруженных шрифтов: файл отдаёт /fonts/:id.
const FONT_FORMAT = { 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'truetype', 'font/otf': 'opentype' };
function fontFaces(fonts = []) {
  return fonts.map((f) => `@font-face { font-family: "${f.family}"; src: url("/fonts/${f.id}"); font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap; }`).join('\n');
}

function themeCss(d, fonts = []) {
  const custom = new Set(fonts.map((f) => f.family));
  const google = d.font && !FONT_STACKS[d.font] && !custom.has(d.font);
  const own = {
    '--series': d.accent,
    '--series-soft': rgba(d.accent, 0.14),
    '--bg': d.bg,
    '--surface': d.surface,
    '--ink': d.ink,
    '--font': google ? `"${d.font}", ${FONT_STACKS.system}` : FONT_STACKS[d.font] || FONT_STACKS.system,
    '--radius': `${d.radius}px`,
  };
  const parts = [];
  if (google) parts.push(`@import url("${googleFontUrl(d.font)}");`);
  if (fonts.length) parts.push(fontFaces(fonts));
  if (custom.has(d.font)) own['--font'] = `"${d.font}", ${FONT_STACKS.system}`;
  if (d.theme === 'light') parts.push(`:root {\n${block(LIGHT)}\n}`);
  if (d.theme === 'dark') parts.push(`:root {\n${block(DARK)}\n}`);
  // Свои цвета действуют в обеих темах; если тема «как в системе», тёмная получает только акцент.
  parts.push(`:root {\n${block(own)}\n}`);
  if (d.theme === 'auto' && (d.bg || d.surface || d.ink)) {
    parts.push(`@media (prefers-color-scheme: dark) {\n:root {\n${block({ '--bg': d.bg, '--surface': d.surface, '--ink': d.ink })}\n}\n}`);
  }
  if (DENSITY[d.density]) parts.push(DENSITY[d.density]);
  if (CARDS[d.cards]) parts.push(CARDS[d.cards]);
  if (BACKGROUNDS[d.background]) parts.push(BACKGROUNDS[d.background]);
  if (NAVS[d.nav]) parts.push(NAVS[d.nav], NAV_KEEP);
  if (d.css) parts.push(`/* Свой CSS */\n${d.css}`);
  return parts.join('\n\n') + '\n';
}

function shopCss(s, fonts = []) {
  // Браузер скачивает только те шрифты, что реально используются, поэтому описаны все — так работает и предпросмотр.
  const used = fonts;
  const vars = {
    '--accent': s.accent,
    '--accent-soft': rgba(s.accent, 0.12),
    '--bg': s.bg,
    '--surface': s.surface,
    '--ink': s.ink,
    '--ink-soft': rgba(s.ink, 0.62),
    '--line': rgba(s.ink, 0.12),
    '--font': s.bodyFont ? `"${s.bodyFont}", ${FONT_STACKS.system}` : FONT_STACKS[s.font] || FONT_STACKS.system,
    '--font-head': s.headingFont ? `"${s.headingFont}", ${FONT_STACKS.system}` : 'var(--font)',
    '--radius': `${s.radius}px`,
    '--cols': s.columns,
    '--mcols': s.mobileColumns || 2,
    '--ratio': (s.cardRatio || '4:5').replace(':', ' / '),
    '--fit': s.imageFit || 'cover',
  };
  return `${used.length ? fontFaces(used) + '\n' : ''}:root {\n${block(vars)}\n}\n${s.css ? `\n/* Свой CSS */\n${s.css}\n` : ''}`;
}

module.exports = { themeCss, shopCss, FONT_STACKS, DENSITY, CARDS, BACKGROUNDS, NAVS };
