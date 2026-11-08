/**
 * RunStatus 词表 ↔ DB CHECK 双钉（design-recover §⑥，AC-R3-3：
 * 「TS RunStatus 词表与 DB CHECK 一致（类型测试 + 迁移测试双钉）」的迁移
 * 半边）：从 information_schema 读 runs 表两条 CHECK 约束的词表，与
 * packages/db 的 RunStatus/RunStopReason 类型字面量逐一对照——TS 侧在
 * recover-status.test.ts 已钉 toRunStatus 产出；本套钉「库侧接纳九值/
 * 五值、不接纳词表外值」，写新读旧（NFR-1：cancelled 显式保留）双跑。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'

/** 与 packages/db/src/entities/run.entity.ts 的 RunStatus 同源词表（九值）。 */
const RUN_STATUS_VOCAB = [
  'pending',
  'running',
  'awaiting_input',
  'completed',
  'partial_success',
  'budget_exceeded',
  'failed',
  'stopped',
  'cancelled',
] as const

/** 与 RunStopReason 同源词表（五值，无死值——PRD R3.2 定稿）。 */
const STOP_REASON_VOCAB = ['user', 'interrupted', 'superseded', 'model', 'provider'] as const

interface CheckRow {
  conname: string
  pg_get_constraintdef: string
}

let checks: CheckRow[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
  const { records } = await runQuery<CheckRow>(
    `SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
       FROM pg_constraint
      WHERE conrelid = 'runs'::regclass AND contype = 'c'`,
  )
  checks = records
})

/** 从 CHECK 定义里解出词表（pg_get_constraintdef 的 ANY 数组字面量）。 */
function vocabOf(constraint: string): string[] {
  const match = /ANY \(\s*ARRAY\[(.*?)\]/s.exec(constraint)
  expect(match, `约束 ${constraint} 应含 ARRAY 词表`).toBeTruthy()
  return (match![1]!.match(/'([^']+)'/g) ?? []).map((w) => w.slice(1, -1))
}

describe('RunStatus ↔ runs CHECK 词表双钉（AC-R3-3 迁移半边）', () => {
  it('status CHECK：九值词表逐字一致（cancelled 显式保留——写新读旧，NFR-1）', () => {
    const statusChecks = checks.filter(
      (c) => /status/.test(c.pg_get_constraintdef) && !/stop_reason/.test(c.pg_get_constraintdef),
    )
    // 建表约束 + 1720000111000 重建后的现状：恰一条 status CHECK
    expect(statusChecks.length).toBeGreaterThanOrEqual(1)
    const vocab = vocabOf(statusChecks[0]!.pg_get_constraintdef)
    expect([...vocab].sort()).toEqual([...RUN_STATUS_VOCAB].sort())
  })

  it('stop_reason CHECK：五值词表逐字一致（NULL 放行 + 五值无死值）', () => {
    const stopChecks = checks.filter((c) => /stop_reason/.test(c.pg_get_constraintdef))
    expect(stopChecks.length).toBeGreaterThanOrEqual(1)
    const def = stopChecks[0]!.pg_get_constraintdef
    expect(def).toContain('stop_reason IS NULL')
    const vocab = vocabOf(def)
    expect([...vocab].sort()).toEqual([...STOP_REASON_VOCAB].sort())
  })

  it('词表外值被拒收（DB 侧 fail-closed 实证）', async () => {
    await expect(
      runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input)
         VALUES ('00000000-0000-4000-8000-00000000e901', 'x', '00000000-0000-4000-8000-00000000e902'::uuid, 'bogus', '{}')`,
      ),
    ).rejects.toThrow(/check constraint/i)
    // stop_reason 词表外值：先落一行合法 run，再 UPDATE 触碰 CHECK
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input)
       VALUES ('00000000-0000-4000-8000-00000000e903', 'x', '00000000-0000-4000-8000-00000000e902'::uuid, 'stopped', '{}')`,
    )
    try {
      await expect(
        runQuery(
          `UPDATE runs SET stop_reason = 'nonsense' WHERE id = '00000000-0000-4000-8000-00000000e903'`,
        ),
      ).rejects.toThrow(/check constraint/i)
    } finally {
      await runQuery(`DELETE FROM runs WHERE id = '00000000-0000-4000-8000-00000000e903'`).catch(
        () => {},
      )
    }
  })

  it('写新读旧双跑：九值全部可写（含 stopped/cancelled 双词并存）', async () => {
    const probeId = '00000000-0000-4000-8000-00000000e911'
    const flowId = '00000000-0000-4000-8000-00000000e912'
    try {
      for (const status of RUN_STATUS_VOCAB) {
        await runQuery(
          `INSERT INTO runs (id, identifier, pipeline_id, status, input, stop_reason)
           VALUES ($1::uuid, $1, $2::uuid, $3, '{}', NULL)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, stop_reason = NULL`,
          [probeId, flowId, status],
        )
      }
      // stopped 行的三个合法来源 + failed 行的两个来源全部可写
      for (const reason of STOP_REASON_VOCAB) {
        await runQuery(
          `UPDATE runs SET status = $2, stop_reason = $3 WHERE id = $1::uuid`,
          [probeId, reason === 'model' || reason === 'provider' ? 'failed' : 'stopped', reason],
        )
      }
    } finally {
      await runQuery(`DELETE FROM runs WHERE id = $1::uuid`, [probeId]).catch(() => {})
    }
  })
})
