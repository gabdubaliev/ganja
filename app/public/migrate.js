'use strict';

// Перенос товаров из CloudShop: выгрузка → черновые карточки (всё редактируется) → перенос отмеченных в «Товары».
// Строки одного товара (код «-1», «-2»… или цвет/размер в скобках) собраны в одну карточку с модификациями.
// Остаток товара с модификациями вводится по ячейкам «цвет × размер»; перенос — только когда сумма сошлась.

const migView = { items: [], filter: 'todo', q: '', page: 0, suppliers: [], loaded: false };
const MIG_PAGE = 50;
const MIG_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const migKey = (c, s) => `${c ?? ''}\u0001${s ?? ''}`;
const migN = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
const migFmt = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 100) / 100).replace('.', ',') : '');

// Сколько распределено по ячейкам и сколько ячеек.
function migSplit(d) {
  const v = d.variants || {};
  const colors = v.colors?.length ? v.colors : [null];
  const sizes = v.sizes?.length ? v.sizes : [null];
  let total = 0;
  for (const c of colors) for (const s of sizes) total += Number(v.qty?.[migKey(c, s)]) || 0;
  return { total, cells: (v.colors?.length || v.sizes?.length) ? colors.length * sizes.length : 0 };
}
// Что требует внимания у карточки.
function migIssues(it) {
  const d = it.data;
  const out = [];
  if (it.error) out.push(it.error);
  if (Number(d.stock) < 0) out.push('отрицательный остаток');
  if (!(Number(d.price) > 0)) out.push('нет цены продажи');
  if (d.variants?.on) {
    const { total, cells } = migSplit(d);
    if (!cells) out.push('не выбраны цвета или размеры');
    else if (Math.abs(total - Number(d.stock)) > 1e-9 && !d.ignoreMismatch) out.push(`распределено ${migFmt(total)} из ${migFmt(d.stock)}`);
  } else if (d.barcode && migView.dupBarcodes?.has(d.barcode)) out.push('штрихкод повторяется у других товаров');
  if (migView.dupNames?.has(`${d.name}\u0001${d.category}`.toLowerCase())) out.push('такое же название в той же категории');
  return out;
}
function migIndex() {
  const bc = new Map(), nm = new Map();
  for (const it of migView.items) {
    if (it.status === 'skip') continue;
    const d = it.data;
    if (d.barcode && !d.variants?.on) bc.set(d.barcode, (bc.get(d.barcode) || 0) + 1);
    const k = `${d.name}\u0001${d.category}`.toLowerCase();
    nm.set(k, (nm.get(k) || 0) + 1);
  }
  // Названия, которые уже есть в программе (не из этого переноса).
  const doneIds = new Set(migView.items.map((i) => i.product_id).filter(Boolean));
  for (const p of catalog.list) if (!p.parent_id && !doneIds.has(p.id)) { const k = `${p.name}\u0001${p.category}`.toLowerCase(); nm.set(k, (nm.get(k) || 0) + 1); }
  migView.dupBarcodes = new Set([...bc].filter(([, n]) => n > 1).map(([k]) => k));
  migView.dupNames = new Set([...nm].filter(([, n]) => n > 1).map(([k]) => k));
}

const MIG_FILTERS = {
  todo: ['К переносу', (it) => it.status === 'new' && it.data.selected],
  attention: ['Нужно проверить', (it) => it.status === 'new' && it.data.selected && migIssues(it).length > 0],
  variants: ['С модификациями', (it) => it.status === 'new' && it.data.variants?.on],
  off: ['Не переносить', (it) => it.status === 'new' && !it.data.selected],
  done: ['Перенесено', (it) => it.status === 'done'],
  all: ['Все', () => true],
};
function migFiltered() {
  const q = migView.q.trim().toLowerCase();
  return migView.items.filter(MIG_FILTERS[migView.filter][1]).filter((it) => !q || it.data.name.toLowerCase().includes(q) || String(it.data.code).toLowerCase().includes(q) || String(it.data.article || '').toLowerCase().includes(q)
    || it.sources.some((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)));
}

