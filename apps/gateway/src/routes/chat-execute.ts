import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, type FlowData } from '@dagents/workflow'
import { executeInline } from '../inline-executor.js'
import { persistComplete } from './internal-runs-helpers.js'

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
  // Write a system message acknowledging the command so the user sees feedback.
  // The downstream invocation (executeInline for @agent; scheduler/dispatch for
  // @flow/@daemon) is dispatched below by kind.
  const ack = formatCommandAck(cmd)
  let systemMessageId: string | undefined
  try {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO chat_messages (chat_id, role, content, metadata)
       VALUES ($1::uuid, 'system', $2, $3)
       RETURNING id`,
      [chatId, ack.text, JSON.stringify({ command: cmd })],
    )
    systemMessageId = records[0]?.id
  } catch (err) {
    log.error('routeCommand system message insert failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'command ack failed' }
  }

  switch (cmd.kind) {
    case 'agent':
      return routeAgentCommand(chatId, cmd, systemMessageId)
    case 'flow':
      return routeFlowCommand(chatId, cmd, systemMessageId)
    case 'daemon':
      return routeDaemonCommand(chatId, cmd, systemMessageId)
  }
}

/**
 * Route an @agent command: resolve the agent by name from agent_daemons,
 * resolve the chat's cwd from its directory binding, then fire-and-forget
 * executeInline (which spawns the claude CLI, streams tokens via WS, and
 * writes the assistant message on completion). Returns immediately so the
 * HTTP response can render an optimistic ack.
 */
async function routeAgentCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Resolve agent by name (cmd.target) → agentId.
  // NOTE: agent_daemons has no status column as of this writing; lookup is by
  // name only. If a status concept is needed later, add a column + filter here.
  let agent: { id: string } | undefined
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM agent_daemons WHERE name = $1 LIMIT 1`,
      [cmd.target],
    )
    agent = records[0]
  } catch (err) {
    log.error('routeAgentCommand agent lookup failed', {
      chatId,
      target: cmd.target,
      error: String(err),
    })
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Agent not found: ${cmd.target}`,
        command: cmd,
        systemMessageId,
        error: 'agent lookup failed',
      },
      systemMessageId,
    }
  }

  if (!agent) {
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Agent not found: ${cmd.target}`,
        command: cmd,
        systemMessageId,
        error: 'agent not found',
      },
      systemMessageId,
    }
  }

  // Resolve cwd from the chat's directory binding so claude runs against
  // the user's project (matches the directory selector in the UI).
  let cwd: string | undefined
  try {
    const dirRes = await runQuery<{ directory_path: string | null }>(
      `SELECT d.path AS directory_path
         FROM chats c
         JOIN directories d ON d.id = c.directory_id
        WHERE c.id = $1::uuid`,
      [chatId],
    )
    cwd = dirRes.records[0]?.directory_path ?? undefined
  } catch (err) {
    log.warn('routeAgentCommand directory lookup failed', { chatId, error: String(err) })
  }

  // Fire-and-forget executeInline — it writes the assistant message and
  // pushes chat:done via wsHub when finished. We don't await here so the
  // HTTP response returns immediately with the ack.
  const runId = randomUUID()
  void executeInline(chatId, agent.id, cmd.message || '(no message)', { cwd }).catch((err) => {
    log.error('routeAgentCommand executeInline failed', {
      chatId,
      agentId: agent.id,
      runId,
      error: String(err),
    })
  })

  return {
    mode: 'json',
    payload: {
      ack: `⚡ Routed to agent: ${cmd.target}`,
      command: cmd,
      systemMessageId,
      runId,
    },
    systemMessageId,
  }
}

/**
 * Route a @flow command: resolve the flow by name from the `flows` table,
 * mark the chat as running + bind the flow_id, then fire-and-forget execute
 * the workflow via the `@dagents/workflow` engine (mirroring the pattern in
 * `workflows.ts` POST /:id/run). The result is written back to chat via
 * `persistComplete` (assistant message + chat:done WS broadcast).
 *
 * Returns immediately with an ack payload so the HTTP response can render an
 * optimistic bubble; the actual execution happens asynchronously.
 */
