/**
 * LLM client + agent fetcher + tool registry for workflow execution.
 *
 * The DagExecutor needs an `llmClient` (for LLM/Agent/PlatformAgent nodes), an
 * `agentFetcher` (for PlatformAgentNode) and a `toolRegistry` (built-in tools
 * for Agent tool-calling loops). All are provided by the gateway because they
 * need DB or network access — the workflow package stays storage-free.
 */

import { createHash } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { createBackend } from '@dagents/agent-adapters'
import { AgentStatus, type AgentEvent, type AgentSession, type AgentType } from '@dagents/contracts'
import type { IStreamDelta } from '@dagents/workflow'
import { decryptSecret } from '../crypto.js'
import { composeSystemPrompt } from '../skill-injection.js'
import { fetchWithRetry, isRetryableStatus } from '../lib/fetch-retry.js'
import {
  countLlmFallback,
  isLlmCircuitOpen,
  recordLlmFailure,
  recordLlmSuccess,
} from '../lib/llm-breaker.js'
import { acquireCliSlot } from '../lib/cli-spawn-gate.js'
import { declareCounter } from '../lib/metrics.js'
import {
  type IExecutionContext,
  type PlatformAgentConfig,
  type ITokenUsage,
  type IToolSchema,
  type IToolCall,
  type IAgentTool,
  type IChatMessage,
  type IChatStreamChunk,
  assertPublicHttpUrl,
} from '@dagents/workflow'

const log = createLogger({ svc: 'gateway:workflow-clients' })

const llmHttpTotal = declareCounter(
  'dagents_llm_http_requests_total',
  'HTTP LLM calls by outcome (ok / transient_error / config_error / fallback)',
  ['result'],
)

// ────────────────────────────────────────────────────────────────────────────
// 运行中节点会话汇点（2026-09-08 可操作终端 PRD，docs/prd-operable-terminal.md）
//
// `runId:nodeId:ordinal → 活着的 CLI 会话` 的进程内登记表：LLM/PlatformAgent
// 节点每次 chat 调用创建会话时注册（节点经 chat 参数上报自己的 nodeId +
// ordinal），插话路由 POST /workflows/runs/:runId/message 据此找到正确的 CLI
// stdin。PlatformAgent 工具循环每轮新建会话 —— 新会话覆盖注册；旧会话结束
// 时仅在表项仍指向自己时才清除，不误删后继会话。
//
// 2026-10-07 R8（design-recover §3.6(a)，PRD R8 风险条款声明的破坏性扩展）：
// 键从 `runId:nodeId` 扩为 `runId:nodeId:ordinal`——并发 iteration 的同节点
// 多会话并存可寻址；键的规范拼写 = `deriveSessionId(runId, nodeId, ordinal)`
// （dagents 侧确定性寻址键，AD-R6 划界：它不对应任何 CLI 后端会话，后端
// 真实会话 id 是另一空间、由 chat 返回值 sessionId 采集，绝不互换）。
// ────────────────────────────────────────────────────────────────────────────

/** 插话送达回执：sent=已写入 CLI stdin；unsupported=执行路径无双向通道
 *  （HTTP provider / 不支持插话的适配器）；not_running=节点当前没有活会话；
 *  ambiguous=该 nodeId 有多个并发实例、调用方须带 ordinal 重试（409 语义，
 *  PRD R8.5 定稿——附带活跃实例清单）。 */
export type NodeSendAck = 'sent' | 'unsupported' | 'not_running' | 'ambiguous'

/** 多实例歧义回执的载荷：活跃 ordinal 清单（客户端列供选择）。 */
export interface NodeSendAmbiguous {
  ack: 'ambiguous'
  ordinals: number[]
}

interface RunNodeSink {
  /** 会话的插话入口（contracts AgentSession.send；undefined = 适配器不支持）。 */
  send: ((text: string) => boolean) | undefined
  /** 该节点 chat 调用的增量通道 —— 送达后回写 user_input 事件进 span。 */
  onDelta: ((chunk: IStreamDelta) => void) | undefined
}

const runNodeSinks = new Map<string, RunNodeSink>()

/**
 * dagents 侧确定性会话寻址键（R8，design-recover §3.6(a)，AC-R8-1）：
 * SHA-1(runId:nodeId:ordinal) 前 16 hex——同键同 id、异 run 异 id、resume
 * 同节点同 id（可单测预测）。**绝不进 `ExecOptions.resumeSessionId`**（该字段
 * 取值单源 = 后端真实会话 id，见 CliChatParams.resumeSessionId 注释）；它只
 * 用于 runNodeSinks 键拼写 / resume 重挂查表 / 插话寻址。
 */
export function deriveSessionId(runId: string, nodeId: string, ordinal: number): string {
  return createHash('sha1').update(`${runId}:${nodeId}:${ordinal}`).digest('hex').slice(0, 16)
}

const sinkKey = (runId: string, nodeId: string, ordinal: number): string =>
  `${runId}:${nodeId}:${ordinal}`

function registerRunNodeSink(
  runId: string,
  nodeId: string,
  ordinal: number | undefined,
  session: AgentSession,
  onDelta: ((chunk: IStreamDelta) => void) | undefined,
): RunNodeSink {
  const sink: RunNodeSink = { send: session.send, onDelta }
  runNodeSinks.set(sinkKey(runId, nodeId, ordinal ?? 0), sink)
  return sink
}

/** 会话收尾：仅当表项仍指向本 sink 才清除（工具循环已换新会话时不覆盖）。 */
function unregisterRunNodeSink(
  runId: string,
  nodeId: string,
  ordinal: number | undefined,
  sink: RunNodeSink,
): void {
  const key = sinkKey(runId, nodeId, ordinal ?? 0)
  if (runNodeSinks.get(key) === sink) runNodeSinks.delete(key)
}

/** 该 nodeId 在本 run 下的活跃实例 ordinal 清单（多实例 409 的载荷）。 */
function liveOrdinalsOf(runId: string, nodeId: string): number[] {
  const prefix = `${runId}:${nodeId}:`
  const ordinals: number[] = []
  for (const key of runNodeSinks.keys()) {
    if (!key.startsWith(prefix)) continue
    const ordinal = Number(key.slice(prefix.length))
    if (Number.isFinite(ordinal)) ordinals.push(ordinal)
  }
  return ordinals.sort((a, b) => a - b)
}

