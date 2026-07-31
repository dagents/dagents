import { serve } from '@hono/node-server'
import { initDb } from '@dagents/db'
import { startTracing } from '@dagents/shared'
import { app } from './app.js'
import { wsHub } from './ws-hub.js'

const tracing = startTracing('gateway')

const port = Number(process.env.GATEWAY_PORT ?? 8080)
// 默认绑定 127.0.0.1，防止网关被局域网直接访问绕过 console 代理层。
// 如需从其他设备访问（如远程开发），显式设置 GATEWAY_HOST=0.0.0.0。
const hostname = process.env.GATEWAY_HOST ?? '127.0.0.1'

await initDb()

function shutdown(): void {
  void (async () => {
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
