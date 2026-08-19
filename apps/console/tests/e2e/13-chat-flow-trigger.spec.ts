import { test, expect } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  createSeedContext,
  seedMockLlmProvider,
  seedFlow,
  seedPlatformAgent,
  seedDirectory,
  seedChat,
  seedChatBoundToFlow,
  resetMockLlm,
  setMockLlmScript,
  mockLlmCalls,
  type SeedContext,
} from './helpers/seed'
import { linearFlow, parallelFlow, llmNode, platformAgentNode, humanInputNode } from './helpers/flow-builder'

/**
 * 13 — 聊天触发 SSE（Tier B，docs/e2e-test-plan.md §5.3 TR-01~08）。
 *
 * 链路：浏览器/HTTP POST /api/chats/:id/messages（mode='stream'）→
 * GET /api/chats/:id/stream（console 真流式透传 → gateway 内联 executor）→
 * SSE 帧（metadata → token* → end）→ assistant 落库（run_id 关联）。
 *
 * 已知偏差（与计划 §5.3 对照）：
 *  - @flow 命令不走 SSE —— ack JSON + fire-and-forget 执行 + persistComplete
 *    落 assistant（TR-02 按真实契约断言）；
 *  - chat 路径不写 runs 表 —— GET /chats/:id/runs 只验证 API 契约，
 *    run 关联改断言 chat_messages.run_id（TR-08）；
 *  - TR-06 不真的发消息：未绑定 chat 的 auto-agent 路径会 spawn 本地 CLI
 *    （不可控），只断言 stream 端点的明确错误契约。
 */

const CONSOLE_BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? '3000'}`

interface SseFrame {
  event: string
  data: unknown
}

/** 读 SSE 流直到满足条件（默认读到 end 帧），返回全部已收帧。 */
async function readSse(
  path: string,
  opts: { until?: (frames: SseFrame[]) => boolean; timeoutMs?: number } = {},
): Promise<SseFrame[]> {
  const { until, timeoutMs = 15_000 } = opts
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) {
    throw new Error(`stream ${path} failed: ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sse read timeout')), deadline - Date.now())),
    ])
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      try {
        const payload = JSON.parse(dataLine.slice(6)) as { event: string; data: unknown }
        frames.push(payload)
      } catch {
        // 非 JSON 帧（如 end 的 '[DONE]'）——按裸文本记录
        frames.push({ event: 'raw', data: dataLine.slice(6) })
      }
    }
    if (until?.(frames)) break
    const ended = frames.some((f) => f.event === 'end' || f.data === '[DONE]')
    if (ended && !until) break
  }
  return frames
}

const tokenText = (frames: SseFrame[]) =>
  frames
    .filter((f) => f.event === 'token')
    .map((f) => String(f.data))
    .join('')

/** 轮询 DB 直到条件满足（fire-and-forget 落库的等待器）。 */
async function pollDb<T>(ctx: SeedContext, sql: string, params: unknown[], pred: (rows: T[]) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let rows: T[] = []
  while (Date.now() < deadline) {
    rows = (await ctx.db.runQuery<T>(sql, params)).records
    if (pred(rows)) return rows
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`pollDb timeout: ${JSON.stringify(rows)}`)
}

/** 浏览器侧发消息（走真实 composer UI）。 */
async function composerSend(page: Page, text: string) {
  const box = page.getByLabel('消息输入框')
  await box.fill(text)
  await page.getByLabel('发送消息').click()
}

