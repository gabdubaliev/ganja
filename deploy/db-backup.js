#!/usr/bin/env node
'use strict';

// Резервные копии баз «Мой магазин»: основная shop.db и базы филиалов branch-N.db. Без зависимостей (Node ≥ 22.13).
//
//   node db-backup.js backup  <папка_баз> <папка_копий> [метка]   — сделать и проверить копию всех баз
//   node db-backup.js verify  <папка_копии>                        — проверить готовую копию
//   node db-backup.js restore <папка_копии> <папка_баз>            — вернуть базы из копии (спросит подтверждение)
//
// Копия: SQLite «VACUUM INTO» — целостный снимок, учитывает журнал WAL; файл базы не копируется побайтно.
// Каждая копия — своя папка с датой и временем (до секунды), существующие копии не перезаписываются и не удаляются.
// Готовая копия проверяется: PRAGMA integrity_check, те же таблицы и то же число строк, что в исходной базе,
// контрольные суммы SHA-256 в manifest.json. Признак готовности — файл COMPLETE (пишется последним).
// Код выхода 0 — только если всё сделано и проверено.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const MAIN = 'shop.db';
const BRANCH_RE = /^branch-\d+\.db$/;
const CONFIRM_WORD = 'ВОССТАНОВИТЬ';

class BackupError extends Error {}
const fail = (msg) => { throw new BackupError(msg); };

// Создать папку со всеми родительскими — по одной, без { recursive: true }
// (встроенный вариант зацикливается на некоторых файловых системах вместо ошибки).
function mkdirp(dir) {
  const parts = path.resolve(dir).split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (const part of parts) {
    cur = path.join(cur, part);
    try { fs.mkdirSync(cur); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!fs.statSync(cur).isDirectory()) throw Object.assign(new Error(`${cur} — это не папка`), { code: 'ENOTDIR' });
    }
  }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

// Базы в папке: shop.db и все branch-N.db. Филиалы из настроек основной базы тоже должны найтись —
// иначе копия была бы неполной.
function listDatabases(dataDir) {
  if (!fs.existsSync(path.join(dataDir, MAIN))) fail(`в папке ${dataDir} нет основной базы ${MAIN}`);
  const files = [MAIN, ...fs.readdirSync(dataDir).filter((f) => BRANCH_RE.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))];
  const db = open(path.join(dataDir, MAIN));
  try {
    let row;
    try { row = db.prepare("SELECT value FROM settings WHERE key = 'branches'").get(); } catch (err) { fail(`основная база ${MAIN} не читается (повреждена?): ${err.message}`); }
    const listed = row ? JSON.parse(row.value).map((b) => b.file).filter((f) => f && BRANCH_RE.test(f)) : [];
    const missing = listed.filter((f) => !files.includes(f));
    if (missing.length) fail(`в настройках есть филиалы, а их баз нет в папке: ${missing.join(', ')}`);
  } finally {
    db.close();
  }
  return files;
}

function open(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    fail(`не открывается база ${file}: ${err.message}`);
  }
}

