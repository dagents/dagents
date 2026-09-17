#!/usr/bin/env bash
# 适配器真机冒烟（2026-09-17，评审搁置项补齐）。
#
# 在**装有真实 CLI 且完成登录**的机器上跑（本机或自托管 runner）：
#   bash scripts/real-cli-smoke.sh [claude|codex|qwen|...]
# 缺哪个 CLI 就如实 SKIP 哪个 —— 绝不把「没测」伪装成「通过」。
# 产物：每适配器一条 PASS/FAIL/SKIP + 汇总；FAIL 非零退出。
#
# 用途：本地随时手跑 + .github/workflows/real-cli.yml nightly（需要
# 带 CLI 的 self-hosted runner，标签 real-cli）。通过后把
# packages/agent-adapters/src/tiers.ts 对应项的 regression 改成 verified。
set -uo pipefail

KINDS=("${@:-}")
if [ ${#KINDS[@]} -eq 0 ] || [ -z "${KINDS[0]}" ]; then
  KINDS=(claude codex qwen copilot opencode)
fi

PROMPT='Reply with exactly: dagents-smoke-ok'
expect_ok() { grep -q 'dagents-smoke-ok'; }

results=""
set_result() { results="$results $1:$2"; }
get_result() {
  local pat=" $1:"
  local rest="${results#*"$pat"}"
  echo "$rest" | cut -d' ' -f1
}
for kind in "${KINDS[@]}"; do
  if ! command -v "$kind" >/dev/null 2>&1; then
    echo "SKIP  $kind  (CLI 未安装 —— 如实跳过，不算通过)"
    set_result "$kind" skip
    continue
  fi
  echo "---- $kind ----"
  case "$kind" in
    claude) out=$(claude -p "$PROMPT" --output-format text 2>&1 | tail -5) ;;
    codex)  out=$(codex exec "$PROMPT" 2>&1 | tail -5) ;;
    qwen)   out=$(qwen "$PROMPT" 2>&1 | tail -5) ;;
    *)      out=$("$kind" -p "$PROMPT" 2>&1 | tail -5) ;;
  esac
  rc=$?
  echo "$out"
  if [ $rc -eq 0 ] && echo "$out" | expect_ok; then
    echo "PASS  $kind"
    set_result "$kind" pass
  else
    echo "FAIL  $kind (exit=$rc, 未见期望输出)"
    set_result "$kind" fail
  fi
done

echo "================ 汇总 ================"
fails=0
for kind in "${KINDS[@]}"; do
  status="$(get_result "$kind")"
  printf '  %-10s %s\n' "$kind" "$status"
  [ "$status" = fail ] && fails=$((fails+1))
done
exit "$fails"
