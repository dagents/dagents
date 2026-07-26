import { serve } from '@hono/node-server'
import { initDb } from '@dagents/db'
import { startTracing } from '@dagents/shared'
import { app } from './app.js'

const tracing = startTracing('gateway')

const port = Number(process.env.GATEWAY_PORT ?? 8080)

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

serve({ fetch: app.fetch, port })
console.log(`gateway on :${port}`)
