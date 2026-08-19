import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, CANVAS_NODES, type FlowData } from '@dagents/workflow'
import { executeInline, INLINE_SUPPORTED_KINDS } from '../inline-executor.js'
import { persistComplete } from './internal-runs-helpers.js'
import { enqueueTask } from './dispatch/service.js'
import {
  createLlmClient,
  createCliLlmClient,
  createDefaultLlmClient,
  createAgentFetcher,
  createBuiltInToolRegistry,
  createHistoryRetriever,
  resetProviderCache,
} from './workflow-clients.js'
import { skillsRegistry } from '../skills-registry.js'

const log = createLogger({ svc: 'gateway:chat-execute' })

export type CommandKind = 'flow' | 'daemon' | 'agent' | 'workflow'

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
  if (kind !== 'flow' && kind !== 'daemon' && kind !== 'agent' && kind !== 'workflow') return null

  if (kind === 'daemon') {
    const message = parts.slice(1).join(' ').trim()
    return { kind: 'daemon', target: null, message }
  }

  if (kind === 'workflow') {
    const message = parts.slice(1).join(' ').trim()
    return { kind: 'workflow', target: null, message }
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
  let agentId = opts.agentIdOverride ?? chat.agent_id

  // "auto" fallback: when neither override nor chat.agent_id is set, pick an
  // agent that can actually run inline (CLI kinds). Prefer the agents table
  // (v0.3 domain model), fall back to agent_daemons (legacy dispatch model).
  // Kind 过滤是必须的：remote 等类型需要 daemon 在线，inline executor 无法
  // spawn —— 若不过滤，auto 会话可能绑定到必然执行失败的 agent。
  // 兜底顺序：① agents 表可本机执行 → ② agent_daemons 可本机执行 →
  // ③ agents 表任意（执行时报友好错误）→ ④ agent_daemons 任意。
  if (!flowId && !agentId) {
    const inlineKinds = [...INLINE_SUPPORTED_KINDS]
    const pickAgentId = async (sql: string, params?: unknown[]): Promise<string | null> => {
      try {
        const { records } = await runQuery<{ id: string }>(sql, params)
        return records[0]?.id ?? null
      } catch (err) {
        log.error('routeMessage auto-agent lookup failed', { chatId, error: String(err) })
        return null
      }
    }
    agentId =
      (await pickAgentId(
        `SELECT id FROM agents WHERE kind = ANY($1::text[]) ORDER BY created_at ASC LIMIT 1`,
        [inlineKinds],
      )) ??
      (await pickAgentId(
        `SELECT id FROM agent_daemons WHERE kind = ANY($1::text[]) ORDER BY created_at ASC LIMIT 1`,
        [inlineKinds],
      )) ??
      (await pickAgentId(`SELECT id FROM agents ORDER BY created_at ASC LIMIT 1`)) ??
      (await pickAgentId(`SELECT id FROM agent_daemons ORDER BY created_at ASC LIMIT 1`))

    // Persist the resolved agent onto the chat row so subsequent messages
    // skip this lookup (and the chat-detail context panel shows the binding).
    if (agentId) {
      try {
        await runQuery(
          `UPDATE chats SET agent_id = $1::uuid, updated_at = NOW() WHERE id = $2::uuid`,
          [agentId, chatId],
        )
      } catch (err) {
        log.warn('routeMessage auto-agent persist failed', { chatId, agentId, error: String(err) })
      }
    }
  }

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
    case 'workflow':
      return routeWorkflowCommand(chatId, cmd, systemMessageId)
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
  // Check both agents (v0.3 domain model) and agent_daemons (legacy).
  let agent: { id: string } | undefined
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM agents WHERE name = $1 LIMIT 1`,
      [cmd.target],
    )
    agent = records[0]
    if (!agent) {
      // fallback to agent_daemons
      const { records: adRecords } = await runQuery<{ id: string }>(
        `SELECT id FROM agent_daemons WHERE name = $1 LIMIT 1`,
        [cmd.target],
      )
      agent = adRecords[0]
    }
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

      // Mirror the engine invocation from workflows.ts POST /:id/run —
      // including the client injection. Without these, LLM/Agent/PlatformAgent
      // nodes throw "LLM client is not available" and only pure-compute flows
      // (CustomFunction/DirectReply/…) can run via @flow. e2e TR-02 pins this.
      resetProviderCache()
      const llmClient = createDefaultLlmClient()
      const agentFetcher = createAgentFetcher()
      const toolRegistry = createBuiltInToolRegistry()
      const historyRetriever = createHistoryRetriever(chatId)

      const registry = new NodeRegistry()
      registry.registerMany(allNodes())
      const executor = new DagExecutor(registry)

      const result = await executor.execute(flowData, cmd.message, {
        chatId,
        runId,
        state: {},
        isLastNode: true,
        startInput: cmd.message,
        llmClient,
        agentFetcher,
        toolRegistry,
        historyRetriever,
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

/**
 * Build the workflow-generator system prompt. Exported for unit tests.
 *
 * CLI-first: generation runs on the local CLI by default (same execution
 * mechanism as chat), with an HTTP provider only as fallback insurance.
 * The prompt carries the REAL platform inventories — agents (so "claude a
 * 做规划" maps to a platformAgentAgentflow node with the agent's UUID) and
 * installed skills — because a generator that can only invent anonymous LLM
 * nodes cannot orchestrate what the platform actually has.
 */
export function buildWorkflowGeneratorPrompt(
  userDesc: string,
  agents: { id: string; name: string; kind: string; summary: string }[],
  skills: { name: string; description: string }[],
): string {
  const nodeNames = CANVAS_NODES.map((n) => `${n.name} (${n.label})`).join(', ')
  const agentLines = agents.length
    ? agents.map((a) => `- ${a.name} | kind=${a.kind} | id=${a.id}${a.summary ? ` | ${a.summary.slice(0, 80)}` : ''}`).join('\n')
    : '(no agents registered — do not use platformAgentAgentflow)'
  const skillLines = skills.length
    ? skills.slice(0, 40).map((s) => `- ${s.name}: ${s.description.slice(0, 80)}`).join('\n')
    : '(no skills installed)'
  return `You are a workflow designer for the Dagents platform.
Given a user's description, generate a valid FlowData JSON object with "nodes" and "edges" arrays.

Available node types (use these EXACT values in data.name):
${nodeNames}

Platform agents (for platformAgentAgentflow nodes, set data.inputs.agentId to the agent's id):
${agentLines}

Installed skills (agents may reference these; skills influence instructions, not node config):
${skillLines}

Rules:
- Every flow MUST start with a node whose data.name is "startAgentflow"
- Use unique node ids like "node_1", "node_2", etc.
- Each node MUST have: id, type: "customNode", position: {x, y}, data: { name, label, ...config }
- When the user mentions an agent/role doing work (e.g. "claude a 做需求规划"), use a platformAgentAgentflow node bound to the matching agent id above
- Every platformAgentAgentflow node MUST set data.inputs.systemPrompt to a concrete, self-contained task instruction for THAT step's role (in the user's language): what this role is responsible for, what input it receives, and what deliverable it must produce. Never rely on the node label alone — the label is display-only and never reaches the model.
- For LLM nodes (data.name: "llmAgentflow"), set data.model and data.systemPrompt
- For DirectReply nodes (data.name: "directReplyAgentflow"), set data.content
- Position nodes in a left-to-right layout with ~250px spacing
- Return ONLY the JSON object, no markdown fences, no explanation

User description:
${userDesc}

Example structure:
{"nodes":[{"id":"node_1","type":"customNode","position":{"x":0,"y":200},"data":{"name":"startAgentflow","label":"Start"}},{"id":"node_2","type":"customNode","position":{"x":250,"y":200},"data":{"name":"platformAgentAgentflow","label":"规划","inputs":{"agentId":"<uuid from the list above>","systemPrompt":"你是需求规划角色。根据上游输入梳理目标与约束，产出结构化的需求规划（目标、范围、验收标准）。"}}},{"id":"node_3","type":"customNode","position":{"x":500,"y":200},"data":{"name":"directReplyAgentflow","label":"Direct Reply","content":"Done"}}],"edges":[{"id":"edge_1","source":"node_1","target":"node_2"},{"id":"edge_2","source":"node_2","target":"node_3"}]}`
}

/**
 * Route a @workflow command. CLI-first: the flow JSON is generated by the
 * local CLI (same zero-config path as chat); an HTTP provider is only used
 * as fallback insurance when the CLI spawn fails. The result is persisted as
 * a new flow and pushed via `persistComplete` → WebSocket `chat:done`.
 */
async function routeWorkflowCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  const runId = randomUUID()
  const userDesc = cmd.message || '创建一个简单的工作流'

  // Fire-and-forget — generation + DB insert happen async, result pushed via WS.
  void (async () => {
    const startedAt = Date.now()
    try {
      // 1. Real platform inventories so the generator maps roles to agents.
      const [{ records: agentRows }, skills] = await Promise.all([
        runQuery<{ id: string; name: string; kind: string; summary: string }>(
          `SELECT id, name, kind, summary FROM agents ORDER BY name`,
          [],
        ),
        Promise.resolve(
          skillsRegistry.list().map(({ name, description }) => ({ name, description })),
        ),
      ])
      const systemPrompt = buildWorkflowGeneratorPrompt(userDesc, agentRows, skills)

      // 2. Generate the flow JSON — CLI first, HTTP provider as insurance.
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userDesc },
      ]
      let llmResult: { text: string }
      try {
        llmResult = await createCliLlmClient('claude').chat({ model: '', messages })
      } catch (cliErr) {
        log.warn('workflow generation via CLI failed, trying HTTP provider', {
          chatId, runId, error: String(cliErr),
        })
        llmResult = await createLlmClient().chat({
          model: '',
          messages,
          temperature: 0.7,
        })
      }

      // 3. Parse the generated JSON
      let flowData: FlowData
      try {
        // Strip markdown fences if present
        const cleaned = llmResult.text
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim()
        flowData = JSON.parse(cleaned) as FlowData

        // Basic validation
        if (!Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
          throw new Error('missing nodes or edges arrays')
        }
        if (flowData.nodes.length === 0) {
          throw new Error('empty nodes array')
        }
      } catch (parseErr) {
        log.warn('routeWorkflowCommand LLM output parse failed, using fallback', {
          chatId, runId, error: String(parseErr),
          rawOutput: llmResult.text.slice(0, 300),
        })
        // Fallback: minimal Start → LLM → DirectReply
        flowData = {
          nodes: [
            { id: 'node_1', type: 'customNode', position: { x: 0, y: 200 }, data: { name: 'startAgentflow', label: 'Start' } },
            { id: 'node_2', type: 'customNode', position: { x: 250, y: 200 }, data: { name: 'llmAgentflow', label: 'LLM', model: '', systemPrompt: userDesc } },
            { id: 'node_3', type: 'customNode', position: { x: 500, y: 200 }, data: { name: 'directReplyAgentflow', label: 'Direct Reply', content: '' } },
          ],
          edges: [
            { id: 'edge_1', source: 'node_1', target: 'node_2' },
            { id: 'edge_2', source: 'node_2', target: 'node_3' },
          ],
        }
      }

      // 4. Generate a flow name from the user description
      const flowName = userDesc.slice(0, 40).trim() || 'AI生成的工作流'

      // 5. Persist to DB
      const { records } = await runQuery<{ id: string }>(
        `INSERT INTO flows (name, description, flow_data, status)
         VALUES ($1, $2, $3, 'draft')
         RETURNING id`,
        [flowName, `由聊天 @workflow 命令生成: ${userDesc}`, JSON.stringify(flowData)],
      )
      const flowId = records[0]?.id

      if (!flowId) {
        throw new Error('flow insert returned no id')
      }

      log.info('routeWorkflowCommand flow created', { chatId, runId, flowId, nodeCount: flowData.nodes.length })

      // 6. Reply in chat with canvas link
      const nodeCount = flowData.nodes.length
      const canvasUrl = `/workflows/${flowId}/canvas`
      const output = [
        `✅ 工作流已创建！`,
        ``,
        `**名称**: ${flowName}`,
        `**节点数**: ${nodeCount}`,
        `**描述**: ${userDesc}`,
        ``,
        `👉 [打开画布编辑](${canvasUrl})`,
        ``,
        `你可以在画布中调整节点参数，然后点击"发布"来运行它。`,
      ].join('\n')

      await persistComplete({
        chatId,
        runId,
        output,
        status: 'completed',
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      log.error('routeWorkflowCommand failed', { chatId, runId, error: String(err) })
      try {
        await persistComplete({
          chatId,
          runId,
          output: `工作流创建失败: ${String(err)}`,
          status: 'failed',
          durationMs: Date.now() - startedAt,
        })
      } catch (persistErr) {
        log.error('routeWorkflowCommand persistComplete failed', { chatId, runId, error: String(persistErr) })
      }
    }
  })()

  return {
    mode: 'json',
    payload: {
      ack: `⚡ 正在用 AI 生成工作流: ${userDesc}`,
      command: cmd,
      systemMessageId,
      runId,
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

/**
 * Route a @daemon command: read the chat's bound agent_id (used as the
 * `agentDaemonId` for dispatch) and its directory (used as `cwd`), then POST
 * to dispatch `/api/v1/dispatch/invoke` to enqueue a task on the agent's
 * daemon. Dispatch inserts a `dispatch_tasks` row at status `queued` and
 * returns `{ taskId }` immediately — the daemon later pulls the task via
 * `/daemons/:id/tasks/claim` and runs it async.
 *
 * Returns immediately with an ack payload containing `runId` + `taskId` so
 * the HTTP response can render an optimistic bubble. The chat is marked
 * `running`; completion is signalled separately:
 *
 *   - Dispatch's future callback to gateway `/internal/runs/:runId/complete`
 *     (spec §5.2 — NOT yet wired on the dispatch side; tracked separately), OR
 *   - The existing `recoverStaleRuns` cleanup mechanism resets stale chats.
 *
 * This fire-and-forget contract is acceptable for Task 1.4.
 */
async function routeDaemonCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // @daemon requires chat.agent_id (used as agentDaemonId for dispatch).
  // LEFT JOIN directories so chats without a directory still resolve (cwd undefined).
  let chat: { agent_id: string | null; directory_path: string | null } | undefined
  try {
    const { records } = await runQuery<{ agent_id: string | null; directory_path: string | null }>(
      `SELECT c.agent_id, d.path AS directory_path
         FROM chats c
         LEFT JOIN directories d ON d.id = c.directory_id
        WHERE c.id = $1::uuid`,
      [chatId],
    )
    chat = records[0]
  } catch (err) {
    log.error('routeDaemonCommand chat lookup failed', { chatId, error: String(err) })
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Daemon invoke failed: chat lookup`,
        command: cmd,
        systemMessageId,
        error: 'chat lookup failed',
      },
      systemMessageId,
    }
  }

  if (!chat?.agent_id) {
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Daemon invoked: ${cmd.message}`,
        command: cmd,
        systemMessageId,
        error: 'no agent bound to chat',
      },
      systemMessageId,
    }
  }

  const runId = randomUUID()
  try {
    const { taskId } = await enqueueTask({
      agentDaemonId: chat.agent_id,
      runId,
      prompt: cmd.message,
      execOptions: { cwd: chat.directory_path ?? undefined },
    })

    // Mark chat running — daemon will complete async (see jsdoc above).
    await runQuery(
      `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    ).catch((err) => {
      log.warn('routeDaemonCommand status=running update failed', { chatId, runId, error: String(err) })
    })

    return {
      mode: 'json',
      payload: {
        ack: `⚡ Daemon invoked: ${cmd.message}`,
        command: cmd,
        systemMessageId,
        runId,
        taskId,
      },
      systemMessageId,
    }
  } catch (err) {
    log.error('routeDaemonCommand dispatch invoke failed', { chatId, runId, error: String(err) })
    return {
      mode: 'json',
      payload: {
        ack: `⚡ Daemon invoke error: ${String(err)}`,
        command: cmd,
        systemMessageId,
        error: String(err),
      },
      systemMessageId,
    }
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
    case 'workflow':
      return { text: `⚡ 正在工作流生成中: ${cmd.message}` }
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
