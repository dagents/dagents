import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app, bootstrap } from '../app.js'
import { AppDataSource } from '@dagents/db'
import { aggregateUsage } from '../runs-usage.js'
import { windowSince, FLEET_WINDOW_HOURS } from '../fleet-stats.js'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for the fleet resource-dashboard aggregation API
 * (plan M6.5 / P1.11.T6).
 *
 * Drives the Hono app in-process via `app.request()` against the real dagents
 * Postgres (docker-compose stack on 127.0.0.1:15432). Each test seeds daemons /
 * agent_daemons / runs (with `agent_daemon_calls` + `cost`) then exercises
 * `GET /api/v1/dispatch/fleet-stats` — the "资源看板数据聚合" acceptance gate.
 *
 * Coverage:
 * - status distribution: daemon statuses + agent kinds + task lifecycle states
 * - 24h throughput: terminal tasks + terminal runs counted in-window
 * - region grouping: agents + run-cost rolled up by capability_descriptor->>'region'
 * - cost rollup: total + last-24h runs.cost sum
 * - per-model token rollup over every run's agent_daemon_calls
 * - empty fleet → zeroed counts (valid payload, not an error)
 * - windowHours query param clamping
 * - aggregateUsage (pure, shared with runs-usage) sums tokens across runs + models
 *
 * `fileParallelism: false` (vitest.config.ts) — shares tables with the other
 * DB-backed dispatch files, so it must run serially.
 */

let daemonId: string
let agentDaemonId: string

