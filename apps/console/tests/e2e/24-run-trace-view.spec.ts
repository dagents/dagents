import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'

/**
 * 24-run-trace-view — 运行结果「轨迹」视图 e2e（2026-10-01，参考
 * deepseek-harness Trajectory 的交互语法）。
 *
 * TC-01: 旁观运行 → 「轨迹」tab → 节点泳道时间线渲染（泳道标签 +
 *        节点段横条 + 投影模式切换）。
 * TC-02: 事件台账渲染过程事件（kind pill + 时间列），failed 节点分区
 *        状态驱动自动展开并带错误行。
 * TC-03: 台账行点击 → Inspector 显示事件全文 + 「查看节点」；节点检视
 *        概览/输入/输出 tab。
 * TC-04: 无时间戳旧运行（started/finished 缺席）→ actual 投影降级
 *        sequence 并提示。
 *
 * 数据直插 run_node_spans（span-writer 终态形状，events 带 at），不跑
 * 真实引擎 —— 本 spec 钉的是 UI 消费契约（run-trace-model 派生 +
 * CanvasTraceView 渲染）。
 */

let ctx: SeedContext
let flowId = ''
let runId = ''

test.beforeAll(async ({ request }) => {
  ctx = await createSeedContext()
  flowId = await seedFlow(ctx, request, {
    name: 'e2e-轨迹视图',
    flowData: {
      nodes: [
        { id: 'n1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
        {
          id: 'n2',
          type: 'customNode',
          position: { x: 300, y: 0 },
          data: { name: 'platformAgentAgentflow', label: '分析', agentId: 'x' },
        },
        {
          id: 'n3',
          type: 'customNode',
          position: { x: 600, y: 0 },
          data: { name: 'llmAgentflow', label: '总结' },
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    },
  })
  runId = crypto.randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at, finished_at, duration_ms)
     VALUES ($1::uuid, $1::text, $2, 'failed', '{}', 'flow', NOW() - interval '1 hour', NOW() - interval '58 minutes', 120000)`,
    [runId, flowId],
  )
  await ctx.db.runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, error, input, output)
     VALUES
     ($1, $2, 'n1', '开始', 'start', 'done', NOW() - interval '2 minutes', NOW() - interval '119 seconds', 1000, NULL, NULL, NULL),
     ($1, $2, 'n2', '分析', 'platformAgent', 'done', NOW() - interval '118 seconds', NOW() - interval '40 seconds', 78000, NULL,
      '{"model": "claude-sonnet-4-5"}'::jsonb, $3::jsonb),
     ($1, $2, 'n3', '总结', 'llm', 'failed', NOW() - interval '39 seconds', NOW() - interval '10 seconds', 29000, '模型超时',
      NULL, $4::jsonb)`,
    [
      runId,
      flowId,
      JSON.stringify({
        text: '这是分析节点的成品正文。',
        events: [
          { kind: 'thinking', label: '先想清楚再动手', at: '2026-10-01T10:00:01Z' },
          { kind: 'tool', label: 'Bash', detail: '{"command":"ls -la"}', at: '2026-10-01T10:00:02Z' },
          { kind: 'tool_result', label: 'Bash', detail: 'file-a\nfile-b', at: '2026-10-01T10:00:03Z' },
        ],
      }),
      JSON.stringify({
        events: [{ kind: 'error', label: '调用超时', at: '2026-10-01T10:01:20Z' }],
      }),
    ],
  )
})

test.afterAll(async () => {
  await ctx.dispose()
})

test.describe('运行结果轨迹视图', () => {
  test('TC-01: 旁观运行 → 轨迹 tab → 节点泳道时间线渲染', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)

    const traceTab = page.getByRole('tab', { name: '轨迹' })
    await expect(traceTab).toBeVisible({ timeout: 20_000 }) // dev 冷编译放宽
    await traceTab.click()

    const trace = page.locator('.canvas-trace')
    await expect(trace).toBeVisible()

    // 泳道标签：三个节点三行（含状态点）
    await expect(trace.locator('.trace-label-text')).toHaveCount(3)
    await expect(trace.locator('.trace-label-text', { hasText: '分析' })).toBeVisible()
    // 节点段横条 ≥3（start/agent/llm 各一）
    await expect(trace.locator('.trace-span').first()).toBeVisible()
    expect(await trace.locator('.trace-span').count()).toBeGreaterThanOrEqual(3)
    // 投影模式切换（默认 actual；三个按钮）
    await expect(trace.locator('.trace-mode-btn')).toHaveCount(3)
    await expect(trace.locator('.trace-mode-btn.active')).toHaveText('实际')
    // 面板加宽（轨迹视图需要横向空间）
    await expect(page.locator('.canvas-results-panel.wide')).toBeAttached()
  })

  test('TC-02: 事件台账渲染过程事件；failed 分区自动展开', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)
    const traceTab = page.getByRole('tab', { name: '轨迹' })
    await expect(traceTab).toBeVisible({ timeout: 20_000 })
    await traceTab.click()
    const trace = page.locator('.canvas-trace')
    await expect(trace).toBeVisible()

    // 节点分区头（label + $ command + 状态/耗时/条数）
    await expect(trace.locator('.trace-node-head', { hasText: '分析' })).toContainText('$ agent')
    // done 分区默认收起（状态驱动自动展开只开 running/failed）—— 手动展开
    const agentHead = trace.locator('.trace-node-head', { hasText: '分析' })
    await agentHead.click()
    await expect(agentHead).toHaveAttribute('aria-expanded', 'true')
    // 台账行：分析分区含 thinking/工具行（有时间列 +xs）
    const rowThinking = trace.locator('.trace-row.k-thinking', { hasText: '先想清楚再动手' })
    await expect(rowThinking).toBeVisible()
    await expect(rowThinking.locator('.trace-row-time')).toContainText('+')
    await expect(trace.locator('.trace-row.k-tool', { hasText: 'Bash' })).toBeVisible()
    // failed 分区自动展开且带错误行
    const failedNode = trace.locator('.trace-node', { hasText: '总结' })
    await expect(failedNode.locator('.trace-row.k-error')).toContainText('调用超时')
    await expect(failedNode.locator('.trace-node-head .trace-node-dot.st-err')).toBeAttached()
  })

  test('TC-03: 台账行 → Inspector 事件全文；「查看节点」→ 节点检视', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)
    const traceTab = page.getByRole('tab', { name: '轨迹' })
    await expect(traceTab).toBeVisible({ timeout: 20_000 })
    await traceTab.click()
    const trace = page.locator('.canvas-trace')
    await expect(trace).toBeVisible()

    // 点工具行 → Inspector：事件全文 detail + 复制按钮（先展开分析分区）
    await trace.locator('.trace-node-head', { hasText: '分析' }).click()
    await trace.locator('.trace-row.k-tool', { hasText: 'Bash' }).first().click()
    const insp = trace.locator('.trace-inspector')
    await expect(insp).toBeVisible()
    await expect(insp.locator('.trace-insp-detail')).toContainText('"command":"ls -la"')

    // 查看节点 → 节点检视：概览 tab（$ command）→ 输出 tab（正文）
    await insp.locator('.trace-insp-nodelink').click()
    await expect(insp.locator('.trace-insp-title')).toHaveText('分析')
    await expect(insp.locator('.trace-insp-kv')).toContainText('$ agent · claude-sonnet-4-5')
    await insp.getByRole('tab', { name: '输出' }).click()
    await expect(insp.locator('.trace-insp-pre')).toContainText('这是分析节点的成品正文')
  })

  test('TC-04: 无时间戳旧运行 → actual 降级 sequence 并提示', async ({ page }) => {
    test.setTimeout(60_000)
    // 造一个 started/finished 全缺席的旧运行（actual 投影无锚点）
    const legacyRunId = crypto.randomUUID()
    await ctx.db.runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at, finished_at, duration_ms)
       VALUES ($1::uuid, $1::text, $2, 'completed', '{}', 'flow', NOW() - interval '2 hours', NOW() - interval '119 minutes', 60000)`,
      [legacyRunId, flowId],
    )
    await ctx.db.runQuery(
      `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, output)
       VALUES ($1, $2, 'n2', '分析', 'platformAgent', 'done',
        $3::jsonb)`,
      [
        legacyRunId,
        flowId,
        JSON.stringify({
          text: '旧运行正文',
          events: [{ kind: 'tool', label: 'Bash(...)' }],
        }),
      ],
    )
    ctx.runIds.push(legacyRunId)

    await page.goto(`/workflows/${flowId}/canvas?run=${legacyRunId}`)
    const traceTab = page.getByRole('tab', { name: '轨迹' })
    await expect(traceTab).toBeVisible({ timeout: 20_000 })
    await traceTab.click()
    const trace = page.locator('.canvas-trace')
    await expect(trace).toBeVisible()
    // 降级提示 + 时间列诚实显示 —（先展开分区再断言行）
    await expect(trace.locator('.trace-degraded')).toContainText('已降级为时序投影')
    await trace.locator('.trace-node-head', { hasText: '分析' }).click()
    await expect(trace.locator('.trace-row.k-tool').first().locator('.trace-row-time')).toHaveText('—')
  })
})
