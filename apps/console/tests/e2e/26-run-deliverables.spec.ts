import { test, expect } from '@playwright/test'
import {
  createSeedContext,
  seedFlow,
  seedMockLlmProvider,
  resetMockLlm,
  setMockLlmScript,
  type SeedContext,
} from './helpers/seed'
import { flow, startNode, llmNode, directReplyNode, edge, node } from './helpers/flow-builder'

/**
 * 26 —— R6 渐进产物与失败抢救（design-artifacts.md §⑥ e2e 行，AC-R6-1/2/5）。
 *
 *   DL-01 5 节点链第 4 节点失败 → node-spans 投影 deliverables=3（节点名/
 *        tokens/output 齐全）+ runs.output 仍 NULL（语义不变，AC-R6-1）
 *   DL-02 同步 POST（非 async）终态响应体带 deliverables（AC-R6-1）
 *   DL-03 中途取消 → 渐进聚合区完整呈现取消前已完成节点产出（AC-R6-2；
 *        stopped(interrupted) 场景依赖 R1/R3 落地后补跑，终态词双读）
 *   DL-04 executeFlow 子流程归属 chip + 聚合区行跳终端锚点（AC-R6-5）
 *
 * 编号说明：25 被 design-verdict/design-sharp 两方占用，本方向让位取 26
 * （仓内双 24 重号先例可容它们）。
 */
