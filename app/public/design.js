'use strict';

// Оформление программы: название, тема, цвета, шрифт, скругления и свой CSS.
// Изменения видны сразу, «Сохранить» применяет их для всех сотрудников.

const DESIGN_PRESETS = {
  classic: { name: 'Классика', accent: '#2a78d6', bg: '', surface: '', ink: '', font: 'system', radius: 10, theme: 'auto' },
  forest: { name: 'Лес', accent: '#2f9e44', bg: '#f3f7f1', surface: '#fbfdfa', ink: '', font: 'rounded', radius: 14, theme: 'light' },
  sunset: { name: 'Закат', accent: '#e8590c', bg: '#fbf5ef', surface: '#fffdfa', ink: '', font: 'system', radius: 12, theme: 'light' },
  grape: { name: 'Виноград', accent: '#7048e8', bg: '', surface: '', ink: '', font: 'rounded', radius: 16, theme: 'auto' },
  night: { name: 'Ночь', accent: '#f5b301', bg: '', surface: '', ink: '', font: 'system', radius: 10, theme: 'dark' },
  strict: { name: 'Строгий', accent: '#111111', bg: '#ffffff', surface: '#ffffff', ink: '#000000', font: 'condensed', radius: 2, theme: 'light' },
};
const designView = { saved: null, draft: null };
// Цвет, которым поле показывает «по умолчанию»: у <input type=color> не бывает пустого значения.
const DEFAULT_SWATCH = { bg: '#f4f5f2', surface: '#fcfcfb', ink: '#0b0b0b' };

function renderDesign() {
  designView.saved = { ...session.design };
  designView.draft = { ...session.design };
  $('#design-presets').innerHTML = Object.entries(DESIGN_PRESETS).map(([key, p]) => `
    <button type="button" class="template" data-preset="${key}" style="--t-bg:${p.bg || '#f4f5f2'};--t-surface:${p.surface || '#fcfcfb'};--t-accent:${p.accent};--t-ink:${p.ink || '#0b0b0b'};--t-radius:${p.radius}px">
      <span class="t-swatch"><i></i><i></i><i></i></span>${p.name}
    </button>`).join('');
  $('#df-font').innerHTML = Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  fillDesignForm();
}

function fillDesignForm() {
  const f = $('#design-form');
  const d = designView.draft;
  for (const el of f.elements) {
    if (!el.name || !(el.name in d)) continue;
    el.value = el.type === 'color' && !d[el.name] ? DEFAULT_SWATCH[el.name] : d[el.name];
    if (el.dataset.optional !== undefined) el.closest('.color').classList.toggle('unset', !d[el.name]);
  }
  $('#design-form [data-out="radius"]').textContent = d.radius;
  $('#design-error').hidden = true;
}

// Предпросмотр: тема собирается так же, как на сервере, и подставляется вместо theme.css.
function previewDesign() {
  const d = designView.draft;
  const vars = {
    '--series': d.accent, '--series-soft': d.accent + '24', '--font': FONT_STACK[d.font], '--radius': d.radius + 'px',
    ...(d.bg && { '--bg': d.bg }), ...(d.surface && { '--surface': d.surface }), ...(d.ink && { '--ink': d.ink }),
  };
  let style = $('#design-preview');
  if (!style) {
    style = document.createElement('style');
    style.id = 'design-preview';
    document.head.append(style);
  }
  const scheme = d.theme === 'auto' ? '' : `:root { color-scheme: ${d.theme}; }`;
  style.textContent = `${scheme}\n:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }\n.btn.primary { background: var(--series); border-color: var(--series); }\n${d.css}`;
  // Принудительная тема и палитра тёмного режима есть только в серверной теме — для них нужен «Сохранить».
  for (const el of document.querySelectorAll('.nav .logo')) el.textContent = d.name || 'Мой магазин';
}

const FONT_STACK = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif',
};

$('#design-form').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name || !(el.name in designView.draft)) return;
  designView.draft[el.name] = el.type === 'range' ? Number(el.value) : el.value;
  if (el.dataset.optional !== undefined) el.closest('.color').classList.remove('unset');
  $('#design-form [data-out="radius"]').textContent = designView.draft.radius;
  previewDesign();
});
$('#design-form').addEventListener('click', (e) => {
  const reset = e.target.closest('[data-reset]');
  const preset = e.target.closest('[data-preset]');
  if (reset) {
    e.preventDefault();
    designView.draft[reset.dataset.reset] = '';
  } else if (preset) {
    const { name, ...p } = DESIGN_PRESETS[preset.dataset.preset];
    Object.assign(designView.draft, p);
  } else return;
  fillDesignForm();
  previewDesign();
});
$('#design-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    session.design = await api('/api/design', { method: 'PUT', body: designView.draft });
    // Перечитываем серверную тему и убираем предпросмотр.
    $('#theme-css').href = '/theme.css?v=' + Date.now();
    $('#design-preview')?.remove();
    applyBrand(session.design.name);
    renderDesign();
    toast('Оформление сохранено для всех');
  } catch (err) {
    showFormError('#design-error', err);
  }
});
$('#design-reset').addEventListener('click', () => {
  designView.draft = { ...designView.saved };
  $('#design-preview')?.remove();
  applyBrand(designView.saved.name);
  fillDesignForm();
});

views.design = { show: renderDesign, right: 'design' };
