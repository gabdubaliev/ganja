'use strict';

// Редактор интерфейса для владельца: «⚙️ Настройки → ✏️ Изменить интерфейс».
// Любую кнопку, ссылку, надпись, заголовок или блок страницы можно переименовать, сменить ей иконку
// (эмодзи или своя картинка), цвет, фон и размер, скрыть, передвинуть выше/ниже или поставить в другое место.
// Работает в базе, в кассе и на витрине (страница — body[data-ui-page]).
//
// Как находится элемент: при загрузке страницы, ДО того как программа что-то нарисует, каждому элементу
// из самой страницы даётся постоянный ключ (data-ui-key): его id или путь от ближайшего элемента с id.
// Списки, которые программа рисует сама (товары, чеки, клиенты), не затрагиваются — меняется «каркас».
// Изменения хранятся у сервера (одни на всех) и применяются у всех сотрудников и покупателей.

(() => {
  // Оформление редактора — здесь же: одинаково в базе, кассе и на витрине.
  const style = document.createElement('style');
  style.textContent = `.ui-hidden { display: none !important; }
body.ui-editing .ui-hidden { display: revert !important; opacity: .35; outline: 2px dashed #e11d48 !important; }
body.ui-editing [data-ui-key]:hover { outline: 2px dashed #6366f1; outline-offset: 2px; cursor: pointer; }
body.ui-editing .ui-picked { outline: 3px solid #6366f1 !important; outline-offset: 2px; }
.ui-icon { display: inline-block; line-height: 1; }
img.ui-icon { width: 1.25em; height: 1.25em; object-fit: contain; vertical-align: -0.2em; }
.ui-has-icon::before { display: none !important; }
.logo > .ui-icon { width: 34px; height: 34px; flex: none; display: grid; place-items: center; font-size: 26px; border-radius: 10px; object-fit: cover; }
#ui-bar { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 2000; display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; padding: 10px 12px; border-radius: 14px; background: #111827; color: #fff; font: 14px/1.3 system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
#ui-bar span { opacity: .75; }
#ui-bar button, #ui-pane button { border: 0; border-radius: 10px; padding: 8px 10px; background: #374151; color: #fff; font: inherit; cursor: pointer; }
#ui-bar .ui-done, #ui-pane .ui-done { background: #6366f1; }
#ui-pane { position: fixed; z-index: 2001; right: 8px; bottom: 76px; width: min(380px, calc(100vw - 16px)); max-height: 70vh; overflow: auto; display: grid; gap: 10px; padding: 14px; border-radius: 16px; background: #fff; color: #111; font: 14px/1.3 system-ui, sans-serif; box-shadow: 0 16px 40px rgba(0,0,0,.25); }
#ui-pane button { background: #eef0f4; color: #111; }
#ui-pane .ui-done { color: #fff; }
#ui-pane label { display: grid; gap: 4px; font-size: 12px; color: #555; flex: 1; }
#ui-pane input:not([type=checkbox]):not([type=color]):not([type=range]) { padding: 8px 10px; border: 1px solid #d0d4da; border-radius: 10px; font: inherit; color: #111; }
#ui-pane .ui-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: end; }
#ui-pane .ui-check { display: flex; align-items: center; gap: 6px; flex: 0; white-space: nowrap; }
.ui-pane-head { display: flex; justify-content: space-between; align-items: center; }
#ui-shop-edit { position: fixed; left: 12px; bottom: 12px; z-index: 1999; border: 0; border-radius: 999px; padding: 10px 14px; background: #111827; color: #fff; font: 600 14px system-ui, sans-serif; box-shadow: 0 8px 20px rgba(0,0,0,.25); cursor: pointer; }
`;
  document.head.append(style);
  const PAGE = document.body.dataset.uiPage || (document.body.classList.contains('kassa') ? 'kassa' : 'admin');
  const SEL = 'a, button, h1, h2, h3, h4, label, summary, th, p, li, section, header, .panel, .field, .chip, .logo, .st-tile, .tile, .tabs, .seg, .tools';
  const keyed = new Map(); // ключ -> элемент

  // 1. Ключи — сразу, пока страница «как в файле».
  function pathKey(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && !cur.id) {
      const tag = cur.tagName.toLowerCase();
      let i = 1;
      for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) i++;
      parts.unshift(`${tag}${i}`);
      cur = cur.parentElement;
    }
    return `${cur && cur.id ? `#${cur.id}` : 'body'}/${parts.join('/')}`;
  }
  for (const el of document.body.querySelectorAll(SEL)) {
    if (el.closest('script, template, #ui-bar, #ui-pane')) continue;
    const k = pathKey(el);
    if (keyed.has(k)) continue;
    el.dataset.uiKey = k;
    keyed.set(k, el);
  }

  let data = { items: {}, favicon: null };
  let editing = false;
  let picked = null;
  let moveFrom = null;

  // 2. Где у элемента текст и где иконка.
  const isIcon = (n) => n.nodeType === 1 && (n.tagName === 'svg' || n.classList.contains('ui-icon') || n.classList.contains('nav-emoji') || (n.tagName === 'SPAN' && n.getAttribute('aria-hidden') === 'true' && !n.children.length && n.textContent.trim().length <= 3));
  function textTarget(el) {
    if (!el.children.length) return el;
    // Надпись — span/b без вложенных элементов (может быть ещё пустой: программа заполнит её позже).
    const spans = [...el.querySelectorAll('span, b, strong')].filter((s) => !s.children.length && !isIcon(s) && !s.classList.contains('badge') && !s.classList.contains('ui-icon'));
    const filled = spans.filter((s) => s.textContent.trim());
    if (spans.length === 1) return spans[0];
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (direct) return null; // текст — прямыми узлами
    return filled[0] || spans[0] || null; // несколько надписей — меняем первую (главную)
  }
  function getText(el) {
    const t = textTarget(el);
    if (t) return t.textContent.trim();
    return [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  }
  function setText(el, value) {
    const t = textTarget(el);
    if (t) { t.textContent = value; return; }
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (nodes.length) { nodes[0].textContent = ` ${value} `; nodes.slice(1).forEach((n) => { n.textContent = ' '; }); }
    else el.append(document.createTextNode(` ${value}`));
  }
  const iconOf = (el) => [...el.children].find(isIcon) || null;
  function setIcon(el, icon) {
    const old = iconOf(el);
    if (el.dataset.uiOrigIcon === undefined) el.dataset.uiOrigIcon = old ? '1' : '0';
    // Иконка, нарисованная стилем (буква «М» в логотипе), — прячется, когда задана своя или убрана.
    el.classList.add('ui-has-icon');
    if (!icon) { if (old) old.style.display = 'none'; return; }
    let node;
    if (icon.img) {
      node = document.createElement('img');
      node.src = `/img/${icon.img}`;
      node.alt = '';
    } else {
      node = document.createElement('span');
      node.textContent = icon.emoji;
      node.setAttribute('aria-hidden', 'true');
    }
    node.className = 'ui-icon';
    if (old && old.classList.contains('ui-icon')) old.replaceWith(node);
    else if (old) { old.style.display = 'none'; old.before(node); }
    else el.prepend(node);
  }

  // 3. Применить сохранённое ко всем элементам страницы.
  function apply() {
    const items = data.items || {};
    for (const [k, o] of Object.entries(items)) {
      const el = keyed.get(k);
      if (!el) continue;
      if (o.text !== undefined && getText(el) !== o.text) setText(el, o.text);
      // Иконка: если программа перерисовала элемент и своя иконка пропала — ставим снова.
      if (o.icon !== undefined) {
        const has = o.icon ? el.querySelector(':scope > .ui-icon') : el.classList.contains('ui-has-icon') && !iconOf(el)?.offsetParent;
        if (!has || !el.dataset.uiIconDone) { setIcon(el, o.icon); el.dataset.uiIconDone = '1'; }
      }
      el.classList.toggle('ui-hidden', Boolean(o.hide));
      el.style.color = o.color || '';
      el.style.background = o.bg || '';
      el.style.fontSize = o.size ? `${o.size}%` : '';
      el.style.fontWeight = o.bold ? '700' : '';
    }
    // Перемещения — после всего остального (опора должна быть на месте).
    for (const [k, o] of Object.entries(items)) {
      if (!o.move) continue;
      const el = keyed.get(k);
      const ref = keyed.get(o.move.ref);
      if (!el || !ref || el.contains(ref)) continue;
      if (o.move.pos === 'before' ? ref.previousElementSibling !== el : ref.nextElementSibling !== el) {
        if (o.move.pos === 'before') ref.before(el); else ref.after(el);
      }
    }
    if (data.favicon) {
      let l = document.querySelector('link[rel="icon"]');
      if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.append(l); }
      if (!l.href.endsWith(`/img/${data.favicon}`)) l.href = `/img/${data.favicon}`;
    }
    if (editing) renderBar();
  }
  // Программа перерисовывает надписи (например, имя кнопки) — возвращаем свои.
  let tick = null;
  // Свои панели редактора (#ui-bar, #ui-pane) не считаются — иначе панель перерисовывала бы сама себя без конца.
  const own = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return Boolean(e && e.closest('#ui-bar, #ui-pane, #me-menu')); };
  new MutationObserver((list) => {
    if (list.every((m) => own(m.target))) return;
    clearTimeout(tick);
    tick = setTimeout(apply, 120);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  const loadUrl = PAGE === 'shop' ? '/shop/ui' : `/api/ui?page=${PAGE}`;
  fetch(loadUrl).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { data = { items: d.items || {}, favicon: d.favicon || null }; apply(); } }).catch(() => {});

  async function save() {
    const r = await fetch(`/api/ui?page=${PAGE}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Не сохранилось');
    data = { items: d.items || {}, favicon: d.favicon || null };
  }
  const item = (k) => (data.items[k] ||= {});
  const msg = (t, bad) => (typeof toast === 'function' ? toast(t, bad ? 'error' : undefined) : alert(t));

  // 4. Режим изменения.
  function renderBar() {
    let bar = document.getElementById('ui-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ui-bar';
      document.body.append(bar);
      bar.addEventListener('click', onBar);
    }
    const hidden = Object.entries(data.items).filter(([, o]) => o.hide).length;
    const html = moveFrom
      ? `<b>Куда поставить?</b> Нажмите на элемент — «${esc2(label(keyed.get(moveFrom)))}» встанет рядом с ним. <button type="button" data-ui="cancel-move">Отмена</button>`
      : `<b>✏️ Изменение интерфейса</b> <span>Нажмите на любую кнопку, надпись или блок</span>
        <button type="button" data-ui="favicon">Иконка вкладки</button>
        <button type="button" data-ui="hidden">Скрытые (${hidden})</button>
        <button type="button" data-ui="reset-all">Сбросить всё</button>
        <button type="button" data-ui="done" class="ui-done">Готово</button>`;
    // Перерисовываем, только если что-то поменялось: кнопки не «дёргаются» под пальцем.
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  }
  const esc2 = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = (el) => (el ? (getText(el) || el.getAttribute('aria-label') || el.tagName.toLowerCase()).slice(0, 40) : '');

  function start() {
    // session — из common.js (база, касса); на витрине — window.uiOwner.
    const owner = (typeof session !== 'undefined' && session.isOwner) || window.uiOwner;
    if (!owner) return msg('Менять интерфейс может только владелец', true);
    editing = true;
    document.body.classList.add('ui-editing');
    renderBar();
    msg('Режим изменения: нажмите на то, что хотите поменять');
  }
  function stop() {
    editing = false;
    moveFrom = null;
    document.body.classList.remove('ui-editing');
    document.getElementById('ui-bar')?.remove();
    closePane();
  }
  window.uiEditStart = start;
  // Витрина: если открыл владелец (просмотр витрины из программы) — кнопка «✏️ Изменить витрину».
  if (PAGE === 'shop') {
    fetch('/api/status').then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (!s || !s.auth || s.user?.role !== 'owner') return;
      window.uiOwner = true;
      const b = document.createElement('button');
      b.type = 'button';
      b.id = 'ui-shop-edit';
      b.textContent = '✏️ Изменить витрину';
      b.addEventListener('click', () => (editing ? stop() : start()));
      document.body.append(b);
    }).catch(() => {});
  }

  // Нажатие в режиме изменения — выбрать элемент, а не выполнить его действие.
  document.addEventListener('click', (e) => {
    if (!editing || e.target.closest('#ui-bar, #ui-pane, #me-menu, .toast')) return;
    const el = e.target.closest('[data-ui-key]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (moveFrom) {
      if (keyed.get(moveFrom).contains(el) || el.dataset.uiKey === moveFrom) return msg('Выберите другое место', true);
      const before = confirm(`Поставить «${label(keyed.get(moveFrom))}» ПЕРЕД «${label(el)}»?\n\nОК — перед, Отмена — после.`);
      item(moveFrom).move = { ref: el.dataset.uiKey, pos: before ? 'before' : 'after' };
      const k = moveFrom;
      moveFrom = null;
      save().then(() => { apply(); pick(keyed.get(k)); msg('Перемещено'); }).catch((err) => msg(err.message, true));
      return;
    }
    pick(el);
  }, true);
  // Ссылки и формы в режиме изменения не срабатывают.
  document.addEventListener('submit', (e) => { if (editing && !e.target.closest('#ui-pane')) { e.preventDefault(); e.stopPropagation(); } }, true);

  function pick(el) {
    document.querySelectorAll('.ui-picked').forEach((x) => x.classList.remove('ui-picked'));
    picked = el;
    el.classList.add('ui-picked');
    const o = data.items[el.dataset.uiKey] || {};
    let pane = document.getElementById('ui-pane');
    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'ui-pane';
      document.body.append(pane);
      pane.addEventListener('click', onPane);
      pane.addEventListener('change', onPaneChange);
    }
    const hasIcon = Boolean(iconOf(el)) || o.icon;
    pane.innerHTML = `<div class="ui-pane-head"><b>${esc2(label(el)) || 'Элемент'}</b><button type="button" data-ui="close" aria-label="Закрыть">×</button></div>
      <label>Текст<input data-uf="text" value="${esc2(o.text ?? getText(el))}" placeholder="Без текста"></label>
      <div class="ui-row"><label>Иконка (эмодзи)<input data-uf="emoji" maxlength="8" value="${esc2(o.icon?.emoji || '')}" placeholder="${hasIcon ? 'своя' : 'нет'} — впишите, например 🛍️"></label>
        <button type="button" data-ui="icon-img">🖼 Картинка</button><button type="button" data-ui="icon-none">Убрать</button></div>
      <div class="ui-row"><label>Цвет текста<input type="color" data-uf="color" value="${o.color || '#111111'}"></label><label>Фон<input type="color" data-uf="bg" value="${o.bg || '#ffffff'}"></label>
        <button type="button" data-ui="no-color">Без цвета</button></div>
      <div class="ui-row"><label>Размер, %<input type="range" min="60" max="220" step="10" data-uf="size" value="${o.size || 100}"></label><label class="ui-check"><input type="checkbox" data-uf="bold" ${o.bold ? 'checked' : ''}> Жирный</label></div>
      <div class="ui-row">
        <button type="button" data-ui="up">↑ Выше</button><button type="button" data-ui="down">↓ Ниже</button>
        <button type="button" data-ui="move">📍 В другое место…</button><button type="button" data-ui="parent">⬚ Выбрать блок вокруг</button>
      </div>
      <div class="ui-row">
        <button type="button" data-ui="hide">${o.hide ? '👁 Показать' : '🙈 Скрыть у всех'}</button>
        <button type="button" data-ui="reset">↺ Как было</button>
        <button type="button" data-ui="save" class="ui-done">Сохранить</button>
      </div>`;
  }
  function closePane() {
    document.getElementById('ui-pane')?.remove();
    document.querySelectorAll('.ui-picked').forEach((x) => x.classList.remove('ui-picked'));
    picked = null;
  }
  function readPane() {
    const pane = document.getElementById('ui-pane');
    const o = item(picked.dataset.uiKey);
    const v = (f) => pane.querySelector(`[data-uf="${f}"]`);
    const t = v('text').value.trim();
    if (t !== getText(picked) || o.text !== undefined) o.text = t;
    const em = v('emoji').value.trim();
    if (em) o.icon = { emoji: em };
    if (v('color').dataset.touched) o.color = v('color').value;
    if (v('bg').dataset.touched) o.bg = v('bg').value;
    const size = Number(v('size').value);
    if (size !== 100) o.size = size; else delete o.size;
    o.bold = v('bold').checked || undefined;
  }
  function onPaneChange(e) {
    if (e.target.matches('[data-uf="color"], [data-uf="bg"]')) e.target.dataset.touched = '1';
  }
  async function onPane(e) {
    const b = e.target.closest('[data-ui]');
    if (!b || !picked) return;
    const k = picked.dataset.uiKey;
    const act = b.dataset.ui;
    try {
      if (act === 'close') return closePane();
      if (act === 'parent') { const p = picked.parentElement?.closest('[data-ui-key]'); return p ? pick(p) : msg('Вокруг больше нет блока', true); }
      if (act === 'move') { moveFrom = k; renderBar(); closePane(); return msg('Теперь нажмите на элемент, рядом с которым поставить'); }
      if (act === 'icon-img') return pickImage((id) => { item(k).icon = { img: id }; picked.dataset.uiIconDone = ''; save().then(() => { location.reload(); }); });
      if (act === 'icon-none') { item(k).icon = null; await save(); location.reload(); return; }
      if (act === 'no-color') { delete item(k).color; delete item(k).bg; }
      if (act === 'hide') { item(k).hide = !item(k).hide; }
      if (act === 'up' || act === 'down') {
        const sib = act === 'up' ? picked.previousElementSibling : picked.nextElementSibling;
        const ref = sib?.closest('[data-ui-key]') === sib ? sib : null;
        if (!ref) return msg(act === 'up' ? 'Выше передвинуть некуда' : 'Ниже передвинуть некуда', true);
        item(k).move = { ref: ref.dataset.uiKey, pos: act === 'up' ? 'before' : 'after' };
      }
      if (act === 'reset') { delete data.items[k]; await save(); location.reload(); return; }
      if (act === 'save' || act === 'no-color') readPane();
      await save();
      apply();
      if (act === 'save') { closePane(); msg('Сохранено — видно у всех'); } else pick(picked);
    } catch (err) { msg(err.message, true); }
  }
  async function onBar(e) {
    const b = e.target.closest('[data-ui]');
    if (!b) return;
    try {
      if (b.dataset.ui === 'done') return stop();
      if (b.dataset.ui === 'cancel-move') { moveFrom = null; return renderBar(); }
      if (b.dataset.ui === 'favicon') return pickImage((id) => { data.favicon = id; save().then(() => { apply(); msg('Иконка вкладки сохранена — браузер может показать её не сразу, обновите страницу'); }).catch((err) => msg(err.message, true)); });
      if (b.dataset.ui === 'hidden') {
        const list = Object.entries(data.items).filter(([, o]) => o.hide);
        if (!list.length) return msg('Скрытых элементов нет');
        const names = list.map(([k], i) => `${i + 1}. ${label(keyed.get(k)) || k}`).join('\n');
        const n = Number(prompt(`Скрытые элементы:\n${names}\n\nВведите номер, чтобы снова показать:`));
        if (!n || !list[n - 1]) return;
        delete list[n - 1][1].hide;
        await save(); apply(); return msg('Снова видно');
      }
      if (b.dataset.ui === 'reset-all') {
        if (!confirm('Вернуть весь интерфейс этой страницы как было? Все ваши переименования, иконки, цвета, перемещения и скрытия здесь пропадут.')) return;
        data = { items: {}, favicon: null };
        await save(); location.reload();
      }
    } catch (err) { msg(err.message, true); }
  }
  // Своя картинка (иконка): загрузка на сервер, дальше — /img/<id>.
  function pickImage(done) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 2e6) return msg('Картинка больше 2 МБ — возьмите поменьше', true);
      const r = new FileReader();
      r.onload = async () => {
        try {
          const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: f.type, data: String(r.result).split(',')[1] }) });
          const d = await res.json();
          if (!res.ok) throw new Error(d.error || 'Картинка не загрузилась');
          done(d.id);
        } catch (err) { msg(err.message, true); }
      };
      r.readAsDataURL(f);
    });
    inp.click();
  }
})();
