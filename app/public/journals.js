'use strict';

// «Движение товара» — все чеки и документы (закупки, списания, перемещения…) одной лентой по дням;
// «Движение денег» — каждый приход и расход по счетам: оплаты клиентов, комиссии, возвраты, оплата поставщикам,
// расходы, внесения, изъятия, переводы. Фильтры: поиск, период, статус, тип, счёт.

const GJ_TYPES = {
  sale: ['Продажа', 'sale'], return: ['Возврат', 'return'], purchase: ['Закупка', 'purchase'], receipt: ['Оприходование', 'receipt'],
  writeoff: ['Списание', 'writeoff'], inventory: ['Инвентаризация', 'inventory'], transfer: ['Перемещение', 'transfer'],
};
const GJ_STATUS = { posted: ['✓', 'Проведён'], draft: ['○', 'Черновик'], refunded: ['↩', 'Возвращён'], done: ['✓', 'Проведён'] };
const weekAgo = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - 6 * 864e5; };
const journalState = () => ({ from: weekAgo(), to: Date.now(), q: '', status: '', type: '', account: '', category: '', shop: 'all', list: [], open: new Set() });
// Несколько магазинов — владелец видит все сразу (по умолчанию) или один; колонка «Отправитель» / «Магазин» показывает чей.
const jrMulti = () => session.isOwner && (session.branch?.allowed?.length || 0) > 1;
function jrShop(prefix, st) {
  const row = $(`#${prefix}-shop-row`);
  row.hidden = !jrMulti();
  if (!jrMulti()) return '';
  $(`#${prefix}-shop`).innerHTML = `<option value="all" ${st.shop === 'all' ? 'selected' : ''}>Все магазины</option>` + session.branch.allowed.map((b) => `<option value="${b.id}" ${String(b.id) === st.shop ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  return `&shop=${st.shop}`;
}
const jrHere = (x) => !x.branch_id || x.branch_id === (session.branch?.id || 1);
const gj = journalState();
const mj = journalState();

// Период: «с … по …» и сколько дней.
function journalPeriod(prefix, st) {
  const f = $(`#${prefix}-from`), t = $(`#${prefix}-to`);
  if (!f.value) f.value = dateInput(st.from);
  if (!t.value) t.value = dateInput(st.to);
  st.from = fromDateInput(f.value);
  st.to = fromDateInput(t.value) + 864e5;
  const days = Math.max(1, Math.round((st.to - st.from) / 864e5));
  $(`#${prefix}-days`).textContent = `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}
const dayTitle = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const jrTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
// Строки по дням: заголовок дня и строки под ним.
function byDays(list, row, cols) {
  let day = '';
  return list.map((x) => {
    const d = dayTitle(x.at);
    const head = d !== day ? `<tr class="jr-day"><td colspan="${cols}">${d}</td></tr>` : '';
    day = d;
    return head + row(x);
  }).join('');
}
const fillSelect = (sel, first, values, cur) => {
  sel.innerHTML = `<option value="">${first}</option>` + values.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
};

/* ---------- Движение товара ---------- */
async function renderGoods() {
  journalPeriod('gj', gj);
  try { gj.list = await api(`/api/journal/goods?from=${gj.from}&to=${gj.to}${jrShop('gj', gj)}`); } catch (err) { return toast(err.message, 'error'); }
  fillSelect($('#gj-type'), 'Все типы', Object.entries(GJ_TYPES).filter(([k]) => gj.list.some((x) => x.type === k)).map(([k, [l]]) => [k, l]), gj.type);
  fillSelect($('#gj-pay'), 'Оплата: все', [...new Set(gj.list.flatMap((x) => (x.methods ? x.methods.split(', ') : [])))].sort().map((m) => [m, m]).concat([['—', 'Без оплаты']]), gj.account);
  const q = gj.q.trim().toLowerCase();
  const list = gj.list.filter((x) => (!gj.type || x.type === gj.type)
    && (!gj.status || (gj.status === 'posted' ? x.status === 'posted' || x.status === 'refunded' : x.status === gj.status))
    && (!gj.account || (gj.account === '—' ? !x.methods : x.methods.split(', ').includes(gj.account)))
    && (!q || [x.number, x.note, x.sender, x.recipient, x.author, x.register, ...(x.items || []).map((i) => i.name)].join(' ').toLowerCase().includes(q)));
  const sales = list.filter((x) => x.type === 'sale' && x.status === 'posted');
  $('#gj-sub').textContent = `${list.length} ${plural(list.length, ['документ', 'документа', 'документов'])} · продажи ${money(sales.reduce((a, x) => a + x.total, 0))}`;
  const create = docKinds();
  $('#gj-create').hidden = !create.length;
  $('#gj-create-menu').innerHTML = create.map((k) => `<button type="button" data-gj-new="${k}">${DOC_KIND[k].icon} ${DOC_KIND[k].name}</button>`).join('');
  $('#gj-body').innerHTML = list.length ? byDays(list, (x) => {
    const [label, cls] = GJ_TYPES[x.type] || [x.type, ''];
    const [mark, st] = GJ_STATUS[x.status] || ['', x.status];
    const key = `${x.type}:${x.id}:${x.branch_id || ''}`;
    const open = x.type === 'sale' && gj.open.has(key);
    return `<tr class="jr-row ${x.status}" data-gj="${key}" tabindex="0">
      <td class="jr-st ${x.status}" title="${st}">${mark}</td>
      <td class="jr-doc"><span class="jr-tag ${cls}">${label} <b>№${esc(String(x.number ?? x.id))}</b></span>${x.direction === 'in' ? ' <span class="pcat">входящее</span>' : ''}${x.note ? `<div class="pcat">${esc(x.note)}</div>` : ''}</td>
      <td data-l="Время">${jrTime(x.at)}</td>
      <td class="num" data-l="Позиций">${int(x.lines)}</td>
      <td class="num jr-sum" data-l="Сумма">${x.discount ? '<span class="jr-disc" title="Со скидкой">%</span> ' : ''}${money2(x.total)}</td>
      <td class="num" data-l="Оплачено">${x.paid ? money2(x.paid) : '—'}${x.methods ? `<div class="pcat">${esc(x.methods)}</div>` : ''}</td>
      <td data-l="Отправитель">${esc(x.sender)}</td>
      <td data-l="Получатель">${esc(x.recipient)}</td>
      <td data-l="Автор">${esc(x.author || '—')}${x.register ? `<div class="pcat">${esc(x.register)}</div>` : ''}</td>
    </tr>${open ? `<tr class="jr-items"><td></td><td colspan="8"><ul>${x.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qtyFmt.format(i.qty)} × ${money2(i.price)} = ${money2(i.qty * i.price)}</span></li>`).join('')}</ul></td></tr>` : ''}`;
  }, 9) : '<tr><td colspan="9" class="empty">За этот период ничего нет</td></tr>';
}

