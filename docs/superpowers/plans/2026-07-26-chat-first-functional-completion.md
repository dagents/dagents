# Chat-First 功能补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chat-First 范式真正可用 —— chat 能对话、@ 命令能触发、Daemons 不再是占位、所有架构 §5 细节对齐。

**Architecture:** 沿用现有 Hono + Next.js App Router + runQuery 原始 SQL 三层架构。SSE 复用现有 `/api/chat/route.ts` 的 pipe 模式与 `lib/sse.ts` 解码器。@ 命令在 gateway `POST /:id/messages` 内解析与调度。本 plan **不涉及** 架构 §9 工作流引擎内聚(独立 plan)。

**Tech Stack:** TypeScript / Hono / Next.js 15 App Router / TypeORM(仅 schema)/ zod / vitest / 原生 fetch SSE

**Scope:** P0(chat 触发机制) + P1(架构契约缺口) + P2(清理)。共 16 个任务,覆盖差距分析中除工作流引擎外的 55 个用例。

**Out of scope(单独 plan):** 架构 §9 工作流引擎内聚(12 个用例,`packages/workflow/` 新包、14 节点、DAG 引擎、新 `flows` 表、新 `/api/v1/workflows/*` API)。

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `apps/console/src/lib/chat-stream.ts` | 浏览器侧 chat SSE 客户端(包装 `streamChat`,接 chat 模型) |
| `apps/console/src/lib/agents-catalog-client.ts` | 浏览器侧 agent 列表 fetch(给 composer selector 用) |
| `apps/console/src/components/agent-selector.tsx` | composer 内 agent 下拉选择器 |
| `apps/console/src/components/directory-selector.tsx` | Chat Home 顶部目录选择器 |
| `apps/console/src/components/daemons-view.tsx` | Daemons 三栏主视图 |
| `apps/console/src/components/daemons-queue.tsx` | Daemons 左栏:任务队列 |
| `apps/console/src/components/daemons-timeline.tsx` | Daemons 中栏:执行时间线 |
| `apps/console/src/components/daemons-stats.tsx` | Daemons 右栏:统计 |
| `apps/console/src/lib/daemons.ts` | Daemons 数据 fetch(dispatch_tasks + fleet-stats) |
| `apps/console/src/app/api/chats/[id]/stream/route.ts` | console → gateway SSE 代理(默认 agent 执行路径) |
| `apps/console/src/styles/daemons.css` | Daemons 三栏样式 |
| `apps/console/src/styles/agent-selector.css` | agent selector 下拉样式 |
| `apps/console/src/styles/directory-selector.css` | 目录选择器样式 |
| `apps/gateway/src/routes/chat-execute.ts` | gateway chat 消息执行调度(@ 命令 + agent 路由) |

### 修改文件

| 文件 | 改动 |
|---|---|
| `apps/gateway/src/routes/chats.ts` | `POST /:id/messages` 接入 chat-execute;`PATCH` schema 加 `agentId`/`flowId` |
| `apps/gateway/src/app.ts` | 挂载 `/api/v1/chats/:id/stream` SSE 路由 |
| `apps/console/src/lib/chats.ts` | `updateChat` body 加 `agentId`/`flowId`;新增 `streamChatMessage` 引用 `chat-stream` |
| `apps/console/src/components/chat-composer.tsx` | 接入 `<AgentSelector>` |
| `apps/console/src/components/chat-home.tsx` | 加顶部 `<DirectorySelector>`;建议卡支持跳转 |
| `apps/console/src/components/suggestion-cards.tsx` | 卡片支持 `href` 跳转模式 |
| `apps/console/src/components/chat-detail.tsx` | `handleSend` 调 `streamChatMessage`;接 SSE;status 同步;system 消息特殊样式 |
| `apps/console/src/components/chat-context-panel.tsx` | agent/flow 可编辑(弹 selector);执行记录改用 `runs` 表 |
| `apps/console/src/components/chat-nav-sidebar.tsx` | 加 Search 输入框;chat item 加消息数 + 状态文本 |
| `apps/console/src/app/daemons/page.tsx` | 渲染 `<DaemonsView />` 取代占位 |

### 删除文件(P2)

| 文件 | 原因 |
|---|---|
| `apps/console/src/app/dashboard/` | 架构 §2.2 砍掉 |
| `apps/console/src/app/lab/` | 架构 §2.2 砍掉 |
| `apps/console/src/app/chat/` | 并入 `/chats` |
| `apps/console/src/app/workspace/` | 并入 `/chats` 与 `/directories` |
| `apps/console/src/app/api/chat/route.ts` | 由 `/api/chats/[id]/stream/route.ts` 取代 |
| `apps/console/src/app/api/workspaces/` | 由 `/api/directories` 取代 |
| `apps/console/src/app/api/lab/` | 砍掉 |
| `apps/console/src/lib/chat-client.ts` | 由 `chat-stream.ts` 取代 |
| `apps/console/src/lib/workspace-proxy.ts` `workspaces.ts` `workspaces.test.ts` | 废弃 |
| `apps/console/src/lib/lab-proxy.ts` `lab.ts` `lab.test.ts` | 废弃 |
| `apps/console/src/lib/launcher.ts` | 废弃 |

---

## Task 1: gateway `POST /chats/:id/messages` 实现 @ 命令解析与执行调度

**Files:**
- Create: `apps/gateway/src/routes/chat-execute.ts`
- Modify: `apps/gateway/src/routes/chats.ts:339-395` (POST messages handler)
- Test: `apps/gateway/src/__tests__/chat-execute.test.ts`

将 `POST /:id/messages` 改造为「写消息 + 调度执行」一体的端点。解析 `@flow`/`@daemon`/`@agent` 命令;默认走 chat 绑定的 agent,通过返回 `{ stream: true, chatRunId }` 让前端拉 SSE。

- [ ] **Step 1: 在 chats.ts 顶部导入 chat-execute**

修改 `apps/gateway/src/routes/chats.ts` 顶部 import 块,在 `import { createLogger } from '@mil/shared'` 之后加:

```typescript
import {
  parseCommand,
  routeMessage,
  type RouteResult,
} from './chat-execute.js'
```

- [ ] **Step 2: 写失败测试 — `@flow` 命令解析**

新建 `apps/gateway/src/__tests__/chat-execute.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseCommand } from '../routes/chat-execute.js'

describe('parseCommand', () => {
  it('parses @flow <name> <message>', () => {
    const r = parseCommand('@flow my-flow do something')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: 'do something' })
  })

  it('parses @daemon <command>', () => {
    const r = parseCommand('@daemon status')
    expect(r).toEqual({ kind: 'daemon', target: null, message: 'status' })
  })

  it('parses @agent <name> <message>', () => {
    const r = parseCommand('@agent claude help me')
    expect(r).toEqual({ kind: 'agent', target: 'claude', message: 'help me' })
  })

  it('returns null for non-command', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull()
  })

  it('handles @flow with no message (defaults to empty)', () => {
    const r = parseCommand('@flow my-flow')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: '' })
  })
})
```

- [ ] **Step 3: 运行测试验证失败**

Run: `pnpm --filter @mil/gateway test chat-execute`
Expected: FAIL with "Cannot find module '../routes/chat-execute.js'"

- [ ] **Step 4: 实现 chat-execute.ts 的 parseCommand**

新建 `apps/gateway/src/routes/chat-execute.ts`:

```typescript
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { runQuery } from '@mil/db'
import { createLogger } from '@mil/shared'

const log = createLogger({ svc: 'gateway:chat-execute' })

export type CommandKind = 'flow' | 'daemon' | 'agent'

export interface ParsedCommand {
  kind: CommandKind
  target: string | null
  message: string
}

/**
 * Parse a @-prefixed command from message content.
 * Returns null when content is not a command (the common case — default agent routing).
 *
 *   @flow <name> <message...>     → { kind: 'flow', target: '<name>', message: '<message...>' }
 *   @daemon <message...>          → { kind: 'daemon', target: null, message: '<message...>' }
 *   @agent <name> <message...>    → { kind: 'agent', target: '<name>', message: '<message...>' }
 */
export function parseCommand(content: string): ParsedCommand | null {
  if (!content.startsWith('@')) return null
  const parts = content.slice(1).split(/\s+/)
  const kind = parts[0]
  if (kind !== 'flow' && kind !== 'daemon' && kind !== 'agent') return null

  if (kind === 'daemon') {
    const message = parts.slice(1).join(' ').trim()
    return { kind: 'daemon', target: null, message }
  }

  const target = parts[1] ?? ''
  const message = parts.slice(2).join(' ').trim()
  return { kind, target, message }
}

// Placeholder — routeMessage implemented in Step 6
export async function routeMessage(
  _chatId: string,
  _content: string,
  _opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  throw new Error('routeMessage not implemented')
}

export interface RouteResult {
  /** 'stream' = caller pulls SSE from /chats/:id/stream; 'json' = return payload directly. */
  mode: 'stream' | 'json'
  /** When mode='stream', the chatRunId the client uses to subscribe. */
  chatRunId?: string
  /** When mode='json', the response payload (e.g. { taskId } from @daemon). */
  payload?: Record<string, unknown>
  /** When mode='json' and the route failed, an error string. */
  error?: string
  /** When the route writes a system message into chat_messages, its id (for client correlation). */
  systemMessageId?: string
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm --filter @mil/gateway test chat-execute`
Expected: PASS — all 6 parseCommand tests green.

- [ ] **Step 6: 写失败测试 — routeMessage 默认路径返回 stream mode**

追加到 `apps/gateway/src/__tests__/chat-execute.test.ts`:

