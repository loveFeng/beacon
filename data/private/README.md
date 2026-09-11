# 本地私有化 Docker 数据目录
#
# docker-compose.private.yml 把 Postgres / Redis 绑到这里：
#   data/private/postgres  →  容器内 /var/lib/postgresql/data
#   data/private/redis     →  容器内 /data
#
# 首次 `compose up` 会自动创建子目录；内容已在仓库根 .gitignore（/data/private/）。
# 清空重来：先 down，再删本目录下 postgres/ redis/，然后重新 up。
