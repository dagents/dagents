import { describe, it, expect } from 'vitest'
import type { QueryRunner } from 'typeorm'
import type { RunStatus, RunStopReason } from '../entities/run.entity.js'
import { RunsStopReasonAndSnapshots1720000111000 } from '../migrations/1720000111000-runs-stop-reason-and-snapshots.js'

/**
 * RunStatus ↔ 迁移 CHECK 词表一致性钉子（design-recover §⑥，AC-R3-3 的
 * 「类型测试 + 迁移测试双钉」之迁移腿）：TS 联合与 DB CHECK 若漂移（单边
 * 加词），写侧会在运行时被 CHECK 拒收（1720000103000 头注释记载的实弹
 * 故障模式）——这里把两侧词表钉在同一份清单上。
 */

/** 捕获型 QueryRunner（只录 SQL，不连库）。 */
function captureRunner(): { runner: QueryRunner; sqls: string[] } {
  const sqls: string[] = []
  const runner = {
    query: async (sql: string): Promise<void> => {
      sqls.push(sql)
    },
  } as unknown as QueryRunner
  return { runner, sqls }
}

/** 词表清单断言（子串存在性 + 完整性）。 */
function expectVocab(sqls: string[], constraint: string, words: readonly string[]): void {
  // 每个约束有 DROP（IF EXISTS）与 ADD 两条语句——词表在 ADD 那条上
  const stmt = sqls.find((s) => s.includes(`ADD CONSTRAINT ${constraint}`)) ?? ''
  expect(stmt, `缺少 ${constraint} 的 ADD DDL`).not.toBe('')
  for (const w of words) {
    expect(stmt, `${constraint} 词表缺 '${w}'`).toContain(`'${w}'`)
  }
}

describe('runs 词表一致性（R3/R8，迁移 1720000111000）', () => {
  it('status CHECK 九值 = RunStatus 联合（写新读旧：cancelled 显式保留）', async () => {
    const { runner, sqls } = captureRunner()
    await new RunsStopReasonAndSnapshots1720000111000().up(runner)
    const statusWords: readonly RunStatus[] = [
      'pending',
      'running',
      'awaiting_input',
      'completed',
      'partial_success',
      'budget_exceeded',
      'failed',
      'stopped',
      'cancelled',
    ]
    expectVocab(sqls, 'runs_status_chk', statusWords)
    // down 路径退回八值（无 stopped——逃生门不是往返保证，仓库范式）
    const down = captureRunner()
    await new RunsStopReasonAndSnapshots1720000111000().down(down.runner)
    const downStmt =
      down.sqls.find((s) => s.includes('ADD CONSTRAINT runs_status_chk')) ?? ''
    expect(downStmt).not.toBe('')
    expect(downStmt).not.toContain("'stopped'")
    expect(downStmt).toContain("'cancelled'")
  })

  it('stop_reason CHECK 五值 = RunStopReason 联合（无死值，R3.2）', async () => {
    const { runner, sqls } = captureRunner()
    await new RunsStopReasonAndSnapshots1720000111000().up(runner)
    const stopWords: readonly RunStopReason[] = [
      'user',
      'interrupted',
      'superseded',
      'model',
      'provider',
    ]
    expectVocab(sqls, 'runs_stop_reason_chk', stopWords)
  })

  it('快照列齐备：frozen_agents / models / run_node_spans.ordinal', async () => {
    const { runner, sqls } = captureRunner()
    await new RunsStopReasonAndSnapshots1720000111000().up(runner)
    expect(sqls.some((s) => s.includes('"frozen_agents"'))).toBe(true)
    expect(sqls.some((s) => s.includes('"models"'))).toBe(true)
    expect(sqls.some((s) => s.includes('"ordinal"'))).toBe(true)
  })
})
