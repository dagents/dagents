/**
 * OpenTelemetry SDK bootstrap (plan M6.1 / P1.11.T2).
 *
 * `startTracing(serviceName)` is the single entry every service calls FIRST in
 * its entry script (`apps/{gateway,dispatch,scheduler}/src/index.ts`,
 * `packages/daemon/src/cli.ts`) — before DB, Redis, or any module that issues
 * I/O. Calling it first is what lets the auto-instrumentations patch `fetch`
 * (undici) and `http` before the first request runs, so W3C `traceparent` is
 * injected into every outbound hop without each call site touching headers.
 *
 * ## Configuration — env-driven, noop by default
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` selects a real OTLP/HTTP trace exporter. We
 * construct `OTLPTraceExporter()` with NO explicit `url`: the exporter then
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` itself and appends the signal path
 * `/v1/traces` per the OTLP/HTTP spec, so a deployment points the env at a
 * collector BASE URL (e.g. `http://otel-collector:4318`). Passing `url`
 * explicitly would disable that append (verified — POST then lands on the base
 * path verbatim and any spec-compliant collector 404s), so we deliberately do
 * not. When the env is unset, the SDK still starts and instruments (so
 * `traceparent` propagates + spans are sampleable in tests via the injected
 * `InMemorySpanExporter`) but exports nowhere — keeping the test suite and
 * local dev free of any external collector dependency. This mirrors the plan's
 * "无 endpoint 时 noop 保证测试零外部依赖" requirement.
 *
 * ## Trace backend — Langfuse persistence is deferred
 *
 * M6.1 delivers propagation + a spec-correct OTLP exporter; it does NOT wire a
 * trace *backend*. The dev stack's Langfuse is pinned to v2.95.11
 * (`infra/docker-compose.yml`), and v2 does NOT expose an OTLP ingestion
 * endpoint — `/api/public/otel*` returns 404 (verified against the pinned
 * image); OTLP ingestion is a Langfuse v3 feature that requires ClickHouse,
 * which is exactly why this stack pins v2. So pointing
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at Langfuse v2 will NOT land traces there.
 * M6.3+ ("读 runs + Langfuse") decides the backend path (Langfuse v3 upgrade,
 * an OTel Collector translating OTLP→Langfuse's ingestion API, or another
 * collector) — until then, set `OTEL_EXPORTER_OTLP_ENDPOINT` to a real OTLP
 * collector (e.g. a local Jaeger/Tempo) to observe traces.
 *
 * ## Propagation
 *
 * `NodeSDK` defaults to the W3C `tracecontext` + `baggage` propagator
 * (`@opentelemetry/core`'s default), so the same `traceId` threads across
 * service boundaries via the `traceparent` header. The undici instrumentation
 * injects it on outbound `fetch`; the `http` instrumentation extracts it on
 * inbound requests. We rely on these defaults rather than re-declaring the
 * propagator so an env override (`OTEL_PROPAGATORS`) still works.
 *
 * ## Resource
 *
 * `service.name` is the one attribute we set explicitly (per service). We pass
 * a synchronous `resourceFromAttributes` and disable `autoDetectResources` so
 * the SDK does not defer span export while async resource detectors resolve —
 * a deferral that, with `SimpleSpanProcessor`, silently dropped ended spans
 * before the exporter saw them (verified during M6.1 spike). The other process
 * /host detectors add little for this stack and are not worth the async wait.
 *
 * ## Testing seam
 *
 * `createTestTracing(serviceName)` returns a handle with an
 * `InMemorySpanExporter` so tests assert "same traceId across N hops" without
 * an OTLP collector. The handle's `shutdown()` flushes + tears down the SDK so
 * tests don't leak a global provider across files. Production code never calls
 * it.
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'

/**
 * Instrumentations shared by every service. `getNodeAutoInstrumentations`
 * bundles `http` (inbound server spans + outbound client spans) and `undici`
 * (Node's global `fetch` — injects `traceparent` on outbound requests), which
 * together give us automatic W3C propagation across gateway→flowise→daemon→
 * LLM without per-call-site header plumbing.
 *
 * `fs` and `dns` are noisy and irrelevant to request traces; disabling them
 * keeps spans focused on the HTTP hop chain the acceptance criterion checks.
 */
