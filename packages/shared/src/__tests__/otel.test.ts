import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { trace, context } from '@opentelemetry/api'
import { createTestTracing, getTracer } from '../index.js'

/**
 * OTel SDK + W3C `traceparent` propagation tests (plan M6.1).
 *
 * These tests assert the acceptance criterion for M6.1 — "同 traceId 贯穿
 * gateway→flowise→daemon→LLM" — at the propagation layer:
 *
 * - `startTracing`/`createTestTracing` registers a working SDK with an
 *   `InMemorySpanExporter` (no OTLP collector needed).
 * - A run-entry span tagged `run.id` is exported and readable via
 *   `currentRunId()`.
 * - The undici auto-instrumentation injects a W3C `traceparent` header into
 *   outbound `fetch` whose traceId matches the active span's — the mechanism
 *   that threads one traceId across gateway→flowise→daemon→LLM without
 *   per-call-site header plumbing.
 * - `traceparent` extracted on an inbound hop reuses the SAME traceId, so the
 *   chain is continuous end-to-end.
 *
 * The stub-server pattern mirrors `apps/gateway/src/__tests__/proxy.test.ts`:
 * spin up a real `node:http` server, point the code under test at it via
 * `process.env`, drive real `fetch` calls. No DB, no Redis, no OTLP collector.
 */

let tracing: ReturnType<typeof createTestTracing>

// Stub "Flowise" server: records the `traceparent` it receives so a test can
// assert the outbound hop joined the active trace.
let stubServer: Server
let stubUrl = ''
let receivedTraceparent: string | null = null

beforeAll(async () => {
  // Register OTel FIRST so the undici instrumentation patches `fetch` before
  // the first request. `createTestTracing` is the test-only seam; production
  // uses `startTracing`, but both go through the same SDK + auto-
  // instrumentations, so propagation behavior is identical.
  tracing = createTestTracing('test')

  stubServer = createServer((req, res) => {
    // `traceparent` arrives lowercased (HTTP headers are case-insensitive).
    receivedTraceparent = (req.headers['traceparent'] as string | undefined) ?? null
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  await tracing.shutdown()
})

afterEach(() => {
  receivedTraceparent = null
  tracing.exporter.reset()
})

describe('OTel SDK — run-entry span + run.id', () => {
  it('exports a span tagged with run.id and surfaces it via currentRunId()', async () => {
    const tracer = getTracer('test')
    await tracer.startActiveSpan('gateway.proxy', async (span) => {
      span.setAttribute('run.id', 'run-abc')
      // Inside the active span, `currentRunId()` reads `run.id` off it.
      // Imported lazily here to avoid a top-level cycle in the test.
      const { currentRunId } = await import('../index.js')
      expect(currentRunId()).toBe('run-abc')
      span.end()
    })

    const spans = tracing.exporter.getFinishedSpans()
    expect(spans.length).toBe(1)
    expect(spans[0]!.name).toBe('gateway.proxy')
    expect(spans[0]!.attributes['run.id']).toBe('run-abc')
  })

  it('currentRunId() returns undefined outside any span', async () => {
    const { currentRunId } = await import('../index.js')
    expect(currentRunId()).toBeUndefined()
  })
})

describe('OTel SDK — W3C traceparent propagation', () => {
  it('injects a traceparent whose traceId matches the active span into outbound fetch', async () => {
    const tracer = getTracer('test')
    await tracer.startActiveSpan('gateway.proxy', async (span) => {
      span.setAttribute('run.id', 'run-xyz')
      const expectedTraceId = span.spanContext().traceId

      // Real outbound fetch through the stub server. The undici
      // instrumentation injects `traceparent` from the active span.
      const res = await fetch(`${stubUrl}/api/v1/prediction/x`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(200)

      // The header the stub received must carry the SAME traceId as the span —
      // this is the property that makes the whole chain one trace.
      expect(receivedTraceparent).not.toBeNull()
      const tpTraceId = receivedTraceparent!.split('-')[1]
      expect(tpTraceId).toBe(expectedTraceId)
      span.end()
    })
  })

  it('threads one traceId across an outbound hop and back (4-hop chain shape)', async () => {
    // Simulates the gateway→flowise→daemon→LLM chain at the propagation layer:
    // a root span opens a trace; an outbound fetch (hop 1) carries its
    // traceparent to the stub; the stub would start a child span under that
    // extracted context and make its own outbound call (hop 2), and so on. We
    // assert the invariant that matters for the acceptance criterion: every
    // hop's traceparent resolves to the SAME traceId as the root.
    const tracer = getTracer('test')
    await tracer.startActiveSpan('run.root', async (root) => {
      root.setAttribute('run.id', 'run-chain')
      const rootTraceId = root.spanContext().traceId

      // Hop 1: gateway → flowise (outbound fetch).
      await fetch(`${stubUrl}/hop1`, { method: 'POST', body: '{}' })
      const hop1TraceId = receivedTraceparent!.split('-')[1]
      expect(hop1TraceId).toBe(rootTraceId)

      // Hop 2: a downstream service extracting that traceparent would continue
      // the same trace. We model it by issuing another fetch from within the
      // same active span — its injected traceparent must still match.
      receivedTraceparent = null
      await fetch(`${stubUrl}/hop2`, { method: 'POST', body: '{}' })
      const hop2TraceId = receivedTraceparent!.split('-')[1]
      expect(hop2TraceId).toBe(rootTraceId)

      root.end()
    })

    // All spans (the manual root + the two undici client spans) share one
    // traceId.
    const spans = tracing.exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThanOrEqual(1)
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId))
    expect(traceIds.size).toBe(1)
  })
})

describe('OTel SDK — extract on an inbound hop continues the trace', () => {
  it('a traceparent received by an inbound request becomes the parent of a child span', async () => {
    // Models the receiving side of each hop: dispatch/daemon/flowise receive a
    // `traceparent` and must start their work as a CHILD of it, not a new
    // trace. The `http` instrumentation does this automatically for inbound
    // server requests; here we assert the equivalent context extraction
    // manually so the test stays free of a second real server.
    const { W3CTraceContextPropagator, TRACE_PARENT_HEADER } = await import('@opentelemetry/core')
    const propagator = new W3CTraceContextPropagator()

    // Root trace on the "caller" side.
    const tracer = getTracer('test')
    const callerSpan = tracer.startSpan('caller.hop')
    const callerCtx = trace.setSpan(context.active(), callerSpan)

    // Inject into a carrier (headers), as undici would on the outbound side.
    const carrier: Record<string, string> = {}
    propagator.inject(callerCtx, carrier, {
      set: (c, k, v) => {
        c[k] = v
      },
      })
    expect(carrier[TRACE_PARENT_HEADER]).toBeTruthy()
    const injectedTraceId = carrier[TRACE_PARENT_HEADER]!.split('-')[1]
    expect(injectedTraceId).toBe(callerSpan.spanContext().traceId)

    // Extract on the "receiver" side (no active span), then start a child span
    // under the extracted context. The child must share the caller's traceId.
    const receiverCtx = propagator.extract(context.active(), carrier, {
      get: (c, k) => c[k],
      keys: (c) => Object.keys(c),
    })
    const receiverSpan = tracer.startSpan(
      'receiver.hop',
      {},
      receiverCtx,
    )
    expect(receiverSpan.spanContext().traceId).toBe(callerSpan.spanContext().traceId)
    callerSpan.end()
    receiverSpan.end()
  })
})
