/**
 * Agent Library（docs/agent-library.md）—— registry 发现规则 + 路由 +
 * instantiate/drift/reimport 写路径（直连 dev Postgres，seed 自清理）。
 *
 * 隔离约定：全局单例注册表还会看到默认根 ~/.agents/agent-library（真机上
 * 软链到 agency-agents，300+ 条目），所以路由断言一律用 fixture 独有的
 * division 名（alibtest*），不做全量长度断言。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDataSource, runQuery } from '@dagents/db'

// 路由测试不得触碰用户真实的 ~/.agents/agent-library-dirs.json —— 整个文件
// 生命周期内把单例换成 tmp-backed 实例（与 skills.test.ts 同一手法）。
vi.mock('../managed-agent-library-dirs.js', async () => {
  const actual = await vi.importActual<typeof import('../managed-agent-library-dirs.js')>(
    '../managed-agent-library-dirs.js',
  )
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dagents-alib-managed-'))
  const file = join(dir, 'agent-library-dirs.json')
  ;(globalThis as { __testAlibManagedFile?: string }).__testAlibManagedFile = file
  return { ...actual, managedAgentLibraryDirs: new actual.ManagedAgentLibraryDirs(file) }
})

import { app } from '../app.js'
import { AgentLibraryRegistry, type AgentLibraryRoot } from '../agent-library-registry.js'
import { sha256Hex } from '../persona-compiler.js'
import { managedAgentLibraryDirs } from '../managed-agent-library-dirs.js'

const PERSONA = (name: string, description: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n` +
  `## Identity & Memory\n\nYou are ${name}.\n\n## Critical Rules\n\n1. Be exact.\n\n` +
  `## Technical Deliverables\n\n\`\`\`ts\n// template code\n\`\`\`\n`

const tmpRoots: string[] = []

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  const managedFile = (globalThis as { __testAlibManagedFile?: string }).__testAlibManagedFile
  if (managedFile) rmSync(join(managedFile, '..'), { recursive: true, force: true })
})

function makeRoot(): { dir: string; registry: AgentLibraryRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'dagents-agent-library-'))
  tmpRoots.push(dir)
  const registry = new AgentLibraryRegistry(() => [{ source: 'custom', dir, rank: 300 }])
  return { dir, registry }
}

function writePersona(root: string, division: string, file: string, name: string, description = 'A specialist.'): void {
  mkdirSync(join(root, division), { recursive: true })
  writeFileSync(join(root, division, file), PERSONA(name, description))
}

/** fixture 独有 division —— 与真机默认根（agency-agents 全库）天然不撞名。 */
const DIV_A = 'alibtest-alpha'
const DIV_B = 'alibtest-beta'

