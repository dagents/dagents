#!/bin/bash
# dagents 一键重启（gateway + console）
# v3: 合并 gateway + console 重启，杀干净 + 等端口释放 + 后台启动 + 健康检查
set -e
cd "$(dirname "$0")"

SELF_PID=$$
SELF_PPID=$PPID
HERMES_PIDS=$(pgrep -f "hermes" 2>/dev/null || true)

# ========== Gateway ==========
echo "🔹 ===== 重启 Gateway (8080) ====="
echo "🔍 杀旧 gateway 进程链..."
kill_targets=""
for pid in $(pgrep -f "dagents" 2>/dev/null); do
  [ "$pid" = "$SELF_PID" ] && continue
  [ "$pid" = "$SELF_PPID" ] && continue
  echo "$HERMES_PIDS" | grep -qw "$pid" && continue
  cmdline=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if echo "$cmdline" | grep -qE "(gateway.*dev|tsx.*(watch|loader).*src/index\\.ts|esbuild.*service)"; then
    echo "   → 命中 PID $pid"
    kill_targets="$kill_targets $pid"
  fi
done
if [ -n "$kill_targets" ]; then
  kill $kill_targets 2>/dev/null || true
  sleep 2
  for pid in $kill_targets; do
    kill -0 "$pid" 2>/dev/null && { echo "   ⚡ 强杀 $pid"; kill -9 "$pid" 2>/dev/null || true; }
  done
  echo "✅ gateway 进程已清理"
else
  echo "   无需清理"
fi
pkill -f "esbuild.*service.*dagents" 2>/dev/null || true

echo "⏳ 等端口 8080 释放..."
for i in $(seq 1 15); do
  lsof -i :8080 -sTCP:LISTEN -t 2>/dev/null | grep -q . || { echo "✅ 端口已释放"; break; }
  PIDS=$(lsof -i :8080 -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')
  echo "  端口仍被占用 ($i/15), PID: $PIDS"
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null || true; done
  [ $i -eq 15 ] && { echo "❌ 端口 8080 仍被占用"; exit 1; }
  sleep 1
done

echo "🚀 后台启动 gateway..."
[ -f .env ] && { set -a; source .env; set +a; echo "   已加载 .env"; }
nohup pnpm --filter @dagents/gateway dev > /tmp/dagents-gateway.log 2>&1 &
GW_PID=$!
echo "   PID: $GW_PID, 日志: /tmp/dagents-gateway.log"

echo "⏳ 等待 gateway 就绪..."
for i in $(seq 1 20); do
  curl -s -m 2 http://localhost:8080/health 2>/dev/null | grep -q '"ok"' && { echo "✅ Gateway 就绪！(${i}s)"; break; }
  kill -0 "$GW_PID" 2>/dev/null || { echo "❌ Gateway 进程已退出"; tail -20 /tmp/dagents-gateway.log; exit 1; }
  [ $i -eq 20 ] && echo "⚠️ Gateway 未在 20s 内就绪"
  sleep 1
done

# ========== Console ==========
echo ""
echo "🔹 ===== 重启 Console (3000) ====="
echo "🔍 杀旧 console 进程..."
lsof -i :3000 -sTCP:LISTEN -t 2>/dev/null | while read pid; do
  echo "   → 杀 PID $pid"
  kill -9 "$pid" 2>/dev/null || true
done
pkill -f "next.*dev.*dagents" 2>/dev/null || true
sleep 2

echo "⏳ 等端口 3000 释放..."
for i in $(seq 1 10); do
  lsof -i :3000 -sTCP:LISTEN -t 2>/dev/null | grep -q . || { echo "✅ 端口已释放"; break; }
  [ $i -eq 10 ] && echo "❌ 端口 3000 仍被占用"
  sleep 1
done

# 上面的 kill -9 可能在 webpack 写 .next 时打断它，留下损坏的增量编译缓存，
# 复用会导致所有 API 路由 500（__webpack_require__ undefined module）。
# 缓存重建只需几十秒，直接清掉最稳。
echo "🧹 清理 console .next 编译缓存..."
rm -rf apps/console/.next

echo "🚀 后台启动 console..."
nohup pnpm --filter @dagents/console dev > /tmp/dagents-console.log 2>&1 &
CONSOLE_PID=$!
echo "   PID: $CONSOLE_PID, 日志: /tmp/dagents-console.log"

echo "⏳ 等待 console 就绪..."
for i in $(seq 1 30); do
  CODE=$(curl -s -m 3 http://localhost:3000/ -o /dev/null -w "%{http_code}" 2>/dev/null)
  [ "$CODE" = "200" ] && { echo "✅ Console 就绪！(${i}s)"; break; }
  kill -0 "$CONSOLE_PID" 2>/dev/null || { echo "❌ Console 进程已退出"; tail -20 /tmp/dagents-console.log; exit 1; }
  [ $i -eq 30 ] && echo "⚠️ Console 未在 30s 内就绪"
  sleep 2
done

echo ""
echo "🎉 重启完成！"
echo "   Gateway: http://localhost:8080  (PID $GW_PID)"
echo "   Console: http://localhost:3000  (PID $CONSOLE_PID)"
echo "   日志: /tmp/dagents-gateway.log, /tmp/dagents-console.log"