/**
 * 插话路由（R8.5，design-recover §3.6(a)）：送达后经同一节点的增量通道回写
 * user_input（span-writer 落库，终端视图渲染为高亮行）。ordinal 缺省 = 该
 * nodeId 唯一活跃实例直接寻址；多实例并存（并发 iteration）返回 'ambiguous'
 * + 活跃实例清单（调用方映射 409，PRD R8.5 定稿）。
 */
export function sendToRunNode(
  runId: string,
  nodeId: string,
  text: string,
  ordinal?: number,
): NodeSendAck {
  if (ordinal == null) {
    const ordinals = liveOrdinalsOf(runId, nodeId)
    if (ordinals.length > 1) return 'ambiguous'
  }
  const sink = runNodeSinks.get(sinkKey(runId, nodeId, ordinal ?? 0))
  if (!sink) return 'not_running'
  if (!sink.send) return 'unsupported'
  if (!sink.send(text)) return 'not_running'
  sink.onDelta?.({ type: 'activity', kind: 'user_input', label: text })
  return 'sent'
}

/** 多实例歧义的清单载荷（路由层 409 响应用；本模块不感知 HTTP）。 */
export function sendToRunNodeAmbiguous(runId: string, nodeId: string): NodeSendAmbiguous | null {
  const ordinals = liveOrdinalsOf(runId, nodeId)
  return ordinals.length > 1 ? { ack: 'ambiguous', ordinals } : null
}

/** 该 run 当前是否有任何活着的 CLI 会话汇点（node-spans 端点的
 *  inputSupported 数据源 —— console 据此渲染 stdin 行的禁用态）。 */
