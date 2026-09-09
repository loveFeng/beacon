#!/bin/sh
# 本地私有化：Postgres 就绪后建表 + 应用 prisma/postgres/*.sql + 灌系统数据。
# 由 docker-compose.private.yml 的 db-init 服务调用；幂等，可重复跑。
set -eu

SCHEMA="${PRISMA_SCHEMA:-prisma/schema.postgres.prisma}"
SQL_DIR="prisma/postgres"

echo "[private-db-init] DATABASE_URL host=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@##; s#\?.*$##')"

# 生产镜像里 schema.prisma 已是 postgres 版；仍显式指定 postgres 文件更稳。
if [ ! -f "$SCHEMA" ]; then
  SCHEMA="prisma/schema.prisma"
fi

echo "[private-db-init] 1/3 prisma db push…"
npx prisma db push --schema "$SCHEMA" --skip-generate

echo "[private-db-init] 2/3 应用 $SQL_DIR/*.sql…"
applied=0
for f in "$SQL_DIR"/*.sql; do
  [ -e "$f" ] || { echo "没有 SQL 文件：$SQL_DIR"; exit 1; }
  name=$(basename "$f")
  echo "   → $name"
  # 自建库没有 Supabase 的 extensions schema；search_path 里带上无妨，PG 会忽略不存在的项。
  (printf 'SET search_path TO beacon, public;\n'; cat "$f") \
    | npx prisma db execute --schema "$SCHEMA" --stdin
  applied=$((applied + 1))
done
echo "   共 $applied 份"

echo "[private-db-init] 3/3 sync-system-data --apply…"
if [ -f scripts/sync-system-data.ts ]; then
  node_modules/.bin/tsx scripts/sync-system-data.ts --apply
else
  echo "⚠️ 未挂载 scripts/sync-system-data.ts，跳过系统数据同步"
fi

echo "[private-db-init] ✅ 完成"
