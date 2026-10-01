import { runQuery } from '@dagents/db'
import type { RunCheckpointStatus, CheckpointAwaiting } from '@dagents/db'

/**
 * run_checkpoints 表访问（断点续跑 §6.1）。热路径 raw SQL 约定同其余 repo。
 */

export interface CheckpointRow {
  run_id: string
  flow_id: string
  status: RunCheckpointStatus
  topo_hash: string
  snapshot: Record<string, unknown>
  awaiting: CheckpointAwaiting | null
  updated_at: Date
}

/** 幂等 upsert：续跑执行期间反复回调（波次/迭代粒度）都落到同一行。
 * 状态机：terminal 单向门（写入后不变）；其余状态自由迁移。写入经
 * makeCheckpointHook 的串行链保序，迟到的波次快照不会越过链尾终态。 */
export async function upsertCheckpoint(row: {
  runId: string
  flowId: string
  status: RunCheckpointStatus
  topoHash: string
  snapshot: Record<string, unknown>
  awaiting?: CheckpointAwaiting | null
}): Promise<void> {
  await runQuery(
    `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot, awaiting, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NOW())
     ON CONFLICT (run_id) DO UPDATE SET
       -- 终态是单向门：terminal 一旦写入不再变；其余状态间自由迁移
       --（running→awaiting_input→running→terminal/resumable 都合法——
       -- 应答回流续跑期间波次快照要能把 awaiting 翻回 running）。
       status = CASE WHEN run_checkpoints.status = 'terminal' THEN run_checkpoints.status
                     ELSE EXCLUDED.status END,
       topo_hash = EXCLUDED.topo_hash,
       snapshot = CASE WHEN run_checkpoints.status = 'terminal' THEN run_checkpoints.snapshot
                       ELSE EXCLUDED.snapshot END,
       awaiting = EXCLUDED.awaiting,
       updated_at = NOW()`,
    [
      row.runId,
      row.flowId,
      row.status,
      row.topoHash,
      JSON.stringify(row.snapshot),
      row.awaiting ? JSON.stringify(row.awaiting) : null,
    ],
  )
}

export async function getCheckpoint(runId: string): Promise<CheckpointRow | null> {
  const { records } = await runQuery<CheckpointRow>(
    `SELECT run_id, flow_id, status, topo_hash, snapshot, awaiting, updated_at
       FROM run_checkpoints WHERE run_id = $1::uuid`,
    [runId],
  )
  return records[0] ?? null
}

export async function updateCheckpointStatus(
  runId: string,
  status: RunCheckpointStatus,
  awaiting?: CheckpointAwaiting | null,
): Promise<void> {
  await runQuery(
    `UPDATE run_checkpoints
        SET status = $2, updated_at = NOW(),
            awaiting = COALESCE($3::jsonb, awaiting)
      WHERE run_id = $1::uuid`,
    [runId, status, awaiting ? JSON.stringify(awaiting) : null],
  )
}

/** boot sweep 用：超时的挂起 checkpoint（deadline 已过仍未应答）。 */
export async function listExpiredAwaiting(): Promise<
  Array<{ run_id: string; flow_id: string }>
> {
  const { records } = await runQuery<{ run_id: string; flow_id: string }>(
    `SELECT run_id, flow_id FROM run_checkpoints
      WHERE status = 'awaiting_input'
        AND (awaiting->>'deadlineAt')::timestamptz < NOW()`,
  )
  return records
}
