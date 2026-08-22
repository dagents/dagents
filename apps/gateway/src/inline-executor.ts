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
import { createBackend } from '@dagents/agent-adapters'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { AgentEvent, AgentResult, TokenUsage, AgentType } from '@dagents/contracts'
import { randomUUID } from 'node:crypto'
import { wsHub, type ChatEvent } from './ws-hub.js'
import { persistComplete, persistCancelled } from './routes/internal-runs-helpers.js'
import { composeSystemPrompt } from './skill-injection.js'
import { executionRegistry, type ExecutionHandle } from './execution-registry.js'
import { computeCost } from './pricing.js'

const log = createLogger({ svc: 'gateway:inline-executor' })

/**
 * Inactivity watchdog for inline CLI executions: abort the CLI when it emits
 * nothing for this long (hung model upstream / stuck CLI). Wall-clock cap is
 * deliberately absent — legit coding-agent tasks can run for many minutes, and
 * the watchdog only fires on *silence*. Env-tunable.
 */
const INLINE_INACTIVITY_TIMEOUT_MS = Number(process.env.INLINE_INACTIVITY_TIMEOUT_MS ?? 300_000)

/**
 * inline 执行器支持的 agent kind（CLI 运行时）。
 * routeMessage 的 auto 兜底也用它过滤掉 remote 等需要 daemon 的类型，
 * 避免新会话默认绑定到无法本机执行的 agent。
 */
export const INLINE_SUPPORTED_KINDS = [
  'claude', 'codex', 'qwen', 'copilot', 'opencode',
  'codebuddy', 'cursor', 'deveco', 'antigravity', 'openclaw', 'pi',
  'hermes', 'kimi', 'kiro', 'grok', 'qoder', 'traecli',
] as const

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
 * Compute USD cost from token usage and model name. Moved to `pricing.ts`
 * (multi-vendor price table + env overrides, 方案 D / AD-3) — re-exported
 * here so existing callers/tests importing from inline-executor keep working.
 */
