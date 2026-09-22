-- pgvector：语义记忆与话题聚类的向量检索（生产）。
-- 在 prisma db push（postgres schema）之后执行一次。
--
-- WITH SCHEMA public 是硬约束：lib/vector/store.ts 的裸 SQL 用 public.vector / OPERATOR(public.<=>)
-- 显式限定（Prisma 连接的 search_path 被 ?schema=beacon 收成只有 "beacon"，pgvector 不在 beacon 里）。
-- 不固定 schema，CREATE EXTENSION 会落到 search_path 第一个 schema（beacon），代码侧就解析不到了。

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- 给记忆表增加向量列（Prisma schema 里 embedding 仍存 JSON 字符串以保持可移植；
-- 这里额外加一个真正的 vector 列供 pgvector 检索，由 lib/vector 的 PgVector 实现读写）。
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS embedding_vec vector(1024);

-- HNSW 近邻索引（余弦）
CREATE INDEX IF NOT EXISTS memory_embedding_hnsw
  ON "MemoryEntry" USING hnsw (embedding_vec vector_cosine_ops);

-- 话题聚类也可选加向量列（跨源聚类用）
ALTER TABLE "TopicCluster" ADD COLUMN IF NOT EXISTS centroid_vec vector(1024);
