/**
 * PlatformAgentNode — 节点级任务指令（systemPrompt）回归。
 *
 * 背景：流程里多个节点常绑同一个 Agent（如 @workflow 生成的
 * 规划/开发/验证链）。没有节点级指令时，节点 label 只是显示文案，
 * 模型完全不知道自己这一步的职责 —— 所以 inputs.systemPrompt 会
 * 追加在 Agent 自身 instructions 之后进入 system prompt。
 */
import { describe, it, expect } from 'vitest'
import { PlatformAgentNode, VERDICT_MAX_INTERACTIONS } from './platform-agent.node.js'
import type { IExecutionContext, IStreamDelta, IAgentTool } from '../../types/execution.js'

interface Capture {
  system: string
  user: string
}

function makeContext(capture: Capture): IExecutionContext {
  return {
    state: {},
    agentFetcher: async () => ({
      id: 'agent-1',
      name: 'claude',
      instructions: '你是平台 Agent。',
      model: '',
      kind: 'claude',
      skills: [],
    }),
    llmClient: {
      // Capture what the node actually sends — the whole point of the test.
      chat: async (params: { messages: { role: string; content: string }[] }) => {
        capture.system = params.messages.find((m) => m.role === 'system')?.content ?? ''
        capture.user = params.messages.find((m) => m.role === 'user')?.content ?? ''
        return { text: 'ok' }
      },
    },
  } as unknown as IExecutionContext
}