test.describe('聊天触发 / SSE（Tier B：TR-01 ~ TR-08）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('TR-01: chat 绑定 flow → 浏览器发消息 → 流式渲染 + 刷新仍在', async ({ page, request }) => {
    const mockText = 'TR01-STREAM-REPLY-最终回复'
    await setMockLlmScript({
      fallback: { text: mockText, streamChunkSize: 6, streamIntervalMs: 40 },
    })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr01-chat-flow',
      flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are TR-01.', prompt: '请回复' })]),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await page.goto(`/chats/${chatId}`)
    await composerSend(page, '你好，触发流程')

    // assistant 气泡出现且最终完整（token 流式渲染的可见结果）
    const bubble = page.locator('.chat-msg-assistant').last()
    await expect(bubble).toBeVisible({ timeout: 15_000 })
    await expect(bubble.locator('.assistant-content')).toContainText(mockText, { timeout: 15_000 })

    // 刷新后消息仍在（落库）
    await page.reload()
    await expect(page.locator('.chat-msg-user').last()).toContainText('你好，触发流程')
    await expect(page.locator('.chat-msg-assistant').last().locator('.assistant-content')).toContainText(mockText)
  })

  test('TR-02: @flow 命令触发 —— ack JSON + 异步执行落库（含 client 注入回归）', async ({ request }) => {
    // 回归锚：@flow 路径曾漏注入 llmClient/agentFetcher（LLM 节点必挂），
    // 修复后 LLM flow 也能经 @flow 跑通。
    const mockText = 'TR02-ATFLOW-RESULT'
    await setMockLlmScript({ fallback: { text: mockText } })
    const directoryId = await seedDirectory(ctx)
    const flowName = `e2e-tr02-flow-${Date.now()}`
    await seedFlow(ctx, request, {
      name: flowName,
      flowData: linearFlow([
        llmNode('a', { systemPrompt: 'You are TR-02.', prompt: '干活' }),
      ]),
    })
    const chatId = await seedChat(ctx, { directoryId }) // 未绑定 flow

    const res = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: 'user', content: `@flow ${flowName} 跑一下这个流程` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.mode).toBe('json')
    expect(JSON.stringify(body.data?.payload?.ack)).toContain(flowName)

    // fire-and-forget：轮询 assistant 落库（persistComplete）
    await pollDb<{ content: string }>(
      ctx,
      `SELECT content FROM chat_messages WHERE chat_id = $1 AND role = 'assistant'`,
      [chatId],
      (rows) => rows.some((r) => r.content.includes(mockText)),
    )
    // chat 被命令绑定到该 flow
    const { records: chatRows } = await ctx.db.runQuery<{ flow_id: string }>(
      `SELECT flow_id FROM chats WHERE id = $1`,
      [chatId],
    )
    expect(chatRows[0]?.flow_id).toBeTruthy()
  })

  test('TR-03: 聊天中执行多 Agent flow —— 完整帧序列 + 三次协作调用', async ({ request }) => {
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:TR-P1' }, respond: { text: 'TR03-P1-OUT' } },
        { match: { systemContains: 'ROLE:TR-P2' }, respond: { text: 'TR03-P2-OUT' } },
        { match: { systemContains: 'You are TR-SUM' }, respond: { text: 'TR03-FINAL' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const agentId = await seedPlatformAgent(ctx, { name: 'tr03-crew', instructions: 'AGENT-BASE-TR03' })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr03-multi',
      flowData: parallelFlow(
        [
          [platformAgentNode('p1', { agentId, systemPrompt: 'ROLE:TR-P1' })],
          [platformAgentNode('p2', { agentId, systemPrompt: 'ROLE:TR-P2' })],
        ],
        llmNode('sum', { systemPrompt: 'You are TR-SUM.', prompt: '汇总' }),
      ),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    const post = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: 'user', content: '并行执行并汇总' },
    })
    expect((await post.json()).data?.mode).toBe('stream')

    const frames = await readSse(`/api/chats/${chatId}/stream`)
    const events = frames.map((f) => f.event)
    // 帧序列：metadata 首、token*、end 尾
    expect(events[0]).toBe('metadata')
    expect(events[events.length - 1]).toBe('end')
    expect(events.filter((e) => e === 'token').length).toBeGreaterThan(0)
    // 汇总节点（唯一可流式节点）的 token 拼接 = mock 文本
    expect(tokenText(frames)).toBe('TR03-FINAL')

    // 多 Agent 协作真的发生在聊天路径（3 次 LLM 调用）
    const calls = (await mockLlmCalls()) as Array<{ messages: Array<{ role: string; content: string }> }>
    const sysCalls = calls.filter((c) => c.messages.some((m) => m.role === 'system'))
    expect(sysCalls.filter((c) => c.messages.some((m) => m.content.includes('ROLE:TR-P1'))).length).toBe(1)
    expect(sysCalls.filter((c) => c.messages.some((m) => m.content.includes('ROLE:TR-P2'))).length).toBe(1)
    expect(sysCalls.filter((c) => c.messages.some((m) => m.content.includes('You are TR-SUM'))).length).toBe(1)
  })

  test('TR-04: HumanInput 聊天路径 —— 挂起/系统提示/下一条消息恢复', async ({ page, request }) => {
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'You are TR04-A' }, respond: { text: 'TR04-A-PROPOSAL' } },
        { match: { systemContains: 'You are TR04-B' }, respond: { text: 'TR04-B-EXECUTED' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr04-human',
      flowData: linearFlow([
        llmNode('a', { systemPrompt: 'You are TR04-A.', prompt: '出方案' }),
        humanInputNode('confirm', { prompt: '确认方案' }),
        llmNode('b', { systemPrompt: 'You are TR04-B.', prompt: '执行' }),
      ]),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await page.goto(`/chats/${chatId}`)
    await composerSend(page, '开始流程')

    // HumanInput 挂起：系统消息出现「确认方案」提示
    await expect(page.locator('.chat-msg-system').last()).toContainText('确认方案', { timeout: 15_000 })

    // 下一条用户消息 = 人类答案：同一条挂起的流恢复，B 的输出流出
    await composerSend(page, '采用方案一')
    await expect(page.locator('.chat-msg-assistant').last().locator('.assistant-content')).toContainText(
      'TR04-B-EXECUTED',
      { timeout: 15_000 },
    )

    // 落库：assistant = B 输出；答案作为 user 消息也在
    await pollDb<{ role: string; content: string }>(
      ctx,
      `SELECT role, content FROM chat_messages WHERE chat_id = $1`,
      [chatId],
      (rows) => rows.some((r) => r.role === 'assistant' && r.content.includes('TR04-B-EXECUTED')),
    )
  })

  test('TR-05: SSE 错误帧 —— 失败可见、不落 assistant、服务不崩', async ({ request }) => {
    await setMockLlmScript({
      rules: [{ match: { systemContains: 'You are TR-05-FAIL' }, respond: { mode: 'error' } }],
      fallback: { text: 'mock: unexpected' },
    })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr05-fail',
      flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are TR-05-FAIL.', prompt: 'boom' })]),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: 'user', content: '触发失败' },
    })
    const frames = await readSse(`/api/chats/${chatId}/stream`)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    // SseStreamer 契约：error 帧即终止帧（流关闭，其后的 end 被丢弃）
    expect(frames[frames.length - 1].event).toBe('error')

    // 失败 run 不落 assistant 消息
    const { records: assistantRows } = await ctx.db.runQuery(
      `SELECT id FROM chat_messages WHERE chat_id = $1 AND role = 'assistant'`,
      [chatId],
    )
    expect(assistantRows).toHaveLength(0)

    // 服务端未崩：紧接一个 API run 正常返回
    const okFlow = await seedFlow(ctx, request, {
      name: 'e2e-tr05-after',
      flowData: linearFlow([llmNode('ok', { systemPrompt: 'You are fine.', prompt: 'ok' })]),
    })
    await setMockLlmScript({ fallback: { text: 'TR05-ALIVE' } })
    const okRun = await request.post(`/api/workflows/${okFlow}/run`, { data: { input: 'alive?' } })
    ctx.runIds.push(okRun.headers()['x-run-id'] as string)
    expect(okRun.status()).toBe(200)
  })

  test('TR-06: 未绑定 flow 的 chat —— stream 端点明确报错不挂死', async ({ request }) => {
    const directoryId = await seedDirectory(ctx)
    const chatId = await seedChat(ctx, { directoryId }) // 无 flow、无 agent

    // 不 POST 消息：auto-agent 路径会绑定真实 agent 并 spawn 本地 CLI（e2e
    // 不可控）；这里断言的是 stream 端点对无 flow chat 的明确错误契约。
    const res = await request.get(`/api/chats/${chatId}/stream`)
    expect([400, 500]).toContain(res.status())
    const body = await res.json()
    expect(JSON.stringify(body)).toContain('flow_id')
  })

  test('TR-07: 流式 token 与最终落库一致', async ({ request }) => {
    const mockText = 'TR07-CONSISTENT-REPLY-内容一致性'
    await setMockLlmScript({ fallback: { text: mockText, streamChunkSize: 5, streamIntervalMs: 20 } })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr07-consistency',
      flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are TR-07.', prompt: '回复' })]),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: 'user', content: '一致性检查' },
    })
    const frames = await readSse(`/api/chats/${chatId}/stream`)
    const streamed = tokenText(frames)
    expect(streamed).toBe(mockText)

    const rows = await pollDb<{ content: string }>(
      ctx,
      `SELECT content FROM chat_messages WHERE chat_id = $1 AND role = 'assistant'`,
      [chatId],
      (rs) => rs.length > 0,
    )
    // 浏览器渲染（流式拼接）== DB 落库内容
    expect(rows[0].content).toBe(streamed)
  })

  test('TR-08: 聊天运行历史 —— runs API 契约 + run_id 关联', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'TR08-RUN-REPLY' } })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-tr08-history',
      flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are TR-08.', prompt: '回复' })]),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: 'user', content: 'run 历史检查' },
    })
    const streamRes = await fetch(`${CONSOLE_BASE}/api/chats/${chatId}/stream`, { headers: { accept: 'text/event-stream' } })
    const runId = streamRes.headers.get('x-run-id')
    await streamRes.text() // drain to end（触发 assistant 落库）
    expect(runId).toBeTruthy()

    // GET /chats/:id/runs 契约（chat 路径不写 runs 表，items 可能为空）
    const runsRes = await request.get(`/api/chats/${chatId}/runs`)
    expect(runsRes.status()).toBe(200)
    const runsBody = await runsRes.json()
    expect(Array.isArray(runsBody.data?.items)).toBe(true)

    // run 关联的真实载体：assistant 消息带 run_id
    const rows = await pollDb<{ run_id: string | null }>(
      ctx,
      `SELECT run_id FROM chat_messages WHERE chat_id = $1 AND role = 'assistant'`,
      [chatId],
      (rs) => rs.length > 0 && rs[0].run_id != null,
    )
    expect(rows[0].run_id).toBe(runId)
  })
})
