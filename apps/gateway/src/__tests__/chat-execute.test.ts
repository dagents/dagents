import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { parseCommand } from '../routes/chat-execute.js'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import { enqueueTask } from '../routes/dispatch/service.js'

// Mock the in-process dispatch service so we can assert enqueueTask calls
// without touching the dispatch_tasks table. Plan A merged dispatch into
// gateway, so routeDaemonCommand now calls enqueueTask() directly instead
// of HTTP-fetching the dispatch service.
vi.mock('../routes/dispatch/service.js', () => ({
  enqueueTask: vi.fn(),
}))

let seededChatIds: string[] = []
let seededDirIds: string[] = []
let seededAgentIds: string[] = []
let seededDaemonIds: string[] = []
let seededDomainAgentIds: string[] = []

// 这些集成测试跑在真实开发库上。个别用例需要「agents 表完全为空」的前置，
// 全表清空会把开发数据（如手工创建的 Claude 助手）一起删掉 —— 因此清空后
// 必须在 cleanup 里恢复一个可用的默认 agent，保证跑完测试产品仍开箱可用。
const DEFAULT_AGENT_ID = '00000000-0000-4000-8000-000000000001'
const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
let wipedAgentsTable = false
/** wipeAllAgents 前的 agent_daemons 快照，cleanup 时原样恢复（守护开发数据）。 */
let agentDaemonsBackup: Array<{
  id: string
  name: string
  kind: string
  daemon_id: string | null
  capability_descriptor: unknown
  executable_path: string | null
  default_args: unknown
  workspace_id: string | null
  visibility: string | null
  created_at: Date | string
  updated_at: Date | string
}> = []
/**
 * wipeAllAgents 前的 agents 快照（全部列）。2026-08-20 修复：此前只恢复
 * agent_daemons + 一行默认 agent，agents 表本身的开发数据（人格库启用的
 * Agent、手工创建的 Agent）会被全表清空永久吞掉 —— 现在与 agent_daemons
 * 同策略：备份 → 清空 → cleanup 原样恢复。
 */
interface AgentRowBackup {
  id: string
  workspace_id: string
  name: string
  kind: string
  agent_type: string | null
  roles: unknown
  instructions: string
  skills: unknown
  visibility: string
  concurrency: number
  model: string
  runtime: string
  owner_id: string
  daemon_id: string | null
  flow_id: string | null
  activity: unknown
  status: string
  availability: string
  summary: string
  input_schema: string
  output_schema: string
  library_meta: unknown
  created_at: Date | string
  updated_at: Date | string
}
let agentsBackup: AgentRowBackup[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})
afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})
beforeEach(async () => {
  vi.mocked(enqueueTask).mockReset()
  await cleanup()
})
afterEach(async () => { await cleanup() })

async function cleanup(): Promise<void> {
  if (seededChatIds.length) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [seededChatIds])
    seededChatIds = []
  }
  if (seededDirIds.length) {
    await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [seededDirIds])
    seededDirIds = []
  }
  if (seededAgentIds.length) {
    await runQuery(`DELETE FROM agent_daemons WHERE id = ANY($1::uuid[])`, [seededAgentIds])
    seededAgentIds = []
  }
  if (seededDaemonIds.length) {
    await runQuery(`DELETE FROM daemons WHERE id = ANY($1::uuid[])`, [seededDaemonIds])
    seededDaemonIds = []
  }
  if (seededDomainAgentIds.length) {
    await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seededDomainAgentIds])
    seededDomainAgentIds = []
  }
  if (wipedAgentsTable) {
    await restoreDefaultAgent()
  }
}

/** 全表清空 agents / agent_daemons（仅在需要「无任何 agent」前置的用例中使用）。 */
async function wipeAllAgents(): Promise<void> {
  // 备份遗留 agent_daemons 行，cleanup 时恢复 —— 这些是开发数据，不能真删。
  const { records: daemonRows } = await runQuery<typeof agentDaemonsBackup[number]>(
    `SELECT id, name, kind, daemon_id, capability_descriptor, executable_path,
            default_args, workspace_id, visibility, created_at, updated_at
     FROM agent_daemons`,
  )
  agentDaemonsBackup = daemonRows
  // 同策略备份 agents 全表（含人格库启用的 Agent 等开发数据）。
  const { records: agentRows } = await runQuery<AgentRowBackup>(`SELECT * FROM agents`)
  agentsBackup = agentRows
  await runQuery(`DELETE FROM agent_daemons`)
  await runQuery(`DELETE FROM agents`)
  wipedAgentsTable = true
}

