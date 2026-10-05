import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import { SseStreamer, type FlowData } from '@dagents/workflow'
import { routeMessage } from './chat-execute.js'
import { enqueueTask, getTask, getTaskEvents } from './dispatch/service.js'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import { persistCancelled } from './internal-runs-helpers.js'
import { sendToRunNode } from './workflow-clients.js'
import { assembleWorkflowEngine, toRunStatus } from './workflow-engine-service.js'
import { createChatHumanInputResolver, resolvePendingHumanInput } from './human-input.js'
import { answerAwaitingRunForChat } from './resume-execution.js'
import type { RunLiveTap } from '../run-live-registry.js'
import {
  listChats,
  searchChats,
  getChatById,
  createChat,
  updateChatFields,
  deleteChat,
  chatExists,
  listChatMessages,
  appendChatMessage,
  resetChatToIdle,
  setChatStatusIdle,
  getChatExecutionBinding,
  getLatestUserMessage,
  insertAssistantChatMessage,
  bumpChatAfterAssistantMessage,
  normalizeChat,
  normalizeMsg,
  type ChatRow,
  type ChatMessageRow,
} from '../repositories/chats.repo.js'
import { getFlowDataById } from '../repositories/workflows.repo.js'
import { getDirectoryPath } from '../repositories/directories.repo.js'
import { upsertChatWorkflowRunRow, listRunsForChat } from '../repositories/runs.repo.js'
import { ok, fail, UUID_RE } from '../lib/http.js'
import {
  tryAcquireRunSlot,
  recordRunFinished,
  runGateStats,
  MAX_CONCURRENT_RUNS,
} from '../lib/run-gate.js'
import { maybeUpdateChatSummary } from '../lib/chat-context-summary.js'

export const chatRoutes = new Hono()

const log = createLogger({ svc: 'gateway:chats' })

const listQuerySchema = z.object({
  directory_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  directory_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const createBodySchema = z.object({
  directoryId: z.string().uuid(),
  title: z.string().min(1).max(200),
  agentId: z.string().uuid().optional(),
  flowId: z.string().max(200).optional(),
})

const updateBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.string().min(1).optional(),
  agentId: z.string().uuid().nullable().optional(),
  flowId: z.string().max(200).nullable().optional(),
})

const createMessageWithExecBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z
    .string()
    .min(1)
    .refine((s) => !s.includes('\x00'), 'content must not contain null bytes'),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Optional agent id — overrides chat.agentId for this message only. */
  agentIdOverride: z.string().uuid().optional(),
  /** Optional flow id — overrides chat.flowId for this message only. */
  flowIdOverride: z.string().optional(),
})

chatRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  let rows: ChatRow[]
  try {
    rows = await listChats({ directoryId: q.directory_id, q: q.q, limit: q.limit })
  } catch (err) {
    log.error('chat list query failed', { error: String(err) })
    return fail(c, 502, 'chat list failed')
  }

  return ok(c, {
    items: rows.map((r) => normalizeChat(r)),
  })
})

/**
 * GET /api/v1/chats/search?q=keyword&directory_id=xxx&limit=20
 *
 * Full-text chat history search across chats.title and chat_messages.content.
 * Returns results grouped by chat — each result has a truncated snippet with
 * the matched substring wrapped in <mark>…</mark> for client-side highlight.
 *
 * q must be non-empty (min 1 char) — empty/whitespace queries are rejected
 * with 400. limit is capped at 50. If directory_id is provided, results are
 * scoped to chats in that directory; otherwise all directories are searched.
 *
 * Match precedence: title matches are returned first (they are usually the
 * strongest signal), then content matches. A chat that matches on content
 * produces one row per matching message so the user can jump to the specific
 * message context.
 *
 * The <mark> wrapping is done in JS, not SQL, to keep the query legible. SQL
 * returns the raw title (for title matches) or a ~200-char window centered on
 * the first hit (for content matches); the JS post-process re-locates the
 * (case-insensitive) hit and wraps it.
 */
