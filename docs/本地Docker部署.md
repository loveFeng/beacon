# 本地 Docker 部署

本机用 Docker 跑烽火台时，有两条路线。**不要混用同一套 compose 文件**，也尽量不要同时占用 `3000` 端口。

| 路线 | Compose 文件 | 数据库 | 适用场景 |
|---|---|---|---|
| **A. 开发态 SQLite** | `docker-compose.local.yml` | SQLite | 快速体验、Mock 登录、零外部依赖 |
| **B. 私有化 Postgres** | `docker-compose.private.yml` | 自建 Postgres + pgvector | 接近私有化交付：Redis + Worker、装机向导密码登录 |
| 生产 SaaS | `docker-compose.yml` | 外部托管 Postgres | 域名 + HTTPS + Nginx；见 README「生产部署」 |

本文只写 **A / B**。生产栈仍以 README 与 `.env.production.example` 为准。

---

## 共同前提

- Docker 与 Compose v2
- 本机已克隆本仓库，在仓库根目录执行命令
- 默认 Web 绑定 `127.0.0.1:3000`（可用环境变量 `BEACON_WEB_BIND` / `BEACON_WEB_PORT` 改）

切换路线前先停掉另一套：

```bash
docker compose -f docker-compose.local.yml down
docker compose --env-file .env.private -f docker-compose.private.yml down
```

---

## A. 开发态 SQLite（开箱即用）

### 特点

- 单容器 Web；**无 Redis / Postgres / Nginx**
- `BEACON_ENV=dev`：短信 Mock（验证码显示在登录页）、热榜/LLM 默认可走 Mock
- 数据在 Docker volume `beacon-sqlite`

### 启动

```bash
# 可选：本地还有一份 .env 给非 Docker 开发用
cp .env.example .env

docker compose -f docker-compose.local.yml up -d --build
```

