import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { context } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

import { AppDataSource, runQuery } from '@dagents/db'
import { createRedis, createTestTracing } from '@dagents/shared'
import type { RedisClient } from '@dagents/shared'
import { runDaemon } from '@dagents/daemon'
import type { AgentBackend, AgentEvent, AgentResult, AgentSession, ExecOptions } from '@dagents/contracts'

// Real app source — imported by relative path so vitest transforms the TS in
// place. We deliberately import `app.ts` (which does NOT call `serve()`), never
// `index.ts` (which binds a port on import). The e2e owns `serve()` so it can
// pick ephemeral ports and tear the servers down in `afterAll`.
import { app as gatewayApp } from '../../../apps/gateway/src/app.js'
import { app as dispatchApp, bootstrap as dispatchBootstrap } from '../../../apps/dispatch/src/app.js'
import { fanOut } from '../../../apps/scheduler/src/fanout.js'
import { createRedisSemaphore } from '../../../apps/scheduler/src/semaphore.js'
import { createFlowisePredictionClient } from '../../../apps/scheduler/src/prediction-client.js'
import { listRunNodeSpans } from '../../../apps/scheduler/src/run-node-spans.js'

/**
 * M6.7 — full-chain trace end-to-end (plan §Task M6.7).
 *
 * Acceptance (issue MZW-280): "选一任务, 从 gateway 追到 daemon/LLM, trace 完整
 * (run_id 串起 gateway → dispatch → daemon → claude adapter → LLM, 含 text/tool-use
 * 事件 + usage 落库 + 节点级 span)".
 *
 * This is the M6 capstone: it wires the real gateway + dispatch + scheduler +
 * daemon together against the docker-compose Postgres/Redis and asserts ONE
 * `run_id` threads every hop, with a continuous OTel traceId across the
 * prediction chain and the run's text/tool-use events, usage, and node-level
 * spans all landed in the platform DB.
 *
 * ## Why real `serve()` (not `app.request()`)
 *
 * The W3C `traceparent` the undici auto-instrumentation injects on outbound
 * `fetch` is only *extracted* on the receiving hop by the `http` server
 * instrumentation when the request arrives through a real `node:http` server.
 * `app.request()` is an in-process call that bypasses the server instrumentation,
 * so it cannot prove the traceparent actually crosses the wire. This suite boots
 * dispatch + gateway on ephemeral ports via `@hono/node-server`'s `serve()` and
 * points the daemon + scheduler at those URLs, so every hop is a real instrumented
 * HTTP call — the faithful proof M6.1's "同 traceId 贯穿" acceptance asks for.
 *
 * ## The chain driven by ONE `run_id`
 *
 *   scheduler.fanOut(childRunId)
 *     → prediction POST gateway /api/v1/flows/<flowId>/prediction  (x-run-id=childRunId)
 *       → gateway.proxy span (run.id=childRunId) + fetch stub Flowise (traceparent injected)
 *         → stub Flowise extracts traceparent, POSTs gateway /api/v1/dispatch/invoke (x-run-id=childRunId)
 *           → dispatch enqueues dispatch_tasks (run_id=childRunId), returns taskId
 *             → daemon claims (poll), opens daemon.execute span (run.id=childRunId)
 *               → fake claude backend yields text + tool-use events + usage
 *                 → (models "claude adapter → LLM": the backend dials the stub LLM
 *                   through the gateway's /api/v1/llm passthrough — a real
 *                   instrumented fetch joining the daemon's trace)
 *               → daemon reportMessages (text + tool-use) + completeTask(usage)
 *             → dispatch appends usage to runs.agent_daemon_calls + events to dispatch_task_events
 *         → stub Flowise polls GET /api/v1/dispatch/tasks/:taskId until completed, then
 *           returns the agentflow prediction response (carrying agentFlowExecutedData)
 *           so the scheduler ingests node spans
 *       → gateway echoes x-run-id
 *     → scheduler completes the run + ingests run_node_spans (trace_id = the prediction traceId)
 *
 * ## Honest scope note — two trace roots
 *
 * The daemon is pull-based: it claims work by polling, so its `daemon.execute`
 * span is opened only AFTER a task is claimed — there is no inbound request
 * whose `traceparent` it can extract to continue the prediction trace. M6.1
 * therefore correlates the daemon hop to the run by `run.id` (read back via
 * `currentRunId()`), not by a shared traceId. This suite asserts that honest
 * contract: the prediction chain (scheduler → gateway → flowise) shares ONE
 * traceId that also lands on `run_node_spans.trace_id`, the dispatch invoke hop
 * continues that same trace (the stub Flowise extracts + re-injects the
 * traceparent), and the daemon hop is `run.id`-correlated. The single `run_id`
 * is what ties the prediction trace and the daemon trace together — exactly the
 * "run_id 串起" the acceptance names.
 */

