import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { AppDataSource, runQuery } from '@mil/db'
import {
  snapshotPipeline,
  bindRunToVersion,
  archiveArtifact,
  reproduce,
  compareOutputs,
  sha256Hex,
  createS3ArtifactStore,
  type ArtifactStore,
  type RunArtifact,
  type FetchFlowOpts,
  type FetchedFlow,
} from '../index.js'

/**
 * Repro integration test (plan M4.1 / spec §1.8 acceptance).
 *
 * Drives the real milagents Postgres (127.0.0.1:15432) + MinIO (127.0.0.1:9000)
 * docker-compose stack. The flow fetcher is a stub (no live Flowise) so the
 * suite asserts the repro contract — snapshot dedup, bind, archive round-trip,
 * structural reproduce — without a live flow engine.
 *
 * Acceptance (issue description):
 *   - 同 flow 二次快照复用 hash        → re-snapshot reuses the version row + hash
 *   - artifact 可存可取                → archive then get returns the same bytes
 *   - 同 hash + 同 input 重跑 + 结构比对 → reproduce compares equal on identical output,
 *                                        diverges on a structural change
 */

// MinIO dev creds. Defaults mirror the production factory
// `apps/scheduler/src/repro-client.ts:createArtifactStoreFromEnv()` so the test
// and prod code agree on the same endpoint URL (`http://localhost:9000`) and
// dev-stack creds — `infra/.env.example` carries the same values. `setup.ts`
// also sets these via `??=` before any test runs, but giving `minioOpts()`
// its own `??` default makes the S3 client construction self-sufficient and
// keeps the test's default aligned with prod's even if `setup.ts` is bypassed.
const minioOpts = () => ({
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'milagents',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'milagents_dev',
  bucket: process.env.MINIO_BUCKET ?? 'milagents',
})

let store: ArtifactStore

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  store = createS3ArtifactStore(minioOpts())
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await runQuery(`DELETE FROM runs`)
  await runQuery(`DELETE FROM pipeline_versions`)
})

/** Build a stub fetchFlow that returns a fixed flow JSON for a flow id. */
function stubFlow(flowJsonByFlowId: Record<string, unknown>) {
  return async (
    flowId: string,
    _opts: FetchFlowOpts,
  ): Promise<FetchedFlow> => {
    const flowJson = flowJsonByFlowId[flowId]
    if (flowJson === undefined) {
      const err = new Error(`stub: unknown flowId ${flowId}`) as Error & {
        status: number
      }
      err.status = 404
      throw err
    }
    return { flowId, flowJson }
  }
}

/** Insert a bare runs row and return its id (for bind/archive tests). */
async function seedRun(pipelineId: string, input: unknown = {}): Promise<string> {
  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO runs (identifier, pipeline_id, status, input)
     VALUES ('test-run', $1, 'pending', $2)
     RETURNING id`,
    [pipelineId, JSON.stringify(input)],
  )
  return records[0].id
}

describe('snapshotPipeline — 同 flow 二次快照复用 hash', () => {
  it('snapshots a flow and stores its SHA-256 + flow JSON', async () => {
    const flowJson = { nodes: [{ id: 'a', data: { label: 'A' } }], edges: [] }
    const snap = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-1': flowJson }),
    })

    expect(snap.pipelineId).toBe('flow-1')
    expect(snap.versionHash).toBe(sha256Hex(flowJson))
    expect(snap.versionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.flowJson).toEqual(flowJson)

    const { records } = await runQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM pipeline_versions WHERE version_hash = $1`,
      [snap.versionHash],
    )
    expect(records[0].count).toBe('1')
  })

  it('re-snapshotting the SAME flow reuses the hash + row (no duplicate)', async () => {
    const flowJson = { nodes: [{ id: 'a' }], version: 1 }
    const fetcher = stubFlow({ 'flow-1': flowJson })

    const first = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, { fetchFlow: fetcher })
    const second = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, { fetchFlow: fetcher })

    // same hash, same row id — dedup via UNIQUE(version_hash)
    expect(second.versionHash).toBe(first.versionHash)
    expect(second.id).toBe(first.id)

    const { records } = await runQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM pipeline_versions WHERE pipeline_id = $1`,
      ['flow-1'],
    )
    expect(records[0].count).toBe('1')
  })

  it('re-snapshotting after the flow CHANGED creates a new hash + row', async () => {
    const v1 = { nodes: [{ id: 'a' }] }
    const v2 = { nodes: [{ id: 'a' }, { id: 'b' }] }

    const first = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-1': v1 }),
    })
    const second = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-1': v2 }),
    })

    expect(second.versionHash).not.toBe(first.versionHash)
    expect(second.id).not.toBe(first.id)

    const { records } = await runQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM pipeline_versions WHERE pipeline_id = $1`,
      ['flow-1'],
    )
    expect(records[0].count).toBe('2')
  })

  it('two flows with the same content but different key order snapshot to the same hash', async () => {
    // canonicalization: {a:1,b:2} and {b:2,a:1} must hash identically
    const flowA = { a: 1, b: 2, nodes: [] }
    const flowB = { b: 2, a: 1, nodes: [] }

    const snapA = await snapshotPipeline('flow-a', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-a': flowA }),
    })
    const snapB = await snapshotPipeline('flow-b', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-b': flowB }),
    })

    expect(snapB.versionHash).toBe(snapA.versionHash)
  })
})

