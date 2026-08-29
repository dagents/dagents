import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'
import { startNode, llmNode, directReplyNode } from './helpers/flow-builder'

/**
 * Flow Templates e2e — spec-17（docs/flow-templates.md §7）。
 *
 * 覆盖：内置模板列表 → 纯 LLM 模板 UI 全链（零依赖，环境无关）→
 * 用户模板 API 全链（seedFlow → from-flow 抽取 → 实例化 → 删除）→
 * 内置模板删除保护（405）。
 *
 * 前置与其他 spec 相同：dev stack（Postgres + gateway）在线。人格绑定/
 * 降级分支由 gateway 单测覆盖（fixture 根确定性验证），e2e 只锁零依赖路径
 * —— 本机真库与 CI 无库环境结果一致。
 */

const BUILTIN_CARD = '查看模板 内容流水线：生成 → 审校 → 发布'

test.describe('Flow Templates (spec-17)', () => {
  let ctx: SeedContext | null = null
  const seededTemplateIds: string[] = []
  const instantiatedFlowIds: string[] = []

  test.beforeAll(async () => {
    ctx = await createSeedContext()
  })

  test.afterAll(async () => {
    if (ctx) {
      if (seededTemplateIds.length > 0) {
        await ctx.db.runQuery(`DELETE FROM flow_templates WHERE id = ANY($1::uuid[])`, [seededTemplateIds])
      }
      if (instantiatedFlowIds.length > 0) {
        await ctx.db.runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [instantiatedFlowIds])
      }
      await ctx.dispose()
    }
  })

  test('catalogue lists the ten builtin templates (2026-08-22 扩充)', async ({ request }) => {
    const res = await request.get('/api/flow-templates')
    expect(res.ok()).toBe(true)
    const json = (await res.json()) as {
      data: { templates: { id: string; source: string; nodeCount: number }[] }
    }
    const builtin = json.data.templates.filter((t) => t.source === 'builtin')
    expect(builtin).toHaveLength(10)
    expect(builtin.slice(0, 3).map((t) => t.id)).toEqual([
      'builtin/dev-three-step', 'builtin/research-fanout', 'builtin/content-pipeline',
    ])
    expect(builtin.slice(3).map((t) => t.id)).toEqual([
      'builtin/code-review-chain', 'builtin/refactor-plan', 'builtin/bug-triage',
      'builtin/tech-comparison', 'builtin/docs-readme', 'builtin/translate-localize',
      'builtin/release-checklist',
    ])
    expect(builtin.every((t) => t.nodeCount >= 3)).toBe(true)
  })

  test('UI journey: instantiate a pure-LLM builtin and land on canvas', async ({ page }) => {
    await page.goto('/flows')
    await page.getByRole('button', { name: '从模板创建' }).click()

    const dialog = page.getByRole('dialog', { name: '从模板创建工作流' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: '内置模板' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: BUILTIN_CARD })).toBeVisible()

    await dialog.getByRole('button', { name: BUILTIN_CARD }).click()
    await expect(dialog.getByText('纯 LLM 模板，零依赖开箱即跑。')).toBeVisible()
    await dialog.getByRole('button', { name: '创建工作流', exact: true }).click()

    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/canvas$/, { timeout: 30_000 })
    const flowId = page.url().match(/\/workflows\/([0-9a-f-]{36})\/canvas$/)![1]
    instantiatedFlowIds.push(flowId)

    const { records } = await ctx!.db.runQuery<{ name: string; status: string }>(
      `SELECT name, status FROM flows WHERE id = $1::uuid`,
      [flowId],
    )
    expect(records[0].status).toBe('draft')
    expect(records[0].name).toContain('内容流水线')
  })

  test('user template API loop: extract → list → instantiate → delete', async ({ request }) => {
    // 1. 造一条纯 LLM flow（start → llm → reply）。
    const flowId = await seedFlow(ctx!, request, {
      name: 'spec17 源流程',
      flowData: {
        nodes: [
          startNode('node_1'),
          llmNode('node_2', { systemPrompt: 'spec17 任务' }),
          directReplyNode('node_3', { text: 'done' }),
        ],
        edges: [
          { id: 'e1', source: 'node_1', target: 'node_2' },
          { id: 'e2', source: 'node_2', target: 'node_3' },
        ],
      },
    })

    // 2. from-flow 抽取（0 个 agent 引用）。
    const extract = await request.post(`/api/flow-templates/from-flow/${flowId}`, {
      data: { name: 'spec17 用户模板', icon: '🧪' },
    })
    expect(extract.ok(), await extract.text()).toBe(true)
    const tplId = ((await extract.json()) as { data: { id: string } }).data.id
    seededTemplateIds.push(tplId)

    // 3. 列表可见（user 源）。
    const list = await request.get('/api/flow-templates')
    const listJson = (await list.json()) as {
      data: { templates: { id: string; source: string; name: string }[] }
    }
    const mine = listJson.data.templates.find((t) => t.id === tplId)
    expect(mine).toMatchObject({ source: 'user', name: 'spec17 用户模板' })

    // 4. 实例化 → draft flow（节点结构透传）。
    const inst = await request.post(`/api/flow-templates/${tplId}/instantiate`, { data: {} })
    expect(inst.ok(), await inst.text()).toBe(true)
    const instJson = (await inst.json()) as { data: { flowId: string; members: unknown[] } }
    instantiatedFlowIds.push(instJson.data.flowId)
    expect(instJson.data.members).toEqual([])
    const { records } = await ctx!.db.runQuery<{ flow_data: { nodes: unknown[] } }>(
      `SELECT flow_data FROM flows WHERE id = $1::uuid`,
      [instJson.data.flowId],
    )
    expect(records[0].flow_data.nodes).toHaveLength(3)

    // 5. 删除 → 再删 404。
    const del = await request.delete(`/api/flow-templates/${tplId}`)
    expect(del.ok()).toBe(true)
    seededTemplateIds.length = 0
    expect((await request.delete(`/api/flow-templates/${tplId}`)).status()).toBe(404)
  })

  test('builtin templates are delete-protected', async ({ request }) => {
    const res = await request.delete('/api/flow-templates/builtin/content-pipeline')
    expect(res.status()).toBe(405)
  })

  // ── 测试工程师补口：画布另存为模板 UI 全链 + 画廊团队场景 tab ──────────

  test('canvas save-as-template journey: topbar → dialog → saved into My templates', async ({ page, request }) => {
    // 1. 造一条纯 LLM flow 并打开其画布（canvas 页含 vendor 组件，等顶栏出现即可）。
    const flowId = await seedFlow(ctx!, request, {
      name: 'spec17 另存源',
      flowData: {
        nodes: [startNode('node_1'), llmNode('node_2', { systemPrompt: 'x' }), directReplyNode('node_3', { text: 'ok' })],
        edges: [
          { id: 'e1', source: 'node_1', target: 'node_2' },
          { id: 'e2', source: 'node_2', target: 'node_3' },
        ],
      },
    })
    await page.goto(`/workflows/${flowId}/canvas`)
    await page.getByRole('button', { name: '另存为模板' }).waitFor({ state: 'visible', timeout: 30_000 })

    // 2. 打开另存对话框（默认名 = 流程名（模板）），直接保存。
    await page.getByRole('button', { name: '另存为模板' }).click()
    const dialog = page.getByRole('dialog', { name: '另存为模板' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel(/名称/)).toHaveValue('spec17 另存源（模板）')
    await dialog.getByRole('button', { name: '保存模板', exact: true }).click()
    await expect(page.getByText(/已保存为模板/)).toBeVisible({ timeout: 10_000 })

    // 3. 从 toast 无法直接拿模板 id —— 经 DB 反查 source_flow_id，画廊「我的模板」可见。
    const { records } = await ctx!.db.runQuery<{ id: string }>(
      `SELECT id FROM flow_templates WHERE source_flow_id = $1::uuid`,
      [flowId],
    )
    expect(records).toHaveLength(1)
    seededTemplateIds.push(records[0].id)

    await page.goto('/flows')
    await page.getByRole('button', { name: '从模板创建' }).click()
    const gallery = page.getByRole('dialog', { name: '从模板创建工作流' })
    await gallery.getByRole('tab', { name: '我的模板' }).click()
    const card = gallery.getByRole('button', { name: '查看模板 spec17 另存源（模板）' })
    await expect(card).toBeVisible()

    // 4. 我的模板可删除（两步确认：第一次点击武装「确认删除？」，第二次执行）。
    const deleteBtn = page.getByRole('button', { name: '删除模板 spec17 另存源（模板）' })
    await deleteBtn.click()
    await expect(deleteBtn).toHaveText(/确认删除/)
    await deleteBtn.click()
    await expect(page.getByText(/已删除模板/)).toBeVisible({ timeout: 10_000 })
    seededTemplateIds.length = 0
    await expect(card).toHaveCount(0)
  })

  test('gallery teams tab renders team scenario cards from the agent library', async ({ page }) => {
    await page.goto('/flows')
    await page.getByRole('button', { name: '从模板创建' }).click()
    const gallery = page.getByRole('dialog', { name: '从模板创建工作流' })
    // 2026-08-22（方案 F）：「团队场景」更名「虚拟团队」（单人指挥多 Agent，消除多人协作预期）。
    await gallery.getByRole('tab', { name: '虚拟团队' }).click()
    // 虚拟团队目录是静态的（6 个），成员可解析性不影响卡片渲染。
    await expect(gallery.getByRole('button', { name: '查看虚拟团队场景 创业 MVP 构建' })).toBeVisible()
    await expect(gallery.getByRole('button', { name: '查看虚拟团队场景 产品发现（并行）' })).toBeVisible()
  })
})