beforeAll(async () => {
  await bootstrap()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // wipe dispatch + runs state, then seed a daemon / agent_daemon row.
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM runs`)
  await AppDataSource.query(`DELETE FROM agent_daemons`)
  await AppDataSource.query(`DELETE FROM daemons`)

  const daemon = await app.request('/api/v1/dispatch/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'fleet-daemon',
      capabilities: [{ agentType: 'claude', tags: ['gpu'] }],
    }),
  })
  daemonId = ((await daemon.json()) as { data: { daemonId: string } }).data.daemonId

  const adRows = await AppDataSource.query(
    `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path, capability_descriptor)
     VALUES ('claude-code', 'claude', $1, 'claude', $2) RETURNING id`,
    [daemonId, JSON.stringify({ region: 'us-east' })],
  )
  agentDaemonId = adRows[0].id
})

/** Insert a run row with given status / cost / finished_at + agent_daemon_calls. */
async function seedRun(opts: {
  status?: string
  cost?: string
  finishedAt?: Date
  calls?: unknown[]
}): Promise<string> {
  const id = randomUUID()
  await AppDataSource.query(
    `INSERT INTO runs (id, identifier, pipeline_id, status, cost, finished_at, agent_daemon_calls)
     VALUES ($1, $2, 'flow-1', $3, $4, $5, $6)`,
    [
      id,
      id,
      opts.status ?? 'completed',
      opts.cost ?? '0',
      opts.finishedAt ?? null,
      JSON.stringify(opts.calls ?? []),
    ],
  )
  return id
}

/** Insert a terminal dispatch_task tied to the seeded agent + a run. */
async function seedTask(opts: {
  status: string
  finishedAt: Date
  runId: string
}): Promise<string> {
  const id = randomUUID()
  await AppDataSource.query(
    `INSERT INTO dispatch_tasks
       (id, agent_daemon_id, run_id, prompt, exec_options, status, finished_at, created_at)
     VALUES ($1, $2, $3, 'p', '{}'::jsonb, $4, $5, NOW())`,
    [id, agentDaemonId, opts.runId, opts.status, opts.finishedAt],
  )
  return id
}

describe('GET /api/v1/dispatch/fleet-stats — status distribution', () => {
  it('counts daemons by status, agents by kind, tasks by lifecycle', async () => {
    // a second daemon in a different status + a second agent kind
    await AppDataSource.query(
      `UPDATE daemons SET status = 'draining' WHERE id = $1`,
      [daemonId],
    )
    const d2 = await app.request('/api/v1/dispatch/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        daemonLabel: 'd2',
        capabilities: [{ agentType: 'codex' }],
      }),
    })
    const d2Id = ((await d2.json()) as { data: { daemonId: string } }).data.daemonId
    await AppDataSource.query(
      `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path)
       VALUES ('codex-cli', 'codex', $1, 'codex')`,
      [d2Id],
    )
    // one queued + one completed task
    const runId = await seedRun({})
    await seedTask({ status: 'completed', finishedAt: new Date(), runId })
    await AppDataSource.query(
      `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, exec_options, status, created_at)
       VALUES ($1, $2, $3, 'q', '{}'::jsonb, 'queued', NOW())`,
      [randomUUID(), agentDaemonId, runId],
    )

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        fleet: {
          daemons: { byStatus: Record<string, number>; total: number }
          agents: { total: number; byKind: Record<string, number> }
          tasks: { byStatus: Record<string, number>; total: number }
        }
      }
    }
    // 2 daemons: 1 draining, 1 online
    expect(body.data.fleet.daemons.total).toBe(2)
    expect(body.data.fleet.daemons.byStatus.draining).toBe(1)
    expect(body.data.fleet.daemons.byStatus.online).toBe(1)
    // 2 agents: 1 claude, 1 codex
    expect(body.data.fleet.agents.total).toBe(2)
    expect(body.data.fleet.agents.byKind.claude).toBe(1)
    expect(body.data.fleet.agents.byKind.codex).toBe(1)
    // 2 tasks: 1 completed, 1 queued
    expect(body.data.fleet.tasks.total).toBe(2)
    expect(body.data.fleet.tasks.byStatus.completed).toBe(1)
    expect(body.data.fleet.tasks.byStatus.queued).toBe(1)
  })

  it('returns zeroed counts for an empty fleet', async () => {
    // beforeEach already wiped; drop the seeded daemon/agent too
    await AppDataSource.query(`DELETE FROM agent_daemons`)
    await AppDataSource.query(`DELETE FROM daemons`)

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        fleet: {
          daemons: { byStatus: Record<string, number>; total: number }
          agents: { total: number; byKind: Record<string, number> }
          tasks: { byStatus: Record<string, number>; total: number }
        }
        cost: { totalCost: string; last24hCost: string; runsCounted: number }
        usage: { byModel: Record<string, unknown>; totalCalls: number; truncated: boolean }
        throughput: { tasks: { total: number }; runs: { total: number } }
        regions: unknown[]
      }
    }
    expect(body.data.fleet.daemons.total).toBe(0)
    expect(body.data.fleet.agents.total).toBe(0)
    expect(body.data.fleet.tasks.total).toBe(0)
    expect(body.data.cost.totalCost).toBe('0.000000')
    expect(body.data.usage.totalCalls).toBe(0)
    expect(body.data.usage.truncated).toBe(false)
    expect(body.data.throughput.tasks.total).toBe(0)
    expect(body.data.throughput.runs.total).toBe(0)
    expect(body.data.regions).toEqual([])
  })
})

describe('GET /api/v1/dispatch/fleet-stats — throughput (24h)', () => {
  it('counts terminal tasks + runs finished in the last 24h', async () => {
    const runId = await seedRun({ finishedAt: new Date() })
    await seedTask({ status: 'completed', finishedAt: new Date(), runId })
    await seedTask({ status: 'failed', finishedAt: new Date(), runId })

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        throughput: {
          since: string
          tasks: { completed: number; failed: number; total: number }
          runs: { completed: number; failed: number; total: number }
        }
      }
    }
    expect(body.data.throughput.tasks.total).toBe(2)
    expect(body.data.throughput.tasks.completed).toBe(1)
    expect(body.data.throughput.tasks.failed).toBe(1)
    expect(body.data.throughput.runs.total).toBe(1)
    expect(body.data.throughput.runs.completed).toBe(1)
  })

  it('excludes runs/tasks finished outside the window', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    const runId = await seedRun({ finishedAt: old })
    await seedTask({ status: 'completed', finishedAt: old, runId })

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { throughput: { tasks: { total: number }; runs: { total: number } } }
    }
    expect(body.data.throughput.tasks.total).toBe(0)
    expect(body.data.throughput.runs.total).toBe(0)
  })

  it('honours a custom windowHours query param', async () => {
    const runId = await seedRun({ finishedAt: new Date() })
    await seedTask({ status: 'completed', finishedAt: new Date(), runId })

    const res = await app.request('/api/v1/dispatch/fleet-stats?windowHours=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { windowHours: number; throughput: { tasks: { total: number }; runs: { total: number } } }
    }
    expect(body.data.windowHours).toBe(1)
    expect(body.data.throughput.tasks.total).toBe(1)
  })

  it('clamps an out-of-range windowHours to the default', async () => {
    const res = await app.request('/api/v1/dispatch/fleet-stats?windowHours=99999')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { windowHours: number } }
    expect(body.data.windowHours).toBe(FLEET_WINDOW_HOURS)
  })
})

describe('GET /api/v1/dispatch/fleet-stats — region', () => {
  it('groups agents + run-cost by capability_descriptor->>region', async () => {
    // seeded agent is region us-east; add one with no region (→ unknown)
    const runId = await seedRun({
      cost: '1.500000',
      finishedAt: new Date(),
      calls: [{ agentDaemonId }],
    })
    await AppDataSource.query(
      `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path)
       VALUES ('no-region', 'claude', $1, 'claude')`,
      [daemonId],
    )

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { regions: Array<{ region: string; agents: number; runs: number; cost: string }> }
    }
    const byRegion = Object.fromEntries(body.data.regions.map((r) => [r.region, r]))
    expect(byRegion['us-east']).toBeDefined()
    expect(byRegion['us-east'].agents).toBe(1)
    // run calls agentDaemonId which is in us-east → 1 run attributed
    expect(byRegion['us-east'].runs).toBe(1)
    // cost carried through as NUMERIC→string (zero-value is '0.000000', not '0')
    expect(byRegion['us-east'].cost).toBe('1.500000')
    expect(byRegion.unknown).toBeDefined()
    expect(byRegion.unknown.agents).toBe(1)
    // no-region agent never called → 0 runs attributed, zero cost in canonical form
    expect(byRegion.unknown.runs).toBe(0)
    expect(byRegion.unknown.cost).toBe('0.000000')
  })

  it('does not double-count a run cost when it fans out to multiple same-region agents', async () => {
    // seeded agentDaemonId is us-east; add a SECOND us-east agent.
    const secondUs = await AppDataSource.query(
      `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path, capability_descriptor)
       VALUES ('claude-2', 'claude', $1, 'claude', $2) RETURNING id`,
      [daemonId, JSON.stringify({ region: 'us-east' })],
    )
    // one run, cost=10, calls BOTH us-east agents (the fan-out case the runs
    // table is designed for). Buggy LEFT JOIN would attribute cost=20 here.
    await seedRun({
      cost: '10.000000',
      finishedAt: new Date(),
      calls: [
        { agentDaemonId },
        { agentDaemonId: secondUs[0].id },
      ],
    })

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { regions: Array<{ region: string; agents: number; runs: number; cost: string }> }
    }
    const usEast = body.data.regions.find((r) => r.region === 'us-east')
    expect(usEast).toBeDefined()
    expect(usEast!.agents).toBe(2)
    expect(usEast!.runs).toBe(1)
    // the key assertion: cost is attributed once, not doubled to 20.000000
    expect(usEast!.cost).toBe('10.000000')
  })
})

describe('GET /api/v1/dispatch/fleet-stats — cost + usage', () => {
  it('rolls up total + last-24h runs.cost and per-model tokens', async () => {
    await seedRun({
      cost: '2.250000',
      finishedAt: new Date(),
      calls: [
        {
          agentDaemonId,
          status: 'completed',
          usage: { claude: { inputTokens: 10, outputTokens: 5 } },
        },
      ],
    })
    await seedRun({
      cost: '0.750000',
      finishedAt: new Date(),
      calls: [
        {
          agentDaemonId,
          status: 'completed',
          usage: { 'claude-haiku': { inputTokens: 100, outputTokens: 50 } },
        },
      ],
    })

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        cost: { totalCost: string; last24hCost: string; runsCounted: number }
        usage: {
          byModel: Record<string, { inputTokens: number; outputTokens: number; calls: number }>
          totalCalls: number
        }
      }
    }
    // 2.25 + 0.75 = 3.000000 (NUMERIC → string, preserved precision)
    expect(body.data.cost.totalCost).toBe('3.000000')
    expect(body.data.cost.last24hCost).toBe('3.000000')
    expect(body.data.cost.runsCounted).toBe(2)
    expect(body.data.usage.totalCalls).toBe(2)
    expect(body.data.usage.byModel.claude).toMatchObject({ inputTokens: 10, outputTokens: 5, calls: 1 })
    expect(body.data.usage.byModel['claude-haiku']).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      calls: 1,
    })
  })

  it('attributes last-24h cost only to runs finished in the window', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await seedRun({ cost: '5.000000', finishedAt: old })
    await seedRun({ cost: '1.000000', finishedAt: new Date() })

    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { cost: { totalCost: string; last24hCost: string } }
    }
    expect(body.data.cost.totalCost).toBe('6.000000')
    expect(body.data.cost.last24hCost).toBe('1.000000')
  })
})

describe('GET /api/v1/dispatch/fleet-stats — envelope + sources', () => {
  it('returns the standard success envelope with a generatedAt snapshot', async () => {
    const res = await app.request('/api/v1/dispatch/fleet-stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { generatedAt: string; windowSince: string; windowHours: number; sources: { runs: boolean; langfuse: boolean; newApi: boolean } }
    }
    expect(body.success).toBe(true)
    expect(typeof body.data.generatedAt).toBe('string')
    expect(body.data.windowSince).toBeTruthy()
    // runs always present; langfuse/new-api pending the OTel clients work (M6.1)
    expect(body.data.sources.runs).toBe(true)
    expect(body.data.sources.langfuse).toBe(false)
    expect(body.data.sources.newApi).toBe(false)
  })
})

describe('aggregateUsage (pure, shared with runs-usage)', () => {
  it('sums tokens across runs and models, counting calls per model', () => {
    const { byModel, totalCalls } = aggregateUsage([
      { usage: { claude: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } } },
      { usage: { claude: { inputTokens: 20, outputTokens: 15 }, 'claude-haiku': { inputTokens: 100 } } },
      { usage: undefined }, // a failed call with no usage — counts toward totalCalls only
    ])
    expect(totalCalls).toBe(3)
    expect(byModel.claude).toEqual({
      inputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      calls: 2,
    })
    expect(byModel['claude-haiku'].inputTokens).toBe(100)
    expect(byModel['claude-haiku'].calls).toBe(1)
  })

  it('ignores non-object usage entries', () => {
    const { byModel, totalCalls } = aggregateUsage([
      { usage: { claude: 'not-an-object' } },
      { usage: { bad: null } },
    ])
    expect(totalCalls).toBe(2)
    expect(byModel).toEqual({})
  })
})

describe('windowSince (pure)', () => {
  it('returns an ISO timestamp `hours` before the given instant', () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    const since = windowSince(now, 24)
    expect(since).toBe('2026-07-08T12:00:00.000Z')
  })
})
