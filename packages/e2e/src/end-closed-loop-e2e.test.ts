import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { context } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

import { AppDataSource, runQuery } from '@mil/db'
import { createRedis, createTestTracing } from '@mil/shared'
import type { RedisClient } from '@mil/shared'
import { runDaemon } from '@mil/daemon'
import type {
  AgentBackend,
  AgentEvent,
  AgentResult,
  AgentSession,
  ExecOptions,
} from '@mil/contracts'

// Real app source — imported by relative path so vitest transforms the TS in
// place (same convention as m6.7-trace-e2e.test.ts). We deliberately import
// `app.ts` (which does NOT call `serve()`), never `index.ts`.
import { app as gatewayApp } from '../../../apps/gateway/src/app.js'
import {
  app as dispatchApp,
  bootstrap as dispatchBootstrap,
} from '../../../apps/dispatch/src/app.js'
import { fanOut } from '../../../apps/scheduler/src/fanout.js'
import { createRedisSemaphore } from '../../../apps/scheduler/src/semaphore.js'
import { createFlowisePredictionClient } from '../../../apps/scheduler/src/prediction-client.js'
import { createReproClient } from '../../../apps/scheduler/src/repro-client.js'
import { reproduceRun } from '../../../apps/scheduler/src/reproduce.js'
import { listRunNodeSpans } from '../../../apps/scheduler/src/run-node-spans.js'
import { createMemoryArtifactStore } from '../../../apps/scheduler/src/__tests__/mem-artifact-store.js'

/**
 * END — MVP full closed-loop (plan §Task END / issue MZW-281).
 *
 * 跑通论文复现场景: 定义 agent → 编排 flow → 批量 → 监控 → 复现. One test drives
 * a 2-paper batch through the full chain in ONE process and asserts each stage's
 * acceptance, end-to-end, with the HITL (human-in-the-loop) gate marked explicitly
 * — the closed loop the MVP plan names as its收尾 milestone.
 *
 * ## What "closed loop" means here
 *
 * The five stages the acceptance names are the same five the M0–M6 milestone code
 * already implements, never before wired into one scenario. This suite is the
 * integration that proves they compose:
 *
 *   1. 定义 agent   — seed an `agent_daemons` row (a registered claude daemon) the
 *                     batch's flow will dispatch to. The "agent definition" surface.
 *   2. 编排 flow    — a stub Flowise agentflow (Tool Agent + DispatchInvoke node)
 *                     that enqueues a dispatch task per prediction, polls it to
 *                     terminal, and returns per-node `agentFlowExecutedData`. This
 *                     is the same stub shape M6.7 uses; the batch just feeds it
 *                     two papers instead of one.
 *   3. 批量          — scheduler `fanOut` with TWO inputs (1 parent + 2 children),
 *                     executed concurrently under the semaphore. This is the
 *                     "批量" the M3.2 fan-out was built for (architecture v0.2
 *                     §6.5: "run N papers through a flow").
 *   4. 监控          — the parent's `output` aggregate + `run_node_spans` (≥1 node
 *                     per child) + `audit_log` version-lock row are all readable
 *                     back, so an operator can monitor batch progress + per-node
 *                     state. Node-level trace = the M6.4/M6.7 monitoring surface.
 *   5. 复现          — `reproduceRun` on one completed child: same hash + same
 *                     input re-run → structural compare → match. The reproduce
 *                     contract (M4.3) closes the loop: the same flow + same input
 *                     reproduces a comparable result.
 *
 * ## HITL 兜底 (human-in-the-loop fallback)
 *
 * The acceptance says "1 篇论文复现 e2e (HITL 兜底)". The HITL gate is the
 * product-manager + project-architect **双签** the issue requires — a human
 * sign-off, not an automated assertion. This suite automates everything up to
 * that gate and records it; the双签 happens on the issue (the code-reviewer
 * adversarial pass + the human reporter's approval), which is the HITL the
 * acceptance names. The suite does NOT attempt to simulate the human — it
 * proves the loop is *ready* for sign-off.
 *
 * ## Faithful to M6.7's real-`serve()` posture
 *
 * Same reason as M6.7: the W3C `traceparent` the undici auto-instrumentation
 * injects is only extracted on the receiving hop through a real `node:http`
 * server. So dispatch + gateway boot on ephemeral ports via `@hono/node-server`'s
 * `serve()`, the stub Flowise + stub LLM are real `node:http` servers, and the
 * daemon is the real `runDaemon` with a fake claude backend (which dials the stub
 * LLM through the gateway's `/api/v1/llm` passthrough — the "claude adapter →
 * LLM" hop joining the daemon's trace, same as M6.7).
 *
 * ## Why a 2-paper batch, not 1
 *
 * A single-input batch is already covered by M6.7. The END milestone is the
 * "批量" scenario, so this suite feeds TWO inputs and asserts the parent
 * aggregate spans both children — proving fan-out (not just single-run) is part
 * of the closed loop. Reproduce then targets ONE of the two children (the
 * acceptance's "1 篇论文复现"), so the batch is real but the reproduce scope is
 * exactly what the acceptance asks for.
 */

