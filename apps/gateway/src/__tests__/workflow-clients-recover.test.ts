/**
 * R8 可恢复性单测（design-recover §⑥ / §3.6）：
 *  - pin 禁降级（AC-R8-3）：modelPinned 的调用遇 provider 瞬时故障/熔断——
 *    响亮失败（providerFailure 错误对象 + 「因 pin 拒绝降级」活动行），
 *    CLI 兜底零调用；未 pin + 全局闸关 = 原样抛（基线对照）。
 *  - 会话延续表取值单源（AC-R8-1 后半，§3.6(a)）：首次不传、chat 收尾采集
 *    真实 backendSessionId、同键重入查表透传（claude 档）、显式传入优先、
 *    collectRunSessions 只回本 run 的 claude 会话——自铸 deriveSessionId
 *    永不进入 ExecOptions.resumeSessionId（取值单源约束的运行时钉子）。
 * 风格对齐 workflow-clients-resume.test.ts（scripted backend + vi.mock db）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const scripted = vi.hoisted(() => ({
  events: [] as unknown[],
  result: null as unknown,
  execOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@dagents/db', () => ({
  // pin 路径走 createDefaultLlmClient → getActiveProvider：按 SQL 分流回
  // 一行 active provider（fetch 由 stub 返回 500——瞬时故障注入）。
  runQuery: vi.fn().mockImplementation(async (sql: string) => {
    if (/llm_providers/.test(sql)) {
      return {
        records: [
          {
            id: 'prov-pin-1',
            base_url: 'http://127.0.0.1:9',
            api_key: 'sk-test',
            default_model: 'default-m',
            provider_type: 'openai',
          },
        ],
        affected: 0,
      }
    }
    return { records: [], affected: 0 }
  }),
}))

vi.mock('@dagents/agent-adapters', () => ({
  createBackend: () => ({
    execute: (_prompt: string, opts: Record<string, unknown>) => {
      scripted.execOptions.push(opts)
      return {
        events: (async function* () {
          for (const e of scripted.events) yield e
        })(),
        result: Promise.resolve(scripted.result),
      }
    },
  }),
}))

import {
  createDefaultLlmClient,
  createCliLlmClient,
  deriveSessionId,
  collectRunSessions,
  sendToRunNode,
  sendToRunNodeAmbiguous,
  resetRunNodeSessionsForTest,
  type CliChatParams,
} from '../routes/workflow-clients.js'
import { recordLlmFailure } from '../lib/llm-breaker.js'
import type { IStreamDelta } from '@dagents/workflow'

function completedResult(output: string, sessionId?: string): unknown {
  return { status: 'completed', output, durationMs: 1, usage: {}, sessionId }
}

beforeEach(() => {
  resetRunNodeSessionsForTest()
  scripted.events = []
  scripted.result = null
  scripted.execOptions = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.LLM_HTTP_RETRY_ATTEMPTS
  delete process.env.DAGENTS_DISABLE_LLM_FALLBACK
  vi.restoreAllMocks()
})

/** stub fetch 返回 5xx（瞬时故障——isRetryableStatus 命中）。 */
function stubFetch500(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ),
  )
}

const baseChatParams = (over: Partial<CliChatParams> = {}): CliChatParams => ({
  model: 'pinned-m',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
})

describe('pin 禁降级（AC-R8-3，§3.6(d)）', () => {
  it('modelPinned + provider 500：响亮失败（providerFailure/期望模型/活动行），CLI 零调用', async () => {
    process.env.LLM_HTTP_RETRY_ATTEMPTS = '1'
    stubFetch500()
    const deltas: IStreamDelta[] = []
    const client = createDefaultLlmClient('claude', {})
    const err = await client
      .chat(baseChatParams({ modelPinned: true, onDelta: (d) => deltas.push(d) }))
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('因 pin 拒绝降级（期望模型 pinned-m）')
    expect((err as { providerFailure?: boolean }).providerFailure).toBe(true)
    expect((err as { expectedModel?: string }).expectedModel).toBe('pinned-m')
    // 过程流活动行（AC-R8-3：明示「因 pin 拒绝降级」）
    expect(
      deltas.some(
        (d) => d.type === 'activity' && d.label.includes('因 pin 拒绝降级'),
      ),
    ).toBe(true)
    // CLI 兜底零调用（降级被拒）
    expect(scripted.execOptions).toHaveLength(0)
  })

  it('未 pin + 全局闸关（DAGENTS_DISABLE_LLM_FALLBACK=1）：原样抛 provider 错误（基线对照，非 pin 包装）', async () => {
    process.env.LLM_HTTP_RETRY_ATTEMPTS = '1'
    process.env.DAGENTS_DISABLE_LLM_FALLBACK = '1'
    stubFetch500()
    const client = createDefaultLlmClient('claude', {})
    const err = await client
      .chat(baseChatParams({}))
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('LLM API error 500')
    expect((err as { providerFailure?: boolean }).providerFailure).toBeUndefined()
    expect(scripted.execOptions).toHaveLength(0)
  })

  it('modelPinned + 熔断开启：同样拒绝降级（含熔断上下文的活动行）', async () => {
    // 熔断器按 provider 连续瞬时失败计数——3 次即开（llm-breaker 语义）
    for (let i = 0; i < 3; i++) recordLlmFailure('prov-pin-1')
    const deltas: IStreamDelta[] = []
    const client = createDefaultLlmClient('claude', {})
    const err = await client
      .chat(baseChatParams({ modelPinned: true, onDelta: (d) => deltas.push(d) }))
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('因 pin 拒绝降级（期望模型 pinned-m）')
    expect((err as { providerFailure?: boolean }).providerFailure).toBe(true)
    expect(
      deltas.some((d) => d.type === 'activity' && d.label.includes('熔断中')),
    ).toBe(true)
    expect(scripted.execOptions).toHaveLength(0)
  })
})

