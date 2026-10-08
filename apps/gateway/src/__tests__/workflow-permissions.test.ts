/**
 * R4 路由门单测（docs/zcode-borrow/design-permission.md §3.3 / §6.2）：
 * 保存门（POST/PUT 422）/ 运行门（invalid 422、enforce 400、warn 放行 +
 * 计数）/ 有声明 run 的 workflow.run 审计行。草稿自由不扩大拒绝面
 * （带环 flow 照常 200）。
 *
 * app.request() 形态（dev Postgres → globalSetup 钉 dagents_gw_test）。
 * 网络零依赖：断言权限面的 http 节点全部放在「孤儿分支」（executor 不执行
 * 无边节点），run 主体是 start → directReply 即时完成。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { renderMetrics } from '../lib/metrics.js'
import { app } from '../app.js'

const PG_URL =
  process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

const seededFlows: string[] = []
const seededRuns: string[] = []
const seededAuditActions: string[] = []

function makeFlow(opts: {
  extraNodes?: Array<Record<string, unknown>>
  edges?: Array<Record<string, unknown>>
}): Record<string, unknown> {
  return {
    nodes: [
      {
        id: 'start',
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: { name: 'startAgentflow', label: 'Start' },
      },
      {
        id: 'reply',
        type: 'customNode',
        position: { x: 300, y: 0 },
        data: { name: 'directReplyAgentflow', label: 'Reply', directReplyMessage: 'done' },
      },
      // 权限面节点放孤儿分支（无边）——投影/preflight 看得见、executor 不执行
      ...(opts.extraNodes ?? []),
    ],
    edges: [{ id: 'e1', source: 'start', target: 'reply' }, ...(opts.edges ?? [])],
  }
}

async function seedFlow(flowData: unknown, name: string): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO flows (id, name, description, flow_data, status) VALUES ($1, $2, '', $3::jsonb, 'draft')`,
    [id, name, JSON.stringify(flowData)],
  )
  seededFlows.push(id)
  return id
}

describe('workflow 路由权限门（R4）', () => {
  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    if (seededRuns.length) {
      await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [seededRuns])
      await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [seededRuns])
    }
    if (seededFlows.length)
      await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [seededFlows])
    if (seededAuditActions.length)
      await runQuery(`DELETE FROM audit_log WHERE action = ANY($1::text[])`, [seededAuditActions])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('PUT 保存门：非法声明（域名带 port）→ 422 + located errors', async () => {
    const id = await seedFlow(makeFlow({}), 'r4-put-invalid')
    const res = await app.request(`/api/v1/workflows/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowData: makeFlow({
          extraNodes: [
            {
              id: 'h1',
              type: 'customNode',
              position: { x: 0, y: 200 },
              data: {
                name: 'httpAgentflow',
                label: 'H',
                url: 'https://api.test/x',
                allowedDomains: ['api.test:8080'],
              },
            },
          ],
        }),
      }),
    })
    expect(res.status).toBe(422)
    // fail() 把 extra 顶层展开（lib/http.ts）——errors 在信封顶层
    const json = (await res.json()) as { error?: string; errors?: Array<{ node?: string }> }
    expect(json.error).toContain('权限声明非法')
    expect(json.errors?.[0]?.node).toBe('h1')
  })

  it('POST 保存门：非法命令白名单 → 422', async () => {
    const res = await app.request('/api/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'r4-post-invalid',
        flowData: makeFlow({
          extraNodes: [
            {
              id: 'c1',
              type: 'customNode',
              position: { x: 0, y: 200 },
              data: {
                name: 'customFunctionAgentflow',
                label: 'C',
                functionCode: 'return 1',
                allowedCommands: 42,
              },
            },
          ],
        }),
      }),
    })
    expect(res.status).toBe(422)
  })

  it('PUT 合法声明 + 带环 flow → 照常 200（草稿自由不扩大拒绝面）', async () => {
    const id = await seedFlow(makeFlow({}), 'r4-put-ok')
    const flow = makeFlow({
      extraNodes: [
        {
          id: 'h1',
          type: 'customNode',
          position: { x: 0, y: 200 },
          data: {
            name: 'httpAgentflow',
            label: 'H',
            url: 'https://api.test/x',
            allowedDomains: ['api.test'],
          },
        },
      ],
      edges: [
        // 环：拓扑校验会拒，但保存门只管权限声明——环是运行门的事
        { id: 'e2', source: 'reply', target: 'reply' },
      ],
    })
    const res = await app.request(`/api/v1/workflows/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowData: flow }),
    })
    expect(res.status).toBe(200)
  })

  it('运行门：invalid 声明 → 422（提前失败，不进执行）', async () => {
    const id = await seedFlow(
      makeFlow({
        extraNodes: [
          {
            id: 'h1',
            type: 'customNode',
            position: { x: 0, y: 200 },
            data: {
              name: 'httpAgentflow',
              label: 'H',
              url: 'https://api.test/x',
              allowedDomains: 'oops',
            },
          },
        ],
      }),
      'r4-run-invalid',
    )
    const res = await app.request(`/api/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    expect(res.status).toBe(422)
  })

  it('运行门：enforce + 未声明 http → 400（错误列节点 id 与指引）', async () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'enforce'
    try {
      const id = await seedFlow(
        makeFlow({
          extraNodes: [
            {
              id: 'h9',
              type: 'customNode',
              position: { x: 0, y: 200 },
              data: { name: 'httpAgentflow', label: 'H', url: 'https://plain.test/x' },
            },
          ],
        }),
        'r4-run-enforce',
      )
      const res = await app.request(`/api/v1/workflows/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'go' }),
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: string; nodes?: string[] }
      expect(json.error).toContain('未声明 allowedDomains')
      expect(json.nodes).toContain('h9')
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      else process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })

  it('运行门：warn（显式逃生门）+ 未声明 → 放行且 undeclared 指标递增（OQ-4 终裁后默认已是 enforce）', async () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'warn'
    try {
      const before = renderMetrics()
      const id = await seedFlow(
        makeFlow({
          extraNodes: [
            {
              id: 'h8',
              type: 'customNode',
              position: { x: 0, y: 200 },
              data: { name: 'httpAgentflow', label: 'H', url: 'https://plain.test/x' },
            },
          ],
        }),
        'r4-run-warn',
      )
      // async=1：preflight（warn 放行 + 指标）后立即返回；孤儿 http 节点的
      // fetch 失败发生在后台，不进本次响应（沙箱无网也确定性）
      const clientRunId = randomUUID()
      seededRuns.push(clientRunId)
      const res = await app.request(`/api/v1/workflows/${id}/run?async=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-run-id': clientRunId },
        body: JSON.stringify({ input: 'go' }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { success?: boolean; data?: { runId?: string } }
      expect(json.success).toBe(true)
      const after = renderMetrics()
      const count = (text: string): number => {
        const m = /dagents_permission_undeclared_http_runs_total (\d+)/.exec(text)
        return m ? Number(m[1]) : 0
      }
      expect(count(after)).toBeGreaterThan(count(before))
    } finally {
      if (prev !== undefined) process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })

  it('有声明 run → workflow.run 审计行（detail 带权限摘要）', async () => {
    const id = await seedFlow(
      makeFlow({
        extraNodes: [
          {
            id: 'c7',
            type: 'customNode',
            position: { x: 0, y: 200 },
            data: {
              name: 'customFunctionAgentflow',
              label: 'C',
              functionCode: 'return 1',
              allowedCommands: ['git'],
            },
          },
        ],
      }),
      'r4-run-audit',
    )
    seededAuditActions.push('workflow.run')
    const res = await app.request(`/api/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    expect(res.status).toBe(200)
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM audit_log WHERE action = 'workflow.run' AND target_id = $1::text LIMIT 1`,
      [id],
    )
    expect(records).toHaveLength(1)
  })

  it('GET /metrics 路由文本含两个 R4 指标（含 HELP 头——未触发也注册）', async () => {
    // §6.2-⑥ 的字面口径：路由层而非 renderMetrics() 单测——钉「指标真的
    // 挂到了对外暴露面」。declareCounter 在 metrics.ts 模块作用域注册，
    // app import 链即声明（未触发时 renderMetric 也输出 HELP/TYPE 头）。
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    // HELP 头在零触发时也输出（renderMetric 对已注册 counter 恒写头）——
    // 钉的是「指标挂到了对外暴露面」；值行只有触发后出现，本文件的前序
    // warn 用例已在同进程 inc 过 undeclared 计数，顺带断言其值行存在。
    expect(text).toContain('# HELP dagents_custom_exec_total')
    expect(text).toContain('# TYPE dagents_custom_exec_total counter')
    expect(text).toContain('# HELP dagents_permission_undeclared_http_runs_total')
    expect(text).toMatch(/dagents_permission_undeclared_http_runs_total [1-9]/)
  })
})