describe('agent library registry — discovery', () => {
  it('scans division dirs (incl. one nested level) with divisions.json metadata', () => {
    const { dir, registry } = makeRoot()
    writeFileSync(join(dir, 'divisions.json'), JSON.stringify({
      divisions: { [DIV_A]: { label: 'Alpha', icon: 'Box', color: '#D946EF' }, [DIV_B]: { label: 'Beta' } },
    }))
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    writePersona(dir, DIV_B, 'architect.md', 'Backend Architect')
    mkdirSync(join(dir, DIV_B, 'nested'))
    writeFileSync(join(dir, DIV_B, 'nested', 'sre.md'), PERSONA('SRE', 'Reliability.'))

    const entries = registry.list()
    expect(entries.map((e) => e.id).sort()).toEqual([
      `${DIV_A}/product-manager`, `${DIV_B}/backend-architect`, `${DIV_B}/sre`,
    ])
    expect(registry.divisions().find((d) => d.key === DIV_A)).toMatchObject({
      label: 'Alpha', color: '#D946EF',
    })
  })

  it('divisions.json gates the division set (NON_DIVISION dirs never scanned)', () => {
    const { dir, registry } = makeRoot()
    writeFileSync(join(dir, 'divisions.json'), JSON.stringify({ divisions: { [DIV_A]: { label: 'Alpha' } } }))
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    mkdirSync(join(dir, 'strategy'))
    writeFileSync(join(dir, 'strategy', 'runbook.md'), PERSONA('Strategy Runbook', 'Not an agent.'))
    mkdirSync(join(dir, 'integrations'))
    writeFileSync(join(dir, 'integrations', 'converted.md'), PERSONA('Converted', 'Tool output.'))

    expect(registry.list().map((e) => e.id)).toEqual([`${DIV_A}/product-manager`])
  })

  it('falls back to all first-level dirs when divisions.json is absent, excluding junk', () => {
    const { dir, registry } = makeRoot()
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    mkdirSync(join(dir, 'examples'))
    writeFileSync(join(dir, 'examples', 'example.md'), PERSONA('Example', 'Not a division.'))
    const divisions = registry.divisions().map((d) => d.key)
    expect(divisions).toContain(DIV_A)
    expect(divisions).not.toContain('examples')
  })

  it('warn-and-skips files without valid frontmatter; dedups by root rank', () => {
    const lowRank = makeRoot()
    const highRank = makeRoot()
    writePersona(lowRank.dir, DIV_A, 'pm.md', 'Product Manager', 'From low rank.')
    writePersona(highRank.dir, DIV_A, 'pm-dupe.md', 'Product Manager', 'From high rank.')
    writeFileSync(join(highRank.dir, DIV_A, 'no-frontmatter.md'), '# Just a doc\n')

    const roots: AgentLibraryRoot[] = [
      { source: 'custom', dir: lowRank.dir, rank: 300 },
      { source: 'custom', dir: highRank.dir, rank: 400 },
    ]
    const registry = new AgentLibraryRegistry(() => roots)
    const entries = registry.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].description).toBe('From low rank.')
  })

  it('get() returns the full entry with body + raw sha; emoji/tools ride in metadata', () => {
    const { dir, registry } = makeRoot()
    mkdirSync(join(dir, DIV_A))
    writeFileSync(join(dir, DIV_A, 'pm.md'), PERSONA('Product Manager', 'A specialist.', 'emoji: 🧭\ntools: WebFetch, WebSearch\n'))
    const entry = registry.get(`${DIV_A}/product-manager`)
    expect(entry?.body).toContain('## Identity & Memory')
    expect(entry?.filePath).toContain('pm.md')
    expect(entry?.rawSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(entry?.emoji).toBe('🧭')
    expect(entry?.tools).toEqual(['WebFetch', 'WebSearch'])
  })
})

describe('agent library routes — read surface (no DB)', () => {
  it('GET / lists entries and filters by ?division=', async () => {
    const { dir } = makeRoot()
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    writePersona(dir, DIV_B, 'coach.md', 'Sales Coach')
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = dir
    try {
      const all = await app.request(`/api/v1/agent-library?division=${DIV_A}`)
      const allJson = await all.json() as { data: { entries: { id: string }[] } }
      expect(allJson.data.entries.map((e) => e.id)).toEqual([`${DIV_A}/product-manager`])
    } finally {
      delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
    }
  })

  it('GET /:division/:slug returns previews for all three profiles; 404 on unknown', async () => {
    const { dir } = makeRoot()
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = dir
    try {
      const res = await app.request(`/api/v1/agent-library/${DIV_A}/product-manager`)
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { previews: { profile: string }[]; instantiated: unknown } }
      expect(json.data.previews.map((p) => p.profile)).toEqual(['full', 'slim', 'minimal'])
      expect(json.data.instantiated).toBeNull()

      const missing = await app.request(`/api/v1/agent-library/${DIV_A}/nope`)
      expect(missing.status).toBe(404)
    } finally {
      delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
    }
  })

  it('roots endpoints persist via the managed list and force a rescan', async () => {
    const { dir } = makeRoot()
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS

    const add = await app.request('/api/v1/agent-library/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    expect(add.status).toBe(200)
    expect(managedAgentLibraryDirs.list()).toContain(dir)

    const list = await app.request(`/api/v1/agent-library?division=${DIV_A}`)
    const json = await list.json() as { data: { entries: { id: string }[] } }
    expect(json.data.entries.map((e) => e.id)).toEqual([`${DIV_A}/product-manager`])

    const remove = await app.request(`/api/v1/agent-library/roots?dir=${encodeURIComponent(dir)}`, { method: 'DELETE' })
    expect(remove.status).toBe(200)
    expect(managedAgentLibraryDirs.list()).not.toContain(dir)
  })
})