describe('PlatformAgentNode — 节点级任务指令', () => {
  it('appends the node task after the agent instructions', async () => {
    const capture: Capture = { system: '', user: '' }
    const node = new PlatformAgentNode()
    await node.run(
      {
        id: 'n1',
        name: 'platformAgentAgentflow',
        inputs: {
          agentId: 'agent-1',
          systemPrompt: '你是需求规划角色：根据输入产出结构化 PRD。',
        },
      },
      '用户的原始需求',
      makeContext(capture),
    )
    expect(capture.system).toContain('你是平台 Agent。')
    expect(capture.system).toContain('你是需求规划角色：根据输入产出结构化 PRD。')
    // Agent instructions come first — persona before task.
    expect(capture.system.indexOf('你是平台 Agent。')).toBeLessThan(
      capture.system.indexOf('你是需求规划角色'),
    )
    expect(capture.user).toBe('用户的原始需求')
  })

  it('degrades cleanly when the node carries no task instruction', async () => {
    const capture: Capture = { system: '', user: '' }
    const node = new PlatformAgentNode()
    await node.run(
      {
        id: 'n2',
        name: 'platformAgentAgentflow',
        inputs: { agentId: 'agent-1' },
      },
      '输入',
      makeContext(capture),
    )
    expect(capture.system).toContain('你是平台 Agent。')
    expect(capture.system).not.toContain('需求规划')
  })

  it('throws on an empty final answer instead of returning an empty success', async () => {
    // 空产出守卫（2026-08-27）：真实复跑中 Agent 一轮跑完 0 字正文仍标
    // done —— 与 llm.node 同款诚实失败。
    const ctx = makeContext({ system: '', user: '' })
    ctx.llmClient = {
      chat: async () => ({ text: '' }),
    }
    const node = new PlatformAgentNode()
    await expect(
      node.run(
        {
          id: 'n3',
          name: 'platformAgentAgentflow',
          inputs: { agentId: 'agent-1' },
        },
        '输入',
        ctx,
      ),
    ).rejects.toThrow(/返回空内容/)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 三值裁决（2026-10-07 R5，docs/zcode-borrow/design-verdict.md §6.1）。
 *
 * 载具：可编程 mock llmClient（脚本化响应序列 + 全量 chat 调用捕获），
 * 钉四件事：① 裁决三分支与回喂消息形状（path/期望/actual 三元组）；
 * ② 预算钉死（VERDICT_MAX_INTERACTIONS=3，恒违规恰 3 次、恒空文本恰 2 次）；
 * ③ 能力披露协议（sessionId 有 → resume 增量；无 → 全量回放 + 会话重建行）；
 * ④ verdict 活动（kind:'verdict'，label 含轮次/结果，detail 含违规行）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 脚本化 chat 响应（按调用序消费；耗尽后重复末条）。 */
interface Scripted {
  text: string
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
  sessionId?: string
}

/** 捕获到的一次 chat 调用（回喂断言的证据面）。 */
interface CapturedChat {
  messages: Array<{ role: string; content: string }>
  tools?: unknown
  resumeSessionId?: string
}

const VERDICT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'reason'],
})
/** 违规产出：enum 未命中（decision=maybe）+ 必填缺失（reason 不在场）。 */
const BAD_JSON = '{"decision":"maybe"}'
const GOOD_JSON = '{"decision":"accept","reason":"looks good"}'

const pingTool: IAgentTool = {
  name: 'ping',
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
  handler: async () => 'pong',
}

function makeVerdictHarness(opts: {
  responses: Scripted[]
  toolRegistry?: Record<string, IAgentTool>
}): { ctx: IExecutionContext; calls: CapturedChat[]; deltas: IStreamDelta[] } {
  const calls: CapturedChat[] = []
  const deltas: IStreamDelta[] = []
  let i = 0
  const ctx = {
    state: {},
    agentFetcher: async () => ({
      id: 'agent-v',
      name: 'verdict-agent',
      instructions: '你是裁决测试 Agent。',
      model: '',
      kind: 'claude',
      skills: [],
    }),
    toolRegistry: opts.toolRegistry,
    onNodeDelta: (chunk: IStreamDelta) => deltas.push(chunk),
    llmClient: {
      chat: async (params: {
        messages: Array<{ role: string; content: string }>
        tools?: unknown
        resumeSessionId?: string
      }) => {
        calls.push({
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          tools: params.tools,
          resumeSessionId: params.resumeSessionId,
        })
        const r = opts.responses[Math.min(i, opts.responses.length - 1)]
        i += 1
        return {
          text: r.text,
          ...(r.toolCalls ? { tool_calls: r.toolCalls } : {}),
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        }
      },
    },
  } as unknown as IExecutionContext
  return { ctx, calls, deltas }
}

function verdictNodeData(
  overrides: Record<string, unknown> = {},
): Parameters<PlatformAgentNode['run']>[0] {
  return {
    id: 'v1',
    name: 'platformAgentAgentflow',
    inputs: { agentId: 'agent-v', outputSchema: VERDICT_SCHEMA, ...overrides },
  }
}

describe('PlatformAgentNode — 三值裁决（R5）', () => {
  it('首轮合规直收：输出带 json 字段，零回喂消息、零 verdict 活动', async () => {
    const { ctx, calls, deltas } = makeVerdictHarness({ responses: [{ text: GOOD_JSON }] })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(1)
    // 契约块编进了 system 头（Agent 知道要交付什么形状）
    expect(calls[0]!.messages[0]!.content).toContain('JSON Schema')
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
    expect(out.output.text).toBe(GOOD_JSON)
    // 首轮直收：没有发生任何轮次，就没有可审计的裁决活动
    expect(deltas).toHaveLength(0)
  })

  it('violations → 修复回喂（path/期望/实际 三元组）→ 第 2 轮合规收下', async () => {
    const { ctx, calls, deltas } = makeVerdictHarness({
      responses: [{ text: BAD_JSON }, { text: GOOD_JSON }],
    })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(2)
    // 第 2 次 chat 的尾部 user 消息 = 修复回喂：含 path 定位 + 期望/实际
    const feed = calls[1]!.messages[calls[1]!.messages.length - 1]!
    expect(feed.role).toBe('user')
    expect(feed.content).toContain('$.decision')
    expect(feed.content).toContain('期望')
    expect(feed.content).toContain('实际')
    // 违规明细覆盖两类分支：enum 未命中 + 必填缺失
    expect(feed.content).toContain('$.reason')
    // 回放档（无 sessionId）：全量 messages 重放（system + user + assistant 回显 + 回喂）
    expect(calls[1]!.resumeSessionId).toBeUndefined()
    expect(calls[1]!.messages.length).toBeGreaterThan(2)
    expect(calls[1]!.messages.some((m) => m.role === 'assistant' && m.content === BAD_JSON)).toBe(
      true,
    )
    // 修复轮禁用工具声明
    expect(calls[1]!.tools).toBeUndefined()
    // verdict 活动：label 含轮次与结果，detail 含违规行
    const verdictActs = deltas.filter(
      (d) => d.type === 'activity' && d.kind === 'verdict',
    ) as Array<{ type: 'activity'; kind: string; label: string; detail?: string }>
    expect(verdictActs.length).toBeGreaterThanOrEqual(2)
    expect(verdictActs.some((a) => a.label.includes('第 1 轮裁决：violations'))).toBe(true)
    expect(verdictActs.some((a) => a.label.includes('第 2 轮裁决：accept'))).toBe(true)
    expect(verdictActs.some((a) => a.label.includes('会话重建'))).toBe(true)
    expect(verdictActs.some((a) => (a.detail ?? '').includes('$.decision'))).toBe(true)
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('no-deliverable（空文本）→ NUDGE 追问（停止调用工具）→ 第 2 轮合规收下', async () => {
    const { ctx, calls } = makeVerdictHarness({ responses: [{ text: '' }, { text: GOOD_JSON }] })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(2)
    const feed = calls[1]!.messages[calls[1]!.messages.length - 1]!
    expect(feed.content).toContain('停止调用工具')
    // 空轮的 assistant 回显占位可见（会话回放语义完整）
    expect(
      calls[1]!.messages.some((m) => m.role === 'assistant' && m.content === '(本轮无正文输出)'),
    ).toBe(true)
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('截断优先：maxIterations 耗尽 + 残余违规文本 → no-deliverable 走 NUDGE（非 repair）', async () => {
    const { ctx, calls, deltas } = makeVerdictHarness({
      responses: [
        {
          text: 'partial junk 不是 JSON',
          toolCalls: [{ id: 'c1', function: { name: 'ping', arguments: '{}' } }],
        },
        {
          text: 'partial junk 不是 JSON',
          toolCalls: [{ id: 'c2', function: { name: 'ping', arguments: '{}' } }],
        },
        { text: GOOD_JSON },
      ],
      toolRegistry: { ping: pingTool },
    })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData({ maxIterations: 2 }), '裁决输入', ctx)
    // 第 1 轮工具循环 2 次 chat（都请求工具）耗尽预算 → truncated → NUDGE
    expect(calls).toHaveLength(3)
    expect(deltas.some((d) => d.type === 'activity' && d.label.includes('no-deliverable'))).toBe(
      true,
    )
    const feed = calls[2]!.messages[calls[2]!.messages.length - 1]!
    expect(feed.content).toContain('停止调用工具')
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('两轮耗尽诚实失败：恒违规 → 节点失败、错误含 path/期望/实际、无空壳成功', async () => {
    const { ctx, calls } = makeVerdictHarness({ responses: [{ text: BAD_JSON }] })
    const node = new PlatformAgentNode()
    await expect(node.run(verdictNodeData(), '裁决输入', ctx)).rejects.toThrow(
      /\$\.decision.*期望.*实际/s,
    )
    // 预算钉死：原始 + 修复 + NUDGE 恰 3 次交互（AC-R5-6）
    expect(calls).toHaveLength(3)
    expect(VERDICT_MAX_INTERACTIONS).toBe(3)
  })

  it('恒空文本：NUDGE 用尽后同类第二次直接失败（类型去重分支）', async () => {
    const { ctx, calls } = makeVerdictHarness({ responses: [{ text: '' }] })
    const node = new PlatformAgentNode()
    await expect(node.run(verdictNodeData(), '裁决输入', ctx)).rejects.toThrow(
      /未交付符合 outputSchema 的产出/,
    )
    expect(calls).toHaveLength(2)
  })

  it('会话延续两档对照：sessionId 有 → resume 增量；无 → 全量回放（裁决结果一致）', async () => {
    // A 档（claude 类）：chat 返回 sessionId → 修复轮原样透传 + 只发增量
    const a = makeVerdictHarness({
      responses: [
        { text: BAD_JSON, sessionId: 's1' },
        { text: GOOD_JSON, sessionId: 's1' },
      ],
    })
    await new PlatformAgentNode().run(verdictNodeData(), '裁决输入', a.ctx)
    expect(a.calls[1]!.resumeSessionId).toBe('s1')
    expect(a.calls[1]!.messages).toHaveLength(1) // 只含本轮 user 回喂消息
    expect(a.calls[1]!.messages[0]!.role).toBe('user')
    expect(a.calls[1]!.messages[0]!.content).toContain('$.decision')
    // resume 档无「会话重建」活动行（AC-R5-2 ②）
    expect(a.deltas.some((d) => d.type === 'activity' && d.label.includes('会话重建'))).toBe(false)

    // B 档（HTTP 类）：无 sessionId → 全量回放 + 「会话重建」活动行
    const b = makeVerdictHarness({ responses: [{ text: BAD_JSON }, { text: GOOD_JSON }] })
    const outB = await new PlatformAgentNode().run(verdictNodeData(), '裁决输入', b.ctx)
    expect(b.calls[1]!.resumeSessionId).toBeUndefined()
    expect(b.calls[1]!.messages.length).toBeGreaterThan(2)
    expect(b.deltas.some((d) => d.type === 'activity' && d.label.includes('会话重建'))).toBe(true)
    // 同场景两档裁决结果一致（AC-R5-4）
    expect(outB.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('outputSchema 声明为非法 JSON 字符串 → 运行时诚实失败（可恢复的配置笔误）', async () => {
    const { ctx } = makeVerdictHarness({ responses: [{ text: GOOD_JSON }] })
    const node = new PlatformAgentNode()
    await expect(
      node.run(verdictNodeData({ outputSchema: '{not-json' }), '裁决输入', ctx),
    ).rejects.toThrow(/不是合法 JSON/)
  })

  /* ── 测试补齐批（2026-10-08）：裁决判据与能力披露协议的边角 ── */

  it('对象形态 outputSchema（非字符串）同样生效——与 LLM 节点双形态收法一致', async () => {
    // 画布 json 控件合法时提交的是解析后的对象（form-engine JsonWidget
    // commit 语义），节点侧必须原样收——不能只认字符串形态。
    const { ctx, calls, deltas } = makeVerdictHarness({
      responses: [{ text: BAD_JSON }, { text: GOOD_JSON }],
    })
    const node = new PlatformAgentNode()
    const out = await node.run(
      verdictNodeData({
        outputSchema: JSON.parse(VERDICT_SCHEMA) as Record<string, unknown>,
      }),
      '裁决输入',
      ctx,
    )
    // 对象形态下裁决循环照常激活：违规回喂 + 第 2 轮收下
    expect(calls).toHaveLength(2)
    expect(deltas.some((d) => d.type === 'activity' && d.label.includes('violations'))).toBe(true)
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('非 JSON 纯文本 → violations（path $ / 期望 JSON 对象 / got 前 80 字摘要）→ 修复', async () => {
    const { ctx, calls } = makeVerdictHarness({
      responses: [{ text: '这不是 JSON，只是一段自然语言的托辞。' }, { text: GOOD_JSON }],
    })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(2)
    const feed = calls[1]!.messages[calls[1]!.messages.length - 1]!
    // adjudicate 的 catch 分支：JSON 解析失败合成 $ 级 issue，三元组齐全
    expect(feed.content).toContain('$：期望 JSON 对象')
    expect(feed.content).toContain('这不是 JSON，只是一段自然语言的托辞。')
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })

  it('围栏 JSON 直收：```json 围栏包裹的合规产出 accept（extractJsonFromText 容忍）', async () => {
    // Agent CLI 常以 Markdown 围栏交付——裁决判据用的是 LLM 节点同款
    // extractJsonFromText，围栏不能误判 violations。
    const { ctx, calls } = makeVerdictHarness({
      responses: [{ text: '```json\n{"decision":"accept","reason":"fenced"}\n```' }],
    })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(1)
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'fenced' })
  })

  it('resume 失守回落回放：中间轮不再回 sessionId → 后续轮全量重放 + 会话重建留痕', async () => {
    // 能力披露协议的诚实边界：lastSessionId 每轮被 chat 返回覆盖（缺席即
    // 清空）——若实现只在有值时覆盖，第 3 轮会拿陈旧 s1 继续 resume，
    // 增量消息丢失全部上下文。本测试钉住回落语义。
    const { ctx, calls, deltas } = makeVerdictHarness({
      responses: [
        { text: BAD_JSON, sessionId: 's1' },
        { text: BAD_JSON }, // resume 轮不回 sessionId：能力失守
        { text: GOOD_JSON },
      ],
    })
    const node = new PlatformAgentNode()
    const out = await node.run(verdictNodeData(), '裁决输入', ctx)
    expect(calls).toHaveLength(3)
    // 第 2 轮：resume 档（s1 透传 + 只发增量）
    expect(calls[1]!.resumeSessionId).toBe('s1')
    expect(calls[1]!.messages).toHaveLength(1)
    // 第 3 轮：回落回放档——无 resumeSessionId、全量 messages（schema 契约
    // system 头仍在，回放真相源完整）
    expect(calls[2]!.resumeSessionId).toBeUndefined()
    expect(
      calls[2]!.messages.some((m) => m.role === 'system' && m.content.includes('JSON Schema')),
    ).toBe(true)
    expect(calls[2]!.messages.length).toBeGreaterThan(3)
    // 回放档发「会话重建」活动行（第 3 轮 NUDGE 追问的回喂活动）；第 2 轮
    // 修复回喂的活动仍是 resume 档（同会话 --resume）
    const feedActs = deltas.filter(
      (d) => d.type === 'activity' && (d.label.includes('回喂') || d.label.includes('追问')),
    ) as Array<{ label: string }>
    expect(feedActs.some((a) => a.label.includes('同会话 --resume'))).toBe(true)
    expect(feedActs.some((a) => a.label.includes('会话重建'))).toBe(true)
    expect(out.output.json).toEqual({ decision: 'accept', reason: 'looks good' })
  })
})