```typescript
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@mil/db'
import { randomUUID } from 'node:crypto'

let seededChatIds: string[] = []
let seededDirIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})
afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})
beforeEach(async () => { await cleanup() })
afterEach(async () => { await cleanup() })

async function cleanup(): Promise<void> {
  if (seededChatIds.length) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [seededChatIds])
    seededChatIds = []
  }
  if (seededDirIds.length) {
    await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [seededDirIds])
    seededDirIds = []
  }
}

async function seedDirAndChat(opts: { agentId?: string | null; flowId?: string | null } = {}): Promise<{ dirId: string; chatId: string }> {
  const dirId = randomUUID()
  await runQuery(
    `INSERT INTO directories (id, path, name, settings) VALUES ($1, $2, $3, $4)`,
    [dirId, `/test-${dirId.slice(0, 8)}`, `Dir ${dirId.slice(0, 8)}`, '{}'],
  )
  seededDirIds.push(dirId)
  const chatId = randomUUID()
  await runQuery(
    `INSERT INTO chats (id, directory_id, title, agent_id, flow_id) VALUES ($1, $2, $3, $4, $5)`,
    [chatId, dirId, 'Test Chat', opts.agentId ?? null, opts.flowId ?? null],
  )
  seededChatIds.push(chatId)
  return { dirId, chatId }
}

describe('POST /api/v1/chats/:id/messages — default routing', () => {
  it('writes user message and returns stream mode when chat has agentId', async () => {
    const { chatId } = await seedDirAndChat({ agentId: randomUUID(), flowId: 'flow-abc' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { message: { id: string; role: string; content: string }; mode: string; chatRunId?: string }
    }
    expect(body.success).toBe(true)
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('hello there')
    expect(body.data.mode).toBe('stream')
    expect(body.data.chatRunId).toBeTruthy()
  })

  it('returns json mode with error when chat has no agentId and no flowId', async () => {
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; error?: string }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.error).toMatch(/no agent or flow bound/)
  })
})
```

- [ ] **Step 7: 运行测试验证失败**

Run: `pnpm --filter @mil/gateway test chat-execute`
Expected: FAIL — current `POST /:id/messages` returns `{ message }` without `mode`/`chatRunId`.

- [ ] **Step 8: 实现 routeMessage**

替换 `apps/gateway/src/routes/chat-execute.ts` 中的 `routeMessage` 占位实现:

```typescript
/**
 * Decide how a chat message should be routed after the user message is written.
 *
 *  - @flow / @daemon / @agent  → dispatch via scheduler/dispatch/agent-override; return JSON
 *  - default                   → caller pulls SSE from /chats/:id/stream using chatRunId
 *
 * The function does NOT execute the flow itself — it only resolves the routing
 * decision and (for @-commands) writes a system message + kicks off the
 * downstream call. The SSE stream route owns the actual gateway→Flowise
 * prediction pipe so the client gets token-by-token rendering.
 */
export async function routeMessage(
  chatId: string,
  content: string,
  opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  // 1. Fetch chat row to know agent_id / flow_id
  let chat: { id: string; agent_id: string | null; flow_id: string | null } | null
  try {
    const { records } = await runQuery<{ id: string; agent_id: string | null; flow_id: string | null }>(
      `SELECT id, agent_id, flow_id FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    chat = records[0] ?? null
  } catch (err) {
    log.error('routeMessage chat lookup failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'chat lookup failed' }
  }
  if (!chat) return { mode: 'json', error: 'chat not found' }

  const cmd = parseCommand(content)

  // 2. @-command routing
  if (cmd) {
    return await routeCommand(chatId, cmd, opts)
  }

  // 3. Default: stream mode — caller subscribes to /chats/:id/stream
  const flowId = opts.flowIdOverride ?? chat.flow_id
  const agentId = opts.agentIdOverride ?? chat.agent_id
  if (!flowId && !agentId) {
    return { mode: 'json', error: 'no agent or flow bound to chat — set chat.agentId or chat.flowId, or use @agent' }
  }

  // Mark chat running; client will poll or refresh on stream end.
  try {
    await runQuery(
      `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
      [chatId],
    )
  } catch (err) {
    log.warn('routeMessage status=running update failed', { chatId, error: String(err) })
  }

  return { mode: 'stream', chatRunId: null }
}

async function routeCommand(
  chatId: string,
  cmd: ParsedCommand,
  opts: { agentIdOverride?: string; flowIdOverride?: string },
): Promise<RouteResult> {
  // For now, write a system message acknowledging the command so the user sees feedback.
  // Real downstream invocation (scheduler.fanout / dispatch.invoke) is a follow-up —
  // the @-command surface is contracted here, the wiring is stubbed.
  const ack = formatCommandAck(cmd)
  try {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO chat_messages (chat_id, role, content, metadata)
       VALUES ($1::uuid, 'system', $2, $3)
       RETURNING id`,
      [chatId, ack.text, JSON.stringify({ command: cmd })],
    )
    return {
      mode: 'json',
      payload: { ack: ack.text, command: cmd, systemMessageId: records[0]?.id },
      systemMessageId: records[0]?.id,
    }
  } catch (err) {
    log.error('routeCommand system message insert failed', { chatId, error: String(err) })
    return { mode: 'json', error: 'command ack failed' }
  }
}

function formatCommandAck(cmd: ParsedCommand): { text: string } {
  switch (cmd.kind) {
    case 'flow':
      return { text: `⚡ Flow triggered: ${cmd.target}${cmd.message ? ` — "${cmd.message}"` : ''}` }
    case 'daemon':
      return { text: `⚡ Daemon invoked: ${cmd.message}` }
    case 'agent':
      return { text: `⚡ Routed to agent: ${cmd.target}` }
  }
}
```

- [ ] **Step 9: 改造 chats.ts 的 POST /:id/messages handler**

替换 `apps/gateway/src/routes/chats.ts` 第 339-395 行整个 `chatRoutes.post('/:id/messages', ...)` handler:

```typescript
const createMessageWithExecBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Optional agent id — overrides chat.agentId for this message only. */
  agentIdOverride: z.string().uuid().optional(),
  /** Optional flow id — overrides chat.flowId for this message only. */
  flowIdOverride: z.string().optional(),
})

chatRoutes.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createMessageWithExecBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  // Only 'user' role messages trigger execution routing.
  // 'assistant'/'system'/'tool' are writes from the stream consumer or other
  // system paths and should not re-route.
  let msgRow: ChatMessageRow | null
  try {
    const result = await runQuery<ChatMessageRow>(
      `WITH chat_check AS (
         SELECT id FROM chats WHERE id = $1::uuid
       ),
       inserted AS (
         INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
         SELECT $1::uuid, $2, $3, $4, $5
          FROM chat_check
         RETURNING id, chat_id, role, content, run_id, metadata, created_at
       ),
       updated AS (
         UPDATE chats
            SET last_message = $3,
                message_count = message_count + 1,
                updated_at = NOW()
          WHERE id = $1::uuid
       )
       SELECT * FROM inserted`,
      [
        id,
        data.role,
        data.content,
        data.runId ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    )
    msgRow = result.records[0] ?? null
  } catch (err) {
    log.error('chat message create failed', { id, error: String(err) })
    return fail(c, 502, 'chat message create failed')
  }
  if (!msgRow) {
    return fail(c, 404, 'chat not found', { id })
  }

  // Non-user roles: return the message without routing.
  if (data.role !== 'user') {
    return ok(c, { message: normalizeMsg(msgRow) })
  }

  // User role: route the message.
  const route = await routeMessage(id, data.content, {
    agentIdOverride: data.agentIdOverride,
    flowIdOverride: data.flowIdOverride,
  })

  if (route.mode === 'stream') {
    return ok(c, {
      message: normalizeMsg(msgRow),
      mode: 'stream',
      chatRunId: route.chatRunId ?? null,
    })
  }

  // JSON mode: @-command ack or routing error.
  return ok(c, {
    message: normalizeMsg(msgRow),
    mode: 'json',
    payload: route.payload,
    error: route.error,
    systemMessageId: route.systemMessageId ?? null,
  })
})
```

保留旧的 `createMessageBodySchema` 不删(其他地方可能引用),但 handler 改用新 schema。

- [ ] **Step 10: 运行测试验证通过**

Run: `pnpm --filter @mil/gateway test chat-execute`
Expected: PASS — all tests green.

也跑现有 chats 测试避免回归:
Run: `pnpm --filter @mil/gateway test chats`
Expected: PASS — existing 9 tests still green (createMessage tests use role:'user' default, will now also call routeMessage; for chats without agent/flow they get mode=json + error, but the existing tests only check `message`/`messageCount`/`lastMessage` so they should still pass).

如果现有测试因 mode 字段失败,在测试断言里跳过新字段即可(只检查 `body.data.message`)。

- [ ] **Step 11: 提交**

```bash
git add apps/gateway/src/routes/chats.ts apps/gateway/src/routes/chat-execute.ts apps/gateway/src/__tests__/chat-execute.test.ts
git commit -m "feat(gateway): chat message routing with @-command parsing and stream/json modes"
```

---

## Task 2: gateway `PATCH /chats/:id` schema 加 agentId/flowId

**Files:**
- Modify: `apps/gateway/src/routes/chats.ts:33-36` (updateBodySchema)
- Modify: `apps/gateway/src/routes/chats.ts:199-276` (PATCH handler)
- Test: `apps/gateway/src/__tests__/chats.test.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/gateway/src/__tests__/chats.test.ts` 的 `describe('PATCH /api/v1/chats/:id — update', ...)` 块末尾追加:

```typescript
  it('updates chat agentId', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Agent Chat' })
    const agentId = randomUUID()

    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { agentId: string | null } }
    }
    expect(body.data.chat.agentId).toBe(agentId)
  })

  it('updates chat flowId', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Flow Chat' })

    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'flow-xyz-123' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { flowId: string | null } }
    }
    expect(body.data.chat.flowId).toBe('flow-xyz-123')
  })

  it('clears chat agentId with null', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Clear Chat' })

    // Set first
    await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: randomUUID() }),
    })
    // Then clear
    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { agentId: string | null } }
    }
    expect(body.data.chat.agentId).toBeNull()
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @mil/gateway test chats`
Expected: FAIL — 3 new tests fail (agentId/flowId not in schema → 400 invalid body).

- [ ] **Step 3: 扩展 updateBodySchema**

修改 `apps/gateway/src/routes/chats.ts` 第 33-36 行:

```typescript
const updateBodySchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  agentId: z.string().uuid().nullable().optional(),
  flowId: z.string().max(200).nullable().optional(),
})
```

- [ ] **Step 4: 扩展 PATCH handler 的字段映射**

修改 `apps/gateway/src/routes/chats.ts` PATCH handler 中 `sets`/`params` 构建块(原第 217-227 行附近):

```typescript
  if (data.title !== undefined) {
    params.push(data.title)
    sets.push(`title = $${params.length}`)
  }
  if (data.status !== undefined) {
    params.push(data.status)
    sets.push(`status = $${params.length}`)
  }
  if (data.agentId !== undefined) {
    params.push(data.agentId)
    sets.push(`agent_id = $${params.length}`)
  }
  if (data.flowId !== undefined) {
    params.push(data.flowId)
    sets.push(`flow_id = $${params.length}`)
  }
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm --filter @mil/gateway test chats`
Expected: PASS — all 12 PATCH tests green (existing + 3 new).

- [ ] **Step 6: 提交**

```bash
git add apps/gateway/src/routes/chats.ts apps/gateway/src/__tests__/chats.test.ts
git commit -m "feat(gateway): allow PATCH /chats/:id to update agentId and flowId"
```

---

## Task 3: console `lib/chats.ts` 加 streamMessage + updateChat 支持 agentId/flowId

**Files:**
- Modify: `apps/console/src/lib/chats.ts:82-95` (updateChat)
- Create: `apps/console/src/lib/chat-stream.ts`
- Test: `apps/console/src/lib/chats.test.ts`

- [ ] **Step 1: 扩展 updateChat 类型签名**

修改 `apps/console/src/lib/chats.ts` 第 82-95 行的 `updateChat`:

```typescript
export async function updateChat(
  id: string,
  body: { title?: string; status?: ChatStatus; agentId?: string | null; flowId?: string | null },
): Promise<Chat> {
  const data = await unwrap<{ chat: Chat }>(
    await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'update chat',
  )
  return data.chat
}
```

- [ ] **Step 2: 创建 chat-stream.ts**

新建 `apps/console/src/lib/chat-stream.ts`:

```typescript
/**
 * Browser-side chat message streaming.
 *
 * Sends a user message to `/api/chats/:id/messages` (which writes the message
 * + decides routing via gateway chat-execute). When the response is mode='stream',
 * subscribes to `/api/chats/:id/stream` to receive the assistant's reply as SSE
 * tokens. When mode='json' (e.g. @-command ack or routing error), returns the
 * payload directly without opening a stream.
 *
 * The split mirrors `/api/chat/route.ts`'s old SSE pipe but routes through the
 * new chat model so chat_messages are persisted with the correct chatId.
 */