chatRoutes.get('/search', async (c) => {
  const parsed = searchQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  // Escape SQL LIKE wildcards in the user query so a literal '%', '_', or '\'
  // in the query is treated as a literal char, not a wildcard. We then use
  // ILIKE … ESCAPE '\' so the escaped sequence is interpreted correctly.
  const escaped = q.q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const likePattern = `%${escaped}%`

  let rows: Awaited<ReturnType<typeof searchChats>>
  try {
    rows = await searchChats({ likePattern, q: q.q, directoryId: q.directory_id, limit: q.limit })
  } catch (err) {
    log.error('chat search query failed', { q: q.q, error: String(err) })
    return fail(c, 502, 'chat search failed')
  }

  // Wrap the (first, case-insensitive) match in <mark>…</mark>. Truncate long
  // snippets with an ellipsis. HTML special chars are escaped so user-controlled
  // content can't inject markup; the <mark> tags we add ourselves are the only
  // HTML in the output.
  const needle = q.q.toLowerCase()
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const wrapHit = (raw: string, isContent: boolean): string => {
    const lower = raw.toLowerCase()
    const idx = lower.indexOf(needle)
    // Leading ellipsis when the content window starts mid-string (the SQL
    // window begins up to 60 chars before the hit, so the snippet usually
    // doesn't start at offset 0 of the original message).
    const leadingEllipsis = isContent && raw.length > 0 && idx > 0 ? '…' : ''
    if (idx < 0) {
      const safe = escapeHtml(raw)
      return raw.length > 200 ? safe.slice(0, 200) + '…' : safe
    }
    const before = escapeHtml(raw.slice(0, idx))
    const hit = escapeHtml(raw.slice(idx, idx + needle.length))
    const afterRaw = raw.slice(idx + needle.length)
    const after = escapeHtml(
      afterRaw.length > 200 - idx ? afterRaw.slice(0, 200 - idx) + '…' : afterRaw,
    )
    return `${leadingEllipsis}${before}<mark>${hit}</mark>${after}`
  }

  return ok(c, {
    items: rows.map((r) => ({
      chatId: r.chat_id,
      chatTitle: r.chat_title,
      snippet: wrapHit(r.snippet_raw, r.match_type === 'content'),
      matchType: r.match_type,
      directoryId: r.directory_id,
      directoryName: r.directory_name,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString(),
    })),
  })
})

chatRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let row: ChatRow | null
  try {
    row = await getChatById(id)
  } catch (err) {
    log.error('chat detail query failed', { id, error: String(err) })
    return fail(c, 502, 'chat detail failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  let row: ChatRow | null
  try {
    row = await createChat({
      directoryId: data.directoryId,
      title: data.title,
      agentId: data.agentId ?? null,
      flowId: data.flowId ?? null,
    })
  } catch (err) {
    log.error('chat create failed', { error: String(err) })
    return fail(c, 502, 'chat create failed')
  }
  if (!row) {
    return fail(c, 502, 'chat create failed')
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = updateBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const hasUpdates =
    data.title !== undefined ||
    data.status !== undefined ||
    data.agentId !== undefined ||
    data.flowId !== undefined

  if (!hasUpdates) {
    let existing: ChatRow | null
    try {
      existing = await getChatById(id)
    } catch (err) {
      log.error('chat detail query failed', { id, error: String(err) })
      return fail(c, 502, 'chat update failed')
    }
    if (!existing) {
      return fail(c, 404, 'chat not found', { id })
    }
    return ok(c, { chat: normalizeChat(existing) })
  }

  let row: ChatRow | null
  try {
    row = await updateChatFields(id, data)
  } catch (err) {
    log.error('chat update failed', { id, error: String(err) })
    return fail(c, 502, 'chat update failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let deletedId: string | null
  try {
    deletedId = await deleteChat(id)
  } catch (err) {
    log.error('chat delete failed', { id, error: String(err) })
    return fail(c, 502, 'chat delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { deleted: true, id: deletedId })
})

chatRoutes.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  try {
    if (!(await chatExists(id))) {
      return fail(c, 404, 'chat not found', { id })
    }
  } catch (err) {
    log.error('chat lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat messages failed')
  }

  let rows: ChatMessageRow[]
  try {
    rows = await listChatMessages(id)
  } catch (err) {
    log.error('chat messages query failed', { id, error: String(err) })
    return fail(c, 502, 'chat messages failed')
  }

  return ok(c, { items: rows.map((r) => normalizeMsg(r)) })
})

chatRoutes.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createMessageWithExecBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  // Only 'user' role messages trigger execution routing.
  // 'assistant'/'system'/'tool' are writes from the stream consumer or other
  // system paths and should not re-route.
  let msgRow: ChatMessageRow | null
  try {
    msgRow = await appendChatMessage(id, {
      role: data.role,
      content: data.content,
      runId: data.runId ?? null,
      metadataJson: JSON.stringify(data.metadata ?? {}),
    })
  } catch (err) {
    log.error('chat message create failed', { id, error: String(err) })
    return fail(c, 502, 'chat message create failed')
  }
  if (!msgRow) {
    return fail(c, 404, 'chat not found', { id })
  }

  // Non-user roles: return the message without routing.
  if (data.role !== 'user') {
    return ok(c, { message: normalizeMsg(msgRow) })
  }

  // A pending HumanInput consumes the user's message as its answer.
  // 2026-09-18 P2：优先走持久挂起（DB checkpoint awaiting —— 跨重启存活，
  // resume 语义续跑，进度经 span writer/WS 可旁观）；进程内 Promise 机制
  // 保留为旧路径兜底（同进程内的老式挂起仍在时先消费）。
  const resumed = await answerAwaitingRunForChat(id, data.content)
  if (resumed) {
    return ok(c, {
      message: normalizeMsg(msgRow),
      mode: 'json',
      payload: { type: 'human_input_ack', content: data.content, runId: resumed },
    })
  }
  if (resolvePendingHumanInput(id, data.content)) {
    return ok(c, {
      message: normalizeMsg(msgRow),
      mode: 'json',
      payload: { type: 'human_input_ack', content: data.content },
    })
  }

  // User role: route the message.
  const route = await routeMessage(id, data.content, {
    agentIdOverride: data.agentIdOverride,
    flowIdOverride: data.flowIdOverride,
  })

  if (route.mode === 'stream') {
    return ok(c, {
      message: normalizeMsg(msgRow),
      mode: 'stream',
      chatRunId: route.chatRunId ?? null,
    })
  }

  // JSON mode: @-command ack or routing error.
  return ok(c, {
    message: normalizeMsg(msgRow),
    mode: 'json',
    payload: route.payload,
    error: route.error,
    systemMessageId: route.systemMessageId ?? null,
  })
})

/**
 * POST /api/v1/chats/:id/reset — clear a failed chat back to 'idle'.
 *
 * Used by the console's error-recovery flow before retrying an agent run.
 * Only flips `failed` → `idle`; a non-failed chat is reset to `idle` too
 * (idempotent) so the caller doesn't have to branch on current status.
 * Returns the updated chat so the console can sync its breadcrumb.
 */
chatRoutes.post('/:id/reset', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let row: ChatRow | null
  try {
    row = await resetChatToIdle(id)
  } catch (err) {
    log.error('chat reset failed', { id, error: String(err) })
    return fail(c, 502, 'chat reset failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

/**
 * Agent-based execution: dispatch a task to the agent via the dispatch
 * service and stream the output back as SSE.
 *
 * When the user selects an agent in the chat UI (e.g. claude-code), the
 * chat has agent_id but no flow_id. We enqueue a dispatch task (via the
 * in-process service function — no HTTP round-trip), then poll
 * dispatch_task_events and stream them as SSE tokens to the client.
 */
async function streamAgentExecution(
  c: Context,
  chatId: string,
  agentId: string,
  prompt: string | null,
): Promise<Response> {
  const runId = randomUUID()

  // 1. Create a dispatch task for this agent (in-process service call).
  let taskId: string
  try {
    const result = await enqueueTask({
      agentDaemonId: agentId,
      runId,
      prompt: prompt ?? '',
    })
    taskId = result.taskId
  } catch (err) {
    log.error('dispatch invoke failed', { agentId, error: String(err) })
    return c.json(
      { success: false, error: 'dispatch invoke failed', detail: String(err) },
      502 as ContentfulStatusCode,
    )
  }

  log.info('dispatched agent task', { chatId, agentId, taskId, runId })

  // 2. Build a live ReadableStream that polls dispatch_task_events and
  //    yields SSE frames. This is a proper live stream (not the buffered
  //    SseStreamer which drains once), suitable for long-running agents.
  const encoder = new TextEncoder()
  let lastSeq = 0

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const POLL_INTERVAL = 500
      let terminal = false
      // 客户端断连（关页/取消）时 request signal 会 abort —— 轮询必须
      // 跟着退出，否则每条被放弃的会话都变成 500ms 一转的永久后台循环
      // （2026-09-17 评审修复：daemon 死亡时任务永不终态 + enqueue 抛错被
      // 吞，这条循环此前无任何退出路径）。
      const signal = c.req.raw.signal

      while (!terminal && !signal.aborted) {
        let events: Awaited<ReturnType<typeof getTaskEvents>> = []
        try {
          // Check task status (in-process service call)
          const task = await getTask(taskId)
          if (task) {
            if (task.status === 'completed' || task.status === 'failed') {
              terminal = true
            }
          }

          // Fetch new events since lastSeq (in-process service call)
          events = await getTaskEvents(taskId, lastSeq)
        } catch (err) {
          log.warn('agent event poll error', { taskId, error: String(err) })
        }

        for (const evt of events) {
          if (evt.seq <= lastSeq) continue
          lastSeq = evt.seq
          const p = (evt.payload ?? {}) as Record<string, unknown>
          const text =
            typeof p.content === 'string'
              ? p.content
              : typeof p.output === 'string'
                ? p.output
                : typeof p.status === 'string'
                  ? p.status
                  : JSON.stringify(p)
          try {
            controller.enqueue(
              encoder.encode(
                `event: token\ndata: ${JSON.stringify({ event: 'token', data: text })}\n\n`,
              ),
            )
          } catch {
            // 流已关闭（客户端断开）——退出而非把异常当 poll error 吞掉
            terminal = true
            break
          }
        }

        if (!terminal && !signal.aborted) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL))
        }
      }

      // Send end event (only meaningful when the stream is still open)
      try {
        controller.enqueue(
          encoder.encode(
            `event: end\ndata: ${JSON.stringify({ event: 'end', data: '[DONE]' })}\n\n`,
          ),
        )
        controller.close()
      } catch {
        // client already gone — nothing to flush
      }

      // Update chat status
      try {
        await setChatStatusIdle(chatId)
      } catch {
        // best-effort status reset — ignore errors once the stream has closed
      }
    },
  })

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-run-id', runId)

  return c.body(readable)
}

