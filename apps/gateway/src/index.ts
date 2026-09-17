import { serve, type ServerType } from '@hono/node-server'
import { AppDataSource, initDb, runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { startTracing } from '@dagents/shared/otel'
import { app } from './app.js'
import { wsHub } from './ws-hub.js'
import { executionRegistry } from './execution-registry.js'
import { startRetentionTimer } from './retention.js'
import { markOrphanedHumanInputs } from './routes/human-input.js'

const tracing = startTracing('gateway')
const log = createLogger({ svc: 'gateway:reaper' })

const port = Number(process.env.GATEWAY_PORT ?? 8080)
// 默认绑定 127.0.0.1，防止网关被局域网直接访问绕过 console 代理层。
// 如需从其他设备访问（如远程开发），显式设置 GATEWAY_HOST=0.0.0.0。
const hostname = process.env.GATEWAY_HOST ?? '127.0.0.1'

await initDb()

/**
 * Boot sweep (execution-cancellation spec D7 / architecture AD-6): a gateway
 * restart kills every in-flight execution — inline CLI spawns, engine runs,
 * HumanInput pending promises all lived in this process and nothing will ever
 * write their terminal state. Converge the dangling DB rows so nothing stays
 * 'running' forever: affected chats get a visible system message, runs flip
 * to failed. ('cancelled' stays reserved for explicit user cancels.)
 *
 * 2026-09-17 补洞：run_node_spans 的 'running' 行（唯一写入方就是本进程，
 * boot 时任何 running span 必然悬空）与「认领 daemon 已离线」的
 * dispatch_tasks 一并收敛 —— 此前这两类会永久停在运行中态。
 */
async function sweepDanglingExecutions(): Promise<void> {
  // 每步独立容错：一条 SQL 失败（如列名演进）不能让其余收敛项陪葬
  //（首版实现整段一个 try/catch，run_node_spans 的列名错就连带
  // dispatch_tasks 也不收敛了 —— e2e 库 boot 日志暴露）。
  const step = async (name: string, sql: string, params: unknown[] = []): Promise<void> => {
    try {
      const { affected } = await runQuery(sql, params)
      if (affected && affected > 0) {
        log.warn('boot sweep step converged rows', { step: name, count: affected })
      }
    } catch (err) {
      log.warn('boot sweep step failed', {
        step: name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM chats WHERE status = 'running'`,
      [],
    )
    if (records.length > 0) {
      for (const chat of records) {
        await runQuery(
          `INSERT INTO chat_messages (chat_id, role, content, created_at)
           VALUES ($1::uuid, 'system', '执行被 gateway 重启中断（如有需要请重新发起）', NOW())`,
          [chat.id],
        ).catch(() => {
          // best-effort message — the status flip below is what matters
        })
      }
      await runQuery(
        `UPDATE chats SET status = 'failed', updated_at = NOW() WHERE status = 'running'`,
        [],
      )
      log.warn('boot sweep: dangling chats converged to failed', { count: records.length })
    }
    await step(
      'runs',
      `UPDATE runs SET status = 'failed', finished_at = NOW() WHERE status IN ('running', 'pending')`,
    )
    // run_node_spans 的 'running' 行（唯一写入方就是本进程，boot 时任何
    // running span 必然悬空）。列名是 finished_at（对齐 entity 映射）。
    await step(
      'run_node_spans',
      `UPDATE run_node_spans
          SET status = 'failed',
              error = COALESCE(error, 'gateway 重启中断（boot sweep）'),
              finished_at = COALESCE(finished_at, NOW())
        WHERE status = 'running'`,
    )
    // dispatch_tasks：daemon 与 gateway 是两个进程 —— daemon 活着时它的
    // claimed/running 任务仍会正常回报终态，不能一刀切。只收敛「认领
    // daemon 已离线」的任务；未被认领的 queued 任务留给调度路径（daemon
    // 重连后仍可 claim）。
    await step(
      'dispatch_tasks',
      `UPDATE dispatch_tasks t
          SET status = 'failed',
              finished_at = NOW(),
              failure_reason = 'claiming daemon offline (gateway boot sweep)'
        WHERE t.status IN ('claimed', 'running')
          AND t.claimed_by_daemon_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM daemons d
             WHERE d.id = t.claimed_by_daemon_id
               AND (d.status = 'offline' OR d.last_heartbeat_at < NOW() - interval '15 seconds')
          )`,
    )
  } catch (err) {
    log.warn('boot sweep failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
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

process.on('SIGTERM', () => void shutdown('SIGTERM', server))
process.on('SIGINT', () => void shutdown('SIGINT', server))
