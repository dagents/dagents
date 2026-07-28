/**
 * InlineAgentExecutor — gateway-embedded agent executor for Web architecture.
 *
 * 在纯 Web 架构下（无桌面端 daemon），gateway 直接 spawn `claude` CLI
 * 执行 agent 任务，绕过 dispatch/daemon 协议。这样用户打开浏览器就能
 * 用 chat，不需要额外启动 daemon 进程。
 *
 * 流程：
 *   1. routeMessage 决定走 inline 执行（chat.agent_id 已绑定）
 *   2. executeInline(chatId, agentId, prompt) spawn claude CLI
 *   3. claudeBackend 解析 stream-json → AgentEvent 流
 *   4. AgentEvent 通过 wsHub 广播给订阅了该 chatId 的浏览器
 *   5. 完成后写入 chat_messages（assistant 角色）+ 更新 chat 状态
 *
 * 与 multica daemon 模式的对应：
 *   - gateway 进程 = daemon 进程（都在本机 spawn claude）
 *   - wsHub = realtime.Hub（WS 广播到浏览器）
 *   - claudeBackend = server/pkg/agent/claude.go（同一份 spawn 逻辑）
 *
 * 保留 dispatch/daemon 协议不动，未来切分布式模式时切换 routeMessage
 * 走 dispatch invoke 即可。
 */
import { claudeBackend } from '@dagents/agent-adapters'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { AgentEvent, AgentResult, TokenUsage } from '@dagents/contracts'
import { randomUUID } from 'node:crypto'
import { wsHub, type ChatEvent } from './ws-hub.js'
import { persistComplete } from './routes/internal-runs-helpers.js'

const log = createLogger({ svc: 'gateway:inline-executor' })

/** Hardcoded price table (USD per 1M tokens) — replace with LLM Provider CRUD lookup in follow-up. */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  haiku: { input: 0.25, output: 1.25 },
}
const DEFAULT_PRICE = { input: 3, output: 15 } // default to sonnet pricing

/**
 * Aggregate per-model token usage into a single summed `TokenUsage`.
 * Returns `undefined` when the map is empty (no usage to report).
 */
export function aggregateUsage(
  usage: Record<string, TokenUsage> | undefined | null,
): TokenUsage | undefined {
  if (!usage) return undefined
  const models = Object.keys(usage)
  if (models.length === 0) return undefined
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let hasCacheRead = false
  let hasCacheWrite = false
  for (const model of models) {
    const u = usage[model]
    if (!u) continue
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    if (u.cacheReadTokens != null) {
      cacheReadTokens += u.cacheReadTokens
      hasCacheRead = true
    }
    if (u.cacheWriteTokens != null) {
      cacheWriteTokens += u.cacheWriteTokens
      hasCacheWrite = true
    }
  }
  const result: TokenUsage = { inputTokens, outputTokens }
  if (hasCacheRead) result.cacheReadTokens = cacheReadTokens
  if (hasCacheWrite) result.cacheWriteTokens = cacheWriteTokens
  return result
}

/**
 * Compute USD cost from token usage and model name. Returns `undefined`
 * when usage is missing (no tokens to price).
 */
export function computeCost(
  usage: { inputTokens?: number; outputTokens?: number } | undefined | null,
  model?: string,
): number | undefined {
  if (!usage) return undefined
  // `model && MODEL_PRICES[model]` returns `""` when model is an empty string
  // and `undefined` for unknown models — use `||` (not `??`) so both fall back
  // to DEFAULT_PRICE.
  const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  if (input === 0 && output === 0) return undefined
  return (input * price.input + output * price.output) / 1_000_000
}

export interface InlineExecOptions {
  /** 工作目录，传给 claude CLI 的 cwd（通常是 chat 关联的 directory path）。 */
  cwd?: string
  /** 模型名（如 "sonnet" / "opus"），透传给 claude CLI --model。 */
  model?: string
}

/**
 * 执行 agent 任务并把结果通过 WS 推送给浏览器。
 *
 * 不返回流给调用方 —— 调用方（routeMessage）只关心任务是否启动成功，
 * 真正的输出通过 wsHub 异步推送到订阅者。
 *
 * 错误处理：spawn 失败、claude 退出非零、解析异常都会通过 WS 推送
 * `chat:error` 事件，并写入一条 assistant 角色的错误消息到 chat_messages。
 */