async function renderMigrate() {
  try {
    const [r, sup] = await Promise.all([api('/api/migrate'), api('/api/suppliers').catch(() => []), categories.load(), catalog.load()]);
    migView.items = r.items;
    migView.suppliers = sup;
  } catch (err) {
    return toast(err.message, 'error');
  }
  migDraw();
}
function migDraw() {
  migIndex();
  const items = migView.items;
  const has = items.length > 0;
  $('#mig-clear').hidden = !has;
  $('#mig-upload-btn').hidden = has;
  const count = (f) => items.filter(MIG_FILTERS[f][1]).length;
  const done = count('done');
  $('#mig-sub').textContent = has ? `${items.length} ${plural(items.length, ['карточка', 'карточки', 'карточек'])} из ${items.reduce((n, i) => n + i.sources.length, 0)} строк выгрузки` : 'Загрузите файл, выгруженный из CloudShop (Товары → Экспорт)';
  $('#mig-stats').innerHTML = has ? [
    ['К переносу', count('todo'), 'отмечены галочкой'],
    ['Нужно проверить', count('attention'), 'остаток, цена, размеры, повторы'],
    ['С модификациями', count('variants'), 'цвета и размеры'],
    ['Перенесено', done, done ? 'уже в «Товарах»' : 'пока ничего'],
  ].map(([t, n, s]) => `<div class="st-tile"><span>${t}</span><b class="num">${n}</b><small>${s}</small></div>`).join('') : '';
  $('#mig-filters').innerHTML = has ? Object.entries(MIG_FILTERS).map(([k, [label]]) => `<button type="button" class="chip" data-mig-filter="${k}" aria-pressed="${migView.filter === k}">${label} <small>${count(k)}</small></button>`).join('') : '';
  $('#mig-bulk').hidden = !has || !session.can('migrate');
  // Колонки цен — по галочкам «Перенос из CloudShop: видеть …».
  for (const k of ['purchase', 'cost', 'markup', 'margin']) document.body.classList.toggle(`no-mig-${k}`, !session.can(`migrate.${k}`));
  for (const id of ['#mig-upload-btn', '#mig-clear']) if ($(id) && !session.can('migrate')) $(id).hidden = true;
  $('#mig-search').hidden = !has;
  $('#mig-cats').innerHTML = categories.list.map((c) => `<option value="${esc(c.name)}">`).join('');
  const list = migFiltered();
  const pages = Math.max(1, Math.ceil(list.length / MIG_PAGE));
  migView.page = Math.min(migView.page, pages - 1);
  const shown = list.slice(migView.page * MIG_PAGE, (migView.page + 1) * MIG_PAGE);
  const selectedCount = items.filter((i) => i.status === 'new' && i.data.selected).length;
  $('#mig-count').textContent = `Отмечено: ${selectedCount}`;
  $('#mig-run').textContent = `Перенести отмеченные (${selectedCount})`;
  $('#mig-all').checked = list.length > 0 && list.every((i) => i.status === 'done' || i.data.selected);
  const supOpts = (id) => `<option value="">—</option>${migView.suppliers.map((s) => `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  $('#mig-body').innerHTML = !has ? '<tr><td colspan="13" class="empty">Выгрузка ещё не загружена</td></tr>' : shown.length ? shown.map((it) => {
    const d = it.data;
    const done = it.status === 'done';
    const dis = done || !session.can('migrate') ? 'disabled' : '';
    const markup = d.calc?.markup ?? null;
    const margin = d.calc?.margin ?? null;
    const issues = migIssues(it);
    const sp = migSplit(d);
    const varLabel = d.variants?.on
      ? `${d.variants.colors?.length || 0} цв. × ${d.variants.sizes?.length || 0} разм.<br><small>${migFmt(sp.total)} из ${migFmt(d.stock)}</small>`
      : 'нет';
    const src = it.sources;
    return `<tr data-mig="${it.id}" class="${done ? 'mig-done' : ''} ${issues.length && !done ? 'mig-warn' : ''}">
      <td><input type="checkbox" data-mig-sel ${d.selected || done ? 'checked' : ''} ${dis} aria-label="Переносить"></td>
      <td class="mig-name"><input class="input" data-f="name" value="${esc(d.name)}" ${dis}>
        <small>${esc(d.code || '—')}${src.length > 1 ? ` · собрано из ${src.length} строк` : ''}${d.created ? ` · создан ${new Date(d.created).toLocaleDateString('ru-RU')}` : ''}${src[0].group ? ` · ${esc(src[0].group)}` : ''}</small>
        ${done ? '<small class="mig-ok">✓ перенесён</small>' : issues.length ? `<small class="mig-issue">⚠ ${esc(issues.join('; '))}</small>` : ''}</td>
      <td class="mig-art"><input class="input" data-f="article" value="${esc(d.article || '')}" placeholder="—" title="Артикул берётся из названия; можно исправить" ${dis}></td>
      <td><input class="input" data-f="category" list="mig-cats" value="${esc(d.category || '')}" placeholder="—" ${dis}></td>
      <td><select class="input" data-f="supplier_id" ${dis}>${supOpts(d.supplier_id)}</select></td>
      <td class="mig-c-purchase"><input class="input num" data-f="purchase" inputmode="decimal" value="${migFmt(d.purchase)}" ${dis}></td>
      <td class="mig-c-cost"><input class="input num" data-f="cost" inputmode="decimal" value="${migFmt(d.cost)}" ${dis}></td>
      <td class="mig-c-markup"><input class="input num" data-f="markup" inputmode="decimal" value="${markup === null ? '' : migFmt(markup)}" title="В CloudShop: ${src[0].markup ?? '—'}%" ${dis}></td>
      <td><input class="input num" data-f="price" inputmode="decimal" value="${migFmt(d.price)}" ${dis}></td>
      <td class="num mig-c-margin" title="В CloudShop: ${src[0].margin ?? '—'}%">${margin === null ? '—' : migFmt(margin) + '%'}</td>
      <td><input class="input num" data-f="stock" inputmode="decimal" value="${migFmt(d.stock)}" ${dis}></td>
      <td>${d.variants?.on ? '<small>новые у каждой модификации</small>' : `<input class="input" data-f="barcode" value="${esc(d.barcode || '')}" ${dis}>`}</td>
      <td><button type="button" class="btn small ${d.variants?.on ? '' : 'ghost'}" data-mig-var ${dis}>${varLabel}</button>${src.length > 1 && !done && session.can('migrate') ? '<button type="button" class="link" data-mig-split>Разделить</button>' : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="13" class="empty">В этом списке пусто</td></tr>';
  $('#mig-pager').innerHTML = pages > 1 ? `<button type="button" class="btn small" data-mig-page="-1" ${migView.page ? '' : 'disabled'}>‹ Назад</button>
    <span>Страница ${migView.page + 1} из ${pages} · ${list.length} шт</span>
    <button type="button" class="btn small" data-mig-page="1" ${migView.page < pages - 1 ? '' : 'disabled'}>Вперёд ›</button>` : list.length ? `<span>${list.length} шт</span>` : '';
}
const migItem = (id) => migView.items.find((i) => i.id === Number(id));
async function migSave(id, patch) {
  try {
    const it = await api(`/api/migrate/${id}`, { method: 'PUT', body: patch });
    const i = migView.items.findIndex((x) => x.id === it.id);
    if (i >= 0) migView.items[i] = it;
    return it;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/* ---------- Загрузка выгрузки ---------- */
// Столбцы CloudShop: ID, Наименование, Код, Группа, Штрих-код, Единица измерения, Цена продажи, Себестоимость,
// Цена закупки, Маржинальность, Наценка, Создан, Общий остаток (или «<магазин> (Остаток)»).
$('#mig-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rows = await readTableFile(file);
    const hi = rows.findIndex((r) => r.some((c) => String(c).trim() === 'Наименование'));
    if (hi < 0) throw new Error('Не похоже на выгрузку CloudShop: нет столбца «Наименование»');
    const head = rows[hi].map((c) => String(c).trim());
    const col = (...names) => { for (const n of names) { const i = head.findIndex((h) => h === n); if (i >= 0) return i; } return -1; };
    const stockCol = col('Общий остаток') >= 0 ? col('Общий остаток') : head.findIndex((h) => /\(Остаток\)$/.test(h));
    const c = { srcId: col('ID'), name: col('Наименование'), code: col('Код'), group: col('Группа'), barcode: col('Штрих-код', 'Штрихкод'), unit: col('Единица измерения'),
      price: col('Цена продажи'), cost: col('Себестоимость'), purchase: col('Цена закупки'), margin: col('Маржинальность'), markup: col('Наценка'), created: col('Создан'), stock: stockCol };
    for (const [k, label] of [['price', 'Цена продажи'], ['stock', 'Общий остаток']]) if (c[k] < 0) throw new Error(`В файле нет столбца «${label}»`);
    const cell = (r, k) => (c[k] < 0 ? '' : r[c[k]] ?? '');
    const text = (v) => (typeof v === 'number' && Number.isInteger(v) ? v.toFixed(0) : String(v ?? '').trim());
    const out = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!String(cell(r, 'name')).trim()) continue;
      out.push({ line: i + 1, srcId: text(cell(r, 'srcId')), name: text(cell(r, 'name')), code: text(cell(r, 'code')), group: text(cell(r, 'group')), barcode: text(cell(r, 'barcode')),
        unit: text(cell(r, 'unit')), price: migN(cell(r, 'price')) || 0, cost: migN(cell(r, 'cost')) || 0, purchase: migN(cell(r, 'purchase')) || 0,
        margin: cell(r, 'margin') === '' ? null : migN(cell(r, 'margin')), markup: cell(r, 'markup') === '' ? null : migN(cell(r, 'markup')), created: cell(r, 'created'), stock: migN(cell(r, 'stock')) || 0 });
    }
    const res = await api('/api/migrate/upload', { method: 'POST', body: { rows: out } });
    toast(`Загружено строк: ${res.rows}. Карточек: ${res.items}, из них собрано с модификациями: ${res.grouped}`);
    migView.filter = 'todo';
    renderMigrate();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#mig-clear').addEventListener('click', async () => {
  const done = migView.items.filter((i) => i.status === 'done').length;
  if (!confirm(`Удалить черновик переноса и загрузить выгрузку заново?${done ? `\n\nУже перенесённые товары (${done}) останутся в «Товарах».` : ''}\nВсе правки в карточках переноса пропадут.`)) return;
  try { await api('/api/migrate', { method: 'DELETE' }); toast('Черновик переноса удалён'); renderMigrate(); } catch (err) { toast(err.message, 'error'); }
});

/* ---------- Правка в таблице ---------- */
$('#mig-body').addEventListener('change', async (e) => {
  const tr = e.target.closest('tr[data-mig]');
  if (!tr) return;
  const it = migItem(tr.dataset.mig);
  if (e.target.matches('[data-mig-sel]')) { await migSave(it.id, { selected: e.target.checked }); return migDraw(); }
  const f = e.target.dataset.f;
  if (!f) return;
  const v = e.target.value;
  let patch;
  if (f === 'markup') {
    // Наценка — от цены закупки; цена продажи округляется до целого сома.
    const m = migN(v);
    if (!Number.isFinite(m)) return toast('Нужно число', 'error');
    patch = { markupPct: m }; // цену от закупки считает сервер
  } else if (['purchase', 'cost', 'price', 'stock'].includes(f)) {
    if (!Number.isFinite(migN(v))) return toast('Нужно число', 'error');
    patch = { [f]: migN(v) };
    // Себестоимость повторяет закупку, если были равны.
    // Себестоимость = закупка + добавка из настроек, если её не вписывали отдельно.
    if (f === 'purchase' && (it.data.cost === it.data.purchase || Math.abs(it.data.cost - it.data.purchase - migCostExtra) < 0.01 || !it.data.cost)) patch.cost = Math.round((migN(v) + migCostExtra) * 100) / 100;
  } else patch = { [f]: f === 'supplier_id' ? (v ? Number(v) : null) : v };
  await migSave(it.id, patch);
  migDraw();
});
$('#mig-body').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-mig]');
  if (!tr) return;
  if (e.target.closest('[data-mig-var]')) openMigVariants(Number(tr.dataset.mig));
  if (e.target.closest('[data-mig-split]')) {
    if (!confirm('Разделить на отдельные товары, как было в CloudShop? Модификации этой карточки сбросятся.')) return;
    try { await api(`/api/migrate/${tr.dataset.mig}/split`, { method: 'POST' }); renderMigrate(); } catch (err) { toast(err.message, 'error'); }
  }
});
$('#mig-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mig-filter]');
  if (!b) return;
  migView.filter = b.dataset.migFilter;
  migView.page = 0;
  migDraw();
});
$('#mig-pager').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mig-page]');
  if (!b) return;
  migView.page += Number(b.dataset.migPage);
  migDraw();
  $('[data-view="migrate"] .table-wrap')?.scrollIntoView({ block: 'start' });
});
let migTimer = null;
$('#mig-search').addEventListener('input', (e) => { clearTimeout(migTimer); migTimer = setTimeout(() => { migView.q = e.target.value; migView.page = 0; migDraw(); }, 200); });

/* ---------- Действия с отмеченными ---------- */
const migChecked = () => migView.items.filter((i) => i.status === 'new' && i.data.selected);
$('#mig-all').addEventListener('change', async (e) => {
  const ids = migFiltered().filter((i) => i.status === 'new').map((i) => i.id);
  if (!ids.length) return;
  try { await api('/api/migrate/bulk', { method: 'POST', body: { ids, patch: { selected: e.target.checked } } }); renderMigrate(); } catch (err) { toast(err.message, 'error'); }
});
$('#mig-bulk').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mig-bulk]');
  if (!b) return;
  const ids = migChecked().map((i) => i.id);
  if (!ids.length) return toast('Отметьте товары галочками', 'error');
  const kind = b.dataset.migBulk;
  migBulkState = { kind, ids };
  $('#mig-bulk-title').textContent = `${{ category: 'Категория', supplier: 'Поставщик', sizes: 'Размеры (модификации)' }[kind]} — отмечено ${ids.length}`;
  $('#mig-bulk-field').innerHTML = kind === 'category'
    ? `<div class="field"><label for="mb-cat">Категория (выберите или впишите новую)</label><input id="mb-cat" class="input" list="mig-cats" autocomplete="off"></div>`
    : kind === 'supplier'
      ? (migView.suppliers.length ? `<div class="field"><label for="mb-sup">Поставщик</label><select id="mb-sup" class="input"><option value="">— без поставщика —</option>${migView.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>` : '<p class="pick-meta">Поставщиков пока нет — добавьте их в «Ещё → Поставщики».</p>')
      : `<p class="pick-meta">Включит модификации с этими размерами (цвета и количество — в окне «Модификации» каждого товара).</p>
         <div class="gen-chips">${MIG_SIZES.map((s) => `<button type="button" class="gen-chip" data-mb-size="${s}" aria-pressed="${['M', 'L', 'XL', '2XL', '3XL'].includes(s)}">${s}</button>`).join('')}</div>`;
  $('#mig-bulk-dlg').showModal();
  $('#mb-cat')?.focus();
});
let migBulkState = null;
$('#mig-bulk-field').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mb-size]');
  if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
});
$('#mig-bulk-cancel').addEventListener('click', () => $('#mig-bulk-dlg').close());
$('#mig-bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { kind, ids } = migBulkState;
  let patch;
  if (kind === 'category') patch = { category: $('#mb-cat').value.trim() };
  else if (kind === 'supplier') { if (!$('#mb-sup')) return $('#mig-bulk-dlg').close(); patch = { supplier_id: $('#mb-sup').value ? Number($('#mb-sup').value) : null }; }
  else { const sizes = [...document.querySelectorAll('[data-mb-size][aria-pressed="true"]')].map((x) => x.dataset.mbSize); patch = { variants: { on: sizes.length > 0, sizes } }; }
  try {
    await api('/api/migrate/bulk', { method: 'POST', body: { ids, patch } });
    $('#mig-bulk-dlg').close();
    toast(`Изменено: ${ids.length}`);
    renderMigrate();
  } catch (err) { toast(err.message, 'error'); }
});
$('#mig-merge').addEventListener('click', async () => {
  const list = migChecked();
  if (list.length < 2) return toast('Отметьте две или больше строк одного товара (например, разные цвета)', 'error');
  if (list.length > 30) return toast('Слишком много строк для одного товара — отметьте только строки этого товара', 'error');
  if (!confirm(`Объединить ${list.length} строк в один товар «${list[0].data.name}»? Каждая строка станет своей модификацией (цвет/размер из скобок в названии).`)) return;
  try { await api('/api/migrate/merge', { method: 'POST', body: { ids: list.map((i) => i.id) } }); toast('Объединено'); renderMigrate(); } catch (err) { toast(err.message, 'error'); }
});
$('#mig-run').addEventListener('click', async () => {
  const list = migChecked();
  if (!list.length) return toast('Отметьте товары для переноса', 'error');
  const bad = list.filter((i) => migIssues(i).some((x) => /распределено|не выбраны|нет цены/.test(x)));
  if (!confirm(`Перенести ${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])} в «Товары»?${bad.length ? `\n\n${bad.length} не перенесутся, пока не исправите (размеры или цена) — они останутся в списке «Нужно проверить».` : ''}\n\nПеренос можно отменить в «Журнале действий».`)) return;
  $('#mig-run').disabled = true;
  try {
    let done = 0, products = 0, variants = 0;
    const failed = [];
    // Частями по 100 — чтобы не держать базу долго.
    for (let i = 0; i < list.length; i += 100) {
      const r = await api('/api/migrate/import', { method: 'POST', body: { ids: list.slice(i, i + 100).map((x) => x.id) } });
      done += r.done; products += r.products; variants += r.variants; failed.push(...r.failed);
      $('#mig-run').textContent = `Переношу… ${Math.min(i + 100, list.length)} из ${list.length}`;
    }
    toast(`Перенесено: ${done} (модификаций: ${variants})${failed.length ? `. Не перенесено: ${failed.length} — см. «Нужно проверить»` : ''}`, failed.length ? 'error' : undefined);
    if (failed.length) migView.filter = 'attention';
  } catch (err) {
    toast(err.message, 'error');
  }
  $('#mig-run').disabled = false;
  renderMigrate();
});

/* ---------- Модификации: цвета × размеры, остаток по ячейкам ---------- */
const migVar = { id: null, v: null };
function openMigVariants(id) {
  const it = migItem(id);
  migVar.id = id;
  migVar.v = JSON.parse(JSON.stringify(it.data.variants || { on: false, colors: [], sizes: [], qty: {} }));
  migVar.v.qty ||= {};
  migVar.ignore = Boolean(it.data.ignoreMismatch);
  $('#mig-var-title').textContent = it.data.name;
  $('#mig-var-sub').textContent = `Остаток в CloudShop: ${migFmt(it.data.stock)} шт. Отметьте цвета и размеры и разложите остаток по ячейкам.`;
  $('#mig-var-src').innerHTML = it.sources.length > 1 ? `<details class="mig-src"><summary>Строки CloudShop (${it.sources.length})</summary><ul>${it.sources.map((s) => `<li>${esc(s.code)} — ${esc(s.name)}: ${migFmt(s.stock)} шт${s.color || s.size ? ` → ${esc([s.color, s.size].filter(Boolean).join(', '))}` : ''}</li>`).join('')}</ul></details>` : '';
  $('#mig-var-on').checked = Boolean(migVar.v.on);
  migVarDraw();
  $('#mig-var').showModal();
}
function migVarDraw() {
  const it = migItem(migVar.id);
  const v = migVar.v;
  const body = $('#mig-var-body');
  if (!v.on) { body.innerHTML = '<p class="pick-meta">Товар перенесётся без модификаций — одной карточкой с общим остатком и старым штрихкодом.</p>'; return; }
  const known = typeof knownValues === 'function' ? knownValues('Цвет') : [];
  // Без повторов «Черный/Чёрный»: ё = е.
  const seen = new Set();
  const colorChoices = [...v.colors, ...known, ...(typeof PRESET_COLORS !== 'undefined' ? PRESET_COLORS : [])].filter((c) => { const k = c.toLowerCase().replace(/ё/g, 'е'); if (seen.has(k)) return false; seen.add(k); return true; });
  const sizeChoices = [...new Set([...MIG_SIZES, ...v.sizes])];
  const chip = (kind, val, on) => `<button type="button" class="gen-chip" data-mv-${kind}="${esc(val)}" aria-pressed="${on}">${kind === 'color' && typeof swatchBg === 'function' ? `<i style="background:${swatchBg(val)}"></i>` : ''}${esc(val)}</button>`;
  const colors = v.colors.length ? v.colors : [null];
  const sizes = v.sizes.length ? (typeof sizeSort === 'function' ? sizeSort(v.sizes) : v.sizes) : [null];
  const { total } = migSplit({ variants: v });
  const stock = Number(it.data.stock) || 0;
  const ok = Math.abs(total - stock) < 1e-9;
  body.innerHTML = `
    <div class="mig-var-row"><b>Цвета</b> <small>(можно без цвета — тогда только размеры)</small></div>
    <div class="gen-chips">${colorChoices.map((c) => chip('color', c, v.colors.includes(c))).join('')}
      <input class="input small mig-add" id="mv-color-add" placeholder="+ свой цвет"></div>
    <div class="mig-var-row"><b>Размеры</b> <button type="button" class="link" data-mv-preset="M,L,XL,2XL,3XL">M–3XL</button> <button type="button" class="link" data-mv-preset="M,L,XL,2XL,3XL,4XL,5XL">M–5XL</button></div>
    <div class="gen-chips">${sizeChoices.map((s) => chip('size', s, v.sizes.includes(s))).join('')}
      <input class="input small mig-add" id="mv-size-add" placeholder="+ свой (44, 32…)"></div>
    ${v.colors.length || v.sizes.length ? `<div class="mig-var-row"><b>Количество</b> <small>(кнопки − и + или впишите число)</small></div>
    <div class="mv-grid">${colors.map((c) => `<section class="mv-color">
      ${c ? `<div class="mv-color-head">${typeof swatchBg === 'function' ? `<i style="background:${swatchBg(c)}"></i>` : ''}<b>${esc(c)}</b><small data-mv-ctotal="${esc(c)}">${migFmt(sizes.reduce((a, s) => a + (Number(v.qty[migKey(c, s)]) || 0), 0))} шт</small></div>` : ''}
      <div class="mv-cells">${sizes.map((s) => { const k = migKey(c, s); return `<div class="mv-cell">
        <span class="mv-size">${esc(s ?? 'Кол-во')}</span>
        <button type="button" class="mv-step" data-mv-step="-1" data-k="${esc(k)}" aria-label="Меньше">−</button>
        <input class="input num" data-mv-q="${esc(k)}" inputmode="numeric" value="${v.qty[k] ? migFmt(v.qty[k]) : ''}" placeholder="0" aria-label="${esc([c, s].filter(Boolean).join(', '))}">
        <button type="button" class="mv-step" data-mv-step="1" data-k="${esc(k)}" aria-label="Больше">+</button>
      </div>`; }).join('')}</div>
    </section>`).join('')}</div>` : '<p class="pick-meta">Отметьте цвета и/или размеры.</p>'}`;
  migVarSum();
}
$('#mig-var-on').addEventListener('change', (e) => {
  migVar.v.on = e.target.checked;
  if (migVar.v.on && !migVar.v.sizes.length && !migVar.v.colors.length) migVar.v.sizes = ['M', 'L', 'XL', '2XL', '3XL'];
  migVarDraw();
});
$('#mig-var-body').addEventListener('click', (e) => {
  const v = migVar.v;
  const step = e.target.closest('[data-mv-step]');
  if (step) {
    const k = step.dataset.k;
    const n = Math.max(0, (Number(v.qty[k]) || 0) + Number(step.dataset.mvStep));
    if (n) v.qty[k] = n; else delete v.qty[k];
    const input = step.parentElement.querySelector('[data-mv-q]');
    input.value = n ? migFmt(n) : '';
    migVarSum();
    return;
  }
  const toggle = (list, val) => (list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  const c = e.target.closest('[data-mv-color]');
  const s = e.target.closest('[data-mv-size]');
  const p = e.target.closest('[data-mv-preset]');
  if (c) v.colors = toggle(v.colors, c.dataset.mvColor);
  else if (s) v.sizes = toggle(v.sizes, s.dataset.mvSize);
  else if (p) v.sizes = p.dataset.mvPreset.split(',');
  else return;
  migVarDraw();
});
// Итог внизу окна (закреплён рядом с «Сохранить») и итоги по цветам.
function migVarSum() {
  const v = migVar.v;
  const foot = $('#mig-var-foot');
  if (!v.on || !(v.colors.length || v.sizes.length)) { foot.innerHTML = ''; return; }
  const { total } = migSplit({ variants: v });
  const stock = Number(migItem(migVar.id).data.stock) || 0;
  const ok = Math.abs(total - stock) < 1e-9;
  foot.innerHTML = `<p class="mig-sum ${ok ? 'ok' : 'bad'}">Распределено <b>${migFmt(total)}</b> из ${migFmt(stock)} шт ${ok ? '✓' : ''}</p>
    ${ok ? '' : `<label class="check mv-ignore"><input type="checkbox" id="mv-ignore" ${migVar.ignore ? 'checked' : ''}> Остаток отличается от CloudShop — перенести ${migFmt(total)} шт, как распределено</label>`}`;
  for (const el of document.querySelectorAll('[data-mv-ctotal]')) {
    const c = el.dataset.mvCtotal;
    const sizes = v.sizes.length ? v.sizes : [null];
    el.textContent = `${migFmt(sizes.reduce((a, s) => a + (Number(v.qty[migKey(c, s)]) || 0), 0))} шт`;
  }
}
$('#mig-var-foot').addEventListener('change', (e) => { if (e.target.id === 'mv-ignore') migVar.ignore = e.target.checked; });
$('#mig-var-body').addEventListener('input', (e) => {
  const k = e.target.dataset.mvQ;
  if (k === undefined) return;
  const n = migN(e.target.value);
  if (e.target.value.trim() === '') delete migVar.v.qty[k]; else if (Number.isFinite(n)) migVar.v.qty[k] = n;
  migVarSum();
});
$('#mig-var-body').addEventListener('change', (e) => {
  if (e.target.id === 'mv-ignore') migVar.ignore = e.target.checked;
  if (e.target.id === 'mv-color-add' || e.target.id === 'mv-size-add') {
    const val = e.target.value.trim();
    if (!val) return;
    const list = e.target.id === 'mv-color-add' ? 'colors' : 'sizes';
    const norm = list === 'sizes' ? val.toUpperCase() : val[0].toUpperCase() + val.slice(1);
    if (!migVar.v[list].includes(norm)) migVar.v[list].push(norm);
    migVarDraw();
    $(`#${e.target.id}`)?.focus();
  }
});
$('#mig-var-cancel').addEventListener('click', () => $('#mig-var').close());
$('#mig-var-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = migVar.v;
  // В сохранение — только ячейки выбранных цветов и размеров.
  const qty = {};
  for (const c of v.colors.length ? v.colors : [null]) for (const s of v.sizes.length ? v.sizes : [null]) { const k = migKey(c, s); if (v.qty[k]) qty[k] = v.qty[k]; }
  const it = await migSave(migVar.id, { variants: { on: v.on, colors: v.colors, sizes: v.sizes, qty }, ignoreMismatch: migVar.ignore });
  if (!it) return;
  $('#mig-var').close();
  migDraw();
});

let migCostExtra = 0;
api('/api/settings/currency').then((r) => { migCostExtra = r.costExtra || 0; }).catch(() => {});
views.migrate = { show: renderMigrate, right: ['migrate', 'migrate.view'] };
