-- 本地私有化 Postgres 首次初始化（docker-entrypoint-initdb.d，仅空库时跑一次）。
-- 镜像：pgvector/pgvector:pg16（自带 vector 扩展）。
-- WITH SCHEMA public：与 lib/vector/store.ts 的 public.vector / OPERATOR(public.<=>) 显式限定对齐
-- （Prisma 连接 search_path 被 ?schema=beacon 收成只有 beacon，pgvector 必须在 public 才能被裸 SQL 解析到）。

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE SCHEMA IF NOT EXISTS beacon;
GRANT ALL ON SCHEMA beacon TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