export function runHasLiveSinks(runId: string): boolean {
  const prefix = `${runId}:`
  for (const key of runNodeSinks.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// ── 会话延续表（R8 §3.6(a)，进程内）────────────────────────────────────────
// deriveSessionId → 后端真实会话 id（chat 收尾从 result.sessionId 采集）。
// 同键重入（resume 重挂、工具循环新一轮）查表命中且 kind=claude → 透传
// `--resume`（跨进程后端会话延续——claude -p 一次问答即退，延续靠后端
// 会话而非进程存活）；非 claude kind 不透传（诚实降级为逻辑会话重放，
// AC-R8-6/R5 同款边界）。跨进程重挂查 runs.frozen_agents.sessions 载荷
// （执行路径终态经 collectRunSessions 落库，resume 路径注入 initialSessions）。

const backendSessions = new Map<string, { sessionId: string; kind: AgentType; runId: string }>()

function rememberBackendSession(
  derivedKey: string,
  sessionId: string | undefined,
  kind: AgentType,
  runId: string,
): void {
  if (!sessionId) return
  backendSessions.set(derivedKey, { sessionId, kind, runId })
}

/** 查表透传（取值单源：只回后端真实会话 id；未命中 = 不传，绝不伪造）。 */
function lookupBackendSession(derivedKey: string, kind: AgentType): string | undefined {
  const found = backendSessions.get(derivedKey)
  if (!found || found.kind !== 'claude' || kind !== 'claude') return undefined
  return found.sessionId
}

/**
 * 该 run 的会话映射采集（执行路径终态落 runs.frozen_agents.sessions 用）：
 * `{ [deriveSessionId]: backendSessionId }`——resume 跨进程重挂的查表数据源
 * （§1.2 的「实施时择一」落此：frozen_agents.sessions 载荷）。
 */
export function collectRunSessions(runId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of backendSessions) {
    if (entry.runId === runId && entry.kind === 'claude') out[key] = entry.sessionId
  }
  return out
}

/** 测试隔离（生产代码禁用）。 */
export function resetRunNodeSessionsForTest(): void {
  runNodeSinks.clear()
  backendSessions.clear()
}

/** LLM provider row from the `llm_providers` table. */
interface LlmProviderRow {
  id: string
  base_url: string
  api_key: string
  default_model: string
  provider_type: string
}

/** Cached LLM provider — fetched once per run, reused across nodes. */
let cachedProvider: LlmProviderRow | null = null
let providerFetchPromise: Promise<LlmProviderRow | null> | null = null

/**
 * Fetch the first active LLM provider. Cached after first call within a
 * process lifetime; use `resetProviderCache()` before each run to force
 * a fresh read (provider config may have changed).
 */
async function getActiveProvider(): Promise<LlmProviderRow | null> {
  if (cachedProvider) return cachedProvider
  if (providerFetchPromise) return providerFetchPromise

  providerFetchPromise = (async () => {
    try {
      const { records } = await runQuery<LlmProviderRow>(
        `SELECT id, base_url, api_key, default_model, provider_type
           FROM llm_providers
           WHERE status = 'active'
           ORDER BY created_at ASC
           LIMIT 1`,
        [],
      )
      cachedProvider = records[0] ?? null
      return cachedProvider
    } catch (err) {
      log.error('failed to fetch LLM provider', { error: String(err) })
      return null
    } finally {
      providerFetchPromise = null
    }
  })()

  return providerFetchPromise
}

/** CLI-backed chat params (mirrors the workflow engine's llmClient seam). */
export interface CliChatParams {
  model: string
  messages: { role: string; content: string }[]
  temperature?: number
  tools?: IToolSchema[]
  /** Cancellation signal (spec D3): aborts the HTTP fetch / kills the CLI child. */
  signal?: AbortSignal
  /** 增量产出回调（2026-08-30 流式展示）：text 增量 + thinking/工具活动。 */
  onDelta?: (chunk: IStreamDelta) => void
  /** 调用方节点 id（2026-09-08 可操作终端）：登记进插话汇点表用。 */
  nodeId?: string
  /**
   * per-node 执行实例序号（2026-10-07 R8，AD-R4）：节点经 buildNodeContext
   * 透传——runNodeSinks 键 / deriveSessionId / 插话寻址（nodeId[ordinal]）
   * 用；缺省 0（非迭代节点恒 0）。
   */
  ordinal?: number
  /**
   * 模型 pin 位（2026-10-07 R8.4，design-recover §3.6(d)）：节点/Agent 显式
   * 声明过模型时置位——pin 的调用**禁熔断/瞬时降级**（provider 故障响亮
   * 失败 stop_reason='provider'，错误含期望/实际模型 + 「因 pin 拒绝降级」
   * 活动行）；未声明维持基线（降级保可用，CLI 第一性不破坏）。
   */
  modelPinned?: boolean
  /**
   * 会话延续（2026-10-07 R5 三值裁决）：非空 = CLI 后端以 --resume 恢复该
   * 会话（claude 已接线）。取值单源——gateway 只透传节点层递来的上一轮
   * chat 返回的后端真实会话 id，本层不做任何 id 换算/铸造；不支持 resume
   * 的适配器静默忽略（能力披露协议靠返回值 sessionId 兜底）。
   */
  resumeSessionId?: string
}

/**
 * Collapse engine chat messages into the two fields a CLI agent accepts:
 * system messages merge into the system prompt, the rest become a
 * role-prefixed conversation. Pure — unit-tested.
 */
export function buildCliMessages(messages: { role: string; content: string }[]): {
  systemPrompt: string | undefined
  prompt: string
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim()
  const rest = messages.filter((m) => m.role !== 'system')
  const prompt = rest.length
    ? rest.map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`).join('\n\n')
    : '(no input)'
  return { systemPrompt: system || undefined, prompt }
}

/**
 * 工作流 CLI 调用不设墙钟上限 —— Agent 自主长跑是常态（2026-08-27 产品
 * 决策：真实复跑中 3/4 并行 Agent 在 180s 墙被截断成「部分文本 + done」
 * 的假成功）。唯一保留的清理机制是静默看门狗：逐行输出即重置，活跃
 * 干活永不触发，真挂死 N 分钟后 SIGTERM→SIGKILL。显式取消走 signal。
 * 默认与 inline 执行路径（INLINE_INACTIVITY_TIMEOUT_MS）对齐。
 */
export const CLI_INACTIVITY_TIMEOUT_MS = Number(
  process.env.WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS ?? 300_000,
)

/**
 * Timeout (ms) for HTTP LLM calls: non-stream `chat` gets it as a total
 * wall-clock budget; `chatStream` uses it as first-byte + inter-chunk idle
 * watchdog so long legitimate streams are never cut mid-flight, only hung
 * upstreams are. Env-tunable.
 */
export const LLM_HTTP_TIMEOUT_MS = Number(process.env.LLM_HTTP_TIMEOUT_MS ?? 120_000)

/**
 * CLI-backed llmClient — the CLI-first baseline for workflow execution.
 *
 * First-class-CLI principle: local CLI agents (claude by default) are the
 * zero-config execution engine; an HTTP provider is optional acceleration.
 * Spawns the CLI with the conversation as one prompt and returns the final
 * text. tool_calls are never returned — the PlatformAgent tool loop
 * degenerates to a single call (the CLI brings its own tools anyway).
 */
/**
 * 过程事件 → 保真 activity 增量（2026-09-06 终端视图裁决「采集层保全文」）：
 * 除 text（正文增量，调用方自行处理）外的全部 AgentEvent 变体都转发 ——
 * 此前只转 thinking/tool-use 且 toolLabel 截 60 字、thinking 落库前再截
 * 100 字，终端视图想显示的内容一半根本没被采集。载荷语义见
 * IStreamDelta 保真契约：tool 的 label=工具名、detail=参数 JSON 全文；
 * tool_result 的 detail=输出全文；短摘要一律由展示层派生。
 */
function forwardActivityDelta(
  evt: AgentEvent,
  onDelta: ((chunk: import('@dagents/workflow').IStreamDelta) => void) | undefined,
): void {
  if (!onDelta) return
  switch (evt.type) {
    case 'thinking':
      if (evt.content) onDelta({ type: 'activity', kind: 'thinking', label: evt.content })
      break
    case 'tool-use': {
      let detail = ''
      try {
        detail = JSON.stringify(evt.input ?? {})
      } catch {
        detail = String(evt.input ?? '')
      }
      onDelta({ type: 'activity', kind: 'tool', label: evt.tool || 'tool', detail })
      break
    }
    case 'tool-result':
      if (evt.output) {
        onDelta({
          type: 'activity',
          kind: 'tool_result',
          label: evt.tool || 'tool',
          detail: evt.output,
        })
      }
      break
    case 'status':
      if (evt.status) onDelta({ type: 'activity', kind: 'status', label: evt.status })
      break
    case 'log':
      if (evt.content) onDelta({ type: 'activity', kind: 'log', label: evt.content })
      break
    case 'error':
      if (evt.content) onDelta({ type: 'activity', kind: 'error', label: evt.content })
      break
    default:
      break
  }
}

/**
 * 文本档 CLI 旗标（PRD FR-03 / 决议 D4）：纯 LLM 调用（未声明 tools）时
 * 从模型工具集整体移除内建工具。背景：适配器默认 bypassPermissions，
 * 零 Provider 时「纯 LLM 节点」实际是带全套工具的真 agent —— 实测
 * 「代码审查链」把「审查这段贴入代码」漂移成在项目仓库里 rg/git 全仓
 * 调查（318s / ~9 万 tokens，结论「该函数不在仓库中」）。
 * `--disallowedTools` 直接摘除工具（与 permission mode 正交）；
 * PlatformAgent 工具循环声明了 tools，不受影响。
 */
const CLI_TEXT_MODE_ARGS = [
  '--disallowedTools',
  'Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,TodoRead,BashOutput,KillShell',
]

export function createCliLlmClient(
  kind: AgentType = 'claude',
  cliCwd?: string,
  runId?: string,
  /** 跨进程重挂的会话映射（R8 §3.6(a)）：runs.frozen_agents.sessions 载荷，
   *  key = deriveSessionId(runId, nodeId, ordinal) → 后端真实会话 id。 */
  initialSessions?: Record<string, string>,
) {
  /**
   * 会话延续的取值单源（R8，与 R5 透传协议同一语义）：调用方显式传入的
   * resumeSessionId 优先；否则查进程内延续表 / 跨进程注入映射——命中且
   * claude 档才透传（后端 --resume 延续），缺席 = 不传（诚实首跑，绝不
   * 伪造 resume 目标——自铸 id 塞进去 claude 首跳即炸）。
   */
  const resolveResumeSessionId = (params: CliChatParams): string | undefined => {
    if (params.resumeSessionId) return params.resumeSessionId
    if (!runId || !params.nodeId) return undefined
    const derivedKey = deriveSessionId(runId, params.nodeId, params.ordinal ?? 0)
    return (
      lookupBackendSession(derivedKey, kind) ?? (initialSessions ?? {})[derivedKey]
    )
  }
  /** 共享：为本次执行创建 backend session（chat 与 chatStream 同款启动）。
   *  CLI spawn 闸（稳定性专项）：子进程总量护栏——并发 run × 分支并行时
   *  按 FIFO 排队而非打爆本机；槽位随 session.result settle 释放。 */
  const startSession = async (params: CliChatParams) => {
    const { systemPrompt, prompt } = buildCliMessages(params.messages)
    const agentToolsDeclared = Array.isArray(params.tools) && params.tools.length > 0
    // 文本档仅对 claude 生效（--disallowedTools 是 claude CLI 旗标；其他
    // 适配器无对应机制，保持原行为 —— 与 D4「非 claude 标注未真机」一致）
    const textModeArgs = kind === 'claude' && !agentToolsDeclared ? CLI_TEXT_MODE_ARGS : undefined
    const release = await acquireCliSlot(`${kind}-node`)
    const resumeSessionId = resolveResumeSessionId(params)
    try {
      const backend = createBackend(kind, { executablePath: '', logger: log })
      const session = backend.execute(prompt, {
        systemPrompt,
        inactivityTimeoutMs: CLI_INACTIVITY_TIMEOUT_MS,
        signal: params.signal,
        // 工作目录 = 项目目录：Agent/LLM 节点的 CLI 在选定项目里干活
        //（读写文件、跑命令都基于它）。缺省回落 gateway 进程 cwd。
        cwd: cliCwd,
        // 文本档：无工具声明的调用禁用全部内建工具（见 CLI_TEXT_MODE_ARGS）
        ...(textModeArgs ? { extraArgs: textModeArgs } : {}),
        // R5 会话延续 / R8 查表透传（同一取值单源）：非空 = CLI 后端以
        // --resume 恢复该真实会话；其余适配器忽略（能力披露靠返回值）。
        ...(resumeSessionId ? { resumeSessionId } : {}),
      })
      void session.result
        .finally(() => release())
        .catch(() => {
          /* result 契约上不 reject；兜底吞掉避免迟到异常变 unhandled */
        })
      return session
    } catch (err) {
      release()
      throw err
    }
  }
  /** 会话采集（R8 §3.6(a)）：chat 收尾把后端真实会话 id 记进延续表——同键
   *  重入（resume 重挂/工具循环新一轮）查表透传；跨进程由执行路径落
   *  runs.frozen_agents.sessions（见 workflow-engine-service 的收尾采集）。 */
  const rememberSession = (params: CliChatParams, sessionId: string | undefined): void => {
    if (!runId || !params.nodeId || !sessionId) return
    rememberBackendSession(
      deriveSessionId(runId, params.nodeId, params.ordinal ?? 0),
      sessionId,
      kind,
      runId,
    )
  }
  return {
    async chat(
      params: CliChatParams,
    ): Promise<{ text: string; usage?: ITokenUsage; sessionId?: string; model?: string }> {
      const session = await startSession(params)
      // 插话汇点登记（2026-09-08；R8 键扩 runId:nodeId:ordinal）：节点上报
      // nodeId + 客户端持有 runId 才登记 —— chat 与 chatStream 同款。收尾
      // 注销（PlatformAgent 工具循环换新会话时 same-sink 守卫不误删后继）。
      const sink =
        runId && params.nodeId
          ? registerRunNodeSink(runId, params.nodeId, params.ordinal, session, params.onDelta)
          : null
      try {
        let text = ''
        for await (const evt of session.events as AsyncIterable<AgentEvent>) {
          // turn 边界（2026-09-08 可操作终端）：插话前后的 turn 是两段独立
          // 产出，正文拼接必须补分隔符（否则「40我此刻」粘连）；过程流里
          // 记一条可见边界，回放能读出「插话在这里被消化」。
          if (evt.type === 'status' && evt.status === AgentStatus.TurnBoundary) {
            text += '\n\n'
            params.onDelta?.({
              type: 'activity',
              kind: 'status',
              label: '── 插话已并入，开始新的 turn ──',
            })
            continue
          }
          // text 事件既是最终正文也是增量 —— 有 onDelta 就逐事件转发
          //（AgentSession.events 与 result 解耦，天生支持边跑边吐）
          if (evt.type === 'text') {
            text += evt.content
            params.onDelta?.({ type: 'text', text: evt.content })
          } else {
            forwardActivityDelta(evt, params.onDelta)
          }
        }
        const result = await session.result
        if (result.status !== 'completed') {
          // 任何非完成状态（timeout/aborted/cancelled/failed）都如实抛错：
          // 此前只检查 failed，被看门狗清理的运行带着部分文本落回「成功」，
          // 表现为 span done + 空/截断 content（真实复跑的假成功来源）。
          // usage 附着到错误对象 —— 引擎失败路径据此把已产生 tokens 落 span。
          const err = new Error(
            `CLI agent 未完成（${result.status}）：${result.error ?? '未知错误'}`,
          )
          const models = Object.keys(result.usage ?? {})
          if (models.length > 0) {
            let usageIn = 0
            let usageOut = 0
            for (const m of models) {
              const u = result.usage![m] as
                { inputTokens?: number; outputTokens?: number } | undefined
              usageIn += u?.inputTokens ?? 0
              usageOut += u?.outputTokens ?? 0
            }
            const withUsage = err as Error & { usage?: ITokenUsage }
            withUsage.usage = {
              prompt_tokens: usageIn,
              completion_tokens: usageOut,
              total_tokens: usageIn + usageOut,
              inputTokens: usageIn,
              outputTokens: usageOut,
            }
          }
          throw err
        }
        // 聚合各模型 usage（claude stream-json 事件携带）—— 结果面板的
        // token 徽章 / runs 用量聚合都依赖它；此前只返回 text 导致恒空。
        let usage: ITokenUsage | undefined
        const models = Object.keys(result.usage ?? {})
        if (models.length > 0) {
          let input = 0
          let output = 0
          for (const m of models) {
            const u = result.usage![m] as
              { inputTokens?: number; outputTokens?: number } | undefined
            input += u?.inputTokens ?? 0
            output += u?.outputTokens ?? 0
          }
          // 双命名（ITokenUsage 是 prompt_tokens 命名 + 开放索引；结果面板
          // 的 tokensBadge 读 inputTokens/outputTokens）。此前 completion_tokens
          // 误写成 input（笔误），输出侧用量被夸大。
          usage = {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            inputTokens: input,
            outputTokens: output,
          }
        }
        // sessionId 回传（2026-10-07 R5 能力披露协议）：本次调用的 CLI 会话
        // id 原样上抛——节点层据此决定修复轮 --resume（同会话）还是 messages
        // 全量回放（逻辑会话）。适配器没采集到 = 缺席 = 无会话延续能力。
        // R8：同键采集进延续表（进程内重挂查表透传）。
        rememberSession(params, result.sessionId)
        return {
          text: text || result.output || '',
          usage,
          sessionId: result.sessionId,
          // resolved model（R8 §3.6(c)）：CLI 路径 = cli:<kind> 形态。
          model: `cli:${kind}`,
        }
      } finally {
        if (sink && runId && params.nodeId) {
          unregisterRunNodeSink(runId, params.nodeId, params.ordinal, sink)
        }
      }
    },
    /**
     * CLI 真流式（2026-08-30）：逐消费 session.events，每个 text 事件即刻
     * yield —— 不再等 result 后一次性吐全文。usage/error 聚合与 chat
     * 同款（result 兜底校验）。
     */
    async *chatStream(params: CliChatParams): AsyncGenerator<IChatStreamChunk> {
      const session = await startSession(params)
      const sink =
        runId && params.nodeId
          ? registerRunNodeSink(runId, params.nodeId, params.ordinal, session, params.onDelta)
          : null
      try {
        for await (const evt of session.events as AsyncIterable<AgentEvent>) {
          // turn 边界：流式路径同样补分隔 delta（chat 与 chatStream 同语义）
          if (evt.type === 'status' && evt.status === AgentStatus.TurnBoundary) {
            yield { delta: '\n\n' }
            params.onDelta?.({
              type: 'activity',
              kind: 'status',
              label: '── 插话已并入，开始新的 turn ──',
            })
            continue
          }
          if (evt.type === 'text') {
            yield { delta: evt.content }
            params.onDelta?.({ type: 'text', text: evt.content })
          } else {
            forwardActivityDelta(evt, params.onDelta)
          }
        }
        const result = await session.result
        if (result.status !== 'completed') {
          throw new Error(`CLI agent 未完成（${result.status}）：${result.error ?? '未知错误'}`)
        }
        rememberSession(params, result.sessionId)
        let usage: ITokenUsage | undefined
        const models = Object.keys(result.usage ?? {})
        if (models.length > 0) {
          let input = 0
          let output = 0
          for (const m of models) {
            const u = result.usage![m] as
              { inputTokens?: number; outputTokens?: number } | undefined
            input += u?.inputTokens ?? 0
            output += u?.outputTokens ?? 0
          }
          usage = {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            inputTokens: input,
            outputTokens: output,
          }
        }
        // resolved model（R8 §3.6(c)）：CLI 路径 = cli:<kind>，随末个
        // usage chunk 上抛（流式路径的 resolvedModel 数据源）。
        if (usage) yield { usage, model: `cli:${kind}` }
      } finally {
        if (sink && runId && params.nodeId) {
          unregisterRunNodeSink(runId, params.nodeId, params.ordinal, sink)
        }
      }
    },
  }
}

/**
 * Default llmClient for workflow execution. CLI-first: an explicitly
 * configured HTTP provider wins (opt-in acceleration), otherwise every
 * LLM/Agent node runs on the local CLI — workflows work with zero setup,
 * same as chat.
 *
 * `chatStream` streams real deltas both ways: provider path parses SSE
 * frames; CLI path consumes AgentSession.events (2026-08-30 —— 此前 CLI
 * 退化为 result 后一次性吐全文，画布/详情旁观看不到生成过程).
 *
 * 熔断降级（稳定性专项 2026-10-04）：HTTP provider 持续瞬时故障（网络/
 * 超时/429/5xx，重试耗尽）时按 lib/llm-breaker 计数——熔断开启期间与单次
 * 瞬时失败都直接降级本地 CLI（HTTP 是加速器，加速器坏了回基线，不是回
 * 失败）。配置错误（401/404 等 4xx）保持诚实抛出——静默换 CLI 只会掩盖
 * 需要人修的坏配置。降级在过程流里留一条可见活动（终端/轨迹可审计）。
 */
export function createDefaultLlmClient(
  kind: AgentType = 'claude',
  opts: { cwd?: string; runId?: string; initialSessions?: Record<string, string> } = {},
) {
  const http = createLlmClient()
  const cli = createCliLlmClient(kind, opts.cwd, opts.runId, opts.initialSessions)

  // e2e 确定性总闸（2026-10-04）：mock provider 用 error 规则钉「节点失败」
  // 断言时，CLI 降级会把确定性失败变成真 claude 慢成功（15s+ 且烧 token）。
  // DAGENTS_DISABLE_LLM_FALLBACK=1 关闭熔断降级与瞬时降级（HTTP 故障诚实
  // 抛出）——e2e/CI 环境专用（见 tests/e2e/README），生产默认不设。
  const fallbackDisabled = process.env.DAGENTS_DISABLE_LLM_FALLBACK === '1'

  /**
   * pin 拒绝降级（2026-10-07 R8.4，design-recover §3.6(d)）：显式声明过模型
   * 的调用（modelPinned）**禁熔断/瞬时降级**——provider 故障节点响亮失败，
   * 错误对象挂 `providerFailure: true`（执行路径落 failed(stop_reason=
   * 'provider')，R3.2 唯一归属）+ 期望/实际模型；过程流明示活动行。等价于
   * 把 DAGENTS_DISABLE_LLM_FALLBACK 的语义按调用粒度产品化（全局闸语义
   * 不变，pin 是其调用粒度版）。未声明模型维持基线（降级保可用）。
   */
  const rejectFallbackForPin = (params: CliChatParams, err: unknown): Error => {
    const pinnedErr = new Error(
      `因 pin 拒绝降级（期望模型 ${params.model}）：${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    ) as Error & { providerFailure?: boolean; expectedModel?: string; actualModel?: string }
    pinnedErr.providerFailure = true
    pinnedErr.expectedModel = params.model
    return pinnedErr
  }

  /** 瞬时故障 → 记熔断 + 降级 CLI；配置错误 → 原样抛。附状态码/无状态码
   *  （网络错误）判定瞬时；降级前在过程流留痕。调用前 providerKey 已被
   *  chat 主路径按当次 provider 设置。pin 首查（R8.4）：置位的调用不降级。 */
  const fallbackOrRethrow = (
    err: unknown,
    params: CliChatParams,
  ): Promise<{
    text: string
    tool_calls?: IToolCall[]
    usage?: ITokenUsage
    sessionId?: string
  }> => {
    const status = (err as { status?: number } | null)?.status
    const transient = status == null || isRetryableStatus(status)
    if (!transient || fallbackDisabled) {
      llmHttpTotal.inc(1, { result: transient ? 'transient_error' : 'config_error' })
      if (transient) recordLlmFailure(providerKey())
      throw err
    }
    // R8.4 pin 禁降级：provider 瞬时故障但模型被显式声明——响亮失败。
    if (params.modelPinned) {
      recordLlmFailure(providerKey())
      llmHttpTotal.inc(1, { result: 'pin_rejected' })
      log.warn('llm http failed but model is pinned — refusing CLI fallback', {
        providerId: providerKey(),
        expectedModel: params.model,
        status: status ?? null,
      })
      params.onDelta?.({
        type: 'activity',
        kind: 'status',
        label: `── 因 pin 拒绝降级（期望模型 ${params.model}）──`,
      })
      throw rejectFallbackForPin(params, err)
    }
    recordLlmFailure(providerKey())
    llmHttpTotal.inc(1, { result: 'transient_error' })
    log.warn('llm http call failed transiently — falling back to CLI', {
      providerId: providerKey(),
      status: status ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
    params.onDelta?.({
      type: 'activity',
      kind: 'status',
      label: '── LLM Provider 瞬时故障，本次调用降级本地 CLI ──',
    })
    return cli.chat(params)
  }

  let providerKey = (): string => 'default'

  return {
    async chat(params: CliChatParams): Promise<{
      text: string
      tool_calls?: IToolCall[]
      usage?: ITokenUsage
      sessionId?: string
      model?: string
    }> {
      const provider = await getActiveProvider()
      if (!provider) return cli.chat(params)
      providerKey = () => provider.id
      if (!fallbackDisabled && isLlmCircuitOpen(provider.id)) {
        // R8.4：pin 的调用熔断期间也不降级（期望模型不可用 = 响亮失败）。
        if (params.modelPinned) {
          countLlmFallback(provider.id)
          llmHttpTotal.inc(1, { result: 'pin_rejected' })
          params.onDelta?.({
            type: 'activity',
            kind: 'status',
            label: `── 因 pin 拒绝降级（期望模型 ${params.model}，LLM Provider 熔断中）──`,
          })
          throw rejectFallbackForPin(
            params,
            new Error(`LLM Provider 熔断中（${provider.id}），期望模型 ${params.model}`),
          )
        }
        countLlmFallback(provider.id)
        llmHttpTotal.inc(1, { result: 'fallback' })
        log.warn('llm breaker open — serving this chat from CLI', { providerId: provider.id })
        params.onDelta?.({
          type: 'activity',
          kind: 'status',
          label: '── LLM Provider 熔断中，本节点走本地 CLI ──',
        })
        return cli.chat(params)
      }
      try {
        const out = await http.chat(params)
        recordLlmSuccess(provider.id)
        llmHttpTotal.inc(1, { result: 'ok' })
        return out
      } catch (err) {
        return fallbackOrRethrow(err, params)
      }
    },
    async *chatStream(params: CliChatParams): AsyncGenerator<IChatStreamChunk> {
      const provider = await getActiveProvider()
      if (!provider) {
        yield* cli.chatStream(params)
        return
      }
      providerKey = () => provider.id
      if (!fallbackDisabled && isLlmCircuitOpen(provider.id)) {
        // R8.4：pin 的调用熔断期间不降级（同 chat 分支）。
        if (params.modelPinned) {
          countLlmFallback(provider.id)
          llmHttpTotal.inc(1, { result: 'pin_rejected' })
          params.onDelta?.({
            type: 'activity',
            kind: 'status',
            label: `── 因 pin 拒绝降级（期望模型 ${params.model}，LLM Provider 熔断中）──`,
          })
          throw rejectFallbackForPin(
            params,
            new Error(`LLM Provider 熔断中（${provider.id}），期望模型 ${params.model}`),
          )
        }
        countLlmFallback(provider.id)
        llmHttpTotal.inc(1, { result: 'fallback' })
        log.warn('llm breaker open — serving this stream from CLI', { providerId: provider.id })
        params.onDelta?.({
          type: 'activity',
          kind: 'status',
          label: '── LLM Provider 熔断中，本节点走本地 CLI ──',
        })
        yield* cli.chatStream(params)
        return
      }
      // 已 yield 过增量后失败不可降级（CLI 重跑会重复输出）——诚实抛错；
      // 首 chunk 前的失败与 chat 同款降级 CLI。
      let yielded = false
      try {
        for await (const chunk of http.chatStream(params)) {
          yielded = true
          yield chunk
        }
        recordLlmSuccess(provider.id)
        llmHttpTotal.inc(1, { result: 'ok' })
      } catch (err) {
        const status = (err as { status?: number } | null)?.status
        const transient = status == null || isRetryableStatus(status)
        if (!transient) {
          llmHttpTotal.inc(1, { result: 'config_error' })
          throw err
        }
        recordLlmFailure(provider.id)
        llmHttpTotal.inc(1, { result: 'transient_error' })
        if (yielded) {
          log.warn('llm http stream failed mid-flight (partial output) — honest rethrow', {
            providerId: provider.id,
            status: status ?? null,
          })
          throw err
        }
        // R8.4：pin 的调用首 chunk 前失败也不降级（与 chat 同款响亮失败）。
        if (params.modelPinned) {
          llmHttpTotal.inc(1, { result: 'pin_rejected' })
          params.onDelta?.({
            type: 'activity',
            kind: 'status',
            label: `── 因 pin 拒绝降级（期望模型 ${params.model}）──`,
          })
          throw rejectFallbackForPin(params, err)
        }
        if (fallbackDisabled) throw err
        log.warn('llm http stream failed before first chunk — falling back to CLI', {
          providerId: provider.id,
          status: status ?? null,
        })
        params.onDelta?.({
          type: 'activity',
          kind: 'status',
          label: '── LLM Provider 瞬时故障，本次生成降级本地 CLI ──',
        })
        yield* cli.chatStream(params)
      }
    },
  }
}

/** Reset the provider cache — call before each workflow run. */
export function resetProviderCache(): void {
  cachedProvider = null
  providerFetchPromise = null
}

/**
 * Decode the API key stored in llm_providers. Keys are stored either
 * AES-256-GCM encrypted (`enc:v1:…`, when ENCRYPTION_KEY is set) or legacy
 * Base64 — `decryptSecret` handles both. (This used to base64-decode the
 * ciphertext blob directly, which garbled the Bearer token and 401'd every
 * workflow LLM call whenever encryption was configured.)
 */
function decodeApiKey(encoded: string): string {
  return decryptSecret(encoded)
}

/**
 * Create an llmClient that calls an OpenAI-compatible /v1/chat/completions
 * endpoint using credentials from the `llm_providers` table.
 *
 * `chat` returns `{ text, usage }` where `usage` is the token usage reported
 * by the provider; `chatStream` yields incremental deltas by requesting
 * `stream: true` and parsing the provider's SSE frames. If no provider is
 * configured, both throw — the calling node catches and marks itself failed.
 */
/**
 * HTTP LLM client（具体返回类型）：chatStream 恒有实现（SSE 解析），因此
 * 这里声明为必选 —— 必选成员可赋值给 IExecutionContext['llmClient'] 的
 * 可选 chatStream，同时 createDefaultLlmClient 的转发调用不需要非空断言
 * （修复 main 上遗留的 TS2722：接口把 chatStream 标成可选，导致
 * `http.chatStream(params)` 报「possibly undefined」）。
 */
interface HttpLlmClient {
  chat(
    params: Parameters<NonNullable<IExecutionContext['llmClient']>['chat']>[0],
  ): ReturnType<NonNullable<IExecutionContext['llmClient']>['chat']>
  chatStream(params: {
    model: string
    messages: IChatMessage[]
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<IChatStreamChunk>
}

export function createLlmClient(
  override: { providerId?: string; model?: string } = {},
): HttpLlmClient {
  return {
    async chat(params) {
      const { url, headers, body, model: resolvedModel } = await prepareRequest(params, false, override)
      // 瞬时故障重试（稳定性专项 2026-10-04）：429/5xx/网络抖动带退避重试
      //（LLM_HTTP_RETRY_ATTEMPTS 可调，默认 3 次；Retry-After 被尊重），
      // 配置错误 4xx 与外部取消直通。耗尽后仍 5xx 的 Response 原样返回，
      // 由下方非 ok 分支统一抛错。
      const res = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers,
          body,
        },
        {
          timeoutMs: LLM_HTTP_TIMEOUT_MS,
          signal: params.signal,
          onRetry: ({ attempt, delayMs, reason }) =>
            log.warn('llm http chat retrying', { attempt, delayMs, reason, url }),
        },
      )

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const err = new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`)
        // 状态挂在错误上：调用侧（createDefaultLlmClient 的熔断决策）据此
        // 区分「瞬时故障可降级」与「配置错误须诚实抛」。
        ;(err as Error & { status?: number }).status = res.status
        throw err
      }

      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{
              id: string
              type: 'function'
              function: { name: string; arguments: string }
            }>
          }
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
        }
      }

      const message = json.choices?.[0]?.message
      const text = message?.content ?? ''
      // Normalise tool calls: present only when the model actually requested
      // one, so callers can treat a missing `tool_calls` as "final answer".
      const rawToolCalls = message?.tool_calls
      const tool_calls: IToolCall[] | undefined =
        Array.isArray(rawToolCalls) && rawToolCalls.length > 0
          ? rawToolCalls.map((tc) => ({ id: tc.id, function: tc.function }))
          : undefined
      const usage: ITokenUsage | undefined = json.usage
        ? {
            prompt_tokens: json.usage.prompt_tokens,
            completion_tokens: json.usage.completion_tokens,
            total_tokens: json.usage.total_tokens,
          }
        : undefined

      // resolved model（R8 §3.6(c)）：HTTP 路径 = 实际请求 model（prepareRequest
      // 解析 override.model || params.model || provider.default_model 后的终值）。
      return { text, tool_calls, usage, model: resolvedModel }
    },

    async *chatStream(params): AsyncGenerator<IChatStreamChunk> {
      // resolved model（R8 §3.6(c)）：HTTP 实际请求的 model 终值——随末个
      // usage chunk 上抛（流式路径的 resolvedModel 数据源）。
      const { url, headers, body, model: resolvedModel } = await prepareRequest(params, true, override)
      // Idle watchdog: fires when no byte arrives within the budget — covers
      // both a hung upstream (no first byte) and a stream stalled mid-flight.
      // Every chunk read re-arms the timer, so long healthy streams survive.
      const controller = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => controller.abort(new Error(`LLM stream idle for over ${LLM_HTTP_TIMEOUT_MS}ms`)),
          LLM_HTTP_TIMEOUT_MS,
        )
      }
      armIdle() // covers time-to-headers — a hung upstream never sends headers
      let res: Response
      try {
        // 取 headers 阶段带重试（稳定性专项）：网络抖动 / 5xx / 429 在第一
        // 字节产出之前都可安全重试；idle 看门狗 controller.signal 作为外部
        // signal 传入——abort 即真断流，不重试。headers 之后的流式阶段绝不
        // 重试（已 yield 的增量无法撤回）。
        res = await fetchWithRetry(
          url,
          {
            method: 'POST',
            headers,
            body,
          },
          {
            signal: params.signal
              ? AbortSignal.any([controller.signal, params.signal])
              : controller.signal,
            onRetry: ({ attempt, delayMs, reason }) => {
              log.warn('llm http stream retrying (pre-headers)', { attempt, delayMs, reason, url })
              armIdle() // 重试期间保持防挂死武装
            },
          },
        )
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const err = new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`)
        ;(err as Error & { status?: number }).status = res.status
        throw err
      }
      if (!res.body) {
        throw new Error('LLM API returned no stream body')
      }

      // Parse OpenAI-compatible SSE frames:
      //   data: {"choices":[{"delta":{"content":"..."}}], "usage": {...}}
      //   data: [DONE]
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      armIdle() // headers→first-chunk gap
      try {
        for (;;) {
          const { done, value } = await reader.read()
          armIdle() // healthy traffic keeps re-arming; silence trips the abort
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let sep: number
          while ((sep = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, sep).trim()
            buffer = buffer.slice(sep + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') return

            try {
              const frame = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string | null } }>
                usage?: {
                  prompt_tokens?: number
                  completion_tokens?: number
                  total_tokens?: number
                }
              }
              const delta = frame.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta.length > 0) {
                yield { delta }
              }
              if (frame.usage) {
                yield {
                  usage: {
                    prompt_tokens: frame.usage.prompt_tokens,
                    completion_tokens: frame.usage.completion_tokens,
                    total_tokens: frame.usage.total_tokens,
                  },
                  // resolved model（R8 §3.6(c)）：随末个 usage chunk 上抛。
                  model: resolvedModel,
                }
              }
            } catch {
              // skip malformed frames — providers occasionally emit keepalives
            }
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        reader.releaseLock()
      }
    },
  }
}

