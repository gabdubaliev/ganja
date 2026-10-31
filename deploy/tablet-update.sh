#!/usr/bin/env bash
# Обновление программы на планшете (Termux) одной командой:
#
#   bash ~/ganja/deploy/tablet-update.sh
#
# Если в вашей версии этого файла ещё нет (первый раз), возьмите его из обновления, ничего не меняя в программе:
#   cd ~/ganja && git fetch origin ccr-b9592b17-z50ef8 && git show origin/ccr-b9592b17-z50ef8:deploy/tablet-update.sh > ~/tablet-update.sh && bash ~/tablet-update.sh
#
# Порядок — копия базы ДО обновления:
#   1. остановить программу (иначе копия может оказаться неполной);
#   2. сделать копию ВСЕХ баз (shop.db и branch-*.db) в ~/ganja-backups/<дата_время>_tablet и проверить её;
#   3. только если копия готова и проверена — скачать новую версию (git, только «перемотка вперёд»);
#   4. запустить программу.
# Не удалось сделать или проверить копию — обновление НЕ выполняется, версия программы не меняется.
# Копии автоматически не удаляются. Восстановление — отдельной командой, с подтверждением (см. в конце вывода).
#
# Настройки (необязательно): PORT (по умолчанию 3001), DB_FILE (как у программы), SHOP_BACKUP_DIR, SHOP_BRANCH,
# NO_START=1 — не запускать программу после обновления.

set -euo pipefail

# Скрипт лежит в репозитории, который сейчас обновится. Работаем с копией во временной папке,
# чтобы git не поменял файл, пока bash его читает.
if [[ -z ${TABLET_UPDATE_COPY:-} ]]; then
  tmp=$(mktemp "${TMPDIR:-/tmp}/tablet-update.XXXXXX")
  cp "${BASH_SOURCE[0]}" "$tmp"
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # Папка программы: GANJA_DIR, или репозиторий, где лежит скрипт, или ~/ganja.
  if [[ -n ${GANJA_DIR:-} ]]; then repo=$GANJA_DIR
  elif [[ -d $here/../.git ]]; then repo=$(cd "$here/.." && pwd)
  else repo=$HOME/ganja; fi
  TABLET_UPDATE_COPY=$tmp TABLET_UPDATE_REPO=$repo exec bash "$tmp" "$@"
fi
trap 'rm -f "$TABLET_UPDATE_COPY"' EXIT

REPO=$TABLET_UPDATE_REPO
APP=$REPO/app
BRANCH=${SHOP_BRANCH:-ccr-b9592b17-z50ef8}
BACKUP_ROOT=${SHOP_BACKUP_DIR:-$HOME/ganja-backups}
PORT=${PORT:-3001}
# База — там же, где её ищет программа: DB_FILE или app/data/shop.db.
if [[ -n ${DB_FILE:-} ]]; then DB=$(cd "$APP" && realpath -m "$DB_FILE"); else DB=$APP/data/shop.db; fi
DATA_DIR=$(dirname "$DB")

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
cancel() { printf '\n\033[1;31mОБНОВЛЕНИЕ ОТМЕНЕНО: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -d $REPO/.git ]] || cancel "не найден репозиторий $REPO"
command -v node >/dev/null || cancel "не найден node (pkg install nodejs-lts)"
[[ $(basename "$DB") == shop.db ]] || cancel "основная база должна называться shop.db (сейчас $DB)"
[[ -f $DB ]] || cancel "не найдена база $DB. Если программа ещё ни разу не запускалась, обновите командой git pull."
branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[[ $branch == "$BRANCH" ]] || cancel "сейчас ветка «$branch», а нужна «$BRANCH». Переключитесь один раз:
  cd $REPO && git fetch origin $BRANCH && git checkout $BRANCH"
current=$(git -C "$REPO" rev-parse --short HEAD)

# 0. Скачать обновление — рабочая версия при этом не меняется. Инструмент копирования берём из скачанной версии
#    (в старой его может ещё не быть), во временный файл.
say "Скачиваю обновление (рабочая версия пока не меняется)"
git -C "$REPO" fetch -q origin "$BRANCH" || cancel "не удалось скачать обновление (нет интернета?). Ничего не менялось."
tool=$(mktemp "${TMPDIR:-/tmp}/db-backup.XXXXXX.js")
trap 'rm -f "$TABLET_UPDATE_COPY" "$tool"' EXIT
git -C "$REPO" show "origin/$BRANCH:deploy/db-backup.js" > "$tool" 2>/dev/null \
  || cp "$REPO/deploy/db-backup.js" "$tool" 2>/dev/null \
  || cancel "нет инструмента резервного копирования deploy/db-backup.js. Ничего не менялось."

# 1. Остановить программу этой папки: процесс node … server.js, запущенный из $APP.
#    (npm start запускает «node --disable-warning=ExperimentalWarning server.js» — старая команда pkill -f "node server.js" его не находила.)
say "Останавливаю программу"
stopped=0
unknown=0
for pid in $(pgrep -f 'node .*server\.js' 2>/dev/null || true); do
  # Только сам процесс node (не обёртки sh -c и не команды, где просто встречается этот текст).
  exe=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | head -n 1 || true)
  [[ $(basename "${exe:-x}") == node ]] || continue
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [[ -z $cwd ]] && unknown=$((unknown + 1))
  [[ $cwd == "$APP" ]] || continue
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$pid" 2>/dev/null && cancel "программа (процесс $pid) не остановилась. Закройте её (Ctrl+C в её окне) и повторите. Версия не менялась."
  stopped=$((stopped + 1))
done
[[ $stopped -gt 0 ]] && echo "Остановлена (процессов: $stopped)." || echo "Программа не была запущена."
[[ $unknown -gt 0 ]] && echo "Внимание: есть ещё процессы node … server.js, папку которых не удалось узнать. Если это эта программа — закройте её (Ctrl+C)."

# 2. Копия всех баз с проверкой.
say "Делаю и проверяю копию всех баз"
if ! node --disable-warning=ExperimentalWarning "$tool" backup "$DATA_DIR" "$BACKUP_ROOT" tablet; then
  cancel "резервная копия не создана или не прошла проверку (подробности выше).
Версия программы НЕ менялась ($current). Запустить прежнюю: cd $APP && PORT=$PORT npm start"
fi
backup_dir=$(ls -1d "$BACKUP_ROOT"/*_tablet* 2>/dev/null | grep -v _FAILED | tail -n 1)

# 3. Новая версия — только перемотка вперёд: локальные правки не затираются, при конфликте — отмена.
say "Переключаю на новую версию"
if ! git -C "$REPO" merge -q --ff-only "origin/$BRANCH"; then
  cancel "обновление не применилось (в папке есть свои изменения?). Версия не менялась ($current). Копия баз: $backup_dir"
fi
echo "Версия: $current → $(git -C "$REPO" rev-parse --short HEAD)  $(git -C "$REPO" log -1 --format='%s')"
echo "Копия баз до обновления: $backup_dir"
echo "Если что-то пойдёт не так, вернуть базы из этой копии (остановите программу; спросит подтверждение,"
echo "текущие базы не удаляются, а переносятся в отдельную папку):"
echo "  node $REPO/deploy/db-backup.js restore $backup_dir $DATA_DIR"

# 4. Запуск.
if [[ ${NO_START:-} == 1 ]]; then
  echo; echo "Запустить программу: cd $APP && PORT=$PORT npm start"
  exit 0
fi
say "Запускаю программу: http://localhost:$PORT"
rm -f "$TABLET_UPDATE_COPY" "$tool"
trap - EXIT
cd "$APP"
PORT=$PORT exec npm start