describe('bindRunToVersion — runs.pipeline_version_hash', () => {
  it('binds a run to a version hash and is idempotent', async () => {
    const flowJson = { nodes: [] }
    const snap = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-1': flowJson }),
    })
    const runId = await seedRun('flow-1')

    const ok1 = await bindRunToVersion(runId, snap.versionHash)
    expect(ok1).toBe(true)

    // idempotent re-bind to the same hash
    const ok2 = await bindRunToVersion(runId, snap.versionHash)
    expect(ok2).toBe(true)

    const { records } = await runQuery<{ hash: string | null }>(
      `SELECT pipeline_version_hash AS hash FROM runs WHERE id = $1`,
      [runId],
    )
    expect(records[0].hash).toBe(snap.versionHash)
  })

  it('returns false when the run id does not exist', async () => {
    const ok = await bindRunToVersion('00000000-0000-4000-8000-000000000000', 'a'.repeat(64))
    expect(ok).toBe(false)
  })
})

describe('archiveArtifact — artifact 可存可取', () => {
  it('archives bytes to MinIO and writes runs.artifact_uri; round-trips via get', async () => {
    const runId = await seedRun('flow-1')
    const artifact: RunArtifact = {
      bytes: Buffer.from('hello repro artifact'),
      contentType: 'text/plain',
      filename: 'out.txt',
    }

    const result = await archiveArtifact(runId, artifact, store)
    expect(result.uri).toMatch(/^s3:\/\/milagents\/runs\//)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)

    // runs.artifact_uri was written
    const { records } = await runQuery<{ uri: string | null }>(
      `SELECT artifact_uri AS uri FROM runs WHERE id = $1`,
      [runId],
    )
    expect(records[0].uri).toBe(result.uri)

    // round-trip: get returns the same bytes
    const fetched = await store.get(result.uri)
    expect(Buffer.from(fetched.bytes).toString('utf8')).toBe('hello repro artifact')
    expect(fetched.contentType).toBe('text/plain')
  })

  it('re-archiving identical bytes is idempotent (content-addressed key)', async () => {
    const runId = await seedRun('flow-1')
    const artifact: RunArtifact = { bytes: Buffer.from('same-bytes') }

    const a = await archiveArtifact(runId, artifact, store)
    const b = await archiveArtifact(runId, artifact, store)

    // same sha → same key → same uri
    expect(b.sha256).toBe(a.sha256)
    expect(b.uri).toBe(a.uri)
  })
})

describe('compareOutputs — structural comparison', () => {
  it('equal structures compare equal regardless of key order', () => {
    expect(compareOutputs({ a: 1, b: 2 }, { b: 2, a: 1 }).equal).toBe(true)
  })

  it('a value change is a structural diff', () => {
    const r = compareOutputs({ a: 1 }, { a: 2 })
    expect(r.equal).toBe(false)
    expect(r.diff).toContain('a')
  })

  it('a missing key is a structural diff', () => {
    const r = compareOutputs({ a: 1, b: 2 }, { a: 1 })
    expect(r.equal).toBe(false)
  })

  it('array length differs', () => {
    const r = compareOutputs([1, 2, 3], [1, 2])
    expect(r.equal).toBe(false)
  })
})

describe('reproduce — 同 hash + 同 input 重跑 + 结构比对', () => {
  it('matches when the executor returns a structurally-equal output', async () => {
    const expected = { ok: true, count: 3, items: [{ id: 1 }, { id: 2 }] }
    const result = await reproduce({
      flowId: 'flow-1',
      input: { paper: 1 },
      versionHash: 'a'.repeat(64),
      expectedOutput: expected,
      // executor returns the same structure with reordered keys — must still match
      execute: async () => ({ items: [{ id: 1 }, { id: 2 }], count: 3, ok: true }),
    })
    expect(result.match).toBe(true)
    expect(result.diff).toBeNull()
  })

  it('diverges when the executor returns a different structure', async () => {
    const result = await reproduce({
      flowId: 'flow-1',
      input: { paper: 1 },
      versionHash: 'a'.repeat(64),
      expectedOutput: { ok: true, count: 3 },
      execute: async () => ({ ok: true, count: 4 }),
    })
    expect(result.match).toBe(false)
    expect(result.diff).not.toBeNull()
  })
})

describe('end-to-end repro flow', () => {
  it('snapshot → bind → archive → reproduce on the same version hash', async () => {
    const flowJson = { nodes: [{ id: 'n1', type: 'llm' }] }
    const snap = await snapshotPipeline('flow-1', { gatewayUrl: 'http://stub' }, {
      fetchFlow: stubFlow({ 'flow-1': flowJson }),
    })

    const runId = await seedRun('flow-1', { paper: 1 })
    await bindRunToVersion(runId, snap.versionHash)

    // archive an artifact for the original run
    const arch = await archiveArtifact(runId, { bytes: Buffer.from('artifact-1') }, store)

    // reproduce: same hash + same input → executor returns the recorded output
    const originalOutput = { ok: true, paper: 1 }
    const repro = await reproduce({
      flowId: 'flow-1',
      input: { paper: 1 },
      versionHash: snap.versionHash,
      expectedOutput: originalOutput,
      execute: async () => ({ ok: true, paper: 1 }),
    })

    expect(repro.match).toBe(true)
    expect(arch.uri).toMatch(/^s3:\/\//)

    // the run row is bound to the snapshot's hash
    const { records } = await runQuery<{ hash: string | null; uri: string | null }>(
      `SELECT pipeline_version_hash AS hash, artifact_uri AS uri FROM runs WHERE id = $1`,
      [runId],
    )
    expect(records[0].hash).toBe(snap.versionHash)
    expect(records[0].uri).toBe(arch.uri)
  })
})
