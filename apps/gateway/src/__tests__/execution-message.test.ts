/**
 * POST /api/v1/workflows/runs/:runId/message — 运行中插话（2026-09-08
 * 可操作终端 PRD，docs/prd-operable-terminal.md）。
 *
 * 纯控制通道契约测试（不落 DB）：向 executionRegistry 注册带 sendToNode
 * 桩的执行句柄，断言路由的回执语义与校验 —— 诚实三态（sent/unsupported/
 * not_running）、409（无活执行，与 cancel 对齐）、参数校验与保险丝。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { app } from '../app.js'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'

const runId = '00000000-0000-0000-0000-0000000000a1'
const chatId = '00000000-0000-0000-0000-0000000000b1'

/** 最小执行句柄：sendToNode 可注入桩。 */
function makeHandle(sendToNode?: ExecutionHandle['sendToNode']): ExecutionHandle {
  return {
    chatId,
    runId,
    kind: 'workflow-run',
    startedAt: Date.now(),
    abort: () => {},
    ...(sendToNode ? { sendToNode } : {}),
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

describe('POST /runs/:runId/message 运行中插话（2026-09-08）', () => {
  it('sent：路由到 sendToNode 桩，回执原样透传', async () => {
    const calls: Array<[string, string]> = []
    const handle = makeHandle((nodeId, text) => {
      calls.push([nodeId, text])
      return 'sent'
    })
    executionRegistry.register(handle)
    const res = await post({ nodeId: 'node-1', text: '重点看登录模块' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { status: string } }
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('sent')
    expect(calls).toEqual([['node-1', '重点看登录模块']])
  })

  it('unsupported：有活执行但执行路径无双向通道', async () => {
    executionRegistry.register(makeHandle(() => 'unsupported'))
    const res = await post({ nodeId: 'node-1', text: 'hi' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { status: string } }
    expect(json.data.status).toBe('unsupported')
  })

  it('not_running：句柄在但目标节点已无活会话', async () => {
    executionRegistry.register(makeHandle(() => 'not_running'))
    const res = await post({ nodeId: 'node-1', text: 'hi' })
    const json = (await res.json()) as { data: { status: string } }
    expect(json.data.status).toBe('not_running')
  })

  it('handle 无 sendToNode（无插话通道的执行种类）→ unsupported', async () => {
    executionRegistry.register(makeHandle(undefined))
    const res = await post({ nodeId: 'node-1', text: 'hi' })
    const json = (await res.json()) as { data: { status: string } }
    expect(json.data.status).toBe('unsupported')
  })

  it('409：无活执行（已结束 / 从未开始），与 cancel 语义对齐', async () => {
    const res = await post({ nodeId: 'node-1', text: 'hi' })
    expect(res.status).toBe(409)
  })

  it('400：缺 nodeId / 空 text / 超长保险丝', async () => {
    executionRegistry.register(makeHandle(() => 'sent'))
    const noNode = await post({ text: 'hi' })
    expect(noNode.status).toBe(400)
    const emptyText = await post({ nodeId: 'node-1', text: '' })
    expect(emptyText.status).toBe(400)
    const tooLong = await post({ nodeId: 'node-1', text: 'x'.repeat(32_001) })
    expect(tooLong.status).toBe(400)
  })
})
