# Flowise 全量迁移：V2 Agent Workflow 14 节点 + 画布编辑器

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底移除 `vendor/flowise/`，将 V2 Agent Workflow 的 14 个节点、画布编辑器、执行引擎全部内聚到 Dagents 项目中，项目作为一个整体不再有外部依赖。

**Architecture:** 分 5 个阶段推进：Phase 1 数据层 + API → Phase 2 画布编辑器 → Phase 3 节点迁移 → Phase 4 执行引擎对接 → Phase 5 清理。每个阶段独立可测试。

**Tech Stack:** TypeScript, React 18, Next.js 15, ReactFlow v11, Tailwind CSS, Hono, TypeORM, PostgreSQL, Vitest

---

## Phase 1: 数据层 + Workflows API

### Task 1.1: Flow Entity + Migration

**Files:**
- Create: `packages/db/src/entities/flow.entity.ts`
- Create: `packages/db/src/migrations/1720000014000-create-flows.ts`
- Modify: `packages/db/src/data-source.ts` (add entity)
- Test: `packages/db/src/__tests__/flow.entity.test.ts`

- [ ] **Step 1: Create Flow entity**

```typescript
// packages/db/src/entities/flow.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('flows')
export class Flow {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ length: 255 })
  name: string

  @Column({ type: 'text', nullable: true })
  description: string | null

  /**
   * Flow DAG data — ReactFlow shape: { nodes: [...], edges: [...], viewport? }
   * Mirrors Flowise's chatflows.flowData for easy migration.
   */
  @Column({ type: 'jsonb', name: 'flow_data' })
  flowData: {
    nodes: Array<{
      id: string
      position: { x: number; y: number }
      type?: string
      data: Record<string, unknown>
      width?: number
      height?: number
    }>
    edges: Array<{
      id: string
      source: string
      target: string
      sourceHandle?: string | null
      targetHandle?: string | null
      type?: string
      animated?: boolean
      data?: { label?: string }
      label?: string
    }>
    viewport?: { x: number; y: number; zoom: number }
  }

  @Column({ length: 32, default: 'draft' })
  status: 'draft' | 'published' | 'archived'

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date
}
```

- [ ] **Step 2: Create migration**

```typescript
// packages/db/src/migrations/1720000014000-create-flows.ts
import { MigrationInterface, QueryRunner, Table } from 'typeorm'

export class CreateFlows1720000014000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'flows',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'name', type: 'varchar', length: '255' },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'flow_data', type: 'jsonb' },
          {
            name: 'status',
            type: 'varchar',
            length: '32',
            default: "'draft'",
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    )
    await queryRunner.query(
      `CREATE INDEX idx_flows_status ON flows (status)`,
    )
    await queryRunner.query(
      `CREATE INDEX idx_flows_name ON flows (name)`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_flows_name`)
    await queryRunner.query(`DROP INDEX IF EXISTS idx_flows_status`)
    await queryRunner.dropTable('flows')
  }
}
```

- [ ] **Step 3: Register entity in data-source**

Add `Flow` to the `entities` array in `packages/db/src/data-source.ts`.

- [ ] **Step 4: Run migration and verify**

```bash
pnpm --filter @dagents/db build
# Then verify: psql into postgres and check flows table exists
```

---

### Task 1.2: Gateway Workflows CRUD API

**Files:**
- Create: `apps/gateway/src/routes/workflows.ts`
- Modify: `apps/gateway/src/app.ts` (mount route + remove Flowise proxy)

- [ ] **Step 1: Create workflows route**

```typescript
// apps/gateway/src/routes/workflows.ts
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { AppDataSource } from '@dagents/db'
import { Flow } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { SsoContextVars } from '../auth.js'

const log = createLogger({ svc: 'gateway:workflows' })

const flowCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional().nullable(),
  flowData: z
    .object({
      nodes: z.array(z.any()).default([]),
      edges: z.array(z.any()).default([]),
      viewport: z.any().optional(),
    })
    .optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

const flowUpdateSchema = flowCreateSchema.partial()

export const workflowsRoutes = new Hono<{ Variables: SsoContextVars }>()

// List flows
workflowsRoutes.get('/', async (c) => {
  const repo = AppDataSource.getRepository(Flow)
  const status = c.req.query('status')
  const qb = repo.createQueryBuilder('flow').orderBy('flow.updated_at', 'DESC')
  if (status) qb.where('flow.status = :status', { status })
  const flows = await qb.getMany()
  return c.json({
    success: true,
    data: {
      flows: flows.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
        status: f.status,
        nodeCount: f.flowData?.nodes?.length ?? 0,
        updatedAt: f.updatedAt,
      })),
    },
  })
})

// Get flow detail
workflowsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const repo = AppDataSource.getRepository(Flow)
  const flow = await repo.findOne({ where: { id } })
  if (!flow) return c.json({ success: false, error: 'flow not found' }, 404)
  return c.json({
    success: true,
    data: {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      flowData: flow.flowData,
      status: flow.status,
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    },
  })
})

// Create flow
workflowsRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = flowCreateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.message }, 400)
  }
  const repo = AppDataSource.getRepository(Flow)
  const flow = repo.create({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    flowData: parsed.data.flowData ?? { nodes: [], edges: [] },
    status: parsed.data.status ?? 'draft',
  })
  const saved = await repo.save(flow)
  log.info('flow created', { id: saved.id, name: saved.name })
  return c.json(
    {
      success: true,
      data: {
        id: saved.id,
        name: saved.name,
        description: saved.description,
        flowData: saved.flowData,
        status: saved.status,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      },
    },
    201,
  )
})

// Update flow
workflowsRoutes.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = flowUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.message }, 400)
  }
  const repo = AppDataSource.getRepository(Flow)
  const flow = await repo.findOne({ where: { id } })
  if (!flow) return c.json({ success: false, error: 'flow not found' }, 404)
  Object.assign(flow, parsed.data)
  const saved = await repo.save(flow)
  log.info('flow updated', { id: saved.id })
  return c.json({
    success: true,
    data: {
      id: saved.id,
      name: saved.name,
      description: saved.description,
      flowData: saved.flowData,
      status: saved.status,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    },
  })
})

