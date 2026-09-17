#!/usr/bin/env bash
# clean.sh —— 清理本地一次性垃圾（2026-09-17 整改）。
#
# 只删「已被 .gitignore 覆盖」的产物，源码零影响（脚本前后各跑一次
# git status --short 自证，见尾部 diff）：
#   1. 根目录游离日志 *.log（dev 脚本留在仓库根的 .dev.log / .dev-daemon.log 等）
#   2. playwright 失败现场 test-results/（根 + apps/console）
#   3. GUI 人工巡检截图 gui-test-screenshots/
#   4. macOS .DS_Store
#
# 刻意不碰（同样是 gitignored，但是活工具状态而非垃圾）：
#   .codegraph/ / .superpowers/ / .gstack/ / backups/ / node_modules / dist / .next
#
# 用法：
#   bash scripts/clean.sh        # 或 pnpm clean
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

freed=0

# 双保险：即使将来 .gitignore 变了，也绝不删 git 未忽略的路径。
safe_rm() {
  local p="$1"
  if [[ ! -e "$p" ]]; then
    return 0
  fi
  if ! git check-ignore -q "$p"; then
    echo "  跳过（未被 gitignore 覆盖）：$p"
    return 0
  fi
  local size
  size=$(du -sk "$p" 2>/dev/null | cut -f1 || echo 0)
  rm -rf "$p"
  freed=$((freed + size))
  echo "  已删 $p"
}

echo "清理前 git status（快照）："
git status --short | sort > /tmp/dagents-clean-before.txt
cat /tmp/dagents-clean-before.txt

echo ""
echo "== 1/4 根目录游离日志（*.log，仅仓库根一层）=="
shopt -s nullglob dotglob
for f in "$ROOT"/*.log; do
  safe_rm "$f"
done
shopt -u nullglob dotglob

echo ""
echo "== 2/4 playwright 失败现场 test-results/ =="
safe_rm "$ROOT/test-results"
safe_rm "$ROOT/apps/console/test-results"

echo ""
echo "== 3/4 GUI 巡检截图 gui-test-screenshots/ =="
safe_rm "$ROOT/gui-test-screenshots"

echo ""
echo "== 4/4 .DS_Store（全仓，排除 node_modules）=="
find "$ROOT" -name '.DS_Store' -not -path '*/node_modules/*' -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    # find 在管道子 shell 里，safe_rm 不共享 freed 计数，单独走同样守卫
    if git check-ignore -q "$f"; then
      rm -f "$f"
      echo "  已删 $f"
    else
      echo "  跳过（未被 gitignore 覆盖）：$f"
    fi
  done

echo ""
echo "清理后 git status（对比）："
git status --short | sort > /tmp/dagents-clean-after.txt
cat /tmp/dagents-clean-after.txt

echo ""
if diff -q /tmp/dagents-clean-before.txt /tmp/dagents-clean-after.txt > /dev/null; then
  echo "✅ git status 前后零差异 —— 未触碰任何被 git 跟踪/未忽略的文件"
else
  echo "⚠️ git status 有差异（不应发生）："
  diff /tmp/dagents-clean-before.txt /tmp/dagents-clean-after.txt || true
fi
echo "约释放 $((freed / 1024)) MiB（不含 .DS_Store）"
