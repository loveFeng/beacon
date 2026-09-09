-- 本地私有化 Postgres 首次初始化（docker-entrypoint-initdb.d，仅空库时跑一次）。
-- 镜像：pgvector/pgvector:pg16（自带 vector 扩展）。

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS beacon;
GRANT ALL ON SCHEMA beacon TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
