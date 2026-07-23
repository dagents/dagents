import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'
import { mapFlowiseToDesignShape, type DesignNode, type DesignEdge } from '../flowise-shape.js'

/**
 * v0.3-M9.2 — gateway chatflows 代理返回 flows-data DAG 形状 (14 节点类型映射).
 *
 * Two layers of coverage:
 *
 * 1. **Pure mapper** (`mapFlowiseToDesignShape`): Flowise 原生 flowData (React
 *    Flow `{ nodes, edges }`) + chatflow row + executions → design DAG shape
 *    `{ id, name, nodes:[{id,type}], edges, runs }`. The 14 agentflow node
 *    `data.name` values (`startAgentflow` … `retrieverAgentflow`) all map to
 *    their design `type` (`Start` … `Retriever`); an unrecognized node falls
 *    back to its raw `data.name` so nothing is silently dropped.
 *
 * 2. **Route integration** (`GET /api/v1/flows/:id`): the gateway fetches the
 *    chatflow row + recent executions from Flowise (stubbed here), runs the
 *    mapper, and returns `{ success: true, data: { id, name, nodes, edges,
 *    runs } }`. A Flowise fetch failure collapses to a sanitized 502; a missing
 *    key is a 503.
 */

let stubServer: Server
let stubUrl = ''
type StubHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => void
let stubHandler: StubHandler = defaultFlowiseHandler

// Every agentflow node `data.name` Flowise emits, paired with the design
// `type` it must map to. Source: vendor/flowise/packages/components/nodes/
// agentflow/*/  →  `this.name = '<x>Agentflow'`, `this.type = '<Design>'`.
const NODE_FIXTURES: Array<{ name: string; type: string }> = [
  { name: 'startAgentflow', type: 'Start' },
  { name: 'agentAgentflow', type: 'Agent' },
  { name: 'llmAgentflow', type: 'LLM' },
  { name: 'toolAgentflow', type: 'Tool' },
  { name: 'httpAgentflow', type: 'HTTP' },
  { name: 'conditionAgentflow', type: 'Condition' },
  { name: 'conditionAgentAgentflow', type: 'Condition Agent' },
  { name: 'iterationAgentflow', type: 'Iteration' },
  { name: 'loopAgentflow', type: 'Loop' },
  { name: 'humanInputAgentflow', type: 'Human Input' },
  { name: 'directReplyAgentflow', type: 'Direct Reply' },
  { name: 'customFunctionAgentflow', type: 'Custom Function' },
  { name: 'executeFlowAgentflow', type: 'Execute Flow' },
  { name: 'retrieverAgentflow', type: 'Retriever' },
]

/** A native Flowise `flowData` JSON string covering all 14 node types. */
function nativeFlowDataAllNodes(): string {
  const nodes = NODE_FIXTURES.map((n, i) => ({
    id: `n${i + 1}`,
    // React Flow `type` is the renderer kind (`agentFlow` / `iteration` / …);
    // the agentflow node identity lives in `data.name` (see Canvas.jsx).
    type: n.name === 'iterationAgentflow' ? 'iteration' : 'agentFlow',
    position: { x: 40 + i * 120, y: 120 },
    data: { id: `n${i + 1}`, name: n.name, label: n.type, type: n.type },
    width: 200,
    height: 44,
  }))
  const edges = NODE_FIXTURES.slice(1).map((_, i) => ({
    id: `e${i}`,
    source: `n${i + 1}`,
    sourceHandle: `output-${i + 1}`,
    target: `n${i + 2}`,
    targetHandle: `input-${i + 2}`,
    type: 'agentFlow',
    data: { label: i === 0 ? 'first' : undefined },
  }))
  return JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } })
}

/** One Flowise execution row carrying a per-node trace (INPROGRESS on n1). */
function nativeExecution(id: string, agentflowId: string, state: string): unknown {
  return {
    id,
    agentflowId,
    sessionId: id.replace('exec', 'R-88'),
    state,
    executionData: JSON.stringify([{ nodeId: 'n1', nodeLabel: 'Start', status: 'INPROGRESS' }]),
    createdDate: '2026-07-13T08:00:00.000Z',
    updatedDate: '2026-07-13T09:00:00.000Z',
  }
}