export { computeCost }

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

  // Cancellation handle (execution-cancellation spec D4): registered so
  // POST /chats/:id/cancel can find and abort this execution. The signal
  // reaches the CLI child via the adapters' kill-escalation path; `done`
  // resolves in the executor loop's finally, after persist + broadcast.
  const abort = new AbortController()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const handle: ExecutionHandle = {
    chatId,
    runId,
    kind: 'chat-agent',
    startedAt: Date.now(),
    abort: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled by caller')),
    done,
  }
  executionRegistry.register(handle)

  // 查 agent 信息：优先 agents 表（v0.3 领域模型），fallback agent_daemons 表（旧 dispatch 模型）
  let execPath = ''
  let agentName = 'agent'
  let agentKind = 'claude'
  let systemPrompt: string | undefined
  try {
    // 先查 agents 表（前端创建的 agent 在此表中）。instructions + skills
    // 组装为 system prompt —— 技能正文由 skill-injection 从注册表解析。
    const { records: agentRows } = await runQuery<{
      name: string
      kind: string
      instructions: string | null
      skills: unknown
    }>(
      `SELECT name, kind, instructions, skills FROM agents WHERE id = $1::uuid`,
      [agentId],
    )
    const agentRow = agentRows[0]

    if (agentRow) {
      agentName = agentRow.name
      agentKind = agentRow.kind
      systemPrompt = composeSystemPrompt(agentRow.instructions, agentRow.skills)
    } else {
      // fallback: agent_daemons 表（旧模型，可能包含额外的 executable_path）
      const { records: daemonRows } = await runQuery<{ name: string; executable_path: string | null; kind: string }>(
        `SELECT name, executable_path, kind FROM agent_daemons WHERE id = $1::uuid`,
        [agentId],
      )
      const daemonRow = daemonRows[0]
      if (!daemonRow) {
        await reportError(
          chatId,
          runId,
          `本会话绑定的 Agent 已不存在（可能已被删除）。请在输入框左侧的 Agent 选择器重新选择一个 Agent 后重试。`,
        )
        return
      }
      agentName = daemonRow.name
      agentKind = daemonRow.kind
      if (daemonRow.executable_path) execPath = daemonRow.executable_path
    }

    // 从 agent_daemons 获取 executable_path（可选，覆盖默认值）
    if (!execPath) {
      const { records: adRows } = await runQuery<{ executable_path: string | null }>(
        `SELECT executable_path FROM agent_daemons WHERE id = $1::uuid`,
        [agentId],
      )
      if (adRows[0]?.executable_path) execPath = adRows[0].executable_path
    }

    // 使用 createBackend factory 支持所有已适配的 agent CLI
    if (!(INLINE_SUPPORTED_KINDS as readonly string[]).includes(agentKind)) {
      const supported = INLINE_SUPPORTED_KINDS.join(', ')
      await reportError(
        chatId,
        runId,
        `Agent「${agentName}」的运行时类型为 ${agentKind}，无法在本机直接执行` +
          `（支持本机执行的类型：${supported}）。` +
          `请在输入框左侧的 Agent 选择器切换为 CLI 类型的 Agent，或为该 Agent 启动对应的 Daemon 后重试。`,
      )
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
  } catch {
    // best-effort status flip — a failure here must not block the spawn below
  }

  // spawn agent via factory (supports claude/codex/qwen/copilot/opencode)
  const backend = createBackend(agentKind as AgentType, { executablePath: execPath, logger: log })

  // Auto-retry: when the agent process exits with a non-zero code (or the
  // stream / spawn throws), re-spawn up to 2 more times with backoff before
  // giving up and reporting chat:error. Each retry is a fresh spawn (not a
  // resume) — transient crashes (OOM, CLI panic, network blip to the model)
  // often clear on a second attempt. Tokens from each attempt stream to the
  // client live; output is reset per attempt so a failed run's partial
  // content doesn't pollute the persisted message.
  const MAX_ATTEMPTS = 3 // 1 initial + 2 retries
  const BACKOFF_MS = [2000, 5000] // wait before attempt 2 / attempt 3
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // 异步消费 AgentEvent 流，推送到 wsHub（带自动重试 + backoff）
  ;(async () => {
    const startedAt = Date.now()
    let output = ''
    let result: AgentResult | null = null
    let lastError = 'unknown error'
    let succeeded = false
    let cancelled = false
    let finalAttempt = 0

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log.info('inline execute attempt', { chatId, runId, attempt, maxAttempts: MAX_ATTEMPTS })

      // Re-spawn the process for each attempt (not a resume).
      let session: ReturnType<typeof backend.execute> | null = null
      try {
        session = backend.execute(prompt, {
          cwd: opts.cwd,
          model: opts.model,
          systemPrompt,
          inactivityTimeoutMs: INLINE_INACTIVITY_TIMEOUT_MS,
          signal: abort.signal,
        })
      } catch (err) {
        lastError = `spawn failed: ${String(err)}`
        log.warn('inline execute spawn threw', { chatId, runId, attempt, error: lastError })
      }

      if (session) {
        // Reset output so partial tokens from a failed attempt don't pollute
        // the next attempt's persisted message.
        output = ''
        try {
          for await (const evt of session.events) {
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
          result = await session.result

          // User cancel: the adapters killed the child and reported
          // 'cancelled' — never retry, fall through to the cancelled terminal.
          if (result.status === 'cancelled') {
            cancelled = true
            finalAttempt = attempt
            break
          }

          // Success: process exited cleanly — break out of the retry loop.
          if (result.status !== 'failed') {
            succeeded = true
            finalAttempt = attempt
            break
          }

          // Non-zero exit: treat as a retryable failure.
          lastError = `agent process exited with status '${result.status}'`
          log.warn('inline execute non-zero exit', { chatId, runId, attempt, status: result.status })
        } catch (err) {
          if (abort.signal.aborted) {
            cancelled = true
            finalAttempt = attempt
            break
          }
          lastError = `stream error: ${String(err)}`
          log.warn('inline execute stream threw', { chatId, runId, attempt, error: lastError })
        }
      }

      // A cancel during backoff stops the retry ladder immediately.
      if (cancelled || abort.signal.aborted) {
        cancelled = true
        break
      }

      // Backoff before the next attempt (if any retries remain). We surface
      // the retry to the client via a [status] tag so the pause isn't an
      // unexplained silence — AssistantContent renders [status] as a dim
      // diagnostic line.
      if (attempt < MAX_ATTEMPTS) {
        const backoff = BACKOFF_MS[attempt - 1] ?? 5000
        log.info('inline execute backing off before retry', {
          chatId, runId, attempt, nextAttempt: attempt + 1, backoffMs: backoff, lastError,
        })
        wsHub.broadcastChat(chatId, {
          type: 'chat:message',
          chatId,
          runId,
          role: 'assistant',
          content: `\n[status]（第 ${attempt} 次执行失败，${backoff / 1000} 秒后自动重试…）[/status]\n`,
          streaming: true,
        })
        await sleep(backoff)
      }
    }

    // User cancel: terminal state is cancelled — persisted + broadcast as
    // chat:cancelled, never retried, never relabeled as failed.
    if (cancelled) {
      try {
        await persistCancelled({
          chatId,
          runId,
          output: output || undefined,
          durationMs: Date.now() - startedAt,
          reason: 'user cancelled',
        })
      } catch (err) {
        log.error('inline execute persistCancelled failed', { chatId, runId, error: String(err) })
      }
      log.info('inline execute cancelled', { chatId, runId, outputLen: output.length })
      return
    }

    // All retries exhausted — report the terminal error to the client + persist.
    if (!succeeded) {
      await reportError(chatId, runId, `${lastError}（已自动重试 ${MAX_ATTEMPTS} 次仍失败）`)
      return
    }

    // 完成：persist assistant message (with usage/cost/duration) + push chat:done
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
        // AD-3 usage_event 溯源字段：chat 终态入账时带上 agent / model。
        agentId,
        model: opts.model ?? null,
      })
    } catch (err) {
      log.error('inline execute persist failed', { chatId, runId, error: String(err) })
    }
    log.info('inline execute done', {
      chatId, runId, attempts: finalAttempt, status: result?.status, outputLen: output.length, usage, durationMs, cost,
    })
  })()
    .catch((err) => {
      log.error('inline execute async loop crashed', { chatId, runId, error: String(err) })
    })
    .finally(() => {
      // Settle the cancellation handle BEFORE unregistering so a concurrent
      // cancelChat() awaiting `done` observes the completed persist+broadcast.
      resolveDone()
      executionRegistry.unregister(handle)
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
