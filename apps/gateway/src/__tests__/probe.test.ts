import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppDataSource } from '@mil/db'
import { runProbeSweep, startProbeWorker } from '../probe.js'
import { NEWAPI_TOKEN_STATUS } from '../newapi.js'

/**
 * Integration tests for the token health probe worker (M2.8/T8).
 *
 * Stub server emulates new-api `/api/token/:id` admin responses; the sweep
 * reads `token_meta` rows from the real milagents Postgres, probes each, and
 * writes the derived status back. Token_meta is wiped between tests.
 *
 * Coverage:
 * - active token → status='active', last_probed_at set
 * - disabled (new-api status=2) → 'disabled'
 * - expired (re-derived from expired_time) → 'expired'
 * - exhausted (re-derived from remain_quota=0) → 'exhausted'
 * - 429 from new-api → 'rate_limited'
 * - network error / 5xx → 'error'
 * - startProbeWorker is a no-op (stopped handle) when admin key unset
 */

let stubServer: Server
let stubUrl = ''
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void

// per-id stub behavior; tests set this before running the sweep.
let stubByToken: Record<number, StubHandler> = {}

function defaultHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const url = req.url ?? ''
  const m = url.match(/^\/api\/token\/(\d+)$/)
  if (!m) {
    res.writeHead(404)
    res.end('{}')
    return
  }
  const id = Number(m[1])
  const handler = stubByToken[id]
  if (handler) {
    handler(req, res)
    return
  }
  res.setHeader('content-type', 'application/json')
  res.writeHead(200)
  res.end(JSON.stringify({ success: true, data: { id, status: NEWAPI_TOKEN_STATUS.ENABLED, expired_time: -1, remain_quota: 1000, unlimited_quota: false } }))
}

beforeAll(async () => {
  stubServer = createServer((req, res) => defaultHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.NEWAPI_BASE_URL = stubUrl
  process.env.NEWAPI_ADMIN_KEY = 'test-admin-key'
  process.env.NEWAPI_ADMIN_USER_ID = '1'
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  stubByToken = {}
  await AppDataSource.query(`DELETE FROM token_meta`)
})

async function seedToken(id: number, status = 'unknown'): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO token_meta (newapi_token_id, name, "group", status) VALUES ($1, $2, 'default', $3)`,
    [id, `tok-${id}`, status],
  )
}

async function tokenMetaStatus(id: number): Promise<{ status: string; probed: boolean }> {
  const rows = await AppDataSource.query(
    `SELECT status, last_probed_at IS NOT NULL AS probed FROM token_meta WHERE newapi_token_id = $1`,
    [id],
  )
  return { status: rows[0]?.status ?? 'missing', probed: Boolean(rows[0]?.probed) }
}

describe('probe sweep — status mapping', () => {
  it('marks an enabled token active and stamps last_probed_at', async () => {
    await seedToken(101)
    const r = await runProbeSweep()
    expect(r.probed).toBe(1)
    expect(r.ok).toBe(1)
    const meta = await tokenMetaStatus(101)
    expect(meta.status).toBe('active')
    expect(meta.probed).toBe(true)
  })

  it('maps new-api status=2 (disabled) → disabled', async () => {
    await seedToken(102)
    stubByToken[102] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { id: 102, status: NEWAPI_TOKEN_STATUS.DISABLED, expired_time: -1, remain_quota: 1000, unlimited_quota: false } }))
    }
    await runProbeSweep()
    expect((await tokenMetaStatus(102)).status).toBe('disabled')
  })

  it('re-derives expired from a past expired_time even when status=1', async () => {
    await seedToken(103)
    const past = Math.floor(Date.now() / 1000) - 60
    stubByToken[103] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { id: 103, status: NEWAPI_TOKEN_STATUS.ENABLED, expired_time: past, remain_quota: 1000, unlimited_quota: false } }))
    }
    await runProbeSweep()
    expect((await tokenMetaStatus(103)).status).toBe('expired')
  })

  it('re-derives exhausted from remain_quota=0', async () => {
    await seedToken(104)
    stubByToken[104] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { id: 104, status: NEWAPI_TOKEN_STATUS.ENABLED, expired_time: -1, remain_quota: 0, unlimited_quota: false } }))
    }
    await runProbeSweep()
    expect((await tokenMetaStatus(104)).status).toBe('exhausted')
  })

  it('maps a 429 from new-api → rate_limited', async () => {
    await seedToken(105)
    stubByToken[105] = (_req, res) => {
      res.writeHead(429)
      res.end('{}')
    }
    await runProbeSweep()
    expect((await tokenMetaStatus(105)).status).toBe('rate_limited')
  })

  it('maps a 5xx / network error → error', async () => {
    await seedToken(106)
    stubByToken[106] = (_req, res) => {
      res.writeHead(500)
      res.end('{}')
    }
    await runProbeSweep()
    expect((await tokenMetaStatus(106)).status).toBe('error')
  })

  it('processes multiple tokens in one sweep', async () => {
    await seedToken(201)
    await seedToken(202)
    await seedToken(203)
    const past = Math.floor(Date.now() / 1000) - 60
    stubByToken[202] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { id: 202, status: NEWAPI_TOKEN_STATUS.ENABLED, expired_time: past, remain_quota: 100, unlimited_quota: false } }))
    }
    stubByToken[203] = (_req, res) => {
      res.writeHead(429)
      res.end('{}')
    }
    const r = await runProbeSweep()
    expect(r.probed).toBe(3)
    expect((await tokenMetaStatus(201)).status).toBe('active')
    expect((await tokenMetaStatus(202)).status).toBe('expired')
    expect((await tokenMetaStatus(203)).status).toBe('rate_limited')
  })
})

describe('startProbeWorker lifecycle', () => {
  it('is a no-op when NEWAPI_ADMIN_KEY is unset (returns a stoppable handle)', async () => {
    const saved = process.env.NEWAPI_ADMIN_KEY
    delete process.env.NEWAPI_ADMIN_KEY
    try {
      const worker = startProbeWorker(50)
      // no sweep fires — token_meta stays empty
      await seedToken(301)
      await new Promise((r) => setTimeout(r, 120))
      expect((await tokenMetaStatus(301)).status).toBe('unknown')
      worker.stop()
    } finally {
      process.env.NEWAPI_ADMIN_KEY = saved
    }
  })

  it('starts, runs an immediate sweep, and stops cleanly', async () => {
    await seedToken(401)
    const worker = startProbeWorker(60_000)
    // the immediate sweep is async; give it a tick
    await new Promise((r) => setTimeout(r, 150))
    expect((await tokenMetaStatus(401)).status).toBe('active')
    expect(() => worker.stop()).not.toThrow()
  })
})