/** Minimal Flowise stub: serves the chatflow row + executions list. */
function defaultFlowiseHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const url = req.url ?? ''
  res.setHeader('content-type', 'application/json')
  const idMatch = url.match(/^\/api\/v1\/chatflows\/([^/?]+)/)
  if (idMatch) {
    res.writeHead(200)
    res.end(
      JSON.stringify({
        id: idMatch[1],
        name: '论文批量复现流水线',
        type: 'AGENTFLOW',
        deployed: true,
        flowData: nativeFlowDataAllNodes(),
        createdDate: '2026-07-01T00:00:00.000Z',
        updatedDate: '2026-07-09T00:00:00.000Z',
      }),
    )
    return
  }
  if (url.startsWith('/api/v1/executions')) {
    // Flowise returns `{ data, total }` when paginated; mirror that.
    res.writeHead(200)
    res.end(
      JSON.stringify({
        data: [
          nativeExecution('exec-1', 'flow_repro_01', 'INPROGRESS'),
          nativeExecution('exec-2', 'flow_repro_01', 'FINISHED'),
        ],
        total: 2,
      }),
    )
    return
  }
  res.writeHead(404)
  res.end(JSON.stringify({ message: 'not found' }))
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.FLOWISE_URL = stubUrl
  process.env.FLOWISE_API_KEY = 'flowise-key-123'
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  delete process.env.FLOWISE_URL
  delete process.env.FLOWISE_API_KEY
})

afterEach(() => {
  stubHandler = defaultFlowiseHandler
})

// ─── 1. Pure mapper ─────────────────────────────────────────────────────────

