import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { createBackend } from '@dagents/agent-adapters'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { AgentResult } from '@dagents/contracts'

/**
 * POST /api/v1/agents/:id/invoke — synchronous one-shot agent invoke.
 *
 * Spawns the agent's CLI backend (same `createBackend` factory the inline
 * executor uses) with a prompt and returns the final text output. Unlike the
 * chat path (executeInline) it is NOT tied to a chat: no chat_messages row,
 * no WS broadcast — the HTTP response carries the result. Built for callers
 * that need "run this agent, give me the text" (e.g. the canvas AI flow
 * generator using a platform agent as the generation engine), and generally
 * useful for scripts.
 *
 * Mounted alongside the catalogue routes in agents.ts under /api/v1/agents.
 *
 * Timeout: the caller may pass timeoutMs (capped at 180s, default 180s).
 * On timeout we answer 504 immediately; the spawned CLI may finish in the
 * background (AgentSession has no kill hook) — acceptable for local dev.
 */

export const agentInvokeRoutes = new Hono()

const log = createLogger({ svc: 'gateway:agent-invoke' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const invokeBodySchema = z.object({
  prompt: z.string().min(1).max(100_000),
  cwd: z.string().max(1024).optional(),
  model: z.string().max(128).optional(),
  timeoutMs: z.number().int().min(1_000).max(180_000).optional(),
})

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 180_000

/** CLI kinds createBackend supports (mirrors inline-executor's list). */
const SUPPORTED_KINDS = [
  'claude', 'codex', 'qwen', 'copilot', 'opencode',
  'codebuddy', 'cursor', 'deveco', 'antigravity', 'openclaw', 'pi',
  'hermes', 'kimi', 'kiro', 'grok', 'qoder', 'traecli',
]

/** Resolve an agent's kind + executable: `agents` table first (v0.3 domain
 *  model), `agent_daemons` fallback (legacy dispatch rows carry the path). */
async function resolveAgent(id: string): Promise<{ kind: string; executablePath: string } | null> {
  const { records: agentRows } = await runQuery<{ kind: string }>(
    `SELECT kind FROM agents WHERE id = $1::uuid`,
    [id],
  )
  if (agentRows[0]) return { kind: agentRows[0].kind, executablePath: '' }

  const { records: daemonRows } = await runQuery<{ kind: string; executable_path: string | null }>(
    `SELECT kind, executable_path FROM agent_daemons WHERE id = $1::uuid`,
    [id],
  )
  if (!daemonRows[0]) return null
  return { kind: daemonRows[0].kind, executablePath: daemonRows[0].executable_path ?? '' }
}

agentInvokeRoutes.post('/:id/invoke', async (c) => {
  const id = c.req.param('id')

  let parsed: z.infer<typeof invokeBodySchema>
  try {
    parsed = invokeBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid invoke body', { detail: String(err) })
  }

  let agent: { kind: string; executablePath: string } | null
  try {
    agent = await resolveAgent(id)
  } catch (err) {
    log.error('invoke agent lookup failed', { id, error: String(err) })
    return fail(c, 502, 'agent lookup failed')
  }
  if (!agent) return fail(c, 404, 'agent not found', { id })
  if (!SUPPORTED_KINDS.includes(agent.kind)) {
    return fail(c, 400, `unsupported agent kind '${agent.kind}' (supported: ${SUPPORTED_KINDS.join(', ')})`)
  }

  const timeoutMs = Math.min(parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const startedAt = Date.now()

  let result: AgentResult
  let output = ''
  try {
    const backend = createBackend(agent.kind as never, { executablePath: agent.executablePath, logger: log })
    const session = backend.execute(parsed.prompt, { cwd: parsed.cwd, model: parsed.model })
    const collect = (async () => {
      for await (const evt of session.events) {
        if (evt.type === 'text') output += evt.content
      }
      return session.result
    })()
    // 超时后 race 已结算，但 collect 仍在跑；它随后 reject 会变成 unhandled
    // rejection 直接杀死整个 gateway 进程。挂一个兜底 catch 吞掉迟到的错误。
    collect.catch((err) => {
      log.warn('invoke collector settled after timeout/race', { id, error: String(err) })
    })
    result = await Promise.race([
      collect,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`invoke timed out after ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('timed out')) return fail(c, 504, msg)
    log.error('invoke execution failed', { id, error: msg })
    return fail(c, 502, 'agent execution failed', { detail: msg })
  }

  if (result.status === 'failed') {
    return fail(c, 502, 'agent process failed', { status: result.status })
  }

  log.info('invoke done', { id, kind: agent.kind, status: result.status, durationMs: Date.now() - startedAt, outputLen: output.length })
  return ok(c, {
    output: output || result.output || '',
    status: result.status,
    durationMs: Date.now() - startedAt,
  })
})
