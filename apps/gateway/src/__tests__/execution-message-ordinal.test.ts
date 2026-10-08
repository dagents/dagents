/**
 * POST /runs/:runId/message 的 ordinal 寻址（design-recover §3.6(e)，
 * PRD R8.5 定稿）：body 可选 ordinal——缺省 = 唯一活跃实例直达；并发迭代
 * 多实例并存 → 409 + 活跃实例清单（客户端列供选择）。纯控制通道契约
 * 测试（不落 DB，与 execution-message.test.ts 同款 registry 桩法；
 * 歧义清单载荷经 workflow-clients 部分 mock 注入——真实 sink 表的注册
 * 依赖 CLI 会话生命周期，由 workflow-clients-recover.test.ts 覆盖）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { app } from '../app.js'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'

vi.mock('../routes/workflow-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/workflow-clients.js')>()
  return {
    ...actual,
    sendToRunNodeAmbiguous: vi.fn(() => ({ ack: 'ambiguous' as const, ordinals: [0, 1, 2] })),
  }
})

const runId = '00000000-0000-0000-0000-000000000c1'
const chatId = '00000000-0000-0000-0000-000000000c2'

/** sendToNode 桩：记录 (nodeId, text, ordinal) 三元组，回执可编程。 */
function makeHandle(
  sendToNode: NonNullable<ExecutionHandle['sendToNode']>,
): ExecutionHandle {
  return {
    chatId,
    runId,
    kind: 'workflow-run',
    startedAt: Date.now(),
    abort: () => {},
    sendToNode,
    done: Promise.resolve(),
  }
}

const post = (body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/v1/workflows/runs/${runId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

afterEach(() => {
  const handle = executionRegistry.getByRun(runId)
  if (handle) executionRegistry.unregister(handle)
})

describe('POST /runs/:runId/message — ordinal 寻址（R8.5，§3.6(e)）', () => {
  it('body 带 ordinal：原样透传给 sendToNode（并发迭代的确定实例直达）', async () => {
    const calls: Array<[string, string, number | undefined]> = []
    executionRegistry.register(
      makeHandle((nodeId, text, ordinal) => {
        calls.push([nodeId, text, ordinal])
        return 'sent'
      }),
    )
    const res = await post({ nodeId: 'body1', text: '第 2 项的补充', ordinal: 2 })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data?: { status: string; ordinal?: number } }
    expect(json.data?.status).toBe('sent')
    expect(json.data?.ordinal).toBe(2)
    expect(calls).toEqual([['body1', '第 2 项的补充', 2]])
  })

  it('多实例歧义（sendToNode 返回 ambiguous）→ 409 + 活跃 ordinal 清单', async () => {
    executionRegistry.register(
      makeHandle((nodeId, _text, ordinal) => {
        void nodeId
        // 缺省寻址（ordinal undefined）撞上多实例：控制通道回 ambiguous
        if (ordinal == null) return 'ambiguous'
        return 'sent'
      }),
    )
    const res = await post({ nodeId: 'body1', text: '补一句' })
    expect(res.status).toBe(409)
    // fail() 信封的 extra 顶层展开（lib/http.ts 单源形状）
    const json = (await res.json()) as { error?: string; ordinals?: number[] }
    expect(json.error).toMatch(/ordinal/)
    // 活跃实例清单（客户端列供选择后带 ordinal 重试）
    expect(json.ordinals).toEqual([0, 1, 2])
  })

  it('ordinal 归一：非整数/负数按缺省处理（不炸不静默错路由）', async () => {
    const calls: Array<[string, string, number | undefined]> = []
    executionRegistry.register(
      makeHandle((nodeId, text, ordinal) => {
        calls.push([nodeId, text, ordinal])
        return 'sent'
      }),
    )
    const res = await post({ nodeId: 'n1', text: 'x', ordinal: -3 })
    expect(res.status).toBe(200)
    expect(calls[0]![2]).toBeUndefined()
  })
})
