import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { createSeedContext, type SeedContext } from './helpers/seed'

/**
 * Agent Library e2e — spec-16（docs/agent-library.md §5 测试策略）。
 *
 * 覆盖「浏览 → 启用 → agents 行落库 → drift」全链路：
 *   1. API：挂载 fixture 目录后目录/详情可见（divisions.json 元数据 + 三档预览）
 *   2. UI 旅程：/agents → 从人格库启用 → 搜索 → 卡片 → 确认步 → 启用 →
 *      跳转 agent 详情页，DB 断言 slim 编译 + 语言包络 + library_meta 溯源
 *   3. API：drift 清单包含刚启用的人格且状态 up-to-date
 *
 * 与其他 spec 相同的前置：dev stack（Postgres :15432 + gateway :8080）须在线，
 * playwright webServer 只管 console dev + mock LLM。fixture 目录经 POST
 * /api/v1/agent-library/roots 挂载（写真实 ~/.agents/agent-library-dirs.json，
 * afterAll 移除），启用的 agent 行 push 进 ctx.agentIds 由 dispose FK-safe 清理。
 */

const FIXTURE_DIR = join(__dirname, 'fixtures', 'agent-library')
const LIB_ID = 'e2elib/e2e-persona-one'
const PERSONA_NAME = 'E2E Persona One'

