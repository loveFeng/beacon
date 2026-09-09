#!/bin/sh
# 本地容器入口：保证 SQLite 文件存在并灌参考数据，再起 Next 开发服。
set -eu

DATA_DIR="/app/data"
DB_FILE="${DATA_DIR}/beacon.db"
mkdir -p "${DATA_DIR}"

export DATABASE_URL="${DATABASE_URL:-file:/app/data/beacon.db}"

echo "[beacon-local] DATABASE_URL=${DATABASE_URL}"
npx prisma db push --skip-generate

# seed 会清空业务表后重建参考数据；只在库文件首次创建时跑一次。
SEED_MARKER="${DATA_DIR}/.seeded"
if [ ! -f "${SEED_MARKER}" ]; then
  echo "[beacon-local] 首次启动，写入敏感词 / 算法规则 / 演示租户…"
  npx tsx prisma/seed.ts
  touch "${SEED_MARKER}"
else
  echo "[beacon-local] 已初始化过，跳过 seed（删 ${SEED_MARKER} 可强制重灌）"
fi

echo "[beacon-local] 启动 Next.js（http://0.0.0.0:3000）…"
exec npx next dev -H 0.0.0.0 -p 3000