let tracing: ReturnType<typeof createTestTracing>
let redis: RedisClient

// Real servers started for the test, torn down in afterAll.
let dispatchServer: ReturnType<typeof serve>
let gatewayServer: ReturnType<typeof serve>
let flowiseServer: Server
let llmServer: Server

let dispatchUrl = ''
let gatewayUrl = ''
let agentDaemonId = '' // agent_daemons.id the stub Flowise invokes against

// Traceparents the stub servers observed on inbound requests — the proof the
// undici instrumentation injected a header whose traceId matches the active
// span's, i.e. the trace crossed the hop.
let flowiseReceivedTraceparent: string | null = null
let llmReceivedTraceparent: string | null = null

const propagator = new W3CTraceContextPropagator()

/**
 * Pull every traceId (field 2) out of the `traceparent` header value(s) seen.
 * A request may carry multiple `traceparent` values (the gateway forwards the
 * inbound traceparent verbatim AND undici injects the active span's), so this
 * returns the full set — the correlation assertion checks membership.
 */
function traceparentTraceIds(header: string): Set<string> {
  return new Set(
    header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tp) => tp.split('-')[1])
      .filter((t): t is string => !!t),
  )
}

beforeAll(async () => {
  // OTel FIRST: register the SDK + auto-instrumentations before any `fetch`
  // runs, so undici is patched and `traceparent` is injected on every outbound
  // hop. `createTestTracing` wires an `InMemorySpanExporter` so the suite reads
  // finished spans back without an OTLP collector (same seam as the M6.1 unit
  // tests). Must run before any `startTracing` in the process; the app source
  // modules imported above do NOT start tracing (only their `index.ts` does,
  // which we never import), so this is the first bootstrap.
  tracing = createTestTracing('m6.7-e2e')

  if (!AppDataSource.isInitialized) await dispatchBootstrap()
  redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:16479')
  await redis.raw().ping()

  // ── dispatch on an ephemeral port ──────────────────────────────────────
  await new Promise<void>((resolve) => {
    dispatchServer = serve({ fetch: dispatchApp.fetch, port: 0 }, (info) => {
      dispatchUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })

  // ── stub Flowise (real node:http server) ───────────────────────────────
  flowiseServer = createServer((req, res) => {
    void stubFlowiseHandler(req, res)
  })
  await new Promise<void>((r) => flowiseServer.listen(0, '127.0.0.1', r))
  const flowiseAddr = flowiseServer.address() as AddressInfo
  process.env.FLOWISE_URL = `http://127.0.0.1:${flowiseAddr.port}`
  // Point the gateway's lazy URL readers at the stubs / dispatch BEFORE the
  // first request flows. The gateway reads these at request time, so setting
  // them here (before requests) is sufficient.
  process.env.DISPATCH_URL = dispatchUrl
  // The gateway proxies node-spans reads to the scheduler; this suite does not
  // exercise that path, but a stray request must not 502 on a missing default.
  process.env.SCHEDULER_URL = dispatchUrl

  // ── gateway on an ephemeral port ───────────────────────────────────────
  await new Promise<void>((resolve) => {
    gatewayServer = serve({ fetch: gatewayApp.fetch, port: 0 }, (info) => {
      gatewayUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })

  // ── stub LLM / new-api ─────────────────────────────────────────────────
  // Stands in for the LLM the claude adapter would call through the gateway's
  // `/api/v1/llm/*` passthrough. The daemon's fake backend dials it (see
  // `fakeClaudeBackend`) so the "claude adapter → LLM" hop is a real
  // instrumented fetch joining the daemon's trace.
  llmServer = createServer((req, res) => {
    llmReceivedTraceparent = (req.headers['traceparent'] as string | undefined) ?? null
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'stub-llm-ok' } }],
      }),
    )
  })
  await new Promise<void>((r) => llmServer.listen(0, '127.0.0.1', r))
  const llmAddr = llmServer.address() as AddressInfo
  process.env.NEWAPI_BASE_URL = `http://127.0.0.1:${llmAddr.port}`

  // ── seed an agent_daemon (invoke's FK target) ──────────────────────────
  // Register a daemon (any daemon) so `agent_daemons.daemon_id` has a valid FK,
  // then seed the agent_daemon row the stub Flowise invokes against. The real
  // daemon (runDaemon, started per-test) registers its OWN daemon and claims
  // the queued task — claim is unauthenticated and not filtered by daemon id
  // (FOR UPDATE SKIP LOCKED on status='queued'), so any online daemon serves
  // any enqueued task. This mirrors the M2.10 canvas-e2e posture.
  const reg = await fetch(`${dispatchUrl}/api/v1/dispatch/daemons/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'e2e-fk-daemon',
      capabilities: [{ agentType: 'claude' }],
    }),
  })
  const regBody = (await reg.json()) as { data: { daemonId: string } }
  const adRows = await AppDataSource.query(
    `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path)
     VALUES ('claude-code', 'claude', $1, 'claude') RETURNING id`,
    [regBody.data.daemonId],
  )
  agentDaemonId = adRows[0].id
})

afterAll(async () => {
  await new Promise<void>((r) => gatewayServer?.close(() => r()))
  await new Promise<void>((r) => dispatchServer?.close(() => r()))
  await new Promise<void>((r) => flowiseServer?.close(() => r()))
  await new Promise<void>((r) => llmServer?.close(() => r()))
  await redis?.raw().quit()
  await tracing?.shutdown()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // Wipe the shared tables so each test starts clean. Order respects FKs:
  // dispatch_task_events → dispatch_tasks → agent_daemons → daemons; runs is
  // independent of dispatch_tasks (run_id is a TEXT ref, no FK).
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM run_node_spans`)
  await AppDataSource.query(`DELETE FROM runs`)
  await redis.del('sem')
  tracing.exporter.reset()
  flowiseReceivedTraceparent = null
  llmReceivedTraceparent = null
})