test.describe('渐进产物（R6 deliverables）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  /** node-spans 信封里的 deliverables（轮询等待网关落库）。 */
  async function fetchDeliverables(
    request: import('@playwright/test').APIRequestContext,
    runId: string,
  ) {
    const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const data = (
      (await r.json()) as {
        data?: { deliverables?: Array<Record<string, unknown>> }
      }
    ).data
    return data?.deliverables ?? null
  }

  test('DL-01: 5 节点链第 4 节点失败 → 投影 3 项产出 + runs.output 仍 NULL（AC-R6-1）', async ({
    request,
  }) => {
    // a/b 直答产出可辨；c 命中空产出规则 → 节点诚实失败（WF-10 契约）
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-dl01-fail-rescue',
      flowData: flow(
        [
          startNode('start'),
          llmNode('a', { systemPrompt: 'You are DL-A.', prompt: 'PA' }),
          llmNode('b', { systemPrompt: 'You are DL-B.', prompt: 'PB' }),
          llmNode('c', { systemPrompt: 'You are DL-C.', prompt: 'PC' }),
          llmNode('d', { systemPrompt: 'You are DL-D.', prompt: 'PD' }),
        ],
        [edge('start', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
      ),
    })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'You are DL-A' }, respond: { text: 'DL01-A-OUT' } },
        { match: { systemContains: 'You are DL-B' }, respond: { text: 'DL01-B-OUT' } },
        { match: { systemContains: 'You are DL-C' }, respond: { text: '' } },
      ],
      fallback: { text: 'ok' },
    })

    const run = await request.post(`/api/workflows/${flowId}/run?async=1`, {
      data: { input: 'go' },
    })
    expect(run.status()).toBe(200)
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    // run 收敛为 failed
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toBe('failed')

    // ★ 投影清单：start/a/b 恰 3 项，条目含节点名 + tokens + output
    const deliverables = (await fetchDeliverables(request, runId)) ?? []
    expect(deliverables.map((d) => d.nodeId).sort()).toEqual(['a', 'b', 'start'])
    const a = deliverables.find((d) => d.nodeId === 'a')!
    expect(a.nodeLabel).toBeTruthy()
    expect(a.status).toBe('done')
    expect(JSON.stringify(a.output)).toContain('DL01-A-OUT')
    expect(a.tokens).toBeTruthy()

    // ★ runs.output 语义不变：失败 run 无产出（清单是第二交付物，不回写）。
    // 落库形态：outputJson = JSON.stringify(null) 即 'null' → jsonb 列是
    // json null 标量而非 SQL NULL——断言两者皆可。
    const sql = await ctx.db.runQuery<{ no_output: boolean }>(
      `SELECT (output IS NULL OR output = 'null'::jsonb) AS no_output FROM runs WHERE id = $1::uuid`,
      [runId],
    )
    expect(sql.records[0]?.no_output).toBe(true)
  })

  test('DL-02: 同步 POST 终态响应体携带 deliverables（AC-R6-1）', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-dl02-sync-body',
      flowData: flow(
        [startNode('start'), llmNode('m', { systemPrompt: 'You are DL-M.', prompt: 'P' })],
        [edge('start', 'm')],
      ),
    })
    await setMockLlmScript({ rules: [], fallback: { text: 'DL02-M-OUT' } })

    // 不走 async —— 同步等待终态，断言响应体本身带清单
    const run = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'go' } })
    expect(run.status()).toBe(200)
    ctx.runIds.push(run.headers()['x-run-id'] as string)
    const body = (await run.json()) as {
      data?: { deliverables?: Array<{ nodeId: string; output: Record<string, unknown> }> }
    }
    const ids = (body.data?.deliverables ?? []).map((d) => d.nodeId)
    expect(ids).toContain('m')
    const m = body.data?.deliverables?.find((d) => d.nodeId === 'm')
    expect(JSON.stringify(m?.output)).toContain('DL02-M-OUT')
  })

  test('DL-03: 中途取消 → 渐进聚合区完整呈现取消前已完成节点产出（AC-R6-2）', async ({
    request,
    page,
  }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-dl03-cancel-rescue',
      flowData: flow(
        [
          startNode('start'),
          llmNode('a', { systemPrompt: 'You are DL3-A.', prompt: 'PA' }),
          llmNode('slow', { systemPrompt: 'You are DL3-SLOW.', prompt: 'PS' }),
          llmNode('d', { systemPrompt: 'You are DL3-D.', prompt: 'PD' }),
        ],
        [edge('start', 'a'), edge('a', 'slow'), edge('slow', 'd')],
      ),
    })
    // a 秒回；slow 挂 8s —— 取消窗口稳定（慢速流 mock 的 delay 规则）
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'You are DL3-A' }, respond: { text: 'DL03-A-OUT' } },
        {
          match: { systemContains: 'You are DL3-SLOW' },
          respond: { text: 'slow-out', delayMs: 8000 },
        },
      ],
      fallback: { text: 'ok' },
    })

    const run = await request.post(`/api/workflows/${flowId}/run?async=1`, {
      data: { input: 'go' },
    })
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    // 等 a 的产出进清单（start+a）再取消 —— 取消前已有可抢救产物
    await expect
      .poll(async () => ((await fetchDeliverables(request, runId)) ?? []).length, {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2)

    const cancel = await request.post(`/api/workflows/runs/${runId}/cancel`)
    expect(cancel.status()).toBe(200)

    // 终态词双读（R3 cancelled→stopped 写新翻转合入后本断言免改）
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toMatch(/^(cancelled|stopped)$/)

    // ★ 不因终态丢失：读面清单仍含取消前完成节点
    const after = (await fetchDeliverables(request, runId)) ?? []
    expect(after.map((d) => d.nodeId)).toContain('a')

    // ★ 面板聚合区（旁观 ?run=）：渲染取消前产出行，未跑节点显式标注「未执行」
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)
    await page.waitForSelector('.canvas-deliverables-card', { timeout: 30_000 })
    // 节点名 span 带 title={nodeId}（hasText 子串会同时命中 st**a**rt）
    await expect(page.locator('.canvas-delv-name[title="a"]')).toBeVisible()
    const deliveredRowText = await page.locator('.canvas-deliverables-card').innerText()
    expect(deliveredRowText).toContain('DL03-A-OUT')
    // d 从未执行 → 「未执行」显式标注（≠失败）；slow 中断未完成同理
    expect(deliveredRowText).toContain('未执行')
  })

  test('DL-04: 子流程产出带归属标注；聚合区行跳终端锚点（AC-R6-5）', async ({ request, page }) => {
    // 子流程：directReply 直出（零 LLM 依赖）
    const childFlowId = await seedFlow(ctx, request, {
      name: 'e2e-dl04-child',
      flowData: flow(
        [startNode('cstart'), directReplyNode('creply', { text: 'DL04-CHILD-OUT' })],
        [edge('cstart', 'creply')],
      ),
    })
    // 父流程：start → executeFlow(子) → 收尾直答
    const parentFlowId = await seedFlow(ctx, request, {
      name: 'e2e-dl04-parent',
      flowData: flow(
        [
          startNode('start'),
          node('sub', 'executeFlowAgentflow', { targetFlowId: childFlowId, label: '调子流程' }),
          directReplyNode('done', { text: 'DL04-PARENT-DONE' }),
        ],
        [edge('start', 'sub'), edge('sub', 'done')],
      ),
    })

    const run = await request.post(`/api/workflows/${parentFlowId}/run?async=1`, {
      data: { input: 'go' },
    })
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toBe('completed')

    // ★ API：子流程节点（子图内的 creply）在清单中带归属名
    // （子流程 spans 并入父 run 同 runId，flow_id=子流程 id → 服务端判归属）
    const deliverables = (await fetchDeliverables(request, runId)) ?? []
    const childRow = deliverables.find((d) => d.nodeId === 'creply')
    expect(
      childRow,
      `子流程节点应在清单中，实际: ${JSON.stringify(deliverables.map((d) => d.nodeId))}`,
    ).toBeTruthy()
    expect(childRow!.subflowName).toBe('e2e-dl04-child')

    // ★ UI：旁观父画布 → 聚合区子流程 chip + 「终端」锚点跳转
    await page.goto(`/workflows/${parentFlowId}/canvas?run=${runId}`)
    await page.waitForSelector('.canvas-deliverables-card', { timeout: 30_000 })
    // 子图节点排在拓扑末尾（父图 topoOrder 不含它们）；creply 行带归属 chip
    const childRowEl = page.locator('.canvas-delv-row').filter({
      has: page.locator('.canvas-delv-name[title="creply"]'),
    })
    await expect(childRowEl).toBeVisible()
    await expect(childRowEl.locator('.canvas-delv-chip-subflow')).toContainText('e2e-dl04-child')

    // 行内「终端」入口：切到终端视图 + 目标段（data-terminal-section）滚入
    await childRowEl.locator('.canvas-delv-term-btn').click()
    await expect
      .poll(
        async () => page.locator('.canvas-results-view-btn.active', { hasText: '终端' }).count(),
        {
          timeout: 10_000,
        },
      )
      .toBeGreaterThan(0)
    const anchor = page.locator('[data-terminal-section="creply"]')
    await expect(anchor).toBeVisible()
  })
})
