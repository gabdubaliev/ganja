# Сборка программы «Мой магазин» для сервера (Railway и любой хостинг с Docker).
FROM node:22-slim

WORKDIR /srv
COPY app/ .

# База хранится на постоянном диске, подключённом к /data.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DB_FILE=/data/shop.db \
    REQUIRE_PASSWORD=1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
