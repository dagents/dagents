import { serve } from '@hono/node-server'
import { initDb, runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { startTracing } from '@dagents/shared/otel'
import { app } from './app.js'
import { wsHub } from './ws-hub.js'

const tracing = startTracing('gateway')
const log = createLogger({ svc: 'gateway:reaper' })

const port = Number(process.env.GATEWAY_PORT ?? 8080)
// 默认绑定 127.0.0.1，防止网关被局域网直接访问绕过 console 代理层。
// 如需从其他设备访问（如远程开发），显式设置 GATEWAY_HOST=0.0.0.0。
const hostname = process.env.GATEWAY_HOST ?? '127.0.0.1'

await initDb()

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

function shutdown(): void {
  void (async () => {
    if (reaperTimer) clearInterval(reaperTimer)
    try {
      await tracing.shutdown()
    } catch (err) {
      console.error('shutdown error', err)
    }
    process.exit(0)
  })()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// 启动 Hono HTTP server，然后把 WebSocket hub 挂到底层 http.Server 上。
// `serve` 直接返回 ServerType（http.Server | http2.Http2Server | …），
// 我们只关心它的 `upgrade` 事件，所以 cast 到 http.Server 即可。
// WS 端点 /ws 由 wsHub 处理 upgrade 请求，其余 HTTP 路由由 Hono app 处理。
const server = serve({ fetch: app.fetch, port, hostname })
wsHub.attachToServer(server as unknown as import('node:http').Server)
console.log(`gateway on ${hostname}:${port} (ws: /ws)`)
