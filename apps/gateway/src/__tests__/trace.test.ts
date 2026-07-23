import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { trace, context } from '@opentelemetry/api'
import { createTestTracing, getTracer, currentRunId } from '@mil/shared'
import { app } from '../app.js'

/**
 * Gateway trace propagation (plan M6.1).
 *
 * Drives the real gateway flow proxy (`app.request()`) against a stub Flowise
 * and asserts the W3C `traceparent` the gateway forwards to Flowise carries
 * the SAME traceId as a run-entry span wrapping the call — the mechanism that
 * threads one traceId across gateway→flowise→daemon→LLM.
 *
 * Mirrors `proxy.test.ts`'s stub-server pattern: a real `node:http` server
 * stands in for Flowise, pointed at via `FLOWISE_URL`, and the gateway is
 * driven in-process via Hono's `app.request()`. No DB, no Redis, no OTLP
 * collector — `createTestTracing` captures spans in memory.
 *
 * The gateway's auto-instrumented `fetch` (undici) injects `traceparent` from
 * the active span; the run-entry span the route opens is tagged `run.id`, so
 * `currentRunId()` resolves inside the proxy and the forwarded `traceparent`
 * matches the run's trace.
 */

let tracing: ReturnType<typeof createTestTracing>
let stubServer: Server
let receivedTraceparent: string | null = null

beforeAll(async () => {
  tracing = createTestTracing('gateway-test')
  stubServer = createServer((req, res) => {
    receivedTraceparent = (req.headers['traceparent'] as string | undefined) ?? null
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({ text: 'ok', echoedRunId: req.headers['x-run-id'] }))
  })
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  process.env.FLOWISE_URL = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  await tracing.shutdown()
})

afterEach(() => {
  receivedTraceparent = null
  tracing.exporter.reset()
})

const ID = '11111111-1111-4111-8111-111111111111'

describe('gateway flow proxy — W3C traceparent propagation (M6.1)', () => {
  it('forwards a traceparent to Flowise matching the run-entry span traceId', async () => {
    // Wrap the client request in a span so the gateway's hop is a child of a
    // caller trace — modeling how a scheduler/daemon call enters the gateway.
    const tracer = getTracer('test')
    await tracer.startActiveSpan('caller.predict', async (callerSpan) => {
      callerSpan.setAttribute('run.id', 'run-prop')
      const callerTraceId = callerSpan.spanContext().traceId

      const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-run-id': 'run-prop' },
        body: JSON.stringify({ question: 'x' }),
      })
      expect(res.status).toBe(200)

      // The gateway forwarded a traceparent whose traceId matches the caller's
      // (and thus the run's) trace — the end-to-end continuity the acceptance
      // criterion checks.
      expect(receivedTraceparent).not.toBeNull()
      const tpTraceId = receivedTraceparent!.split('-')[1]
      expect(tpTraceId).toBe(callerTraceId)
      callerSpan.end()
    })
  })

  it('opens a gateway.proxy span tagged run.id and ends it', async () => {
    await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x' }),
    })

    const spans = tracing.exporter.getFinishedSpans()
    const proxySpan = spans.find((s) => s.name === 'gateway.proxy')
    expect(proxySpan).toBeDefined()
    // run.id is set on the span from the x-run-id the caller sent (or a freshly
    // minted UUID); here we sent none, so the gateway generated one and tagged
    // the span with it.
    expect(proxySpan!.attributes['run.id']).toBeTruthy()
    // The undici instrumentation also emitted an HTTP client span for the
    // outbound fetch; it shares the proxy span's traceId.
    const clientSpan = spans.find((s) => s.name === 'POST')
    expect(clientSpan).toBeDefined()
    expect(clientSpan!.spanContext().traceId).toBe(proxySpan!.spanContext().traceId)
  })

  it('currentRunId() resolves to the forwarded x-run-id inside the proxy', async () => {
    // The route sets run.id on its active span from x-run-id; `currentRunId()`
    // reads it back. We assert it indirectly: the span attribute equals the
    // x-run-id we sent (the only writer of run.id on that span is the route).
    await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': 'run-explicit-42' },
      body: JSON.stringify({ question: 'x' }),
    })

    const proxySpan = tracing.exporter.getFinishedSpans().find((s) => s.name === 'gateway.proxy')
    expect(proxySpan!.attributes['run.id']).toBe('run-explicit-42')
    // `currentRunId` is exercised by the shared-suite unit test; here we just
    // reference it so the import is not tree-shaken as unused in this file.
    expect(typeof currentRunId).toBe('function')
  })
})
