import { test, expect } from '@playwright/test'

/**
 * Workflow engine module e2e — UC-WF-01 ~ UC-WF-12.
 *
 * Status (updated 2026-08-08): the workflow engine landed via Plan A/B/C —
 * `packages/workflow/` exists, the `flows` table backs it, and
 * `/api/v1/workflows/*` (proxied by the console at `/api/workflows/*`) is live.
 *
 * The user-facing CRUD surface is now exercised by real `test()`:
 *   - UC-WF-02 ~ 06: list / get / create / update / delete
 *
 * Still `test.fixme` (2026-08-19 更新):
 *   - UC-WF-01 / 12: run + SSE token stream —— 执行态覆盖已由
 *     `11-workflow-execution.spec.ts`（WF-01，Mock LLM 契约层）与
 *     `13-chat-flow-trigger.spec.ts`（TR-01/03/07，SSE 帧序列/流式渲染）
 *     以确定性 Mock LLM Provider 落地；此处 fixme 仅作 UC 编号占位。
 *   - UC-WF-07: GET /:id/executions — route not implemented (only
 *     /runs/:runId/node-spans exists today).
 *   - UC-WF-08 ~ 11: 14 node types / DAG / branch / loop — engine-internal,
 *     covered by unit tests in `packages/workflow/src/__tests__/` + node suites.
 *
 * Console proxy: `/api/workflows/*` → gateway `/api/v1/workflows/*`, piping the
 * gateway's `{ success, data }` envelope through unchanged, so assertions read
 * the gateway shape (data.flows, data.flow, data.deleted) over the console baseURL.
 *
 * Why UC-WF-04 (create) and UC-WF-06 (delete) provision their own flow instead
 * of reusing the shared fixture: the suite runs serially (workers:1) but each
 * test must pass independently — a delete that removed the shared flow would
 * break later tests, so create/delete each spin up a throwaway and clean it up.
 */
test.describe('Workflow engine module (UC-WF-01 ~ 12) — architecture §9', () => {
  // Shared fixture for the read-only UCs (list / get / update). Created in
  // beforeAll, removed in afterAll.
  let sharedFlowId = ''

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/workflows', {
      data: { name: 'e2e-uc-wf-shared', flowData: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(200)
    sharedFlowId = (await res.json()).data.flow.id
  })

  test.afterAll(async ({ request }) => {
    if (sharedFlowId) await request.delete(`/api/workflows/${sharedFlowId}`)
  })

  test('UC-WF-02: list workflows', async ({ request }) => {
    const res = await request.get('/api/workflows')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.flows)).toBe(true)
    expect(body.data.flows.some((f: { id: string }) => f.id === sharedFlowId)).toBe(true)
  })

  test('UC-WF-03: get workflow definition', async ({ request }) => {
    const res = await request.get(`/api/workflows/${sharedFlowId}`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.flow?.id).toBe(sharedFlowId)
    expect(body.data?.flow?.flowData).toBeTruthy()
  })

  test('UC-WF-04: create workflow', async ({ request }) => {
    const res = await request.post('/api/workflows', {
      data: { name: 'e2e-uc-wf-04-create', flowData: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.flow?.id).toBeTruthy()
    // clean up the throwaway so the suite stays side-effect-free
    await request.delete(`/api/workflows/${body.data.flow.id}`)
  })

  test('UC-WF-05: update workflow definition', async ({ request }) => {
    const res = await request.put(`/api/workflows/${sharedFlowId}`, {
      data: { name: 'e2e-uc-wf-05-renamed' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.flow?.name).toBe('e2e-uc-wf-05-renamed')
  })

  test('UC-WF-06: delete workflow', async ({ request }) => {
    const created = await request.post('/api/workflows', {
      data: { name: 'e2e-uc-wf-06-delete' },
    })
    const id = (await created.json()).data.flow.id

    const res = await request.delete(`/api/workflows/${id}`)
    expect(res.status()).toBe(200)
    expect((await res.json()).data?.deleted).toBe(true)

    // a follow-up GET must 404 — the row is really gone
    const gone = await request.get(`/api/workflows/${id}`)
    expect(gone.status()).toBe(404)
  })

  // ---- remaining UCs: not yet coverable at the HTTP/browser layer ----

  test.fixme('UC-WF-01: execute workflow (SSE streaming)', async ({ request }) => {
    // Gap: POST /api/workflows/:id/run exists, but a green SSE run needs an
    // executable flow (real nodes) + a configured LLM provider; the empty flows
    // provisioned in this suite won't produce a token stream.
    const res = await request.post(`/api/workflows/${sharedFlowId}/run`, {
      headers: { accept: 'text/event-stream' },
      data: { input: 'hello' },
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/event-stream')
  })

  test.fixme('UC-WF-07: view execution history', async ({ request }) => {
    // Gap: GET /api/workflows/:id/executions is not implemented — only
    // /api/workflows/runs/:runId/node-spans (per-run node trace) exists today.
    const res = await request.get(`/api/workflows/${sharedFlowId}/executions`)
    expect(res.status()).toBe(200)
    expect(Array.isArray((await res.json()).data?.items)).toBe(true)
  })

  test.fixme('UC-WF-08: support 14 node types', () => {
    // Engine-internal — covered by packages/workflow/src/nodes/*.node.test.ts
    // (14 node suites). Kept as a placeholder so the UC count matches the gap analysis.
  })

  test.fixme('UC-WF-09: DAG topological execution', () => {
    // Engine-internal — covered by packages/workflow/src/__tests__/executor.test.ts.
  })

  test.fixme('UC-WF-10: branch handling (Condition / ConditionAgent)', () => {
    // Engine-internal — covered by condition / condition-agent node tests.
  })

  test.fixme('UC-WF-11: loop handling (Iteration / Loop)', () => {
    // Engine-internal — covered by iteration / loop node tests.
  })

  test.fixme('UC-WF-12: stream token / tool call / thinking', async ({ request }) => {
    // Gap: same executable-flow + LLM setup as UC-WF-01; asserts the SSE event
    // types (token / tool_call / thinking) once a real run is wired here.
    const res = await request.post(`/api/workflows/${sharedFlowId}/run`, {
      headers: { accept: 'text/event-stream' },
      data: { input: 'stream test' },
    })
    expect(res.headers()['content-type']).toContain('text/event-stream')
  })
})