async function routeFlowCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Resolve flow by name (cmd.target). Exclude 'archived' flows — only
  // draft + published are runnable from chat.
  let flow: { id: string } | undefined
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM flows WHERE name = $1 AND status IN ('draft', 'published') LIMIT 1`,
      [cmd.target],
    )
    flow = records[0]
  } catch (err) {
    log.error('routeFlowCommand flow lookup failed', {
      chatId,
      target: cmd.target,
      error: String(err),
    })
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Flow lookup failed: ${cmd.target}`,
        command: cmd,
        systemMessageId,
        error: 'flow lookup failed',
      },
      systemMessageId,
    }
  }

  if (!flow) {
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Flow not found: ${cmd.target}`,
        command: cmd,
        systemMessageId,
        error: 'flow not found',
      },
      systemMessageId,
    }
  }

  // Mark chat as running + bind flow_id (text column — accepts any string).
  await runQuery(
    `UPDATE chats SET status = 'running', flow_id = $1, updated_at = NOW() WHERE id = $2::uuid`,
    [flow.id, chatId],
  ).catch((err) => {
    log.warn('routeFlowCommand status update failed', { chatId, flowId: flow!.id, error: String(err) })
  })

  const runId = randomUUID()

  // Fire-and-forget execution — persistComplete writes the assistant message
  // and pushes chat:done via wsHub when finished. We don't await here so the
  // HTTP response returns immediately with the ack.
  void (async () => {
    const startedAt = Date.now()
    try {
      const { records } = await runQuery<{ flow_data: unknown }>(
        `SELECT flow_data FROM flows WHERE id = $1::uuid`,
        [flow.id],
      )
      const flowRow = records[0]
      if (!flowRow) {
        await writeErrorSystemMessage(chatId, `Flow execution failed: flow ${flow.id} not loadable`)
        await persistComplete({
          chatId,
          runId,
          output: `Flow execution failed: flow ${cmd.target} not loadable`,
          status: 'failed',
          durationMs: Date.now() - startedAt,
        })
        return
      }

      const flowData = flowRow.flow_data as FlowData
      if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
        await persistComplete({
          chatId,
          runId,
          output: `Flow execution failed: invalid flow data for ${cmd.target}`,
          status: 'failed',
          durationMs: Date.now() - startedAt,
        })
        return
      }

      // Mirror the engine invocation from workflows.ts POST /:id/run.
      const registry = new NodeRegistry()
      registry.registerMany(allNodes())
      const executor = new DagExecutor(registry)

      const result = await executor.execute(flowData, cmd.message, {
        chatId,
        runId,
        state: {},
        isLastNode: true,
        startInput: cmd.message,
      })

      const durationMs = Date.now() - startedAt
      if (result.status === 'success') {
        // finalOutput is Record<string, unknown> | null — extract a string
        // for chat rendering. DirectReply nodes emit { content: string };
        // fall back to JSON for any other shape.
        const out = result.finalOutput
        const output =
          out && typeof out.content === 'string'
            ? out.content
            : out != null
              ? JSON.stringify(out)
              : ''
        await persistComplete({
          chatId,
          runId,
          output: output || `(flow ${cmd.target} completed with no output)`,
          status: 'completed',
          durationMs,
        })
      } else {
        await persistComplete({
          chatId,
          runId,
          output: `Flow execution failed: ${result.error ?? 'unknown error'}`,
          status: 'failed',
          durationMs,
        })
      }
    } catch (err) {
      log.error('routeFlowCommand execution failed', {
        chatId,
        flowId: flow.id,
        runId,
        error: String(err),
      })
      try {
        await persistComplete({
          chatId,
          runId,
          output: `Flow execution failed: ${String(err)}`,
          status: 'failed',
          durationMs: Date.now() - startedAt,
        })
      } catch (persistErr) {
        log.error('routeFlowCommand persistComplete failed', {
          chatId,
          runId,
          error: String(persistErr),
        })
      }
    }
  })()

  return {
    mode: 'json',
    payload: {
      ack: `⚡ Flow triggered: ${cmd.target}`,
      command: cmd,
      systemMessageId,
      runId,
      flowId: flow.id,
    },
    systemMessageId,
  }
}

async function writeErrorSystemMessage(chatId: string, text: string): Promise<void> {
  await runQuery(
    `INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1::uuid, 'system', $2, NOW())`,
    [chatId, text],
  ).catch((err) => {
    log.error('writeErrorSystemMessage failed', { chatId, error: String(err) })
  })
}

// Stub — real wiring lands in Task 1.4 (dispatch.invoke for @daemon).
async function routeDaemonCommand(
  _chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  return {
    mode: 'json',
    payload: {
      ack: `⚡ Daemon invoked: ${cmd.message}`,
      command: cmd,
      systemMessageId,
      error: 'not wired yet',
    },
    systemMessageId,
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