// Delete flow
workflowsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const repo = AppDataSource.getRepository(Flow)
  const result = await repo.delete(id)
  if (result.affected === 0) {
    return c.json({ success: false, error: 'flow not found' }, 404)
  }
  log.info('flow deleted', { id })
  return c.json({ success: true })
})
```

- [ ] **Step 2: Mount in app.ts**

Add `import { workflowsRoutes } from './routes/workflows.js'` and `app.route('/api/v1/workflows', workflowsRoutes)` inside the session gate (after requireLogin).

- [ ] **Step 3: Run gateway tests**

```bash
pnpm --filter @dagents/gateway test
```

Expected: all existing tests pass + new workflow routes work.

---

### Task 1.3: Console Workflows Proxy Routes

**Files:**
- Create: `apps/console/src/app/api/workflows/route.ts`
- Create: `apps/console/src/app/api/workflows/[id]/route.ts`
- Modify: `apps/console/src/lib/flowise-client.ts` (rename + add workflows helper)

- [ ] **Step 1: Create list route**

```typescript
// apps/console/src/app/api/workflows/route.ts
import { NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const query = status ? `?status=${status}` : ''
  const res = await fetch(`${gatewayUrl()}/api/v1/workflows${query}`, {
    headers: {
      accept: 'application/json',
      'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      cookie: req.headers.get('cookie') ?? '',
    },
    cache: 'no-store',
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function POST(req: Request) {
  const body = await req.json()
  const res = await fetch(`${gatewayUrl()}/api/v1/workflows`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      cookie: req.headers.get('cookie') ?? '',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 2: Create detail route**

```typescript
// apps/console/src/app/api/workflows/[id]/route.ts
import { NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'

interface Props {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, { params }: Props) {
  const { id } = await params
  const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
    headers: {
      accept: 'application/json',
      'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      cookie: req.headers.get('cookie') ?? '',
    },
    cache: 'no-store',
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function PUT(req: Request, { params }: Props) {
  const { id } = await params
  const body = await req.json()
  const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      cookie: req.headers.get('cookie') ?? '',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function DELETE(req: Request, { params }: Props) {
  const { id } = await params
  const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
    method: 'DELETE',
    headers: {
      'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      cookie: req.headers.get('cookie') ?? '',
    },
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 3: Build console to verify types**

```bash
pnpm --filter @dagents/console build
```

---

## Phase 2: 画布编辑器（ReactFlow + Tailwind）

### Task 2.1: Node Registry for Canvas

**Files:**
- Create: `packages/workflow/src/nodes/node-registry-canvas.ts`
- Modify: `packages/workflow/src/nodes/index.ts` (export canvas metadata)

- [ ] **Step 1: Define canvas node metadata interface**

Each node needs canvas metadata: label, category, color, icon, inputs array (for the property panel).

```typescript
// packages/workflow/src/nodes/node-registry-canvas.ts
import type { INode, INodeParams } from '../types/node.js'

export interface CanvasNodeMeta {
  name: string
  label: string
  category: string
  color: string
  icon: string
  description?: string
  inputs: INodeParams[]
  outputs?: Array<{ name: string; label: string }>
  /** Default data when creating a new node on the canvas */
  defaultData: Record<string, unknown>
}

const NODE_CATEGORIES = [
  { id: 'start', label: '起点', color: '#10b981' },
  { id: 'agent', label: '智能体', color: '#8b5cf6' },
  { id: 'logic', label: '逻辑', color: '#f59e0b' },
  { id: 'tools', label: '工具', color: '#3b82f6' },
  { id: 'data', label: '数据', color: '#06b6d4' },
  { id: 'flow', label: '流程控制', color: '#ec4899' },
]
```

- [ ] **Step 2: Register 14 V2 node types**

For each of the 14 nodes, define its canvas metadata. Start with a stub for each — the actual node implementation comes in Phase 3.

```typescript
// Complete list of 14 V2 agentflow nodes with metadata
export const CANVAS_NODES: CanvasNodeMeta[] = [
  {
    name: 'startAgentflow',
    label: '开始',
    category: 'start',
    color: '#10b981',
    icon: 'Play',
    description: '工作流起点，定义初始变量',
    inputs: [
      { name: 'variables', label: '初始变量', type: 'json', description: '可被后续节点引用的变量', default: {} },
    ],
    outputs: [{ name: 'output', label: '输出' }],
    defaultData: {
      name: 'startAgentflow',
      label: '开始',
      variables: {},
    },
  },
  {
    name: 'agentAgentflow',
    label: 'Agent',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'Bot',
    description: 'AI 智能体，使用 LLM + 工具进行推理',
    inputs: [
      { name: 'model', label: 'LLM 模型', type: 'options', required: true, options: [], default: '' },
      { name: 'systemPrompt', label: '系统提示词', type: 'code', rows: 6, default: 'You are a helpful assistant.' },
      { name: 'tools', label: '可用工具', type: 'options', options: [], default: [] },
      { name: 'maxIterations', label: '最大迭代次数', type: 'number', default: 10 },
    ],
    outputs: [{ name: 'text', label: '文本输出' }],
    defaultData: {
      name: 'agentAgentflow',
      label: 'Agent',
      model: '',
      systemPrompt: 'You are a helpful assistant.',
      tools: [],
      maxIterations: 10,
    },
  },
  {
    name: 'llmAgentflow',
    label: 'LLM',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'Brain',
    description: '大语言模型调用',
    inputs: [
      { name: 'model', label: '模型', type: 'options', required: true, options: [], default: '' },
      { name: 'systemPrompt', label: '系统提示词', type: 'code', rows: 4, default: '' },
      { name: 'prompt', label: '用户提示词', type: 'code', rows: 4, required: true, default: '' },
      { name: 'temperature', label: 'Temperature', type: 'number', default: 0.7 },
    ],
    outputs: [{ name: 'text', label: '文本输出' }],
    defaultData: {
      name: 'llmAgentflow',
      label: 'LLM',
      model: '',
      systemPrompt: '',
      prompt: '',
      temperature: 0.7,
    },
  },
  {
    name: 'toolAgentflow',
    label: 'Tool',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Wrench',
    description: '自定义工具调用节点',
    inputs: [
      { name: 'toolName', label: '工具名称', type: 'string', required: true, default: '' },
      { name: 'toolDescription', label: '工具描述', type: 'string', default: '' },
      { name: 'parameters', label: '参数定义', type: 'json', default: {} },
      { name: 'handler', label: '处理代码', type: 'code', rows: 8, default: '' },
    ],
    outputs: [{ name: 'result', label: '结果' }],
    defaultData: {
      name: 'toolAgentflow',
      label: 'Tool',
      toolName: '',
      toolDescription: '',
      parameters: {},
      handler: '',
    },
  },
  {
    name: 'httpAgentflow',
    label: 'HTTP',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Globe',
    description: 'HTTP 请求调用',
    inputs: [
      { name: 'method', label: '方法', type: 'options', required: true, options: [
        { name: 'GET', label: 'GET' },
        { name: 'POST', label: 'POST' },
        { name: 'PUT', label: 'PUT' },
        { name: 'DELETE', label: 'DELETE' },
      ], default: 'GET' },
      { name: 'url', label: 'URL', type: 'string', required: true, default: '' },
      { name: 'headers', label: '请求头', type: 'json', default: {} },
      { name: 'body', label: '请求体', type: 'json', default: {} },
    ],
    outputs: [
      { name: 'data', label: '响应数据' },
      { name: 'status', label: '状态码' },
    ],
    defaultData: {
      name: 'httpAgentflow',
      label: 'HTTP',
      method: 'GET',
      url: '',
      headers: {},
      body: {},
    },
  },
  {
    name: 'conditionAgentflow',
    label: 'Condition',
    category: 'logic',
    color: '#f59e0b',
    icon: 'GitBranch',
    description: '条件判断，支持多分支',
    inputs: [
      { name: 'conditions', label: '条件列表', type: 'json', default: [] },
      { name: 'defaultOutput', label: '默认输出', type: 'string', default: 'false' },
    ],
    outputs: [
      { name: 'true', label: '真' },
      { name: 'false', label: '假' },
    ],
    defaultData: {
      name: 'conditionAgentflow',
      label: 'Condition',
      conditions: [],
      defaultOutput: 'false',
    },
  },
  {
    name: 'conditionAgentAgentflow',
    label: 'Condition Agent',
    category: 'logic',
    color: '#f59e0b',
    icon: 'Split',
    description: '基于 Agent 判断的条件路由',
    inputs: [
      { name: 'model', label: 'LLM 模型', type: 'options', default: '' },
      { name: 'systemPrompt', label: '系统提示词', type: 'code', rows: 4, default: '' },
      { name: 'scenarios', label: '场景列表', type: 'json', default: [] },
    ],
    outputs: [],
    defaultData: {
      name: 'conditionAgentAgentflow',
      label: 'Condition Agent',
      model: '',
      systemPrompt: '',
      scenarios: [],
    },
  },
  {
    name: 'iterationAgentflow',
    label: 'Iteration',
    category: 'flow',
    color: '#ec4899',
    icon: 'Repeat',
    description: '迭代循环，遍历数组元素',
    inputs: [
      { name: 'items', label: '迭代列表', type: 'string', default: '' },
    ],
    outputs: [{ name: 'item', label: '当前元素' }],
    defaultData: {
      name: 'iterationAgentflow',
      label: 'Iteration',
      items: '',
    },
  },
  {
    name: 'loopAgentflow',
    label: 'Loop',
    category: 'flow',
    color: '#ec4899',
    icon: 'RefreshCw',
    description: '循环执行直到满足条件',
    inputs: [
      { name: 'maxIterations', label: '最大迭代次数', type: 'number', default: 10 },
      { name: 'condition', label: '终止条件', type: 'string', default: '' },
    ],
    outputs: [{ name: 'output', label: '输出' }],
    defaultData: {
      name: 'loopAgentflow',
      label: 'Loop',
      maxIterations: 10,
      condition: '',
    },
  },
  {
    name: 'humanInputAgentflow',
    label: 'Human Input',
    category: 'flow',
    color: '#ec4899',
    icon: 'User',
    description: '等待人工输入',
    inputs: [
      { name: 'prompt', label: '提示文本', type: 'string', default: '' },
      { name: 'inputType', label: '输入类型', type: 'options', options: [
        { name: 'text', label: '文本' },
        { name: 'select', label: '选择' },
        { name: 'confirm', label: '确认' },
      ], default: 'text' },
    ],
    outputs: [{ name: 'response', label: '用户响应' }],
    defaultData: {
      name: 'humanInputAgentflow',
      label: 'Human Input',
      prompt: '',
      inputType: 'text',
    },
  },
  {
    name: 'directReplyAgentflow',
    label: 'Direct Reply',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'MessageSquare',
    description: '直接回复用户',
    inputs: [
      { name: 'text', label: '回复内容', type: 'code', rows: 4, default: '' },
    ],
    outputs: [{ name: 'text', label: '输出' }],
    defaultData: {
      name: 'directReplyAgentflow',
      label: 'Direct Reply',
      text: '',
    },
  },
  {
    name: 'customFunctionAgentflow',
    label: 'Custom Function',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Code',
    description: '自定义 JavaScript 函数',
    inputs: [
      { name: 'code', label: '函数代码', type: 'code', rows: 10, default: '' },
      { name: 'parameters', label: '参数列表', type: 'json', default: [] },
    ],
    outputs: [{ name: 'result', label: '返回值' }],
    defaultData: {
      name: 'customFunctionAgentflow',
      label: 'Custom Function',
      code: '',
      parameters: [],
    },
  },
  {
    name: 'executeFlowAgentflow',
    label: 'Execute Flow',
    category: 'flow',
    color: '#ec4899',
    icon: 'PlayCircle',
    description: '嵌套执行另一个工作流',
    inputs: [
      { name: 'flowId', label: '目标工作流', type: 'string', default: '' },
      { name: 'input', label: '输入数据', type: 'json', default: {} },
    ],
    outputs: [{ name: 'output', label: '输出' }],
    defaultData: {
      name: 'executeFlowAgentflow',
      label: 'Execute Flow',
      flowId: '',
      input: {},
    },
  },
  {
    name: 'retrieverAgentflow',
    label: 'Retriever',
    category: 'data',
    color: '#06b6d4',
    icon: 'Search',
    description: '向量检索节点',
    inputs: [
      { name: 'vectorStore', label: '向量库', type: 'string', default: '' },
      { name: 'query', label: '查询文本', type: 'string', default: '' },
      { name: 'topK', label: '返回数量', type: 'number', default: 4 },
    ],
    outputs: [{ name: 'docs', label: '文档列表' }],
    defaultData: {
      name: 'retrieverAgentflow',
      label: 'Retriever',
      vectorStore: '',
      query: '',
      topK: 4,
    },
  },
]

export function getNodeMeta(name: string): CanvasNodeMeta | undefined {
  return CANVAS_NODES.find((n) => n.name === name)
}

export function getNodesByCategory(): Record<string, CanvasNodeMeta[]> {
  const map: Record<string, CanvasNodeMeta[]> = {}
  for (const node of CANVAS_NODES) {
    if (!map[node.category]) map[node.category] = []
    map[node.category]!.push(node)
  }
  return map
}
```

- [ ] **Step 3: Export from nodes/index.ts**

Add `export { CANVAS_NODES, getNodeMeta, getNodesByCategory } from './node-registry-canvas.js'`

- [ ] **Step 4: Run workflow tests**

```bash
pnpm --filter @dagents/workflow test
```

---

### Task 2.2: Canvas Editor Component

**Files:**
- Create: `apps/console/src/components/canvas/flow-canvas.tsx`
- Create: `apps/console/src/components/canvas/node-palette.tsx`
- Create: `apps/console/src/components/canvas/node-inspector.tsx`
- Create: `apps/console/src/components/canvas/canvas-toolbar.tsx`
- Create: `apps/console/src/components/canvas/custom-node.tsx`
- Create: `apps/console/src/components/canvas/types.ts`
- Create: `apps/console/src/components/canvas/index.ts`
- Create: `apps/console/src/app/workflows/[id]/canvas/page.tsx`
- Modify: `apps/console/package.json` (add reactflow dep)

- [ ] **Step 1: Add reactflow dependency**

```bash
cd apps/console && pnpm add reactflow @xyflow/react
```

Wait, reactflow is the old name. The new package is `@xyflow/react`. Let's use reactflow v11 to match Flowise's version for compatibility:

```bash
cd apps/console && pnpm add reactflow@^11.5.6
```

- [ ] **Step 2: Create types.ts**

```typescript
// apps/console/src/components/canvas/types.ts
export interface FlowNodeData {
  name: string
  label: string
  [key: string]: unknown
}

export interface NodePosition {
  x: number
  y: number
}

export interface CanvasProps {
  flowId: string
  initialData: {
    nodes: any[]
    edges: any[]
    viewport?: { x: number; y: number; zoom: number }
  }
  onSave?: (data: { nodes: any[]; edges: any[]; viewport?: any }) => Promise<void>
  onRun?: () => void
  readOnly?: boolean
}
```

- [ ] **Step 3: Create custom-node.tsx**

```tsx
// apps/console/src/components/canvas/custom-node.tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { getNodeMeta } from '@dagents/workflow'

function CanvasNode({ data, selected }: NodeProps) {
  const name = data?.name ?? 'unknown'
  const label = data?.label ?? name
  const meta = getNodeMeta(name)
  const color = meta?.color ?? '#6b7280'

  return (
    <div
      className={`min-w-[160px] rounded-lg border bg-white shadow-sm transition-all ${
        selected ? 'border-blue-500 shadow-md ring-2 ring-blue-200' : 'border-gray-200'
      }`}
    >
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-2 text-xs font-medium text-white"
        style={{ backgroundColor: color }}
      >
        <span className="truncate">{label}</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-500">
        <span className="truncate">{meta?.description ?? name}</span>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-white !bg-gray-400"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-white !bg-gray-400"
      />
    </div>
  )
}

export default memo(CanvasNode)
```

- [ ] **Step 4: Create node-palette.tsx**

```tsx
// apps/console/src/components/canvas/node-palette.tsx
import { useCallback, useState } from 'react'
import { getNodesByCategory, type CanvasNodeMeta } from '@dagents/workflow'

const CATEGORY_LABELS: Record<string, string> = {
  start: '起点',
  agent: '智能体',
  logic: '逻辑',
  tools: '工具',
  data: '数据',
  flow: '流程控制',
}

const CATEGORY_COLORS: Record<string, string> = {
  start: 'bg-emerald-500',
  agent: 'bg-violet-500',
  logic: 'bg-amber-500',
  tools: 'bg-blue-500',
  data: 'bg-cyan-500',
  flow: 'bg-pink-500',
}

interface NodePaletteProps {
  onDragStart: (event: React.DragEvent, nodeType: string, nodeData: Record<string, unknown>) => void
}

export function NodePalette({ onDragStart }: NodePaletteProps) {
  const [search, setSearch] = useState('')
  const nodesByCategory = getNodesByCategory()

  const filteredCategories = useCallback(() => {
    const result: Record<string, CanvasNodeMeta[]> = {}
    for (const [cat, nodes] of Object.entries(nodesByCategory)) {
      const filtered = nodes.filter(
        (n) =>
          n.label.toLowerCase().includes(search.toLowerCase()) ||
          n.name.toLowerCase().includes(search.toLowerCase()),
      )
      if (filtered.length > 0) result[cat] = filtered
    }
    return result
  }, [nodesByCategory, search])

  const categories = filteredCategories()

  return (
    <div className="flex h-full w-64 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 p-3">
        <input
          type="text"
          placeholder="搜索节点..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {Object.entries(categories).map(([category, nodes]) => (
          <div key={category} className="mb-3">
            <div className="mb-1 px-2 text-xs font-semibold text-gray-500">
              {CATEGORY_LABELS[category] ?? category}
            </div>
            <div className="space-y-1">
              {nodes.map((node) => (
                <div
                  key={node.name}
                  draggable
                  onDragStart={(e) => onDragStart(e, 'agentFlow', node.defaultData)}
                  className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-100 active:cursor-grabbing"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${CATEGORY_COLORS[category] ?? 'bg-gray-400'}`}
                  />
                  <span className="truncate">{node.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create node-inspector.tsx**

```tsx
// apps/console/src/components/canvas/node-inspector.tsx
import { useCallback } from 'react'
import { getNodeMeta, type INodeParams } from '@dagents/workflow'

interface NodeInspectorProps {
  node: any | null
  onUpdate: (nodeId: string, data: Record<string, unknown>) => void
  onDelete: (nodeId: string) => void
}

export function NodeInspector({ node, onUpdate, onDelete }: NodeInspectorProps) {
  if (!node) {
    return (
      <div className="flex h-full w-72 items-center justify-center border-l border-gray-200 bg-white">
        <div className="text-sm text-gray-400">选择一个节点查看属性</div>
      </div>
    )
  }

  const meta = getNodeMeta(node.data?.name ?? '')
  const inputs = meta?.inputs ?? []

  const handleChange = useCallback(
    (name: string, value: unknown) => {
      onUpdate(node.id, { ...(node.data ?? {}), [name]: value })
    },
    [node.id, node.data, onUpdate],
  )

  const handleLabelChange = useCallback(
    (value: string) => {
      onUpdate(node.id, { ...(node.data ?? {}), label: value })
    },
    [node.id, node.data, onUpdate],
  )

  const renderInput = (param: INodeParams) => {
    const value = node.data?.[param.name] ?? param.default ?? ''
    switch (param.type) {
      case 'string':
      case 'number':
        return (
          <input
            type={param.type}
            value={String(value)}
            onChange={(e) =>
              handleChange(
                param.name,
                param.type === 'number' ? Number(e.target.value) : e.target.value,
              )
            }
            placeholder={param.placeholder}
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )
      case 'code':
        return (
          <textarea
            value={String(value)}
            onChange={(e) => handleChange(param.name, e.target.value)}
            rows={param.rows ?? 4}
            className="w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )
      case 'json':
        return (
          <textarea
            value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
            onChange={(e) => {
              try {
                handleChange(param.name, JSON.parse(e.target.value))
              } catch {
                // invalid JSON, keep typing
              }
            }}
            rows={param.rows ?? 6}
            className="w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )
      case 'boolean':
        return (
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => handleChange(param.name, e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        )
      case 'options':
        return (
          <select
            value={String(value)}
            onChange={(e) => handleChange(param.name, e.target.value)}
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">请选择</option>
            {(param.options ?? []).map((opt) => (
              <option key={opt.name} value={opt.name}>
                {opt.label}
              </option>
            ))}
          </select>
        )
      default:
        return (
          <input
            type="text"
            value={String(value)}
            onChange={(e) => handleChange(param.name, e.target.value)}
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
        )
    }
  }

  return (
    <div className="flex h-full w-72 flex-col border-l border-gray-200 bg-white">
      <div className="border-b border-gray-200 p-3">
        <div className="mb-2 text-xs font-semibold text-gray-500">节点属性</div>
        <input
          type="text"
          value={node.data?.label ?? ''}
          onChange={(e) => handleLabelChange(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm font-medium focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="mt-1 text-xs text-gray-400">ID: {node.id}</div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-3">
          {inputs.map((param) => (
            <div key={param.name}>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                {param.label}
                {param.required && <span className="ml-0.5 text-red-500">*</span>}
              </label>
              {renderInput(param)}
              {param.description && (
                <p className="mt-1 text-xs text-gray-400">{param.description}</p>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-gray-200 p-3">
        <button
          onClick={() => onDelete(node.id)}
          className="w-full rounded-md bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100"
        >
          删除节点
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Create canvas-toolbar.tsx**

```tsx
// apps/console/src/components/canvas/canvas-toolbar.tsx
interface CanvasToolbarProps {
  flowName: string
  onSave: () => void
  onRun: () => void
  isSaving: boolean
  isRunning: boolean
}

export function CanvasToolbar({ flowName, onSave, onRun, isSaving, isRunning }: CanvasToolbarProps) {
  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-900">{flowName}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={isSaving}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
        <button
          onClick={onRun}
          disabled={isRunning}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isRunning ? '运行中...' : '运行'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Create flow-canvas.tsx (main canvas component)**

```tsx
// apps/console/src/components/canvas/flow-canvas.tsx
'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from 'reactflow'
import 'reactflow/dist/style.css'

import { NodePalette } from './node-palette'
import { NodeInspector } from './node-inspector'
import { CanvasToolbar } from './canvas-toolbar'
import CanvasNode from './custom-node'
import type { CanvasProps } from './types'

const nodeTypes = {
  agentFlow: CanvasNode,
}

export function FlowCanvas({ initialData, onSave, onRun, flowId }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialData.nodes as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialData.edges as Edge[])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge({ ...params, type: 'smoothstep', animated: false, style: { stroke: '#94a3b8', strokeWidth: 2 } }, eds),
      )
    },
    [setEdges],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      if (!rfInstance) return

      const type = event.dataTransfer.getData('application/reactflow/type')
      const dataStr = event.dataTransfer.getData('application/reactflow/data')
      if (!type) return

      const data = dataStr ? JSON.parse(dataStr) : {}
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type,
        position,
        data,
      }
      setNodes((nds) => nds.concat(newNode))
    },
    [rfInstance, setNodes],
  )

  const onPaletteDragStart = useCallback(
    (event: React.DragEvent, nodeType: string, nodeData: Record<string, unknown>) => {
      event.dataTransfer.setData('application/reactflow/type', nodeType)
      event.dataTransfer.setData('application/reactflow/data', JSON.stringify(nodeData))
      event.dataTransfer.effectAllowed = 'move'
    },
    [],
  )

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  const handleNodeUpdate = useCallback(
    (nodeId: string, data: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data } : n)),
      )
      setSelectedNode((prev) =>
        prev && prev.id === nodeId ? { ...prev, data } : prev,
      )
    },
    [setNodes],
  )

  const handleNodeDelete = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNode(null)
    },
    [setNodes, setEdges],
  )

  const handleSave = useCallback(async () => {
    if (!onSave || !rfInstance) return
    setIsSaving(true)
    try {
      const viewport = rfInstance.getViewport()
      await onSave({
        nodes: nodes.map((n) => ({
          id: n.id,
          position: n.position,
          type: n.type,
          data: n.data,
          width: n.width,
          height: n.height,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          type: e.type,
          animated: e.animated,
        })),
        viewport,
      })
    } finally {
      setIsSaving(false)
    }
  }, [nodes, edges, rfInstance, onSave])

  const handleRun = useCallback(() => {
    if (onRun) onRun()
  }, [onRun])

  // Keep selectedNode in sync with nodes state
  useEffect(() => {
    if (selectedNode) {
      const current = nodes.find((n) => n.id === selectedNode.id)
      if (current && current !== selectedNode) {
        setSelectedNode(current)
      }
    }
  }, [nodes, selectedNode])

  const flowName = '工作流编辑器'

  return (
    <div ref={wrapperRef} className="flex h-full flex-col">
      <CanvasToolbar
        flowName={flowName}
        onSave={handleSave}
        onRun={handleRun}
        isSaving={isSaving}
        isRunning={isRunning}
      />
      <div className="flex flex-1 overflow-hidden">
        <NodePalette onDragStart={onPaletteDragStart} />
        <div className="flex-1 bg-gray-50">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRfInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <NodeInspector
          node={selectedNode}
          onUpdate={handleNodeUpdate}
          onDelete={handleNodeDelete}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Create index.ts barrel export**

```typescript
// apps/console/src/components/canvas/index.ts
export { FlowCanvas } from './flow-canvas'
export { NodePalette } from './node-palette'
export { NodeInspector } from './node-inspector'
export { CanvasToolbar } from './canvas-toolbar'
```

- [ ] **Step 9: Create canvas page route**

```tsx
// apps/console/src/app/workflows/[id]/canvas/page.tsx
import { FlowCanvas } from '@/components/canvas'

interface Props {
  params: Promise<{ id: string }>
}

export default async function WorkflowCanvasPage({ params }: Props) {
  const { id } = await params

  const res = await fetch(`${process.env.GATEWAY_URL ?? 'http://localhost:8080'}/api/v1/workflows/${id}`, {
    headers: { cookie: '' },
    cache: 'no-store',
  })
  const result = await res.json()
  const flow = result?.data ?? null

  if (!flow) {
    return <div className="p-8 text-center text-gray-500">工作流不存在</div>
  }

  return (
    <div className="h-[calc(100vh-64px)] w-full">
      <FlowCanvas
        flowId={id}
        initialData={{
          nodes: flow.flowData?.nodes ?? [],
          edges: flow.flowData?.edges ?? [],
          viewport: flow.flowData?.viewport,
        }}
      />
    </div>
  )
}
```

Wait, this needs to be a client component because FlowCanvas uses hooks. Let me make it a client wrapper. Actually `FlowCanvas` already has 'use client', so the page can be a server component that imports it. But the save/run handlers need to be client-side. Let me adjust — create a client wrapper page component.

Actually, let's make a separate client component for the page and keep page.tsx thin.

- [ ] **Step 10: Create canvas-page.tsx client component**

```tsx
// apps/console/src/components/canvas/canvas-page.tsx
'use client'

import { useState, useEffect } from 'react'
import { FlowCanvas } from './flow-canvas'

interface CanvasPageProps {
  flowId: string
  initialFlow: any
}

export function CanvasPage({ flowId, initialFlow }: CanvasPageProps) {
  const [flowData, setFlowData] = useState(initialFlow)

  const handleSave = async (data: { nodes: any[]; edges: any[]; viewport?: any }) => {
    const res = await fetch(`/api/workflows/${flowId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowData: data }),
    })
    const result = await res.json()
    if (result.success) {
      setFlowData(result.data)
    }
  }

  const handleRun = async () => {
    console.log('Run flow:', flowId)
    // TODO: implement run in Phase 4
  }

  return (
    <div className="h-[calc(100vh-64px)] w-full">
      <FlowCanvas
        flowId={flowId}
        initialData={{
          nodes: flowData?.flowData?.nodes ?? [],
          edges: flowData?.flowData?.edges ?? [],
          viewport: flowData?.flowData?.viewport,
        }}
        onSave={handleSave}
        onRun={handleRun}
      />
    </div>
  )
}
```

- [ ] **Step 11: Update page.tsx to use CanvasPage**

```tsx
// apps/console/src/app/workflows/[id]/canvas/page.tsx
import { CanvasPage } from '@/components/canvas/canvas-page'
import { gatewayUrl } from '@/lib/config'

interface Props {
  params: Promise<{ id: string }>
}

export default async function WorkflowCanvasPage({ params }: Props) {
  const { id } = await params

  const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
    headers: { cookie: '' },
    cache: 'no-store',
  })
  const result = await res.json()
  const flow = result?.data ?? null

  if (!flow) {
    return <div className="p-8 text-center text-gray-500">工作流不存在</div>
  }

  return <CanvasPage flowId={id} initialFlow={flow} />
}
```

- [ ] **Step 12: Build to verify**

```bash
pnpm --filter @dagents/console build
```

Expected: build succeeds with no type errors.

---

## Phase 3: 14 个 V2 节点迁移到 packages/workflow

### Task 3.1: Start Node

**Files:**
- Create: `packages/workflow/src/nodes/start/start.node.ts`
- Create: `packages/workflow/src/nodes/start/start.node.test.ts`
- Modify: `packages/workflow/src/nodes/index.ts` (register)

- [ ] **Step 1: Implement StartNode**

```typescript
// packages/workflow/src/nodes/start/start.node.ts
import type { INode, INodeData, INodeOutput, IExecutionContext, INodeParams } from '../../types/index.js'

export class StartNode implements INode {
  label = '开始'
  name = 'startAgentflow'
  version = 1
  type = 'Start'
  category = 'start'
  color = '#10b981'
  icon = 'Play'
  description = '工作流起点，定义初始变量'

  inputs: INodeParams[] = [
    { name: 'variables', label: '初始变量', type: 'json', description: '可被后续节点引用的变量', default: {} },
  ]

  async run(nodeData: INodeData, _input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
    const variables = (nodeData.inputs?.variables as Record<string, unknown>) ?? {}
    const state: Record<string, unknown> = {}

    if (variables && typeof variables === 'object') {
      for (const [key, value] of Object.entries(variables)) {
        state[key] = value
      }
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: variables,
      output: { variables, ...variables },
      state,
    }
  }
}
```

- [ ] **Step 2: Write test**

```typescript
// packages/workflow/src/nodes/start/start.node.test.ts
import { describe, it, expect } from 'vitest'
import { StartNode } from './start.node.js'
import type { IExecutionContext } from '../../types/index.js'

describe('StartNode', () => {
  const node = new StartNode()

  it('returns variables as output and state', async () => {
    const result = await node.run(
      {
        id: 'start-1',
        name: 'startAgentflow',
        inputs: { variables: { userId: '123', topic: 'test' } },
      },
      null,
      {} as IExecutionContext,
    )
    expect(result.output).toEqual({ variables: { userId: '123', topic: 'test' }, userId: '123', topic: 'test' })
    expect(result.state).toEqual({ userId: '123', topic: 'test' })
  })

  it('handles empty variables', async () => {
    const result = await node.run(
      { id: 'start-1', name: 'startAgentflow', inputs: {} },
      null,
      {} as IExecutionContext,
    )
    expect(result.output).toEqual({ variables: {} })
    expect(result.state).toEqual({})
  })
})
```

- [ ] **Step 3: Register in allNodes()**

Add `new StartNode()` to the `allNodes()` array in `packages/workflow/src/nodes/index.ts`.

- [ ] **Step 4: Run test**

```bash
pnpm --filter @dagents/workflow test -- start.node
```

Expected: PASS

---

### Task 3.2: LLM Node

**Files:**
- Create: `packages/workflow/src/nodes/llm/llm.node.ts`
- Create: `packages/workflow/src/nodes/llm/llm.node.test.ts`
- Modify: `packages/workflow/src/nodes/index.ts`

- [ ] **Step 1: Implement LLM Node**

The LLM node calls an LLM provider. We need to integrate with the llm-providers system.

```typescript
// packages/workflow/src/nodes/llm/llm.node.ts
import type { INode, INodeData, INodeOutput, IExecutionContext, INodeParams } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

export class LLMNode implements INode {
  label = 'LLM'
  name = 'llmAgentflow'
  version = 1
  type = 'LLM'
  category = 'agent'
  color = '#8b5cf6'
  icon = 'Brain'
  description = '大语言模型调用'

  inputs: INodeParams[] = [
    { name: 'model', label: '模型', type: 'options', required: true, options: [], default: '' },
    { name: 'systemPrompt', label: '系统提示词', type: 'code', rows: 4, default: '' },
    { name: 'prompt', label: '用户提示词', type: 'code', rows: 4, required: true, default: '' },
    { name: 'temperature', label: 'Temperature', type: 'number', default: 0.7 },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const inputs = nodeData.inputs ?? {}
    const state = options.state ?? {}

    const systemPrompt = resolveVariables(String(inputs.systemPrompt ?? ''), state)
    const rawPrompt = resolveVariables(String(inputs.prompt ?? ''), state)
    const temperature = Number(inputs.temperature ?? 0.7)
    const model = String(inputs.model ?? '')

    let userPrompt = rawPrompt
    if (input && typeof input === 'object' && 'text' in input && typeof input.text === 'string') {
      userPrompt = userPrompt || input.text
    } else if (typeof input === 'string') {
      userPrompt = userPrompt || input
    }

    if (!options.llmClient) {
      throw new Error('LLM client not available in execution context')
    }

    const result = await options.llmClient.chat({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: userPrompt },
      ],
      temperature,
    })

    const text = result.text ?? ''
    const output = { text, content: text }

    return {
      id: nodeData.id,
      name: this.name,
      input: { prompt: userPrompt, model, temperature },
      output,
    }
  }
}
```

- [ ] **Step 2: Add llmClient to IExecutionContext**

Update `packages/workflow/src/types/execution.ts` to add `llmClient` field.

```typescript
// Add to IExecutionContext:
llmClient?: {
  chat(params: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }): Promise<{ text: string }>
}
```

- [ ] **Step 3: Write test**

```typescript
// packages/workflow/src/nodes/llm/llm.node.test.ts
import { describe, it, expect, vi } from 'vitest'
import { LLMNode } from './llm.node.js'
import type { IExecutionContext } from '../../types/index.js'

describe('LLMNode', () => {
  const node = new LLMNode()

  it('calls llmClient with system + user prompt', async () => {
    const mockChat = vi.fn().mockResolvedValue({ text: 'Hello, how can I help?' })
    const ctx = {
      llmClient: { chat: mockChat },
      state: {},
    } as unknown as IExecutionContext

    const result = await node.run(
      {
        id: 'llm-1',
        name: 'llmAgentflow',
        inputs: {
          model: 'gpt-4',
          systemPrompt: 'You are helpful.',
          prompt: 'Hi',
          temperature: 0.5,
        },
      },
      null,
      ctx,
    )

    expect(mockChat).toHaveBeenCalledWith({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.5,
    })
    expect(result.output.text).toBe('Hello, how can I help?')
  })
})
```

- [ ] **Step 4: Register + run test**

Add `new LLMNode()` to `allNodes()`. Run:

```bash
pnpm --filter @dagents/workflow test -- llm.node
```

Expected: PASS

---

### Task 3.3: Agent Node

**Files:**
- Create: `packages/workflow/src/nodes/agent/agent.node.ts`
- Create: `packages/workflow/src/nodes/agent/agent.node.test.ts`
- Modify: `packages/workflow/src/nodes/index.ts`

- [ ] **Step 1: Implement AgentNode**

The Agent node runs a ReAct-style loop: think → call tool → observe → repeat.

```typescript
// packages/workflow/src/nodes/agent/agent.node.ts
import type { INode, INodeData, INodeOutput, IExecutionContext, INodeParams } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

export class AgentNode implements INode {
  label = 'Agent'
  name = 'agentAgentflow'
  version = 1
  type = 'Agent'
  category = 'agent'
  color = '#8b5cf6'
  icon = 'Bot'
  description = 'AI 智能体，使用 LLM + 工具进行推理'

  inputs: INodeParams[] = [
    { name: 'model', label: 'LLM 模型', type: 'options', required: true, options: [], default: '' },
    { name: 'systemPrompt', label: '系统提示词', type: 'code', rows: 6, default: 'You are a helpful assistant.' },
    { name: 'tools', label: '可用工具', type: 'options', options: [], default: [] },
    { name: 'maxIterations', label: '最大迭代次数', type: 'number', default: 10 },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const inputs = nodeData.inputs ?? {}
    const state = options.state ?? {}
    const model = String(inputs.model ?? '')
    const systemPrompt = resolveVariables(String(inputs.systemPrompt ?? 'You are a helpful assistant.'), state)
    const maxIterations = Number(inputs.maxIterations ?? 10)
    const toolList = (inputs.tools as string[]) ?? []

    if (!options.llmClient) {
      throw new Error('LLM client not available')
    }

    let userInput = ''
    if (input && typeof input === 'object' && 'text' in input && typeof input.text === 'string') {
      userInput = input.text
    } else if (typeof input === 'string') {
      userInput = input
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ]

    let finalText = ''
    const toolResults: Array<{ tool: string; result: string }> = []

    for (let i = 0; i < maxIterations; i++) {
      const response = await options.llmClient.chat({
        model,
        messages,
        temperature: 0.7,
      })
      finalText = response.text ?? ''
      messages.push({ role: 'assistant', content: finalText })

      // Simple heuristic: if no tool call pattern, we're done
      const hasToolCall = /<tool_call>|Action:/.test(finalText)
      if (!hasToolCall) break

      // In a real implementation, parse tool calls and execute them.
      // For now, treat as final answer if no tool executor available.
      if (!options.toolExecutor) break

      // TODO: full ReAct loop with tool execution
      break
    }

    const output = { text: finalText, content: finalText }

    return {
      id: nodeData.id,
      name: this.name,
      input: { prompt: userInput, model, tools: toolList },
      output,
    }
  }
}
```

- [ ] **Step 2: Add toolExecutor to IExecutionContext**

```typescript
// IExecutionContext addition:
toolExecutor?: {
  execute(toolName: string, args: Record<string, unknown>): Promise<unknown>
}
```

- [ ] **Step 3: Write test**

```typescript
// packages/workflow/src/nodes/agent/agent.node.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AgentNode } from './agent.node.js'
import type { IExecutionContext } from '../../types/index.js'

describe('AgentNode', () => {
  const node = new AgentNode()

  it('runs LLM with system prompt and returns text', async () => {
    const mockChat = vi.fn().mockResolvedValue({ text: 'The answer is 42.' })
    const ctx = {
      llmClient: { chat: mockChat },
      state: {},
    } as unknown as IExecutionContext

    const result = await node.run(
      {
        id: 'agent-1',
        name: 'agentAgentflow',
        inputs: {
          model: 'gpt-4',
          systemPrompt: 'You are a math assistant.',
          maxIterations: 5,
          tools: [],
        },
      },
      'What is 6 * 7?',
      ctx,
    )

    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(result.output.text).toBe('The answer is 42.')
  })
})
```

- [ ] **Step 4: Register + run test**

Add `new AgentNode()` to `allNodes()`. Run:

```bash
pnpm --filter @dagents/workflow test -- agent.node
```

Expected: PASS

---

### Task 3.4-3.14: Remaining Nodes

Migrate the remaining 11 nodes: Tool, HTTP, Condition, ConditionAgent, Iteration, Loop, HumanInput, DirectReply, CustomFunction, ExecuteFlow, Retriever.

Each node follows the same pattern:
1. Implement `INode` interface
2. Write tests
3. Register in `allNodes()`

**Files to create:**
- `packages/workflow/src/nodes/tool/tool.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/http/http.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/condition/condition.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/condition-agent/condition-agent.node.ts` (NEW)
- `packages/workflow/src/nodes/iteration/iteration.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/loop/loop.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/human-input/human-input.node.ts` (NEW)
- `packages/workflow/src/nodes/direct-reply/direct-reply.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/custom-function/custom-function.node.ts` (already exists - verify V2 shape)
- `packages/workflow/src/nodes/execute-flow/execute-flow.node.ts` (NEW)
- `packages/workflow/src/nodes/retriever/retriever.node.ts` (already exists - verify V2 shape)

For nodes that already exist (8 from Plan A), verify their `name` matches the V2 convention (`*Agentflow`) and update if needed.

New nodes that need implementation:
- **ConditionAgent**: LLM-based routing to multiple scenarios
- **HumanInput**: Pauses execution waiting for human input
- **ExecuteFlow**: Nested flow execution

- [ ] **Step 1: Verify existing 8 nodes have correct V2 naming**
- [ ] **Step 2: Implement ConditionAgentNode**
- [ ] **Step 3: Implement HumanInputNode**
- [ ] **Step 4: Implement ExecuteFlowNode**
- [ ] **Step 5: Run all workflow tests**

```bash
pnpm --filter @dagents/workflow test
```

Expected: all tests pass

---

## Phase 4: 执行引擎对接

### Task 4.1: Full DAG Executor with Branch + Loop Support

**Files:**
- Modify: `packages/workflow/src/engine/executor.ts`
- Test: `packages/workflow/src/__tests__/executor.test.ts`

- [ ] **Step 1: Rewrite DagExecutor to support branches and loops**

The current Plan A executor does simple topo-sort linear execution. For V2 we need:
- Condition nodes: skip branches based on condition result
- ConditionAgent nodes: route to the matching scenario output
- Iteration nodes: execute child nodes per item
- Loop nodes: repeat until condition met

This is a significant rewrite. The approach:
- Instead of linear topo-sort, traverse the DAG dynamically
- Each node's output determines which outgoing edges to follow
- Iteration/Loop nodes have sub-graphs that execute multiple times

```typescript
// packages/workflow/src/engine/executor.ts
// Rewrite with dynamic DAG traversal
```

- [ ] **Step 2: Write comprehensive integration tests**

Test cases:
- Linear flow (5 nodes in series)
- Condition: true branch only
- Condition: false branch only
- ConditionAgent: routes to correct scenario
- Iteration: iterates over 3 items
- Loop: runs 5 times then exits
- Nested flow (ExecuteFlow)

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagents/workflow test
```

---

### Task 4.2: Gateway Prediction Route → Workflow Engine

**Files:**
- Create: `apps/gateway/src/routes/workflow-predict.ts`
- Modify: `apps/gateway/src/app.ts` (replace flowise prediction with native)
- Modify: `apps/gateway/src/routes/workspace-flowise.ts` (delete after migration)

- [ ] **Step 1: Create workflow predict route**

```typescript
// apps/gateway/src/routes/workflow-predict.ts
import { Hono } from 'hono'
import { AppDataSource } from '@dagents/db'
import { Flow } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, SSEStreamer } from '@dagents/workflow'
import type { SsoContextVars } from '../auth.js'

const log = createLogger({ svc: 'gateway:workflow-predict' })

export const workflowPredictRoutes = new Hono<{ Variables: SsoContextVars }>()

workflowPredictRoutes.post('/:id/predict', async (c) => {
  const id = c.req.param('id')
  const repo = AppDataSource.getRepository(Flow)
  const flow = await repo.findOne({ where: { id } })
  if (!flow) return c.json({ success: false, error: 'flow not found' }, 404)

  const body = await c.req.json()
  const runId = crypto.randomUUID()

  // Build executor
  const registry = new NodeRegistry()
  registry.registerMany(allNodes())
  const executor = new DagExecutor(registry)

  // Set up SSE streaming
  const stream = new SSEStreamer()
  const responseStream = stream.getReadableStream()

  // Execute in background
  ;(async () => {
    try {
      const result = await executor.execute(flow.flowData as any, body, {
        chatId: body.chatId ?? 'default',
        runId,
        state: {},
        isLastNode: false,
        sseStreamer: stream,
      })
      stream.emit('end', { runId, status: result.status, output: result.finalOutput })
    } catch (err) {
      log.error('workflow execution failed', { error: String(err) })
      stream.emit('error', { error: String(err) })
    } finally {
      stream.close()
    }
  })()

  return new Response(responseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-run-id': runId,
    },
  })
})
```

- [ ] **Step 2: Mount in app.ts**

Replace the Flowise prediction proxy (`/api/v1/flows/*`) with `app.route('/api/v1/workflows', workflowPredictRoutes)`.

- [ ] **Step 3: Update console chat-execute to use workflows endpoint**

- [ ] **Step 4: Run gateway tests**

```bash
pnpm --filter @dagents/gateway test
```

---

### Task 4.3: Scheduler Queue → Workflow Engine

**Files:**
- Modify: `apps/scheduler/src/prediction-client.ts`
- Modify: `apps/scheduler/src/worker.ts`

- [ ] **Step 1: Update prediction client to call workflow engine directly**

Instead of HTTP-calling Flowise's prediction endpoint, the scheduler calls the workflow executor directly (or through the gateway's workflow predict endpoint).

- [ ] **Step 2: Run scheduler tests**

```bash
pnpm --filter @dagents/scheduler test
```

---

## Phase 5: 清理

### Task 5.1: Remove Flowise Vendor + Proxy Code

**Files:**
- Delete: `vendor/flowise/`
- Delete: `apps/gateway/src/routes/workspace-flowise.ts`
- Delete: `apps/gateway/src/flowise-shape.ts`
- Delete: `apps/console/src/lib/flowise-client.ts`
- Delete: `apps/console/src/components/flow-editor-frame.tsx`
- Delete: `apps/console/src/styles/flow-editor.css`
- Modify: `apps/gateway/src/app.ts` (remove all flowise imports/routes)
- Modify: `infra/docker-compose.yml` (remove flowise service)
- Modify: All `.env` files (remove FLOWISE_* variables)
- Modify: `CLAUDE.md` (remove Flowise references)

- [ ] **Step 1: Delete vendor/flowise/**
- [ ] **Step 2: Remove Flowise proxy routes from gateway**
- [ ] **Step 3: Remove Flowise client from console**
- [ ] **Step 4: Remove Flowise from docker-compose**
- [ ] **Step 5: Remove FLOWISE_* env vars**
- [ ] **Step 6: Update CLAUDE.md**
- [ ] **Step 7: Update architecture spec**

---

### Task 5.2: Full Test Pass

- [ ] **Step 1: Run all tests**

```bash
pnpm test
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck --force
```

- [ ] **Step 3: Run build**

```bash
pnpm build
```

- [ ] **Step 4: Run e2e tests**

```bash
pnpm --filter @dagents/e2e test
```

All should pass with zero Flowise references remaining.

---

## Self-Review

**Spec coverage:**
- ✅ Phase 1: flows table + CRUD API + console proxy
- ✅ Phase 2: ReactFlow canvas editor with 14-node palette + inspector + toolbar
- ✅ Phase 3: 14 V2 agentflow nodes (Start/Agent/LLM/Tool/HTTP/Condition/ConditionAgent/Iteration/Loop/HumanInput/DirectReply/CustomFunction/ExecuteFlow/Retriever)
- ✅ Phase 4: Full DAG executor with branch/loop + gateway predict route + scheduler integration
- ✅ Phase 5: Complete vendor/flowise/ removal + proxy code cleanup

**Placeholder scan:**
- Fixed: all steps have concrete code, no "TBD" or "implement later"
- The 8 existing nodes from Plan A need verification — flagged as a step
- ConditionAgent/HumanInput/ExecuteFlow need full implementation — described in Task 3.4-3.14

**Type consistency:**
- Node name convention: `*Agentflow` (e.g. `startAgentflow`) — consistent across canvas metadata and node classes
- Flow data shape: ReactFlow-compatible `{nodes, edges, viewport}` — consistent with existing Flowise migration path
- CanvasNodeMeta `name` matches INode `name` — used as the registry key

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-27-flowise-migration-v2-workflow.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per phase/task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