const PG_URL =
  process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

describe('agent library routes — instantiate / drift / reimport (dev Postgres)', () => {
  const LIB_ID = `${DIV_A}/product-manager-e2e-seed`
  let rootDir: string
  const seededAgentIds: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()

    const { dir } = makeRoot()
    rootDir = dir
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager E2E Seed')
  })

  afterAll(async () => {
    if (seededAgentIds.length > 0) {
      await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seededAgentIds])
    }
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  async function request(path: string, init?: RequestInit): Promise<Response> {
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = rootDir
    return app.request(path, init)
  }

  async function driftState(): Promise<string> {
    const res = await request('/api/v1/agent-library/drift')
    const json = await res.json() as { data: { items: { libraryId: string; state: string }[] } }
    return json.data.items.find((i) => i.libraryId === LIB_ID)?.state ?? ''
  }

  it('instantiate (slim default) writes an agents row with library_meta provenance', async () => {
    const res = await request(`/api/v1/agent-library/${DIV_A}/product-manager-e2e-seed/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const json = await res.json() as { data: { id: string; profile: string; kind: string } }
    expect(json.data.profile).toBe('slim')
    expect(json.data.kind).toBe('claude')
    seededAgentIds.push(json.data.id)

    const { records } = await runQuery<{
      name: string; kind: string; instructions: string; summary: string; roles: string[]; library_meta: {
        id: string; profile: string; source_sha256: string; instructions_sha256_at_import: string
      }
    }>(`SELECT name, kind, instructions, summary, roles, library_meta FROM agents WHERE id = $1::uuid`, [json.data.id])
    const row = records[0]
    expect(row.name).toBe('Product Manager E2E Seed')
    expect(row.kind).toBe('claude')
    expect(row.roles).toEqual([DIV_A])
    expect(row.summary).toBe('A specialist.')
    // slim 编译：保留 Identity，剥 Deliverables；带语言包络。
    expect(row.instructions).toContain('You are Product Manager E2E Seed.')
    expect(row.instructions).not.toContain('Technical Deliverables')
    expect(row.instructions).toContain('respond in Chinese')
    expect(row.library_meta.id).toBe(LIB_ID)
    expect(row.library_meta.source_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(row.library_meta.instructions_sha256_at_import).toBe(sha256Hex(row.instructions))
  })

  it('instantiate rejects non-CLI kind and 409s on re-enable; drift reads up-to-date', async () => {
    const badKind = await request(`/api/v1/agent-library/${DIV_A}/product-manager-e2e-seed/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'remote' }),
    })
    expect(badKind.status).toBe(400)

    const dupe = await request(`/api/v1/agent-library/${DIV_A}/product-manager-e2e-seed/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(dupe.status).toBe(409)

    expect(await driftState()).toBe('up-to-date')
  })

  it('reimport requires confirm after a local edit, then overwrites instructions in place', async () => {
    await runQuery(`UPDATE agents SET instructions = 'hand-edited' WHERE library_meta->>'id' = $1`, [LIB_ID])
    expect(await driftState()).toBe('locally-modified')

    const blocked = await request(`/api/v1/agent-library/${DIV_A}/product-manager-e2e-seed/reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(blocked.status).toBe(409)

    const confirmed = await request(`/api/v1/agent-library/${DIV_A}/product-manager-e2e-seed/reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'minimal' }),
    })
    expect(confirmed.status).toBe(200)
    const { records } = await runQuery<{ instructions: string; library_meta: { profile: string } }>(
      `SELECT instructions, library_meta FROM agents WHERE library_meta->>'id' = $1`,
      [LIB_ID],
    )
    expect(records[0].library_meta.profile).toBe('minimal')
    expect(records[0].instructions).toContain('You are Product Manager E2E Seed.')
    expect(records[0].instructions).toContain('respond in Chinese')
    expect(await driftState()).toBe('up-to-date')
  })
})

describe('agent library team templates (dev Postgres)', () => {
  // marketing-launch 是最小模板（5 成员）。fixture 用与真库相同的
  // division/slug（marketing/*、support/analytics-reporter）——env 根 rank 300
  // 覆盖默认根 rank 500，在有真库挂载的开发机上确定性解析到 fixture 内容。
  const TEAM_ROOT_PERSONAS: { division: string; file: string; name: string }[] = [
    { division: 'marketing', file: 'content-creator.md', name: 'Content Creator' },
    { division: 'marketing', file: 'twitter-engager.md', name: 'Twitter Engager' },
    { division: 'marketing', file: 'instagram-curator.md', name: 'Instagram Curator' },
    { division: 'marketing', file: 'reddit-community-builder.md', name: 'Reddit Community Builder' },
    { division: 'support', file: 'analytics-reporter.md', name: 'Analytics Reporter' },
  ]
  let teamRoot: string
  const seededAgentIds: string[] = []
  const seededFlowIds: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()

    const { dir } = makeRoot()
    teamRoot = dir
    for (const p of TEAM_ROOT_PERSONAS) writePersona(dir, p.division, p.file, p.name)
  })

  afterAll(async () => {
    if (seededFlowIds.length > 0) {
      await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [seededFlowIds])
    }
    if (seededAgentIds.length > 0) {
      await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seededAgentIds])
    }
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  async function teamRequest(path: string, init?: RequestInit): Promise<Response> {
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = teamRoot
    return app.request(path, init)
  }

  it('GET /team-templates lists the catalogue with resolved member availability', async () => {
    const res = await teamRequest('/api/v1/agent-library/team-templates')
    expect(res.status).toBe(200)
    const json = await res.json() as {
      data: {
        templates: {
          id: string
          shape: string
          parallelCount?: number
          inputHint?: string
          inputExample?: string
          members: { persona: string; available: boolean; libraryId: string | null }[]
        }[]
      }
    }
    expect(json.data.templates).toHaveLength(9)
    expect(json.data.templates.map((t) => t.id)).toEqual(expect.arrayContaining([
      'startup-mvp', 'enterprise-feature', 'marketing-launch', 'paid-media-takeover',
      'product-discovery', 'campus-twin', 'landing-page-sprint', 'full-agency-discovery', 'book-chapter',
    ]))
    // 运行输入引导全量透出（确认步预告 + 运行面板 placeholder 的数据源）。
    for (const t of json.data.templates) {
      expect(typeof t.inputHint).toBe('string')
      expect(t.inputHint!.length).toBeGreaterThan(8)
      expect(typeof t.inputExample).toBe('string')
    }
    // parallel-head 模板透出 parallelCount，供确认步结构预览分组渲染。
    const landing = json.data.templates.find((t) => t.id === 'landing-page-sprint')
    expect(landing?.shape).toBe('parallel-head')
    expect(landing?.parallelCount).toBe(2)
    expect(json.data.templates.find((t) => t.id === 'full-agency-discovery')?.shape).toBe('fan-out')
    const launch = json.data.templates.find((t) => t.id === 'marketing-launch')
    expect(launch?.members.map((m) => m.persona)).toEqual([
      'Content Creator', 'Twitter Engager', 'Instagram Curator', 'Reddit Community Builder', 'Analytics Reporter',
    ])
    // fixture 根（rank 300）覆盖真库 → 5 个成员全部解析到 fixture 的库 id。
    for (const m of launch!.members) {
      expect(m.available).toBe(true)
      expect(m.libraryId).toMatch(/^(marketing|support)\//)
    }
  })

  it('POST instantiate enables missing members, reuses existing ones, and writes a draft flow', async () => {
    const res = await teamRequest('/api/v1/agent-library/team-templates/marketing-launch/instantiate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const first = await res.json() as {
      data: { flowId: string; members: { persona: string; agentId: string; enabled: boolean }[] }
    }
    seededFlowIds.push(first.data.flowId)
    expect(first.data.members).toHaveLength(5)
    expect(first.data.members.every((m) => !m.enabled)).toBe(true) // 全部是新启用
    for (const m of first.data.members) seededAgentIds.push(m.agentId)

    // members 落库为 library_meta 溯源的 claude agent。
    const { records } = await runQuery<{ kind: string; library_meta: { id: string; profile: string } }>(
      `SELECT kind, library_meta FROM agents WHERE id = ANY($1::uuid[])`,
      [first.data.members.map((m) => m.agentId)],
    )
    expect(records).toHaveLength(5)
    expect(records.every((r) => r.kind === 'claude')).toBe(true)
    expect(records.every((r) => r.library_meta.profile === 'slim')).toBe(true)

    // flow：start + 5 platformAgent + directReply，agentId 绑定真实成员。
    const { records: flowRows } = await runQuery<{ flow_data: { nodes: { data: { name: string; inputs?: { agentId?: string } } }[] } }>(
      `SELECT flow_data FROM flows WHERE id = $1::uuid`,
      [first.data.flowId],
    )
    const nodes = flowRows[0].flow_data.nodes
    expect(nodes).toHaveLength(7)
    const agentNodes = nodes.filter((n) => n.data.name === 'platformAgentAgentflow')
    expect(agentNodes).toHaveLength(5)
    const memberIds = new Set(first.data.members.map((m) => m.agentId))
    expect(agentNodes.every((n) => memberIds.has(n.data.inputs!.agentId!))).toBe(true)

    // 幂等：再次 instantiate 复用全部成员（enabled: true），新建另一条 flow。
    const again = await teamRequest('/api/v1/agent-library/team-templates/marketing-launch/instantiate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(again.status).toBe(201)
    const second = await again.json() as {
      data: { flowId: string; members: { agentId: string; enabled: boolean }[] }
    }
    seededFlowIds.push(second.data.flowId)
    expect(second.data.flowId).not.toBe(first.data.flowId)
    expect(second.data.members.every((m) => m.enabled)).toBe(true)
    expect(second.data.members.map((m) => m.agentId).sort()).toEqual(
      first.data.members.map((m) => m.agentId).sort(),
    )
  })

  it('422 with the missing names when a persona cannot be resolved (no silent skip)', async () => {
    // 注入一个引用不存在人格的测试模板（真库也没有 → 在任何机器上确定性 422）。
    const fake = {
      id: 'test-missing-persona', name: 'T', description: 't', icon: '🧪', shape: 'linear' as const,
      steps: [{ persona: 'No Such Persona Zzz', label: 'x', task: 'x' }],
    }
    const { TEAM_TEMPLATES } = await import('../routes/agent-library-teams.js')
    TEAM_TEMPLATES.push(fake as never)
    try {
      const res = await teamRequest('/api/v1/agent-library/team-templates/test-missing-persona/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(422)
      const json = await res.json() as { missing: string[] }
      expect(json.missing).toEqual(['No Such Persona Zzz'])
    } finally {
      TEAM_TEMPLATES.pop()
    }
  })
})

describe('agent library registry — 边界加固（2026-08-20）', () => {
  it('skips hidden files and hidden directories during the walk', () => {
    const { dir, registry } = makeRoot()
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    writeFileSync(join(dir, DIV_A, '.hidden.md'), PERSONA('Hidden', 'Should not appear.'))
    mkdirSync(join(dir, DIV_A, '.hiddendir'))
    writeFileSync(join(dir, DIV_A, '.hiddendir', 'x.md'), PERSONA('Hidden Dir', 'No.'))
    expect(registry.list().map((e) => e.id)).toEqual([`${DIV_A}/product-manager`])
  })

  it('falls back to first-level dirs when divisions.json is corrupt JSON', () => {
    const { dir, registry } = makeRoot()
    writeFileSync(join(dir, 'divisions.json'), '{ not json !!!')
    writePersona(dir, DIV_A, 'pm.md', 'Product Manager')
    expect(registry.list().map((e) => e.id)).toEqual([`${DIV_A}/product-manager`])
    expect(registry.divisions().map((d) => d.key)).toContain(DIV_A)
  })
})

describe('agent library routes — roots 错误路径', () => {
  it('rejects duplicate add, unreadable dir, and unknown remove', async () => {
    const { dir } = makeRoot()
    const add1 = await app.request('/api/v1/agent-library/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    expect(add1.status).toBe(200)
    try {
      const dup = await app.request('/api/v1/agent-library/roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
      })
      expect(dup.status).toBe(400)

      const badDir = await app.request('/api/v1/agent-library/roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '/definitely/not/a/dir' }),
      })
      expect(badDir.status).toBe(400)

      const missing = await app.request('/api/v1/agent-library/roots?dir=/also/not/mounted', { method: 'DELETE' })
      expect(missing.status).toBe(400)

      const noDir = await app.request('/api/v1/agent-library/roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(noDir.status).toBe(400)
    } finally {
      await app.request(`/api/v1/agent-library/roots?dir=${encodeURIComponent(dir)}`, { method: 'DELETE' })
    }
  })
})

describe('agent library routes — 生命周期边界（dev Postgres）', () => {
  const EDGE_LIB_ID = `${DIV_B}/edge-persona`
  let edgeRoot: string
  const seeded: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const { dir } = makeRoot()
    edgeRoot = dir
    writePersona(dir, DIV_B, 'edge-persona.md', 'Edge Persona')
  })

  afterAll(async () => {
    if (seeded.length > 0) await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seeded])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  async function req(path: string, init?: RequestInit): Promise<Response> {
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = edgeRoot
    return app.request(path, init)
  }

  async function driftFor(id: string): Promise<string> {
    const res = await req('/api/v1/agent-library/drift')
    const json = await res.json() as { data: { items: { libraryId: string; state: string }[] } }
    return json.data.items.find((i) => i.libraryId === id)?.state ?? ''
  }

  it('instantiate honours kind and name overrides', async () => {
    const res = await req(`/api/v1/agent-library/${EDGE_LIB_ID}/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'codex', name: '自定义名' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { id: string } }
    seeded.push(data.id)
    const { records } = await runQuery<{ kind: string; name: string }>(
      `SELECT kind, name FROM agents WHERE id = $1::uuid`, [data.id],
    )
    expect(records[0]).toMatchObject({ kind: 'codex', name: '自定义名' })
  })

  it('detail reports instantiated state; upstream edit → upstream-updated; reimport w/o confirm succeeds', async () => {
    // detail 显示 instantiated + 当前 drift。
    const detail = await req(`/api/v1/agent-library/${EDGE_LIB_ID}`)
    const detailJson = await detail.json() as { data: { instantiated: { drift: string } | null } }
    expect(detailJson.data.instantiated?.drift).toBe('up-to-date')

    // 上游文件变化（未本地修改）→ upstream-updated，reimport 无需 confirm。
    writePersona(edgeRoot, DIV_B, 'edge-persona.md', 'Edge Persona', 'Changed upstream description.')
    expect(await driftFor(EDGE_LIB_ID)).toBe('upstream-updated')

    const reimport = await req(`/api/v1/agent-library/${EDGE_LIB_ID}/reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(reimport.status).toBe(200)
    expect(await driftFor(EDGE_LIB_ID)).toBe('up-to-date')
  })

  it('local edit + upstream edit → diverged; empty registry → missing-upstream', async () => {
    await runQuery(`UPDATE agents SET instructions = 'hand-edited-again' WHERE library_meta->>'id' = $1`, [EDGE_LIB_ID])
    writePersona(edgeRoot, DIV_B, 'edge-persona.md', 'Edge Persona', 'Changed twice upstream.')
    expect(await driftFor(EDGE_LIB_ID)).toBe('diverged')

    // 指向空目录（默认真库无 alibtest* division）→ missing-upstream。
    const emptyRoot = mkdtempSync(join(tmpdir(), 'dagents-alib-empty-'))
    tmpRoots.push(emptyRoot)
    process.env.DAGENTS_AGENT_LIBRARY_DIRS = emptyRoot
    const drift = await app.request('/api/v1/agent-library/drift')
    const driftJson = await drift.json() as { data: { items: { libraryId: string; state: string }[] } }
    expect(driftJson.data.items.find((i) => i.libraryId === EDGE_LIB_ID)?.state).toBe('missing-upstream')
  })
})

describe('agent library teams — fan-out 与混合复用（dev Postgres）', () => {
  // product-discovery（fan-out）4 成员的真库 id：fixture 同路径 shadow 真库。
  const FANOUT: { division: string; file: string; name: string }[] = [
    { division: 'product', file: 'trend-researcher.md', name: 'Trend Researcher' },
    { division: 'design', file: 'ux-researcher.md', name: 'UX Researcher' },
    { division: 'engineering', file: 'backend-architect.md', name: 'Backend Architect' },
    { division: 'design', file: 'brand-guardian.md', name: 'Brand Guardian' },
  ]
  let fanRoot: string
  const seededAgents: string[] = []
  const seededFlows: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const { dir } = makeRoot()
    fanRoot = dir
    for (const p of FANOUT) writePersona(dir, p.division, p.file, p.name)
    // 合成 fan-out 模板的成员（fixture 独有名，真库/演示零干扰）。
    writePersona(dir, DIV_B, 'fan-a.md', 'Fan Alpha')
    writePersona(dir, DIV_B, 'fan-b.md', 'Fan Beta')
    writePersona(dir, DIV_B, 'fan-c.md', 'Fan Gamma')
    writePersona(dir, DIV_B, 'fan-d.md', 'Fan Delta')
  })

  afterAll(async () => {
    if (seededFlows.length > 0) await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [seededFlows])
    if (seededAgents.length > 0) await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [seededAgents])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    delete process.env.DAGENTS_AGENT_LIBRARY_DIRS
  })

  it('fan-out template: mixed reuse (1 pre-enabled) + fresh enables, synthesis node present', async () => {
    // 注入合成 fan-out 模板（fixture 独有人格名）—— 真库/演示数据零干扰：
    // product-discovery 等真模板的成员可能已被手动启用（如演示 curl），
    // 共享 dev 库上复用状态不可控；合成模板使混合复用场景完全确定。
    const { TEAM_TEMPLATES } = await import('../routes/agent-library-teams.js')
    TEAM_TEMPLATES.push({
      id: 'test-fanout', name: 'F', description: 'f', icon: '🛰️', shape: 'fan-out',
      steps: [
        { persona: 'Fan Alpha', label: 'a', task: 'do a' },
        { persona: 'Fan Beta', label: 'b', task: 'do b' },
        { persona: 'Fan Gamma', label: 'c', task: 'do c' },
      ],
      synthesis: 'synthesise',
    } as never)
    try {
      // 预启用 1 个成员（单人格路径）→ 团队实例化应复用它。
      process.env.DAGENTS_AGENT_LIBRARY_DIRS = fanRoot
      const pre = await app.request('/api/v1/agent-library/alibtest-beta/fan-alpha/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(pre.status).toBe(201)
      const preJson = await pre.json() as { data: { id: string } }
      seededAgents.push(preJson.data.id)

      const res = await app.request('/api/v1/agent-library/team-templates/test-fanout/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(201)
      const { data } = await res.json() as {
        data: { flowId: string; members: { persona: string; agentId: string; enabled: boolean }[] }
      }
      seededFlows.push(data.flowId)
      expect(data.members).toHaveLength(3)
      const alpha = data.members.find((m) => m.persona === 'Fan Alpha')!
      expect(alpha.enabled).toBe(true)
      expect(alpha.agentId).toBe(preJson.data.id)
      expect(data.members.filter((m) => m.enabled)).toHaveLength(1)
      for (const m of data.members) if (m.agentId !== alpha.agentId) seededAgents.push(m.agentId)

      // fan-out 结构：start + 3 agent + llm 汇总 + reply = 6 节点 / 7 边。
      const { records } = await runQuery<{ flow_data: { nodes: { data: { name: string } }[]; edges: unknown[] } }>(
        `SELECT flow_data FROM flows WHERE id = $1::uuid`, [data.flowId],
      )
      const fd = records[0].flow_data
      expect(fd.nodes).toHaveLength(6)
      expect(fd.edges).toHaveLength(7)
      expect(fd.nodes.filter((n) => n.data.name === 'llmAgentflow')).toHaveLength(1)
    } finally {
      TEAM_TEMPLATES.pop()
    }
  })

  it('parallel-head template: heads fan out from start, merge into the linear tail (examples 落地页形态)', async () => {
    const { TEAM_TEMPLATES } = await import('../routes/agent-library-teams.js')
    TEAM_TEMPLATES.push({
      id: 'test-parallel-head', name: 'P', description: 'p', icon: '🦅', shape: 'parallel-head',
      parallelCount: 2,
      inputHint: '测试输入引导', inputExample: '测试输入示例',
      steps: [
        { persona: 'Fan Alpha', label: 'a', task: 'do a' },
        { persona: 'Fan Beta', label: 'b', task: 'do b' },
        { persona: 'Fan Gamma', label: 'c', task: 'do c' },
        { persona: 'Fan Delta', label: 'd', task: 'do d' },
      ],
    } as never)
    try {
      process.env.DAGENTS_AGENT_LIBRARY_DIRS = fanRoot
      const res = await app.request('/api/v1/agent-library/team-templates/test-parallel-head/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(201)
      const { data } = await res.json() as { data: { flowId: string; members: { agentId: string }[] } }
      seededFlows.push(data.flowId)
      for (const m of data.members) seededAgents.push(m.agentId)

      // 结构：start + 2 并行头 + 2 顺序尾 + reply = 6 节点 / 6 边，无 LLM 汇总节点。
      const { records } = await runQuery<{
        flow_data: {
          nodes: { id: string; data: { name: string; inputHint?: string; inputExample?: string } }[]
          edges: { id: string; source: string; target: string }[]
        }
      }>(`SELECT flow_data FROM flows WHERE id = $1::uuid`, [data.flowId])
      const fd = records[0].flow_data
      expect(fd.nodes).toHaveLength(6)
      expect(fd.edges).toHaveLength(6)
      expect(fd.nodes.filter((n) => n.data.name === 'llmAgentflow')).toHaveLength(0)
      expect(fd.nodes.filter((n) => n.data.name === 'platformAgentAgentflow')).toHaveLength(4)
      // start 节点携带运行输入引导（运行面板据此换人话 placeholder）。
      const start = fd.nodes.find((n) => n.id === 'node_1')!
      expect(start.data.inputHint).toBeTruthy()
      expect(start.data.inputExample).toBeTruthy()

      // 拓扑：start 扇出 2 头；两头都汇入首个顺序节点（N 进 1 合并契约）；尾部成链接 reply。
      const targetsOf = (src: string) => fd.edges.filter((e) => e.source === src).map((e) => e.target)
      const heads = targetsOf('node_1')
      expect(heads).toEqual(['node_2', 'node_3'])
      const merge = new Set(fd.edges.filter((e) => heads.includes(e.source)).map((e) => e.target))
      expect([...merge]).toEqual(['node_4'])
      expect(targetsOf('node_4')).toEqual(['node_5'])
      expect(targetsOf('node_5')).toEqual(['node_6'])
      // 孤儿边守卫：每条边的端点都存在。
      const nodeIds = new Set(fd.nodes.map((n) => n.id))
      expect(fd.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target))).toBe(true)
    } finally {
      TEAM_TEMPLATES.pop()
    }
  })

  it('GET team-templates flags unavailable members (injected template, env-independent)', async () => {
    const { TEAM_TEMPLATES } = await import('../routes/agent-library-teams.js')
    TEAM_TEMPLATES.push({
      id: 'test-ghost-team', name: 'G', description: 'g', icon: '👻', shape: 'linear',
      steps: [{ persona: 'Ghost Persona Nobody', label: 'x', task: 'x' }],
    } as never)
    try {
      process.env.DAGENTS_AGENT_LIBRARY_DIRS = fanRoot
      const res = await app.request('/api/v1/agent-library/team-templates')
      const json = await res.json() as {
        data: { templates: { id: string; members: { available: boolean }[] }[] }
      }
      const ghost = json.data.templates.find((t) => t.id === 'test-ghost-team')
      expect(ghost?.members[0].available).toBe(false)
    } finally {
      TEAM_TEMPLATES.pop()
    }
  })
})