let tracing: ReturnType<typeof createTestTracing>
let redis: RedisClient

// Real servers started for the suite, torn down in afterAll.
let dispatchServer: ReturnType<typeof serve>
let gatewayServer: ReturnType<typeof serve>
let flowiseServer: Server
let llmServer: Server

let dispatchUrl = ''
let gatewayUrl = ''
let agentDaemonId = '' // agent_daemons.id the stub Flowise invokes against

const propagator = new W3CTraceContextPropagator()

// Per-prediction flow JSON the stub Flowise serves for snapshot (M4.2 repro:
// the scheduler self-snapshots the flow once per batch). Keyed by nothing — the
// stub returns the same canonical flow definition for every chatflows GET, so
// the whole batch shares ONE version hash (the repro "snapshot once" contract).
const STUB_FLOW_JSON = {
  id: 'flow-end-e2e',
  name: '论文复现 batch flow',
  // Minimal Flowise chatflow row shape; snapshotPipeline hashes the canonical
  // serialization, so the exact fields don't matter — only that two snapshots
  // of the same content reuse the same hash.
  flowData: { nodes: [{ id: 'start' }, { id: 'agent' }, { id: 'dispatch' }], edges: [] },
}

beforeAll(async () => {
  // OTel FIRST (same ordering invariant as M6.7): register the SDK +
  // auto-instrumentations before any `fetch`, so undici is patched and
  // `traceparent` is injected on every outbound hop.
  tracing = createTestTracing('end-e2e')

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
  // Serves two surfaces the closed loop needs:
  //   - GET /api/v1/chatflows/<id>  → flow definition JSON (repro snapshot)
  //   - POST /api/v1/prediction/<id> (via gateway /flows/<id>/prediction)
  //       → the DispatchInvoke agentflow: enqueue task, poll, return nodes
  flowiseServer = createServer((req, res) => {
    void stubFlowiseHandler(req, res)
  })
  await new Promise<void>((r) => flowiseServer.listen(0, '127.0.0.1', r))
  const flowiseAddr = flowiseServer.address() as AddressInfo
  process.env.FLOWISE_URL = `http://127.0.0.1:${flowiseAddr.port}`
  // The gateway reads these lazily at request time; set before any request.
  process.env.DISPATCH_URL = dispatchUrl
  process.env.SCHEDULER_URL = dispatchUrl
  // The repro flow-fetch goes through the gateway's /api/v1/chatflows/* read
  // proxy, which requires a Flowise API key (the gateway injects it upstream).
  // Set a non-empty key so the proxy does not 503.
  process.env.FLOWISE_API_KEY = 'stub-flowise-key'

  // ── gateway on an ephemeral port ───────────────────────────────────────
  await new Promise<void>((resolve) => {
    gatewayServer = serve({ fetch: gatewayApp.fetch, port: 0 }, (info) => {
      gatewayUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })

  // ── stub LLM / new-api ─────────────────────────────────────────────────
  // The daemon's fake backend dials it through the gateway's /api/v1/llm/*
  // passthrough so the "claude adapter → LLM" hop is a real instrumented fetch.
  llmServer = createServer((_req, res) => {
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

  // ── seed an agent_daemon (define-agent stage) ──────────────────────────
  // Register a daemon so agent_daemons.daemon_id has a valid FK, then seed the
  // agent_daemon row the stub Flowise invokes against. Claim is unauthenticated
  // and not filtered by daemon id (FOR UPDATE SKIP LOCKED on status='queued'),
  // so any online daemon serves any enqueued task — same posture as M6.7.
  const reg = await fetch(`${dispatchUrl}/api/v1/dispatch/daemons/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'end-e2e-fk-daemon',
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
  // Wipe the shared tables so each test starts clean. Order respects FKs.
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM run_node_spans`)
  await AppDataSource.query(`DELETE FROM runs`)
  await AppDataSource.query(`DELETE FROM pipeline_versions`)
  await AppDataSource.query(`DELETE FROM audit_log`)
  await redis.del('sem')
  tracing.exporter.reset()
})

// ── stub Flowise ───────────────────────────────────────────────────────────

/**
 * The stub Flowise handler. Models two surfaces:
 *
 *   GET /api/v1/chatflows/<id> — the flow definition (repro snapshot fetches
 *     this through the gateway's read proxy). Returns the canonical flow JSON
 *     so snapshotPipeline hashes it once for the whole batch.
 *
 *   POST /api/v1/prediction/<id> (reached as gateway /api/v1/flows/<id>/prediction)
 *     — the DispatchInvoke agentflow: on a prediction request it (1) enqueues a
 *     dispatch task via the gateway with the SAME `x-run-id` and the SAME trace
 *     (extracted from the inbound `traceparent`, re-injected on the outbound
 *     invoke fetch — the faithful W3C continuation), (2) polls the task until
 *     terminal, then (3) returns an agentflow prediction response carrying
 *     `agentFlowExecutedData` so the scheduler ingests node spans.
 *
 * The agent's final answer folds the per-paper input back in so the two
 * children produce distinguishable outputs (the reproduce stage asserts on the
 * chosen child's specific output).
 */
async function stubFlowiseHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://stub')

  // Flow definition read (repro snapshot). The gateway forwards Authorization
  // + accept; respond with the canonical flow JSON.
  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/chatflows/')) {
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify(STUB_FLOW_JSON))
    return
  }

  // Prediction (the DispatchInvoke agentflow). Reached as /api/v1/prediction/<id>
  // after the gateway rewrites /flows/<id>/prediction.
  const runId = (req.headers['x-run-id'] as string | undefined) ?? randomUUID()

  // Extract the inbound context (the gateway's traceparent) and continue it on
  // the outbound /dispatch/invoke fetch, so the dispatch hop joins the SAME
  // trace — exactly what a Flowise with OTel instrumentation does.
  const extractedCtx = propagator.extract(context.active(), req.headers, {
    get: (c, k) =>
      (c as Record<string, string | string[]>)[k.toLowerCase()] as string | undefined,
    keys: (c) => Object.keys(c as Record<string, unknown>),
  })

  // Parse the prediction body to fold the per-paper input into the agent's
  // answer, so each child's output is distinguishable (reproduce asserts on it).
  let paperId = 'unknown'
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    paperId = String(body?.question ?? body?.paper ?? body?.paperId ?? 'unknown')
  } catch {
    // Non-JSON / unreadable body — fall back to the default label.
  }
  const output = `reproduced:${paperId}`

  // Enqueue the dispatch task through the gateway (gateway → dispatch), inside
  // the extracted context so the traceparent propagates.
  const invokeRes = await context.with(extractedCtx, async () => {
    return fetch(`${gatewayUrl}/api/v1/dispatch/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': runId },
      body: JSON.stringify({
        agentDaemonId,
        runId,
        prompt: `reproduce paper ${paperId}`,
        execOptions: {},
      }),
    })
  })
  const invokeBody = (await invokeRes.json()) as { data?: { taskId: string } }
  const taskId = invokeBody.data?.taskId

  // Poll the task (through the gateway → dispatch) until terminal, continuing
  // the extracted trace on each poll. The real DispatchInvoke node does this.
  let status = 'queued'
  if (taskId) {
    for (let i = 0; i < 200; i++) {
      await context.with(extractedCtx, async () => {
        const r = await fetch(`${gatewayUrl}/api/v1/dispatch/tasks/${taskId}`, {
          headers: { accept: 'application/json' },
        })
        if (r.ok) {
          const body = (await r.json()) as { data?: { status: string } }
          status = body.data?.status ?? status
        }
      })
      if (status === 'completed' || status === 'failed') break
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // Return an agentflow prediction response carrying the per-node trace, so the
  // scheduler projects it into run_node_spans (the 监控 surface). Three nodes:
  // start + agent (carries usageMetadata) + dispatch.
  //
  // `executionId` / `sessionId` are derived from the INPUT (paperId), NOT the
  // runId, so the response is fully determined by the input — a re-run with the
  // same input (the reproduce stage) yields a structurally identical response,
  // so `compareOutputs` matches. This models a deterministic 论文复现 flow whose
  // comparable output is the reproduced result, not run-id plumbing metadata.
  // (A real Flowise `sessionId` would be the overrideConfig.sessionId = run id;
  // a faithful reproduce of THAT would diverge on `sessionId`. The repro
  // contract compares structural output, so the flow's comparable surface must
  // be input-determined — which is exactly what a reproduction-target flow is.)
  const agentflowOutput = {
    executionId: `exec-${paperId}`,
    sessionId: `paper-${paperId}`,
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
 * A fake `AgentBackend` that yields a status + text + tool-use + tool-result
 * event, then a completed `AgentResult` with per-model usage. To model the
 * "claude adapter → LLM" hop as a real instrumented fetch (so it joins the
 * daemon's trace), the backend POSTs the gateway's `/api/v1/llm/chat/completions`
 * passthrough — the same surface the real claude CLI would hit via
 * `ANTHROPIC_BASE_URL`. (Identical to M6.7's fake backend.)
 */
function fakeClaudeBackend(llmUrl: string): (t: string) => AgentBackend {
  return () => ({
    execute(_prompt: string, _opts: ExecOptions): AgentSession {
      const events: AgentEvent[] = [
        { type: 'status', status: 'started', sessionId: 'sess-end-e2e' },
        { type: 'text', content: 'reproducing paper' },
        { type: 'tool-use', tool: 'Bash', callId: 'call-1', input: { cmd: 'ls' } },
        { type: 'tool-result', tool: '', callId: 'call-1', output: 'paper.pdf' },
      ]
      const gen = (async function* (): AsyncGenerator<AgentEvent> {
        // The LLM hop: a real instrumented fetch, inside the daemon.execute
        // span context so the stub LLM receives a traceparent sharing the
        // daemon's traceId.
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
        output: 'paper.pdf',
        durationMs: 5,
        sessionId: 'sess-end-e2e',
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

describe('END — MVP full closed-loop (define agent → flow → batch → monitor → reproduce)', () => {
  it('runs a 2-paper batch through the full chain and reproduces one paper end-to-end', async () => {
    // A real daemon pointed at the real dispatch URL, with the fake claude
    // backend (which dials the stub LLM). Polls fast so claimed tasks are
    // picked up promptly. One daemon serves both children's tasks (claim is
    // not filtered by daemon id) — the batch is concurrent, not serialized.
    const llmUrl = process.env.NEWAPI_BASE_URL!
    const daemonHandle = runDaemon({
      serverUrl: dispatchUrl,
      label: 'end-e2e-daemon',
      agentType: 'claude',
      backendFactory: fakeClaudeBackend(llmUrl),
      pollIntervalMs: 15,
      heartbeatIntervalMs: 1000,
    })

    try {
      // ── stage 1: 定义 agent ───────────────────────────────────────────
      // (Seeded in beforeAll.) Assert the agent_daemon row the batch will
      // dispatch to exists + is the one the stub Flowise invokes against.
      const adRow = await runQuery<{ id: string; kind: string }>(
        `SELECT id, kind FROM agent_daemons WHERE id = $1`,
        [agentDaemonId],
      )
      expect(adRow.records[0]?.id).toBe(agentDaemonId)
      expect(adRow.records[0]?.kind).toBe('claude')

      // ── stages 2 + 3: 编排 flow + 批量 ────────────────────────────────
      // fanOut with TWO paper inputs (the 批量 scenario). The repro client is
      // wired so the scheduler self-snapshots the flow once (M4.2) and binds
      // parent + every child to that version — the repro prerequisite the
      // reproduce stage needs. The flowId is UUID-shaped (the gateway's flow
      // proxy rewrites <uuid>/prediction → Flowise /api/v1/prediction/<uuid>).
      const sem = createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' })
      const prediction = createFlowisePredictionClient({ gatewayUrl })
      const artifactStore = createMemoryArtifactStore()
      const repro = createReproClient({ gatewayUrl, artifactStore })
      const flowId = randomUUID()

      const result = await fanOut(
        {
          flowId,
          pipelineId: flowId,
          identifier: 'end-e2e-batch',
          inputs: [
            { body: { question: 'paper-A' }, label: 'paper-A' },
            { body: { question: 'paper-B' }, label: 'paper-B' },
          ],
        },
        { prediction, semaphore: sem, repro },
      )

      // ── batch acceptance ─────────────────────────────────────────────
      expect(result.total).toBe(2)
      expect(result.completed).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.children).toHaveLength(2)

      // Every child completed; each child's output is the stub Flowise
      // agentflow prediction response (an object carrying
      // `agentFlowExecutedData`). The per-paper answer the stub folded in
      // lands on the Agent node's `output.content` — assert it there, since
      // that is the authoritative per-paper result the flow produced.
      expect(result.children).toHaveLength(2)
      const childAnswers = result.children.map((c) => {
        const data = (c.output as { agentFlowExecutedData?: Array<{ nodeId?: string; data?: { output?: { content?: string } } }> })
          ?.agentFlowExecutedData
        const agent = data?.find((n) => n.nodeId === 'agent')
        return agent?.data?.output?.content ?? null
      })
      expect(childAnswers).toContain('reproduced:paper-A')
      expect(childAnswers).toContain('reproduced:paper-B')

      // ── stage 4: 监控 (batch aggregate + node spans + audit) ─────────
      // The parent's output is the aggregate (M3.2): both children, completed.
      const parentRow = await runQuery<{ status: string; output: unknown }>(
        `SELECT status, output FROM runs WHERE id = $1`,
        [result.parentRunId],
      )
      expect(parentRow.records[0]?.status).toBe('completed')
      const aggregate = parentRow.records[0]?.output as {
        total: number
        completed: number
        failed: number
        children: Array<{ id: string; status: string }>
      }
      expect(aggregate.total).toBe(2)
      expect(aggregate.completed).toBe(2)
      expect(aggregate.children).toHaveLength(2)

      // Each child has node-level spans (≥3: start + agent + dispatch) — the
      // per-node monitoring surface (M6.4). Collect them across both children.
      const childIds = result.children.map((c) => c.runId)
      const allSpans: Awaited<ReturnType<typeof listRunNodeSpans>> = []
      for (const id of childIds) allSpans.push(...(await listRunNodeSpans(id)))
      expect(allSpans.length).toBeGreaterThanOrEqual(6) // ≥3 nodes × 2 children
      const agentSpans = allSpans.filter((s) => s.nodeId === 'agent')
      expect(agentSpans).toHaveLength(2)
      for (const s of agentSpans) {
        expect(s.traceId).toBeTruthy()
        expect(Number(s.cost)).toBe(0.0123)
      }

      // The version-lock audit row landed (M6.6): the batch's self-snapshot
      // wrote one audit_log row tied to the parent run.
      const auditRow = await runQuery<{ action: string; run_id: string | null }>(
        `SELECT action, run_id FROM audit_log WHERE action = 'pipeline_version.lock'`,
      )
      expect(auditRow.records[0]?.action).toBe('pipeline_version.lock')
      expect(auditRow.records[0]?.run_id).toBe(result.parentRunId)

      // Every child is bound to the same pipeline_version_hash (repro
      // prerequisite) — the snapshot-once contract.
      const hashRows = await runQuery<{
        hash: string | null
      }>(`SELECT pipeline_version_hash AS hash FROM runs WHERE id = ANY($1)`, [
        childIds,
      ])
      const hashes = new Set(hashRows.records.map((r) => r.hash))
      expect(hashes.size).toBe(1)
      expect([...hashes][0]).toBeTruthy()
      const versionHash = [...hashes][0]!

      // ── stage 5: 复现 (one paper, e2e) ───────────────────────────────
      // Reproduce ONE child (the acceptance's "1 篇论文复现"). Same hash +
      // same input re-run → structural compare → match (the reproduce
      // contract, M4.3). The re-run re-predicts against the same flow + same
      // input, so the stub Flowise returns a structurally identical response
      // and `compareOutputs` matches.
      const sourceChild = result.children[0]!
      const report = await reproduceRun(sourceChild.runId, {
        prediction,
        semaphore: sem,
        repro,
        artifactStore,
      })

      expect(report.sourceRunId).toBe(sourceChild.runId)
      expect(report.rerunRunId).not.toBe(sourceChild.runId)
      expect(report.status).toBe('completed')
      expect(report.match).toBe(true)
      expect(report.diff).toBeNull()
      expect(report.versionHash).toBe(versionHash)
      // The re-run's output is structurally equal to the source's (same
      // input-determined stub response). compareOutputs is canonical, so the
      // match holds even if object key order differs.
      expect(report.output).toEqual(sourceChild.output)
      expect(report.expected).toEqual(sourceChild.output)

      // The re-run row shares the source's comparable identity + provenance
      // (created_by_run_id = source) — "可追溯" (traceable).
      const rerunRow = await runQuery<{
        status: string
        pipeline_version_hash: string | null
        created_by_run_id: string | null
      }>(
        `SELECT status, pipeline_version_hash, created_by_run_id
           FROM runs WHERE id = $1`,
        [report.rerunRunId],
      )
      const rr = rerunRow.records[0]
      expect(rr?.status).toBe('completed')
      expect(rr?.pipeline_version_hash).toBe(versionHash)
      expect(rr?.created_by_run_id).toBe(sourceChild.runId)

      // Optional evidence dump for the verification doc: set END_EVIDENCE_PATH
      // to write a JSON snapshot of this run's closed-loop proof. The committed
      // test asserts above; this only captures a concrete example for
      // docs/mvp-closed-loop-verification.md and is a no-op in normal runs.
      const evidencePath = process.env.END_EVIDENCE_PATH
      if (evidencePath) {
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              flowId,
              agentDaemonId,
              fanOut: {
                parentRunId: result.parentRunId,
                total: result.total,
                completed: result.completed,
                failed: result.failed,
                children: result.children.map((c) => ({
                  runId: c.runId,
                  status: c.status,
                  output: c.output,
                })),
              },
              parentAggregate: aggregate,
              nodeSpans: allSpans.map((s) => ({
                runId: s.runId,
                nodeId: s.nodeId,
                status: s.status,
                traceId: s.traceId,
                cost: s.cost,
              })),
              auditLock: auditRow.records[0],
              versionHash,
              reproduce: {
                sourceRunId: report.sourceRunId,
                rerunRunId: report.rerunRunId,
                status: report.status,
                match: report.match,
                diff: report.diff,
                versionHash: report.versionHash,
                output: report.output,
                expected: report.expected,
                artifactUri: report.artifactUri,
              },
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
  }, 120_000)
})