/** Resolve the provider and build the request parts for a chat call. */
async function prepareRequest(
  params: {
    model: string
    messages: unknown
    temperature?: number
    tools?: IToolSchema[]
  },
  stream: boolean,
  override: { providerId?: string; model?: string } = {},
): Promise<{ url: string; headers: Record<string, string>; body: string; model: string }> {
  // Explicit provider override (canvas generator picking `providerId::model`):
  // bypass the active-provider cache and read that row directly.
  let provider: LlmProviderRow | null
  if (override.providerId) {
    const { records } = await runQuery<LlmProviderRow>(
      `SELECT id, base_url, api_key, default_model, provider_type
         FROM llm_providers
        WHERE id = $1`,
      [override.providerId],
    )
    provider = records[0] ?? null
  } else {
    provider = await getActiveProvider()
  }
  if (!provider) {
    throw new Error('No active LLM provider configured. Add one in the LLM Providers settings.')
  }

  const model = override.model || params.model || provider.default_model
  if (!model) {
    throw new Error('No model specified and provider has no default model')
  }

  const apiKey = decodeApiKey(provider.api_key)
  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    stream,
  }
  if (params.temperature != null) {
    body.temperature = params.temperature
  }
  // Forward function tools so the model can request tool calls. The
  // OpenAI-compatible endpoint returns `choices[0].message.tool_calls`
  // when the model decides to call a tool instead of replying directly.
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools
  }
  if (stream) {
    // Ask the provider to include token usage on the final streamed frame.
    body.stream_options = { include_usage: true }
  }

  return {
    url,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // resolved model（R8 §3.6(c)）：本调用实际请求的 model 终值。
    model,
  }
}

