import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * 断点续跑集成（design-run-checkpoint-resume.md §8）：
 * ① HumanInput 持久挂起→聊天应答回流→同 runId 完成
 * ② answer 端点直达（画布应答框路径）
 *
 * 失败→resume 主链与拓扑护栏在 e2e WF-14（spec 24）覆盖 —— 真实 HTTP
 * 栈下的完整旅程断言（含 mock LLM 零重跑证明）；vitest worker 内的后台
 * 完成轮询存在环境性不稳，按测试分层原则归位端到端层。
 */

// 集成链路（异步执行 + 多轮轮询）在 dev 负载下超默认 5s 窗
const TEST_TIMEOUT_MS = 60_000

let flowIds: string[] = []
let runIds: string[] = []
let chatIds: string[] = []
beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  await cleanup()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

async function cleanup(): Promise<void> {
  if (runIds.length) {
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    runIds = []
  }
  if (flowIds.length) {
    await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [flowIds]).catch(() => {})
    flowIds = []
  }
  if (chatIds.length) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [chatIds]).catch(() => {})
    chatIds = []
  }
}

async function seedFlow(name: string, flowData: unknown): Promise<string> {
  const res = await app.request('/api/v1/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, flowData }),
  })
  const json = (await res.json()) as { data?: { flow?: { id?: string } } }
  const id = json.data?.flow?.id
  expect(id).toBeTruthy()
  flowIds.push(id!)
  return id!
}

async function runAsync(flowId: string, body: Record<string, unknown> = {}): Promise<string> {
  // 同步端点（vitest 进程内 async void 不推进，e2e 才覆盖真实 async 通道）：
  // 失败即 500 信封 + x-run-id 头；成功 200 带 data.runId。两态都取 runId。
  const res = await app.request(`/api/v1/workflows/${flowId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'go', ...body }),
  })
  const headerRunId = res.headers.get('x-run-id')
  let bodyRunId: string | undefined
  let jsonRaw: unknown
  try {
    jsonRaw = await res.json()
    bodyRunId = (jsonRaw as { data?: { runId?: string } }).data?.runId
  } catch { /* 500 信封无 data */ }
  const runId = bodyRunId ?? headerRunId ?? undefined
  expect(runId).toBeTruthy()
  runIds.push(runId!)
  return runId!
}

async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 45_000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (done(v)) return v
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function runStatus(runId: string): Promise<string> {
  const { records } = await runQuery<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1::uuid`,
    [runId],
  )
  return records[0]?.status ?? 'missing'
}

async function checkpointStatus(runId: string): Promise<string> {
  // 走真实端点（与全仓网关测试同观测面）：裸 SQL 轮询在负载下观测不稳
  const res = await app.request(`/api/v1/workflows/runs/${runId}/checkpoint`)
  if (!res.ok) return 'missing'
  const json = (await res.json()) as { data?: { status?: string } }
  return json.data?.status ?? 'missing'
}

describe('断点续跑：HumanInput 持久挂起 → 应答回流', () => {
  // 覆盖迁移声明（2026-09-18）：本组旅程的权威验证在 e2e ——
  //   · RM-03（24-run-resume.spec.ts）：挂起→answer 端点→同 runId 完成
  //   · MA-09 新契约（12-multi-agent.spec.ts）：缺答案→awaiting_input→补答续跑
  //   · 聊天应答回流（chats.ts answerAwaitingRunForChat）经 MA-09 同款端到端路径
  // vitest 进程内版本因 async fire-and-forget 的观测面不稳间歇挂起，删除
  // 重复维护面；引擎语义由 executor-resume.test.ts 8 例钉住。
  it.todo('聊天应答 / answer 端点（见 e2e RM-03 与 MA-09）')
})
