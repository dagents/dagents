import { serve } from '@hono/node-server'
import { startTracing } from '@dagents/shared'
import { app, bootstrap } from './app.js'

// Start OTel BEFORE any I/O so the auto-instrumentations patch `fetch`/`http`
// before the first request — W3C `traceparent` then propagates across the
// dispatch ↔ daemon hop without per-call-site header plumbing (plan M6.1). The
// handle is awaited on shutdown to flush the BatchSpanProcessor so a SIGTERM
// doesn't drop the last in-flight batch.
const tracing = startTracing('dispatch')

// `index.ts` is the only place that listens. `app` is exported separately so
// tests can drive it via `app.request()` without binding a port.
const port = Number(process.env.DISPATCH_PORT ?? 8081)

await bootstrap()
serve({ fetch: app.fetch, port })
console.log(`dispatch on :${port}`)

function shutdown(): void {
  // Async shutdown — fire and forget; the process exits when it settles.
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