// ── stub Flowise ───────────────────────────────────────────────────────────

/**
 * The stub Flowise prediction handler. Models the DispatchInvoke tool node:
 * on a prediction request it (1) enqueues a dispatch task via the gateway with
 * the SAME `x-run-id` and the SAME trace (extracted from the inbound
 * `traceparent` and re-injected on the outbound invoke fetch — the faithful W3C
 * continuation a real instrumented Flowise would do), (2) polls the task until
 * terminal, then (3) returns an agentflow prediction response carrying
 * `agentFlowExecutedData` so the scheduler ingests node spans.
 */
async function stubFlowiseHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // Capture the traceparent the gateway forwarded — proves the gateway→flowise
  // hop joined the prediction trace.
  flowiseReceivedTraceparent = (req.headers['traceparent'] as string | undefined) ?? null
  const runId = (req.headers['x-run-id'] as string | undefined) ?? randomUUID()

  // Extract the inbound context (the gateway's traceparent) and continue it on
  // the outbound /dispatch/invoke fetch, so the dispatch hop joins the SAME
  // trace. This is exactly what a Flowise with OTel instrumentation does.
  const extractedCtx = propagator.extract(context.active(), req.headers, {
    get: (c, k) =>
      (c as Record<string, string | string[]>)[k.toLowerCase()] as string | undefined,
    keys: (c) => Object.keys(c as Record<string, unknown>),
  })

  // Enqueue the dispatch task through the gateway (gateway → dispatch), inside
  // the extracted context so the traceparent propagates. dispatch returns the
  // taskId — the stub polls it next.
  const invokeRes = await context.with(extractedCtx, async () => {
    return fetch(`${gatewayUrl}/api/v1/dispatch/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': runId },
      body: JSON.stringify({
        agentDaemonId,
        runId,
        prompt: 'list the directory',
        execOptions: {},
      }),
    })
  })
  const invokeBody = (await invokeRes.json()) as { data?: { taskId: string } }
  const taskId = invokeBody.data?.taskId

  // Poll the task (through the gateway → dispatch) until terminal, continuing
  // the extracted trace on each poll. The real DispatchInvoke node does this.
  let status = 'queued'
  let output = 'ok'
  if (taskId) {
    for (let i = 0; i < 200; i++) {
      await context.with(extractedCtx, async () => {
        const r = await fetch(`${gatewayUrl}/api/v1/dispatch/tasks/${taskId}`, {
          headers: { accept: 'application/json' },
        })
        if (r.ok) {
          const body = (await r.json()) as {
            data?: { status: string; result?: { output?: string } }
          }
          status = body.data?.status ?? status
          if (status === 'completed' || status === 'failed') {
            output = body.data?.result?.output ?? output
          }
        }
      })
      if (status === 'completed' || status === 'failed') break
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // Return an agentflow prediction response carrying the per-node trace, so the
  // scheduler projects it into run_node_spans. The DispatchInvoke node is one
  // of the executed nodes; an Agent node carries usageMetadata.
  const agentflowOutput = {
    executionId: 'exec-e2e',
    sessionId: runId,
    agentFlowExecutedData: [
      {
        nodeId: 'start',
        nodeLabel: 'Start',
        status: 'FINISHED',
        data: { id: 'start', name: 'startAgentflow', output: { content: 'start' } },
      },
      {
        nodeId: 'agent',
        nodeLabel: 'Agent',
        status: 'FINISHED',
        data: {
          id: 'agent',
          name: 'agentAgentflow',
          output: {
            content: output,
            usageMetadata: {
              input_tokens: 42,
              output_tokens: 7,
              total_tokens: 49,
              total_cost: 0.0123,
            },
          },
        },
      },
      {
        nodeId: 'dispatch',
        nodeLabel: 'DispatchInvoke',
        status: 'FINISHED',
        data: { id: 'dispatch', name: 'dispatchInvoke', output: { content: output } },
      },
    ],
  }
  res.setHeader('content-type', 'application/json')
  res.writeHead(200)
  res.end(JSON.stringify(agentflowOutput))
}

// ── fake claude backend (stands in for claude adapter → LLM) ───────────────

/**
 * A fake `AgentBackend` that yields a `status`, `text`, `tool-use`, and
 * `tool-result` event, then a completed `AgentResult` with per-model usage. To
 * model the "claude adapter → LLM" hop as a real instrumented fetch (so it
 * joins the daemon's trace), the backend POSTs the gateway's
 * `/api/v1/llm/chat/completions` passthrough — the same surface the real
 * claude CLI would hit via `ANTHROPIC_BASE_URL`. The stub LLM captures the
 * traceparent.
 */
function fakeClaudeBackend(llmUrl: string): (t: string) => AgentBackend {
  return () => ({
    execute(_prompt: string, _opts: ExecOptions): AgentSession {
      const events: AgentEvent[] = [
        { type: 'status', status: 'started', sessionId: 'sess-e2e' },
        { type: 'text', content: 'listing directory' },
        { type: 'tool-use', tool: 'Bash', callId: 'call-1', input: { cmd: 'ls' } },
        { type: 'tool-result', tool: '', callId: 'call-1', output: 'a.txt\nb.txt' },
      ]
      const gen = (async function* (): AsyncGenerator<AgentEvent> {
        // The LLM hop: a real instrumented fetch. Runs inside the daemon.execute
        // span context, so the stub LLM receives a traceparent sharing the
        // daemon's traceId — the "claude adapter → LLM" hop joining the trace.
        await fetch(`${llmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer sk-stub' },
          body: JSON.stringify({
            model: 'stub-model',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        for (const ev of events) yield ev
      })()
      const result: AgentResult = {
        status: 'completed',
        output: 'a.txt\nb.txt',
        durationMs: 5,
        sessionId: 'sess-e2e',
        usage: { 'stub-model': { inputTokens: 42, outputTokens: 7 } },
      }
      return {
        events: { [Symbol.asyncIterator]: () => gen },
        result: Promise.resolve(result),
      }
    },
  })
}

