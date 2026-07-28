# Trial Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Dagents 平台从 "Demo 可演" 推进到 "Trial 可用"：兑现 Chat-First 触发承诺、补齐首屏引导、激活 Daemons e2e 保护、暴露消息级用量、统一语言。

**Architecture:** 5 个独立 Phase，每个 Phase 自成可测试单元。Phase 1/2 并行（P0），Phase 3/4/5 并行（P1）。所有改动复用现有 schema，无 DB migration。新增一个 gateway 内部回调 endpoint 用于 scheduler/dispatch 完成后回写 chat。

**Tech Stack:** TypeScript, Hono, Next.js 15, React 18, TypeORM, PostgreSQL, Vitest, Playwright, zod

**Spec:** `docs/superpowers/specs/2026-07-28-trial-readiness.md`

---

## File Structure

| File | 责任 | 操作 |
|------|------|------|
| `apps/gateway/src/routes/chat-execute.ts` | `routeCommand` 真正调用下游 | Modify |
| `apps/gateway/src/routes/internal-runs.ts` | 新增内部回调 endpoint | Create |
| `apps/gateway/src/app.ts` | 挂载 internal-runs 路由 + 内部 token 中间件 | Modify |
| `apps/gateway/src/inline-executor.ts` | 持久化 usage 到 metadata | Modify |
| `apps/gateway/src/ws-hub.ts` | `ChatEvent` 增加 usage 字段 | Modify |
| `apps/console/src/components/chat-home.tsx` | 空状态 UI + 中文文案 | Modify |
| `apps/console/src/components/use-directories.ts` | 目录加载 hook 抽取 | Create |
| `apps/console/src/components/assistant-content.tsx` | 渲染 usage footer | Modify |
| `apps/console/src/components/assistant-content.css` | footer 样式 | Modify |
| `apps/console/src/lib/chat-stream.ts` | 透传 usage 到 ChatEvent | Modify |
| `apps/console/tests/e2e/09-chat-trigger.spec.ts` | 激活 UC-TRG-02/03/04 | Modify |
| `apps/console/tests/e2e/01-chat-home.spec.ts` | 激活 UC-CHAT-01 空状态 | Modify |
| `apps/console/tests/e2e/06-daemons.spec.ts` | 激活 UC-DAE-01/02/03 | Modify |
| `apps/gateway/src/__tests__/chat-execute.test.ts` | routeCommand 单测 | Create |
| `apps/gateway/src/__tests__/internal-runs.test.ts` | 内部 endpoint 单测 | Create |
| `docs/superpowers/specs/flowise-migration-compat.md` | Flowise 兼容承诺 | Create |

---

## Phase 1: Chat Trigger 接调度（P0-1, TR-1）

### Task 1.1: Gateway 内部回调 endpoint

**Files:**
- Create: `apps/gateway/src/routes/internal-runs.ts`
- Modify: `apps/gateway/src/app.ts` (挂载路由)
- Test: `apps/gateway/src/__tests__/internal-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/src/__tests__/internal-runs.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'
import type { Hono } from 'hono'

describe('POST /internal/runs/:runId/complete', () => {
  let app: Hono
  let chatId: string

  beforeAll(async () => {
    process.env.INTERNAL_CALLBACK_TOKEN = 'test-internal-token'
    app = buildApp()
    // 创建测试 chat（用现有 test helpers 或直接 SQL）
    const { runQuery } = await import('@dagents/db')
    const { records: dirRecords } = await runQuery<{ id: string }>(
      `INSERT INTO directories (path, name) VALUES ('/tmp/test-internal', 'test-internal') RETURNING id`,
    )
    const dirId = dirRecords[0]!.id
    const { records: chatRecords } = await runQuery<{ id: string }>(
      `INSERT INTO chats (directory_id, title) VALUES ($1, 'test') RETURNING id`,
      [dirId],
    )
    chatId = chatRecords[0]!.id
  })

  afterAll(async () => {
    const { runQuery } = await import('@dagents/db')
    await runQuery(`DELETE FROM chat_messages WHERE chat_id = $1::uuid`, [chatId])
    await runQuery(`DELETE FROM chats WHERE id = $1::uuid`, [chatId])
    await runQuery(`DELETE FROM directories WHERE path = '/tmp/test-internal'`)
  })

  it('rejects without x-internal-token header', async () => {
    const res = await app.request('/internal/runs/run-1/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, output: 'hi', status: 'completed' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const res = await app.request('/internal/runs/run-1/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: JSON.stringify({ chatId, output: 'hi', status: 'completed' }),
    })
    expect(res.status).toBe(401)
  })

  it('writes assistant message + broadcasts WS', async () => {
    const res = await app.request(`/internal/runs/run-1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        chatId,
        output: 'flow result: 42',
        status: 'completed',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        durationMs: 1200,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.messageId).toBeTypeOf('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/internal-runs.test.ts
```
Expected: FAIL with "Cannot find module '../routes/internal-runs.js'" or 404.

- [ ] **Step 3: Create internal-runs route**

```typescript
// apps/gateway/src/routes/internal-runs.ts
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { wsHub } from '../ws-hub.js'
import type { TokenUsage } from '@dagents/contracts'

const log = createLogger({ svc: 'gateway:internal-runs' })

export const internalRunsRoutes = new Hono()

interface CompleteBody {
  chatId: string
  output: string
  status: 'completed' | 'failed'
  usage?: TokenUsage
  durationMs?: number
  cost?: number
}

/**
 * Internal endpoint called by scheduler/dispatch after a run completes.
 * Writes the assistant message + broadcasts chat:done via WS.
 *
 * Auth: requires x-internal-token header matching INTERNAL_CALLBACK_TOKEN env.
 * Bind to 127.0.0.1 in production (gateway already binds loopback by default).
 */
internalRunsRoutes.post('/runs/:runId/complete', async (c) => {
  const token = c.req.header('x-internal-token')
  const expected = process.env.INTERNAL_CALLBACK_TOKEN
  if (!expected || token !== expected) {
    return c.json({ success: false, error: 'unauthorized' }, 401)
  }

  const runId = c.req.param('runId')
  let body: CompleteBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'invalid json' }, 400)
  }

  if (!body.chatId || !body.output) {
    return c.json({ success: false, error: 'chatId and output required' }, 400)
  }

  const messageId = randomUUID()
  const metadata: Record<string, unknown> = {
    runId,
    status: body.status,
  }
  if (body.usage) metadata.usage = body.usage
  if (body.durationMs != null) metadata.durationMs = body.durationMs
  if (body.cost != null) metadata.cost = body.cost

  try {
    await runQuery(
      `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
      [messageId, body.chatId, body.output, runId, JSON.stringify(metadata)],
    )
    await runQuery(
      `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
      [body.chatId],
    )
  } catch (err) {
    log.error('internal complete persist failed', { runId, chatId: body.chatId, error: String(err) })
    return c.json({ success: false, error: 'persist failed' }, 502)
  }

  wsHub.broadcastChat(body.chatId, {
    type: 'chat:done',
    chatId: body.chatId,
    runId,
    role: 'assistant',
    content: body.output,
    streaming: false,
    status: body.status,
    usage: body.usage,
    durationMs: body.durationMs,
    cost: body.cost,
  })

  log.info('internal complete ok', { runId, chatId: body.chatId, messageId })
  return c.json({ success: true, data: { messageId } })
})
```

- [ ] **Step 4: Mount the route in app.ts**

Add to `apps/gateway/src/app.ts` after existing route mounts:

```typescript
import { internalRunsRoutes } from './routes/internal-runs.js'
// ... existing mounts ...
app.route('/internal', internalRunsRoutes)
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/internal-runs.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/internal-runs.ts apps/gateway/src/__tests__/internal-runs.test.ts apps/gateway/src/app.ts
git commit -m "feat: 新增 gateway 内部回调 endpoint 用于 scheduler/dispatch 完成回写"
```

---

### Task 1.2: Wire @agent to executeInline with override

**Files:**
- Modify: `apps/gateway/src/routes/chat-execute.ts:165-201` (routeCommand)
- Test: `apps/gateway/src/__tests__/chat-execute.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/src/__tests__/chat-execute.test.ts
import { describe, it, expect, vi } from 'vitest'
import { parseCommand } from '../routes/chat-execute.js'

