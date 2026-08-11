#!/bin/bash
# dagents gateway 一键重启（杀干净 + 等端口释放 + 后台启动）
# v2: 修复 pkill 误杀 Hermes 自身 + 补 esbuild 清理 + 进程组 kill
set -e
cd "$(dirname "$0")"

# 保存当前 shell 和 Hermes 相关 PID，避免误杀
SELF_PID=$$
SELF_PPID=$PPID
HERMES_PIDS=$(pgrep -f "hermes" 2>/dev/null || true)

echo "🔍 杀旧 gateway 进程链..."
echo "   当前 shell PID=$SELF_PID, PPID=$SELF_PPID"

# 找到 dagents gateway 的所有进程，排除 Hermes 自身和当前 shell 树
kill_targets=""
for pid in $(pgrep -f "dagents" 2>/dev/null); do
  # 跳过自身和父进程
  [ "$pid" = "$SELF_PID" ] && continue
  [ "$pid" = "$SELF_PPID" ] && continue
  # 跳过 Hermes 进程
  echo "$HERMES_PIDS" | grep -qw "$pid" && continue
  # 只杀 gateway 相关或 tsx 相关的 dagents 进程
  cmdline=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if echo "$cmdline" | grep -qE "(gateway.*dev|tsx.*(watch|loader).*src/index\.ts|esbuild.*service)"; then
    echo "   → 命中 PID $pid: $(echo "$cmdline" | cut -c1-80)"
    kill_targets="$kill_targets $pid"
  fi
done

if [ -n "$kill_targets" ]; then
  # 先温和 SIGTERM
  kill $kill_targets 2>/dev/null || true
  sleep 2
  # 还活着的强制 SIGKILL
  for pid in $kill_targets; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "   ⚡ 强杀 PID $pid（SIGTERM 无响应）"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo "✅ 进程已清理"
else
  echo "   无需清理的进程"
fi

# 额外清理：可能残留的 esbuild 服务进程（tsx 的子进程）
pkill -f "esbuild.*service.*dagents" 2>/dev/null || true

echo "⏳ 等端口 8080 释放..."
for i in $(seq 1 15); do
  # 只检测本地 LISTEN 状态，排除 PacketTun/WeChat 等出站连接
  if ! lsof -i :8080 -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
    echo "✅ 端口已释放"
    break
  fi
  PIDS_ON_PORT=$(lsof -i :8080 -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')
  echo "  端口仍被占用 (尝试 $i/15)，PID: $PIDS_ON_PORT"
  for pid in $PIDS_ON_PORT; do
    kill -9 "$pid" 2>/dev/null || true
  done
  [ $i -eq 15 ] && { echo "❌ 端口 8080 仍被占用"; exit 1; }
  sleep 1
done

echo "🚀 后台启动 gateway..."
nohup pnpm --filter @dagents/gateway dev > /tmp/dagents-gateway.log 2>&1 &
GATEWAY_PID=$!
echo "   PID: $GATEWAY_PID"
echo "   日志: /tmp/dagents-gateway.log"

# 等待 gateway 就绪
echo "⏳ 等待 gateway 就绪..."
for i in $(seq 1 20); do
  if curl -s -m 2 http://localhost:8080/health 2>/dev/null | grep -q '"ok"'; then
    echo "✅ Gateway 已就绪！(${i}s)"
    exit 0
  fi
  # 检查启动是否立即失败
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "❌ Gateway 进程已退出，请检查日志:"
    tail -20 /tmp/dagents-gateway.log 2>/dev/null
    exit 1
  fi
  sleep 1
done
echo "⚠️  Gateway 未在 20s 内就绪，请检查日志: tail -f /tmp/dagents-gateway.log"
exit 1
