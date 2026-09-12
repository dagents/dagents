#!/usr/bin/env bash
# backup.sh —— 单机个人工具的数据备份（2026-09-06 还债）。
#
# 覆盖两块数据源：
#   1. Postgres（flows / runs / chats / agents / providers …）—— pg_dump 自定义格式（-Fc，可 pg_restore 选择性恢复）
#   2. ~/.agents 文件系统（人格库 / 技能库 / 技能目录注册）—— tar.gz
#
# 用法：
#   bash scripts/backup.sh                    # 备份到 ./backups/（git 忽略）
#   BACKUP_DIR=/somewhere bash scripts/backup.sh
#   POSTGRES_URL=postgresql://… bash scripts/backup.sh
#
# 建议挂 cron 每日一跑（示例：每天 04:30）：
#   crontab -e
#   30 4 * * * cd /path/to/dagents && bash scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
mkdir -p "$BACKUP_DIR"

# 连接串优先取 env，回落仓库 .env（与 gateway 同源）
PG_URL="${POSTGRES_URL:-$(grep -E '^POSTGRES_URL=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)}"
if [[ -z "$PG_URL" ]]; then
  echo "❌ 找不到 POSTGRES_URL（env 或 .env）" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DB_OUT="$BACKUP_DIR/dagents-db-$STAMP.dump"
FS_OUT="$BACKUP_DIR/agents-home-$STAMP.tar.gz"

# ── 1. Postgres ──（容器在跑就走 docker exec 的 pg_dump，否则用本机 pg_dump）
CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i postgres | head -1 || true)"
if [[ -n "$CONTAINER" ]]; then
  DB_NAME="$(echo "$PG_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
  DB_USER="$(echo "$PG_URL" | sed -E 's|postgresql://([^:]+):.*|\1|')"
  docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$DB_OUT"
else
  pg_dump "$PG_URL" -Fc -f "$DB_OUT"
fi
echo "✅ db   → $DB_OUT ($(du -h "$DB_OUT" | cut -f1))"

# ── 2. ~/.agents 文件系统 ──
if [[ -d "$AGENTS_HOME" ]]; then
  tar -czf "$FS_OUT" -C "$HOME" "$(basename "$AGENTS_HOME")"
  echo "✅ fs   → $FS_OUT ($(du -h "$FS_OUT" | cut -f1))"
else
  echo "⚠️  $AGENTS_HOME 不存在，跳过文件系统备份"
fi

# ── 3. 保留窗口：db 30 份（~1MB/份），文件系统 10 份（可到几百 MB/份，
#      备份目录自身无限增长是另一个坑）。KEEP_DB / KEEP_FS 可调。──
KEEP_DB="${KEEP_DB:-30}"; KEEP_FS="${KEEP_FS:-10}"
ls -1t "$BACKUP_DIR"/dagents-db-*.dump 2>/dev/null | tail -n +"$((KEEP_DB + 1))" | xargs rm -f 2>/dev/null || true
ls -1t "$BACKUP_DIR"/agents-home-*.tar.gz 2>/dev/null | tail -n +"$((KEEP_FS + 1))" | xargs rm -f 2>/dev/null || true

echo "done. 恢复示例：pg_restore --clean -d \$POSTGRES_URL $DB_OUT"