// Таблицы и число строк в каждой — для сверки копии с исходной базой.
function tableCounts(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, db.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`).get().n]));
}

function integrity(file) {
  const db = open(file);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    return rows.length === 1 && rows[0] === 'ok' ? 'ok' : rows.slice(0, 5).join('; ');
  } finally {
    db.close();
  }
}

// Место на диске: копии нужно примерно столько же, сколько занимают базы с журналами, плюс запас.
function checkSpace(dataDir, files, root) {
  const need = files.reduce((s, f) => s + ['', '-wal'].reduce((a, x) => a + (fs.existsSync(path.join(dataDir, f + x)) ? fs.statSync(path.join(dataDir, f + x)).size : 0), 0), 0);
  let free = Infinity;
  try { const st = fs.statfsSync(root); free = st.bavail * st.bsize; } catch { /* нет statfs — проверим по факту записи */ }
  if (free < need * 1.2 + 10e6) fail(`мало места для копии: нужно около ${Math.ceil((need * 1.2 + 10e6) / 1e6)} МБ, свободно ${Math.floor(free / 1e6)} МБ`);
}

function backup(dataDir, root, label = '') {
  dataDir = path.resolve(dataDir);
  root = path.resolve(root);
  const files = listDatabases(dataDir);
  try { mkdirp(root); } catch (err) { fail(`не создаётся папка копий ${root}: ${err.message}`); }
  // Пишется ли в папку копий: пробный файл (на некоторых файловых системах mkdir отвечает странно).
  const probe = path.join(root, `.write-test-${process.pid}`);
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe); } catch (err) { fail(`в папку копий ${root} нельзя записать: ${err.message}`); }
  checkSpace(dataDir, files, root);
  // Своя папка для каждой копии: дата и время; если такая уже есть (та же секунда) — с номером. Ничего не перезаписываем.
  const base = `${stamp()}${label ? `_${label.replace(/[^\w-]/g, '')}` : ''}`;
  let dir = '';
  for (let i = 1; i <= 100 && !dir; i++) {
    const name = path.join(root, i === 1 ? base : `${base}-${i}`);
    try { fs.mkdirSync(name); dir = name; } catch (err) {
      if (err.code !== 'EEXIST') fail(`не создаётся папка копии ${name}: ${err.message}`);
    }
  }
  if (!dir || !fs.statSync(dir).isDirectory()) fail(`не удалось создать отдельную папку для копии в ${root}`);
  const manifest = { created: new Date().toISOString(), label, source: dataDir, files: [] };
  try {
    for (const name of files) {
      const src = path.join(dataDir, name);
      const dst = path.join(dir, name);
      const tmp = `${dst}.partial`;
      const db = open(src);
      let counts;
      try {
        try { counts = tableCounts(db); } catch (err) { fail(`база ${name} не читается (повреждена?): ${err.message}`); }
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        // Строки ещё раз после снимка: если программа писала в базу во время копии, сверка ниже это поймает.
        const again = tableCounts(db);
        if (JSON.stringify(again) !== JSON.stringify(counts)) fail(`база ${name} менялась во время копирования — остановите программу и повторите`);
      } finally {
        db.close();
      }
      fs.renameSync(tmp, dst);
      const check = integrity(dst);
      if (check !== 'ok') fail(`копия ${name} повреждена: ${check}`);
      const copy = open(dst);
      let copyCounts;
      try { copyCounts = tableCounts(copy); } finally { copy.close(); }
      if (JSON.stringify(copyCounts) !== JSON.stringify(counts)) fail(`копия ${name} не совпадает с базой по числу строк`);
      manifest.files.push({ name, bytes: fs.statSync(dst).size, sha256: sha256(dst), tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) });
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'COMPLETE'), `${manifest.created}\n`);
  } catch (err) {
    // Незаконченную копию не удаляем, а помечаем — чтобы её нельзя было принять за готовую.
    try { fs.renameSync(dir, `${dir}_FAILED`); } catch { /* оставим как есть */ }
    throw err;
  }
  return { dir, manifest };
}

// Проверка готовой копии: признак готовности, контрольные суммы, целостность каждой базы.
function verify(dir) {
  dir = path.resolve(dir);
  if (!fs.existsSync(path.join(dir, 'COMPLETE'))) fail(`копия ${dir} не завершена (нет файла COMPLETE)`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { fail(`в копии ${dir} нет или испорчен manifest.json`); }
  if (!manifest.files?.some((f) => f.name === MAIN)) fail(`в копии нет основной базы ${MAIN}`);
  for (const f of manifest.files) {
    const file = path.join(dir, f.name);
    if (!fs.existsSync(file)) fail(`в копии нет файла ${f.name}`);
    if (sha256(file) !== f.sha256) fail(`файл ${f.name} в копии изменён или повреждён (не сходится SHA-256)`);
    const check = integrity(file);
    if (check !== 'ok') fail(`копия ${f.name} повреждена: ${check}`);
  }
  return manifest;
}

// Запущена ли программа с этой папкой баз: восстановление поверх работающей базы испортило бы её.
function runningServers() {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (/(^|\/)node$/.test(cmd[0]) && cmd.some((a) => /(^|\/)server\.js$/.test(a))) out.push(Number(pid));
    } catch { /* процесс завершился или чужой */ }
  }
  return out;
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise((resolve) => rl.question(question, resolve)); } finally { rl.close(); }
}

// Восстановление: только из проверенной копии, только при остановленной программе и только после того,
// как оператор введёт слово ВОССТАНОВИТЬ. Текущие базы не удаляются — переносятся в папку replaced-<дата>.
async function restore(dir, dataDir) {
  dir = path.resolve(dir);
  dataDir = path.resolve(dataDir);
  const manifest = verify(dir);
  const running = runningServers();
  if (running.length) fail(`программа запущена (процесс ${running.join(', ')}). Остановите её и повторите восстановление.`);
  const current = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f === MAIN || BRANCH_RE.test(f) || /^(shop|branch-\d+)\.db-(wal|shm)$/.test(f)) : [];
  process.stderr.write(`\nВосстановление баз из копии ${dir}\n  создана: ${manifest.created}\n  базы в копии: ${manifest.files.map((f) => f.name).join(', ')}\n`);
  process.stderr.write(`  папка баз: ${dataDir}\n  сейчас там: ${current.join(', ') || '— пусто —'}\n`);
  process.stderr.write('Текущие файлы баз НЕ удаляются: они будут перенесены в отдельную папку replaced-<дата>.\n');
  const answer = (await ask(`Чтобы продолжить, введите ${CONFIRM_WORD}: `)).trim();
  if (answer !== CONFIRM_WORD) fail('восстановление отменено: подтверждение не введено');
  mkdirp(dataDir);
  let aside = '';
  if (current.length) {
    aside = path.join(dataDir, `replaced-${stamp()}`);
    fs.mkdirSync(aside);
    for (const f of current) fs.renameSync(path.join(dataDir, f), path.join(aside, f));
  }
  for (const f of manifest.files) {
    fs.copyFileSync(path.join(dir, f.name), path.join(dataDir, `${f.name}.restoring`));
    fs.renameSync(path.join(dataDir, `${f.name}.restoring`), path.join(dataDir, f.name));
    const check = integrity(path.join(dataDir, f.name));
    if (check !== 'ok') fail(`восстановленная база ${f.name} не прошла проверку: ${check}. Прежние файлы — в ${aside}`);
  }
  return { restored: manifest.files.map((f) => f.name), aside };
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'backup' && a && b) {
      const { dir, manifest } = backup(a, b, c);
      console.log(`Копия готова и проверена: ${dir}`);
      for (const f of manifest.files) console.log(`  ${f.name}: ${(f.bytes / 1e6).toFixed(2)} МБ, таблиц ${f.tables}, строк ${f.rows}, целостность ok`);
    } else if (cmd === 'verify' && a) {
      const m = verify(a);
      console.log(`Копия в порядке: ${m.files.map((f) => f.name).join(', ')} (создана ${m.created})`);
    } else if (cmd === 'restore' && a && b) {
      const r = await restore(a, b);
      console.log(`Восстановлено: ${r.restored.join(', ')}${r.aside ? `\nПрежние файлы баз перенесены в ${r.aside}` : ''}`);
    } else {
      console.error('Использование:\n  node db-backup.js backup <папка_баз> <папка_копий> [метка]\n  node db-backup.js verify <папка_копии>\n  node db-backup.js restore <папка_копии> <папка_баз>');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`ОШИБКА: ${err instanceof BackupError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { backup, verify, restore, listDatabases };