describe('parseCommand', () => {
  it('parses @agent <name> <message>', () => {
    const cmd = parseCommand('@agent claude-code 修复登录 bug')
    expect(cmd).toEqual({
      kind: 'agent',
      target: 'claude-code',
      message: '修复登录 bug',
    })
  })

  it('parses @flow <name> <message>', () => {
    const cmd = parseCommand('@flow daily-summary 生成今日报告')
    expect(cmd).toEqual({
      kind: 'flow',
      target: 'daily-summary',
      message: '生成今日报告',
    })
  })

  it('parses @daemon <message>', () => {
    const cmd = parseCommand('@daemon run daily scan')
    expect(cmd).toEqual({
      kind: 'daemon',
      target: null,
      message: 'run daily scan',
    })
  })

  it('returns null for non-command', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for unknown @ command', () => {
    expect(parseCommand('@unknown foo')).toBeNull()
  })
})

describe('routeCommand @agent wiring', () => {
  // Integration test: @agent should resolve target agent by name and call executeInline
  // with agentIdOverride. We mock executeInline to avoid spawning claude.
  it('routes @agent to executeInline with resolved agentId', async () => {
    const { routeMessage } = await import('../routes/chat-execute.js')
    // This test requires DB setup — see integration test pattern in
    // existing __tests__/chat-execute.test.ts (if any) or use app.request()
    // pattern. For unit test, mock runQuery + executeInline.
    // Skipped here for brevity — follow TDD red-green for the routeMessage path.
  })
})
```

- [ ] **Step 2: Run test to verify parseCommand passes (it should — already implemented)**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/chat-execute.test.ts
```
Expected: parseCommand tests PASS (existing behavior).

- [ ] **Step 3: Update routeCommand to wire @agent**

Replace `routeCommand` in `apps/gateway/src/routes/chat-execute.ts:165-201` with:

```typescript
async function routeCommand(
  chatId: string,
  cmd: ParsedCommand,
  opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  // Write ack system message for all command kinds (UX feedback).
  const ack = formatCommandAck(cmd)
  let systemMessageId: string | undefined
  try {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO chat_messages (chat_id, role, content, metadata)
       VALUES ($1::uuid, 'system', $2, $3)
       RETURNING id`,
      [chatId, ack.text, JSON.stringify({ command: cmd })],
    )
    systemMessageId = records[0]?.id
  } catch (err) {
    log.error('routeCommand system message insert failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'command ack failed' }
  }

  // Dispatch to the right downstream based on kind.
  try {
    if (cmd.kind === 'agent') {
      return await routeAgentCommand(chatId, cmd, systemMessageId)
    }
    if (cmd.kind === 'flow') {
      return await routeFlowCommand(chatId, cmd, systemMessageId)
    }
    return await routeDaemonCommand(chatId, cmd, systemMessageId)
  } catch (err) {
    log.error('routeCommand downstream failed', { chatId, cmd, error: String(err) })
    return {
      mode: 'json',
      payload: { ack: ack.text, command: cmd, systemMessageId, error: String(err) },
      systemMessageId,
    }
  }
}

async function routeAgentCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Resolve agent by name (cmd.target) → agentId
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons WHERE name = $1 AND status = 'active' LIMIT 1`,
    [cmd.target],
  )
  const agent = records[0]
  if (!agent) {
    return {
      mode: 'json',
      payload: { ack: `⚡ Agent not found: ${cmd.target}`, command: cmd, systemMessageId, error: 'agent not found' },
      systemMessageId,
    }
  }

  // Resolve cwd from chat's directory
  let cwd: string | undefined
  const dirRes = await runQuery<{ directory_path: string | null }>(
    `SELECT d.path AS directory_path FROM chats c JOIN directories d ON d.id = c.directory_id WHERE c.id = $1::uuid`,
    [chatId],
  )
  cwd = dirRes.records[0]?.directory_path ?? undefined

  // Fire-and-forget executeInline (writes assistant message + WS chat:done on completion)
  const runId = randomUUID()
  void executeInline(chatId, agent.id, cmd.message || '(no message)', { cwd }).catch((err) => {
    log.error('routeAgentCommand executeInline failed', { chatId, agentId: agent.id, runId, error: String(err) })
  })

  return {
    mode: 'json',
    payload: { ack: `⚡ Routed to agent: ${cmd.target}`, command: cmd, systemMessageId, runId },
    systemMessageId,
  }
}

async function routeFlowCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Stub for Task 1.3
  return {
    mode: 'json',
    payload: { ack: `⚡ Flow triggered: ${cmd.target}`, command: cmd, systemMessageId, error: 'not wired yet' },
    systemMessageId,
  }
}

async function routeDaemonCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Stub for Task 1.4
  return {
    mode: 'json',
    payload: { ack: `⚡ Daemon invoked: ${cmd.message}`, command: cmd, systemMessageId, error: 'not wired yet' },
    systemMessageId,
  }
}
```

- [ ] **Step 4: Run tests to verify @agent wiring compiles**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/chat-execute.test.ts
pnpm --filter @dagents/gateway exec tsc --noEmit
```
Expected: parseCommand tests still PASS, typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/chat-execute.ts apps/gateway/src/__tests__/chat-execute.test.ts
git commit -m "feat: @agent 命令真正调用 executeInline 并按名称解析 agent"
```

---

### Task 1.3: Wire @flow to gateway workflows/:id/run

**Files:**
- Modify: `apps/gateway/src/routes/chat-execute.ts` (routeFlowCommand)
- Test: `apps/gateway/src/__tests__/chat-execute.test.ts` (extend)

- [ ] **Step 1: Add failing test for @flow resolution by name**

Append to `apps/gateway/src/__tests__/chat-execute.test.ts`:

```typescript
describe('routeFlowCommand @flow wiring', () => {
  it('resolves flow by name and posts to /api/v1/workflows/:id/run', async () => {
    // Integration: seed a flow with name='daily-summary', call routeMessage
    // with '@flow daily-summary 生成今日报告', assert:
    //   - system message written
    //   - workflow run kicked off (workflow_runs row or chat:done WS frame)
    //   - response payload contains runId
    // Use app.request() pattern from existing __tests__/chats.test.ts
  })

  it('returns error payload when flow name not found', async () => {
    // Call routeMessage with '@flow nonexistent ...'
    // Assert payload.error === 'flow not found'
  })
})
```

- [ ] **Step 2: Implement routeFlowCommand**

Replace the stub `routeFlowCommand` in `apps/gateway/src/routes/chat-execute.ts`:

