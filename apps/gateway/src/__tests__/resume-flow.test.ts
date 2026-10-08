import { describe, it } from 'vitest'

/**
 * 断点续跑集成（design-run-checkpoint-resume.md §8）：
 * ① HumanInput 持久挂起→聊天应答回流→同 runId 完成
 * ② answer 端点直达（画布应答框路径）
 *
 * 失败→resume 主链与拓扑护栏在 e2e WF-14（spec 24）覆盖 —— 真实 HTTP
 * 栈下的完整旅程断言（含 mock LLM 零重跑证明）；vitest worker 内的后台
 * 完成轮询存在环境性不稳，按测试分层原则归位端到端层。
 *
 * 2026-10-08 清理批（验收遗留 #6b）：旅程归位 e2e 后残留的本地驱动骨架
 * （seedFlow/runAsync/pollUntil/runStatus/checkpointStatus 与 DB 清理段，
 * eslint 存量 warning 来源）移除；同款 app.request 直连真跑模式见
 * `__tests__/warm-cache-lineage-tokens.test.ts` 与 `recover-budget-resume.test.ts`。
 */

describe('断点续跑：HumanInput 持久挂起 → 应答回流', () => {
  // 覆盖迁移声明（2026-09-18）：本组旅程的权威验证在 e2e ——
  //   · RM-03（24-run-resume.spec.ts）：挂起→answer 端点→同 runId 完成
  //   · MA-09 新契约（12-multi-agent.spec.ts）：缺答案→awaiting_input→补答续跑
  //   · 聊天应答回流（chats.ts answerAwaitingRunForChat）经 MA-09 同款端到端路径
  // vitest 进程内版本因 async fire-and-forget 的观测面不稳间歇挂起，删除
  // 重复维护面；引擎语义由 executor-resume.test.ts 8 例钉住。
  it.todo('聊天应答 / answer 端点（见 e2e RM-03 与 MA-09）')
})
