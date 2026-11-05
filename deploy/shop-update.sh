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
# Копии перед обновлением лежат в $BACKUP_DIR/before-update/<дата_время>_update; хранятся последние $SHOP_KEEP_UPDATES (30),
# более старые удаляются после успешного обновления. Ночные копии (30 дней) не трогаются.

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
KEEP=${SHOP_KEEP_UPDATES:-30}

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

# Старые копии перед обновлениями: оставляем последние $KEEP (не меньше 3), остальные удаляем.
# Имена начинаются с даты и времени, поэтому сортировка по имени — по времени.
if (( KEEP < 3 )); then KEEP=3; fi
mapfile -t old < <(ls -1d "$BACKUP_DIR"/before-update/[0-9]*_update* 2>/dev/null | sort | head -n -"$KEEP")
if (( ${#old[@]} )); then
  freed=$(du -sch "${old[@]}" 2>/dev/null | tail -n 1 | cut -f1)
  for d in "${old[@]}"; do rm -rf -- "$d"; done
  echo "Удалено старых копий перед обновлениями: ${#old[@]} (освобождено $freed), оставлено последних $KEEP."
fi

# Ночные копии: хранить 90 дней (раньше 30) — правим уже установленный /usr/local/bin/shop-backup.
if [[ -z ${SHOP_SYSTEMCTL:-} && -f /usr/local/bin/shop-backup ]] && grep -q 'tail -n +31' /usr/local/bin/shop-backup; then
  sed -i 's/tail -n +31/tail -n +91/g' /usr/local/bin/shop-backup && echo "Ночные копии теперь хранятся 90 дней."
fi

# Автоматические обновления безопасности системы (Ubuntu/Debian): ставятся сами каждый день, только исправления
# безопасности, без перезагрузки. Включается один раз; если apt занят — попробуем при следующем обновлении.
if [[ -z ${SHOP_SYSTEMCTL:-} ]] && command -v apt-get >/dev/null && [[ ! -f /var/lib/shop-auto-upgrades ]]; then
  echo "Включаю автоматические обновления безопасности системы…"
  if apt-get update -q >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -yq unattended-upgrades >/dev/null 2>&1; then
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n' > /etc/apt/apt.conf.d/20auto-upgrades
    printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52shop-no-reboot
    : > /var/lib/shop-auto-upgrades
    systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
    echo "Автоматические обновления безопасности включены (без перезагрузки сервера)."
  else
    echo "Не удалось включить автообновления системы сейчас (apt занят?) — попробую при следующем shop-update."
  fi
fi

# Сам скрипт обновления тоже обновляется: новая версия из программы ставится в /usr/local/bin/shop-update
# с теми же папками, что сейчас (как делает install.sh).
self=$(readlink -f "$0" 2>/dev/null || echo "$0")
if [[ -z ${SHOP_SYSTEMCTL:-} && -f $APP_DIR/deploy/shop-update.sh && $self == /usr/local/bin/shop-update ]]; then
  new=$(mktemp)
  sed "s|^APP_DIR=.*|APP_DIR=\${SHOP_APP_DIR:-$APP_DIR}|; s|^DATA_DIR=.*|DATA_DIR=\${SHOP_DATA_DIR:-$DATA_DIR}|; s|^BACKUP_DIR=.*|BACKUP_DIR=\${SHOP_BACKUP_DIR:-$BACKUP_DIR}|; s|^BRANCH=.*|BRANCH=\${SHOP_BRANCH:-$BRANCH}|" "$APP_DIR/deploy/shop-update.sh" > "$new"
  if ! cmp -s "$new" /usr/local/bin/shop-update; then install -m 755 "$new" /usr/local/bin/shop-update && echo "Скрипт обновления shop-update обновлён."; fi
  rm -f "$new"
fi
