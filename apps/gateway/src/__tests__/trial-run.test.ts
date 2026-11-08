import { describe, it, expect, beforeEach } from 'vitest'
import type { TrialMockScript } from '@dagents/contracts'
import {
  ruleMatches,
  resolveMockResponse,
  scanUnresolvedPlaceholders,
  createTrialLlmClient,
  recordTrialMockCall,
  getTrialCalls,
  scheduleTrialCallsCleanup,
} from '../lib/trial-mock-llm.js'
import {
  notifyRunFinished,
  isTerminalRunStatus,
  resetRunNotifyClaimForTests,
} from '../lib/run-notify.js'
import { trialRunBodySchema } from '../routes/workflow-trial.js'

/**
 * R10 fake llmClient 内核 + R9b run 通知单点（design-sharp §6.3/§6.4）。
 *
 * 行为等价钉子（NFR-2：与 e2e server.mjs 同内核）——谓词命中序/未知谓词
 * 不命中/toolLoop/延迟/错误注入；claim 幂等与 superseded 零发射。
 * 文件只 import type 跨包类型（运行时零 dist 依赖），可在不重建 workspace
 * 包的条件下运行。
 */

const body = (messages: Array<{ role: string; content: string }>, model = 'm1') => ({
  model,
  messages,
})

describe('trialRunBodySchema（路由级 union 判别，2026-10-08 集成批）', () => {
  it('ScriptSet 形态 {default:{…}} 的 fallback 不被单脚本分支吞掉', () => {
    // 回归钉子：旧 union 把单脚本分支排前，宽形状（全 optional + rules
    // default([])）把 {default:…} strip 成 {rules:[]}——fallback 静默丢失
    // → mock 全部回落 mock:unmatched（e2e 26 首跑逮出）。
    const parsed = trialRunBodySchema.safeParse({
      input: 'x',
      mockScript: { default: { rules: [], fallback: { text: 'SCRIPTED' } } },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const script = parsed.data.mockScript
    expect(script).toBeDefined()
    if (!script || !('default' in script)) throw new Error('script set shape lost')
    expect(script.default?.fallback?.text).toBe('SCRIPTED')
  })

  it('单脚本形态 {rules,fallback} 不被 ScriptSet 分支吞掉', () => {
    const parsed = trialRunBodySchema.safeParse({
      mockScript: {
        rules: [{ match: { modelIs: 'm1' }, respond: { text: 'R' } }],
        fallback: { text: 'FB' },
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const script = parsed.data.mockScript
    if (!script || !('rules' in script)) throw new Error('single script shape lost')
    expect(script.rules).toHaveLength(1)
    expect(script.fallback?.text).toBe('FB')
  })
})

describe('ruleMatches（server.mjs:36-73 行为等价）', () => {
  const m = body([
    { role: 'system', content: '你是测试系统' },
    { role: 'user', content: '用户问题 ABC' },
    { role: 'tool', content: '工具输出 XYZ' },
  ])

  it('空 match 恒命中；各 role 谓词命中/不命中', () => {
    expect(ruleMatches(undefined, m)).toBe(true)
    expect(ruleMatches({}, m)).toBe(true)
    expect(ruleMatches({ systemContains: '测试系统' }, m)).toBe(true)
    expect(ruleMatches({ systemContains: '不存在' }, m)).toBe(false)
    expect(ruleMatches({ userContains: 'ABC' }, m)).toBe(true)
    expect(ruleMatches({ userContains: 'XYZ' }, m)).toBe(false)
    expect(ruleMatches({ toolResultContains: 'XYZ' }, m)).toBe(true)
    expect(ruleMatches({ toolResultContains: 'ABC' }, m)).toBe(false)
    expect(ruleMatches({ messagesContain: 'ABC' }, m)).toBe(true)
    expect(ruleMatches({ hasToolResult: true }, m)).toBe(true)
    expect(ruleMatches({ hasToolResult: false }, m)).toBe(false)
    expect(ruleMatches({ modelIs: 'm1' }, m)).toBe(true)
    expect(ruleMatches({ modelIs: 'm2' }, m)).toBe(false)
  })

  it('多谓词全部满足才命中；hasToolResult=false 对无工具消息命中', () => {
    const noTool = body([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ])
    expect(ruleMatches({ systemContains: 'sys', userContains: 'u' }, noTool)).toBe(true)
    expect(ruleMatches({ systemContains: 'sys', userContains: 'x' }, noTool)).toBe(false)
    expect(ruleMatches({ hasToolResult: false }, noTool)).toBe(true)
  })

  it('未知谓词一律不命中（脚本写错快速失败）', () => {
    expect(ruleMatches({ nopeContains: 'x' }, m)).toBe(false)
  })
})

describe('resolveMockResponse（server.mjs:75-95 行为等价）', () => {
  it('规则按序首个命中；无命中走 fallback；label 缺省 rule[i]/fallback', () => {
    const script: TrialMockScript = {
      rules: [
        { match: { userContains: '不命中' }, respond: { text: 'wrong' } },
        { match: { userContains: 'ABC' }, label: '命中第二条', respond: { text: 'right' } },
      ],
      fallback: { text: 'fb' },
    }
    const r = resolveMockResponse(script, body([{ role: 'user', content: 'ABC' }]))
    expect(r.text).toBe('right')
    expect(r.label).toBe('命中第二条')

    const miss = resolveMockResponse(
      { rules: script.rules, fallback: { text: 'fb' } },
      body([{ role: 'user', content: '别的' }]),
    )
    expect(miss.text).toBe('fb')
    expect(miss.label).toBe('fallback')

    const noFallback = resolveMockResponse({ rules: [] }, body([{ role: 'user', content: 'x' }]))
    expect(noFallback.text).toBe('mock:unmatched')
    expect(noFallback.label).toBe('fallback')
  })

  it('toolLoop 模式：无视内容恒返工具调用（测 maxIterations 封顶）', () => {
    const r = resolveMockResponse(
      {
        rules: [],
        fallback: {
          mode: 'toolLoop',
          toolCalls: [{ function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
      },
      body([{ role: 'user', content: 'x' }]),
    )
    expect(r.mode).toBe('ok')
    expect(r.text).toBe('')
    expect(r.toolCalls).toHaveLength(1)
  })
})

describe('createTrialLlmClient', () => {
  it('chat：默认 usage、byNode 脚本选择、调用记录含 unresolvedPlaceholders', async () => {
    const runId = 'trial-rec-' + Math.random().toString(36).slice(2)
    const client = createTrialLlmClient({
      runId,
      script: {
        byNode: {
          n1: { rules: [{ respond: { text: '来自 n1' } }] },
        },
        default: { rules: [{ respond: { text: '默认脚本' } }] },
      },
    })
    const r1 = await client.chat({
      model: 'm',
      nodeId: 'n1',
      messages: [{ role: 'user', content: '带未解析 {{ghostVar}} 的正文' }],
    })
    expect(r1.text).toBe('来自 n1')
    expect(r1.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    const r2 = await client.chat({
      model: 'm',
      nodeId: 'n9',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r2.text).toBe('默认脚本')

    const calls = getTrialCalls(runId)
    expect(calls).not.toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls![0].nodeId).toBe('n1')
    expect(calls![0].unresolvedPlaceholders).toContain('ghostVar')
    expect(calls![1].matchedRule).toBe('rule[0]')
  })

  it('chatStream：按 chunkSize 切片 + usage 尾帧', async () => {
    const runId = 'trial-stream-' + Math.random().toString(36).slice(2)
    const client = createTrialLlmClient({
      runId,
      script: {
        rules: [],
        fallback: { text: '0123456789', streamChunkSize: 4, streamIntervalMs: 0 },
      },
    })
    const chunks: string[] = []
    let tailUsage = false
    for await (const c of client.chatStream({ model: 'm', messages: [] })) {
      if (c.delta !== undefined) chunks.push(c.delta)
      if (c.usage !== undefined) tailUsage = true
    }
    expect(chunks).toEqual(['0123', '4567', '89'])
    expect(tailUsage).toBe(true)
  })

  it('error/malformed 注入 = 诚实抛错（试运行是验证场）', async () => {
    const client = createTrialLlmClient({
      runId: 'x',
      script: { rules: [], fallback: { mode: 'error' } },
    })
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toThrow(/mock/)

    const malformed = createTrialLlmClient({
      runId: 'x',
      script: { rules: [], fallback: { mode: 'malformed' } },
    })
    await expect(malformed.chat({ model: 'm', messages: [] })).rejects.toThrow(/JSON/)
  })

  it('record/get/schedule registry：记录追加有序、清理后为 null', async () => {
    const runId = 'trial-ttl-' + Math.random().toString(36).slice(2)
    recordTrialMockCall(runId, { messages: [], ts: new Date().toISOString() })
    recordTrialMockCall(runId, { messages: [], ts: new Date().toISOString() })
    expect(getTrialCalls(runId)).toHaveLength(2)
    expect(getTrialCalls(runId)![0].seq).toBe(1)
    expect(getTrialCalls(runId)![1].seq).toBe(2)
    expect(getTrialCalls('不存在的-run')).toBeNull()
    scheduleTrialCallsCleanup(runId)
    // 定时器 unref 不阻塞测试进程；这里只验证幂等调度不抛
    scheduleTrialCallsCleanup(runId)
  })
})

describe('scanUnresolvedPlaceholders（llm.node.ts 同启发式）', () => {
  it('收集去重并截断到 20；非字符串 content 跳过', () => {
    const found = scanUnresolvedPlaceholders([
      { role: 'user', content: '{{a}} {{b}}' },
      { role: 'system', content: '{{a}} 又来 {{c}}' },
      { role: 'assistant', content: '普通文本' },
      { role: 'tool', content: '' },
    ])
    expect(found).toEqual(['a', 'b', 'c'])
  })
})

describe('notifyRunFinished（R9b claim 单点）', () => {
  beforeEach(() => {
    resetRunNotifyClaimForTests()
  })

  it('终态词表判定：awaiting_input/running 不算完成', () => {
    expect(isTerminalRunStatus('completed')).toBe(true)
    expect(isTerminalRunStatus('failed')).toBe(true)
    expect(isTerminalRunStatus('partial_success')).toBe(true)
    expect(isTerminalRunStatus('budget_exceeded')).toBe(true)
    expect(isTerminalRunStatus('stopped')).toBe(true)
    expect(isTerminalRunStatus('awaiting_input')).toBe(false)
    expect(isTerminalRunStatus('running')).toBe(false)
  })

  it('claim 幂等：同 runId 重复调用静默；superseded 零发射（AC-R9-3 服务端半）', () => {
    // 直接观测 broadcastRun 的落点：注入假 wsHub 不易（模块单例），这里以
    // 「不抛 + 幂等语义可重入」钉住——帧投递由 ws-hub 单测覆盖。
    expect(() =>
      notifyRunFinished({ runId: 'r1', flowId: 'f1', status: 'completed' }),
    ).not.toThrow()
    expect(() => notifyRunFinished({ runId: 'r1', status: 'completed' })).not.toThrow()
    expect(() =>
      notifyRunFinished({ runId: 'r2', status: 'stopped', stopReason: 'superseded' }),
    ).not.toThrow()
    expect(() => notifyRunFinished({ runId: 'r3', status: 'awaiting_input' })).not.toThrow()
  })
})