export async function executeInline(
  chatId: string,
  agentId: string,
  prompt: string,
  opts: InlineExecOptions = {},
): Promise<void> {
  const runId = randomUUID()
  log.info('inline execute start', { chatId, agentId, runId, cwd: opts.cwd })

  // 查 agent 信息，确定 executable_path（优先用 agent 自带的，否则用 'claude'）
  let execPath = 'claude'
  let agentName = 'agent'
  try {
    const { records } = await runQuery<{ name: string; executable_path: string | null; kind: string }>(
      `SELECT name, executable_path, kind FROM agent_daemons WHERE id = $1::uuid`,
      [agentId],
    )
    const agent = records[0]
    if (!agent) {
      await reportError(chatId, runId, `agent not found: ${agentId}`)
      return
    }
    agentName = agent.name
    if (agent.executable_path) execPath = agent.executable_path
    // 非 claude kind 暂不支持 inline 执行（只有 claude adapter）
    if (agent.kind !== 'claude') {
      await reportError(chatId, runId, `inline executor only supports 'claude' kind, got '${agent.kind}'`)
      return
    }
  } catch (err) {
    await reportError(chatId, runId, `agent lookup failed: ${String(err)}`)
    return
  }

  // 标记 chat 为 running
  try {
    await runQuery(
      `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    )
  } catch {}

  // spawn claude
  const backend = claudeBackend({ executablePath: execPath, logger: log })
  let session: ReturnType<typeof backend.execute> | null = null
  try {
    session = backend.execute(prompt, { cwd: opts.cwd, model: opts.model })
  } catch (err) {
    await reportError(chatId, runId, `claude spawn failed: ${String(err)}`)
    return
  }

  // 异步消费 AgentEvent 流，推送到 wsHub
  ;(async () => {
    let output = ''
    let result: AgentResult | null = null
    try {
      for await (const evt of session!.events) {
        const text = eventToText(evt)
        if (text) {
          output += text
          const payload: ChatEvent = {
            type: 'chat:message',
            chatId,
            runId,
            role: 'assistant',
            content: text,
            streaming: true,
          }
          wsHub.broadcastChat(chatId, payload)
        }
      }
      result = await session!.result
    } catch (err) {
      log.error('inline execute stream error', { chatId, runId, error: String(err) })
      await reportError(chatId, runId, `stream error: ${String(err)}`)
      return
    }

    // 完成：持久化 assistant 消息（含 usage/cost/duration）+ 推送 chat:done
    const usage = aggregateUsage(result?.usage)
    const durationMs = result?.durationMs
    const cost = computeCost(usage, opts.model)
    try {
      await persistComplete({
        chatId,
        runId,
        output: output || result?.output || '',
        status: result?.status === 'failed' ? 'failed' : 'completed',
        usage,
        durationMs,
        cost,
      })
    } catch (err) {
      log.error('inline execute persist failed', { chatId, runId, error: String(err) })
    }
    log.info('inline execute done', { chatId, runId, status: result?.status, outputLen: output.length, usage, durationMs, cost })
  })().catch((err) => {
    log.error('inline execute async loop crashed', { chatId, runId, error: String(err) })
  })
}

/**
 * 把 AgentEvent 映射为要推送的文本片段。
 *
 * 用明确的闭合标签分隔不同类型的内容，让前端能解析成 segments 分别渲染：
 *   - text → 纯文本（assistant 的主回复）
 *   - thinking → [thinking]...[/thinking]（前端折叠灰色显示）
 *   - tool-use → [tool: name]{input-json}[/tool]（前端折叠，显示工具名+摘要）
 *   - tool-result → [tool-result]...[/tool-result]
 *   - status → [status]xxx[/status]（前端不显示或显示为诊断文字）
 *   - error → [error]...[/error]
 *   - log → [log]...[/log]
 *
 * 纯 text 事件不加标签，直接输出——它是 assistant 的主回复内容，
 * 前端作为正文渲染。
 *
 * tool-use 的 input 序列化为 JSON 放在标签内，前端解析后提取
 * file_path / query / command 等关键字段作为工具调用摘要显示，
 * 与 multica 的 ToolCallRow 一致。
 */
function eventToText(evt: AgentEvent): string {
  switch (evt.type) {
    case 'text':
      return evt.content
    case 'thinking':
      return evt.content ? `\n[thinking]${evt.content}[/thinking]\n` : ''
    case 'tool-use': {
      // Serialize input as compact JSON so the frontend can parse it back
      // and show a meaningful summary (file path / query / command…).
      // Empty input → empty body; the frontend handles both.
      const body = evt.input != null
        ? safeCompactJson(evt.input)
        : ''
      return `\n[tool:${evt.tool}]${body}[/tool]\n`
    }
    case 'tool-result':
      return evt.output ? `\n[tool-result]${evt.output}[/tool-result]\n` : ''
    case 'status':
      return `[status]${evt.status}[/status]\n`
    case 'log':
      return evt.content ? `[log]${evt.content}[/log]\n` : ''
    case 'error':
      return `\n[error]${evt.content}[/error]\n`
    default:
      return ''
  }
}

/**
 * Compact JSON serializer that won't throw on cyclic inputs. Used to embed
 * tool-use `input` inside the [tool:Name]<body>[/tool] tag — the frontend
 * parses it back to render a summary (file_path / query / command …).
 */
function safeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** 上报错误：推送 chat:error + 写入一条 assistant 错误消息 + 标记 chat idle。 */
async function reportError(chatId: string, runId: string, message: string): Promise<void> {
  log.error('inline execute error', { chatId, runId, error: message })
  wsHub.broadcastChat(chatId, {
    type: 'chat:error',
    chatId,
    runId,
    role: 'assistant',
    content: `⚠️ ${message}`,
    streaming: false,
    error: message,
  })
  try {
    await runQuery(
      `INSERT INTO chat_messages (id, chat_id, role, content, created_at)
       VALUES ($1::uuid, $2::uuid, 'assistant', $3, NOW())`,
      [randomUUID(), chatId, `⚠️ ${message}`],
    )
    await runQuery(
      `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    )
  } catch (err) {
    log.error('reportError persist failed', { chatId, error: String(err) })
  }
}
