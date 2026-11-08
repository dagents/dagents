import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, resetMockLlm, type SeedContext } from './helpers/seed'
import { flow, startNode, directReplyNode, edge, node, NODE } from './helpers/flow-builder'

/**
 * R4 声明式权限闭环 e2e（docs/zcode-borrow/design-permission.md §6.3）。
 *
 *   PG-01 declared-but-violated：http 节点声明 allowed.test、请求 blocked.test
 *        → 节点被拒（span rejected、run partial_success）、span error 含未声明
 *        域名与节点 id（守卫在 fetch 前抛，零真实网络依赖，沙箱确定性）
 *        ——AC-R4-5。
 *   PG-02 customFunction $exec：声明 ['node'] → 真跑成功 + 活动流含 tool 行；
 *        改调 'sh' → 节点被拒带指引（span rejected）——AC-R4-2。
 *   PG-03 确认面：运行面板权限确认区展示命令/域名清单（选择器断言）。
 */
test.describe('权限闭环（R4）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await resetMockLlm()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('PG-01: 恶意 http flow（declared-but-violated）被拦在执行层', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-r4-pg01-domain',
      flowData: flow(
        [
          startNode('start'),
          // 声明 allowed.test、实请求 blocked.test —— 守卫在 fetch 前抛
          node('h1', NODE.http, {
            url: 'https://blocked.test/x',
            allowedDomains: ['allowed.test'],
          }),
          directReplyNode('reply', { text: 'done' }),
        ],
        [edge('start', 'h1'), edge('h1', 'reply')],
      ),
    })

    const run = await request.post(`/api/workflows/${flowId}/run?async=1`, {
      data: { input: 'go' },
    })
    expect(run.status()).toBe(200)
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    // 守卫 fetch 前抛 → 快速失败；轮询到终态（R9d「节点拒绝」档：run
    // partial_success 不整体翻红——集成裁决 2026-10-08 与对照表对齐）
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toBe('partial_success')

    const spans = (
      (await (await request.get(`/api/workflows/runs/${runId}/node-spans`)).json()) as {
        data?: { spans?: Array<{ nodeId: string; status: string | null; error: string | null }> }
      }
    ).data?.spans
    const h1 = spans?.find((s) => s.nodeId === 'h1')
    expect(h1?.status).toBe('rejected')
    // 错误含节点 id 与未声明域名（AC-R4-1 字面要求）+ 拒绝档首词
    expect(h1?.error).toContain('节点被拒绝：')
    expect(h1?.error).toContain('blocked.test')
    expect(h1?.error).toContain('h1')
    expect(h1?.error).toContain('allowed.test')
  })

  test('PG-02: customFunction $exec 白名单通道（放行 + 拒绝两路径）', async ({ request }) => {
    // ① 已列命令：node -e 真跑（async IIFE 形态——函数体契约是 return 值）
    const okFlowId = await seedFlow(ctx, request, {
      name: 'e2e-r4-pg02-exec-ok',
      flowData: flow(
        [
          startNode('start'),
          node('cf', NODE.customFunction, {
            functionCode:
              'return (async () => { const r = await $exec("node", ["-e", "console.log(42)"]); return { code: r.code, out: r.stdout } })()',
            allowedCommands: ['node'],
          }),
          directReplyNode('reply', { text: 'done' }),
        ],
        [edge('start', 'cf'), edge('cf', 'reply')],
      ),
    })
    const okRun = await request.post(`/api/workflows/${okFlowId}/run?async=1`, {
      data: { input: 'go' },
    })
    expect(okRun.status()).toBe(200)
    const okRunId = ((await okRun.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(okRunId)

    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${okRunId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toBe('completed')

    const okSpans = (
      (await (await request.get(`/api/workflows/runs/${okRunId}/node-spans`)).json()) as {
        data?: { spans?: Array<{ nodeId: string; status: string | null; output: unknown }> }
      }
    ).data?.spans
    const cf = okSpans?.find((s) => s.nodeId === 'cf')
    expect(cf?.status).toBe('done')
    // 真受控 spawn 的回传证明（stdout 42）+ 活动流 tool 行（采集层保全文）
    expect(JSON.stringify(cf?.output)).toContain('42')
    expect(JSON.stringify(cf?.output)).toMatch(/tool/)

    // ② 未列命令：sh ∉ ['node'] → 节点被拒带指引（execRunner 零调用；
    // R9d「节点拒绝」档：span rejected、run partial_success）
    const denyFlowId = await seedFlow(ctx, request, {
      name: 'e2e-r4-pg02-exec-deny',
      flowData: flow(
        [
          startNode('start'),
          node('cfx', NODE.customFunction, {
            functionCode: 'return $exec("sh", ["-c", "echo pwned"]).then((r) => r.stdout)',
            allowedCommands: ['node'],
          }),
          directReplyNode('reply', { text: 'done' }),
        ],
        [edge('start', 'cfx'), edge('cfx', 'reply')],
      ),
    })
    const denyRun = await request.post(`/api/workflows/${denyFlowId}/run?async=1`, {
      data: { input: 'go' },
    })
    expect(denyRun.status()).toBe(200)
    const denyRunId = ((await denyRun.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(denyRunId)

    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/workflows/runs/${denyRunId}/node-spans`)
          return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
        },
        { timeout: 30_000 },
      )
      .toBe('partial_success')
    const denySpans = (
      (await (await request.get(`/api/workflows/runs/${denyRunId}/node-spans`)).json()) as {
        data?: { spans?: Array<{ nodeId: string; status: string | null; error: string | null }> }
      }
    ).data?.spans
    const cfx = denySpans?.find((s) => s.nodeId === 'cfx')
    expect(cfx?.status).toBe('rejected')
    expect(cfx?.error).toContain('节点被拒绝：')
    expect(cfx?.error).toContain('sh 未在 allowedCommands 声明')
  })

  test('PG-03: 运行面板权限确认区展示命令/域名清单（AC-R4-4 UI 面）', async ({ page, request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-r4-pg03-panel',
      flowData: flow(
        [
          startNode('start'),
          node('h1', NODE.http, {
            url: 'https://allowed.test/x',
            allowedDomains: ['allowed.test'],
          }),
          node('cf', NODE.customFunction, {
            functionCode: 'return 1',
            allowedCommands: ['git', 'rg'],
          }),
          directReplyNode('reply', { text: 'done' }),
        ],
        [edge('start', 'h1'), edge('h1', 'cf'), edge('cf', 'reply')],
      ),
    })

    await page.goto(`/workflows/${flowId}/canvas`)
    await page.locator('.canvas-run-btn').click()
    const panel = page.getByTestId('run-permission-summary')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('权限确认')
    // 命令清单 chip（git / rg）
    await expect(panel.locator('.run-perm-chip', { hasText: 'git' })).toBeVisible()
    await expect(panel.locator('.run-perm-chip', { hasText: 'rg' })).toBeVisible()
    // 域名清单 chip + 运行时裁决提示
    await expect(panel.locator('.run-perm-chip', { hasText: 'allowed.test' })).toBeVisible()
    await expect(panel).toContainText('$exec 实际调用在白名单内即放行')
  })
})
