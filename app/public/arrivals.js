'use strict';

// Приход: поступление товара от поставщика.

const arrival = { lines: [] }; // { productId, qty, cost }

function renderArrivalPick() {
  const q = $('#arrival-search').value;
  const list = catalog.search(q, 8);
  $('#arrival-results').hidden = !q.trim();
  $('#arrival-results').innerHTML = list.map((p) => `
    <button type="button" class="suggest" data-id="${p.id}">
      <span>${esc(p.name)}</span><span class="pick-meta num">на складе ${qty(p.stock, p.unit)}</span>
    </button>`).join('') + `<button type="button" class="suggest new" data-new>+ Новый товар «${esc(q.trim())}»</button>`;
}

function renderArrival() {
  const total = arrival.lines.reduce((s, l) => s + l.qty * l.cost, 0);
  $('#arrival-lines').innerHTML = arrival.lines.length ? arrival.lines.map((l, i) => {
    const p = catalog.byId(l.productId);
    return `<tr data-i="${i}">
      <td><div class="pname">${esc(p.name)}</div><div class="pcat">сейчас на складе ${qty(p.stock, p.unit)}</div></td>
      <td><input class="input num" data-field="qty" inputmode="decimal" value="${l.qty ? String(l.qty).replace('.', ',') : ''}" placeholder="0" aria-label="Количество"></td>
      <td><input class="input num" data-field="cost" inputmode="decimal" value="${l.cost ? String(l.cost).replace('.', ',') : ''}" placeholder="0" aria-label="Закупочная цена"></td>
      <td class="num">${money2(l.qty * l.cost)}</td>
      <td><button type="button" class="icon-btn" data-remove aria-label="Убрать строку">×</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">Найдите товар выше, чтобы добавить его в приход</td></tr>';
  $('#arrival-total').textContent = money2(total);
  $('#arrival-save').disabled = !arrival.lines.length;
}

function addArrivalLine(p) {
  if (!arrival.lines.some((l) => l.productId === p.id)) arrival.lines.push({ productId: p.id, qty: 0, cost: p.cost });
  $('#arrival-search').value = '';
  $('#arrival-results').hidden = true;
  renderArrival();
  const row = $(`#arrival-lines tr[data-i="${arrival.lines.findIndex((l) => l.productId === p.id)}"] [data-field="qty"]`);
  row?.focus();
}

async function renderArrivalHistory() {
  try {
    const list = await api('/api/arrivals');
    $('#arrival-history').innerHTML = list.length ? list.map((a) => `
      <details class="doc">
        <summary>
          <span>${dateTime(a.created_at)}</span>
          <span class="doc-who">${esc(a.supplier || 'Поставщик не указан')}</span>
          <span class="pick-meta">${a.items.length} ${plural(a.items.length, ['позиция', 'позиции', 'позиций'])}</span>
          <b class="num">${money2(a.total)}</b>
        </summary>
        <ul>${a.items.map((i) => `<li><span>${esc(i.name)}</span><span class="num">${qty(i.qty, i.unit)} × ${money2(i.cost)}</span></li>`).join('')}</ul>
      </details>`).join('') : '<p class="empty">Приходов пока не было</p>';
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#arrival-search').addEventListener('input', renderArrivalPick);
$('#arrival-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const found = catalog.search(e.target.value, 2);
  if (found.length === 1) addArrivalLine(found[0]);
});
$('#arrival-results').addEventListener('click', (e) => {
  const btn = e.target.closest('.suggest');
  if (!btn) return;
  if (btn.hasAttribute('data-new')) {
    const name = $('#arrival-search').value.trim();
    openProductDialog(null, addArrivalLine);
    $('#product-form').elements.name.value = /^\d+$/.test(name) ? '' : name;
    if (/^\d+$/.test(name)) $('#product-form').elements.barcode.value = name;
  } else {
    addArrivalLine(catalog.byId(btn.dataset.id));
  }
});
$('#arrival-lines').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-i]');
  if (!row || !e.target.dataset.field) return;
  arrival.lines[Number(row.dataset.i)][e.target.dataset.field] = Math.max(0, parseNum(e.target.value) || 0);
  renderArrival();
});
$('#arrival-lines').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-i]');
  if (!row || !e.target.closest('[data-remove]')) return;
  arrival.lines.splice(Number(row.dataset.i), 1);
  renderArrival();
});
$('#arrival-save').addEventListener('click', async () => {
  const empty = arrival.lines.find((l) => !(l.qty > 0));
  if (empty) return toast(`Укажите количество для «${catalog.byId(empty.productId).name}»`, 'error');
  try {
    const saved = await api('/api/arrivals', { method: 'POST', body: { supplier: $('#arrival-supplier').value, items: arrival.lines } });
    toast(`Приход на ${money2(saved.total)} проведён, остатки обновлены`);
    arrival.lines = [];
    $('#arrival-supplier').value = '';
    await catalog.load();
    renderArrival();
    renderArrivalHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
});

views.arrivals = {
  async show() {
    try { await catalog.load(); } catch (err) { toast(err.message, 'error'); }
    arrival.lines = arrival.lines.filter((l) => catalog.byId(l.productId));
    renderArrival();
    renderArrivalHistory();
  },
};
