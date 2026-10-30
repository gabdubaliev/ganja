'use strict';

// Оформление: из настроек собирается CSS с переменными, который подключается после style.css
// (программа) или shop.css (витрина) и переопределяет цвета, шрифт и скругления.

const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif',
};

// Палитры программы — те же, что в style.css. Нужны, чтобы включить светлую или тёмную тему принудительно.
const LIGHT = {
  'color-scheme': 'light', '--bg': '#f4f5f2', '--surface': '#fcfcfb', '--ink': '#0b0b0b', '--ink-2': '#52514e', '--muted': '#7a7873',
  '--grid': '#e1e0d9', '--axis': '#c3c2b7', '--border': 'rgba(11, 11, 11, 0.10)', '--hover': 'rgba(11, 11, 11, 0.04)', '--rest': '#d4d3cb',
  '--good-ink': '#006300', '--critical': '#d03b3b',
};
const DARK = {
  'color-scheme': 'dark', '--bg': '#0d0d0d', '--surface': '#1a1a19', '--ink': '#f0efec', '--ink-2': '#c3c2b7', '--muted': '#8f8d87',
  '--grid': '#2c2c2a', '--axis': '#383835', '--border': 'rgba(255, 255, 255, 0.10)', '--hover': 'rgba(255, 255, 255, 0.05)', '--rest': '#4a4a46',
  '--good-ink': '#0ca30c', '--critical': '#e05555',
};

const block = (vars) => Object.entries(vars).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `  ${k}: ${v};`).join('\n');

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function themeCss(d) {
  const own = {
    '--series': d.accent,
    '--series-soft': rgba(d.accent, 0.14),
    '--bg': d.bg,
    '--surface': d.surface,
    '--ink': d.ink,
    '--font': FONT_STACKS[d.font] || FONT_STACKS.system,
    '--radius': `${d.radius}px`,
  };
  const parts = [];
  if (d.theme === 'light') parts.push(`:root {\n${block(LIGHT)}\n}`);
  if (d.theme === 'dark') parts.push(`:root {\n${block(DARK)}\n}`);
  // Свои цвета действуют в обеих темах; если тема «как в системе», тёмная получает только акцент.
  parts.push(`:root {\n${block(own)}\n}`);
  if (d.theme === 'auto' && (d.bg || d.surface || d.ink)) {
    parts.push(`@media (prefers-color-scheme: dark) {\n:root {\n${block({ '--bg': d.bg, '--surface': d.surface, '--ink': d.ink })}\n}\n}`);
  }
  parts.push('.btn.primary { background: var(--series); border-color: var(--series); }');
  if (d.css) parts.push(`/* Свой CSS */\n${d.css}`);
  return parts.join('\n\n') + '\n';
}

function shopCss(s) {
  const vars = {
    '--accent': s.accent,
    '--accent-soft': rgba(s.accent, 0.12),
    '--bg': s.bg,
    '--surface': s.surface,
    '--ink': s.ink,
    '--ink-soft': rgba(s.ink, 0.62),
    '--line': rgba(s.ink, 0.12),
    '--font': FONT_STACKS[s.font] || FONT_STACKS.system,
    '--radius': `${s.radius}px`,
    '--cols': s.columns,
  };
  return `:root {\n${block(vars)}\n}\n${s.css ? `\n/* Свой CSS */\n${s.css}\n` : ''}`;
}

module.exports = { themeCss, shopCss, FONT_STACKS };