/**
 * Create an agentFetcher that reads agent config from the `agents` table.
 * Used by PlatformAgentNode to resolve an agentId to its instructions/model.
 *
 * `skills` 在网关侧预先解析为 SKILL.md 正文并组装进 instructions（见
 * skill-injection.ts），因此传给节点的是空数组 —— 节点层的技能名清单
 * 只作为未预解析 fetcher 的兜底，避免同一技能被声明两遍。
 */
export function createAgentFetcher(): NonNullable<IExecutionContext['agentFetcher']> {
  return async (agentId: string): Promise<PlatformAgentConfig | null> => {
    try {
      const { records } = await runQuery<{
        id: string
        name: string
        instructions: string
        model: string
        kind: string
        skills: unknown
      }>(
        `SELECT id, name, instructions, model, kind, skills
           FROM agents
           WHERE id = $1`,
        [agentId],
      )
      const row = records[0]
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        instructions: composeSystemPrompt(row.instructions, row.skills) ?? '',
        model: row.model,
        kind: row.kind,
        skills: [],
      }
    } catch (err) {
      log.error('agentFetcher query failed', { agentId, error: String(err) })
      return null
    }
  }
}

/** Cap HTTP tool responses so a huge payload can't blow up the LLM context. */
const HTTP_TOOL_MAX_RESPONSE = 32 * 1024
const HTTP_TOOL_TIMEOUT_MS = 15_000

