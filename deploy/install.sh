#!/usr/bin/env bash
# Установка программы «Мой магазин» на чистый сервер Ubuntu 22.04 / 24.04.
#
#   curl -fsSL https://raw.githubusercontent.com/gabdubaliev/ganja/ccr-b9592b17-z50ef8/deploy/install.sh -o install.sh
#   sudo bash install.sh
#
# Что делает: ставит Node.js 22 и веб-сервер Caddy (он сам получает HTTPS-сертификат),
# скачивает программу в /opt/shop, хранит базу в /var/lib/shop, запускает программу
# как службу (поднимается сама после перезагрузки) и каждую ночь делает копию базы.
# Повторный запуск безопасен: база и настройки сохраняются.
#
# Если рядом со скриптом лежит shop.db (база с планшета или компьютера) и базы филиалов branch-N.db,
# а на сервере базы ещё нет, они будут перенесены.

set -euo pipefail

REPO=https://github.com/gabdubaliev/ganja.git
# Рабочая ветка: сюда попадают все доработки (её же обновляет планшет).
BRANCH=${BRANCH:-ccr-b9592b17-z50ef8}
APP_DIR=/opt/shop
DATA_DIR=/var/lib/shop
BACKUP_DIR=/var/backups/shop
ENV_FILE=/etc/shop.env
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "запустите скрипт от root: sudo bash install.sh"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail "скрипт рассчитан на Ubuntu, а здесь ${PRETTY_NAME:-неизвестная система}"

# ---------- Вопросы ----------
existing_domain=""
existing_admin=""
[[ -f $ENV_FILE ]] && existing_domain=$(grep -oP '^DOMAIN=\K.*' "$ENV_FILE" || true)
[[ -f $ENV_FILE ]] && existing_admin=$(grep -oP '^ADMIN_DOMAIN=\K.*' "$ENV_FILE" || true)