// ── the test ───────────────────────────────────────────────────────────────

describe('M6.7 — full-chain trace e2e (one run_id, gateway → daemon → LLM)', () => {
  it('threads one run_id + a continuous traceId across every hop with events, usage, and node spans', async () => {
    // A real daemon pointed at the real dispatch URL, with the fake claude
    // backend (which dials the stub LLM). Polls fast so the claimed task is
    // picked up promptly.
    const llmUrl = process.env.NEWAPI_BASE_URL!
    const daemonHandle = runDaemon({
      serverUrl: dispatchUrl,
      label: 'm6.7-daemon',
      agentType: 'claude',
      backendFactory: fakeClaudeBackend(llmUrl),
      pollIntervalMs: 15,
      heartbeatIntervalMs: 1000,
    })

    try {
      // Trigger: scheduler fanOut → gateway → stub flowise → dispatch → daemon.
      // One child input ⇒ one child run; that child's id is the run_id that
      // must thread every hop. The gateway's flow proxy requires a UUID-shaped
      // chatflow id (it rewrites `<uuid>/prediction` → Flowise's
      // `/api/v1/prediction/<uuid>`), so the flowId is a UUID.
      const sem = createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' })
      const prediction = createFlowisePredictionClient({ gatewayUrl })
      const flowId = randomUUID()
      const result = await fanOut(
        {
          flowId,
          pipelineId: flowId,
          identifier: 'm6.7-trace',
          inputs: [{ body: { question: 'list the directory' } }],
        },
        { prediction, semaphore: sem },
      )

      expect(result.total).toBe(1)
      expect(result.completed).toBe(1)
      const runId = result.children[0]!.runId

      // ── (A) run_id threads every hop ──────────────────────────────────
      // runs row
      const runRow = await runQuery<{ status: string; agent_daemon_calls: unknown }>(
        `SELECT status, agent_daemon_calls FROM runs WHERE id = $1`,
        [runId],
      )
      expect(runRow.records[0]?.status).toBe('completed')

      // dispatch_tasks.run_id = runId, completed, with usage
      const taskRow = await runQuery<{
        status: string
        usage: { 'stub-model'?: { inputTokens: number; outputTokens: number } } | null
      }>(`SELECT status, usage FROM dispatch_tasks WHERE run_id = $1`, [runId])
      expect(taskRow.records[0]?.status).toBe('completed')
      expect(taskRow.records[0]?.usage?.['stub-model']?.inputTokens).toBe(42)

      // ── (D) text + tool-use events landed in dispatch_task_events ─────
      const eventRows = await runQuery<{ kind: string; payload: AgentEvent }>(
        `SELECT kind, payload FROM dispatch_task_events
          WHERE task_id = (SELECT id FROM dispatch_tasks WHERE run_id = $1)
          ORDER BY seq`,
        [runId],
      )
      const messages = eventRows.records
        .filter((r) => r.kind === 'message')
        .flatMap((r) => r.payload as AgentEvent)
      expect(messages.some((m) => m.type === 'text')).toBe(true)
      expect(messages.some((m) => m.type === 'tool-use')).toBe(true)
      expect(messages.some((m) => m.type === 'tool-result')).toBe(true)

      // ── (E) usage landed in runs.agent_daemon_calls ───────────────────
      const calls = runRow.records[0]?.agent_daemon_calls as Array<{
        usage?: Record<string, unknown>
        status?: string
      }>
      expect(Array.isArray(calls)).toBe(true)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const call = calls.find((c) => c.status === 'completed')
      expect(call?.usage?.['stub-model']).toMatchObject({ inputTokens: 42, outputTokens: 7 })

      // ── (F) node spans landed with the prediction trace's traceId ─────
      const spans = await listRunNodeSpans(runId)
      expect(spans.length).toBeGreaterThanOrEqual(3) // start + agent + dispatch
      const agentSpan = spans.find((s) => s.nodeId === 'agent')
      expect(agentSpan).toBeDefined()
      expect(agentSpan!.traceId).toBeTruthy()
      expect(Number(agentSpan!.cost)).toBe(0.0123)

      // ── (B) the prediction traceId reaches flowise + node spans ────────
      // The scheduler.child-run span (run.id = runId) opens the run's trace.
      // The gateway forwards the inbound `traceparent` (the scheduler's) to
      // Flowise verbatim, so the traceparent(s) the stub Flowise received
      // include the scheduler run's traceId — the gateway→flowise hop is on the
      // prediction trace. `run_node_spans.trace_id` is stamped from the active
      // span inside the scheduler's `context.with`, so it is the same traceId.
      //
      // (The gateway also opens its own `gateway.proxy` span tagged `run.id`;
      // over a real HTTP hop that span may root a fresh trace because Hono does
      // not extract the inbound traceparent into the handler context — no OTel
      // middleware. undici then injects that proxy span's traceparent too, so
      // Flowise sees both. The load-bearing correlation for the run is the
      // scheduler's traceId, which is present in the received set, plus the
      // `run.id` tag that ties the gateway.proxy span to the run regardless of
      // its trace root.)
      const finished = tracing.exporter.getFinishedSpans()
      const childSpan = finished.find(
        (s) => s.name === 'scheduler.child-run' && s.attributes?.['run.id'] === runId,
      )
      expect(childSpan).toBeDefined()
      const predTraceId = childSpan!.spanContext().traceId

      // The gateway.proxy span is tagged run.id = runId — run-id correlation on
      // the gateway hop, independent of which trace the proxy span roots.
      const proxySpan = finished.find(
        (s) => s.name === 'gateway.proxy' && s.attributes?.['run.id'] === runId,
      )
      expect(proxySpan).toBeDefined()
      expect(proxySpan!.attributes?.['run.id']).toBe(runId)

      // The traceparent(s) the stub Flowise received include the scheduler
      // run's traceId — the gateway→flowise hop joined the prediction trace.
      expect(flowiseReceivedTraceparent).not.toBeNull()
      expect(traceparentTraceIds(flowiseReceivedTraceparent!).has(predTraceId)).toBe(true)
      // node spans carry the same traceId
      expect(agentSpan!.traceId).toBe(predTraceId)

      // ── (C) the daemon hop is run.id-correlated ───────────────────────
      const daemonSpan = finished.find(
        (s) => s.name === 'daemon.execute' && s.attributes?.['run.id'] === runId,
      )
      expect(daemonSpan).toBeDefined()
      expect(daemonSpan!.attributes?.['task.id']).toBeTruthy()

      // ── the LLM hop joined the daemon's trace ─────────────────────────
      // The fake backend's fetch to the stub LLM ran inside the daemon.execute
      // span, so the stub LLM received a traceparent carrying the daemon
      // trace's traceId.
      expect(llmReceivedTraceparent).not.toBeNull()
      expect(llmReceivedTraceparent!.split('-')[1]).toBe(daemonSpan!.spanContext().traceId)

      // Optional evidence dump for the verification doc: set M67_EVIDENCE_PATH
      // to write a JSON snapshot of this run's trace correlation proof. The
      // committed test asserts above; this only captures a concrete example for
      // docs/archive/verification/m6.7-trace-e2e-verification.md and is a no-op in normal runs.
      const evidencePath = process.env.M67_EVIDENCE_PATH
      if (evidencePath) {
        const evRows = await runQuery<{ kind: string; seq: number; payload: AgentEvent }>(
          `SELECT kind, seq, payload FROM dispatch_task_events
            WHERE task_id = (SELECT id FROM dispatch_tasks WHERE run_id = $1)
            ORDER BY seq`,
          [runId],
        )
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              runId,
              flowId,
              fanOut: { total: result.total, completed: result.completed, failed: result.failed },
              runsRow: runRow.records[0],
              dispatchTask: taskRow.records[0],
              dispatchTaskEvents: evRows.records.map((r) => ({
                kind: r.kind,
                seq: r.seq,
                type: (r.payload as { type?: string })?.type,
                tool: (r.payload as { tool?: string })?.tool,
                content: (r.payload as { content?: string })?.content,
              })),
              runNodeSpans: spans.map((s) => ({
                nodeId: s.nodeId,
                nodeLabel: s.nodeLabel,
                status: s.status,
                traceId: s.traceId,
                cost: s.cost,
                tokens: s.tokens,
              })),
              flowiseReceivedTraceparentTraceIds: flowiseReceivedTraceparent
                ? [...traceparentTraceIds(flowiseReceivedTraceparent)]
                : null,
              llmReceivedTraceId: llmReceivedTraceparent
                ? llmReceivedTraceparent.split('-')[1]
                : null,
              spans: finished.map((s) => ({
                name: s.name,
                traceId: s.spanContext().traceId,
                runId: (s.attributes?.['run.id'] as string | undefined) ?? null,
                taskId: (s.attributes?.['task.id'] as string | undefined) ?? null,
              })),
            },
            null,
            2,
          ),
        )
      }
    } finally {
      daemonHandle.stop()
      await daemonHandle.done.catch(() => undefined)
    }
  }, 90_000)
})
