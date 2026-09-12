import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 1720000094000 — dispatch 任务取消协议（执行取消 spec §7 Deferred，2026-09-06 还债）。
 *
 * `cancel_requested_at`：gateway 侧的取消意图标记（幂等）。queued/claimed
 * 任务由 gateway 直接落终态（failed + failure_reason='cancelled'）；running
 * 任务只打标记，daemon 在事件流循环中轮询发现后 abort 子进程
 * （ExecOptions.signal → SIGTERM→SIGKILL）并以 failTask('cancelled') 收尾。
 * 不动 status CHECK 约束 —— 'failed' + failure_reason 承载取消终态，
 * claim/terminal 的状态机不变。
 */
export class AddDispatchTaskCancel1720000094000 implements MigrationInterface {
  name = 'AddDispatchTaskCancel1720000094000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE dispatch_tasks ADD COLUMN cancel_requested_at TIMESTAMPTZ`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE dispatch_tasks DROP COLUMN cancel_requested_at`)
  }
}