echo
echo "Домен, по которому будет открываться программа, например mylavka.kg."
echo "Домен уже должен указывать на IP этого сервера (запись A в DNS)."
echo "Если домена пока нет, просто нажмите Enter — программа откроется по IP, без HTTPS."
read -rp "Домен [${existing_domain:-нет}]: " DOMAIN
DOMAIN=${DOMAIN:-$existing_domain}
DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
if [[ -n $DOMAIN && ! $DOMAIN =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then fail "домен «$DOMAIN» указан неверно"; fi

# Домен — витрина для покупателей. Программа для владельца и сотрудников — на отдельном адресе (поддомене).
ADMIN_DOMAIN=""
if [[ -n $DOMAIN ]]; then
  echo
  echo "По адресу $DOMAIN покупатели увидят интернет-витрину."
  echo "Программа для вас и сотрудников (учёт, касса) будет на отдельном адресе."
  read -rp "Адрес программы [${existing_admin:-baza.$DOMAIN}]: " ADMIN_DOMAIN
  ADMIN_DOMAIN=${ADMIN_DOMAIN:-${existing_admin:-baza.$DOMAIN}}
  ADMIN_DOMAIN=${ADMIN_DOMAIN#http://}; ADMIN_DOMAIN=${ADMIN_DOMAIN#https://}; ADMIN_DOMAIN=${ADMIN_DOMAIN%%/*}
  [[ $ADMIN_DOMAIN =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "адрес «$ADMIN_DOMAIN» указан неверно"
  [[ $ADMIN_DOMAIN != "$DOMAIN" && $ADMIN_DOMAIN != "www.$DOMAIN" ]] || fail "адрес программы должен отличаться от адреса витрины"
fi

if [[ -f $ENV_FILE ]] && grep -q '^ADMIN_EMAIL=' "$ENV_FILE"; then
  echo
  echo "Администратор уже задан в $ENV_FILE — оставляю как есть."
else
  echo
  read -rp "Email администратора: " ADMIN_EMAIL
  [[ $ADMIN_EMAIL == *@*.* ]] || fail "email указан неверно"
  read -rsp "Пароль администратора (не короче 8 символов, на экране не виден): " ADMIN_PASSWORD; echo
  [[ ${#ADMIN_PASSWORD} -ge 8 ]] || fail "пароль короче 8 символов"
  [[ $ADMIN_PASSWORD != *$'\n'* ]] || fail "пароль не должен содержать перевод строки"
fi

# ---------- Пакеты ----------
say "Обновляю список пакетов и ставлю нужные программы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Ставлю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
echo "Node.js $(node -v)"

if ! command -v caddy >/dev/null; then
  say "Ставлю веб-сервер Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

# ---------- Программа ----------
say "Скачиваю программу"
id shop >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin shop
if [[ -d $APP_DIR/.git ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  # Повторная установка на работающий сервер — это тоже обновление: сначала копия всех баз с проверкой.
  if [[ -f $DATA_DIR/shop.db ]]; then
    say "Делаю копию баз перед обновлением"
    tool=$(mktemp --suffix=.js)
    git -C "$APP_DIR" show "origin/$BRANCH:deploy/db-backup.js" > "$tool" || fail "нет инструмента резервного копирования"
    chmod 644 "$tool"
    systemctl stop shop 2>/dev/null || true
    if ! runuser -u shop -- node --disable-warning=ExperimentalWarning "$tool" backup "$DATA_DIR" "$BACKUP_DIR/before-update" install; then
      rm -f "$tool"
      systemctl start shop 2>/dev/null || true
      fail "резервная копия не создана или не прошла проверку. Программа не обновлена и снова запущена."
    fi
    rm -f "$tool"
  fi
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
install -d -o shop -g shop -m 750 "$DATA_DIR"
install -d -o shop -g shop -m 750 "$BACKUP_DIR"

# База, принесённая рядом со скриптом. Файлы -wal и -shm — её часть, переносим вместе.
# Базы филиалов (branch-N.db) — вместе с основной: покупатели, бонусы и сертификаты у них общие.
# studio.db — MONT AI Studio (съёмки, исходники, задания), если ею пользовались.
if [[ -f $SRC_DIR/shop.db && ! -f $DATA_DIR/shop.db ]]; then
  say "Переношу базу $SRC_DIR/shop.db"
  for f in "$SRC_DIR"/shop.db "$SRC_DIR"/shop.db-wal "$SRC_DIR"/shop.db-shm "$SRC_DIR"/branch-*.db "$SRC_DIR"/branch-*.db-wal "$SRC_DIR"/branch-*.db-shm "$SRC_DIR"/studio.db "$SRC_DIR"/studio.db-wal "$SRC_DIR"/studio.db-shm; do
    [[ -f $f ]] && install -o shop -g shop -m 640 "$f" "$DATA_DIR/$(basename "$f")"
  done
fi

# ---------- Настройки ----------
if [[ ! -f $ENV_FILE ]]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# Настройки программы. После изменения: systemctl restart shop
HOST=127.0.0.1
PORT=3000
DB_FILE=$DATA_DIR/shop.db
REQUIRE_PASSWORD=1
NODE_ENV=production
EOF
  umask 022
fi
sed -i '/^DOMAIN=/d;/^SHOP_DOMAIN=/d;/^ADMIN_DOMAIN=/d' "$ENV_FILE"
printf 'DOMAIN=%s\nSHOP_DOMAIN=%s\nADMIN_DOMAIN=%s\n' "$DOMAIN" "$DOMAIN" "$ADMIN_DOMAIN" >> "$ENV_FILE"
if [[ -n ${ADMIN_EMAIL:-} ]]; then
  printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" >> "$ENV_FILE"
fi
chown root:shop "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------- Служба ----------
say "Запускаю программу как службу"
cat > /etc/systemd/system/shop.service <<EOF
[Unit]
Description=Мой магазин
After=network-online.target
Wants=network-online.target

[Service]
User=shop
Group=shop
WorkingDirectory=$APP_DIR/app
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Ночная копия базы: VACUUM INTO даёт целостную копию даже во время работы. Хранятся 30 последних.
cat > /usr/local/bin/shop-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Основной магазин, все филиалы (branch-N.db) и MONT AI Studio (studio.db): у каждого своя копия на дату.
for db in $DATA_DIR/shop.db $DATA_DIR/branch-*.db $DATA_DIR/studio.db; do
  [[ -f \$db ]] || continue
  name=\$(basename "\$db" .db)
  file=$BACKUP_DIR/\$name-\$(date +%F).db
  rm -f "\$file"
  /usr/bin/node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('\$db', { readOnly: true }).exec(\"VACUUM INTO '\$file'\")"
done
ls -1t $BACKUP_DIR/shop-*.db | tail -n +31 | xargs -r rm -f
ls -1t $BACKUP_DIR/studio-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f
for b in \$(ls $BACKUP_DIR/branch-*.db 2>/dev/null | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}\.db$//' | sort -u); do
  ls -1t \$b-*.db | tail -n +31 | xargs -r rm -f
done
EOF
chmod 755 /usr/local/bin/shop-backup
cat > /etc/systemd/system/shop-backup.service <<EOF
[Unit]
Description=Копия базы «Мой магазин»

[Service]
Type=oneshot
# От имени программы: так файлы базы остаются её собственными.
User=shop
ExecStart=/usr/local/bin/shop-backup
EOF
cat > /etc/systemd/system/shop-backup.timer <<EOF
[Unit]
Description=Каждую ночь копировать базу «Мой магазин»

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Обновление программы одной командой: shop-update (deploy/shop-update.sh).
# Сначала копия всех баз с проверкой; не удалась — обновление отменяется, прежняя версия работает дальше.
install -m 755 "$APP_DIR/deploy/shop-update.sh" /usr/local/bin/shop-update
sed -i "s|^APP_DIR=.*|APP_DIR=\${SHOP_APP_DIR:-$APP_DIR}|; s|^DATA_DIR=.*|DATA_DIR=\${SHOP_DATA_DIR:-$DATA_DIR}|; s|^BACKUP_DIR=.*|BACKUP_DIR=\${SHOP_BACKUP_DIR:-$BACKUP_DIR}|; s|^BRANCH=.*|BRANCH=\${SHOP_BRANCH:-$BRANCH}|" /usr/local/bin/shop-update

systemctl daemon-reload
systemctl enable -q shop shop-backup.timer
systemctl restart shop
systemctl start shop-backup.timer

# ---------- Caddy: HTTPS и проксирование ----------
say "Настраиваю веб-сервер"
if [[ -n $DOMAIN ]]; then
  cat > /etc/caddy/Caddyfile <<EOF
# Создано install.sh. Caddy сам получает и продлевает сертификаты HTTPS.
# Витрина для покупателей:
$DOMAIN {
	reverse_proxy 127.0.0.1:3000
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
# Программа для владельца и сотрудников:
$ADMIN_DOMAIN {
	reverse_proxy 127.0.0.1:3000
}
EOF
else
  cat > /etc/caddy/Caddyfile <<EOF
# Создано install.sh. Домена нет — программа открывается по IP, без HTTPS.
:80 {
	reverse_proxy 127.0.0.1:3000
}
EOF
fi
systemctl reload caddy || systemctl restart caddy

say "Открываю порты 22 (SSH), 80 и 443"
ufw allow OpenSSH >/dev/null
# SSH мог быть перенесён на другой порт (например, если провайдер блокирует 22) — разрешаем все порты SSH, иначе потеряем доступ.
for p in $(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'); do ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ---------- Проверка ----------
sleep 3
if ! systemctl is-active -q shop; then
  journalctl -u shop -n 30 --no-pager
  fail "программа не запустилась, подробности выше"
fi
IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

say "Готово"
if [[ -n $DOMAIN ]]; then
  echo "Витрина для покупателей:  https://$DOMAIN"
  echo "Программа:                https://$ADMIN_DOMAIN"
  echo "Касса:                    https://$ADMIN_DOMAIN/kassa.html"
  echo
  echo "В DNS домена должны быть записи A (все на $IP):"
  echo "  $DOMAIN, www.$DOMAIN, $ADMIN_DOMAIN"
  echo "Сертификаты HTTPS появятся через минуту после того, как DNS заработает."
else
  echo "Программа:  http://$IP"
  echo "Касса:      http://$IP/kassa.html"
  echo "Витрина:    http://$IP/shop"
  echo
  echo "Когда появится домен, направьте его на $IP и запустите install.sh ещё раз."
fi
echo
echo "Обновить программу:      shop-update"
echo "Посмотреть журнал:       journalctl -u shop -f"
echo "Копии базы:              $BACKUP_DIR (каждую ночь, 30 последних)"