/** 恢复开发数据：备份的 agents / agent_daemons 行 + 保底的默认 Claude agent。 */
async function restoreDefaultAgent(): Promise<void> {
  for (const row of agentDaemonsBackup) {
    await runQuery(
      `INSERT INTO agent_daemons (id, name, kind, daemon_id, capability_descriptor,
                                  executable_path, default_args, workspace_id, visibility,
                                  created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id, row.name, row.kind, row.daemon_id, JSON.stringify(row.capability_descriptor ?? {}),
        row.executable_path, JSON.stringify(row.default_args ?? []), row.workspace_id, row.visibility,
        row.created_at, row.updated_at,
      ],
    )
  }
  agentDaemonsBackup = []
  for (const row of agentsBackup) {
    await runQuery(
      `INSERT INTO agents (id, workspace_id, name, kind, agent_type, roles, instructions, skills,
                           visibility, concurrency, model, runtime, owner_id, daemon_id, flow_id,
                           activity, status, availability, summary, input_schema, output_schema,
                           library_meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb,
               $9, $10, $11, $12, $13, $14, $15,
               $16::jsonb, $17, $18, $19, $20, $21,
               $22::jsonb, $23, $24)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id, row.workspace_id, row.name, row.kind, row.agent_type,
        JSON.stringify(row.roles ?? []), row.instructions, JSON.stringify(row.skills ?? []),
        row.visibility, row.concurrency, row.model, row.runtime, row.owner_id, row.daemon_id, row.flow_id,
        JSON.stringify(row.activity ?? []), row.status, row.availability, row.summary,
        row.input_schema, row.output_schema,
        row.library_meta === null || row.library_meta === undefined ? null : JSON.stringify(row.library_meta),
        row.created_at, row.updated_at,
      ],
    )
  }
  agentsBackup = []
  await runQuery(
    `INSERT INTO agents (id, workspace_id, name, kind, owner_id, status, availability, summary)
     VALUES ($1, $2, 'Claude 助手', 'claude', 'local', 'idle', 'online', 'Claude CLI agent')
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_AGENT_ID, DEFAULT_WORKSPACE_ID],
  )
  wipedAgentsTable = false
}

async function seedDirAndChat(opts: { agentId?: string | null; flowId?: string | null } = {}): Promise<{ dirId: string; chatId: string }> {
  const dirId = randomUUID()
  await runQuery(
    `INSERT INTO directories (id, path, name, settings) VALUES ($1, $2, $3, $4)`,
    [dirId, `/test-${dirId.slice(0, 8)}`, `Dir ${dirId.slice(0, 8)}`, '{}'],
  )
  seededDirIds.push(dirId)
  const chatId = randomUUID()
  await runQuery(
    `INSERT INTO chats (id, directory_id, title, agent_id, flow_id) VALUES ($1, $2, $3, $4, $5)`,
    [chatId, dirId, 'Test Chat', opts.agentId ?? null, opts.flowId ?? null],
  )
  seededChatIds.push(chatId)
  return { dirId, chatId }
}

async function seedAgent(name?: string): Promise<string> {
  // agent_daemons.daemon_id is NOT NULL and references daemons(id), so we
  // create a minimal daemon row first, then the agent_daemon row.
  const daemonId = randomUUID()
  await runQuery(
    `INSERT INTO daemons (id, label, token) VALUES ($1, $2, $3)`,
    [daemonId, `daemon-${daemonId.slice(0, 8)}`, `token-${daemonId.slice(0, 8)}`],
  )
  seededDaemonIds.push(daemonId)

  const agentId = randomUUID()
  await runQuery(
    `INSERT INTO agent_daemons (id, name, kind, daemon_id) VALUES ($1, $2, $3, $4)`,
    [agentId, name ?? `agent-${agentId.slice(0, 8)}`, 'claude', daemonId],
  )
  seededAgentIds.push(agentId)
  return agentId
}

/** 在 agents 表（v0.3 领域模型）插入一行，可指定 kind 与 created_at（用于排序）。 */
async function seedDomainAgent(kind: string, createdAt: Date): Promise<string> {
  const agentId = randomUUID()
  await runQuery(
    `INSERT INTO agents (id, workspace_id, name, kind, owner_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agentId, DEFAULT_WORKSPACE_ID, `agent-${kind}-${agentId.slice(0, 8)}`, kind, 'test', createdAt],
  )
  seededDomainAgentIds.push(agentId)
  return agentId
}

