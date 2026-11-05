'use strict';

// Сканер штрихкодов камерой телефона. Android (Chrome) читает коды сам (BarcodeDetector);
// iPhone (Safari) этого не умеет — тогда подгружается библиотека ZXing (/vendor/zxing.min.js, MIT, лежит у нас).
// openScanner({ onCode, title }) — окно на весь экран с камерой. Сканирует подряд: каждый новый код → onCode(code);
// onCode может вернуть текст («Добавлено: Футболка») — он показывается внизу. Тот же код повторно — только после того,
// как он пропал из кадра на 2 секунды (пока держите камеру на товаре, он не добавится второй раз).

const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];
let zxingLoad = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  zxingLoad ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing.min.js';
    s.onload = ok;
    s.onerror = () => { zxingLoad = null; fail(new Error('Не загрузился модуль сканера — проверьте интернет')); };
    document.head.append(s);
  });
  return zxingLoad;
}

function scanBeep() {
  try { navigator.vibrate?.(60); } catch { /* нет вибрации */ }
  try {
    const ctx = scanBeep.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1700; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.09);
  } catch { /* без звука */ }
}

async function openScanner({ onCode, title = 'Наведите камеру на штрихкод' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Камера недоступна в этом браузере. Откройте сайт в Safari или Chrome', 'error');
  const box = document.createElement('div');
  box.className = 'scan-overlay';
  box.innerHTML = `<video playsinline muted autoplay></video>
    <div class="scan-frame" aria-hidden="true"><i></i></div>
    <div class="scan-top"><b>${esc(title)}</b><button type="button" class="scan-close" aria-label="Закрыть">×</button></div>
    <div class="scan-bottom"><span class="scan-msg">Запускаю камеру…</span><button type="button" class="btn primary scan-done">Готово</button></div>`;
  document.body.append(box);
  const video = box.querySelector('video');
  const msg = (t, bad) => { const m = box.querySelector('.scan-msg'); m.textContent = t; m.classList.toggle('bad', Boolean(bad)); };
  let stream = null, reader = null, stopped = false, timer = null;
  let last = '', lastAt = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    try { reader?.reset(); } catch { /* уже остановлен */ }
    stream?.getTracks().forEach((t) => t.stop());
    box.remove();
  };
  box.querySelector('.scan-close').addEventListener('click', stop);
  box.querySelector('.scan-done').addEventListener('click', stop);
  const found = async (code) => {
    code = String(code || '').trim();
    if (!code || stopped) return;
    // Тот же код, пока он в кадре, не добавляется повторно: снова — только если убрать камеру на 2 секунды и навести опять.
    const now = Date.now();
    if (code === last && now - lastAt < 2000) { lastAt = now; return; }
    last = code; lastAt = now;
    scanBeep();
    box.classList.add('hit');
    setTimeout(() => box.classList.remove('hit'), 250);
    try {
      const r = await onCode?.(code);
      msg(r || `Код ${code}`);
    } catch (err) { msg(err.message, true); }
  };
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
  try {
    const formats = 'BarcodeDetector' in window ? await window.BarcodeDetector.getSupportedFormats().catch(() => []) : [];
    if (formats.includes('ean_13')) {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play().catch(() => {});
      const detector = new window.BarcodeDetector({ formats: SCAN_FORMATS.filter((f) => formats.includes(f)) });
      msg('Наведите на штрихкод — товар добавится сам. Ещё такой же — уберите камеру и наведите снова');
      const tick = async () => {
        if (stopped) return;
        try { const codes = await detector.detect(video); if (codes[0]) await found(codes[0].rawValue); } catch { /* кадр не готов */ }
        timer = setTimeout(tick, 120);
      };
      tick();
    } else {
      await loadZxing();
      if (stopped) return;
      // Без дополнительных подсказок: с ними (форматы + TRY_HARDER) библиотека перестаёт находить коды в видео.
      reader = new window.ZXing.BrowserMultiFormatReader();
      msg('Наведите на штрихкод — товар добавится сам. Ещё такой же — уберите камеру и наведите снова');
      await reader.decodeFromConstraints(constraints, video, (result) => { if (result) found(result.getText()); });
      stream = video.srcObject;
    }
  } catch (err) {
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    msg(denied ? 'Нет доступа к камере. Разрешите камеру для этого сайта в настройках телефона (Safari → Камера → Разрешить) и попробуйте снова.'
      : err?.name === 'NotFoundError' ? 'Камера не найдена' : `Камера не запустилась: ${err?.message || err}`, true);
  }
}
