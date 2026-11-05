'use strict';

// Копия базы вне сервера: каждую ночь снимок всех баз сжимается, шифруется паролем владельца
// и отправляется документом в личный чат владельца с ботом Telegram. Пропадёт сервер — копия останется в Telegram.
//
// Файл копии (.montbk): "MONTBK1\n" | соль 16 | iv 12 | данные (AES-256-GCM) | метка 16.
// Ключ — scrypt(пароль, соль). Без пароля файл не открыть: ни Telegram, ни кто-то с доступом к чату его не прочитает.
// Внутри (после расшифровки и распаковки gzip): строка JSON с описанием файлов, перевод строки, файлы подряд.
// Большая копия режется на части до 45 МБ (Telegram принимает документы до 50 МБ).
//
// Расшифровать: node offsite.js decrypt <папка-для-баз> <файл.montbk> [часть2 …]
// (пароль спросит; можно передать в переменной SHOP_BACKUP_PASSWORD).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const MAGIC = Buffer.from('MONTBK1\n');
const PART = 45 * 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const keyOf = (password, salt) => crypto.scryptSync(String(password), salt, 32, SCRYPT);

// files: [{ name, file }] → зашифрованный файл out. Возвращает размер.
async function pack(files, out, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(password, salt), iv);
  const list = files.map((f) => ({ name: f.name, size: fs.statSync(f.file).size }));
  async function* body() {
    yield Buffer.from(JSON.stringify({ v: 1, at: Date.now(), files: list }) + '\n');
    for (const f of files) for await (const chunk of fs.createReadStream(f.file)) yield chunk;
  }
  const ws = fs.createWriteStream(out, { mode: 0o600 });
  ws.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(Readable.from(body()), zlib.createGzip({ level: 6 }), cipher, ws, { end: false });
  await new Promise((ok, fail) => ws.end(cipher.getAuthTag(), (err) => (err ? fail(err) : ok())));
  return fs.statSync(out).size;
}

// Части файла для отправки: [{ start, end }] (end не включительно).
function parts(size) {
  const out = [];
  for (let start = 0; start < size; start += PART) out.push({ start, end: Math.min(size, start + PART) });
  return out;
}

// Расшифровать склеенные части в папку dir. Возвращает список баз.
async function unpack(inputs, dir, password) {
  const buf = Buffer.concat(inputs.map((f) => fs.readFileSync(f)));
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Это не файл копии MONT (.montbk) или части сложены не по порядку');
  const salt = buf.subarray(8, 24), iv = buf.subarray(24, 36);
  const tag = buf.subarray(buf.length - 16), data = buf.subarray(36, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(password, salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try { plain = zlib.gunzipSync(Buffer.concat([decipher.update(data), decipher.final()])); } catch { throw new Error('Неверный пароль или файл повреждён / не все части'); }
  const nl = plain.indexOf(10);
  const head = JSON.parse(plain.subarray(0, nl).toString('utf8'));
  fs.mkdirSync(dir, { recursive: true });
  let pos = nl + 1;
  for (const f of head.files) {
    const name = path.basename(f.name);
    fs.writeFileSync(path.join(dir, name), plain.subarray(pos, pos + f.size), { mode: 0o600 });
    pos += f.size;
  }
  return { at: head.at, files: head.files };
}

// Отправить документ в Telegram (до 50 МБ).
async function sendDocument(token, chatId, file, { start = 0, end, name, caption }) {
  const fd = fs.openSync(file, 'r');
  let bytes;
  try {
    const len = (end ?? fs.statSync(file).size) - start;
    bytes = Buffer.alloc(len);
    fs.readSync(fd, bytes, 0, len, start);
  } finally { fs.closeSync(fd); }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([bytes], { type: 'application/octet-stream' }), name);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60_000) });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram ответил: ${body.description || res.status}`);
}

module.exports = { pack, unpack, parts, sendDocument, PART };

// Командная строка: расшифровка копии.
if (require.main === module) {
  const [cmd, dir, ...files] = process.argv.slice(2);
  if (cmd !== 'decrypt' || !dir || !files.length) {
    console.log('Расшифровать копию: node offsite.js decrypt <папка-для-баз> <файл.montbk> [часть2 …]');
    process.exit(1);
  }
  const run = async (password) => {
    const r = await unpack(files, dir, password);
    console.log(`Готово. Копия от ${new Date(r.at).toLocaleString('ru-RU')}:`);
    for (const f of r.files) console.log(`  ${path.join(dir, path.basename(f.name))} — ${(f.size / 1048576).toFixed(1)} МБ`);
  };
  const fromEnv = process.env.SHOP_BACKUP_PASSWORD;
  if (fromEnv) run(fromEnv).catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
  else {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Пароль для копий: ', (pw) => { rl.close(); run(pw).catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); }); });
  }
}
