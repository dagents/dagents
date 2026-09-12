/**
 * POST /api/v1/workflows/runs/:runId/message — 运行中插话（2026-09-08
 * 可操作终端 PRD，docs/prd-operable-terminal.md）。
 *
 * 把用户消息路由到目标节点的活 CLI 会话：经 execution-registry 找到该
 * runId 的执行句柄，走 sendToNode 控制通道（abort 的姊妹动词）写入 CLI
 * 进程的 JSON 帧 stdin。同步 HTTP 响应即送达回执 —— 诚实三态：
 *   sent         已写入 CLI stdin（user_input 事件已回写进 span 通道）
 *   unsupported  执行路径无双向通道（HTTP provider 运行 / 适配器不支持）
 *   not_running  目标节点当前没有可收话的活会话（已结束 / 未开跑）
 * 409 = 该 runId 没有活执行（已结束 / 从未开始），与 cancel 语义对齐。
 *
 * 不做任意 shell：本路由只送用户消息文本；控制动词仅既有 cancel。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { executionRegistry } from '../execution-registry.js'

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** 保险丝（非语义截断）：插话是人打的一句话，32k 字符远超一切正常使用。 */
const MESSAGE_MAX_CHARS = 32_000

/** Mounted at /api/v1/workflows — POST /runs/:runId/message */
export const runMessageRoutes = new Hono()

runMessageRoutes.post('/runs/:runId/message', async (c) => {
  const runId = c.req.param('runId')
  const body = (await c.req.json().catch(() => null)) as {
    nodeId?: unknown
    text?: unknown
  } | null
  const nodeId = typeof body?.nodeId === 'string' ? body.nodeId.trim() : ''
  const text = typeof body?.text === 'string' ? body.text : ''

  if (!runId || !nodeId) {
    return fail(c, 400, 'runId and nodeId are required', { runId, nodeId })
  }
  if (text.length === 0) {
    return fail(c, 400, 'message text is required')
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    return fail(c, 400, `message too long (max ${MESSAGE_MAX_CHARS} chars)`)
  }

  const handle = executionRegistry.getByRun(runId)
  if (!handle) {
    return fail(c, 409, 'no active execution for this run', { runId })
  }
  if (!handle.sendToNode) {
    // 有活执行但该执行种类没有插话通道（inline chat 的 chat-agent 等）
    return ok(c, { runId, nodeId, status: 'unsupported' as const })
  }
  const status = handle.sendToNode(nodeId, text)
  return ok(c, { runId, nodeId, status })
})
