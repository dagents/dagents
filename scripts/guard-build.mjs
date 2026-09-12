#!/usr/bin/env node
/**
 * guard-build.mjs —— dev/build 互踩防护（2026-09-06 E-17/18 还债）。
 *
 * 已知问题清单里的两笔「每天都在交的税」：
 *   1. dev server 运行时跑 `pnpm build`（或经 turbo 的 test/typecheck）会
 *      覆盖 apps/console/.next → dev 全站 500（ENONENT build-manifest）；
 *   2. turbo 重建各 package 的 dist 触发 gateway tsx watch 自动重启 →
 *      进行中的 run 连同 CLI 子进程被终止。
 *
 * 防护：build/test/typecheck 前探测 3000/8080 端口，dev 在跑就大声警告 +
 * 给出出路（不阻断 —— CI 没有端口占用，零打扰）。出路：
 *   - 只想要测试：`pnpm --filter <pkg> test`（不再触发任何构建）
 *   - 必须全仓构建：先停 dev，或 `DAGENTS_SKIP_GUARD=1` 自担风险
 *   - 想保住 dev 的 .next：`pnpm --filter @dagents/console build:isolated`
 */
import { createConnection } from 'node:net'

const PROBES = [
  { port: 3000, name: 'console dev' },
  { port: 8080, name: 'gateway dev' },
]

function isListening(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.setTimeout(300, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

const running = []
for (const p of PROBES) {
  if (await isListening(p.port)) running.push(p)
}

if (running.length > 0 && !process.env.DAGENTS_SKIP_GUARD) {
  const list = running.map((p) => `${p.name} (:${p.port})`).join(' + ')
  console.warn(`
⚠️  检测到 ${list} 正在运行 —— 接下来的构建/测试可能把它打挂：
     • console dev 在跑时 next build 会覆盖 .next → dev 全站 500
     • gateway dev 在跑时 packages/*/dist 重建会触发 tsx watch 重启 → 进行中的 run 被终止

   出路：
     • 只想跑测试        → pnpm --filter <pkg> test（不触发构建）
     • 必须全仓构建       → 先停 dev（bash restart-gateway.sh 可一键恢复）
     • 保住 dev 的 .next  → pnpm --filter @dagents/console build:isolated
     • 自担风险继续       → DAGENTS_SKIP_GUARD=1 <命令>

   （CI 无端口占用，本防护零打扰；3 秒后继续…）
`)
  await new Promise((r) => setTimeout(r, 3000))
}
