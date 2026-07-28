import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { executeInline } from '../inline-executor.js'

const log = createLogger({ svc: 'gateway:chat-execute' })

export type CommandKind = 'flow' | 'daemon' | 'agent'

export interface ParsedCommand {
  kind: CommandKind
  target: string | null
  message: string
}

/**
 * Parse a @-prefixed command from message content.
 * Returns null when content is not a command (the common case — default agent routing).
 *
 *   @flow <name> <message...>     → { kind: 'flow', target: '<name>', message: '<message...>' }
 *   @daemon <message...>          → { kind: 'daemon', target: null, message: '<message...>' }
 *   @agent <name> <message...>    → { kind: 'agent', target: '<name>', message: '<message...>' }
 */
export function parseCommand(content: string): ParsedCommand | null {
  if (!content.startsWith('@')) return null
  const parts = content.slice(1).split(/\s+/)
  const kind = parts[0]
  if (kind !== 'flow' && kind !== 'daemon' && kind !== 'agent') return null

  if (kind === 'daemon') {
    const message = parts.slice(1).join(' ').trim()
    return { kind: 'daemon', target: null, message }
  }

  const target = parts[1] ?? ''
  const message = parts.slice(2).join(' ').trim()
  return { kind, target, message }
}

/**
 * Decide how a chat message should be routed after the user message is written.
 *
 *  - @flow / @daemon / @agent  → dispatch via scheduler/dispatch/agent-override; return JSON
 *  - default                   → caller pulls SSE from /chats/:id/stream using chatRunId
 *
 * The function does NOT execute the flow itself — it only resolves the routing
 * decision and (for @-commands) writes a system message + kicks off the
 * downstream call. The SSE stream route owns the actual workflow execution
 * using the internal @dagents/workflow engine so the client gets token-by-token
 * rendering.
 */
export async function routeMessage(
  chatId: string,
  content: string,
  opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  // 1. Fetch chat row to know agent_id / flow_id
  let chat: { id: string; agent_id: string | null; flow_id: string | null } | null
  try {
    const { records } = await runQuery<{ id: string; agent_id: string | null; flow_id: string | null }>(
      `SELECT id, agent_id, flow_id FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    chat = records[0] ?? null
  } catch (err) {
    log.error('routeMessage chat lookup failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'chat lookup failed' }
  }
  if (!chat) return { mode: 'json', error: 'chat not found' }

  const cmd = parseCommand(content)

  // 2. @-command routing
  if (cmd) {
    return await routeCommand(chatId, cmd, opts)
  }

  // 3. Default routing: agent_id → inline executor (WS push);
  //    flow_id → SSE stream (caller pulls /chats/:id/stream).
  const flowId = opts.flowIdOverride ?? chat.flow_id
  const agentId = opts.agentIdOverride ?? chat.agent_id
  if (!flowId && !agentId) {
    return { mode: 'json', error: 'no agent or flow bound to chat — set chat.agentId or chat.flowId, or use @agent' }
  }

  // Persist agent/flow overrides onto the chat row so subsequent reads
  // (stream endpoint, WS subscribers) see the same binding.
  const updates: string[] = []
  const params: unknown[] = []
  if (opts.agentIdOverride && opts.agentIdOverride !== chat.agent_id) {
    params.push(opts.agentIdOverride)
    updates.push(`agent_id = $${params.length}::uuid`)
  }
  if (opts.flowIdOverride && opts.flowIdOverride !== chat.flow_id) {
    params.push(opts.flowIdOverride)
    updates.push(`flow_id = $${params.length}::uuid`)
  }
  if (updates.length > 0) {
    params.push(chatId)
    try {
      await runQuery(
        `UPDATE chats SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::uuid`,
        params,
      )
    } catch (err) {
      log.warn('routeMessage override persist failed', { chatId, error: String(err) })
    }
  }

  // ─── Agent path: spawn claude CLI inline, push tokens via WebSocket ───
  // Browser subscribes to /ws?chat=<id> (or sends {type:'subscribe',chatId})
  // and receives chat:message / chat:done / chat:error frames. The HTTP
  // response returns immediately with mode='json' so the client can render
  // an optimistic assistant bubble and let WS fill it in.
  if (agentId) {
    // Resolve cwd from the chat's directory binding so claude runs against
    // the user's project (matches the directory selector in the UI).
    let cwd: string | undefined
    try {
      const { records } = await runQuery<{ directory_path: string | null }>(
        `SELECT d.path AS directory_path
           FROM chats c
           JOIN directories d ON d.id = c.directory_id
          WHERE c.id = $1::uuid`,
        [chatId],
      )
      cwd = records[0]?.directory_path ?? undefined
    } catch (err) {
      log.warn('routeMessage directory lookup failed', { chatId, error: String(err) })
    }

    const runId = randomUUID()
    // Fire-and-forget — the executor writes the assistant message and
    // pushes chat:done when finished. We don't await here so the HTTP
    // response returns immediately.
    void executeInline(chatId, agentId, content, { cwd }).catch((err) => {
      log.error('executeInline failed', { chatId, agentId, runId, error: String(err) })
    })

    return {
      mode: 'json',
      payload: {
        status: 'executing',
        message: 'Agent task started; streaming via WebSocket',
        runId,
      },
    }
  }

  // ─── Flow path: caller pulls SSE from /chats/:id/stream ───
  try {
    await runQuery(
      `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    )
  } catch (err) {
    log.warn('routeMessage status=running update failed', { chatId, error: String(err) })
  }

  return { mode: 'stream', chatRunId: randomUUID() }
}

async function routeCommand(
  chatId: string,
  cmd: ParsedCommand,
  _opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  // For now, write a system message acknowledging the command so the user sees feedback.
  // Real downstream invocation (scheduler.fanout / dispatch.invoke) is a follow-up —
  // the @-command surface is contracted here, the wiring is stubbed.
  const ack = formatCommandAck(cmd)
  try {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO chat_messages (chat_id, role, content, metadata)
       VALUES ($1::uuid, 'system', $2, $3)
       RETURNING id`,
      [chatId, ack.text, JSON.stringify({ command: cmd })],
    )
    return {
      mode: 'json',
      payload: { ack: ack.text, command: cmd, systemMessageId: records[0]?.id },
      systemMessageId: records[0]?.id,
    }
  } catch (err) {
    log.error('routeCommand system message insert failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'command ack failed' }
  }
}

function formatCommandAck(cmd: ParsedCommand): { text: string } {
  switch (cmd.kind) {
    case 'flow':
      return { text: `⚡ Flow triggered: ${cmd.target}${cmd.message ? ` — "${cmd.message}"` : ''}` }
    case 'daemon':
      return { text: `⚡ Daemon invoked: ${cmd.message}` }
    case 'agent':
      return { text: `⚡ Routed to agent: ${cmd.target}` }
  }
}

export interface RouteResult {
  /** 'stream' = caller pulls SSE from /chats/:id/stream; 'json' = return payload directly. */
  mode: 'stream' | 'json'
  /** When mode='stream', the chatRunId the client uses to subscribe. */
  chatRunId?: string
  /** When mode='json', the response payload (e.g. { taskId } from @daemon). */
  payload?: Record<string, unknown>
  /** When mode='json' and the route failed, an error string. */
  error?: string
  /** When the route writes a system message into chat_messages, its id (for client correlation). */
  systemMessageId?: string
}