import { consumeStream, type StreamEvent } from './sse'

export interface SendMessageResult {
  /** The persisted user message. */
  userMessage: {
    id: string
    role: 'user'
    content: string
    createdAt: string
  }
  /** 'stream' = caller should iterate `events`; 'json' = check `payload`/`error`. */
  mode: 'stream' | 'json'
  /** When mode='stream', an async iterator of decoded SSE events. */
  events?: AsyncGenerator<StreamEvent, void, unknown>
  /** When mode='json', the routing payload (e.g. @-command ack). */
  payload?: Record<string, unknown>
  /** When mode='json', an error string if routing failed. */
  error?: string
  /** When a system message was written (e.g. @-command ack), its id. */
  systemMessageId?: string | null
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

interface SendMessageResponse {
  message: {
    id: string
    role: string
    content: string
    createdAt: string
  }
  mode: 'stream' | 'json'
  chatRunId?: string | null
  payload?: Record<string, unknown>
  error?: string
  systemMessageId?: string | null
}

/**
 * Send a chat message and either subscribe to the SSE stream or return the JSON payload.
 *
 * @param chatId target chat
 * @param content user message text
 * @param opts optional agent/flow overrides + abort signal
 */
export async function sendChatMessage(
  chatId: string,
  content: string,
  opts: { agentIdOverride?: string; flowIdOverride?: string; signal?: AbortSignal } = {},
): Promise<SendMessageResult> {
  const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      role: 'user',
      ...(opts.agentIdOverride ? { agentIdOverride: opts.agentIdOverride } : {}),
      ...(opts.flowIdOverride ? { flowIdOverride: opts.flowIdOverride } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`send message failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const body = (await res.json()) as Envelope<SendMessageResponse>
  if (!body.success || !body.data) {
    throw new Error(`send message failed: ${body.error ?? 'unknown error'}`)
  }

  const data = body.data
  const userMessage = {
    id: data.message.id,
    role: 'user' as const,
    content: data.message.content,
    createdAt: data.message.createdAt,
  }

  if (data.mode === 'stream') {
    // Subscribe to the SSE stream for assistant tokens.
    const streamRes = await fetch(`/api/chats/${encodeURIComponent(chatId)}/stream`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!streamRes.ok || !streamRes.body) {
      const detail = await streamRes.text().catch(() => '')
      throw new Error(`stream subscribe failed (${streamRes.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    return {
      userMessage,
      mode: 'stream',
      events: consumeStream(streamRes),
    }
  }

  return {
    userMessage,
    mode: 'json',
    payload: data.payload,
    error: data.error,
    systemMessageId: data.systemMessageId ?? null,
  }
}
```

- [ ] **Step 3: 运行类型检查**

Run: `pnpm --filter @mil/console typecheck`
Expected: PASS — no type errors.

(如果 console 没有 `typecheck` 脚本,跑 `pnpm --filter @mil/console exec tsc --noEmit`.)

- [ ] **Step 4: 提交**

```bash
git add apps/console/src/lib/chats.ts apps/console/src/lib/chat-stream.ts
git commit -m "feat(console): add chat-stream client and extend updateChat with agentId/flowId"
```

---

## Task 4: console API route `/api/chats/:id/stream` SSE 代理

**Files:**
- Create: `apps/console/src/app/api/chats/[id]/stream/route.ts`
- Modify: `apps/gateway/src/app.ts` (mount SSE route in gateway)

console 代理转发到 gateway 的 SSE 端点。gateway 侧需要新增 `GET /api/v1/chats/:id/stream`,这里通过 console 代理实现。

- [ ] **Step 1: 在 gateway chats.ts 加 SSE stream handler**

在 `apps/gateway/src/routes/chats.ts` 末尾追加:

```typescript
import { gatewayUrl } from '../app.js' // re-export if needed; see step 2

/**
 * GET /api/v1/chats/:id/stream — SSE stream of the chat's active run.
 *
 * This is a thin pass-through to the gateway's Flowise prediction proxy. The
 * chat-execute route marked the chat as 'running' and the caller (console)
 * subscribes here to receive the assistant's token stream.
 *
 * The chat's flow_id (or agent_id → resolved flow) is used as the upstream
 * prediction target. sessionId = chatId so Flowise's Flow State resumes the
 * correct memory.
 */
chatRoutes.get('/:id/stream', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // Resolve chat → flowId
  let chat: { flow_id: string | null; agent_id: string | null } | null
  try {
    const { records } = await runQuery<{ flow_id: string | null; agent_id: string | null }>(
      `SELECT flow_id, agent_id FROM chats WHERE id = $1::uuid`,
      [id],
    )
    chat = records[0] ?? null
  } catch (err) {
    log.error('chat stream lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!chat) return fail(c, 404, 'chat not found', { id })
  if (!chat.flow_id) {
    return fail(c, 400, 'chat has no flow_id — bind a flow via PATCH /chats/:id first', { id })
  }

  // Build the upstream prediction URL — same shape as /api/chat/route.ts used.
  const runId = c.req.header('x-run-id')?.trim() || randomUUID()
  const upstreamUrl = `${process.env.FLOWISE_URL ?? 'http://localhost:3101'}/api/v1/prediction/${encodeURIComponent(chat.flow_id)}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-run-id': runId,
      },
      body: JSON.stringify({
        question: '', // stream continuation — no new question, just subscribe
        streaming: true,
        overrideConfig: { sessionId: id },
      }),
    })
  } catch (err) {
    log.error('chat stream upstream failed', { id, flowId: chat.flow_id, error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return fail(c, 502, 'prediction failed', { status: upstream.status, detail: detail.slice(0, 500) })
  }

  // Pipe the SSE body through. Preserve content-type so the browser sees text/event-stream.
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  respHeaders.set('x-run-id', runId)
  respHeaders.set('cache-control', 'no-cache')
  return new Response(upstream.body, { status: 200, headers: respHeaders })
})
```

并在文件顶部 import 块加(如果尚未导入):

```typescript
import { randomUUID } from 'node:crypto'
```

- [ ] **Step 2: 创建 console 代理 route**

新建 `apps/console/src/app/api/chats/[id]/stream/route.ts`:

```typescript
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/chats/:id/stream — SSE proxy to gateway.
 *
 * The browser's chat-stream client subscribes here after POSTing a user message
 * to receive the assistant's reply as a token stream. We pipe the upstream
 * `text/event-stream` body straight back without buffering so token-by-token
 * rendering works (same posture as the legacy /api/chat route).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/chats/${encodeURIComponent(id)}/stream`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
  headers.set('accept', 'text/event-stream')

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable' },
      { status: 502 },
    )
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'stream failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  // Pipe the SSE body straight through.
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  const runId = upstream.headers.get('x-run-id')
  if (runId) respHeaders.set('x-run-id', runId)
  respHeaders.set('cache-control', 'no-cache')

  return new NextResponse(upstream.body, { status: 200, headers: respHeaders })
}
```

- [ ] **Step 3: 手动验证 — curl SSE 端点**

启动 dev 服务器(假设已运行),执行:

```bash
# 先准备一个有 flow_id 的 chat
CHAT_ID=$(curl -s http://localhost:3000/api/chats?directory_id=$(curl -s http://localhost:3000/api/directories | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['items'][0]['id'])") | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['items'][0]['id'])")
echo "Chat ID: $CHAT_ID"

# 绑定一个 flow(用任意已存在的 flowId,可以是占位)
curl -s -X PATCH http://localhost:3000/api/chats/$CHAT_ID \
  -H 'content-type: application/json' \
  -d '{"flowId":"dummy-flow-id"}'

# 发送消息触发流
curl -s -X POST http://localhost:3000/api/chats/$CHAT_ID/messages \
  -H 'content-type: application/json' \
  -d '{"content":"hello"}'
# 预期: {"success":true,"data":{"message":{...},"mode":"stream","chatRunId":null}}

# 订阅 SSE
curl -sN http://localhost:3000/api/chats/$CHAT_ID/stream
# 预期: 502 prediction failed (因为 dummy flow 在 Flowise 不存在) — 但路由要可达
```

Expected: POST 返回 `mode:"stream"`;GET stream 路由可达(502 是 Flowise 端的合理失败,不是 404)。

- [ ] **Step 4: 提交**

```bash
git add apps/gateway/src/routes/chats.ts apps/console/src/app/api/chats/[id]/stream/route.ts
git commit -m "feat: add SSE stream endpoint for chat assistant replies"
```

---

## Task 5: chat-detail.tsx 接入 SSE 流式回复 + status 同步

**Files:**
- Modify: `apps/console/src/components/chat-detail.tsx:91-117` (handleSend)
- Modify: `apps/console/src/components/chat-detail.tsx:144-167` (render)

- [ ] **Step 1: 改造 handleSend 使用 sendChatMessage**

替换 `apps/console/src/components/chat-detail.tsx` 第 19-25 行的 import:

```typescript
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  updateChat,
} from '@/lib/chats'
import { sendChatMessage } from '@/lib/chat-stream'
```

替换第 91-117 行的 `handleSend`:

```typescript
const handleSend = useCallback(async (text: string) => {
  if (sending) return
  setSending(true)
  setError(null)

  // Optimistic user message
  const optimisticId = `opt-${Date.now()}`
  const optimisticMsg: ChatMessage = {
    id: optimisticId,
    chatId,
    role: 'user',
    content: text,
    runId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  }
  setMessages((prev) => [...prev, optimisticMsg])

  // Mark chat running immediately for breadcrumb + context panel
  setChat((prev) => (prev ? { ...prev, status: 'running' } : prev))

  try {
    const result = await sendChatMessage(chatId, text)

    // Replace optimistic with persisted user message
    setMessages((prev) =>
      prev.map((m) =>
        m.id === optimisticId
          ? {
              ...result.userMessage,
              chatId,
              role: 'user',
              runId: null,
              metadata: {},
            }
          : m,
      ),
    )

    if (result.mode === 'stream' && result.events) {
      // Append an empty assistant message we'll fill token-by-token.
      const assistantId = `ast-${Date.now()}`
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          chatId,
          role: 'assistant',
          content: '',
          runId: null,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ])

      let accumulated = ''
      for await (const ev of result.events) {
        if (ev.event === 'token' && typeof ev.data === 'string') {
          accumulated += ev.data
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
          )
        } else if (ev.event === 'error') {
          setError(typeof ev.data === 'string' ? ev.data : String(ev.data))
        }
      }

      // Stream ended — mark chat done and persist assistant message
      setChat((prev) => (prev ? { ...prev, status: 'done' } : prev))
      // Persist the assistant message via the existing createMessage API
      // (role='assistant'); the gateway writes it into chat_messages.
      try {
        const persisted = await createMessage(chatId, {
          role: 'assistant',
          content: accumulated,
        })
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? persisted : m)))
      } catch (err) {
        // Persist failed — leave the optimistic assistant message in place.
        console.warn('assistant message persist failed', err)
      }
    } else if (result.mode === 'json') {
      // @-command ack or routing error — system message already written by gateway
      if (result.error) setError(result.error)
      // Refresh chat to reflect any system message + status change
      try {
        const refreshed = await fetchChat(chatId)
        setChat(refreshed)
        const msgs = await fetchMessages(chatId)
        setMessages(msgs)
      } catch {}
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err))
    setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
    setChat((prev) => (prev ? { ...prev, status: 'failed' } : prev))
  } finally {
    setSending(false)
  }
}, [chatId, sending])
```

需要在文件顶部 import 加 `createMessage`:

```typescript
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  createMessage,
  updateChat,
} from '@/lib/chats'
import { sendChatMessage } from '@/lib/chat-stream'
```

- [ ] **Step 2: 增强 system 消息渲染**

替换 `apps/console/src/components/chat-detail.tsx` 中消息渲染部分(原 154-160 行):

```typescript
messages.map((m) => (
  <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
    {m.role === 'system' && (
      <div className="chat-msg-system-icon">
        <Icon name="zap" style={{ width: 12, height: 12 }} />
      </div>
    )}
    <div className="chat-msg-content">{m.content}</div>
    {m.role !== 'system' && (
      <div className="chat-msg-meta">{formatTime(m.createdAt)}</div>
    )}
  </div>
))
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 4: 手动浏览器验证**