$('#gj-body').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-gj]');
  if (!tr) return;
  const [type, id, branch] = tr.dataset.gj.split(':');
  // Чек — раскрыть состав; документ — открыть.
  if (type === 'sale') {
    const key = tr.dataset.gj;
    if (gj.open.has(key)) gj.open.delete(key); else gj.open.add(key);
    return renderGoods();
  }
  if (branch && Number(branch) !== (session.branch?.id || 1)) return toast('Документ другого магазина — откройте его, переключив магазин вверху', 'error');
  openDoc(Number(id));
});
$('#gj-create').addEventListener('click', () => { $('#gj-create-menu').hidden = !$('#gj-create-menu').hidden; });
$('#gj-create-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gj-new]');
  if (!b) return;
  $('#gj-create-menu').hidden = true;
  newDoc(b.dataset.gjNew);
});

/* ---------- Движение денег ---------- */
async function renderCashflow() {
  journalPeriod('mj', mj);
  try { mj.list = await api(`/api/journal/money?from=${mj.from}&to=${mj.to}${jrShop('mj', mj)}`); } catch (err) { return toast(err.message, 'error'); }
  fillSelect($('#mj-account'), 'Все счета', [...new Set(mj.list.map((x) => x.account).filter((a) => a && a !== '—'))].sort().map((a) => [a, a]), mj.account);
  fillSelect($('#mj-category'), 'Все категории', [...new Set(mj.list.map((x) => x.category))].sort().map((c) => [c, c]), mj.category);
  const q = mj.q.trim().toLowerCase();
  const list = mj.list.filter((x) => (!mj.type || x.dir === mj.type)
    && (!mj.status || x.status === mj.status)
    && (!mj.account || x.account === mj.account)
    && (!mj.category || x.category === mj.category)
    && (!q || [x.ref, x.number, x.note, x.counterparty, x.account, x.category, x.author].join(' ').toLowerCase().includes(q)));
  const done = list.filter((x) => x.status === 'done');
  const inSum = done.filter((x) => x.dir === 'in').reduce((a, x) => a + x.amount, 0);
  const outSum = done.filter((x) => x.dir === 'out').reduce((a, x) => a + x.amount, 0);
  $('#mj-totals').innerHTML = `<span>Приход <b class="pos-text">+${money2(inSum)}</b></span><span>Расход <b class="neg">−${money2(outSum)}</b></span><span>Итого <b>${inSum - outSum >= 0 ? '+' : '−'}${money2(Math.abs(inSum - outSum))}</b></span>`;
  $('#mj-sub').textContent = `${list.length} ${plural(list.length, ['операция', 'операции', 'операций'])}`;
  const what = (x) => (x.src === 'sale' ? `чек №${x.ref}` : x.src === 'doc' ? `${x.kind === 'purchase' ? 'закупка' : 'возврат'} №${x.number}` : x.src === 'cert' ? (x.number ? `сертификат ${x.number}` : 'сертификат') : '');
  $('#mj-body').innerHTML = list.length ? byDays(list, (x) => {
    const [mark, st] = x.status === 'refunded' ? ['↩', 'Чек возвращён — деньги не учитываются'] : ['✓', 'Проведён'];
    return `<tr class="jr-row ${x.status}" ${x.src === 'doc' && jrHere(x) ? `data-mj-doc="${x.ref}" tabindex="0"` : ''}>
      <td class="jr-st ${x.status}" title="${st}">${mark}</td>
      <td class="jr-doc"><span class="jr-tag ${x.dir}">${x.dir === 'in' ? 'Приход' : 'Расход'}</span>${what(x) ? ` <span class="pcat">${esc(what(x))}</span>` : ''}${x.note ? `<div class="pcat">${esc(x.note)}</div>` : ''}</td>
      <td data-l="Время">${jrTime(x.at)}</td>
      <td class="num pos-text jr-sum ${x.dir === 'in' ? '' : 'jr-empty'}" data-l="Приход">${x.dir === 'in' ? money2(x.amount) : '—'}</td>
      <td class="num neg jr-sum ${x.dir === 'out' ? '' : 'jr-empty'}" data-l="Расход">${x.dir === 'out' ? money2(x.amount) : '—'}</td>
      <td data-l="Контрагент">${esc(x.counterparty || '—')}</td>
      <td data-l="Счёт">${esc(x.account || '—')}${x.shop && mj.shop === 'all' && jrMulti() ? `<div class="pcat">${esc(x.shop)}</div>` : ''}</td>
      <td data-l="Категория">${esc(x.category)}</td>
      <td data-l="Автор">${esc(x.author || '—')}</td>
    </tr>`;
  }, 9) : '<tr><td colspan="9" class="empty">За этот период движений денег нет</td></tr>';
}
$('#mj-body').addEventListener('click', (e) => { const tr = e.target.closest('[data-mj-doc]'); if (tr) openDoc(Number(tr.dataset.mjDoc)); });
$('#mj-create').addEventListener('click', () => { $('#mj-create-menu').hidden = !$('#mj-create-menu').hidden; });
$('#mj-create-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mj-new]');
  if (!b) return;
  $('#mj-create-menu').hidden = true;
  if (b.dataset.mjNew === 'expense') { location.hash = 'reports'; setTimeout(() => $('#np-add')?.click(), 400); } else location.hash = 'accounts';
});