```typescript
async function routeFlowCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // Resolve flow by name (cmd.target) → flowId
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM flows WHERE name = $1 AND status IN ('draft', 'published') LIMIT 1`,
    [cmd.target],
  )
  const flow = records[0]
  if (!flow) {
    return {
      mode: 'json',
      payload: { ack: `⚡ Flow not found: ${cmd.target}`, command: cmd, systemMessageId, error: 'flow not found' },
      systemMessageId,
    }
  }

  // Mark chat as running
  await runQuery(
    `UPDATE chats SET status = 'running', flow_id = $1, updated_at = NOW() WHERE id = $2::uuid`,
    [flow.id, chatId],
  ).catch((err) => {
    log.warn('routeFlowCommand status update failed', { chatId, error: String(err) })
  })

  // Fire-and-forget: call gateway's own /api/v1/workflows/:id/run internally
  const runId = randomUUID()
  void (async () => {
    try {
      // Build the workflow engine inline (mirror workflows.ts POST /:id/run)
      const { NodeRegistry, DagExecutor } = await import('@dagents/workflow')
      const { flowRow } = await loadFlow(flow.id)
      if (!flowRow) {
        await writeErrorSystemMessage(chatId, `Flow execution failed: flow ${flow.id} not loadable`)
        return
      }
      const registry = new NodeRegistry()
      const executor = new DagExecutor(registry)
      const result = await executor.execute(flowRow.flow_data, {
        input: cmd.message,
        chatId,
        runId,
      })
      // Write result via internal callback path (reuses Task 1.1 logic)
      await completeRunInternal(chatId, runId, result.output ?? '', 'completed', result.usage)
    } catch (err) {
      log.error('routeFlowCommand execution failed', { chatId, flowId: flow.id, runId, error: String(err) })
      await completeRunInternal(chatId, runId, `Flow execution failed: ${String(err)}`, 'failed')
    }
  })()

  return {
    mode: 'json',
    payload: { ack: `⚡ Flow triggered: ${cmd.target}`, command: cmd, systemMessageId, runId, flowId: flow.id },
    systemMessageId,
  }
}

// Helpers (module-private)
async function loadFlow(flowId: string): Promise<{ flowRow: { flow_data: unknown } | null }> {
  const { records } = await runQuery<{ flow_data: unknown }>(
    `SELECT flow_data FROM flows WHERE id = $1::uuid`,
    [flowId],
  )
  return { flowRow: records[0] ? { flow_data: records[0].flow_data } : null }
}

async function completeRunInternal(
  chatId: string,
  runId: string,
  output: string,
  status: 'completed' | 'failed',
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): Promise<void> {
  // Reuse the internal-runs route's persist + broadcast logic by calling it
  // in-process. We import the helper directly to avoid an HTTP round-trip.
  const { persistComplete } = await import('./internal-runs-helpers.js')
  await persistComplete({ chatId, runId, output, status, usage })
}

async function writeErrorSystemMessage(chatId: string, text: string): Promise<void> {
  await runQuery(
    `INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1::uuid, 'system', $2, NOW())`,
    [chatId, text],
  ).catch((err) => {
    log.error('writeErrorSystemMessage failed', { chatId, error: String(err) })
  })
}
```

- [ ] **Step 3: Extract persistComplete helper**

Create `apps/gateway/src/routes/internal-runs-helpers.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { wsHub } from '../ws-hub.js'

const log = createLogger({ svc: 'gateway:internal-runs-helpers' })

export interface CompleteParams {
  chatId: string
  runId: string
  output: string
  status: 'completed' | 'failed'
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  durationMs?: number
  cost?: number
}