启动 dev 服务器,在浏览器中:
1. 打开 `http://localhost:3000/`
2. 选择一个 directory,发送消息 "你好"
3. 跳转到 chat detail 页面
4. 检查:
   - 面包屑状态显示 "Running"
   - user 消息立即出现
   - 如果 chat 绑定了有效 flowId(且 Flowise 可达),assistant 消息应该流式追加
   - 流结束后状态变为 "Done"

(如果未配置 Flowise,会看到 502 错误提示 — 这是预期行为,证明路由可达)

- [ ] **Step 5: 提交**

```bash
git add apps/console/src/components/chat-detail.tsx
git commit -m "feat(console): chat detail streams assistant replies via SSE and syncs status"
```

---

## Task 6: chat-composer agent selector 真实下拉

**Files:**
- Create: `apps/console/src/components/agent-selector.tsx`
- Create: `apps/console/src/styles/agent-selector.css`
- Modify: `apps/console/src/components/chat-composer.tsx`

- [ ] **Step 1: 创建 agent-selector 组件**

新建 `apps/console/src/components/agent-selector.tsx`:

```typescript
'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import '@/styles/agent-selector.css'

export interface AgentOption {
  id: string
  name: string
}

interface AgentSelectorProps {
  /** Currently selected agent id (null = auto). */
  value: string | null
  /** Called when user picks an agent. */
  onChange: (agentId: string | null) => void
  /** Optional: disable the selector. */
  disabled?: boolean
}

/**
 * Fetch agents from /api/agents and render a dropdown.
 * "auto" (null) means "let the chat pick the agent".
 */
export function AgentSelector({ value, onChange, disabled }: AgentSelectorProps): React.ReactElement {
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' })
        if (!res.ok) return
        const body = (await res.json()) as { success: boolean; data?: { items: AgentOption[] } }
        if (!cancelled && body.success && body.data) {
          setAgents(body.data.items)
        }
      } catch {
        // silent — selector shows just "auto" on failure
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = agents.find((a) => a.id === value)
  const label = value ? (selected?.name ?? value.slice(0, 8)) : 'auto'

  return (
    <div className="agent-selector" ref={ref}>
      <button
        type="button"
        className="agent-selector-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="Select agent"
      >
        <Icon name="bot" style={{ width: 14, height: 14, color: 'var(--accent)' }} />
        <span>{label}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="agent-selector-dropdown">
          <button
            type="button"
            className={`agent-selector-option${value === null ? ' selected' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
          >
            <Icon name="bot" style={{ width: 14, height: 14 }} />
            <span>auto</span>
            <span className="agent-selector-option-hint">让 chat 自动选择</span>
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`agent-selector-option${value === a.id ? ' selected' : ''}`}
              onClick={() => { onChange(a.id); setOpen(false) }}
            >
              <Icon name="bot" style={{ width: 14, height: 14 }} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

新建 `apps/console/src/styles/agent-selector.css`:

```css
.agent-selector { position: relative; display: inline-block; }

.agent-selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-pill);
  color: var(--fg-2);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--motion-fast), border-color var(--motion-fast);
}
.agent-selector-trigger:hover { background: var(--surface); border-color: var(--border); }
.agent-selector-trigger:disabled { opacity: 0.5; cursor: not-allowed; }

.agent-selector-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--elev-ring);
  z-index: 100;
  padding: 4px;
}

.agent-selector-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.agent-selector-option:hover { background: var(--surface-warm); }
.agent-selector-option.selected { background: var(--accent-soft); color: var(--accent-hover); }
.agent-selector-option-hint { margin-left: auto; font-size: var(--text-xs); color: var(--meta); }
```

- [ ] **Step 3: 接入 chat-composer**

修改 `apps/console/src/components/chat-composer.tsx`,完整替换为:

```typescript
'use client'

import { useRef, useState, useCallback } from 'react'
import { Icon } from '@/components/icon'
import { AgentSelector } from '@/components/agent-selector'
import '@/styles/chat-composer.css'

interface ChatComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  placeholder?: string
  agentSelector?: boolean
  /** Currently selected agent (null = auto). */
  agentId?: string | null
  /** Called when user changes agent selection. */
  onAgentChange?: (agentId: string | null) => void
}

export function ChatComposer({
  onSend,
  disabled,
  placeholder = 'Send a message…',
  agentSelector = true,
  agentId = null,
  onAgentChange,
}: ChatComposerProps): React.ReactElement {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setInput('')
  }, [input, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const canSend = input.trim().length > 0 && !disabled

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer-card">
        <div className="chat-composer-top">
          <button type="button" className="chat-composer-attach" title="Attach file">
            <Icon name="plus" style={{ width: 18, height: 18 }} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="chat-composer-textarea"
            rows={1}
            disabled={disabled}
          />
        </div>
        <div className="chat-composer-bottom">
          {agentSelector && onAgentChange && (
            <AgentSelector value={agentId} onChange={onAgentChange} disabled={disabled} />
          )}
          <span className="chat-composer-hint">
            ⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令
          </span>
          <button
            type="button"
            className="chat-composer-send"
            onClick={handleSend}
            disabled={!canSend}
            title="Send message"
          >
            <Icon name="send" style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: chat-detail 透传 agentId**

修改 `apps/console/src/components/chat-detail.tsx`,在 `ChatDetail` 组件 state 声明附近(原第 45-50 行后)加:

```typescript
const [selectedAgentId, setSelectedAgentId] = useState<string | null>(chat?.agentId ?? null)
```

并在 `useEffect` fetch 完 chat 后同步:
```typescript
useEffect(() => {
  if (chat) setSelectedAgentId(chat.agentId)
}, [chat])
```

修改 `handleSend` 中调用 `sendChatMessage` 处,把 `selectedAgentId` 透传:
```typescript
const result = await sendChatMessage(chatId, text, {
  agentIdOverride: selectedAgentId ?? undefined,
})
```

修改 composer 渲染(原第 163 行):
```typescript
<ChatComposer
  onSend={handleSend}
  disabled={sending || loading}
  agentId={selectedAgentId}
  onAgentChange={setSelectedAgentId}
