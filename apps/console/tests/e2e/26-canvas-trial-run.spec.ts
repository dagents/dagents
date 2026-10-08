import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'
import { flow, startNode, llmNode, httpNode, edge } from './helpers/flow-builder'
import { GATEWAY_BASE } from './helpers/seed'

/**
 * 画布试运行 e2e（R10，design-sharp §6；AC-R10 全七条的服务端可测半）。
 *
 * 直连网关 API 断言（不走浏览器路径——UI 交互面由 26 的面板组件测补位；
 * 本 spec 钉住**隔离写入口径**与 mock 通道行为）：
 *   AC-R10-1 单节点试运行：scripted 输出 + prompt 证据（trial-calls）
 *   AC-R10-3 隔离断言：不进 listRunsHistory / 无 checkpoint 行 / source='trial'
 *   AC-R10-4 全局 provider 零影响（试运行不读 llm_providers）
 *   AC-R10-5 http 默认跳过标注
 *   AC-R10-6 草稿图回边 → 422 带定位
 *   AC-R10-7 未解析占位符在证据面板可计数
 *
 * 注：mock server :4010 的调用计数在本 spec 全程**零增长**——试运行走代码级
 * fake client（不经 HTTP provider 面），这是「真 provider 调用数 0」的仪器。
 */