/**
 * GET /api/v1/chats/:id/stream — SSE stream of the chat's active run.
 *
 * Executes the chat's bound workflow using the internal @dagents/workflow engine
 * and streams token events via SSE.
 */
chatRoutes.get('/:id/stream', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // Fetch the latest user message (the prompt for execution) alongside chat metadata.
  let chat: Awaited<ReturnType<typeof getChatExecutionBinding>>
  let lastUserMsg: string | null = null
  try {
    chat = await getChatExecutionBinding(id)
    if (chat) {
      lastUserMsg = await getLatestUserMessage(id)
    }
  } catch (err) {
    log.error('chat stream lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!chat) return fail(c, 404, 'chat not found', { id })

  // ─── Agent-based execution (no flow_id, but agent_id is set) ───
  // When the user selects an agent in the chat UI (e.g. claude-code),
  // chat.agent_id is set but flow_id may be null. We dispatch a task
  // to the agent via the dispatch service and stream the output back.
  if (!chat.flow_id && chat.agent_id) {
    return await streamAgentExecution(c, id, chat.agent_id, lastUserMsg)
  }

  // ─── Flow-based execution ───
  if (!chat.flow_id) {
    return fail(c, 400, 'chat has no flow_id — bind a flow via PATCH /chats/:id first', { id })
  }

  let flowRow: Awaited<ReturnType<typeof getFlowDataById>>
  try {
    flowRow = await getFlowDataById(chat.flow_id)
  } catch (err) {
    log.error('chat stream flow lookup failed', { id, flowId: chat.flow_id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!flowRow) {
    return fail(c, 404, 'flow not found', { flowId: chat.flow_id })
  }

  const flowData = flowRow.flow_data as FlowData
  if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
    return fail(c, 400, 'invalid flow data', { flowId: chat.flow_id })
  }

  // 同 workflows.ts：非 UUID 的 x-run-id 会让落库静默失败，直接忽略换新生成
  const rawChatRunId = c.req.header('x-run-id')?.trim()
  const runId = rawChatRunId && UUID_RE.test(rawChatRunId) ? rawChatRunId : randomUUID()
  const streamer = new SseStreamer(id)

  // Cancellation handle (execution-cancellation spec D4): the SSE flow run
  // registers by chat — POST /chats/:id/cancel aborts the engine signal and
  // this handler persists the cancelled terminal + ends the stream.
  const abort = new AbortController()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  // run 并发闸（稳定性专项）：达上限诚实 429——SSE 尚未开流，拒绝不留半状态。
  const releaseRunSlot = tryAcquireRunSlot()
  if (!releaseRunSlot) {
    return fail(c, 429, `并发运行已达上限（${MAX_CONCURRENT_RUNS()}）——请取消闲置运行或稍后重试`, {
      active: runGateStats().active,
    })
  }
  let finalRunStatus: string | null = null

  const handle: ExecutionHandle = {
    chatId: id,
    runId,
    kind: 'chat-stream',
    startedAt: Date.now(),
    abort: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled by caller')),
    // 运行中插话（2026-09-08 可操作终端）：chat 触发的工作流运行与画布直跑同权
    sendToNode: (nodeId: string, text: string) => sendToRunNode(runId, nodeId, text),
    done,
  }
  executionRegistry.register(handle)

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-run-id', runId)

  // The streamer buffers until `toReadableStream()` attaches the live
  // controller, so this metadata event is delivered even though it fires
  // before the response body starts.
  streamer.streamMetadataEvent(id, { chatId: id, runId, sessionId: runId })

  const prompt = lastUserMsg ?? ''
  ;(async () => {
    let finalText = ''
    let cancelled = false
    // run-live 收口句柄提到 try 外：外层 catch（装配/执行异常路径）也要关流，
    // 否则画布旁观者靠 2 分钟 idle 兜底才发现结束（架构审计 G5）。
    let live: RunLiveTap | undefined
    try {
      // CLI-first：无 provider 时 LLM/Agent 节点跑本地 CLI（零配置基线）。
      // 工作目录 = 会话绑定的项目目录（和聊天 inline 执行一致）。
      let chatCwd: string | undefined
      if (chat.directory_id) {
        try {
          chatCwd = (await getDirectoryPath(chat.directory_id)) ?? undefined
        } catch {
          /* 目录解析失败回落网关 cwd */
        }
      }
      // 引擎装配单一来源（与画布直跑 / @flow 路径共用）：chat 触发的
      // 工作流与画布直跑共用同一进度数据源，画布可通过
      // /workflows/:flowId/canvas?run=<id> 实时旁观 chat 发起的运行。
      const {
        executor,
        live: liveTap,
        baseOptions,
      } = assembleWorkflowEngine({
        flowData,
        runId,
        flowId: chat.flow_id!,
        cwd: chatCwd,
        logger: log,
        flowContextMd: flowRow.context_md ?? null,
      })
      live = liveTap
      // HumanInput nodes park on the user's next message in this chat
      // (see human-input.ts).
      const humanInputResolver = createChatHumanInputResolver({ chatId: id, runId, streamer })
      const result = await executor.execute(flowData, prompt, {
        ...baseOptions,
        chatId: id,
        runId,
        state: {},
        isLastNode: true,
        sseStreamer: streamer,
        startInput: prompt,
        signal: abort.signal,
        humanInputResolver,
      })
      finalText = extractReplyText(result.finalOutput)
      if (result.status === 'cancelled') {
        cancelled = true
        finalRunStatus = 'cancelled'
        streamer.streamErrorEvent(id, 'Execution cancelled by user')
      } else if (result.status === 'budget_exceeded') {
        finalRunStatus = 'failed'
        streamer.streamErrorEvent(id, result.error ?? 'token 预算超限，运行停机')
      } else if (result.status !== 'success' && result.status !== 'partial_success') {
        finalRunStatus = 'failed'
        streamer.streamErrorEvent(id, result.error ?? 'workflow execution failed')
      } else {
        finalRunStatus = result.status === 'partial_success' ? 'partial_success' : 'completed'
      }
      // runs 行：chat 触发的工作流运行也进 flow 运行历史，且画布旁观
      // （canvas?run=）依赖它判断终态。best-effort —— 失败不影响流。
      try {
        const runStatus = toRunStatus(result.status)
        // 运行实时终端：chat 流式运行 settle 上报终态（画布旁观者关流）。
        live.finish(runStatus)
        await upsertChatWorkflowRunRow({
          runId,
          flowId: chat.flow_id!,
          chatId: id,
          status: runStatus,
          inputJson: JSON.stringify(prompt.slice(0, 200)),
          outputJson: JSON.stringify(finalText.slice(0, 500) || null),
          startedAtIso: new Date(handle.startedAt).toISOString(),
          durationMs: Math.max(0, Date.now() - handle.startedAt),
          directoryId: chat.directory_id ?? null,
        })
      } catch (err) {
        log.warn('chat stream runs row persist failed', { id, runId, error: String(err) })
      }
    } catch (err) {
      live?.finish('failed')
      log.error('chat stream execution failed', { id, error: String(err) })
      streamer.streamErrorEvent(id, String(err))
    } finally {
      // User cancel: persist the cancelled terminal (chat:cancelled WS frame
      // included) instead of the normal assistant-reply persistence.
      if (cancelled) {
        try {
          await persistCancelled({ chatId: id, runId, reason: 'user cancelled' })
        } catch (err) {
          log.warn('persistCancelled failed on stream cancel', { id, runId, error: String(err) })
        }
      }
      // Persist the assistant reply so the conversation history survives a
      // page reload (best-effort — the stream already delivered the text).
      else if (finalText.length > 0) {
        try {
          await insertAssistantChatMessage(
            id,
            finalText,
            runId,
            JSON.stringify({ source: 'workflow' }),
          )
          await bumpChatAfterAssistantMessage(id, finalText.slice(0, 200))
          // 滚动摘要钩子（P1b）：与 persistComplete 同款 fire-and-forget
          void maybeUpdateChatSummary(id)
        } catch (err) {
          log.warn('persist assistant reply failed', { id, runId, error: String(err) })
        }
      } else {
        try {
          await setChatStatusIdle(id)
        } catch {
          // best-effort status reset — ignore errors once the stream closed
        }
      }
      streamer.streamEndEvent(id)
      resolveDone()
      executionRegistry.unregister(handle)
      releaseRunSlot()
      recordRunFinished(finalRunStatus ?? 'failed')
    }
  })().catch((err) => {
    log.error('chat stream async loop crashed', { id, runId, error: String(err) })
    resolveDone()
    executionRegistry.unregister(handle)
    releaseRunSlot()
    recordRunFinished(finalRunStatus ?? 'failed')
  })

  return c.body(streamer.toReadableStream())
})

/** Pull a printable reply string out of a flow's final output record.
 *  DirectReply 节点的 content 常是「字符串化的上游 JSON」（引擎把上游
 *  output 记录 stringify 后塞进 content）—— 二次解包取 text/content，
 *  否则用户在聊天里看到一坨 {"text":…} JSON，像工作流没生效。 */
function extractReplyText(finalOutput: Record<string, unknown> | null): string {
  if (!finalOutput) return ''
  const raw =
    typeof finalOutput.content === 'string' && finalOutput.content
      ? finalOutput.content
      : typeof finalOutput.text === 'string' && finalOutput.text
        ? finalOutput.text
        : ''
  if (!raw) return ''
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const inner = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof inner.text === 'string' && inner.text) return inner.text
      if (typeof inner.content === 'string' && inner.content) return inner.content
    } catch {
      // 不是合法 JSON —— 按原文返回
    }
  }
  return raw
}

chatRoutes.get('/:id/runs', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // runs.chat_id is TEXT, so cast chat id to text for the comparison.
  let rows: Awaited<ReturnType<typeof listRunsForChat>>
  try {
    rows = await listRunsForChat(id)
  } catch (err) {
    log.error('chat runs query failed', { id, error: String(err) })
    return fail(c, 502, 'chat runs failed')
  }

  return ok(c, {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString(),
      finishedAt:
        r.finished_at instanceof Date
          ? r.finished_at.toISOString()
          : r.finished_at
            ? new Date(r.finished_at).toISOString()
            : null,
      // 执行卡用：流程名 + 耗时（「⚡ 工作流 · Skill测试Flowv4 · 12.8s」）
      durationMs: r.duration_ms ?? null,
      flowId: r.pipeline_id ?? null,
      flowName: r.flow_name ?? null,
    })),
  })
})