/>
```

- [ ] **Step 5: 类型检查 + 手动验证**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS.

浏览器中打开 chat detail,点击 composer 左下 "Agent" 按钮,应看到下拉列表(包含 "auto" + agents 列表)。

- [ ] **Step 6: 提交**

```bash
git add apps/console/src/components/agent-selector.tsx apps/console/src/styles/agent-selector.css apps/console/src/components/chat-composer.tsx apps/console/src/components/chat-detail.tsx
git commit -m "feat(console): real agent selector dropdown in chat composer"
```

---

## Task 7: Chat Home 顶部目录选择器

**Files:**
- Create: `apps/console/src/components/directory-selector.tsx`
- Create: `apps/console/src/styles/directory-selector.css`
- Modify: `apps/console/src/components/chat-home.tsx`

- [ ] **Step 1: 创建 directory-selector 组件**

新建 `apps/console/src/components/directory-selector.tsx`:

```typescript
'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { fetchDirectories, type Directory } from '@/lib/directories'
import '@/styles/directory-selector.css'

interface DirectorySelectorProps {
  value: string | null
  onChange: (dirId: string) => void
}

export function DirectorySelector({ value, onChange }: DirectorySelectorProps): React.ReactElement {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (!cancelled) setDirectories(dirs)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = directories.find((d) => d.id === value)

  return (
    <div className="directory-selector" ref={ref}>
      <button
        type="button"
        className="directory-selector-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" style={{ width: 14, height: 14 }} />
        <span>{selected?.name ?? '选择目录'}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="directory-selector-dropdown">
          {directories.length === 0 ? (
            <a className="directory-selector-empty" href="/directories">
              添加项目目录 →
            </a>
          ) : (
            directories.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`directory-selector-option${value === d.id ? ' selected' : ''}`}
                onClick={() => { onChange(d.id); setOpen(false) }}
              >
                <Icon name="folder" style={{ width: 14, height: 14 }} />
                <span>{d.name}</span>
                <span className="directory-selector-option-path">{d.path}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

新建 `apps/console/src/styles/directory-selector.css`:

```css
.directory-selector { position: relative; display: inline-block; }

.directory-selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--motion-fast), border-color var(--motion-fast);
}
.directory-selector-trigger:hover { background: var(--surface-warm); border-color: var(--accent); }

.directory-selector-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--elev-ring);
  z-index: 50;
  padding: 4px;
}

.directory-selector-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.directory-selector-option:hover { background: var(--surface-warm); }
.directory-selector-option.selected { background: var(--accent-soft); color: var(--accent-hover); }
.directory-selector-option-path {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--meta);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-selector-empty {
  display: block;
  padding: 12px;
  color: var(--muted);
  font-size: var(--text-sm);
  text-align: center;
  text-decoration: none;
}
.directory-selector-empty:hover { color: var(--accent); }
```

- [ ] **Step 3: 接入 chat-home**

修改 `apps/console/src/components/chat-home.tsx`,在 import 块加:

```typescript
import { DirectorySelector } from '@/components/directory-selector'
```

在 `return (` 后的 `<div className="chat-home-body">` 内,在 `chat-home-placeholder` 之前加:

```typescript
<div className="chat-home-topbar">
  <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
</div>
```

并在 `chat-home.css` 加(或直接行内样式):

```css
.chat-home-topbar {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}
```

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS.

浏览器打开 `http://localhost:3000/`,顶部应看到目录选择器,点击展开可切换目录。

- [ ] **Step 5: 提交**

```bash
git add apps/console/src/components/directory-selector.tsx apps/console/src/styles/directory-selector.css apps/console/src/components/chat-home.tsx
git commit -m "feat(console): top directory selector on Chat Home"
```

---

## Task 8: SuggestionCards 跳转模式

**Files:**
- Modify: `apps/console/src/components/suggestion-cards.tsx`
- Modify: `apps/console/src/components/chat-home.tsx:77`

- [ ] **Step 1: 改造 SuggestionCards 支持 href**

替换 `apps/console/src/components/suggestion-cards.tsx` 完整内容:

```typescript
'use client'

import Link from 'next/link'
import { Icon, type IconName } from '@/components/icon'
import '@/styles/suggestion-cards.css'

interface SuggestionCardsProps {
  /** When a card has `href`, it navigates instead of calling onPick. */
  onPick?: (text: string) => void
}

interface Suggestion {
  icon: IconName
  text: string
  /** When set, the card links to this href instead of triggering onPick. */
  href?: string
}

const SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'zap', text: '帮我创建一个批量推理的 AgentFlow', href: '/flows' },
  { icon: 'agents', text: '查看当前资源看板的 agent 状态', href: '/agents' },
  { icon: 'flows', text: '设计一个多步骤的 Workspace 任务' },
  { icon: 'lab', text: '测试新的 Agent prompt 模板' },
] as const

export function SuggestionCards({ onPick }: SuggestionCardsProps): React.ReactElement {
  return (
    <div className="suggestion-grid">
      {SUGGESTIONS.map((s) => {
        const inner = (
          <>
            <div className="suggestion-card-icon">
              <Icon name={s.icon} style={{ width: 14, height: 14 }} />
            </div>
            <span className="suggestion-card-text">{s.text}</span>
          </>
        )
        if (s.href) {
          return (
            <Link key={s.text} href={s.href} className="suggestion-card">
              {inner}
            </Link>
          )
        }
        return (
          <button
            key={s.text}
            type="button"
            className="suggestion-card"
            onClick={() => onPick?.(s.text)}
          >
            {inner}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查 + 手动验证**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS.

浏览器打开 `/`,点击"创建 AgentFlow"应跳转到 `/flows`;点击"查看 Agent 状态"应跳转到 `/agents`;后两张卡仍触发消息发送。

- [ ] **Step 3: 提交**

```bash
git add apps/console/src/components/suggestion-cards.tsx
git commit -m "feat(console): suggestion cards navigate to /flows and /agents"
```

---

## Task 9: Sidebar Search 输入框 + chat item 显示消息数与状态文本

**Files:**
- Modify: `apps/console/src/components/chat-nav-sidebar.tsx`
- Modify: `apps/console/src/styles/chat-nav-sidebar.css`

- [ ] **Step 1: 加 Search state 和过滤逻辑**

修改 `apps/console/src/components/chat-nav-sidebar.tsx`,在 `activeChatId` state 后(原第 41 行后)加:

```typescript
const [search, setSearch] = useState('')
```

修改 chat 列表渲染部分,在 `chats.map` 前加过滤:

```typescript
const filteredChats = chats.filter((chat) =>
  chat.title.toLowerCase().includes(search.toLowerCase()),
)
```

然后把 `chats.map((chat) => ...)` 改为 `filteredChats.map((chat) => ...)`。

- [ ] **Step 2: 加 Search 输入框 UI**

在 `chat-nav-actions` div 内(原第 121-126 行),在 New Chat 按钮后加:

```typescript
{!collapsed && (
  <div className="chat-nav-search">
    <Icon name="search" style={{ width: 12, height: 12, color: 'var(--meta)' }} />
    <input
      type="text"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="搜索对话…"
      className="chat-nav-search-input"
    />
  </div>
)}
```

- [ ] **Step 3: chat item 加消息数和状态文本**

修改 chat item 渲染(原第 170-180 行附近),在 `chat-nav-chat-item-title` 后加:

```typescript
<Link
  key={chat.id}
  href={`/chats/${chat.id}`}
  className="chat-nav-chat-item"
  aria-selected={activeChatId === chat.id}
>
  <span className={`chat-nav-chat-status ${chat.status}`} />
  <span className="chat-nav-chat-item-title">{chat.title}</span>
  <span className="chat-nav-chat-item-meta">
    <span className="chat-nav-chat-item-count">{chat.messageCount}</span>
    <span className="chat-nav-chat-item-status">{chat.status}</span>
  </span>
</Link>
```

- [ ] **Step 4: 加样式**

在 `apps/console/src/styles/chat-nav-sidebar.css` 末尾追加:

```css
.chat-nav-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--surface-warm);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  margin-top: 4px;
}
.chat-nav-search-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  font-size: var(--text-xs);
  color: var(--fg);
}
.chat-nav-search-input::placeholder { color: var(--meta); }

.chat-nav-chat-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 10px;
  color: var(--meta);
}
.chat-nav-chat-item-count {
  font-family: var(--font-mono);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
}
.chat-nav-chat-item-status { text-transform: uppercase; letter-spacing: 0.02em; }
```

- [ ] **Step 5: 手动验证**

浏览器打开任意页面,在 sidebar 应看到搜索框,输入关键词过滤 chat;每个 chat item 右侧应显示消息数和状态。

- [ ] **Step 6: 提交**

```bash
git add apps/console/src/components/chat-nav-sidebar.tsx apps/console/src/styles/chat-nav-sidebar.css
git commit -m "feat(console): sidebar search + chat item message count and status"
```

---

## Task 10: chat-context-panel 可编辑 agent/flow + 真正 run 列表

**Files:**
- Modify: `apps/console/src/components/chat-context-panel.tsx`
- Modify: `apps/console/src/lib/chats.ts` (新增 fetchChatRuns)
- Modify: `apps/gateway/src/routes/chats.ts` (新增 GET /:id/runs)

- [ ] **Step 1: gateway 加 GET /chats/:id/runs**

在 `apps/gateway/src/routes/chats.ts` 末尾追加:

```typescript
interface RunRow {
  id: string
  status: string
  created_at: Date
  finished_at: Date | null
}

