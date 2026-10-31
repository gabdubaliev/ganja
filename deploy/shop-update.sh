#!/usr/bin/env bash
# Обновление программы «Мой магазин» на сервере: sudo shop-update
# install.sh копирует этот файл в /usr/local/bin/shop-update.
#
# Порядок — копия базы ДО любой смены версии:
#   1. скачать обновление (рабочая версия пока не меняется);
#   2. остановить программу — чтобы в базу никто не писал и копия была полной;
#   3. сделать копию ВСЕХ баз (shop.db и branch-*.db) и проверить её (целостность, число строк, SHA-256);
#   4. только если копия готова и проверена — переключить версию и запустить программу.
# Ошибка на шагах 1–3: обновление отменяется, прежняя версия остаётся и снова запускается.
# Копии перед обновлением лежат в $BACKUP_DIR/before-update/<дата_время>_update и автоматически не удаляются.

set -euo pipefail

APP_DIR=${SHOP_APP_DIR:-/opt/shop}
DATA_DIR=${SHOP_DATA_DIR:-/var/lib/shop}
BACKUP_DIR=${SHOP_BACKUP_DIR:-/var/backups/shop}
BRANCH=${SHOP_BRANCH:-ccr-b9592b17-z50ef8}
SERVICE=${SHOP_SERVICE:-shop}
SYSTEMCTL=${SHOP_SYSTEMCTL:-systemctl}
# Копия делается от имени пользователя программы: так файлы копий принадлежат ему, как и сама база.
RUN_AS=${SHOP_RUN_AS-runuser -u shop --}
NODE=${SHOP_NODE:-/usr/bin/node}

say() { printf '\n==> %s\n' "$*"; }
cancel() { printf '\n\033[1;31mОБНОВЛЕНИЕ ОТМЕНЕНО: %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -z ${SHOP_SYSTEMCTL:-} && $EUID -ne 0 ]]; then cancel "запустите от root: sudo shop-update"; fi
[[ -d $APP_DIR/.git ]] || cancel "не найдена программа в $APP_DIR"
[[ -f $DATA_DIR/shop.db ]] || cancel "не найдена база $DATA_DIR/shop.db"

say "Скачиваю обновление (рабочая версия пока не меняется)"
git -C "$APP_DIR" fetch -q origin "$BRANCH" || cancel "не удалось скачать обновление (нет связи с GitHub?). Программа не тронута."
current=$(git -C "$APP_DIR" rev-parse --short HEAD)
target=$(git -C "$APP_DIR" rev-parse --short "origin/$BRANCH")

# Инструмент копирования берём из скачанной версии (в старой его может не быть), во временный файл.
tool=$(mktemp --suffix=.js)
trap 'rm -f "$tool"' EXIT
git -C "$APP_DIR" show "origin/$BRANCH:deploy/db-backup.js" > "$tool" 2>/dev/null \
  || git -C "$APP_DIR" show "HEAD:deploy/db-backup.js" > "$tool" 2>/dev/null \
  || cancel "нет инструмента резервного копирования deploy/db-backup.js. Программа не тронута."
chmod 644 "$tool"

say "Останавливаю программу, чтобы копия была полной"
$SYSTEMCTL stop "$SERVICE" || cancel "не удалось остановить программу. Версия не менялась."

say "Делаю и проверяю копию всех баз"
if ! $RUN_AS "$NODE" --disable-warning=ExperimentalWarning "$tool" backup "$DATA_DIR" "$BACKUP_DIR/before-update" update; then
  $SYSTEMCTL start "$SERVICE" || true
  cancel "резервная копия не создана или не прошла проверку (подробности выше).
Версия программы НЕ менялась ($current), программа снова запущена."
fi

say "Переключаю версию $current → $target"
if ! git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"; then
  git -C "$APP_DIR" checkout -q -f "$current" 2>/dev/null || true
  $SYSTEMCTL start "$SERVICE" || true
  cancel "не удалось переключить версию. Возвращена прежняя ($current), программа запущена. Копия баз сохранена."
fi
$SYSTEMCTL start "$SERVICE" || cancel "новая версия не запустилась. Копия баз — в $BACKUP_DIR/before-update (самая новая папка)."
echo
echo "Программа обновлена: $(git -C "$APP_DIR" log -1 --format='%h %s')"
echo "Копия баз до обновления: $(ls -1d "$BACKUP_DIR"/before-update/*_update* 2>/dev/null | grep -v _FAILED | tail -n 1)"
