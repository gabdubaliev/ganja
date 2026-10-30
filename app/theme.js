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