$('#gj-status').addEventListener('click', (e) => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  gj.status = b.dataset.st;
  for (const x of $('#gj-status').querySelectorAll('[data-st]')) x.setAttribute('aria-pressed', String(x === b));
  renderGoods();
});
// Фильтры обоих журналов.
for (const [prefix, st, render] of [['gj', gj, () => renderGoods()], ['mj', mj, () => renderCashflow()]]) {
  let timer = null;
  $(`#${prefix}-q`).addEventListener('input', (e) => { st.q = e.target.value; clearTimeout(timer); timer = setTimeout(render, 200); });
  for (const [id, key] of [...(prefix === 'mj' ? [['status', 'status']] : []), ['type', 'type'], ['pay', 'account'], ['account', 'account'], ['category', 'category'], ['shop', 'shop']]) {
    $(`#${prefix}-${id}`)?.addEventListener('change', (e) => { st[key] = e.target.value; render(); });
  }
  $(`#${prefix}-from`).addEventListener('change', render);
  $(`#${prefix}-to`).addEventListener('change', render);
}
document.addEventListener('click', (e) => {
  for (const id of ['gj', 'mj']) if (!e.target.closest(`#${id}-create, #${id}-create-menu`)) { const m = $(`#${id}-create-menu`); if (m) m.hidden = true; }
});

views.goods = { show: renderGoods, right: ['sales', 'docs.sale', 'arrivals', 'refund', 'writeoff', 'stock', 'transfer'] };
views.cashflow = { show: renderCashflow, right: ['accounts', 'reports.money'] };
