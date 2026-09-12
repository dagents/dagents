import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'

/**
 * 22-run-terminal-view — 运行结果「终端」视图 e2e（2026-09-06）。
 *
 * RT-01: 画布旁观 → 结果面板「终端」tab 渲染全量事件流（thinking/工具/
 *        工具结果/错误行 + 正文 + 段头元信息）。
 * RT-02: 查看全文入口存在（ResultViewer 角标）。
 * RT-03: 旧运行（仅 activity 环）显示「早于全量采集」提示。
 *
 * 数据直插 run_node_spans（span-writer 终态形状），不跑真实引擎 ——
 * 本 spec 钉的是 UI 消费契约（run-terminal-format 派生 + RunTerminal 渲染）。
 */

let ctx: SeedContext
let flowId = ''
let runId = ''

test.beforeAll(async ({ request }) => {
  ctx = await createSeedContext()
  flowId = await seedFlow(ctx, request, {
    name: 'e2e-终端视图',
    flowData: {
      nodes: [
        { id: 'n1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
        {
          id: 'n2',
          type: 'customNode',
          position: { x: 300, y: 0 },
          data: { name: 'platformAgentAgentflow', label: '分析', agentId: 'x' },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    },
  })
  runId = crypto.randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at, finished_at, duration_ms)
     VALUES ($1::uuid, $1::text, $2, 'completed', '{}', 'flow', NOW() - interval '1 hour', NOW() - interval '58 minutes', 120000)`,
    [runId, flowId],
  )
  await ctx.db.runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, input, output)
     VALUES
     ($1, $2, 'n1', '开始', 'start', 'done', NOW() - interval '2 minutes', NOW() - interval '119 seconds', 1000, NULL, NULL),
     ($1, $2, 'n2', '分析', 'platformAgent', 'done', NOW() - interval '118 seconds', NOW() - interval '10 seconds', 108000,
      '{"model": "claude-sonnet-4-5"}'::jsonb,
      $3::jsonb)`,
    [
      runId,
      flowId,
      JSON.stringify({
        text: '这是成品正文，包含结论一句话。',
        events: [
          { kind: 'thinking', label: '先想清楚再动手', at: '2026-09-06T10:00:01Z' },
          { kind: 'tool', label: 'Bash', detail: '{"command":"ls -la"}', at: '2026-09-06T10:00:02Z' },
          { kind: 'tool_result', label: 'Bash', detail: 'file-a\nfile-b', at: '2026-09-06T10:00:03Z' },
          { kind: 'error', label: '一次限流重试成功', at: '2026-09-06T10:00:04Z' },
        ],
      }),
    ],
  )
})

test.afterAll(async () => {
  await ctx.dispose()
})

test.describe('运行结果终端视图', () => {
  test('RT-01/02: 旁观运行 → 终端 tab 渲染全量事件流 + 查看全文入口', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)

    // 切到终端视图（localStorage 记忆键直接置后 reload 亦可；走 UI 更真）
    const termTab = page.getByRole('tab', { name: '终端' })
    await expect(termTab).toBeVisible({ timeout: 20_000 }) // dev 冷编译放宽
    await termTab.click()

    const terminal = page.locator('.run-terminal')
    await expect(terminal).toBeVisible()

    // 段头（节点名 + 状态 + tokens/耗时元信息行；两个节点两段）
    await expect(terminal.locator('.rtl-sep', { hasText: '分析' })).toHaveCount(1)
    // 提示行（$ agent · model；按文本收敛到 agent 段）
    await expect(terminal.locator('.rtl-cmd', { hasText: 'agent' })).toContainText('$ agent · claude-sonnet-4-5')
    // 事件行四类齐全（图标是 svg，按行类断言）
    await expect(terminal.locator('.rtl-thinking')).toContainText('先想清楚再动手')
    await expect(terminal.locator('.rtl-tool')).toContainText('Bash')
    await expect(terminal.locator('.rtl-toolresult')).toContainText('file-a')
    await expect(terminal.locator('.rtl-errorline')).toContainText('限流')
    // 成品正文
    await expect(terminal.locator('.rtl-output')).toContainText('这是成品正文')
    // 查看全文入口（ResultViewer 角标）
    await expect(terminal.locator('.rv-open').first()).toBeAttached()
    // 全量运行不显示旧运行提示
    await expect(terminal.locator('.rtl-legacy-note')).toHaveCount(0)
  })

  test('RT-03: 旧运行（仅 activity 环）显示「早于全量采集」提示', async ({ page }) => {
    test.setTimeout(60_000)
    // 造一个只有 activity 的旧运行
    const legacyRunId = crypto.randomUUID()
    await ctx.db.runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at, finished_at, duration_ms)
       VALUES ($1::uuid, $1::text, $2, 'completed', '{}', 'flow', NOW() - interval '2 hours', NOW() - interval '119 minutes', 60000)`,
      [legacyRunId, flowId],
    )
    await ctx.db.runQuery(
      `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, output)
       VALUES ($1, $2, 'n2', '分析', 'platformAgent', 'done', NOW() - interval '119 minutes', NOW() - interval '118 minutes',
        $3::jsonb)`,
      [legacyRunId, flowId, JSON.stringify({ text: '旧运行正文', activity: [{ kind: 'tool', label: 'Bash(...)', at: '2026-08-01T00:00:00Z' }] })],
    )
    ctx.runIds.push(legacyRunId)

    await page.goto(`/workflows/${flowId}/canvas?run=${legacyRunId}`)
    const termTab = page.getByRole('tab', { name: '终端' })
    await expect(termTab).toBeVisible({ timeout: 20_000 })
    await termTab.click()
    const terminal = page.locator('.run-terminal')
    await expect(terminal).toBeVisible()
    await expect(terminal.locator('.rtl-legacy-note')).toBeVisible()
    await expect(terminal.locator('.rtl-legacy-note')).toContainText('早于全量过程采集')
  })
})
