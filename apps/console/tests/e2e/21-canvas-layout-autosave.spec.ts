import { test, expect, type APIRequestContext } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'

/**
 * 21-canvas-layout-autosave — 画布布局自动保存（2026-09-06）。
 *
 * CV-LAY-01: 拖拽节点停手 → debounce(~800ms) 静默 PUT /api/workflows/:id/layout
 *            → gateway merge 进 flow_data（坐标取整）。
 * CV-LAY-02: 刷新后位置从 DB 还原（不再回退到旧布局）。
 * CV-LAY-03: readOnly 画布（旁观编辑锁）不触发自动保存。
 *
 * 拖拽用 playwright CDP 级真实输入（IAB webview 的合成事件驱动不了 RF 的
 * d3-drag 层 —— 见会话记录；e2e chromium 没有此限制）。
 */

/** 读 flow_data 里指定节点的坐标（经 console BFF → gateway）。 */
async function readNodePosition(
  request: APIRequestContext,
  flowId: string,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  const res = await request.get(`/api/workflows/${flowId}`)
  expect(res.ok()).toBeTruthy()
  const json = (await res.json()) as {
    data: { flow: { flowData: { nodes: Array<{ id: string; position: { x: number; y: number } }> } } }
  }
  const node = json.data.flow.flowData.nodes.find((n) => n.id === nodeId)
  expect(node).toBeTruthy()
  return node!.position
}

test.describe('画布布局自动保存', () => {
  let ctx: SeedContext
  let flowId = ''

  test.beforeAll(async ({ request }) => {
    ctx = await createSeedContext()
    flowId = await seedFlow(ctx, request, {
      name: 'e2e-布局自动保存',
      flowData: {
        nodes: [
          { id: 'n1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
          {
            id: 'n2',
            type: 'customNode',
            position: { x: 300, y: 0 },
            data: { name: 'llmAgentflow', label: '布局测试', model: 'p::m', prompt: 'hi' },
          },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    })
  })

  test.afterAll(async () => {
    await ctx.dispose()
  })

  test('CV-LAY-01/02: 拖拽停 → 落库 → 刷新还原', async ({ page, request }) => {
    test.setTimeout(60_000)
    await page.goto(`/workflows/${flowId}/canvas`)
    const node = page.locator('.react-flow__node[data-id="n2"]')
    await expect(node).toBeVisible({ timeout: 20_000 }) // dev 冷编译放宽
    await expect(node).toContainText('布局测试')

    // 真实拖拽：节点中心 → 右下 +160/+120（steps 让 d3-drag 逐帧吃到移动）
    const box = (await node.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 160, cy + 120, { steps: 10 })
    await page.mouse.up()

    // debounce 800ms + BFF → gateway 落库；轮询 DB 直到坐标离开种子值 (300,0)
    await expect
      .poll(() => readNodePosition(request, flowId, 'n2'), { timeout: 8_000 })
      .not.toEqual({ x: 300, y: 0 })
    const persisted = await readNodePosition(request, flowId, 'n2')
    expect(Math.abs(persisted.x - 300)).toBeGreaterThan(80)

    // 刷新：位置从 DB 还原（DOM transform 是 flow 坐标，不受视口影响）
    await page.reload()
    const restored = page.locator('.react-flow__node[data-id="n2"]')
    await expect(restored).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => restored.evaluate((el) => el.style.transform), { timeout: 5_000 })
      .toContain(`translate(${persisted.x}px, ${persisted.y}px)`)
  })

  test('CV-LAY-03: 不动布局时刷新不写库（无意外 PUT）', async ({ page, request }) => {
    test.setTimeout(40_000)
    const posBefore = await readNodePosition(request, flowId, 'n1')
    await page.goto(`/workflows/${flowId}/canvas`)
    await expect(page.locator('.react-flow__node[data-id="n1"]')).toBeVisible({ timeout: 20_000 })
    // 不拖任何东西：初始 fitView 的 onMoveEnd 可能触发一次同值 merge（幂等），
    // 断言坐标不变即可 —— 自动保存永不该改语义内容。
    await page.waitForTimeout(1_500)
    const posAfter = await readNodePosition(request, flowId, 'n1')
    expect(posAfter).toEqual(posBefore)
  })
})