/**
 * Built-in tools available to every workflow run — the base layer of the
 * executor's per-run tool registry (Tool nodes in the graph add more as they
 * execute). Deliberately small and safe: an HTTP caller and a clock.
 */
export function createBuiltInToolRegistry(): Record<string, IAgentTool> {
  const httpRequest: IAgentTool = {
    name: 'http_request',
    description:
      'Perform an HTTP request and return the response body (truncated). ' +
      'Use for APIs and web lookups; returns {"status": number, "body": string}.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to request' },
        method: { type: 'string', description: 'HTTP method (default GET)' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'object', description: 'JSON request body (POST/PUT/PATCH)' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) {
        return 'Error: url must be an absolute http(s) URL'
      }
      // SSRF 防线：与 HTTP 节点共用同一守卫（私网/环回/链路本地阻断，
      // 逃生门 DAGENTS_HTTP_ALLOW_PRIVATE=1）。LLM 的工具参数与 flow 文档
      // 一样是不可信输入。
      try {
        assertPublicHttpUrl(new URL(url), 'http_request tool')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
      const method = String(args.method ?? 'GET').toUpperCase()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HTTP_TOOL_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            ...(isRecord(args.headers) ? args.headers : {}),
            ...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
          signal: controller.signal,
          // 不自动跟随重定向：3xx 直出状态码 + Location，由 LLM 决定是否
          // 重新发起（下一跳同样过上面的 SSRF 校验）。自动跟随会把
          // 「公网 URL 校验通过 → 302 跳内网」变成免检通道。
          redirect: 'manual',
        })
        // 保尾截断（2026-10-04 P1a）：与 http 节点同款——判决常在末尾。
        const raw = await res.text()
        const text =
          raw.length > HTTP_TOOL_MAX_RESPONSE
            ? raw.slice(0, Math.floor(HTTP_TOOL_MAX_RESPONSE * 0.6)) +
              `\n[响应截断：全文 ${raw.length} 字符，上限 ${HTTP_TOOL_MAX_RESPONSE}——中间省略]\n` +
              raw.slice(raw.length - Math.floor(HTTP_TOOL_MAX_RESPONSE * 0.4))
            : raw
        const location = res.headers.get('location')
        return JSON.stringify({
          status: res.status,
          ...(location ? { location } : {}),
          body: text,
        })
      } catch (err) {
        return `Error: http_request failed — ${err instanceof Error ? err.message : String(err)}`
      } finally {
        clearTimeout(timer)
      }
    },
  }

  const datetimeNow: IAgentTool = {
    name: 'datetime_now',
    description: 'Get the current date and time (ISO-8601, local timezone).',
    parameters: { type: 'object', properties: {} },
    handler: async () => new Date().toISOString(),
  }

  return { [httpRequest.name]: httpRequest, [datetimeNow.name]: datetimeNow }
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
