import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { AppDataSource, runQuery } from '@mil/db'
import type { ArtifactStore } from '@mil/repro'
import { createLogger } from '@mil/shared'
import { fanOut } from './fanout.js'
import type { PredictionClient } from './prediction-client.js'
import { reproduceRun, ReproError } from './reproduce.js'
import type { ReproClient } from './repro-client.js'
import { rerunRun, RerunError } from './rerun.js'
import type { Semaphore } from './semaphore.js'
import { availableSlots } from './semaphore.js'
import { listRunNodeSpans } from './run-node-spans.js'
import type { Worker } from './worker.js'

/**
 * Scheduler HTTP surface (M3.2 + M3.1 health).
 *
 * Exposes fan-out as `POST /api/v1/scheduler/runs/fanout`: a caller posts a
 * batch of inputs + a flow id, and the scheduler creates the parent run, fans
 * out N children under the concurrency gate, and returns the aggregate.
 *
 * `GET /health` reports the worker's run-state and the semaphore's available
 * slot count, so an operator can see the consumer loop is live and how much
 * concurrency headroom remains.
 *
 * `app` is exported separately from the `serve()` entry so tests drive it via
 * `app.request()` without binding a port, mirroring dispatch/gateway. The
 * `prediction` + `semaphore` deps are injected through `buildApp` so tests can
 * swap in stubs; `index.ts` wires the real Redis semaphore + gateway
 * prediction client.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

const log = createLogger({ svc: 'scheduler' })

/** Standard envelope helpers (same shape as dispatch/gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const fanOutBodySchema = z.object({
  flowId: z.string().min(1),
  pipelineId: z.string().min(1),
  identifier: z.string().min(1).max(256),
  inputs: z
    .array(
      z.object({
        body: z.unknown(),
        label: z.string().max(256).optional(),
      }),
    )
    // `.min(1)` rejects empty batches; `.max()` caps unbounded fan-out: a huge
    // payload would fan into one createRun per input (Promise.all, not batched)
    // and one runs row each, with maxConcurrent gating only the Prediction hop,
    // not the bookkeeping. 1000 matches a realistic large batch without making
    // a single request unbounded.
    .min(1, 'inputs must be non-empty')
    .max(1000, 'inputs must be at most 1000'),
  workspaceId: z.string().max(128).nullable().optional(),
  pipelineVersionHash: z.string().length(64).nullable().optional(),
  createdByUserId: z.string().uuid().nullable().optional(),
})

export interface AppDeps {
  prediction: PredictionClient
  semaphore: Semaphore
  /**
   * Optional repro integration (M4.2): threaded into `fanOut` + `rerunRun` so
   * the HTTP paths snapshot/bind/archive the same way the worker does. Absent
   * → fan-out / rerun keep their M3.2/M3.4 behavior (no repro), so tests that
   * don't exercise repro skip it.
   */
  repro?: ReproClient
  /**
   * The cap `semaphore` was constructed with. `/health` reports
   * `availableSlots` = `maxConcurrent - held`, so the cap must be known here
   * (the `Semaphore` interface intentionally does not expose it).
   */
  maxConcurrent: number
  /**
   * Optional: the queue-consumer worker (M3.1). Present in production
   * (`index.ts` starts it) and in worker integration tests; absent when a test
   * only exercises the fan-out HTTP path. `/health` reads `worker.isRunning()`,
   * so omitting it just reports `running: false`.
   */
  worker?: Pick<Worker, 'isRunning'>
  /**
   * Optional artifact store for the reproduce route (M4.3). When supplied, a
   * reproduce run archives its JSON comparison report as the re-run row's
   * `artifact_uri`; when omitted the comparison is still returned, just not
   * persisted. Production reuses the M4.2 artifact store (`createArtifactStoreFromEnv`); tests inject an
   * in-memory stub (or omit it).
   */
  artifactStore?: ArtifactStore
}

