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

/* ---------- Свои шрифты: общие для программы и витрины ---------- */
let customFonts = [];
async function loadCustomFonts() {
  try { customFonts = await api('/api/fonts'); } catch { customFonts = []; }
  return customFonts;
}
const customFamilyList = () => [...new Set(customFonts.map((f) => f.family))];
const WEIGHTS = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const WEIGHT_WORDS = [[/extra-?light|ultra-?light/i, 200], [/semi-?bold|demi-?bold/i, 600], [/extra-?bold|ultra-?bold|heavy/i, 800],
  [/thin|hairline/i, 100], [/light/i, 300], [/medium/i, 500], [/black/i, 900], [/bold/i, 700], [/regular|normal|book/i, 400]];
// «Intro-Black.otf» → название Intro, жирность 900; «IntroItalic.ttf» → курсив.
function guessFont(fileName) {
  let base = fileName.replace(/\.(woff2?|ttf|otf)$/i, '');
  const italic = /italic|oblique/i.test(base);
  const weight = WEIGHT_WORDS.find(([re]) => re.test(base))?.[1] || 400;
  base = base.replace(/italic|oblique/ig, '');
  for (const [re] of WEIGHT_WORDS) base = base.replace(new RegExp(re.source, 'ig'), '');
  const family = base.replace(/[-_]+/g, ' ').replace(/([a-zа-я])([A-ZА-Я])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return { family: family || fileName, weight, style: italic ? 'italic' : 'normal' };
}
const fileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Не удалось прочитать файл'));
  r.readAsDataURL(file);
});

function renderFontList() {
  // Шрифты описаны в theme.css — после загрузки она перечитывается, чтобы образцы показались сразу.
  $('#font-list').innerHTML = customFonts.length ? customFonts.map((f) => `
    <li data-font="${f.id}">
      <span class="font-sample" style="font-family:'${esc(f.family)}';font-weight:${f.weight};font-style:${f.style}">Аа Бб Привет, мир 123</span>
      <small>${esc(f.file_name || '')} · ${Math.max(1, Math.round(f.size / 1024))} КБ</small>
      <input class="input" data-f="family" value="${esc(f.family)}" aria-label="Название шрифта" title="Название меняется у всех файлов этого шрифта">
      <select class="input" data-f="weight" aria-label="Жирность">${Object.entries(WEIGHTS).map(([w, n]) => `<option value="${w}" ${Number(w) === f.weight ? 'selected' : ''}>${w} · ${n}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-f="style" ${f.style === 'italic' ? 'checked' : ''}> курсив</label>
      <button type="button" class="btn small ghost" data-font-del="${f.id}" title="Удалить">✕</button>
    </li>`).join('') : '<li class="empty">Своих шрифтов пока нет.</li>';
}

function fillFontSelect() {
  const fams = customFamilyList();
  $('#df-font').innerHTML = (fams.length ? `<optgroup label="Мои шрифты">${fams.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Современные шрифты">${ADMIN_FONTS.map((f) => `<option value="${f}">${f}</option>`).join('')}</optgroup>`
    + `<optgroup label="Системные">${Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</optgroup>`;
  $('#df-font').value = designView.draft?.font || 'system';
}

async function afterFontsChanged() {
  await loadCustomFonts();
  $('#theme-css').href = '/theme.css?v=' + Date.now();
  // Переименование меняет и выбранный шрифт — берём оформление с сервера.
  try { session.design = await api('/api/design'); } catch { /* останется как было */ }
  if (designView.draft) designView.draft.font = session.design.font;
  renderFontList();
  fillFontSelect();
  if ($('#design-preview')) previewDesign();
}

$('#font-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const typed = $('#font-family').value.trim();
  let added = 0;
  for (const file of files) {
    const g = guessFont(file.name);
    try {
      await api('/api/fonts', { method: 'POST', body: { family: typed || g.family, weight: g.weight, style: g.style, fileName: file.name, data: await fileBase64(file) } });
      added++;
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
  if (!added) return;
  $('#font-family').value = '';
  await afterFontsChanged();
  toast(added === 1 ? 'Шрифт загружен — выберите его в списке «Шрифт»' : `Загружено шрифтов: ${added}`);
});
$('#font-list').addEventListener('change', async (e) => {
  const li = e.target.closest('[data-font]');
  if (!li) return;
  const body = {
    family: li.querySelector('[data-f="family"]').value,
    weight: Number(li.querySelector('[data-f="weight"]').value),
    style: li.querySelector('[data-f="style"]').checked ? 'italic' : 'normal',
  };
  try {
    await api(`/api/fonts/${li.dataset.font}`, { method: 'PUT', body });
    await afterFontsChanged();
    toast('Шрифт изменён');
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#font-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-font-del]');
  if (!del) return;
  e.preventDefault();
  if (!confirm('Удалить этот файл шрифта? Где он выбран, текст покажется обычным шрифтом.')) return;
  try {
    await api(`/api/fonts/${del.dataset.fontDel}`, { method: 'DELETE' });
    await afterFontsChanged();
  } catch (err) {
    toast(err.message, 'error');
  }
});
// Enter в названии шрифта не отправляет форму оформления.
$('#font-manager').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); e.target.blur(); } });

async function renderDesign() {
  await loadCustomFonts();
  designView.saved = { ...session.design };
  designView.draft = { ...session.design };
  renderFontList();
  $('#design-presets').innerHTML = Object.entries(DESIGN_PRESETS).map(([key, p]) => `
    <button type="button" class="template" data-preset="${key}" style="--t-bg:${p.bg || (p.theme === 'dark' ? '#14161f' : '#f4f5fa')};--t-surface:${p.surface || (p.theme === 'dark' ? '#1d2030' : '#ffffff')};--t-accent:${p.accent};--t-ink:${p.ink || (p.theme === 'dark' ? '#e7e9f1' : '#141625')};--t-radius:${p.radius}px">
      <span class="t-swatch"><i></i><i></i><i></i></span>${p.name}
    </button>`).join('');
  fillFontSelect();
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