打开 [http://localhost:3000](http://localhost:3000)。任意手机号登录，验证码在登录页回显。

### 相关文件

| 文件 | 作用 |
|---|---|
| `docker-compose.local.yml` | 编排 |
| `Dockerfile.local` | SQLite schema + `next dev` |
| `scripts/docker-local-entrypoint.sh` | 首次 `db push` + seed，再起服务 |
| `.env.docker.local.example` | 可选：真实 LLM / 热榜开关说明 |

### 常用命令

```bash
docker compose -f docker-compose.local.yml logs -f
docker compose -f docker-compose.local.yml down
```

强制重灌参考数据（会清业务数据对应的那次 seed 标记）：

```bash
docker compose -f docker-compose.local.yml exec web rm -f /app/data/.seeded
docker compose -f docker-compose.local.yml restart web
```

或删 volume 后重建：

```bash
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d --build
```

---

## B. 私有化 + 自建 Postgres（本机直连 HTTP）

面向「私有化形态、库自己跑、不要反代 / 不要 HTTPS / 不要 xray」的本机部署。

### 特点

| 项 | 取值 |
|---|---|
| 形态 | `BEACON_EDITION=private`（无短信、无支付；装机向导 + 密码登录） |
| 入口 | 直连 `http://localhost:3000`（**无** `proxy` / Nginx） |
| TLS | **无 HTTPS**；`BEACON_SITE_URL` / `BEACON_PUBLIC_URL` 必须是 `http://…` |
| 出海代理 | **无 xray**（不设 `BEACON_HTTP_PROXY`；YouTube 热榜可能不可用） |
| 编排内服务 | Postgres(pgvector)、Redis、web、worker、rsshub、dailyhot、一次性 `db-init` |

登录 Cookie 是否带 `Secure` 由站点 URL 协议决定（见 `lib/auth-constants.ts` 的 `authCookieSecure`）。写成 `https://` 却用明文端口访问时，部分浏览器会丢掉 Cookie，表现为「登进去刷新又回登录页」。

### 1. 准备环境文件

```bash
cp .env.private.example .env.private
chmod 600 .env.private
```

至少改这几项（模板里有注释）：

```bash
# 各生成一次填进去
openssl rand -hex 32      # → POSTGRES_PASSWORD、REDIS_PASSWORD、BEACON_SETUP_TOKEN（各用一次）
openssl rand -base64 48   # → BEACON_MASTER_KEY
```

并确认：

```env
BEACON_EDITION=private
BEACON_SETUP_TOKEN=<上面生成的 32 位 hex>
BEACON_PUBLIC_URL=http://localhost:3000
BEACON_SITE_URL=http://localhost:3000
BEACON_TRUSTED_PROXY_HOPS=0
```

`BEACON_SETUP_TOKEN` **必填**（≥8 字符）。装机向导第一步要填它——没有口令时向导会拒绝继续，避免局域网里谁先打开 `/setup` 谁变成管理员。装机完成后口令可留在 `.env.private`（实例已初始化后向导不再开放）。

`DATABASE_URL` / `REDIS_URL` 里的密码须与上面 Postgres / Redis 密码一致。Compose 启动时还会用 `POSTGRES_*` / `REDIS_PASSWORD` **覆盖**容器内的 `DATABASE_URL` / `REDIS_URL`，以服务名 `postgres` / `redis` 互访。

可选：在 `.env.private` 填 `BEACON_DEFAULT_LLM_*` 作为默认模型；不填则装机后在设置页配 BYOK。

**不要**配置短信（`BEACON_SMS_*`）或微信支付（`BEACON_WXPAY_*`）——私有化形态没有这些能力面。

### 2. 启动

必须带 `--env-file`，否则 compose 插值读不到 `REDIS_PASSWORD` / `POSTGRES_PASSWORD`：

```bash
docker compose --env-file .env.private -f docker-compose.private.yml up -d --build
```

首次会：

1. 起 Postgres（`pgvector/pgvector:pg16`）+ Redis + rsshub + dailyhot  
2. `db-init`：`prisma db push` → 跑 `prisma/postgres/*.sql` → `sync-system-data --apply`  
3. 起 web / worker  

打开 [http://localhost:3000](http://localhost:3000) → **装机向导**：

1. 填入 `.env.private` 里的 `BEACON_SETUP_TOKEN`（可用 `grep BEACON_SETUP_TOKEN .env.private` 查看）
2. 设团队名、管理员称呼与登录密码
3. 可选：大模型 Key、企业应用（OA）

之后用管理员密码登录。

### 3. 验证

```bash
docker compose --env-file .env.private -f docker-compose.private.yml ps
curl -s http://127.0.0.1:3000/api/health
```

期望 web / postgres / redis / worker 为 Up；`db-init` 为 `Exited (0)`。

### 相关文件

| 文件 | 作用 |
|---|---|
| `docker-compose.private.yml` | 编排（无 proxy / xray / certbot） |
| `.env.private.example` | 环境模板（复制为 `.env.private`，已 gitignore） |
| `deploy/private-local/init-postgres.sql` | 空库首次：`vector` 扩展 + `beacon` schema |
| `scripts/docker-private-db-init.sh` | 建表 + SQL 增量 + 系统数据 |
| `Dockerfile` | 与生产相同的 Postgres Prisma 镜像（`beacon-web:latest`） |

### 常用命令

```bash
# 日志
docker compose --env-file .env.private -f docker-compose.private.yml logs -f web worker

# 停服务（保留数据 volume）
docker compose --env-file .env.private -f docker-compose.private.yml down

# 停并清空库 / Redis（不可恢复）
docker compose --env-file .env.private -f docker-compose.private.yml down -v
```

本机用 GUI / `psql` 连库（密码见 `.env.private`）：

```text
postgresql://beacon:<POSTGRES_PASSWORD>@127.0.0.1:5432/beacon?schema=beacon
```

手动再跑一遍库初始化（幂等；一般不必）：

```bash
docker compose --env-file .env.private -f docker-compose.private.yml run --rm db-init
```

### 已知取舍

- **无反代**：`BEACON_TRUSTED_PROXY_HOPS=0` 时，生产口径下 IP 限流会退化成全站共用一个桶（本机可接受）。
- **无 xray**：不走 `BEACON_HTTP_PROXY`；依赖翻墙的 YouTube 等源可能失败，其它热榜（DailyHot / 60s）不受影响。
- **镜像构建**：首次 `docker compose … build` 较慢；拉基础镜像若遇 `unexpected EOF`，可先 `docker pull pgvector/pgvector:pg16` 等再重试。

---

## 与生产 SaaS 栈的对照

| | A SQLite | B 私有化本地 | `docker-compose.yml` 生产 |
|---|---|---|---|
| 反代 | 无 | 无 | Nginx 80/443 |
| HTTPS | 无 | 无 | 需要证书 |
| 数据库 | SQLite volume | 编排内 Postgres | 外部托管（如火山 Supabase） |
| 队列 | 进程内 | Redis + Worker | Redis + Worker |
| 登录 | Mock 短信 | 装机密码 / OA | 真实短信等 |
| xray | 无 | 无 | 有（可选 YouTube） |

生产启动摘要（细节以 README「生产部署」为准）：

```bash
cp .env.production.example .env.production   # 填 DATABASE_URL、短信、主密钥等
export REDIS_PASSWORD="$(openssl rand -hex 32)"
deploy/cert.sh self-signed your.domain       # 或 issue 正式证书
DATABASE_URL="…" bash scripts/db-init-supabase.sh
docker compose up -d --build
```

---

## 排障速查

| 现象 | 处理 |
|---|---|
| `必须设置 REDIS_PASSWORD` | 用 `--env-file .env.private` 启动 B，或 `export REDIS_PASSWORD=…` |
| 3000 端口占用 | 先 `down` 另一套 compose；或改 `BEACON_WEB_PORT` |
| 私有化登进去又掉线 | 确认 `BEACON_SITE_URL` 是 `http://` 不是 `https://` |
| 提示未配置装机口令 | 在 `.env.private` 加 `BEACON_SETUP_TOKEN`（`openssl rand -hex 32`），再 `up -d --force-recreate web worker` |
| `db-init` 非 0 退出 | `logs db-init`；常见是 Postgres 未就绪或密码与 `DATABASE_URL` 不一致 |
| 健康检查只有 `status:ok` | 生产健康详情可能需 `BEACON_HEALTH_TOKEN`；本机有 web 响应即可 |
| 想清空私有化库重来 | `down -v` 后再 `up -d --build`（会重新跑 init SQL + db-init） |
