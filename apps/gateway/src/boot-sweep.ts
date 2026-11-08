/**
 * Boot sweep（execution-cancellation spec D7 / architecture AD-6）：gateway
 * 重启杀死一切在途执行——inline CLI spawn、引擎 run、HumanInput 挂起 Promise
 * 都活在本进程里，无人再写它们的终态。启动时收敛悬空 DB 行，杜绝「永远
 * running」。受影响的 chat 补一条可见系统消息。
 *
 * 2026-10-07 可恢复性地基（design-recover §3.2）：三件收敛语义升级——
 *  ① runs 在途行 → `stopped` + `stop_reason='interrupted'`（中断事实诚实，
 *     与真失败 failed 区分；无 checkpoint 的 chat 路径 run 同样标注——resume
 *     可用性判据才是 checkpoint resumable，UI 入口联动见 console 批次）；
 *  ② run_node_spans 悬空 running → `stopped`（唯一写入方就是本进程，boot 时
 *     任何 running span 必然悬空）——依赖 CHECK 放宽迁移 1720000106200
 *     （三方共同前置，「迁移先行、写方随后」），否则被拒收且每步容错吞错、
 *     spans 永悬 running（1720000103000 头注释记载的实弹故障模式）；
 *  ③ run_checkpoints 悬空 running → `resumable`（AC-R1-1 关键前置：崩溃时
 *     进程内 terminalize('resumable') 从未执行，checkpoint 停在 running 会被
 *     resume 路由 409）。
 *
 * 终态行零改写（AC-R3-1「终态不被后台任务改写」由 WHERE 条件保证）；真失败
 * （catch 路径）仍 failed；既有 awaiting 超时收敛维持 failed（应答窗超时是
 * 真实失败语义，PRD 未把它列入 stopped 来源，保守不动）。
 *
 * 从 index.ts 抽出为独立模块（2026-10-07）：启动路径内联不可测——抽出后
 * gateway 单测可对 dagents_gw_test 直接做 DB 断言（__tests__/boot-sweep.test.ts）。
 */
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:reaper' })

export async function sweepDanglingExecutions(): Promise<void> {
  // 每步独立容错：一条 SQL 失败（如列名演进）不能让其余收敛项陪葬
  //（首版实现整段一个 try/catch，run_node_spans 的列名错就连带
  // dispatch_tasks 也不收敛了 —— e2e 库 boot 日志暴露）。
  const step = async (name: string, sql: string, params: unknown[] = []): Promise<void> => {
    try {
      const { affected } = await runQuery(sql, params)
      if (affected && affected > 0) {
        log.warn('boot sweep step converged rows', { step: name, count: affected })
      }
    } catch (err) {
      log.warn('boot sweep step failed', {
        step: name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM chats WHERE status = 'running'`,
      [],
    )
    if (records.length > 0) {
      for (const chat of records) {
        await runQuery(
          `INSERT INTO chat_messages (chat_id, role, content, created_at)
           VALUES ($1::uuid, 'system', '执行被 gateway 重启中断（如有需要请重新发起）', NOW())`,
          [chat.id],
        ).catch(() => {
          // best-effort message — the status flip below is what matters
        })
      }
      await runQuery(
        `UPDATE chats SET status = 'failed', updated_at = NOW() WHERE status = 'running'`,
        [],
      )
      log.warn('boot sweep: dangling chats converged to failed', { count: records.length })
    }
    // ① runs：在途行收敛为 stopped(interrupted)——gateway 重启是「中断」不是
    //    「失败」（用户可 resume；真失败仍由 catch 路径落 failed）。
    await step(
      'runs',
      `UPDATE runs SET status = 'stopped', stop_reason = 'interrupted', finished_at = NOW()
        WHERE status IN ('running', 'pending')`,
    )
    // ② run_node_spans 的 'running' 行（唯一写入方就是本进程，boot 时任何
    //    running span 必然悬空）。列名是 finished_at（对齐 entity 映射）。
    //    前置：CHECK 放宽迁移 1720000106200（词表含 'stopped'）。
    await step(
      'run_node_spans',
      `UPDATE run_node_spans
          SET status = 'stopped',
              error = COALESCE(error, 'gateway 重启中断（boot sweep）'),
              finished_at = COALESCE(finished_at, NOW())
        WHERE status = 'running'`,
    )
    // ③ run_checkpoints：崩溃时进程内 terminalize 从未执行——悬空 running
    //    收敛 resumable，resume 路由（只认 resumable）不再 409。
    await step(
      'run_checkpoints',
      `UPDATE run_checkpoints SET status = 'resumable', updated_at = NOW() WHERE status = 'running'`,
    )
    // dispatch_tasks：daemon 与 gateway 是两个进程 —— daemon 活着时它的
    // claimed/running 任务仍会正常回报终态，不能一刀切。只收敛「认领
    // daemon 已离线」的任务；未被认领的 queued 任务留给调度路径（daemon
    // 重连后仍可 claim）。
    // 持久挂起超时收敛（断点续跑 P2）：deadline 已过的 awaiting run →
    // failed + checkpoint terminal（应答窗 = HUMAN_INPUT_TIMEOUT_MS）——
    // 维持 failed（真实失败语义，见文件头）。
    await step(
      'run_checkpoints_expired_awaiting',
      `UPDATE runs r
          SET status = 'failed', finished_at = NOW()
         FROM run_checkpoints c
        WHERE c.run_id = r.id
          AND r.status = 'awaiting_input'
          AND c.status = 'awaiting_input'
          AND (c.awaiting->>'deadlineAt')::timestamptz < NOW()`,
    )
    await step(
      'run_checkpoints_terminalize',
      `UPDATE run_checkpoints
          SET status = 'terminal', updated_at = NOW()
        WHERE status = 'awaiting_input'
          AND (awaiting->>'deadlineAt')::timestamptz < NOW()`,
    )
    await step(
      'dispatch_tasks',
      `UPDATE dispatch_tasks t
          SET status = 'failed',
              finished_at = NOW(),
              failure_reason = 'claiming daemon offline (gateway boot sweep)'
        WHERE t.status IN ('claimed', 'running')
          AND t.claimed_by_daemon_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM daemons d
             WHERE d.id = t.claimed_by_daemon_id
               AND (d.status = 'offline' OR d.last_heartbeat_at < NOW() - interval '15 seconds')
          )`,
    )
  } catch (err) {
    log.warn('boot sweep failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