/**
 * Build the Hono app with injected deps. Production wires this in `index.ts`;
 * tests pass stubs. Keeping construction in a factory (rather than module-level
 * singletons) means each test gets an isolated app + dep set with no shared
 * mutable state between files.
 */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const slots = await availableSlots(deps.semaphore, deps.maxConcurrent).catch(() => null)
    return c.json({
      ok: true,
      svc: 'scheduler',
      db: AppDataSource.isInitialized,
      running: deps.worker?.isRunning() ?? false,
      availableSlots: slots,
    })
  })

  app.post('/api/v1/scheduler/runs/fanout', async (c) => {
    let parsed: z.infer<typeof fanOutBodySchema>
    try {
      parsed = fanOutBodySchema.parse(await c.req.json())
    } catch (err) {
      return fail(c, 400, 'invalid fanout body', { detail: String(err) })
    }

    try {
      const result = await fanOut(
        {
          flowId: parsed.flowId,
          inputs: parsed.inputs,
          pipelineId: parsed.pipelineId,
          identifier: parsed.identifier,
          workspaceId: parsed.workspaceId ?? null,
          pipelineVersionHash: parsed.pipelineVersionHash ?? null,
          createdByUserId: parsed.createdByUserId ?? null,
        },
        { prediction: deps.prediction, semaphore: deps.semaphore, repro: deps.repro },
      )
      return ok(c, result)
    } catch (err) {
      // A row-creation failure (DB down, CHECK violation) means the batch could
      // not be recorded at all — surface as 502 rather than a half-recorded
      // 200. Per-child prediction failures are NOT thrown here; they are
      // captured as `failed` children inside `fanOut` and the request still
      // succeeds with the aggregate.
      log.error('fanout failed', { error: String(err) })
      return fail(c, 502, 'fanout failed', { detail: String(err) })
    }
  })

  app.post('/api/v1/scheduler/runs/:runId/rerun', async (c) => {
    const runId = c.req.param('runId')
    // Path-level UUID guard: a non-uuid runId can't match any row, so reject
    // early with 400 rather than hitting the DB and 404-ing on a malformed key.
    if (!UUID_RE.test(runId)) {
      return fail(c, 400, 'invalid runId', { detail: 'runId must be a uuid' })
    }

    try {
      const result = await rerunRun(runId, {
        prediction: deps.prediction,
        semaphore: deps.semaphore,
        repro: deps.repro,
      })
      return ok(c, result)
    } catch (err) {
      // Domain guards map to client-visible statuses; anything else is an
      // infrastructure failure (DB write) → 502, matching the fan-out route.
      if (err instanceof RerunError) {
        const status = err.code === 'not_found' ? 404 : 409
        return fail(c, status, err.message, { code: err.code })
      }
      log.error('rerun failed', { runId, error: String(err) })
      return fail(c, 502, 'rerun failed', { detail: String(err) })
    }
  })

  app.post('/api/v1/scheduler/runs/:runId/reproduce', async (c) => {
    const runId = c.req.param('runId')
    // Same UUID guard as rerun: a non-uuid runId can't match any row.
    if (!UUID_RE.test(runId)) {
      return fail(c, 400, 'invalid runId', { detail: 'runId must be a uuid' })
    }

    try {
      const result = await reproduceRun(runId, deps)
      return ok(c, result)
    } catch (err) {
      // Domain guards map to client-visible statuses; infrastructure failure → 502.
      if (err instanceof ReproError) {
        const status = reproErrorStatus(err.code)
        return fail(c, status, err.message, { code: err.code })
      }
      log.error('reproduce failed', { runId, error: String(err) })
      return fail(c, 502, 'reproduce failed', { detail: String(err) })
    }
  })

  /**
   * `GET /api/v1/scheduler/runs/:runId/node-spans` — a run's node-level trace
   * (plan M6.4 / P1.11.T5): the "节点级状态可查" acceptance gate.
   *
   * Returns the run's `run_node_spans` rows — one per DAG node the Flowise
   * agentflow executed, with status + timing + token/cost + error + the OTel
   * traceId (M6.1) for end-to-end correlation. The console AgentFlows browse
   * page reads this to render the node inspector without re-reading Flowise's
   * live `executionData` on every render.
   *
   * `runId` is a UUID; we validate the shape (400) so a mistyped id is a clean
   * client error rather than a 404 that looks like "run exists but has no
   * spans". 200 + empty `spans` when the run has no node trace yet (a
   * non-agentflow run, or a run whose prediction hasn't been recorded by
   * Flowise); 404 when the run id matches no `runs` row.
   */
  app.get('/api/v1/scheduler/runs/:runId/node-spans', async (c) => {
    const runId = c.req.param('runId')
    if (!UUID_RE.test(runId)) {
      return fail(c, 400, 'invalid runId', { detail: 'runId must be a uuid' })
    }

    // Existence check so a non-existent run is a 404, distinct from "run with
    // no spans" (200 + empty array) — mirrors the dispatch `/usage/by-agent`
    // route's posture.
    const { records: exist } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE id = $1`,
      [runId],
    )
    if (!exist[0]) return fail(c, 404, 'run not found', { runId })

    const spans = await listRunNodeSpans(runId)
    return ok(c, { runId, spans })
  })

  return app
}

/**
 * Map a `ReproError` code to an HTTP status (mirrors rerun's convention):
 * `not_found` → 404, `in_flight` → 409, the preconditions (`not_completed`,
 * `unbound`) → 422. Kept as a helper so the route body stays flat and the
 * mapping is grep-able in one place.
 */
function reproErrorStatus(code: 'not_found' | 'in_flight' | 'not_completed' | 'unbound'): ContentfulStatusCode {
  if (code === 'not_found') return 404
  if (code === 'in_flight') return 409
  return 422
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