test.describe('Agent Library (spec-16)', () => {
  let ctx: SeedContext | null = null
  let instantiatedAgentId = ''

  test.beforeAll(async ({ request }) => {
    ctx = await createSeedContext()
    // 上次失败的运行可能残留挂载 —— 先尽力移除再挂载，保证 from-scratch。
    await request.delete(`/api/agent-library/roots?dir=${encodeURIComponent(FIXTURE_DIR)}`)
    const res = await request.post('/api/agent-library/roots', { data: { dir: FIXTURE_DIR } })
    expect(res.ok(), `mount fixture root: ${await res.text()}`).toBe(true)
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/agent-library/roots?dir=${encodeURIComponent(FIXTURE_DIR)}`)
    await ctx?.dispose()
  })

  test('catalogue lists the fixture division + entry with three profile previews', async ({ request }) => {
    const listRes = await request.get(`/api/agent-library?division=e2elib`)
    expect(listRes.ok()).toBe(true)
    const list = (await listRes.json()) as {
      data: {
        divisions: { key: string; label: string }[]
        entries: { id: string; name: string; emoji: string | null }[]
      }
    }
    expect(list.data.divisions.find((d) => d.key === 'e2elib')?.label).toBe('E2E Library')
    const entry = list.data.entries.find((e) => e.id === LIB_ID)
    expect(entry?.name).toBe(PERSONA_NAME)
    expect(entry?.emoji).toBe('🧪')

    const detailRes = await request.get(`/api/agent-library/e2elib/e2e-persona-one`)
    expect(detailRes.ok()).toBe(true)
    const detail = (await detailRes.json()) as {
      data: { previews: { profile: string }[]; instantiated: unknown }
    }
    expect(detail.data.previews.map((p) => p.profile)).toEqual(['full', 'slim', 'minimal'])
    expect(detail.data.instantiated).toBeNull()
  })

  test('UI journey: browse → enable → lands on the new agent with slim persona', async ({ page }) => {
    await page.goto('/agents')
    await page.getByRole('button', { name: '从人格库启用' }).click()

    const dialog = page.getByRole('dialog', { name: '从人格库启用 Agent' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'E2E Library' })).toBeVisible()

    await dialog.getByLabel('搜索人格库').fill(PERSONA_NAME)
    await dialog.getByRole('button', { name: `查看人格 ${PERSONA_NAME}` }).click()

    // 确认步：三档单选 + slim 默认选中，直接启用。
    await expect(dialog.getByText('导入档位（systemPrompt 体积）')).toBeVisible()
    await dialog.getByRole('button', { name: '启用', exact: true }).click()

    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 15_000 })
    instantiatedAgentId = page.url().split('/').pop() ?? ''

    // DB 断言：slim 编译（剥 Deliverables）+ 语言包络 + library_meta 溯源。
    const { records } = await ctx!.db.runQuery<{
      name: string; kind: string; instructions: string; library_meta: { id: string; profile: string }
    }>(
      `SELECT name, kind, instructions, library_meta FROM agents WHERE id = $1::uuid`,
      [instantiatedAgentId],
    )
    const row = records[0]
    expect(row.name).toBe(PERSONA_NAME)
    expect(row.kind).toBe('claude')
    expect(row.instructions).toContain('E2E Persona One')
    expect(row.instructions).not.toContain('Technical Deliverables')
    expect(row.instructions).toContain('respond in Chinese')
    expect(row.library_meta.id).toBe(LIB_ID)
    expect(row.library_meta.profile).toBe('slim')

    // 注册清理（dispose 按 FK 安全顺序删 agents）。
    ctx!.agentIds.push(instantiatedAgentId)
  })

  test('drift lists the enabled persona as up-to-date', async ({ request }) => {
    const res = await request.get('/api/agent-library/drift')
    expect(res.ok()).toBe(true)
    const json = (await res.json()) as {
      data: { items: { libraryId: string; state: string }[] }
    }
    const mine = json.data.items.find((i) => i.libraryId === LIB_ID)
    expect(mine?.state).toBe('up-to-date')
  })

  // Phase 3：团队场景 tab。成员可解析性取决于挂载的库（本机真库 vs CI 无库），
  // 断言只锁环境无关的渲染结构：模板卡片、成员 chips、确认步成员清单。
  test('team scenarios tab renders template cards and member list', async ({ page }) => {
    await page.goto('/agents')
    await page.getByRole('button', { name: '从人格库启用' }).click()

    const dialog = page.getByRole('dialog', { name: '从人格库启用 Agent' })
    await dialog.getByRole('tab', { name: '团队场景' }).click()

    const card = dialog.getByRole('button', { name: '查看团队场景 创业 MVP 构建' })
    await expect(card).toBeVisible()
    await expect(card.locator('.alib-member-chip', { hasText: '上线质检' })).toBeVisible() // 成员 chip

    await card.click()
    await expect(dialog.getByText('成员按顺序执行，上游产出作为下游输入。')).toBeVisible()
    // 确认步列出全部 5 个成员行（名字 + 职责标签 + 状态角标）。
    const members = dialog.locator('.alib-team-member')
    await expect(members).toHaveCount(5)
    await expect(dialog.locator('.alib-team-member').filter({ hasText: 'Backend Architect' })).toBeVisible()
  })

  // ── 测试工程师补口（2026-08-20）────────────────────────────────────────

  // 顺序依赖：上方 UI journey 已启用 E2E Persona One（spec 内按序执行）。
  test('enabled persona carries its drift badge on the card', async ({ page }) => {
    await page.goto('/agents')
    await page.getByRole('button', { name: '从人格库启用' }).click()
    const dialog = page.getByRole('dialog', { name: '从人格库启用 Agent' })
    await dialog.getByLabel('搜索人格库').fill('E2E Persona One')
    const card = dialog.getByRole('button', { name: '查看人格 E2E Persona One' })
    await expect(card.locator('.alib-badge-up-to-date')).toHaveText('已启用')
  })

  // 团队全链 UI 旅程：挂载含 marketing-launch 5 成员的 fixture（真库路径
  // shadow / CI 唯一来源，两端都确定可解析）→ 团队 tab → 确认步 → 创建
  // 工作流 → 落在画布。清理删除本次 flow 与成员 agents（这些 library id
  // 只可能来自本 spec —— 成员人格随时可在库页一键重启用）。
  test('team scenario full journey: create workflow and land on canvas', async ({ page, request }) => {
    const teamFixture = join(__dirname, 'fixtures', 'agent-library-teams')
    await request.delete(`/api/agent-library/roots?dir=${encodeURIComponent(teamFixture)}`)
    const mount = await request.post('/api/agent-library/roots', { data: { dir: teamFixture } })
    expect(mount.ok(), `mount team fixture: ${await mount.text()}`).toBe(true)

    try {
      await page.goto('/agents')
      await page.getByRole('button', { name: '从人格库启用' }).click()
      const dialog = page.getByRole('dialog', { name: '从人格库启用 Agent' })
      await dialog.getByRole('tab', { name: '团队场景' }).click()
      await dialog.getByRole('button', { name: '查看团队场景 营销活动发布' }).click()
      await expect(dialog.locator('.alib-team-member')).toHaveCount(5)
      await dialog.getByRole('button', { name: '创建工作流', exact: true }).click()

      await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/canvas$/, { timeout: 30_000 })

      const flowId = page.url().match(/\/workflows\/([0-9a-f-]{36})\/canvas$/)![1]
      const memberRows = await ctx!.db.runQuery<{ count: string }>(
        `SELECT count(*)::text AS count FROM agents
          WHERE library_meta->>'id' = ANY($1::text[])`,
        [[
          'marketing/content-creator', 'marketing/twitter-engager', 'marketing/instagram-curator',
          'marketing/reddit-community-builder', 'support/analytics-reporter',
        ]],
      )
      expect(Number(memberRows.records[0].count)).toBeGreaterThanOrEqual(5)

      await ctx!.db.runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [flowId])
      await ctx!.db.runQuery(
        `DELETE FROM agents WHERE library_meta->>'id' = ANY($1::text[])`,
        [[
          'marketing/content-creator', 'marketing/twitter-engager', 'marketing/instagram-curator',
          'marketing/reddit-community-builder', 'support/analytics-reporter',
        ]],
      )
    } finally {
      await request.delete(`/api/agent-library/roots?dir=${encodeURIComponent(teamFixture)}`)
    }
  })
})