describe('parseCommand', () => {
  it('parses @flow <name> <message>', () => {
    const r = parseCommand('@flow my-flow do something')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: 'do something' })
  })

  it('parses @daemon <command>', () => {
    const r = parseCommand('@daemon status')
    expect(r).toEqual({ kind: 'daemon', target: null, message: 'status' })
  })

  it('parses @agent <name> <message>', () => {
    const r = parseCommand('@agent claude help me')
    expect(r).toEqual({ kind: 'agent', target: 'claude', message: 'help me' })
  })

  it('returns null for non-command', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for unknown @ command', () => {
    expect(parseCommand('@unknown foo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull()
  })

  it('handles @flow with no message (defaults to empty)', () => {
    const r = parseCommand('@flow my-flow')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: '' })
  })
})

describe('POST /api/v1/chats/:id/messages — default routing', () => {
  it('writes user message and returns json mode with executing payload when chat has agentId', async () => {
    const { chatId } = await seedDirAndChat({ agentId: randomUUID(), flowId: 'flow-abc' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { message: { id: string; role: string; content: string }; mode: string; payload?: { status?: string; runId?: string } }
    }
    expect(body.success).toBe(true)
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('hello there')
    // Agent path returns json mode (tokens stream via WebSocket, not SSE)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.status).toBe('executing')
    expect(body.data.payload?.runId).toBeTruthy()
  })

  it('auto-selects first agent when chat has no agentId and no flowId (auto mode)', async () => {
    // "auto" fallback: when chat has no agent binding, gateway picks an
    // inline-capable agent. We seed an agent_daemons row to guarantee a
    // candidate exists; assert the chat got *some* agent_id persisted.
    await seedAgent('default-agent')
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; payload?: { status?: string; runId?: string } }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.status).toBe('executing')
    expect(body.data.payload?.runId).toBeTruthy()

    // Verify the resolved agent was persisted onto the chat row so subsequent
    // messages skip the fallback lookup.
    const { records } = await runQuery<{ agent_id: string | null }>(
      `SELECT agent_id FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    expect(records[0]?.agent_id).not.toBeNull()
  })

  it('auto routing prefers an inline-capable agent over an older remote agent (P0 regression)', async () => {
    // 复现 2026-08-15 验收发现的 P0：auto 兜底曾按 created_at ASC 绑定最老
    // agent，当最老是 remote 类型（需 daemon）时新会话必然执行失败。
    // 期望：即使 remote agent 更老，也优先绑定 CLI 类型（claude）。
    await wipeAllAgents()
    const remoteId = await seedDomainAgent('remote', new Date(Date.now() - 60_000))
    const claudeId = await seedDomainAgent('claude', new Date())
    expect(remoteId).not.toBe(claudeId)
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)

    const { records } = await runQuery<{ agent_id: string | null }>(
      `SELECT agent_id FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    expect(records[0]?.agent_id).toBe(claudeId)
  })

  it('wipeAllAgents + restore preserves pre-existing agents rows (dev-data guard)', async () => {
    // 2026-08-20 P0 回归：wipeAllAgents 曾只恢复 agent_daemons + 一行默认
    // agent，agents 表的开发数据（人格库启用的、手工创建的）被全表清空
    // 永久吞掉（真机上吞掉了 7 个演示 Agent）。期望：wipe 后 cleanup 把
    // 备份的全部 agents 行原样恢复，library_meta 等 JSONB 列一字不差。
    const markerId = randomUUID()
    await runQuery(
      `INSERT INTO agents (id, workspace_id, name, kind, instructions, summary, owner_id, library_meta)
       VALUES ($1, $2, '库数据守护标记', 'claude', 'marker instructions', 'marker', 'local',
               $3::jsonb)`,
      [markerId, DEFAULT_WORKSPACE_ID, JSON.stringify({ id: 'guard/marker', profile: 'slim' })],
    )
    try {
      await wipeAllAgents()
      const { records: wiped } = await runQuery<{ count: string }>(
        `SELECT count(*)::text AS count FROM agents`,
      )
      expect(Number(wiped[0].count)).toBe(0)

      await restoreDefaultAgent()
      const { records } = await runQuery<{ instructions: string; library_meta: { id?: string } }>(
        `SELECT instructions, library_meta FROM agents WHERE id = $1::uuid`,
        [markerId],
      )
      expect(records[0]?.instructions).toBe('marker instructions')
      expect(records[0]?.library_meta).toMatchObject({ id: 'guard/marker', profile: 'slim' })
    } finally {
      await runQuery(`DELETE FROM agents WHERE id = $1::uuid`, [markerId])
    }
  })

  it('returns json mode with error when no agent is available (agent_daemons empty)', async () => {
    // Ensure no agents are available — the auto fallback should find nothing
    // in either agents or agent_daemons and return the error.
    await wipeAllAgents()
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; error?: string }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.error).toMatch(/no agent or flow bound/)
  })
})

