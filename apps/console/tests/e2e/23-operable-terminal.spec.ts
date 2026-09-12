import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'

/**
 * 23-operable-terminal — 可操作终端 e2e（2026-09-08，docs/prd-operable-terminal.md）。
 *
 * OT-01: 重跑闭环（B）—— 列表历史行「重跑」→ 运行对话框预填上次输入 →
 *        提交 → 画布旁观接管（?run=）。全旅程钉死 ⬆ 语义。
 * OT-02: 终端 stdin 行状态机（A 的 UI 面）—— 运行结束 → 原位「重跑」入口；
 *        运行中但无 CLI 汇点（HTTP 路径，inputSupported=false）→ 禁用 + 原因。
 * OT-03: 插话路由 BFF 透传 —— 无活执行的 runId → 409（与 cancel 对齐）。
 *
 * 数据直插 runs/run_node_spans（不跑真实 CLI）—— e2e 环境无 claude CLI
 * 会话，inputSupported 恒 false，恰好用来钉「诚实禁用态」；真实送达走
 * 本机真机冒烟（PRD §8，不进 CI）。
 */

let ctx: SeedContext
let flowId = ''
let doneRunId = ''

test.beforeAll(async ({ request }) => {
  ctx = await createSeedContext()
  flowId = await seedFlow(ctx, request, {
    name: 'e2e-可操作终端',
    flowData: {
      nodes: [
        { id: 'n1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
        {
          id: 'n2',
          type: 'customNode',
          position: { x: 300, y: 0 },
          data: { name: 'directReplyAgentflow', label: '回复' },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    },
  })

  // 已完成的运行：带输入全文（重跑预填数据源）+ events 全量（终端视图）
  doneRunId = crypto.randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at, finished_at, duration_ms)
     VALUES ($1::uuid, $1::text, $2, 'completed', $3::jsonb, 'flow', NOW() - interval '1 hour', NOW() - interval '58 minutes', 120000)`,
    [doneRunId, flowId, JSON.stringify({ input: '重跑这行的输入文本' })],
  )
  await ctx.db.runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, input, output)
     VALUES
     ($1, $2, 'n1', '开始', 'start', 'done', NOW() - interval '2 minutes', NOW() - interval '119 seconds', 1000, NULL, NULL),
     ($1, $2, 'n2', '回复', 'directReply', 'done', NOW() - interval '118 seconds', NOW() - interval '10 seconds', 108000, NULL,
      '{"text": "上次的产出正文", "events": [{"kind": "log", "label": "直出回复", "at": "2026-09-08T10:00:00Z"}]}'::jsonb)`,
    [doneRunId, flowId],
  )
})

test.afterAll(async () => {
  await ctx.dispose()
})

test.describe('可操作终端', () => {
  test('OT-01: 历史行重跑 → 对话框预填上次输入 → 提交 → 画布旁观接管', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    // .flow-card 限定到卡片根 —— data-flow-id 在卡片内部按钮上也存在
    const card = page.locator(`.flow-card[data-flow-id="${flowId}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 }) // dev 冷编译放宽
    await card.locator('[data-toggle]').click()
    await expect(card).toHaveClass(/expanded/)

    // 历史行的重跑按钮（⬆ 等价物，画布旁观按钮旁）
    const row = card.locator('.flow-runs-row').filter({ hasText: '重跑这行的输入文本' })
    await expect(row).toBeVisible()
    const rerunBtn = row.getByRole('button', { name: '重跑' })
    await expect(rerunBtn).toBeVisible()
    await rerunBtn.click()

    // 运行对话框打开且预填上次输入（历史行 input 全文优先于记忆）
    const dialog = page.getByRole('dialog', { name: '运行输入' })
    await expect(dialog).toBeVisible()
    const textarea = dialog.locator('textarea')
    await expect(textarea).toHaveValue('重跑这行的输入文本')

    // 可再编辑 + 提交 → async run → 画布旁观接管
    await textarea.fill('重跑旅程改过的输入')
    await dialog.getByRole('button', { name: '开始运行' }).click()
    await page.waitForURL(/\/workflows\/[^\s]+\/canvas\?run=/, { timeout: 20_000 })
  })

  test('OT-02a: 终端 stdin 行结束态 —— 原位「重跑」入口打开输入面板', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas?run=${doneRunId}`)
    const termTab = page.getByRole('tab', { name: '终端' })
    await expect(termTab).toBeVisible({ timeout: 20_000 })
    await termTab.click()

    // 运行结束：stdin 行翻到结束态（就近原则 —— ⬆ 在原地）
    const bar = page.locator('.rti-done')
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: '重跑' }).click()

    // 画布运行输入面板打开（输入记忆为空时预填空串 —— 画布直跑首跑）
    await expect(page.locator('.canvas-run-panel')).toBeVisible()
  })

  test('OT-02b: 运行中无 CLI 汇点 → stdin 行禁用 + 原因（诚实不假装）', async ({ page }) => {
    test.setTimeout(60_000)
    // 造一个 running 运行 + running span：无 CLI 会话 → inputSupported=false
    const runningRunId = crypto.randomUUID()
    await ctx.db.runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at)
       VALUES ($1::uuid, $1::text, $2, 'running', '{}', 'flow', NOW())`,
      [runningRunId, flowId],
    )
    await ctx.db.runQuery(
      `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, output)
       VALUES ($1, $2, 'n2', '回复', 'directReply', 'running', NOW(), NULL)`,
      [runningRunId, flowId],
    )
    try {
      await page.goto(`/workflows/${flowId}/canvas?run=${runningRunId}`)
      const termTab = page.getByRole('tab', { name: '终端' })
      await expect(termTab).toBeVisible({ timeout: 20_000 })
      await termTab.click()

      // 运行中 + inputSupported=false → 禁用态给原因，不渲染可输入框
      await expect(page.locator('.rti-disabled')).toBeVisible()
      await expect(page.locator('.rti-disabled')).toContainText('不可插话')
      await expect(page.locator('.rti-input')).toHaveCount(0)
    } finally {
      // 收敛 running 行：防 boot sweep / 其它用例把它当孤儿
      await ctx.db.runQuery(`UPDATE runs SET status = 'failed' WHERE id = $1::uuid`, [runningRunId])
      await ctx.db.runQuery(`UPDATE run_node_spans SET status = 'failed' WHERE run_id = $1::uuid`, [runningRunId])
    }
  })

  test('OT-03: 插话路由 —— 无活执行 409（BFF 透传 gateway 控制通道）', async ({ request }) => {
    const res = await request.post(`/api/workflows/runs/${crypto.randomUUID()}/message`, {
      data: { nodeId: 'n2', text: '冒烟' },
    })
    expect(res.status()).toBe(409)
    const json = (await res.json()) as { success: boolean; error?: string }
    expect(json.success).toBe(false)
  })
})