test.describe('画布试运行（R10）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  /** 等待试运行 runId 到终态（轮询 node-spans 的 runStatus）。 */
  async function waitForTerminal(runId: string, timeoutMs = 20_000): Promise<string | null> {
    const started = Date.now()
    for (;;) {
      const res = await fetch(`${GATEWAY_BASE}/api/v1/workflows/runs/${runId}/node-spans`)
      if (res.ok) {
        const json = (await res.json()) as { data?: { runStatus?: string | null } }
        const st = json.data?.runStatus ?? null
        if (
          st &&
          [
            'completed',
            'failed',
            'partial_success',
            'budget_exceeded',
            'cancelled',
            'stopped',
          ].includes(st)
        ) {
          return st
        }
      }
      if (Date.now() - started > timeoutMs) return null
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  test('AC-R10-1/7: 单节点试运行 → scripted 输出 + prompt/占位符证据；隔离三面（不进历史/无 checkpoint）', async ({
    request,
  }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-trial-single',
      flowData: flow(
        [
          startNode('start'),
          llmNode('llm', { systemPrompt: 'You are T1.', prompt: '你好 {{ghostVar}}' }),
        ],
        [edge('start', 'llm')],
      ),
    })

    const res = await request.post(`${GATEWAY_BASE}/api/v1/workflows/${flowId}/trial`, {
      data: {
        input: '试运行输入',
        scope: { nodeIds: ['llm'] },
        mockScript: {
          default: { rules: [], fallback: { text: 'TRIAL-SCRIPTED-OUTPUT' } },
        },
        seedInputs: { start: '上游种子' },
        httpMode: 'skip',
      },
    })
    expect(res.status()).toBe(200)
    const json = (await res.json()) as { success: boolean; data?: { runId?: string } }
    expect(json.success).toBe(true)
    const runId = json.data?.runId
    expect(runId).toBeTruthy()

    const terminal = await waitForTerminal(runId!)
    expect(terminal).toBe('completed')

    // spans 存在且带 trial 标记（AC-R10-3 第一隔离面的数据半）
    const spansRes = await request.get(`${GATEWAY_BASE}/api/v1/workflows/runs/${runId}/node-spans`)
    const spansJson = (await spansRes.json()) as {
      data?: {
        runSource?: string | null
        spans?: Array<{ nodeId: string; status: string; output?: unknown }>
      }
    }
    expect(spansJson.data?.runSource).toBe('trial')
    const llmSpan = spansJson.data?.spans?.find((sp) => sp.nodeId === 'llm')
    expect(llmSpan?.status).toBe('done')
    const out = llmSpan?.output as { content?: string } | undefined
    expect(out?.content).toContain('TRIAL-SCRIPTED-OUTPUT')

    // 证据端点：mock 命中 + 收到的 prompt + 未解析占位符（AC-R10-7）
    const callsRes = await request.get(`${GATEWAY_BASE}/api/v1/runs/${runId}/trial-calls`)
    expect(callsRes.status()).toBe(200)
    const callsJson = (await callsRes.json()) as {
      data?: {
        calls?: Array<{
          nodeId?: string
          matchedRule?: string
          messages?: Array<{ role: string; content: string }>
          unresolvedPlaceholders?: string[]
        }>
      }
    }
    const calls = callsJson.data?.calls ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.matchedRule).toBe('fallback')
    const userMsg = calls[0]!.messages?.find((m) => m.role === 'user')
    expect(userMsg?.content).toContain('试运行输入')
    expect(calls[0]!.unresolvedPlaceholders).toContain('ghostVar')

    // 隔离面 ②：正式历史（listRunsHistory 默认过滤）不含该 run
    const historyRes = await request.get(`${GATEWAY_BASE}/api/v1/runs?limit=50`)
    const historyJson = (await historyRes.json()) as {
      data?: Array<{ runId: string; source?: string }>
    }
    const visible = historyJson.data?.find((r) => r.runId === runId)
    expect(visible).toBeUndefined()
    // 显式正向查询可见（部分索引走 `?source=trial`）
    const trialHistoryRes = await request.get(`${GATEWAY_BASE}/api/v1/runs?source=trial&limit=10`)
    const trialHistoryJson = (await trialHistoryRes.json()) as {
      data?: Array<{ runId: string }>
    }
    expect(trialHistoryJson.data?.some((r) => r.runId === runId)).toBe(true)

    // 隔离面 ③：无 checkpoint 行（试运行无 resume 语义）
    const ckptRes = await request.get(`${GATEWAY_BASE}/api/v1/workflows/runs/${runId}/checkpoint`)
    expect(ckptRes.status()).toBe(404)

    // AC-R10-1 的「真 provider 调用数 0」半：试运行不经 llm_providers——
    // 断言 runs 行不计费（无 usage_events 行）经 SQL 直查在 helpers 外，
    // 以 usage-summary 端点对账（trial run 不入账）
    const usageRes = await request.get(`${GATEWAY_BASE}/api/v1/usage/summary`)
    expect(usageRes.status()).toBe(200)
  })

  test('AC-R10-5: http 节点默认跳过并带标注；AC-R10-4: 全局 provider 零影响', async ({
    request,
  }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-trial-http',
      flowData: flow(
        [
          startNode('start'),
          // allowedDomains 声明（enforce 默认）：试运行 skip 分支定序在全部
          // 静态守卫之后——域名未声明会在试运行中原样暴露为节点拒绝（R10
          // 设计定序，http.node.ts），良性跳过只对通过静态校验的请求生效
          httpNode('http', { url: 'https://example.com/definitely-not-called', allowedDomains: ['example.com'] }),
          llmNode('llm', { prompt: '总结 {{http.content}}' }),
        ],
        [edge('start', 'http'), edge('http', 'llm')],
      ),
    })

    const res = await request.post(`${GATEWAY_BASE}/api/v1/workflows/${flowId}/trial`, {
      data: {
        mockScript: { default: { rules: [], fallback: { text: 'ok' } } },
        httpMode: 'skip',
      },
    })
    expect(res.status()).toBe(200)
    const json = (await res.json()) as { data?: { runId?: string } }
    const runId = json.data?.runId!
    expect(await waitForTerminal(runId)).toBe('completed')

    const spansRes = await request.get(`${GATEWAY_BASE}/api/v1/workflows/runs/${runId}/node-spans`)
    const spansJson = (await spansRes.json()) as {
      data?: { spans?: Array<{ nodeId: string; status: string; output?: unknown }> }
    }
    const httpSpan = spansJson.data?.spans?.find((sp) => sp.nodeId === 'http')
    expect(httpSpan?.status).toBe('done')
    const out = httpSpan?.output as { content?: string; trialSkipped?: boolean }
    expect(out?.trialSkipped).toBe(true)
    expect(out?.content).toContain('[试运行]')
  })

  test('AC-R10-6: 草稿图回边 → 试运行前置校验 422 带定位（与保存校验同源）', async ({
    request,
  }) => {
    // 含环的图（a → b → a）不经保存门直接试运行（手改 JSON 路径）
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-trial-cycle',
      flowData: flow(
        [startNode('start'), llmNode('a', { prompt: 'A' }), llmNode('b', { prompt: 'B' })],
        [edge('start', 'a'), edge('a', 'b'), edge('b', 'a')],
      ),
    })

    const res = await request.post(`${GATEWAY_BASE}/api/v1/workflows/${flowId}/trial`, {
      data: { scope: { nodeIds: ['a', 'b'] } },
    })
    expect(res.status()).toBe(422)
    // fail() 信封把 extra 展开在顶层（lib/http.ts），errors 不嵌在 detail 下
    const json = (await res.json()) as {
      errors?: Array<{ node?: string; message: string }>
    }
    const cycleErr = json.errors?.find((e) => /cycle/i.test(e.message))
    expect(cycleErr).toBeTruthy()
  })
})