function buildInstrumentations() {
  return getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
  })
}

/**
 * Whether to wire a real OTLP exporter. Driven solely by the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` env var so dev/test stay collector-free by
 * default and a deployment flips tracing on with one env var (no code change).
 */
function otlpEndpoint(): string | undefined {
  const v = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  return v && v.trim().length > 0 ? v.trim() : undefined
}

/**
 * Start OpenTelemetry for a service. Idempotent: a second call is a no-op so a
 * test that re-imports an entry module does not register a second global SDK
 * (which `@opentelemetry/api` would warn about and the second would lose).
 *
 * Returns the `NodeSDK` so callers (tests, or a graceful-shutdown hook) can
 * `shutdown()` it; production entries ignore the return.
 */
export function startTracing(serviceName: string): NodeSDK {
  // `NodeSDK.configuration` is set on construction; we can't read it back, so
  // guard re-entry with a module-level flag.
  if (started) return started
  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
  }

  const resource = resourceFromAttributes({ 'service.name': serviceName })

  if (otlpEndpoint()) {
    // OTLP/HTTP trace exporter. Constructed with NO `url` so the exporter reads
    // `OTEL_EXPORTER_OTLP_ENDPOINT` itself and appends the spec signal path
    // `/v1/traces` (passing `url` would use it verbatim and 404 on a spec
    // collector — verified). NodeSDK wraps the exporter in its default
    // BatchSpanProcessor, keeping export off the hot path; `shutdown()` on the
    // returned SDK flushes the batch (entries call it on SIGTERM).
    const traceExporter = new OTLPTraceExporter()
    started = new NodeSDK({
      serviceName,
      resource,
      autoDetectResources: false,
      traceExporter,
      instrumentations: [buildInstrumentations()],
    })
  } else {
    // No collector configured: start the SDK + instrumentations so
    // `traceparent` still propagates and spans are created (sampleable in
    // tests via the test seam), but attach no exporter — ended spans simply
    // aren't shipped anywhere. A ConsoleSpanProcessor would spam logs, so we
    // attach none.
    started = new NodeSDK({
      serviceName,
      resource,
      autoDetectResources: false,
      instrumentations: [buildInstrumentations()],
    })
  }

  started.start()
  return started
}

// Module-level guard so a repeated `startTracing` call is a no-op. Held as a
// bare `let` rather than wrapped in an object because this module is the only
// mutator and the simplicity is worth the directness.
let started: NodeSDK | undefined

/**
 * Test-only tracing bootstrap. Registers the SDK with a `SimpleSpanProcessor`
 * backed by an `InMemorySpanExporter` so tests read finished spans back and
 * assert "same traceId across hops". Idempotent per process like
 * `startTracing`; returns a handle exposing the exporter + a `shutdown()`.
 *
 * Production code MUST NOT call this — it keeps spans in memory forever.
 */
export function createTestTracing(serviceName: string): {
  exporter: InMemorySpanExporter
  shutdown(): Promise<void>
} {
  if (started) {
    // A prior bootstrap (prod or test) already ran this process. We can't
    // reconfigure the global provider; return a fresh standalone exporter the
    // test can still read from by re-registering a processor is not possible
    // post-start, so surface the situation loudly rather than silently
    // returning an exporter that captures nothing.
    throw new Error(
      'createTestTracing called after tracing already started — call it before any startTracing() in the process',
    )
  }
  const exporter = new InMemorySpanExporter()
  const sdk = new NodeSDK({
    serviceName,
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    autoDetectResources: false,
    // `SimpleSpanProcessor` exports each span synchronously on end, so tests
    // see spans without awaiting a batch flush. `{ exporter }` is the
    // documented options shape; passing the exporter directly was a silent
    // no-op in the 2.x line (verified during the M6.1 spike).
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
    instrumentations: [buildInstrumentations()],
  })
  sdk.start()
  started = sdk
  return {
    exporter,
    shutdown: async () => {
      await sdk.shutdown()
      started = undefined
    },
  }
}