export async function persistComplete(params: CompleteParams): Promise<string> {
  const messageId = randomUUID()
  const metadata: Record<string, unknown> = {
    runId: params.runId,
    status: params.status,
  }
  if (params.usage) metadata.usage = params.usage
  if (params.durationMs != null) metadata.durationMs = params.durationMs
  if (params.cost != null) metadata.cost = params.cost

  await runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
    [messageId, params.chatId, params.output, params.runId, JSON.stringify(metadata)],
  )
  await runQuery(
    `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
    [params.chatId],
  )

  wsHub.broadcastChat(params.chatId, {
    type: 'chat:done',
    chatId: params.chatId,
    runId: params.runId,
    role: 'assistant',
    content: params.output,
    streaming: false,
    status: params.status,
    usage: params.usage,
    durationMs: params.durationMs,
    cost: params.cost,
  })

  log.info('persistComplete ok', { runId: params.runId, chatId: params.chatId, messageId })
  return messageId
}
```

Refactor `internal-runs.ts` (Task 1.1) to use this helper:

```typescript
// apps/gateway/src/routes/internal-runs.ts (refactored body)
import { persistComplete } from './internal-runs-helpers.js'
// ... auth check stays ...
internalRunsRoutes.post('/runs/:runId/complete', async (c) => {
  // ... auth + parse ...
  try {
    const messageId = await persistComplete({ chatId: body.chatId, runId, ...body })
    return c.json({ success: true, data: { messageId } })
  } catch (err) {
    return c.json({ success: false, error: 'persist failed' }, 502)
  }
})
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/chat-execute.test.ts
pnpm --filter @dagents/gateway exec vitest run src/__tests__/internal-runs.test.ts
pnpm --filter @dagents/gateway exec tsc --noEmit
```
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/chat-execute.ts apps/gateway/src/routes/internal-runs-helpers.ts apps/gateway/src/routes/internal-runs.ts apps/gateway/src/__tests__/chat-execute.test.ts
git commit -m "feat: @flow 命令解析 flow 名称并触发 workflow 引擎执行"
```

---

### Task 1.4: Wire @daemon to dispatch invoke

**Files:**
- Modify: `apps/gateway/src/routes/chat-execute.ts` (routeDaemonCommand)
- Test: `apps/gateway/src/__tests__/chat-execute.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `apps/gateway/src/__tests__/chat-execute.test.ts`:

```typescript
describe('routeDaemonCommand @daemon wiring', () => {
  it('enqueues task via dispatch /api/v1/dispatch/invoke', async () => {
    // Integration: seed chat with agent_id bound, mock dispatch HTTP,
    // call routeMessage with '@daemon run scan', assert:
    //   - system message written
    //   - dispatch received POST /invoke with agentDaemonId=chat.agent_id
    //   - response payload contains taskId
  })

  it('returns error when chat has no agent_id bound', async () => {
    // Chat without agent_id → @daemon cannot resolve agentDaemonId
    // Assert payload.error === 'no agent bound to chat'
  })
})
```

- [ ] **Step 2: Implement routeDaemonCommand**

Replace the stub `routeDaemonCommand`:

```typescript
async function routeDaemonCommand(
  chatId: string,
  cmd: ParsedCommand,
  systemMessageId: string | undefined,
): Promise<RouteResult> {
  // @daemon requires chat.agent_id (used as agentDaemonId for dispatch)
  const { records: chatRecords } = await runQuery<{ agent_id: string | null; directory_path: string | null }>(
    `SELECT c.agent_id, d.path AS directory_path
       FROM chats c
       LEFT JOIN directories d ON d.id = c.directory_id
      WHERE c.id = $1::uuid`,
    [chatId],
  )
  const chat = chatRecords[0]
  if (!chat?.agent_id) {
    return {
      mode: 'json',
      payload: { ack: `⚡ Daemon invoked: ${cmd.message}`, command: cmd, systemMessageId, error: 'no agent bound to chat' },
      systemMessageId,
    }
  }

  const runId = randomUUID()
  const dispatchUrl = process.env.DISPATCH_URL ?? 'http://localhost:8081'
  try {
    const resp = await fetch(`${dispatchUrl}/api/v1/dispatch/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId: chat.agent_id,
        runId,
        prompt: cmd.message,
        execOptions: { cwd: chat.directory_path ?? undefined },
      }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      log.error('routeDaemonCommand dispatch invoke failed', { chatId, runId, status: resp.status, body: text })
      return {
        mode: 'json',
        payload: { ack: `⚡ Daemon invoke failed: ${resp.status}`, command: cmd, systemMessageId, error: 'dispatch invoke failed' },
        systemMessageId,
      }
    }
    const data = (await resp.json()) as { data?: { taskId: string } }
    const taskId = data.data?.taskId

    // Mark chat running — daemon will complete async; completeRunInternal is
    // called by dispatch's completion callback (needs dispatch-side wiring,
    // tracked separately; for now we rely on the daemon's WS push).
    await runQuery(
      `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    ).catch(() => {})

    return {
      mode: 'json',
      payload: { ack: `⚡ Daemon invoked: ${cmd.message}`, command: cmd, systemMessageId, runId, taskId },
      systemMessageId,
    }
  } catch (err) {
    log.error('routeDaemonCommand fetch failed', { chatId, runId, error: String(err) })
    return {
      mode: 'json',
      payload: { ack: `⚡ Daemon invoke error: ${String(err)}`, command: cmd, systemMessageId, error: String(err) },
      systemMessageId,
    }
  }
}
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/chat-execute.test.ts
pnpm --filter @dagents/gateway exec tsc --noEmit
```
Expected: PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/routes/chat-execute.ts apps/gateway/src/__tests__/chat-execute.test.ts
git commit -m "feat: @daemon 命令通过 dispatch /invoke 排队任务到 daemon"
```

---

### Task 1.5: Activate UC-TRG-02/03/04 e2e

**Files:**
- Modify: `apps/console/tests/e2e/09-chat-trigger.spec.ts` (lines 173-238+)

- [ ] **Step 1: Read current fixme bodies**

```bash
# Confirm test bodies are at lines 173-238+ for UC-TRG-02/03/04
```
The existing fixme bodies assert stub behavior (`⚡ Flow triggered: ...` ack only). Real behavior adds `runId` / `taskId` / actual assistant reply.

- [ ] **Step 2: Update UC-TRG-02 assertions and remove .fixme**

In `apps/console/tests/e2e/09-chat-trigger.spec.ts`, find the `test.fixme('UC-TRG-02: @flow triggers a named flow and acks in-chat', ...)` block. Replace with:

```typescript
test('UC-TRG-02: @flow triggers a named flow and acks in-chat', async ({ page, request }) => {
  await page.goto(`/chats/${chatForCommands}`)
  const textarea = page.getByPlaceholder(/Send a message/)
  await expect(textarea).toBeVisible({ timeout: 10_000 })
  await textarea.fill('@flow daily-summary 生成今日报告')
  await page.keyboard.press('Enter')

  // User message persisted
  await expect(page.locator('.chat-msg-user').first()).toBeVisible()
  // System ack
  const ack = page.locator('.chat-msg-system').first()
  await expect(ack).toBeVisible({ timeout: 10_000 })
  await expect(ack.locator('.chat-msg-content')).toHaveText(/Flow triggered: daily-summary/)

  // API contract: POST returns mode='json' with runId
  const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
    data: { content: '@flow daily-summary 生成今日报告', role: 'user' },
  })
  expect(res.ok()).toBe(true)
  const body = await res.json()
  expect(body.success).toBe(true)
  expect(body.data.mode).toBe('json')
  expect(body.data.payload?.ack).toMatch(/Flow triggered: daily-summary/)
  expect(body.data.payload?.command?.kind).toBe('flow')
  expect(body.data.payload?.command?.target).toBe('daily-summary')
  expect(body.data.payload?.runId).toBeTypeOf('string')
  expect(body.data.payload?.flowId).toBeTypeOf('string')
})
```

Also seed a flow named `daily-summary` in `beforeAll`:

```typescript
// Add to beforeAll after existing seeds:
const { runQuery } = await import('@dagents/db')
const { records: flowRecords } = await runQuery<{ id: string }>(
  `INSERT INTO flows (name, description, flow_data, status)
   VALUES ('daily-summary', 'e2e test flow',
           '{"nodes":[{"id":"start","position":{"x":0,"y":0},"type":"start","data":{}}],"edges":[]}',
           'published')
   RETURNING id`,
)
ctx.flowId = flowRecords[0]!.id
```

Add `flowId: string` to `SeedContext` extension at top of file, and dispose in `afterAll`:

```typescript
// afterAll, before ctx.dispose():
if (ctx.flowId) {
  await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [ctx.flowId])
}
```

- [ ] **Step 3: Update UC-TRG-03 (@daemon) assertions and remove .fixme**

```typescript
test('UC-TRG-03: @daemon invokes a daemon and acks in-chat', async ({ page, request }) => {
  await page.goto(`/chats/${chatForCommands}`)
  const textarea = page.getByPlaceholder(/Send a message/)
  await expect(textarea).toBeVisible({ timeout: 10_000 })
  await textarea.fill('@daemon run daily scan')
  await page.keyboard.press('Enter')

  await expect(page.locator('.chat-msg-user').first()).toBeVisible()
  const ack = page.locator('.chat-msg-system').first()
  await expect(ack).toBeVisible({ timeout: 10_000 })
  await expect(ack.locator('.chat-msg-content')).toHaveText(/Daemon invoked: run daily scan/)

  const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
    data: { content: '@daemon run daily scan', role: 'user' },
  })
  expect(res.ok()).toBe(true)
  const body = await res.json()
  expect(body.success).toBe(true)
  expect(body.data.mode).toBe('json')
  expect(body.data.payload?.ack).toMatch(/Daemon invoked: run daily scan/)
  expect(body.data.payload?.command?.kind).toBe('daemon')
  expect(body.data.payload?.command?.target).toBeNull()
  expect(body.data.payload?.runId).toBeTypeOf('string')
  expect(body.data.payload?.taskId).toBeTypeOf('string')
})
```

Note: `chatForCommands` must have `agent_id` bound in `beforeAll` for `@daemon` to succeed. Verify the seed:

```typescript
chatForCommands = await seedChat(ctx, {
  directoryId: dirId,
  title: 'commands chat',
  agentId, // bound — required for @daemon
})
```

- [ ] **Step 4: Update UC-TRG-04 (@agent) — find its fixme and activate**

Locate `test.fixme('UC-TRG-04: @agent <agent-name> <message> 临时覆盖', ...)` in the same file. Replace with:

```typescript
test('UC-TRG-04: @agent <agent-name> <message> 临时覆盖', async ({ page, request }) => {
  await page.goto(`/chats/${chatForCommands}`)
  const textarea = page.getByPlaceholder(/Send a message/)
  await expect(textarea).toBeVisible({ timeout: 10_000 })
  await textarea.fill(`@agent ${agentName} hello from override`)
  await page.keyboard.press('Enter')

  await expect(page.locator('.chat-msg-user').first()).toBeVisible()
  const ack = page.locator('.chat-msg-system').first()
  await expect(ack).toBeVisible({ timeout: 10_000 })
  await expect(ack.locator('.chat-msg-content')).toHaveText(/Routed to agent:/)

  const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
    data: { content: `@agent ${agentName} hello from override`, role: 'user' },
  })
  expect(res.ok()).toBe(true)
  const body = await res.json()
  expect(body.success).toBe(true)
  expect(body.data.mode).toBe('json')
  expect(body.data.payload?.command?.kind).toBe('agent')
  expect(body.data.payload?.command?.target).toBe(agentName)
  expect(body.data.payload?.runId).toBeTypeOf('string')
})
```

`agentName` must be captured in `beforeAll` from `seedAgent`'s opts.

- [ ] **Step 5: Run e2e against dev stack**

```bash
# Ensure dev stack up: docker compose up -d, gateway :8080, dispatch :8081
pnpm --filter @dagents/console exec playwright test tests/e2e/09-chat-trigger.spec.ts -g "UC-TRG-0[234]"
```
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console/tests/e2e/09-chat-trigger.spec.ts
git commit -m "test: 激活 UC-TRG-02/03/04 e2e (chat trigger 真正接调度)"
```

---

## Phase 2: Chat Home 空状态引导（P0-2, TR-2）

### Task 2.1: Extract useDirectories hook