describe('routeFlowCommand @flow wiring', () => {
  it('returns error payload when flow name not found', async () => {
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@flow nonexistent-flow do something' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: { ack?: string; error?: string; command?: { target?: string } }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toBe('flow not found')
    expect(body.data.payload?.ack).toMatch(/Flow not found: nonexistent-flow/)
    expect(body.data.payload?.command?.target).toBe('nonexistent-flow')
  })
})

describe('routeDaemonCommand @daemon wiring', () => {
  it('returns error payload when chat has no agent_id bound', async () => {
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon run scan' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: { ack?: string; error?: string; command?: { kind?: string; message?: string } }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toBe('no agent bound to chat')
    expect(body.data.payload?.ack).toMatch(/Daemon invoked: run scan/)
    expect(body.data.payload?.command?.kind).toBe('daemon')
    expect(body.data.payload?.command?.message).toBe('run scan')
  })

  it('enqueues task via in-process enqueueTask and returns runId + taskId', async () => {
    const agentId = randomUUID()
    const { chatId, dirId } = await seedDirAndChat({ agentId })
    const expectedTaskId = randomUUID()
    const expectedDirPath = `/test-${dirId.slice(0, 8)}`

    const mockEnqueue = vi.mocked(enqueueTask)
    mockEnqueue.mockResolvedValue({ taskId: expectedTaskId })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon rebuild the index' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: {
          ack?: string
          runId?: string
          taskId?: string
          command?: { kind?: string; message?: string }
        }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.taskId).toBe(expectedTaskId)
    expect(body.data.payload?.runId).toBeTruthy()
    expect(body.data.payload?.ack).toMatch(/Daemon invoked: rebuild the index/)
    expect(body.data.payload?.command?.kind).toBe('daemon')

    // Verify enqueueTask was called with the right contract (Plan A: no HTTP).
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith({
      agentDaemonId: agentId,
      runId: body.data.payload?.runId,
      prompt: 'rebuild the index',
      execOptions: { cwd: expectedDirPath },
    })

    // Chat should be marked running.
    const { records } = await runQuery<{ status: string }>(
      `SELECT status FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    expect(records[0]?.status).toBe('running')
  })

  it('returns error payload when enqueueTask throws', async () => {
    const agentId = randomUUID()
    const { chatId } = await seedDirAndChat({ agentId })

    const mockEnqueue = vi.mocked(enqueueTask)
    mockEnqueue.mockRejectedValue(new Error('enqueue failed'))

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon do thing' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; payload?: { error?: string; ack?: string } }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toMatch(/enqueue failed/)
    expect(body.data.payload?.ack).toMatch(/Daemon invoke error/)
  })
})
