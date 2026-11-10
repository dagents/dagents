import { serve, type ServerType } from '@hono/node-server'
import { AppDataSource, initDb, runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { startTracing } from '@dagents/shared/otel'
import { app } from './app.js'
import { wsHub } from './ws-hub.js'
import { executionRegistry } from './execution-registry.js'
import { startRetentionTimer } from './retention.js'
import { sweepDanglingExecutions } from './boot-sweep.js'
import { markOrphanedHumanInputs } from './routes/human-input.js'
import { reportErrorToSink } from './lib/error-sink.js'
import { retryUntilDeadline, DB_INIT_RETRY_MS } from './lib/db-init-retry.js'
import { startGoalLoop, stopGoalLoop } from './goal-loop-service.js'

const tracing = startTracing('gateway')
const log = createLogger({ svc: 'gateway:main' })

const port = Number(process.env.GATEWAY_PORT ?? 8080)
// 默认绑定 127.0.0.1，防止网关被局域网直接访问绕过 console 代理层。
// 如需从其他设备访问（如远程开发），显式设置 GATEWAY_HOST=0.0.0.0。
const hostname = process.env.GATEWAY_HOST ?? '127.0.0.1'

// 启动期依赖重试（稳定性专项 2026-10-04）：docker compose 竞态 / 机器重启
// 顺序里 Postgres 慢半拍，网关不该当场退出等人工 restart。预算内带退避
// 重试（默认 60s），超窗仍失败才带着最后一次错误退出。
await retryUntilDeadline(() => initDb(), {
  onRetry: ({ attempt, delayMs, error }) => {
    log.warn('db init failed — retrying until deadline', {
      attempt,
      delayMs,
      budgetMs: DB_INIT_RETRY_MS(),
      error: error instanceof Error ? error.message : String(error),
    })
  },
})

/**
 * Boot sweep（execution-cancellation spec D7 / architecture AD-6）：收敛悬空
 * 执行行——2026-10-07 可恢复性地基起 runs/spans 收敛为 stopped(interrupted)、
 * checkpoint 收敛 resumable（中断可恢复，详见 boot-sweep.ts 文件头）。从
 * index.ts 内联抽出为独立模块，gateway 单测可做 DB 断言。
 */
await sweepDanglingExecutions()
// HumanInput 挂起态是进程内 Promise（单进程红线）—— 重启即死。挂起时写进
// 会话历史的提示（"直接在本聊天中回复即可"）在重启后成为谎言：用户回复会
// 被当成新消息正常路由，流程却早已不在。boot 时把「聊天最后一条消息是
// human_input 提示」的会话补一条中断说明，让历史不说谎（2026-09-06）。
await markOrphanedHumanInputs()
// 执行轨迹保留清理（90 天默认，DAGENTS_RETENTION_DAYS 可调/关闭）
startRetentionTimer()

/**
 * Daemon offline reaper — marks daemons as `offline` when their
 * `last_heartbeat_at` is older than the staleness threshold.
 *
 * Without this, a daemon that crashes without sending a final `offline`
 * heartbeat stays `online` forever in the `daemons` table, causing the fleet
 * panel to show stale data and allowing the task router to dispatch work to a
 * dead daemon. The reaper runs every 15s and only updates rows whose status
 * is `online` or `draining` (not already `offline`), so it's idempotent.
 *
 * Staleness threshold: 3x the default heartbeat interval (5s × 3 = 15s),
 * giving a daemon enough grace to survive a transient network blip before
 * being marked offline.
 */
const REAPER_INTERVAL_MS = 15_000
const STALE_THRESHOLD_SECONDS = 15

async function reapStaleDaemons(): Promise<void> {
  try {
    const { affected } = await runQuery(
      `UPDATE daemons
         SET status = 'offline'
       WHERE status IN ('online', 'draining')
         AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval`,
      [String(STALE_THRESHOLD_SECONDS)],
    )
    if (affected && affected > 0) {
      log.info('marked stale daemons offline', { count: affected, thresholdSec: STALE_THRESHOLD_SECONDS })
    }
  } catch (err) {
    log.warn('reaper query failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

const reaperTimer = setInterval(() => { void reapStaleDaemons() }, REAPER_INTERVAL_MS)
reaperTimer.unref?.()

/**
 * Graceful shutdown（2026-09-17 补齐）：停机不再是 process.exit(0) 甩手 ——
 * ①停接新请求 ②abort 全部在跑执行（各自的 abort 路径会把终态落库，
 * CLI 子进程 SIGTERM→SIGKILL）③给执行 5s 落库预算 ④通知并关闭 WS 客户端
 * ⑤关 tracing 与连接池。超预算强退：boot sweep 下次启动兜底收敛。
 */
const SHUTDOWN_SETTLE_MS = 5_000
let shuttingDown = false

async function shutdown(signal: string, server: ServerType | undefined): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.warn('gateway shutting down', { signal, activeExecutions: executionRegistry.activeCount() })
  // 硬退出看门狗：优雅路径任何一步（连接排空/trace flush/池销毁）挂起
  // 也不能让进程赖着不死 —— tsx watch/编排器的强杀窗口不等人
  // （2026-09-17 e2e 中途网关死亡事故：SIGTERM 后停机链未在窗口内完成
  // 被 tsx force kill，整轮 e2e 断流）。
  const hardExit = setTimeout(() => process.exit(0), 3_000)
  hardExit.unref?.()
  if (reaperTimer) clearInterval(reaperTimer)
  stopGoalLoop()

  // 停止接受新连接（已有 keep-alive 连接随 server.closeIdleConnections 收敛）
  try {
    server?.close()
    ;(server as unknown as { closeIdleConnections?: () => void })?.closeIdleConnections?.()
  } catch (err) {
    log.warn('http server close failed during shutdown', { error: String(err) })
  }

  // Abort 全部在跑执行，然后给它们一个落库预算（race 超时）
  const handles = executionRegistry.abortAll('gateway shutting down')
  if (handles.length > 0) {
    await Promise.race([
      Promise.allSettled(handles.map((h) => h.done)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS)),
    ])
  }

  wsHub.shutdown()
  // trace flush 有界竞赛（≤500ms）：未配置 OTLP 时 NodeSDK.shutdown() 会
  // 永久挂起（2026-09-17 测试工程师实测定位——此前停机恒撞 3s 看门狗，
  // 优雅路径实际从未走完）；配置了收集器也只给半秒冲刷预算，收不完
  // 丢弃 —— 停机确定性优先于遥测完整性。
  await Promise.race([
    tracing.shutdown().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ])
  try {
    await AppDataSource.destroy()
  } catch (err) {
    log.warn('db pool destroy error', { error: String(err) })
  }
  process.exit(0)
}

const server = serve({ fetch: app.fetch, port, hostname })
wsHub.attachToServer(server as unknown as import('node:http').Server)
console.log(`gateway on ${hostname}:${port} (ws: /ws)`)

// 目标环 supervisor（方向 C，2026-11-10）：tick 驱动的推进/评估状态机。
// 放在 serve 之后——自 POST 触发 run 需要监听已就绪；间隔 0 可关闭。
startGoalLoop()

process.on('SIGTERM', () => void shutdown('SIGTERM', server))
process.on('SIGINT', () => void shutdown('SIGINT', server))

/**
 * 进程级异常兜底（稳定性专项 2026-10-04）：后台定时器（retention / reaper /
 * sweeper）、SSE 流、fire-and-forget 链里任何一个漏接的 rejection，在新版
 * Node 默认 throw 语义下都会直接杀死网关——连带全部在跑 run 与 CLI 子进程
 *（agent-invoke 的 collect 兜底注释就是活证据）。此处收口：
 *  - unhandledRejection：记日志 + error-sink，进程继续服务（后台任务的
 *    残余状态由各自信任域兜底：执行有 boot sweep，定时器每轮独立容错）。
 *  - uncaughtException：同步栈已不可信，走受控优雅停机链（abort 执行 →
 *    落库 → 3s 硬退出看门狗），而不是让 Node 默认裸退丢掉终态。
 */
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection (process-level guardrail)', {
    reason: reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason),
  })
  reportErrorToSink(reason, 'gateway')
})
process.on('uncaughtException', (err) => {
  log.error('uncaught exception (process-level guardrail) — graceful shutdown', {
    error: err.message,
    stack: err.stack,
  })
  reportErrorToSink(err, 'gateway')
  void shutdown('uncaughtException', server)
})