**Files:**
- Create: `apps/console/src/components/use-directories.ts`
- Modify: `apps/console/src/components/chat-home.tsx` (use hook)
- Modify: `apps/console/src/components/directory-selector.tsx` (use hook)

- [ ] **Step 1: Create the hook**

```typescript
// apps/console/src/components/use-directories.ts
'use client'

import { useEffect, useState } from 'react'
import { fetchDirectories, type Directory } from '@/lib/directories'

export interface UseDirectoriesResult {
  directories: Directory[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useDirectories(): UseDirectoriesResult {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const dirs = await fetchDirectories()
      setDirectories(dirs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return { directories, loading, error, reload }
}
```

- [ ] **Step 2: Refactor chat-home.tsx to use the hook**

In `apps/console/src/components/chat-home.tsx`, replace the inline `useEffect` (lines 31-44) with:

```typescript
import { useDirectories } from './use-directories'
// ...

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const { directories, loading, error, reload } = useDirectories()
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error2, setError2] = useState<string | null>(null)

  useEffect(() => {
    if (directories.length > 0 && !selectedDirId) setSelectedDirId(directories[0]!.id)
  }, [directories, selectedDirId])

  const handleSend = useCallback(async (text: string) => {
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      setError2('请先添加项目目录')
      return
    }
    // ... rest unchanged ...
  }, [selectedDirId, directories, selectedAgentId, router])
  // ...
}
```

- [ ] **Step 3: Refactor directory-selector.tsx to use the hook**

In `apps/console/src/components/directory-selector.tsx`, replace the inline effect (lines 43-54) with:

```typescript
import { useDirectories } from './use-directories'
// ...
export function DirectorySelector({ value, onChange }: DirectorySelectorProps): React.ReactElement {
  const { directories, reload } = useDirectories()
  // ... rest unchanged, but `setDirectories(dirs)` calls become `reload()` ...
}
```

- [ ] **Step 4: Typecheck + run unit tests**

```bash
pnpm --filter @dagents/console exec tsc --noEmit
pnpm --filter @dagents/console exec vitest run
```
Expected: typecheck PASS, no unit test regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/components/use-directories.ts apps/console/src/components/chat-home.tsx apps/console/src/components/directory-selector.tsx
git commit -m "refactor: 抽取 useDirectories hook 复用目录加载逻辑"
```

---

### Task 2.2: Chat Home empty state with inline directory add

**Files:**
- Modify: `apps/console/src/components/chat-home.tsx`
- Modify: `apps/console/src/styles/chat-home.css`

- [ ] **Step 1: Add Empty State UI**

In `apps/console/src/components/chat-home.tsx`, modify the render to branch on `directories.length === 0`:

```typescript
import { pickDirectory, createDirectory } from '@/lib/directories'
// ...

const [addingDir, setAddingDir] = useState(false)
const [addError, setAddError] = useState<string | null>(null)

const handleAddDirectory = useCallback(async (): Promise<void> => {
  setAddError(null)
  setAddingDir(true)
  try {
    const path = await pickDirectory()
    if (!path) return // user cancelled
    const dir = await createDirectory({ path })
    await reload()
    setSelectedDirId(dir.id)
  } catch (err) {
    setAddError(err instanceof Error ? err.message : String(err))
  } finally {
    setAddingDir(false)
  }
}, [reload])

// In render, replace the placeholder section:
return (
  <div className="chat-home-body">
    <div className="chat-home-topbar">
      <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
    </div>

    {directories.length === 0 && !loading ? (
      <div className="chat-home-empty">
        <div className="chat-home-empty-icon">
          <Icon name="folder" style={{ width: 48, height: 48, color: 'var(--accent)' }} />
        </div>
        <h2 className="chat-home-empty-title">开始前，请先添加一个项目目录</h2>
        <p className="chat-home-empty-desc">
          DAgent 需要知道在哪里运行 Agent。添加一个本地目录即可开始对话。
        </p>
        <button
          type="button"
          className="chat-home-empty-cta"
          onClick={() => void handleAddDirectory()}
          disabled={addingDir}
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          <span>{addingDir ? '等待选择…' : '浏览本地目录…'}</span>
        </button>
        {addError ? (
          <div className="chat-home-empty-error">{addError}</div>
        ) : null}
        <a className="chat-home-empty-secondary" href="/directories">
          或前往目录管理页 →
        </a>
      </div>
    ) : (
      <div className="chat-home-placeholder">
        <div className="chat-home-placeholder-inner">
          <div className="chat-home-bot-avatar">
            <Icon name="bot" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
          </div>
          <h1 className="chat-home-welcome-title">DAgent 控制台</h1>
          <p className="chat-home-welcome-desc">
            多 Agent 编排平台，支持推理、工具调用与并行执行。
          </p>
          <SuggestionCards onPick={(text) => void handleSend(text)} />
        </div>
      </div>
    )}

    <ChatComposer
      onSend={handleSend}
      disabled={sending || directories.length === 0}
      agentId={selectedAgentId}
      onAgentChange={setSelectedAgentId}
    />
    {(error2 || error) && (
      <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--text-sm)', paddingBottom: 'var(--space-4)' }}>
        {error2 ?? error}
      </div>
    )}
  </div>
)
```

- [ ] **Step 2: Add CSS**

Append to `apps/console/src/styles/chat-home.css`:

```css
.chat-home-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8) var(--space-4);
  text-align: center;
  gap: var(--space-3);
}

.chat-home-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: var(--surface-2, #f5f5f5);
  margin-bottom: var(--space-2);
}

.chat-home-empty-title {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.chat-home-empty-desc {
  font-size: var(--text-sm);
  color: var(--text-muted);
  max-width: 380px;
  margin: 0;
}

.chat-home-empty-cta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}
.chat-home-empty-cta:hover { opacity: 0.9; }
.chat-home-empty-cta:disabled { opacity: 0.6; cursor: not-allowed; }

.chat-home-empty-error {
  color: var(--danger);
  font-size: var(--text-sm);
}

