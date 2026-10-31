'use strict';

// Оформление программы: название, тема, цвета, шрифт, скругления и свой CSS.
// Изменения видны сразу, «Сохранить» применяет их для всех сотрудников.

const P = (name, accent, rest) => ({ name, accent, bg: '', surface: '', ink: '', font: 'Inter', radius: 14, theme: 'auto', density: 'normal', cards: 'shadow', background: 'soft', nav: 'light', ...rest });
const DESIGN_PRESETS = {
  classic: P('Индиго', '#5b5bf6', {}),
  aurora: P('Аврора', '#7c3aed', { font: 'Manrope', radius: 18, background: 'mesh', cards: 'glass', theme: 'light' }),
  ocean: P('Океан', '#0ea5e9', { font: 'Rubik', background: 'gradient', nav: 'accent' }),
  forest: P('Лес', '#2f9e44', { bg: '#f3f7f1', surface: '#fbfdfa', font: 'Nunito', theme: 'light' }),
  sunset: P('Закат', '#e8590c', { bg: '#fbf5ef', surface: '#fffdfa', font: 'Montserrat', radius: 12, theme: 'light', background: 'gradient' }),
  business: P('Деловой', '#2563eb', { font: 'IBM Plex Sans', radius: 8, nav: 'dark', cards: 'outline', background: 'plain', density: 'compact', theme: 'light' }),
  rose: P('Роза', '#e11d74', { bg: '#fdf4f7', surface: '#ffffff', font: 'Jost', radius: 20, background: 'mesh', theme: 'light' }),
  night: P('Ночь', '#f5b301', { radius: 10, theme: 'dark', nav: 'dark', background: 'mesh' }),
  graphite: P('Графит', '#22d3ee', { bg: '#0f1117', surface: '#171a23', ink: '#e7e9f1', font: 'Manrope', theme: 'dark', cards: 'outline', background: 'plain' }),
  strict: P('Строгий', '#111111', { bg: '#ffffff', surface: '#ffffff', ink: '#000000', font: 'condensed', radius: 2, theme: 'light', cards: 'outline', background: 'plain', density: 'compact' }),
};
const ADMIN_FONTS = ['Inter', 'Manrope', 'Montserrat', 'Rubik', 'Nunito', 'Roboto', 'Open Sans', 'Jost', 'PT Sans', 'IBM Plex Sans', 'Fira Sans'];
const designView = { saved: null, draft: null };
// Цвет, которым поле показывает «по умолчанию»: у <input type=color> не бывает пустого значения.
const DEFAULT_SWATCH = { bg: '#f4f5fa', surface: '#ffffff', ink: '#141625' };

function renderDesign() {
  designView.saved = { ...session.design };
  designView.draft = { ...session.design };
  $('#design-presets').innerHTML = Object.entries(DESIGN_PRESETS).map(([key, p]) => `
    <button type="button" class="template" data-preset="${key}" style="--t-bg:${p.bg || (p.theme === 'dark' ? '#14161f' : '#f4f5fa')};--t-surface:${p.surface || (p.theme === 'dark' ? '#1d2030' : '#ffffff')};--t-accent:${p.accent};--t-ink:${p.ink || (p.theme === 'dark' ? '#e7e9f1' : '#141625')};--t-radius:${p.radius}px">
      <span class="t-swatch"><i></i><i></i><i></i></span>${p.name}
    </button>`).join('');
  $('#df-font').innerHTML = `<optgroup label="Современные шрифты">${ADMIN_FONTS.map((f) => `<option value="${f}">${f}</option>`).join('')}</optgroup>`
    + `<optgroup label="Системные">${Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</optgroup>`;
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

// Предпросмотр: сервер собирает тему из черновика точно так же, как theme.css, и она подставляется вместо неё.
let previewSeq = 0;
async function previewDesign() {
  const d = designView.draft;
  for (const el of document.querySelectorAll('.nav .logo')) el.textContent = d.name || 'Мой магазин';
  const seq = ++previewSeq;
  let css;
  try { ({ css } = await api('/api/design/preview', { method: 'POST', body: d })); } catch { return; }
  if (seq !== previewSeq) return;
  let style = $('#design-preview');
  if (!style) {
    style = document.createElement('style');
    style.id = 'design-preview';
    document.head.append(style);
  }
  style.textContent = css;
  $('#theme-css').disabled = true;
}
function endPreview() {
  $('#design-preview')?.remove();
  $('#theme-css').disabled = false;
}

const FONT_STACK = {
  system: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
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
    endPreview();
    applyBrand(session.design.name);
    renderDesign();
    toast('Оформление сохранено для всех');
  } catch (err) {
    showFormError('#design-error', err);
  }
});
$('#design-reset').addEventListener('click', () => {
  designView.draft = { ...designView.saved };
  endPreview();
  applyBrand(designView.saved.name);
  fillDesignForm();
});

views.design = { show: renderDesign, right: 'design' };