describe('mapFlowiseToDesignShape (pure)', () => {
  it('maps all 14 agentflow node names to design types', () => {
    const flow = {
      id: 'flow_repro_01',
      name: '论文批量复现流水线',
      type: 'AGENTFLOW' as const,
      flowData: nativeFlowDataAllNodes(),
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    const shape = mapFlowiseToDesignShape(flow, [])
    expect(shape.id).toBe('flow_repro_01')
    expect(shape.name).toBe('论文批量复现流水线')

    // Every node surfaces an `id` + a `type`; all 14 design types present.
    const types = shape.nodes.map((n) => n.type)
    for (const { type } of NODE_FIXTURES) {
      expect(types, `expected node type "${type}"`).toContain(type)
    }
    expect(shape.nodes).toHaveLength(NODE_FIXTURES.length)
    // The required shape carries at least { id, type } per node.
    for (const n of shape.nodes as DesignNode[]) {
      expect(typeof n.id).toBe('string')
      expect(typeof n.type).toBe('string')
    }
  })

  it('maps edges {source,target} → design {from,to} with optional label', () => {
    const flow = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      flowData: nativeFlowDataAllNodes(),
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    const shape = mapFlowiseToDesignShape(flow, [])
    expect(shape.edges).toHaveLength(NODE_FIXTURES.length - 1)
    const first = shape.edges[0] as DesignEdge
    expect(first.from).toBe('n1')
    expect(first.to).toBe('n2')
    expect(first.label).toBe('first')
    // edges past the first have no label
    expect(shape.edges[1]!.label).toBeUndefined()
  })

  it('maps an unrecognized node name through verbatim (no silent drop)', () => {
    const flowData = JSON.stringify({
      nodes: [
        { id: 'x1', type: 'agentFlow', position: { x: 0, y: 0 }, data: { name: 'futureNodeAgentflow', label: 'X' } },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    const flow = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      flowData,
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    const shape = mapFlowiseToDesignShape(flow, [])
    expect(shape.nodes).toHaveLength(1)
    // Unknown name → surfaced verbatim so a new node type is visible, not blanked.
    expect(shape.nodes[0]!.type).toBe('futureNodeAgentflow')
  })

  it('filters StickyNote nodes (decorative, not a design DAG type)', () => {
    // A StickyNote is a canvas annotation Flowise saves as RF `type='stickyNote'`
    // + `data.name='stickyNoteAgentflow'`. It is NOT one of the 14 design
    // node types (`flows-data.js:3-5`), so it must be dropped from the design
    // `nodes[]` — otherwise it surfaces as a verbatim 15th type and pollutes
    // the shape contract this route exists to enforce.
    const flowData = JSON.stringify({
      nodes: [
        { id: 'n1', type: 'agentFlow', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: 'Start' } },
        { id: 'sn', type: 'stickyNote', position: { x: 40, y: 0 }, data: { name: 'stickyNoteAgentflow', label: 'a note' } },
        { id: 'n2', type: 'agentFlow', position: { x: 80, y: 0 }, data: { name: 'agentAgentflow', label: 'Agent' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'agentFlow' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    const flow = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      flowData,
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    const shape = mapFlowiseToDesignShape(flow, [])
    expect(shape.nodes).toHaveLength(2)
    expect(shape.nodes.map((n) => n.id)).not.toContain('sn')
    expect(shape.nodes.map((n) => n.type)).not.toContain('stickyNoteAgentflow')
    expect(shape.nodes.map((n) => n.type)).not.toContain('StickyNote')
  })

  it('degrades an empty/malformed flowData to an empty DAG (no throw)', () => {
    const base = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    expect(mapFlowiseToDesignShape({ ...base, flowData: '' }, []).nodes).toEqual([])
    expect(mapFlowiseToDesignShape({ ...base, flowData: 'not-json{' }, []).edges).toEqual([])
    expect(mapFlowiseToDesignShape({ ...base, flowData: undefined }, []).nodes).toEqual([])
  })

  it('paints per-node run status from the latest execution', () => {
    const flow = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      flowData: nativeFlowDataAllNodes(),
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    // exec-2 is newer (updatedDate 10:00 > exec-1 09:00) → its INPROGRESS on n1 wins.
    const execs = [
      {
        id: 'exec-1',
        agentflowId: 'f1',
        sessionId: 'R-881',
        state: 'FINISHED',
        executionData: JSON.stringify([{ nodeId: 'n1', status: 'FINISHED' }]),
        createdDate: '2026-07-13T08:00:00.000Z',
        updatedDate: '2026-07-13T09:00:00.000Z',
      },
      {
        id: 'exec-2',
        agentflowId: 'f1',
        sessionId: 'R-882',
        state: 'INPROGRESS',
        executionData: JSON.stringify([{ nodeId: 'n1', status: 'INPROGRESS' }]),
        createdDate: '2026-07-13T09:30:00.000Z',
        updatedDate: '2026-07-13T10:00:00.000Z',
      },
    ]
    const shape = mapFlowiseToDesignShape(flow, execs)
    const n1 = shape.nodes.find((n) => n.id === 'n1')!
    expect(n1.status).toBe('running')
    // the flow's overall status mirrors the latest execution's state
    expect(shape.status).toBe('running')
    // runs carry the design run-row fields the detail page renders
    expect(shape.runs.length).toBeGreaterThanOrEqual(1)
    expect(shape.runs[0]!.id).toBe('R-882')
  })

  it('uses idle status when no executions exist', () => {
    const flow = {
      id: 'f1',
      name: 'f',
      type: 'AGENTFLOW' as const,
      flowData: nativeFlowDataAllNodes(),
      createdDate: '2026-07-01T00:00:00.000Z' as const,
      updatedDate: '2026-07-09T00:00:00.000Z' as const,
    }
    const shape = mapFlowiseToDesignShape(flow, [])
    expect(shape.status).toBe('idle')
    expect(shape.runs).toEqual([])
    for (const n of shape.nodes) {
      expect(n.status).toBe('idle')
    }
  })
})

// ─── 2. Route integration ───────────────────────────────────────────────────

describe('GET /api/v1/flows/:id (gateway → design shape)', () => {
  it('returns {id,name,nodes:[{id,type}],edges,runs} from the Flowise proxy', async () => {
    const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { id: string; name: string; nodes: Array<{ id: string; type: string }>; edges: unknown[]; runs: unknown[] } }
    expect(body).toMatchObject({ success: true })
    const data = body.data
    expect(data.id).toBe('flow_repro_01')
    expect(data.name).toBe('论文批量复现流水线')
    expect(Array.isArray(data.nodes)).toBe(true)
    expect(data.nodes.length).toBe(14)
    // the required node shape carries at least { id, type }
    for (const n of data.nodes) {
      expect(typeof n.id).toBe('string')
      expect(typeof n.type).toBe('string')
    }
    expect(Array.isArray(data.edges)).toBe(true)
    expect(data.edges.length).toBe(13)
    expect(Array.isArray(data.runs)).toBe(true)
  })

  it('forwards to /api/v1/chatflows/:id + /api/v1/executions with the gateway key', async () => {
    const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
    expect(res.status).toBe(200)
    // The stub's default handler already returned 200 with the shape, so the
    // upstream dial happened; a missing key would have 503'd before reaching
    // the stub. (Forwarding detail is exhaustively covered by flowise-read.test.)
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe('flow_repro_01')
  })

  it('collapses a Flowise fetch failure to a sanitized 502 (no stack leak)', async () => {
    const saved = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(401)
      res.end(JSON.stringify({ message: 'Unauthorized', stack: 'at /src/…', db: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false })
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(JSON.stringify(body)).not.toContain('stack')
    } finally {
      stubHandler = saved
    }
  })

  it('returns 503 when FLOWISE_API_KEY is unset', async () => {
    const saved = process.env.FLOWISE_API_KEY
    delete process.env.FLOWISE_API_KEY
    try {
      const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'flowise api key not configured' })
    } finally {
      process.env.FLOWISE_API_KEY = saved
    }
  })

  it('returns 400 for a malformed flow id (no path traversal reaches Flowise)', async () => {
    // The id allowlist `[A-Za-z0-9_-]{1,128}` rejects `/` and `.`, so an
    // encoded-traversal id is a 400 — never dialed upstream.
    const res = await app.request('/api/v1/flows/..%2f..', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'invalid flow id' })
    // the rejected id is echoed only after allowlist validation (no `/`/`.`),
    // so no traversal payload reaches the response.
    expect(JSON.stringify(body)).not.toContain('..%2f')
  })

  it('returns 502 "flow shape unrecognized" when upstream returns a non-chatflow row', async () => {
    const saved = stubHandler
    stubHandler = (req, res) => {
      // 200 but the body isn't a chatflow row (no id/name/createdDate).
      res.setHeader('content-type', 'application/json')
      if ((req.url ?? '').startsWith('/api/v1/chatflows/')) {
        res.writeHead(200)
        res.end(JSON.stringify({ unexpected: 'shape' }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify({ data: [], total: 0 }))
    }
    try {
      const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'flow shape unrecognized' })
      // the unrecognized upstream shape is NOT echoed (no field-name leak)
      expect(JSON.stringify(body)).not.toContain('unexpected')
    } finally {
      stubHandler = saved
    }
  })

  it('returns 502 "flow fetch failed" when /chatflows/:id upstream 404s', async () => {
    const saved = stubHandler
    stubHandler = (req, res) => {
      res.setHeader('content-type', 'application/json')
      if ((req.url ?? '').startsWith('/api/v1/chatflows/')) {
        res.writeHead(404)
        res.end(JSON.stringify({ message: 'chatflow not found', stack: 'at /src/…' }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify({ data: [], total: 0 }))
    }
    try {
      const res = await app.request('/api/v1/flows/flow_repro_01', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'flow fetch failed' })
      // upstream 404 body (message/stack) is collapsed, not forwarded
      expect(JSON.stringify(body)).not.toContain('chatflow not found')
      expect(JSON.stringify(body)).not.toContain('stack')
    } finally {
      stubHandler = saved
    }
  })

  it('still serves /api/v1/flows/:id/prediction (the original proxy)', async () => {
    // The new :id route must NOT shadow the prediction wildcard.
    const res = await app.request(
      '/api/v1/flows/d87207fd-7a11-4d42-8580-2f03ca58e79d/prediction',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    // The stub returns 200 for any path under the prediction rewrite; we only
    // assert the route resolved (not 404) so the wildcard still wins for the
    // `:id/prediction` suffix.
    expect(res.status).not.toBe(404)
  })
})