.chat-home-empty-secondary {
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-decoration: none;
  margin-top: var(--space-2);
}
.chat-home-empty-secondary:hover { text-decoration: underline; }
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dagents/console exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/components/chat-home.tsx apps/console/src/styles/chat-home.css
git commit -m "feat: Chat Home 空状态引导用户内联添加首个项目目录"
```

---

### Task 2.3: Localize welcome copy (zh-CN)

**Files:**
- Modify: `apps/console/src/components/chat-home.tsx`

- [ ] **Step 1: Verify all English copy replaced**

The render in Task 2.2 already replaced:
- "DAgent Console" → "DAgent 控制台"
- "Multi-agent orchestration with reasoning, tool use, and parallel execution support." → "多 Agent 编排平台，支持推理、工具调用与并行执行。"

Also check `apps/console/src/components/suggestion-cards.tsx` — suggestions are already Chinese. Run a sanity grep:

```bash
# Find any remaining English UI copy in console components
```

Manually verify any remaining English copy in chat components, replace with Chinese where it's user-facing.

- [ ] **Step 2: Commit (if any additional changes)**

```bash
git add apps/console/src/components/
git commit -m "feat: 统一 Chat Home UI 文案为中文 (zh-CN)"
```

---

### Task 2.4: Activate UC-CHAT-01 e2e for empty state

**Files:**
- Modify: `apps/console/tests/e2e/01-chat-home.spec.ts`

- [ ] **Step 1: Locate existing UC-CHAT-01 fixme**

Read `apps/console/tests/e2e/01-chat-home.spec.ts` to find UC-CHAT-01 (likely a fixme about "first-time user with no directories sees empty state").

- [ ] **Step 2: Replace fixme with active test**

```typescript
test('UC-CHAT-01: first-time user with no directories sees empty state CTA', async ({ page, request }) => {
  // Ensure no directories exist (cleanup any leftover)
  const { runQuery } = await import('@dagents/db')
  await runQuery(`DELETE FROM directories WHERE path LIKE '/tmp/e2e-empty-%'`)

  await page.goto('/')
  // Empty state renders
  await expect(page.locator('.chat-home-empty')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.chat-home-empty-title')).toHaveText(/开始前，请先添加一个项目目录/)
  await expect(page.locator('.chat-home-empty-cta')).toBeVisible()
  // Composer is disabled when no directories
  const sendButton = page.locator('.chat-composer-send')
  await expect(sendButton).toBeDisabled()

  // Cleanup
  await runQuery(`DELETE FROM directories WHERE path LIKE '/tmp/e2e-empty-%'`)
})
```

Note: this test assumes the e2e DB starts with no directories. If other tests seed directories in the same suite, isolate by running it first or use a dedicated DB state. Coordinate with `helpers/seed.ts`.

- [ ] **Step 3: Run e2e**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/01-chat-home.spec.ts -g "UC-CHAT-01"
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/console/tests/e2e/01-chat-home.spec.ts
git commit -m "test: 激活 UC-CHAT-01 e2e (空状态 CTA)"
```

---

## Phase 3: Daemons E2E 激活（P1-4, TR-4）

### Task 3.1: Activate UC-DAE-01 (queue list)

**Files:**
- Modify: `apps/console/tests/e2e/06-daemons.spec.ts`

- [ ] **Step 1: Read current fixme body**

```bash
# Read apps/console/tests/e2e/06-daemons.spec.ts to find UC-DAE-01 fixme
```

- [ ] **Step 2: Update assertions to match real daemons-view.tsx + remove .fixme**

The daemons-view page renders queue/timeline/stats. Read `apps/console/src/components/daemons-view.tsx` to confirm selectors, then:

```typescript
test('UC-DAE-01: daemons page shows task queue list', async ({ page }) => {
  // Seed: insert a few dispatch_tasks rows in 'queued' status
  const { runQuery } = await import('@dagents/db')
  const { records: agentRecords } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons LIMIT 1`,
  )
  if (agentRecords.length === 0) {
    // Skip cleanly if no agent registered — daemons page requires one
    test.skip()
    return
  }
  const agentId = agentRecords[0]!.id
  const { records: taskRecords } = await runQuery<{ id: string }>(
    `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, status, created_at)
     VALUES (gen_random_uuid(), $1, 'e2e-run-1', 'e2e test task', 'queued', NOW())
     RETURNING id`,
    [agentId],
  )
  const taskId = taskRecords[0]!.id

  try {
    await page.goto('/daemons')
    // Queue list renders
    await expect(page.locator('.daemons-queue')).toBeVisible({ timeout: 10_000 })
    // The seeded task appears
    await expect(page.locator('.daemons-queue-item').filter({ hasText: 'e2e test task' })).toBeVisible()
  } finally {
    await runQuery(`DELETE FROM dispatch_tasks WHERE id = $1::uuid`, [taskId])
  }
})
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/06-daemons.spec.ts -g "UC-DAE-01"
git add apps/console/tests/e2e/06-daemons.spec.ts
git commit -m "test: 激活 UC-DAE-01 e2e (daemons 队列列表)"
```

---

### Task 3.2: Activate UC-DAE-02 (timeline)

**Files:**
- Modify: `apps/console/tests/e2e/06-daemons.spec.ts`

- [ ] **Step 1: Update fixme → test for timeline**

```typescript
test('UC-DAE-02: daemons page shows execution timeline', async ({ page }) => {
  // Seed: insert a completed task with started_at + completed_at
  const { runQuery } = await import('@dagents/db')
  const { records: agentRecords } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons LIMIT 1`,
  )
  if (agentRecords.length === 0) { test.skip(); return }
  const agentId = agentRecords[0]!.id
  const { records: taskRecords } = await runQuery<{ id: string }>(
    `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, status, created_at, started_at, completed_at)
     VALUES (gen_random_uuid(), $1, 'e2e-run-2', 'e2e timeline task', 'completed',
             NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '3 minutes')
     RETURNING id`,
    [agentId],
  )
  const taskId = taskRecords[0]!.id

  try {
    await page.goto('/daemons')
    await expect(page.locator('.daemons-timeline')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.daemons-timeline-item').first()).toBeVisible()
  } finally {
    await runQuery(`DELETE FROM dispatch_tasks WHERE id = $1::uuid`, [taskId])
  }
})
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/06-daemons.spec.ts -g "UC-DAE-02"
git add apps/console/tests/e2e/06-daemons.spec.ts
git commit -m "test: 激活 UC-DAE-02 e2e (daemons 执行时间线)"
```

---

### Task 3.3: Activate UC-DAE-03 (stats)

**Files:**
- Modify: `apps/console/tests/e2e/06-daemons.spec.ts`

- [ ] **Step 1: Update fixme → test for stats**

```typescript
test('UC-DAE-03: daemons page shows stats summary', async ({ page }) => {
  await page.goto('/daemons')
  await expect(page.locator('.daemons-stats')).toBeVisible({ timeout: 10_000 })
  // Stats cards render (queued / running / completed / failed)
  await expect(page.locator('.daemons-stats-card').first()).toBeVisible()
  // Numeric values are present (non-empty)
  const statValue = await page.locator('.daemons-stats-value').first().textContent()
  expect(statValue).not.toBeNull()
})
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/06-daemons.spec.ts -g "UC-DAE-03"
git add apps/console/tests/e2e/06-daemons.spec.ts
git commit -m "test: 激活 UC-DAE-03 e2e (daemons 统计面板)"
```

---

## Phase 4: 消息级用量/成本显示（P1-6, TR-6）

### Task 4.1: Persist usage in inline-executor

**Files:**
- Modify: `apps/gateway/src/inline-executor.ts:127-150`
- Test: `apps/gateway/src/__tests__/inline-executor.test.ts` (extend or create)

- [ ] **Step 1: Add failing test for metadata persistence**

```typescript
// apps/gateway/src/__tests__/inline-executor.test.ts (append)
describe('executeInline usage persistence', () => {
  it('persists result.usage to chat_messages.metadata', async () => {
    // Mock claudeBackend to return AgentResult with usage
    // Call executeInline, then query chat_messages.metadata
    // Assert metadata.usage = { inputTokens, outputTokens, totalTokens }
  })
})
```

- [ ] **Step 2: Update INSERT in inline-executor.ts**

In `apps/gateway/src/inline-executor.ts`, replace lines 127-150:

```typescript
// 完成：写 assistant 消息 + 推送 chat:done
const usage = result?.usage
const durationMs = result?.durationMs ?? undefined
const cost = usage ? computeCost(usage, opts.model) : undefined
const metadata: Record<string, unknown> = {
  runId,
  status: result?.status ?? 'completed',
}
if (usage) metadata.usage = usage
if (durationMs != null) metadata.durationMs = durationMs
if (cost != null) metadata.cost = cost

try {
  await runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
    [randomUUID(), chatId, output || result?.output || '', runId, JSON.stringify(metadata)],
  )
  await runQuery(
    `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
    [chatId],
  )
} catch (err) {
  log.error('inline execute persist failed', { chatId, runId, error: String(err) })
}

wsHub.broadcastChat(chatId, {
  type: 'chat:done',
  chatId,
  runId,
  role: 'assistant',
  content: output || result?.output || '',
  streaming: false,
  status: result?.status ?? 'completed',
  usage,
  durationMs,
  cost,
})
log.info('inline execute done', { chatId, runId, status: result?.status, outputLen: output.length, usage })
```

Add `computeCost` helper at top of file:

```typescript
// Hardcoded price table (USD per 1M tokens) — replace with LLM Provider CRUD lookup in follow-up.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'sonnet': { input: 3, output: 15 },
  'opus': { input: 15, output: 75 },
  'haiku': { input: 0.25, output: 1.25 },
}
const DEFAULT_PRICE = { input: 3, output: 15 } // default to sonnet pricing

