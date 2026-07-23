import { serve } from '@hono/node-server'
import { initDb } from '@mil/db'
import { startTracing } from '@mil/shared'
import { app } from './app.js'
import { startProbeWorker } from './probe.js'

// Start OTel BEFORE any other import side effect / I/O so the auto-
// instrumentations patch `fetch` (undici) + `http` before the first request
// runs — this is what makes W3C `traceparent` propagate gateway→flowise→
// daemon→LLM without per-call-site header plumbing (plan M6.1). The handle is
// awaited on shutdown to flush the BatchSpanProcessor so a SIGTERM doesn't
// drop the last in-flight batch.
const tracing = startTracing('gateway')

const port = Number(process.env.GATEWAY_PORT ?? 8080)

// DB is initialized once at bootstrap; tokens routes + probe worker reuse the
// shared AppDataSource (mirrors dispatch's bootstrap()). Must run before
// startProbeWorker()/serve() — runQuery -> createQueryRunner().connect() needs
// the pool that initialize() creates, else list/get/PUT 500 and probe crashes.
await initDb()

// Health probe worker (P1.4.T8): polls new-api token status on an interval
// and writes it to token_meta. No-op when NEWAPI_ADMIN_KEY isn't set. Started
// before serve() so the first sweep runs as the gateway comes up; stopped on
// SIGTERM so the process exits cleanly.
const probeWorker = startProbeWorker()

function shutdown(): void {
  // Async shutdown — fire and forget; the process exits when it settles.
  void (async () => {
    try {
      probeWorker.stop()
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