describe('会话延续表（AC-R8-1 取值单源，§3.6(a)）', () => {
  it('首次不传（诚实首跑）→ chat 收尾采集真实 sessionId → 同键重入查表透传 --resume', async () => {
    const client = createCliLlmClient('claude', undefined, 'run-sess-1')
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-real-1')

    // 首次：无显式 resumeSessionId、表空 → ExecOptions 无该键
    const first = await client.chat(
      baseChatParams({ model: '', nodeId: 'n1', ordinal: 0 }),
    )
    expect(first.sessionId).toBe('sess-real-1')
    expect('resumeSessionId' in scripted.execOptions[0]!).toBe(false)

    // 采集：deriveSessionId(run,node,ordinal) → 后端真实会话 id
    const key = deriveSessionId('run-sess-1', 'n1', 0)
    expect(collectRunSessions('run-sess-1')).toEqual({ [key]: 'sess-real-1' })

    // 重入（同键）：查表命中 → 透传真实 id（跨轮 --resume 延续）
    scripted.events = [{ type: 'text', content: 'b' }]
    scripted.result = completedResult('b', 'sess-real-1')
    await client.chat(baseChatParams({ model: '', nodeId: 'n1', ordinal: 0 }))
    expect(scripted.execOptions[1]!.resumeSessionId).toBe('sess-real-1')
  })

  it('显式 resumeSessionId 优先于查表（R5 透传协议同一取值单源）', async () => {
    const client = createCliLlmClient('claude', undefined, 'run-sess-2')
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-table')
    await client.chat(baseChatParams({ model: '', nodeId: 'n2', ordinal: 0 }))
    // 表内已有 sess-table；显式传入 sess-explicit → 用显式值
    scripted.result = completedResult('a', 'sess-explicit')
    await client.chat(
      baseChatParams({ model: '', nodeId: 'n2', ordinal: 0, resumeSessionId: 'sess-explicit' }),
    )
    expect(scripted.execOptions[1]!.resumeSessionId).toBe('sess-explicit')
  })

  it('非 claude kind：查表不透传（诚实降级为逻辑会话，AC-R8-6 边界）', async () => {
    const client = createCliLlmClient('codex', undefined, 'run-sess-3')
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-codex')
    await client.chat(baseChatParams({ model: '', nodeId: 'n3', ordinal: 0 }))
    // codex 档采集不进 claude 延续面：collectRunSessions 不回
    expect(collectRunSessions('run-sess-3')).toEqual({})
    // 重入：ExecOptions 无 resumeSessionId（不透传）
    await client.chat(baseChatParams({ model: '', nodeId: 'n3', ordinal: 0 }))
    expect('resumeSessionId' in scripted.execOptions[1]!).toBe(false)
  })

  it('initialSessions（跨进程注入 frozen_agents.sessions）：命中即透传', async () => {
    const key = deriveSessionId('run-sess-4', 'n4', 2)
    const client = createCliLlmClient('claude', undefined, 'run-sess-4', {
      [key]: 'sess-cross-process',
    })
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-cross-process')
    await client.chat(baseChatParams({ model: '', nodeId: 'n4', ordinal: 2 }))
    expect(scripted.execOptions[0]!.resumeSessionId).toBe('sess-cross-process')
  })

  it('ordinal 维度隔离：同 nodeId 不同 ordinal 是不同键（并发迭代多会话）', async () => {
    const client = createCliLlmClient('claude', undefined, 'run-sess-5')
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-ord-0')
    await client.chat(baseChatParams({ model: '', nodeId: 'n5', ordinal: 0 }))
    // ordinal 1：另一实例——表内 ordinal 0 的会话不串
    scripted.result = completedResult('a', 'sess-ord-1')
    await client.chat(baseChatParams({ model: '', nodeId: 'n5', ordinal: 1 }))
    expect(scripted.execOptions[1]!.resumeSessionId).toBeUndefined()
    const collected = collectRunSessions('run-sess-5')
    expect(collected[deriveSessionId('run-sess-5', 'n5', 0)]).toBe('sess-ord-0')
    expect(collected[deriveSessionId('run-sess-5', 'n5', 1)]).toBe('sess-ord-1')
  })

  it('collectRunSessions 按 run 过滤（跨 run 不串）', async () => {
    const client = createCliLlmClient('claude', undefined, 'run-sess-6')
    scripted.events = [{ type: 'text', content: 'a' }]
    scripted.result = completedResult('a', 'sess-6')
    await client.chat(baseChatParams({ model: '', nodeId: 'n6', ordinal: 0 }))
    expect(collectRunSessions('run-sess-other')).toEqual({})
  })
})

describe('插话寻址基础语义（R8.5，§3.6(e)）', () => {
  it('无活会话：sendToRunNode not_running；ambiguous 清单载荷为 null', () => {
    expect(sendToRunNode('run-none', 'nX', 'hi')).toBe('not_running')
    expect(sendToRunNodeAmbiguous('run-none', 'nX')).toBeNull()
  })
})