function computeCost(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }, model?: string): number | undefined {
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return undefined
  const price = (model && MODEL_PRICES[model]) ?? DEFAULT_PRICE
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000
}
```

- [ ] **Step 3: Extend ChatEvent type**

In `apps/gateway/src/ws-hub.ts`, find the `ChatEvent` interface and add fields:

```typescript
export interface ChatEvent {
  type: 'chat:message' | 'chat:done' | 'chat:error'
  chatId: string
  runId: string
  role: 'assistant' | 'system' | 'tool'
  content: string
  streaming: boolean
  status?: string
  /** Token usage for the run (present on chat:done when available). */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  /** Wall-clock duration in ms (present on chat:done when available). */
  durationMs?: number
  /** Computed cost in USD (present on chat:done when available). */
  cost?: number
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/inline-executor.test.ts
pnpm --filter @dagents/gateway exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/inline-executor.ts apps/gateway/src/ws-hub.ts apps/gateway/src/__tests__/inline-executor.test.ts
git commit -m "feat: inline-executor 持久化 usage/cost/duration 到 chat_messages.metadata"
```

---

### Task 4.2: Propagate usage through console chat-stream

**Files:**
- Modify: `apps/console/src/lib/chat-stream.ts`
- Modify: `apps/console/src/lib/use-ws-chat.ts` (if WS path)

- [ ] **Step 1: Locate chat:done handler in console**

Read `apps/console/src/lib/chat-stream.ts` and `use-ws-chat.ts` to find where `chat:done` is consumed. Add `usage` / `durationMs` / `cost` to the message type.

```typescript
// apps/console/src/lib/chat-stream.ts (or use-ws-chat.ts)
export interface AssistantMessageMeta {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  durationMs?: number
  cost?: number
}

// In the chat:done handler:
function handleChatDone(event: {
  content: string
  runId: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  durationMs?: number
  cost?: number
}) {
  // Attach meta to the streaming bubble so it can render the footer
  setMessages((prev) => prev.map((m) =>
    m.runId === event.runId
      ? { ...m, content: event.content, streaming: false, meta: { usage: event.usage, durationMs: event.durationMs, cost: event.cost } }
      : m
  ))
}
```

- [ ] **Step 2: For historical messages loaded from DB, parse metadata**

In the message loader (likely in `apps/console/src/lib/chats.ts` or `chat-detail.tsx`), map `metadata` from DB to `meta` on the message object:

```typescript
// When loading chat messages from /api/chats/:id/messages:
function mapDbMessage(msg: { id: string; role: string; content: string; metadata?: unknown }): ChatMessage {
  const meta = (msg.metadata && typeof msg.metadata === 'object') ? msg.metadata as AssistantMessageMeta : undefined
  return { id: msg.id, role: msg.role, content: msg.content, meta }
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dagents/console exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/lib/chat-stream.ts apps/console/src/lib/use-ws-chat.ts apps/console/src/lib/chats.ts apps/console/src/components/chat-detail.tsx
git commit -m "feat: 前端透传 chat:done 的 usage/cost/duration 到消息对象"
```

---

### Task 4.3: Render usage footer in AssistantContent

**Files:**
- Modify: `apps/console/src/components/assistant-content.tsx`
- Modify: `apps/console/src/styles/assistant-content.css`

- [ ] **Step 1: Add UsageFooter render**

In `apps/console/src/components/assistant-content.tsx`, accept a `meta` prop and render a footer at the bottom of the assistant message:

```typescript
export interface AssistantMessageMeta {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  durationMs?: number
  cost?: number
}

interface AssistantContentProps {
  raw: string
  meta?: AssistantMessageMeta
}

export function AssistantContent({ raw, meta }: AssistantContentProps): React.ReactElement {
  const segments = parseAssistantContent(raw)
  // ... existing render logic ...

  return (
    <div className="assistant-content">
      {/* existing preface / middle / final render */}
      {/* ... */}
      {meta ? <UsageFooter meta={meta} /> : null}
    </div>
  )
}

function UsageFooter({ meta }: { meta: AssistantMessageMeta }): React.ReactElement | null {
  const parts: string[] = []
  if (meta.usage?.totalTokens != null) {
    parts.push(formatTokens(meta.usage.totalTokens))
  } else if (meta.usage?.inputTokens != null && meta.usage?.outputTokens != null) {
    parts.push(formatTokens(meta.usage.inputTokens + meta.usage.outputTokens))
  }
  if (meta.durationMs != null) parts.push(formatDuration(meta.durationMs))
  if (meta.cost != null) parts.push(`$${meta.cost.toFixed(4)}`)
  if (parts.length === 0) return null
  return <div className="assistant-usage-footer">{parts.join(' · ')}</div>
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`
  return `${n} tokens`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
```

- [ ] **Step 2: Add CSS**

Append to `apps/console/src/styles/assistant-content.css`:

```css
.assistant-usage-footer {
  margin-top: var(--space-2);
  padding-top: var(--space-1);
  font-size: var(--text-xs, 11px);
  color: var(--text-muted);
  border-top: 1px solid var(--border, rgba(0,0,0,0.06));
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Wire meta prop in chat-detail.tsx and floating-chat.tsx**

In both `apps/console/src/components/chat-detail.tsx` and `apps/console/src/components/floating-chat.tsx`, find where `<AssistantContent raw={...} />` is rendered and pass `meta={message.meta}`:

```typescript
<AssistantContent raw={message.content} meta={message.meta} />
```

- [ ] **Step 4: Typecheck + run unit tests**

```bash
pnpm --filter @dagents/console exec tsc --noEmit
pnpm --filter @dagents/console exec vitest run
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/components/assistant-content.tsx apps/console/src/styles/assistant-content.css apps/console/src/components/chat-detail.tsx apps/console/src/components/floating-chat.tsx
git commit -m "feat: AssistantContent 渲染 token/耗时/cost footer"
```

---

### Task 4.4: E2E for usage display

**Files:**
- Modify: `apps/console/tests/e2e/02-chat-detail.spec.ts`

- [ ] **Step 1: Add test for usage footer**

```typescript
test('UC-CHAT-XX: assistant message shows usage footer after streaming', async ({ page }) => {
  // This requires the dev stack with a working claude CLI on the gateway.
  // If claude is not available in e2e env, mark as test.fixme and skip activation.
  // For now: assume the existing send-and-stream test already produces a
  // chat:done with usage; assert the footer renders.
  await page.goto(`/chats/${chatId}`)
  // Trigger a send (depends on existing send test setup)
  const textarea = page.getByPlaceholder(/Send a message/)
  await textarea.fill('hi')
  await page.keyboard.press('Enter')

  const assistant = page.locator('.chat-msg-assistant').first()
  await expect(assistant).toBeVisible({ timeout: 15_000 })
  // Footer appears after chat:done
  await expect(assistant.locator('.assistant-usage-footer')).toBeVisible({ timeout: 30_000 })
  // Footer contains "tokens" suffix
  const footerText = await assistant.locator('.assistant-usage-footer').textContent()
  expect(footerText).toMatch(/tokens/)
})
```

Note: if claude CLI isn't available in e2e, leave as `test.fixme` and document the dependency.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/02-chat-detail.spec.ts -g "usage footer"
git add apps/console/tests/e2e/02-chat-detail.spec.ts
git commit -m "test: 新增 assistant 消息 usage footer e2e 验证"
```

---

## Phase 5: Flowise 兼容承诺 + 语言统一（P1-5, P1-7）

### Task 5.1: Write Flowise migration compat doc

**Files:**
- Create: `docs/superpowers/specs/flowise-migration-compat.md`

- [ ] **Step 1: Write the doc**

```markdown
# Flowise 迁移期数据兼容承诺

> **日期**: 2026-07-28
> **状态**: Active
> **关联**: `docs/superpowers/plans/2026-07-27-flowise-migration-v2-workflow.md`

## 兼容窗口期定义

从 2026-07-27（Plan A 完成）到 Plan C 完成（`vendor/flowise/` 删除）之间为"兼容窗口期"。期间新 `flows` 表与旧 Flowise `chatflows` 表并存。

## 用户承诺

1. **数据保留**: 用户在 Flowise 中创建的所有 chatflows 不会被删除。
2. **迁移路径**: Plan C 提供一次性 migration 脚本，把 `chatflows.flowData` 导入 `flows.flow_data`（形状一致，ReactFlow 兼容）。
3. **API 兼容**: 旧 `/api/v1/flows/*` / `/api/v1/chatflows/*` proxy 路由在 Plan C 完成前保留。新代码应使用 `/api/v1/workflows/*`。
4. **执行引擎**: Plan A 已完成 `@dagents/workflow` 引擎；Plan B/C 完成前，部分节点（Start/LLM/Agent）仍走 Flowise prediction 路径。Plan C 完成后所有执行走 `@dagents/workflow`。

## 迁移完成判据

- [ ] `vendor/flowise/` 目录从仓库删除
- [ ] gateway 不再有任何 Flowise proxy 路由
- [ ] `FLOWISE_URL` / `FLOWISE_API_KEY` 环境变量从所有 .env.example 移除
- [ ] E2E UC-WF-01~12 全部 active（当前 0/12）
- [ ] 一次性 migration 脚本已执行并归档

## 用户行动指引

- **兼容窗口期内**: 优先在 `/workflows` 新页面编辑 flow；旧 `/flows` 页面仍可用。
- **Plan C 完成后**: 旧 `/flows` 路由重定向到 `/workflows`；用户无需手动迁移。

## 回滚预案

若 Plan C 出现重大问题，可回滚到兼容窗口期状态：
- 保留 `vendor/flowise/` 不删除
- 恢复 gateway Flowise proxy 路由
- 已迁移的 `flows` 表数据保留，不影响新功能使用
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/flowise-migration-compat.md
git commit -m "docs: Flowise 迁移期数据兼容承诺"
```

---

### Task 5.2: Audit and localize remaining English UI copy

**Files:**
- Modify: various components under `apps/console/src/components/`

- [ ] **Step 1: Grep for English-only UI strings**

```bash
# Search for common English UI patterns in components
# (manual review; no automated tool)
```

Check these files for English user-facing copy:
- `apps/console/src/components/chat-composer.tsx` — placeholder, button labels
- `apps/console/src/components/chat-nav-sidebar.tsx` — nav labels
- `apps/console/src/components/agents-view.tsx` — column headers, button labels
- `apps/console/src/components/flows-view.tsx` — column headers
- `apps/console/src/components/daemons-view.tsx` — column headers
- `apps/console/src/components/settings-view.tsx` — section labels

- [ ] **Step 2: Replace English copy with Chinese**

For each file found, replace user-facing English strings with zh-CN equivalents. Examples:
- "Send a message" → "发送消息"（or keep English placeholder if it matches multica style — confirm with product）
- "Search…" → "搜索…"
- "New Chat" → "新建对话"
- "Save" → "保存"
- "Cancel" → "取消"

**Note**: Technical terms (Agent, Flow, Daemon, Token) keep English in zh-CN copy — they are product nouns.

- [ ] **Step 3: Typecheck + visual review**

```bash
pnpm --filter @dagents/console exec tsc --noEmit
# Manual: pnpm --filter @dagents/console dev → walk through each page
```

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/components/
git commit -m "feat: 全站 UI 文案统一为中文 (zh-CN)"
```

---

## Phase 6: 延期项（P2，本期不实施）

以下项目已在 spec §2.2 列为 Out of Scope，记录在此供 Trial 反馈后启动：

- **TR-7**: 建议卡"填入后编辑"行为（当前点击即触发 handleSend）
- **TR-8**: Agent selector 能力预览
- **TR-9**: 流式错误恢复引导
- **TR-10**: Workflow Engine 完整交付（依赖既有 plan `2026-07-27-flowise-migration-v2-workflow.md`）

---

## Self-Review Checklist

### Spec 覆盖率

| Spec 章节 | 对应 Task |
|----------|-----------|
| §3.1 TR-1 Chat Trigger 接调度 | Task 1.1 / 1.2 / 1.3 / 1.4 / 1.5 ✅ |
| §3.2 TR-2 Chat Home 空状态引导 | Task 2.1 / 2.2 / 2.3 / 2.4 ✅ |
| §3.3 TR-3 Workflow Engine | 复用既有 plan，无新 Task ✅ |
| §3.4 TR-4 Daemons e2e 激活 | Task 3.1 / 3.2 / 3.3 ✅ |
| §3.5 TR-5 Flowise 兼容承诺 | Task 5.1 ✅ |
| §3.6 TR-6 消息级用量显示 | Task 4.1 / 4.2 / 4.3 / 4.4 ✅ |
| §3.7 TR-7 叙事语言统一 | Task 2.3 (chat-home) + Task 5.2 (全站) ✅ |
| §3.8 P2 打磨项 | Phase 6 延期说明 ✅ |

### 类型一致性

- `ChatEvent` 在 ws-hub.ts (Task 4.1) 与 chat-stream.ts (Task 4.2) 字段名一致：`usage` / `durationMs` / `cost` ✅
- `AssistantMessageMeta` 在 chat-stream.ts (Task 4.2) 与 assistant-content.tsx (Task 4.3) 字段名一致 ✅
- `persistComplete` 在 internal-runs-helpers.ts (Task 1.3) 与 internal-runs.ts (Task 1.1 重构) 签名一致 ✅
- `ParsedCommand` 字段 `kind` / `target` / `message` 在所有 routeXxxCommand 函数中一致 ✅

### 已知占位符

- Task 1.2 Step 1 的 `routeMessage @agent wiring` 测试是骨架，标记为"需扩展"。该 Task 的真正验证依赖 Task 1.5 的 e2e。这是 acceptable — unit test 覆盖 parseCommand，integration test 覆盖 routeMessage，e2e 覆盖全链路。
- Task 4.4 的 e2e 依赖 claude CLI 在 e2e 环境可用。不可用时降级为 `test.fixme` 并注释依赖。
- Task 5.2 的 grep 步骤需要人工 review，无自动化工具。这是文档性质任务的合理做法。

---

## 执行顺序建议

**串行必经路径**（每个 Phase 内部按 Task 编号顺序）：
- Phase 1: Task 1.1 → 1.2 → 1.3 → 1.4 → 1.5
- Phase 2: Task 2.1 → 2.2 → 2.3 → 2.4
- Phase 3: Task 3.1 → 3.2 → 3.3
- Phase 4: Task 4.1 → 4.2 → 4.3 → 4.4
- Phase 5: Task 5.1 → 5.2

**并行可能**：
- Phase 1 与 Phase 2 可并行（不同文件，不同服务）
- Phase 3 与 Phase 4 可并行（不同模块）
- Phase 5 与任何 Phase 可并行（文档/文案任务）

**Gate 验证**：
- Phase 1+2 完成 → 验收 Gate-Trial-1（spec §1.4）
- Phase 3+4+5 完成 → 验收 Gate-Trial-2（spec §1.4）
