/**
 * Flow Templates（docs/flow-templates.md）—— pipeline 两分支 + 路由四端点。
 *
 * 确定性约定：人格绑定分支用 fixture 独有名（Tpl Persona One，真库不可能
 * 重名）；降级分支 personaName=null 或库未挂（不触 DB）。内置模板实例化用
 * 纯 LLM 的 content-pipeline（零依赖，任何环境一致）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'

vi.mock('../managed-agent-library-dirs.js', async () => {
  const actual = await vi.importActual<typeof import('../managed-agent-library-dirs.js')>(
    '../managed-agent-library-dirs.js',
  )
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dagents-ftpl-managed-'))
  return { ...actual, managedAgentLibraryDirs: new actual.ManagedAgentLibraryDirs(join(dir, 'dirs.json')) }
})

import { app } from '../app.js'
import {
  extractTemplateFromFlow,
  instantiateFlowTemplate,
} from '../flow-template-pipeline.js'

const PERSONA = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture persona for flow-template tests.\n---\n\n` +
  `## Identity & Memory\n\nYou are ${name}.\n\n## Critical Rules\n\n1. Be exact.\n`

const tmpRoots: string[] = []
const PG_URL = process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('flow-template-pipeline — extract（纯函数）', () => {
  const flow = {
    nodes: [
      { id: 'node_1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: 'Start' } },
      {
        id: 'node_2', type: 'customNode', position: { x: 250, y: 0 },
        data: {
          name: 'platformAgentAgentflow', label: '规划',
          output: 'runtime residue',
          inputs: { agentId: 'agent-uuid-1', systemPrompt: '做规划' },
        },
      },
      { id: 'node_3', type: 'customNode', position: { x: 500, y: 0 }, data: { name: 'llmAgentflow', label: 'LLM', model: '', systemPrompt: 'x', executionData: { ran: true } } },
    ],
    edges: [{ id: 'e1', source: 'node_1', target: 'node_2' }],
  }

  it('rewrites platformAgent to persona refs and strips runtime keys', () => {
    const extracted = extractTemplateFromFlow(flow, new Map([['agent-uuid-1', 'Software Architect']]))!
    expect(extracted).not.toBeNull()
    expect(extracted.agentRefs).toEqual([{ nodeId: 'node_2', personaName: 'Software Architect', task: '做规划' }])
    const agentNode = extracted.flowData.nodes.find((n) => n.id === 'node_2')!
    expect((agentNode.data as { inputs: { agentId: string } }).inputs.agentId).toBe('')
    // 运行态键被剥（platformAgent 的 output 与 llm 的 executionData）。
    expect((agentNode.data as Record<string, unknown>).output).toBeUndefined()
    const llmNode = extracted.flowData.nodes.find((n) => n.id === 'node_3')!
    expect((llmNode.data as Record<string, unknown>).executionData).toBeUndefined()
    expect((llmNode.data as Record<string, unknown>).systemPrompt).toBe('x')
  })

  it('agent without provenance → personaName null (pure degrade reference)', () => {
    const extracted = extractTemplateFromFlow(flow, new Map())!
    expect(extracted.agentRefs[0].personaName).toBeNull()
  })

  it('rejects flows without a start node or without nodes', () => {
    expect(extractTemplateFromFlow({ nodes: [flow.nodes[1]], edges: [] }, new Map())).toBeNull()
    expect(extractTemplateFromFlow({ nodes: [], edges: [] }, new Map())).toBeNull()
  })
})

describe('flow-template-pipeline — instantiate 降级分支（无 DB）', () => {
  it('degrades unresolved persona refs to llmAgentflow with expert prefix', async () => {
    const template = {
      name: '降级测试',
      flowData: {
        nodes: [
          { id: 'n1', data: { name: 'startAgentflow', label: 'Start' } },
          {
            id: 'n2', data: {
              name: 'platformAgentAgentflow', label: '规划',
              inputs: { agentId: '', systemPrompt: '做规划' },
            },
          },
          {
            id: 'n3', data: {
              name: 'platformAgentAgentflow', label: '匿名步',
              inputs: { agentId: '', systemPrompt: '匿名任务' },
            },
          },
        ],
        edges: [],
      },
      agentRefs: [
        { nodeId: 'n2', personaName: 'Nobody Has This Persona', task: '做规划' },
        { nodeId: 'n3', personaName: null, task: '匿名任务' },
      ],
    }
    // 库未挂（无 fixture root）：两个引用全部降级，不触发任何 DB 写。
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
    const result = await instantiateFlowTemplate(template)
    expect(result.members.every((m) => m.degraded)).toBe(true)
    expect(result.members[0].persona).toBe('Nobody Has This Persona')

    const named = result.flowData.nodes.find((n) => n.id === 'n2')!
    const namedData = named.data as Record<string, unknown>
    expect(namedData.name).toBe('llmAgentflow')
    expect((namedData.label as string)).toBe('规划')
    expect(String(namedData.systemPrompt)).toContain('以 Nobody Has This Persona 的专家身份')
    expect(String(namedData.systemPrompt)).toContain('做规划')

    const anon = result.flowData.nodes.find((n) => n.id === 'n3')!.data as Record<string, unknown>
    expect(String(anon.systemPrompt)).toBe('匿名任务')
    expect(String(anon.systemPrompt)).not.toContain('专家身份')
  })
})

describe('flow-template-pipeline — 降级指令单一事实源（2026-08-20 开发修复钉住）', () => {
  it('degrade prefers the node systemPrompt over a drifted ref.task', async () => {
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
    const template = {
      name: '漂移测试',
      flowData: {
        nodes: [
          { id: 's', data: { name: 'startAgentflow', label: 'Start' } },
          { id: 'a', data: { name: 'platformAgentAgentflow', label: '步', inputs: { agentId: '', systemPrompt: '节点权威指令' } } },
        ],
        edges: [],
      },
      agentRefs: [{ nodeId: 'a', personaName: 'Ghost Drift', task: '过期的 ref 指令' }],
    }
    const result = await instantiateFlowTemplate(template)
    const degraded = result.flowData.nodes.find((n) => n.id === 'a')!.data as { systemPrompt: string }
    expect(degraded.systemPrompt).toContain('节点权威指令')
    expect(degraded.systemPrompt).not.toContain('过期的 ref 指令')
  })
})

describe('flow-templates routes（dev Postgres）', () => {
  const FIXTURE_PERSONA = 'Tpl Persona One'
  let fixtureRoot: string
  const seededFlows: string[] = []
  const seededTemplates: string[] = []
  const seededAgents: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const dir = mkdtempSync(join(tmpdir(), 'dagents-ftpl-'))
    tmpRoots.push(dir)
    fixtureRoot = dir
    mkdirSync(join(dir, 'alibtest-tpl'), { recursive: true })
    writeFileSync(join(dir, 'alibtest-tpl', 'tpl-persona-one.md'), PERSONA(FIXTURE_PERSONA))
  })

  afterAll(async () => {
    if (seededFlows.length) await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [seededFlows])
    if (seededTemplates.length) await runQuery(`DELETE FROM flow_templates WHERE id = ANY($1::uuid[])`, [seededTemplates])
    if (seededAgents.length) await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seededAgents])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  async function seedFlow(flowData: unknown, name: string): Promise<string> {
    const id = randomUUID()
    await runQuery(`INSERT INTO flows (id, name, description, flow_data, status) VALUES ($1, $2, '', $3::jsonb, 'draft')`, [
      id, name, JSON.stringify(flowData),
    ])
    seededFlows.push(id)
    return id
  }

  it('GET / lists the 3 builtin templates with member availability', async () => {
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = fixtureRoot
    const res = await app.request('/api/v1/flow-templates')
    expect(res.status).toBe(200)
    const json = await res.json() as {
      data: { templates: { id: string; source: string; nodeCount: number; agentRefs: { personaName: string | null; available: boolean }[] }[] }
    }
    const ids = json.data.templates.filter((t) => t.source === 'builtin').map((t) => t.id)
    expect(ids).toEqual(['builtin/dev-three-step', 'builtin/research-fanout', 'builtin/content-pipeline'])
    const dev = json.data.templates.find((t) => t.id === 'builtin/dev-three-step')!
    expect(dev.nodeCount).toBe(5)
    expect(dev.agentRefs.map((r) => r.personaName)).toEqual(['Software Architect', 'Senior Developer', 'Code Reviewer'])
    // 真库或 fixture 都不含这三个名字？—— 真库含！断言只锁「有解析结果字段」，
    // 不锁具体值（fixture 机器 vs CI 无库环境 available 不同）。
    expect(dev.agentRefs.every((r) => typeof r.available === 'boolean')).toBe(true)
  })

  it('from-flow extracts persona refs from library-backed agents; instantiate re-binds', async () => {
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = fixtureRoot
    // 1. 启用 fixture 人格（唯一名 → 命中 fixture 而非真库）。
    const enable = await app.request('/api/v1/agent-library/alibtest-tpl/tpl-persona-one/instantiate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(enable.status).toBe(201)
    const agentId = ((await enable.json()) as { data: { id: string } }).data.id
    seededAgents.push(agentId)

    // 2. 造一条绑定该 agent 的 flow → from-flow。
    const flowId = await seedFlow({
      nodes: [
        { id: 'node_1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: 'Start' } },
        { id: 'node_2', type: 'customNode', position: { x: 250, y: 0 }, data: { name: 'platformAgentAgentflow', label: '一步', inputs: { agentId, systemPrompt: 'fixture 任务' } } },
      ],
      edges: [{ id: 'e1', source: 'node_1', target: 'node_2' }],
    }, 'ftpl 源流程')
    const extract = await app.request(`/api/v1/flow-templates/from-flow/${flowId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ftpl 用户模板', icon: '🧪' }),
    })
    expect(extract.status).toBe(201)
    const tplId = ((await extract.json()) as { data: { id: string } }).data.id
    seededTemplates.push(tplId)

    const { records: tplRows } = await runQuery<{ agent_refs: { personaName: string | null }[]; flow_data: { nodes: { data: { inputs?: { agentId?: string } } }[] } }>(
      `SELECT agent_refs, flow_data FROM flow_templates WHERE id = $1::uuid`, [tplId],
    )
    expect(tplRows[0].agent_refs).toEqual([{ nodeId: 'node_2', personaName: FIXTURE_PERSONA, task: 'fixture 任务' }])
    expect(tplRows[0].flow_data.nodes[1].data.inputs!.agentId).toBe('')

    // 3. 实例化：persona 命中 fixture → 复用已启用 agent（enabled: true，未降级）。
    const inst = await app.request(`/api/v1/flow-templates/${tplId}/instantiate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(inst.status).toBe(201)
    const instJson = (await inst.json()) as { data: { flowId: string; members: { persona: string | null; agentId: string | null; degraded: boolean; enabled: boolean }[] } }
    seededFlows.push(instJson.data.flowId)
    expect(instJson.data.members).toEqual([
      { persona: FIXTURE_PERSONA, agentId, degraded: false, enabled: true },
    ])
    const { records: flowRows } = await runQuery<{ flow_data: { nodes: { data: { name: string; inputs?: { agentId?: string } } }[] } }>(
      `SELECT flow_data FROM flows WHERE id = $1::uuid`, [instJson.data.flowId],
    )
    expect(flowRows[0].flow_data.nodes[1].data.name).toBe('platformAgentAgentflow')
    expect(flowRows[0].flow_data.nodes[1].data.inputs!.agentId).toBe(agentId)
  })

  it('from-flow with a non-library agent degrades on instantiate (llmAgentflow rewrite)', async () => {
    // 造一个无 library_meta 的 agent（模拟手工创建），绑定进 flow。
    const plainAgentId = randomUUID()
    await runQuery(
      `INSERT INTO agents (id, workspace_id, name, kind, instructions, owner_id)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', '手工 Agent', 'claude', 'x', 'local')`,
      [plainAgentId],
    )
    seededAgents.push(plainAgentId)

    const flowId = await seedFlow({
      nodes: [
        { id: 'node_1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: 'Start' } },
        { id: 'node_2', type: 'customNode', position: { x: 250, y: 0 }, data: { name: 'platformAgentAgentflow', label: '匿名步', inputs: { agentId: plainAgentId, systemPrompt: '手工任务' } } },
      ],
      edges: [{ id: 'e1', source: 'node_1', target: 'node_2' }],
    }, 'ftpl 无源流程')

    const extract = await app.request(`/api/v1/flow-templates/from-flow/${flowId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(extract.status).toBe(201)
    const tplId = ((await extract.json()) as { data: { id: string } }).data.id
    seededTemplates.push(tplId)

    const inst = await app.request(`/api/v1/flow-templates/${tplId}/instantiate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(inst.status).toBe(201)
    const instJson = (await inst.json()) as { data: { flowId: string; members: { degraded: boolean; persona: string | null }[] } }
    seededFlows.push(instJson.data.flowId)
    expect(instJson.data.members).toEqual([{ persona: null, agentId: null, degraded: true, enabled: false }])
    const { records } = await runQuery<{ flow_data: { nodes: { data: { name: string; systemPrompt?: string } }[] } }>(
      `SELECT flow_data FROM flows WHERE id = $1::uuid`, [instJson.data.flowId],
    )
    const degradedNode = records[0].flow_data.nodes[1].data
    expect(degradedNode.name).toBe('llmAgentflow')
    expect(degradedNode.systemPrompt).toBe('手工任务')
  })

  it('instantiates a pure-LLM builtin (zero deps) and enforces builtin delete 405', async () => {
    const inst = await app.request('/api/v1/flow-templates/builtin/content-pipeline/instantiate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(inst.status).toBe(201)
    const instJson = (await inst.json()) as { data: { flowId: string; members: unknown[] } }
    seededFlows.push(instJson.data.flowId)
    expect(instJson.data.members).toEqual([])

    const noStart = await app.request('/api/v1/flow-templates/from-flow/00000000-0000-4000-8000-000000000000', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(noStart.status).toBe(404)

    const del = await app.request('/api/v1/flow-templates/builtin/content-pipeline', { method: 'DELETE' })
    expect(del.status).toBe(405)

    // 用户模板可删。
    const flowId = await seedFlow({
      nodes: [{ id: 'node_1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: 'Start' } }],
      edges: [],
    }, 'ftpl 待删模板源')
    const extract = await app.request(`/api/v1/flow-templates/from-flow/${flowId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const tplId = ((await extract.json()) as { data: { id: string } }).data.id
    const delUser = await app.request(`/api/v1/flow-templates/${tplId}`, { method: 'DELETE' })
    expect(delUser.status).toBe(200)
    const again = await app.request(`/api/v1/flow-templates/${tplId}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })
})

// ── 测试工程师补口（2026-08-20 第二轮）──────────────────────────────────

describe('builtin 模板完整性元测试（防社区 PR 数据漂移）', () => {
  it('every builtin: edges 引用存在的节点、agentRefs 的 nodeId/task 与节点一致、有 start', async () => {
    const { BUILTIN_FLOW_TEMPLATES } = await import('../flow-templates/builtin/index.js')
    expect(BUILTIN_FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(3)
    for (const tpl of BUILTIN_FLOW_TEMPLATES) {
      const nodeIds = new Set(tpl.flowData.nodes.map((n) => String(n.id)))
      expect(nodeIds.size, tpl.id).toBe(tpl.flowData.nodes.length)
      expect(
        tpl.flowData.nodes.some((n) => (n.data as Record<string, unknown>)?.name === 'startAgentflow'),
        `${tpl.id} 缺 startAgentflow`,
      ).toBe(true)
      for (const e of tpl.flowData.edges) {
        expect(nodeIds.has(String(e.source)), `${tpl.id} 边 source 悬空: ${e.source}`).toBe(true)
        expect(nodeIds.has(String(e.target)), `${tpl.id} 边 target 悬空: ${e.target}`).toBe(true)
      }
      // task 双拷贝一致性：降级节点用 ref.task、绑定节点用节点 inputs.systemPrompt ——
      // 两者漂移会让同一模板在不同环境下行为分叉，元测试钉死。
      for (const ref of tpl.agentRefs) {
        const node = tpl.flowData.nodes.find((n) => String(n.id) === ref.nodeId)
        expect(node, `${tpl.id} agentRef 指向不存在的节点 ${ref.nodeId}`).toBeTruthy()
        expect((node!.data as { name: string }).name).toBe('platformAgentAgentflow')
        const nodeTask = (node!.data as { inputs?: { systemPrompt?: string } }).inputs?.systemPrompt
        expect(nodeTask, `${tpl.id} 节点 ${ref.nodeId} 缺 inputs.systemPrompt`).toBeTruthy()
        expect(ref.task, `${tpl.id} agentRef.task 与节点 systemPrompt 漂移`).toBe(nodeTask)
      }
      // 模板内不应残留任何本机状态（agentId 必须为空串）。
      for (const n of tpl.flowData.nodes) {
        const data = n.data as { name?: string; inputs?: { agentId?: string } }
        if (data?.name === 'platformAgentAgentflow') {
          expect(data.inputs?.agentId ?? '', `${tpl.id} 节点 ${n.id} 残留 agentId`).toBe('')
        }
      }
    }
  })
})

describe('flow-template-pipeline — 混合解析（部分命中部分降级）', () => {
  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  it('resolves the hit persona and degrades the miss in one pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dagents-ftpl-mix-'))
    tmpRoots.push(dir)
    mkdirSync(join(dir, 'mixdiv'), { recursive: true })
    writeFileSync(join(dir, 'mixdiv', 'hit-one.md'), PERSONA('Mix Hit One'))

    // instantiate 走全局单例注册表：用环境变量指向 fixture 根（单例会扫描）。
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = dir
    try {
      // 先启用 Hit One，让实例化走「复用」分支。
      const enable = await app.request('/api/v1/agent-library/mixdiv/mix-hit-one/instantiate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(enable.status).toBe(201)
      const hitAgentId = ((await enable.json()) as { data: { id: string } }).data.id
      try {
        const template = {
          name: '混合',
          flowData: {
            nodes: [
              { id: 's', data: { name: 'startAgentflow', label: 'Start' } },
              { id: 'a', data: { name: 'platformAgentAgentflow', label: '命中', inputs: { agentId: '', systemPrompt: '任务A' } } },
              { id: 'b', data: { name: 'platformAgentAgentflow', label: '未命中', inputs: { agentId: '', systemPrompt: '任务B' } } },
            ],
            edges: [],
          },
          agentRefs: [
            { nodeId: 'a', personaName: 'Mix Hit One', task: '任务A' },
            { nodeId: 'b', personaName: 'Mix Ghost Nobody', task: '任务B' },
          ],
        }
        const result = await instantiateFlowTemplate(template)
        expect(result.members).toHaveLength(2)
        expect(result.members[0]).toMatchObject({ persona: 'Mix Hit One', agentId: hitAgentId, degraded: false, enabled: true })
        expect(result.members[1]).toMatchObject({ persona: 'Mix Ghost Nobody', agentId: null, degraded: true })
        const bound = result.flowData.nodes.find((n) => n.id === 'a')!.data as { name: string; inputs: { agentId: string } }
        expect(bound.name).toBe('platformAgentAgentflow')
        expect(bound.inputs.agentId).toBe(hitAgentId)
        const degraded = result.flowData.nodes.find((n) => n.id === 'b')!.data as { name: string; systemPrompt: string }
        expect(degraded.name).toBe('llmAgentflow')
        expect(degraded.systemPrompt).toContain('Mix Ghost Nobody')
      } finally {
        await runQuery(`DELETE FROM agents WHERE id = $1::uuid`, [hitAgentId])
      }
    } finally {
      delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
    }
  })
})

describe('flow-templates routes — 4xx 边界（测试工程师补口）', () => {
  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('rejects non-uuid flowId with 400 instead of a 502 uuid-cast error', async () => {
    const res = await app.request('/api/v1/flow-templates/from-flow/not-a-uuid', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('404 for unknown builtin slug and non-uuid template id on instantiate', async () => {
    const unknownBuiltin = await app.request('/api/v1/flow-templates/builtin/nope/instantiate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(unknownBuiltin.status).toBe(404)

    const garbage = await app.request('/api/v1/flow-templates/garbage-id/instantiate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(garbage.status).toBe(404)
  })

  it('rejects extraction when the flow has no start node (422)', async () => {
    const id = randomUUID()
    await runQuery(
      `INSERT INTO flows (id, name, description, flow_data, status) VALUES ($1, 'no-start', '', $2::jsonb, 'draft')`,
      [id, JSON.stringify({ nodes: [{ id: 'n1', data: { name: 'llmAgentflow', label: 'L', systemPrompt: 'x' } }], edges: [] })],
    )
    try {
      const res = await app.request(`/api/v1/flow-templates/from-flow/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(422)
    } finally {
      await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [id])
    }
  })
})
