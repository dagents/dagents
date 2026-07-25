import { test, expect } from '@playwright/test'

/**
 * Workflow engine module e2e — UC-WF-01 ~ UC-WF-12.
 *
 * Module status: ❌ 0/12 implemented. The `packages/workflow/` package does not
 * exist; 14 nodes not migrated; DAG engine not built; new `flows` table not
 * built; new `/api/v1/workflows/*` API not built; Flowise proxy code not
 * removed. See architecture §9 and gap-analysis §10.
 *
 * All twelve user cases are marked `test.fixme` with the gap. This file is
 * deliberately a single suite (not split per UC) because the entire module is
 * one unit of work — when the workflow-engine plan lands, all twelve will be
 * activated together.
 *
 * ## Out of scope for this file
 *
 * The fourteen node types (UC-WF-08) and the DAG execution (UC-WF-09 ~ 11)
 * are engine-internal concerns better tested at the `packages/workflow/` unit
 * level. The e2e here only covers the user-facing surface (API + UI):
 * list/get/create/update/delete/run/history. When the engine lands, the unit
 * tests in `packages/workflow/src/__tests__/` should cover the DAG semantics;
 * these e2e specs stay focused on the HTTP + browser contract.
 */

test.describe('Workflow engine module (UC-WF-01 ~ 12) — architecture §9', () => {
  test.beforeEach(async ({ request }) => {
    // Quick health check: the workflow API does not exist yet, so any request
    // to /api/v1/workflows returns 404. This is intentional — when the route
    // lands, the fixme markers below activate and the requests will start
    // resolving. Keeping the health check here so a misconfigured dev stack
    // (e.g. gateway down) surfaces as a clear failure rather than a confusing
    // "route not found" inside each fixme test.
    const res = await request.get('/api/v1/workflows')
    // Currently 404 — expected. When the route lands, this becomes 200.
    expect([404, 200]).toContain(res.status())
  })

  test.fixme('UC-WF-01: execute workflow (SSE streaming)', async ({ request }) => {
    // Gap: 路由不存在;当前仍用 /api/v1/flows/:id/prediction (Flowise)。
    // 期望: POST /api/v1/workflows/:id/run 返回 SSE,
    //       推送 token / 工具调用 / 思考过程事件。
    const res = await request.post('/api/v1/workflows/test-flow-id/run', {
      headers: { accept: 'text/event-stream' },
      data: { input: 'hello' },
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/event-stream')
  })

  test.fixme('UC-WF-02: list workflows', async ({ request }) => {
    // Gap: 路由不存在;当前用 /api/v1/flows (旧)。
    const res = await request.get('/api/v1/workflows')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data?.items)).toBe(true)
  })

  test.fixme('UC-WF-03: get workflow definition', async ({ request }) => {
    // Gap: 路由不存在;当前用 /api/v1/chatflows/:id (旧)。
    const res = await request.get('/api/v1/workflows/test-flow-id')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.flow_data).toBeTruthy()
  })

  test.fixme('UC-WF-04: create workflow', async ({ request }) => {
    // Gap: 路由不存在;flows 表未建(§9.4)。
    const res = await request.post('/api/v1/workflows', {
      data: { name: 'e2e workflow', flow_data: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(201)
  })

  test.fixme('UC-WF-05: update workflow definition', async ({ request }) => {
    // Gap: 路由不存在。
    const res = await request.put('/api/v1/workflows/test-flow-id', {
      data: { flow_data: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(200)
  })

  test.fixme('UC-WF-06: delete workflow', async ({ request }) => {
    // Gap: 路由不存在。
    const res = await request.delete('/api/v1/workflows/test-flow-id')
    expect(res.status()).toBe(204)
  })

  test.fixme('UC-WF-07: view execution history', async ({ request }) => {
    // Gap: 路由不存在;当前用 /api/v1/executions (旧)。
    const res = await request.get('/api/v1/workflows/test-flow-id/executions')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data?.items)).toBe(true)
  })

  test.fixme('UC-WF-08: support 14 node types', () => {
    // Gap: packages/workflow/src/nodes/ 目录不存在;0/14 节点迁移。
    // 期望节点: Start / Agent / LLM / Tool / HTTP / Condition /
    //          ConditionAgent / Iteration / Loop / HumanInput /
    //          DirectReply / CustomFunction / ExecuteFlow / Retriever。
    //
    // This is a developer-facing concern — covered by unit tests in
    // packages/workflow/src/nodes/__tests__/, not by browser e2e. Kept here
    // as a placeholder so the UC count matches the gap analysis.
    expect(true).toBe(true)
  })

  test.fixme('UC-WF-09: DAG topological execution', () => {
    // Gap: packages/workflow/src/engine/executor.ts 不存在。
    // 期望: 根据 edges 计算执行顺序,节点 output 作为下游 input。
    // 引擎内部行为,unit test 覆盖。
    expect(true).toBe(true)
  })

  test.fixme('UC-WF-10: branch handling (Condition / ConditionAgent)', () => {
    // Gap: 节点未迁移。
    // 期望: Condition 节点根据条件选路径;ConditionAgent 类似。
    expect(true).toBe(true)
  })

  test.fixme('UC-WF-11: loop handling (Iteration / Loop)', () => {
    // Gap: 节点未迁移。
    // 期望: Iteration/Loop 重复执行子路径。
    expect(true).toBe(true)
  })

  test.fixme('UC-WF-12: stream token / tool call / thinking', async ({ request }) => {
    // Gap: packages/workflow/src/engine/sse-streamer.ts 不存在。
    // 期望: SSE 推送多种事件类型 (token / tool_call / thinking / metadata / end)。
    const res = await request.post('/api/v1/workflows/test-flow-id/run', {
      headers: { accept: 'text/event-stream' },
      data: { input: 'stream test' },
    })
    expect(res.headers()['content-type']).toContain('text/event-stream')
  })
})