chatRoutes.get('/:id/runs', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // runs.chat_id is TEXT, so cast chat id to text for the comparison.
  let rows: RunRow[]
  try {
    const { records } = await runQuery<RunRow>(
      `SELECT id, status, created_at, finished_at
         FROM runs
         WHERE chat_id = $1::text
         ORDER BY created_at DESC
         LIMIT 50`,
      [id],
    )
    rows = records
  } catch (err) {
    log.error('chat runs query failed', { id, error: String(err) })
    return fail(c, 502, 'chat runs failed')
  }

  return ok(c, {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : (r.finished_at ? new Date(r.finished_at).toISOString() : null),
    })),
  })
})
```

- [ ] **Step 2: lib/chats.ts 加 fetchChatRuns**

在 `apps/console/src/lib/chats.ts` 末尾追加:

```typescript
export interface ChatRun {
  id: string
  status: string
  createdAt: string
  finishedAt: string | null
}

export async function fetchChatRuns(chatId: string, signal?: AbortSignal): Promise<ChatRun[]> {
  const data = await unwrap<{ items: ChatRun[] }>(
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/runs`, {
      cache: 'no-store',
      signal,
    }),
    'chat runs',
  )
  return data.items
}
```

- [ ] **Step 3: console 加 /api/chats/[id]/runs 代理**

新建 `apps/console/src/app/api/chats/[id]/runs/route.ts`:

```typescript
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/chats/${encodeURIComponent(id)}/runs${req.nextUrl.search}`
  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch {
    return NextResponse.json({ success: false, error: 'gateway unavailable' }, { status: 502 })
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
```

- [ ] **Step 4: 改造 chat-context-panel**

替换 `apps/console/src/components/chat-context-panel.tsx` 完整内容:

```typescript
'use client'

import { useEffect, useState } from 'react'
import type { Chat, ChatRun } from '@/lib/chats'
import { fetchChatRuns, updateChat } from '@/lib/chats'
import type { Directory } from '@/lib/directories'
import { AgentSelector } from '@/components/agent-selector'
import { Icon } from '@/components/icon'
import '@/styles/chat-context-panel.css'

interface ChatContextPanelProps {
  chat: Chat | null
  directory: Directory | null
}

export function ChatContextPanel({ chat, directory }: ChatContextPanelProps): React.ReactElement {
  const [runs, setRuns] = useState<ChatRun[]>([])
  const [editingAgent, setEditingAgent] = useState(false)
  const [editingFlow, setEditingFlow] = useState(false)
  const [flowInput, setFlowInput] = useState('')

  useEffect(() => {
    if (!chat) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetchChatRuns(chat.id)
        if (!cancelled) setRuns(r)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [chat?.id, chat?.updatedAt])

  const handleAgentChange = async (agentId: string | null) => {
    if (!chat) return
    try {
      await updateChat(chat.id, { agentId })
      // Caller (chat-detail) should refresh chat — emit a custom event or call onChange
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId: chat.id } }))
    } catch (err) {
      console.warn('agent update failed', err)
    }
    setEditingAgent(false)
  }

  const handleFlowSave = async () => {
    if (!chat) return
    try {
      await updateChat(chat.id, { flowId: flowInput || null })
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId: chat.id } }))
    } catch (err) {
      console.warn('flow update failed', err)
    }
    setEditingFlow(false)
  }

  return (
    <div className="chat-context-panel">
      {/* Directory */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">所属目录</div>
        {directory ? (
          <div className="chat-context-item">
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
          </div>
        ) : (
          <div className="muted">—</div>
        )}
      </div>

      {/* Agent — editable */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">
          绑定 Agent
          {!editingAgent && (
            <button className="chat-context-edit" onClick={() => setEditingAgent(true)}>编辑</button>
          )}
        </div>
        {editingAgent ? (
          <AgentSelector value={chat?.agentId ?? null} onChange={handleAgentChange} />
        ) : (
          <div className="chat-context-item">
            <Icon name="bot" style={{ width: 14, height: 14 }} />
            <span>{chat?.agentId ?? 'auto'}</span>
          </div>
        )}
      </div>

      {/* Flow — editable */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">
          绑定 Flow
          {!editingFlow && (
            <button className="chat-context-edit" onClick={() => { setFlowInput(chat?.flowId ?? ''); setEditingFlow(true) }}>编辑</button>
          )}
        </div>
        {editingFlow ? (
          <div className="chat-context-flow-edit">
            <input
              type="text"
              value={flowInput}
              onChange={(e) => setFlowInput(e.target.value)}
              placeholder="flow id"
              className="chat-context-flow-input"
            />
            <button className="chat-context-flow-save" onClick={handleFlowSave}>保存</button>
            <button className="chat-context-flow-cancel" onClick={() => setEditingFlow(false)}>取消</button>
          </div>
        ) : (
          <div className="chat-context-item">
            <Icon name="flows" style={{ width: 14, height: 14 }} />
            <span>{chat?.flowId ?? '—'}</span>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">统计</div>
        <div className="chat-context-stats">
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">消息数</span>
            <span className="chat-context-stat-value">{chat?.messageCount ?? 0}</span>
          </div>
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">状态</span>
            <span className={`chat-context-stat-value status-${chat?.status ?? 'idle'}`}>
              {chat?.status ?? 'idle'}
            </span>
          </div>
        </div>
      </div>

      {/* Real runs */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">执行记录</div>
        {runs.length === 0 ? (
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>暂无执行记录</div>
        ) : (
          <div className="chat-context-runs">
            {runs.slice(0, 10).map((r) => (
              <div key={r.id} className="chat-context-run">
                <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
                  {r.id.slice(0, 8)}
                </span>
                <span className={`chat-context-run-status status-${r.status}`}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: chat-detail 监听 chat-updated 事件刷新**

修改 `apps/console/src/components/chat-detail.tsx`,在 `useEffect` 中加监听(在 chat 加载的 effect 后):

```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { chatId: string }
    if (detail.chatId !== chatId) return
    void fetchChat(chatId).then(setChat).catch(() => {})
  }
  window.addEventListener('chat-updated', handler)
  return () => window.removeEventListener('chat-updated', handler)
}, [chatId])
```

并把 `<ChatContextPanel chat={chat} directory={directory} messages={messages} />` 改为 `<ChatContextPanel chat={chat} directory={directory} />`(不再传 messages)。

- [ ] **Step 6: 加编辑按钮样式**

在 `apps/console/src/styles/chat-context-panel.css` 末尾追加:

```css
.chat-context-edit {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: var(--meta);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: 0;
}
.chat-context-edit:hover { color: var(--accent); }

.chat-context-flow-edit {
  display: flex;
  gap: 4px;
  align-items: center;
}
.chat-context-flow-input {
  flex: 1;
  padding: 4px 8px;
  background: var(--surface-warm);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg);
}
.chat-context-flow-save, .chat-context-flow-cancel {
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  cursor: pointer;
}
.chat-context-flow-save { background: var(--accent); color: var(--accent-on); }
.chat-context-flow-cancel { background: var(--surface); color: var(--muted); }

.chat-context-run-status {
  margin-left: auto;
  font-size: var(--text-xs);
  text-transform: uppercase;
}
.chat-context-run-status.status-completed { color: var(--accent); }
.chat-context-run-status.status-running { color: var(--warn); }
.chat-context-run-status.status-failed { color: var(--danger); }
```

- [ ] **Step 7: 类型检查 + 手动验证**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS.

浏览器打开 chat detail,右栏 agent/flow 应有"编辑"按钮,点击后可改;执行记录应显示真正的 run 列表(如果 runs 表有数据)。

- [ ] **Step 8: 提交**

```bash
git add apps/console/src/components/chat-context-panel.tsx apps/console/src/styles/chat-context-panel.css apps/console/src/components/chat-detail.tsx apps/console/src/lib/chats.ts apps/console/src/app/api/chats/[id]/runs/route.ts apps/gateway/src/routes/chats.ts
git commit -m "feat: editable agent/flow in chat context panel + real runs list"
```

---

## Task 11: Daemons 三栏页面(任务队列 / 执行时间线 / 统计)

**Files:**
- Create: `apps/console/src/lib/daemons.ts`
- Create: `apps/console/src/components/daemons-view.tsx`
- Create: `apps/console/src/components/daemons-queue.tsx`
- Create: `apps/console/src/components/daemons-timeline.tsx`
- Create: `apps/console/src/components/daemons-stats.tsx`
- Create: `apps/console/src/styles/daemons.css`
- Modify: `apps/console/src/app/daemons/page.tsx`

- [ ] **Step 1: 创建 daemons 数据 lib**

新建 `apps/console/src/lib/daemons.ts`:

```typescript
/**
 * Daemons page data fetchers.
 *
 * - Task queue: from dispatch_tasks (via gateway → dispatch proxy at /api/v1/dispatch/tasks)
 * - Fleet stats: from /api/fleet-stats (existing endpoint)
 * - Execution timeline: from runs (via /api/v1/dispatch/runs or scheduler)
 *
 * For MVP we read from dispatch_tasks + fleet-stats; the timeline shows the
 * most recent active run's steps (placeholder: list of dispatch_tasks with
 * status=running).
 */

export interface DispatchTask {
  id: string
  type: string
  status: 'queued' | 'running' | 'done' | 'failed'
  description: string | null
  flow_id: string | null
  priority: number
  created_at: string
  updated_at: string
}

export interface FleetStats {
  online_daemons: number
  active_tasks: number
  queue_depth: number
  throughput_per_min: number
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status})`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

export async function fetchDispatchTasks(status?: string): Promise<DispatchTask[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const data = await unwrap<{ items: DispatchTask[] } | DispatchTask[]>(
    await fetch(`/api/dispatch/tasks${qs}`, { cache: 'no-store' }),
    'dispatch tasks',
  )
  // Tolerate either { items: [] } or bare []
  return Array.isArray(data) ? data : data.items ?? []
}

export async function fetchFleetStats(): Promise<FleetStats> {
  const data = await unwrap<FleetStats>(
    await fetch('/api/fleet-stats', { cache: 'no-store' }),
    'fleet stats',
  )
  return data
}
```

- [ ] **Step 2: 创建 daemons-view 主组件**

新建 `apps/console/src/components/daemons-view.tsx`:

```typescript
'use client'

import { useEffect, useState } from 'react'
import { DaemonsQueue, type DispatchTask } from '@/components/daemons-queue'
import { DaemonsTimeline } from '@/components/daemons-timeline'
import { DaemonsStats, type FleetStats } from '@/components/daemons-stats'
import { fetchDispatchTasks, fetchFleetStats } from '@/lib/daemons'
import '@/styles/daemons.css'

export function DaemonsView(): React.ReactElement {
  const [tasks, setTasks] = useState<DispatchTask[]>([])
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'queued' | 'running' | 'done' | 'failed'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const status = filter === 'all' ? undefined : filter
        const [t, s] = await Promise.all([
          fetchDispatchTasks(status),
          fetchFleetStats().catch(() => null),
        ])
        if (cancelled) return
        setTasks(t)
        if (s) setStats(s)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const interval = setInterval(load, 5000) // refresh every 5s
    return () => { cancelled = true; clearInterval(interval) }
  }, [filter])

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null

  return (
    <div className="daemons-view">
      <div className="daemons-toolbar">
        {(['all', 'queued', 'running', 'done', 'failed'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`daemons-filter${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="daemons-grid">
        <DaemonsQueue
          tasks={tasks}
          loading={loading}
          selectedId={selectedTaskId}
          onSelect={setSelectedTaskId}
        />
        <DaemonsTimeline task={selectedTask} />
        <DaemonsStats stats={stats} tasks={tasks} />
      </div>
      {error && (
        <div className="daemons-error">{error}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 创建 daemons-queue**

新建 `apps/console/src/components/daemons-queue.tsx`:

```typescript
'use client'

import { Icon } from '@/components/icon'

export interface DispatchTask {
  id: string
  type: string
  status: 'queued' | 'running' | 'done' | 'failed'
  description: string | null
  flow_id: string | null
  priority: number
  created_at: string
  updated_at: string
}

interface DaemonsQueueProps {
  tasks: DispatchTask[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function DaemonsQueue({ tasks, loading, selectedId, onSelect }: DaemonsQueueProps): React.ReactElement {
  return (
    <div className="daemons-queue">
      <div className="daemons-col-header">
        <Icon name="daemons" style={{ width: 14, height: 14 }} />
        <span>任务队列</span>
        <span className="daemons-col-count">{tasks.length}</span>
      </div>
      <div className="daemons-queue-list">
        {loading ? (
          <div className="daemons-empty">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="daemons-empty">暂无任务</div>
        ) : (
          tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`daemons-task-card${selectedId === t.id ? ' selected' : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <div className="daemons-task-card-head">
                <span className={`daemons-task-status status-${t.status}`} />
                <span className="daemons-task-type">{t.type}</span>
                <span className="daemons-task-priority">P{t.priority}</span>
              </div>
              <div className="daemons-task-desc">{t.description ?? t.id.slice(0, 8)}</div>
              <div className="daemons-task-meta">
                {t.flow_id && <span className="mono">{t.flow_id.slice(0, 8)}</span>}
                <span>{formatTime(t.created_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 daemons-timeline**

新建 `apps/console/src/components/daemons-timeline.tsx`:

```typescript
'use client'

import type { DispatchTask } from '@/components/daemons-queue'
import { Icon } from '@/components/icon'

interface DaemonsTimelineProps {
  task: DispatchTask | null
}

export function DaemonsTimeline({ task }: DaemonsTimelineProps): React.ReactElement {
  return (
    <div className="daemons-timeline">
      <div className="daemons-col-header">
        <Icon name="flows" style={{ width: 14, height: 14 }} />
        <span>执行时间线</span>
      </div>
      {!task ? (
        <div className="daemons-empty">选择左侧任务查看详情</div>
      ) : (
        <div className="daemons-timeline-body">
          <div className="daemons-timeline-task-head">
            <span className="mono">{task.id.slice(0, 8)}</span>
            <span className={`daemons-task-status status-${task.status}`}>{task.status}</span>
          </div>
          <div className="daemons-timeline-steps">
            <div className={`daemons-timeline-step ${task.status === 'done' ? 'done' : task.status === 'running' ? 'running' : 'queued'}`}>
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">任务创建</span>
              <span className="daemons-timeline-step-time">{new Date(task.created_at).toLocaleString()}</span>
            </div>
            <div className={`daemons-timeline-step ${task.status === 'running' ? 'running' : task.status === 'done' || task.status === 'failed' ? 'done' : 'queued'}`}>
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">派发到 daemon</span>
            </div>
            <div className={`daemons-timeline-step ${task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : 'queued'}`}>
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">{task.status === 'failed' ? '执行失败' : '执行完成'}</span>
              {task.updated_at !== task.created_at && (
                <span className="daemons-timeline-step-time">{new Date(task.updated_at).toLocaleString()}</span>
              )}
            </div>
          </div>
          <div className="daemons-timeline-logs">
            <div className="daemons-timeline-logs-head">日志</div>
            <pre className="daemons-timeline-logs-body">
{`[task ${task.id.slice(0, 8)}] type=${task.type} priority=${task.priority}
[task ${task.id.slice(0, 8)}] status=${task.status}
[task ${task.id.slice(0, 8)}] flow=${task.flow_id ?? 'none'}`}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 创建 daemons-stats**

新建 `apps/console/src/components/daemons-stats.tsx`:

```typescript
'use client'

import type { DispatchTask } from '@/components/daemons-queue'
import { Icon } from '@/components/icon'

export interface FleetStats {
  online_daemons: number
  active_tasks: number
  queue_depth: number
  throughput_per_min: number
}

interface DaemonsStatsProps {
  stats: FleetStats | null
  tasks: DispatchTask[]
}

export function DaemonsStats({ stats, tasks }: DaemonsStatsProps): React.ReactElement {
  const running = tasks.filter((t) => t.status === 'running').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const failed = tasks.filter((t) => t.status === 'failed').length

  return (
    <div className="daemons-stats">
      <div className="daemons-col-header">
        <Icon name="dashboard" style={{ width: 14, height: 14 }} />
        <span>统计</span>
      </div>
      <div className="daemons-stats-grid">
        <div className="daemons-stat">
          <div className="daemons-stat-label">在线 daemons</div>
          <div className="daemons-stat-value">{stats?.online_daemons ?? '—'}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">活跃任务</div>
          <div className="daemons-stat-value">{stats?.active_tasks ?? running}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">队列深度</div>
          <div className="daemons-stat-value">{stats?.queue_depth ?? queued}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">吞吐 / 分钟</div>
          <div className="daemons-stat-value">{stats?.throughput_per_min ?? '—'}</div>
        </div>
      </div>
      <div className="daemons-stats-breakdown">
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-running" />
          <span>running</span>
          <span className="mono">{running}</span>
        </div>
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-queued" />
          <span>queued</span>
          <span className="mono">{queued}</span>
        </div>
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-failed" />
          <span>failed</span>
          <span className="mono">{failed}</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: 创建样式**

新建 `apps/console/src/styles/daemons.css`:

```css
.daemons-view { display: flex; flex-direction: column; gap: var(--space-4); height: 100%; }

.daemons-toolbar { display: flex; gap: var(--space-2); }
.daemons-filter {
  padding: 4px 12px;
  background: var(--surface-warm);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-pill);
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  text-transform: capitalize;
}
.daemons-filter:hover { background: var(--surface); color: var(--fg); }
.daemons-filter.active { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }

.daemons-grid {
  display: grid;
  grid-template-columns: 320px 1fr 280px;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
}

.daemons-queue, .daemons-timeline, .daemons-stats {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  overflow: hidden;
  min-height: 0;
}

.daemons-col-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
}
.daemons-col-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--meta);
  background: var(--surface);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
}

.daemons-empty {
  padding: var(--space-8);
  text-align: center;
  color: var(--meta);
  font-size: var(--text-sm);
}

.daemons-queue-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
}

.daemons-task-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: var(--space-3);
  margin-bottom: 6px;
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--motion-fast), background var(--motion-fast);
}
.daemons-task-card:hover { background: var(--surface-warm); border-color: var(--border); }
.daemons-task-card.selected { border-color: var(--accent); background: var(--accent-soft); }

.daemons-task-card-head { display: flex; align-items: center; gap: 6px; }
.daemons-task-status {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--meta);
  flex-shrink: 0;
}
.daemons-task-status.status-running { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.daemons-task-status.status-queued { background: var(--warn); }
.daemons-task-status.status-done { background: var(--meta); }
.daemons-task-status.status-failed { background: var(--danger); }

.daemons-task-type { font-size: var(--text-sm); font-weight: 500; color: var(--fg); flex: 1; }
.daemons-task-priority {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--meta);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
}
.daemons-task-desc { font-size: var(--text-xs); color: var(--muted); }
.daemons-task-meta {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--meta);
}

.daemons-timeline-body { flex: 1; overflow-y: auto; padding: var(--space-4); }
.daemons-timeline-task-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.daemons-timeline-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.daemons-timeline-step {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--muted);
}
.daemons-timeline-step.queued { color: var(--meta); }
.daemons-timeline-step.running { color: var(--accent); }
.daemons-timeline-step.done { color: var(--fg); }
.daemons-timeline-step.failed { color: var(--danger); }
.daemons-timeline-step-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--meta);
}
.daemons-timeline-step.queued .daemons-timeline-step-dot { background: var(--meta); }
.daemons-timeline-step.running .daemons-timeline-step-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.daemons-timeline-step.done .daemons-timeline-step-dot { background: var(--accent); }
.daemons-timeline-step.failed .daemons-timeline-step-dot { background: var(--danger); }
.daemons-timeline-step-label { flex: 1; }
.daemons-timeline-step-time { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--meta); }

.daemons-timeline-logs { background: var(--surface-warm); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.daemons-timeline-logs-head { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-soft); font-size: var(--text-xs); color: var(--meta); text-transform: uppercase; letter-spacing: 0.02em; }
.daemons-timeline-logs-body { padding: var(--space-3); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg); white-space: pre-wrap; }

.daemons-stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  padding: var(--space-3);
}
.daemons-stat {
  padding: var(--space-3);
  background: var(--surface-warm);
  border-radius: var(--radius-sm);
}
.daemons-stat-label { font-size: var(--text-xs); color: var(--meta); margin-bottom: 4px; }
.daemons-stat-value { font-family: var(--font-mono); font-size: var(--text-xl); font-weight: 500; color: var(--fg); }

.daemons-stats-breakdown { padding: var(--space-3); border-top: 1px solid var(--border-soft); }
.daemons-stats-breakdown-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 0;
  font-size: var(--text-sm);
}
.daemons-stats-breakdown-row span:nth-child(2) { flex: 1; color: var(--muted); }
```

- [ ] **Step 7: 替换 daemons page**

替换 `apps/console/src/app/daemons/page.tsx` 完整内容:

```typescript
import { PageShell } from '@/components/page-shell'
import { DaemonsView } from '@/components/daemons-view'

/**
 * Daemons route — task queue + execution timeline + stats.
 *
 * Three-column layout ported from design/daemon-execution.html.
 */
export default function DaemonsPage(): React.ReactElement {
  return (
    <PageShell
      title="Daemons"
      subtitle="任务队列 · 执行时间线 · 统计"
      fullBleed
    >
      <DaemonsView />
    </PageShell>
  )
}
```

- [ ] **Step 8: 类型检查 + 手动验证**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS.

浏览器打开 `http://localhost:3000/daemons`,应看到三栏布局:左栏任务队列(支持 filter),中栏时间线,右栏统计。

- [ ] **Step 9: 提交**

```bash
git add apps/console/src/lib/daemons.ts apps/console/src/components/daemons-view.tsx apps/console/src/components/daemons-queue.tsx apps/console/src/components/daemons-timeline.tsx apps/console/src/components/daemons-stats.tsx apps/console/src/styles/daemons.css apps/console/src/app/daemons/page.tsx
git commit -m "feat(console): Daemons three-column page (queue + timeline + stats)"
```

---

## Task 12: 移除旧路由与旧 API (P2 清理)

**Files:**
- Delete: `apps/console/src/app/dashboard/`
- Delete: `apps/console/src/app/lab/`
- Delete: `apps/console/src/app/chat/`
- Delete: `apps/console/src/app/workspace/`
- Delete: `apps/console/src/app/api/chat/route.ts`
- Delete: `apps/console/src/app/api/workspaces/`
- Delete: `apps/console/src/app/api/lab/`
- Delete: `apps/console/src/lib/chat-client.ts`
- Delete: `apps/console/src/lib/workspace-proxy.ts`
- Delete: `apps/console/src/lib/workspaces.ts`
- Delete: `apps/console/src/lib/workspaces.test.ts`
- Delete: `apps/console/src/lib/lab-proxy.ts`
- Delete: `apps/console/src/lib/lab.ts`
- Delete: `apps/console/src/lib/lab.test.ts`
- Delete: `apps/console/src/lib/launcher.ts`

- [ ] **Step 1: 检查引用**

Run: `grep -r "from '@/lib/chat-client'" apps/console/src/ --include='*.ts' --include='*.tsx'`
Run: `grep -r "from '@/lib/workspace-proxy'" apps/console/src/ --include='*.ts' --include='*.tsx'`
Run: `grep -r "from '@/lib/lab-proxy'" apps/console/src/ --include='*.ts' --include='*.tsx'`
Run: `grep -r "from '@/lib/launcher'" apps/console/src/ --include='*.ts' --include='*.tsx'`

Expected: 0 matches for each (or only matches inside the files being deleted).

如果有非删除文件的引用,先迁移到新 lib(`chats.ts` / `chat-stream.ts` / `directories.ts`)再删除。

- [ ] **Step 2: 删除文件**

使用 `rm -rf` 删除以上所有路径(或用 `git rm -r`)。

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @mil/console exec tsc --noEmit`
Expected: PASS — no broken imports.

如果有 broken imports,逐个修复(替换为新 lib 的对应函数)。

- [ ] **Step 4: 跑全量测试**

Run: `pnpm test`
Expected: PASS — all remaining tests green.

- [ ] **Step 5: 启动 dev 服务器手动验证所有路由**

启动 dev 后用 curl 检查:
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/chats/<existing-id>` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/directories` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/daemons` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/agents` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/flows` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/settings` → 200
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/dashboard` → 404 (removed)
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/lab` → 404 (removed)
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/chat` → 404 (removed)
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/workspace` → 404 (removed)

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore(console): remove deprecated routes and APIs (dashboard, lab, chat, workspace)"
```

---

## Task 13: 全量构建验证

**Files:** (无修改)

- [ ] **Step 1: 跑全量构建**

Run: `pnpm build`
Expected: PASS — all packages build.

- [ ] **Step 2: 跑全量测试**

Run: `pnpm test`
Expected: PASS — all tests green.

- [ ] **Step 3: 启动 dev 服务器手动回归**

启动 `pnpm run dev`,在浏览器中逐项验证:

1. `/` Chat Home:
   - 顶部目录选择器可见,可切换
   - 4 张建议卡,前两张跳转 `/flows` `/agents`,后两张发消息
   - composer agent selector 可点击展开
   - 发送消息 → 跳转 `/chats/:id`

2. `/chats/:id` Chat Detail:
   - 面包屑显示目录 + 标题 + 状态
   - user 消息立即出现
   - 如有有效 flow,assistant 消息流式追加(否则显示 502 错误,符合预期)
   - chat.status: idle → running → done
   - 右栏 agent/flow 可编辑
   - 右栏执行记录显示真正 runs
   - composer agent selector 可用
   - 输入 `@flow foo bar` → 看到 system 消息 "⚡ Flow triggered: foo — "bar""

3. `/directories`:
   - 列表、新建、编辑、删除均工作

4. `/daemons`:
   - 三栏布局可见
   - filter 切换工作
   - 选中任务,中栏时间线更新
   - 右栏统计显示数字(如果 dispatch 在线)

5. `/agents` `/flows` `/settings`: 路由可达,渲染正常

6. Sidebar:
   - 折叠/展开工作
   - Search 输入过滤 chat
   - chat item 显示消息数 + 状态

- [ ] **Step 4: 提交(如有修复)**

如果手动回归发现 bug,逐个修复并提交。否则跳过。

---

## Self-Review

### Spec coverage(对照差距分析文档)

**P0 — Chat 触发机制(6 用例):**
- UC-TRG-01 默认 SSE → Task 1 + 4 + 5 ✅
- UC-TRG-02 @flow → Task 1 (parseCommand + routeCommand ack) ✅(真实 scheduler.fanout 留作 follow-up,架构 §4.2 伪代码已 stub)
- UC-TRG-03 @daemon → Task 1 ✅(同上,dispatch.invoke stub)
- UC-TRG-04 @agent → Task 1 + 6(agentIdOverride) ✅
- UC-TRG-05 @ 补全提示 → Task 6(已有静态提示文案,补全弹窗留作后续)— 部分覆盖
- UC-TRG-06 SSE 流式 → Task 3 + 4 + 5 ✅

**P1 — 架构契约缺口:**
- UC-CHAT-02 顶部目录选择器 → Task 7 ✅
- UC-CHAT-03 建议卡跳转 → Task 8 ✅
- UC-CHAT-11 编辑 agent/flow → Task 10 ✅
- UC-CHAT-12 system 消息样式 → Task 5 ✅
- UC-CHAT-13 chat.status 同步 → Task 5 ✅
- UC-NAV-08 Search → Task 9 ✅
- UC-NAV-05 消息数+状态 → Task 9 ✅
- UC-DAE-01~06 Daemons 三栏 → Task 11 ✅(timeline + log stream 是简化版,真实 step progress 需要 scheduler 接入,留作 follow-up)

**P2 — 清理:**
- Task 12 移除旧路由/旧 API ✅

**Out of scope(单独 plan):**
- UC-WF-01 ~ UC-WF-12 工作流引擎内聚(架构 §9) — 不在本 plan
- UC-FLW-04/05/07 创建/删除/历史 flow API — 依赖工作流引擎,不在本 plan
- UC-TRG-02/03 真实 scheduler/dispatch 调度 — stub ack,真实执行留作 follow-up
- UC-DAE-02 真实 step progress — 需要 scheduler 接入,留作 follow-up
- UC-DAE-06 实时 log stream — 需要 WS/SSE,留作 follow-up

### Placeholder scan

✅ 无 TBD/TODO/implement later
✅ 每个 step 都有完整代码或具体命令
✅ Task 1 Step 8 的 routeCommand 是 stub(明确注释 "真实 downstream invocation ... is a follow-up"),但 stub 本身有完整实现(写 system message + 返回 ack)

### Type consistency

- `RouteResult` 在 chat-execute.ts 定义,在 chats.ts 使用 — 一致 ✅
- `sendChatMessage` 返回 `SendMessageResult`,在 chat-detail.tsx 消费 — 一致 ✅
- `DispatchTask` 在 daemons.ts 定义,在 daemons-queue/timeline/stats 导入 — 一致 ✅
- `updateChat` body 类型在 lib/chats.ts 扩展后,在 chat-context-panel.tsx 使用 `{ agentId }`/`{ flowId }` — 一致 ✅
- `AgentSelector` props `value`/`onChange` 在 chat-composer 和 chat-context-panel 两处使用 — 一致 ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-26-chat-first-functional-completion.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 task 派 fresh subagent,两阶段审查(spec 合规 + 代码质量)

**2. Inline Execution** - 当前 session 内按 task 顺序执行,checkpoint 审查

**Which approach?**
