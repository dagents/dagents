# 系统架构重设计：Chat-First 双维度模型

> **日期**: 2026-07-25
> **状态**: Draft
> **基于**: `design/` (v0.2/v0.3 平台控制台原型) + `design-redo-open-webui/` (Chat-First 原型)
> **决策模式**: 共存 (B) — Chat-First 升级为 home，9 屏精简保留

---

## 1. 背景与目标

### 1.1 现状

项目当前有 `design/` 9 屏平台控制台原型（v0.2/v0.3），已落地为 `apps/console/` Next.js 应用 + 三个 Hono 后端服务（`gateway` / `scheduler` / `dispatch`）。后端数据层基于 TypeORM + PostgreSQL，运行时统一使用 `runQuery` 原始 SQL 查询。

`design-redo-open-webui/` 是新的 Chat-First 原型，采用 OpenWebUI 布局范式：chat 作为 home，其他模块降为 sidebar 二级入口，chat 历史按时间分组。

### 1.2 目标

- 将 chat 升为一等公民，作为系统 home (`/`)
- 合并 `chat` + `workspace` 概念为**双维度模型**：项目目录 → 对话
- 砍掉 `dashboard` / `lab` / `launcher`（能力并入 chat home）
- 将 `daemons` 从子页面升级为一级模块
- 保持与现有后端服务（dispatch/scheduler/gateway）的兼容性
- 不加 `/console` 路由前缀，所有路由平级

### 1.3 非目标

- 不更换 UI 框架（保留 Next.js + 现有样式系统）
- 不引入新的数据库（继续使用现有 PostgreSQL）

### 1.4 新目标：工作流引擎内聚

**目标**: 将 Flowise v2 Agentflow 核心执行引擎从 `vendor/flowise/` 迁移到项目内部 `packages/workflow/`，不再依赖外部 Flowise 服务。

**迁移范围**:
- 14 个 Agentflow 节点（Start / Agent / LLM / Tool / HTTP / Condition / ConditionAgent / Iteration / Loop / HumanInput / DirectReply / CustomFunction / ExecuteFlow / Retriever）
- DAG 执行引擎（节点遍历、状态管理、流式输出）
- 运行时状态管理（flow state、memory、变量解析）
- SSE 流式输出（token 流、工具调用、思考过程）

**移除依赖**:
- `FLOWISE_URL` / `FLOWISE_API_KEY` 环境变量
- gateway 中的 Flowise proxy 代码（`/api/v1/flows/*`、`/api/v1/chatflows/*`、`/api/v1/executions/*`）
- `vendor/flowise/`（保留一段时间后删除）

---

## 2. 架构决策

### 2.1 范式选择：共存模式 (B)

**决策**: `design-redo` 的 Chat-First 范式作为新 surface，`design/` 的 9 屏精简后保留为独立路由，两套原型并存。

**理由**:
- 风险低：现有 9 屏功能不受影响，用户可继续使用
- 体验升级：新用户打开就是 chat，更直观
- 后端复用：现有 design shape 的 API 可复用，只需新增 chat/directory 相关 API

### 2.2 路由策略：无前缀平级

**决策**: 所有路由平级，不加 `/console` 前缀。

**最终路由表**:

| 路由 | 模块 | 来源 | 说明 |
|------|------|------|------|
| `/` | Chat Home | design-redo (新) | 目录选择器 + 欢迎屏 + New Chat 输入框 |
| `/chats/{id}` | 对话详情 | design-redo (新) | 面包屑 + 双栏（对话 + 上下文） |
| `/directories` | 目录管理 | 新增 | 添加/移除项目目录 |
| `/agents` | Agents | design/ 保留 | agent 列表 + 详情 |
| `/agents/{id}` | Agent 详情 | design/ 保留 | 单 agent 配置 |
| `/flows` | AgentFlows | design/ 保留 | flow 列表 + 编辑器 |
| `/daemons` | Daemons | design/ 升级 | 任务队列 + 执行时间线 + 统计 |
| `/settings` | 设置 | design/ 保留 | 系统配置 |
| ~~/dashboard~~ | 砍掉 | — | 能力并入 chat home 建议卡 |
| ~~/lab~~ | 砍掉 | — | 能力并入 chat（直接测 prompt） |
| ~~/launcher~~ | 砍掉 | — | 被 `/` 取代 |
| ~~/chat~~ | 并入 /chats | — | chat 不再独立路由 |
| ~~/workspace~~ | 并入 /chats | — | workspace 概念合并 |

### 2.3 双维度组织：项目目录 → 对话

**决策**: Sidebar 不再按时间分组，改为**按项目目录折叠列表**。每个目录下显示其对话列表。

**结构**:
```
Sidebar
├── + New Chat
├── Search
├── 主功能
│   ├── Chats (active)
│   ├── Agents
│   ├── AgentFlows
│   ├── Daemons
│   └── Settings
└── 项目目录 (可折叠)
    ├── 📁 dagents-main (3)
    │   ├── 重构 agent 注册流程 (running)
    │   ├── 数据迁移脚本测试 (pending)
    │   └── 调试 daemons 心跳 (done)
    ├── 📁 flowise-plugins (2) ▸
    └── + 添加项目目录
```

**维度说明**:
- **一级（项目目录）**: 用户手动添加的文件系统路径，可折叠，显示对话数
- **二级（对话/chat）**: 该目录下的对话，带状态点（绿=running / 黄=pending / 灰=done / 红=failed）+ 消息数 + 状态

### 2.4 Chat 触发方式：混合（selector + @命令）

**决策**: 默认用 agent selector 发消息；输入 `@flow` / `@daemon` 等命令触发特定执行。

**触发逻辑**:
- **默认**: 消息发给 chat 绑定的 agent（通过 chat.agent_id），走 gateway `/api/v1/flows/:flowId/prediction`（SSE 流式）
- **`@flow <flow-name> <message>`**: 触发 flow 执行，走 scheduler `/api/v1/scheduler/runs/fanout`
- **`@daemon <command>`**: 触发 daemon 命令，走 dispatch `/api/v1/dispatch/invoke`
- **`@agent <agent-name> <message>`**: 临时覆盖 agent，消息发给指定 agent

### 2.5 数据迁移策略：迁移后废弃

**决策**: 新建 `directories` + `chats` + `chat_messages` 表，迁移脚本把 `workspaces` 数据导入 `directories`，`runs.workspace_id` 改名为 `runs.chat_id`，旧表废弃。

---

## 3. 数据模型

### 3.1 新增表

#### `directories` 表（项目目录）

替代原 `workspaces` 表。用户手动添加的文件系统路径。

```sql
CREATE TABLE "directories" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "path"       TEXT NOT NULL UNIQUE,
  "name"       TEXT NOT NULL,
  "settings"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_directories_name ON ("name");
```

**字段说明**:
- `path`: 文件系统绝对路径（如 `/Users/rowan/Projects/dagents-main`）
- `name`: 显示名称（如 `dagents-main`，可自定义）
- `settings`: 扩展配置（如默认 agent、配额等，原 `workspaces.quota` 迁移至此）

#### `chats` 表（对话）

合并原 `chat` + `workspace 线程` 概念。每个对话属于一个目录。

```sql
CREATE TABLE "chats" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "directory_id"  UUID NOT NULL REFERENCES "directories"("id") ON DELETE CASCADE,
  "title"         TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'idle',
  "agent_id"      UUID,
  "flow_id"       TEXT,
  "last_message"  TEXT,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "last_run_id"   UUID,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chats_status_chk CHECK ("status" IN ('idle','running','done','failed'))
);
CREATE INDEX idx_chats_directory ON ("directory_id", "updated_at" DESC);
CREATE INDEX idx_chats_status ON ("status");
```

**字段说明**:
- `directory_id`: 所属项目目录（FK 强制）
- `agent_id`: 绑定的 agent（可空，运行时由 selector 覆盖）
- `flow_id`: 绑定的 flow（可空，TEXT 兼容 Flowise id）
- `last_run_id`: 最近一次 run（可空，无 FK 强制，沿用 MVP 松散策略）
- `status`: 对话状态（idle=新建 / running=执行中 / done=完成 / failed=失败）

#### `chat_messages` 表（消息）

统一存储 chat 消息流。

```sql
CREATE TABLE "chat_messages" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_id"    UUID NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "role"       TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "run_id"     UUID,
  "metadata"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_messages_role_chk CHECK ("role" IN ('user','assistant','system','tool'))
);
CREATE INDEX idx_chat_messages_chat ON ("chat_id", "created_at");
```

**字段说明**:
- `role`: 消息角色（user=用户 / assistant=AI 回复 / system=系统消息 / tool=工具调用结果）
- `run_id`: 关联的 run（可空，用于追踪触发执行的上下文）
- `metadata`: 扩展元数据（如 token 用量、模型信息等）

### 3.2 修改表

#### `runs` 表

将 `workspace_id` (TEXT) 改名为 `chat_id` (TEXT)：

```sql
-- 迁移：先加新列，复制数据，再删旧列
ALTER TABLE "runs" ADD COLUMN "chat_id" TEXT;
UPDATE "runs" SET "chat_id" = "workspace_id";
ALTER TABLE "runs" DROP COLUMN "workspace_id";
CREATE INDEX idx_runs_chat_status ON ("chat_id", "status");
```

> **注意**: `runs.chat_id` 保持 TEXT 类型（不强制 FK），沿用现有 MVP 松散策略。

### 3.3 废弃表

迁移完成后废弃以下表：
- `workspaces` — 数据迁移到 `directories`
- `workspace_members` — 暂无替代（多用户协作待后续）
- `workspace_flows` — flow 关联改为通过 `chats.flow_id` 或 directory settings

### 3.4 迁移脚本

```sql
-- 1. 创建 directories 表（见上）
-- 2. 创建 chats 表（见上）
-- 3. 创建 chat_messages 表（见上）

-- 4. 迁移 workspaces → directories
INSERT INTO "directories" (id, path, name, settings, created_at, updated_at)
SELECT
  id,
  COALESCE(name, id::text),  -- workspaces 无 path 字段，暂用 name 作 path
  name,
  jsonb_build_object('quota', quota, 'description', description, 'glyph', glyph),
  created_at,
  updated_at
FROM "workspaces"
WHERE status = 'active';

-- 5. 迁移 runs.workspace_id → chats + runs.chat_id
-- 为每个有 workspace_id 的 run 创建一个 chat
INSERT INTO "chats" (id, directory_id, title, status, last_run_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  r.workspace_id::uuid,  -- 假设 workspace_id 是有效的 directory UUID
  'Migrated from workspace',
  CASE WHEN r.status IN ('completed') THEN 'done'
       WHEN r.status IN ('failed','cancelled') THEN 'failed'
       WHEN r.status IN ('running','pending') THEN 'running'
       ELSE 'idle' END,
  r.id,
  r.created_at,
  COALESCE(r.finished_at, r.updated_at, NOW())
FROM "runs" r
WHERE r.workspace_id IS NOT NULL
  AND r.workspace_id::uuid IN (SELECT id FROM "directories");

-- 6. 更新 runs.chat_id（需要应用层或脚本映射 run → chat）
-- 这一步较复杂，建议在应用层迁移时处理

-- 7. 废弃旧表（可选，建议先保留一段时间）
-- DROP TABLE "workspace_flows";
-- DROP TABLE "workspace_members";
-- DROP TABLE "workspaces";
```

---

## 4. 后端 API 设计

### 4.1 Directories API

新增于 `apps/dispatch/src/routes/directories.ts`（或 gateway，根据职责选择）。

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/v1/dispatch/directories` | 列出所有目录 |
| `POST` | `/api/v1/dispatch/directories` | 添加目录（body: `{ path, name? }`） |
| `GET` | `/api/v1/dispatch/directories/:id` | 目录详情（含对话列表） |
| `PATCH` | `/api/v1/dispatch/directories/:id` | 更新目录（name, settings） |
| `DELETE` | `/api/v1/dispatch/directories/:id` | 删除目录（级联删除 chats） |

### 4.2 Chats API

新增于 `apps/dispatch/src/routes/chats.ts`。

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/v1/dispatch/chats` | 列出所有 chats（支持 `directory_id` 筛选） |
| `POST` | `/api/v1/dispatch/chats` | 创建 chat（body: `{ directory_id, title?, agent_id?, flow_id? }`） |
| `GET` | `/api/v1/dispatch/chats/:id` | chat 详情（含 last_message, run 状态） |
| `PATCH` | `/api/v1/dispatch/chats/:id` | 更新 chat（title, agent_id, flow_id, status） |
| `DELETE` | `/api/v1/dispatch/chats/:id` | 删除 chat（级联删除 messages） |
| `GET` | `/api/v1/dispatch/chats/:id/messages` | 消息列表（分页） |
| `POST` | `/api/v1/dispatch/chats/:id/messages` | 发送消息（触发执行） |

**消息发送逻辑**（`POST /api/v1/dispatch/chats/:id/messages`）:

```typescript
// 伪代码
async function sendMessage(chatId, content, agentIdOverride) {
  const chat = await getChat(chatId)
  const agentId = agentIdOverride ?? chat.agent_id

  // 写入 user message
  await insertMessage(chatId, 'user', content)

  // 解析 @命令
  if (content.startsWith('@flow ')) {
    const [, flowName, ...rest] = content.split(' ')
    const message = rest.join(' ')
    // 触发 scheduler fanout
    const run = await scheduler.fanout({
      flowId: chat.flow_id,
      question: message,
      chatId
    })
    await updateChat(chatId, { status: 'running', last_run_id: run.id })
    return { run_id: run.id }
  }

  if (content.startsWith('@daemon ')) {
    // 触发 dispatch invoke
    const task = await dispatch.invoke({
      agentDaemonId: resolveAgentDaemonId(agentId),
      runId: generateRunId(),
      prompt: content.replace('@daemon ', ''),
      execOptions: {}
    })
    return { task_id: task.id }
  }

  // 默认：走 gateway prediction (SSE)
  // 这部分由 console API route 处理（流式转发）
  return { stream: true, agent_id: agentId }
}
```

### 4.3 Console API Routes（代理层）

新增于 `apps/console/src/app/api/`：

```
api/
├── directories/
│   ├── [id]/route.ts
│   └── route.ts
├── chats/
│   ├── [id]/
│   │   ├── messages/route.ts
│   │   └── route.ts
│   └── route.ts
```

这些路由是 thin proxy，转发到 dispatch 服务，保持 server-side 转发模式（避免 CORS + origin 泄漏）。

**SSE 流式处理**:
- `POST /api/chats/:id/messages` 默认走 gateway prediction（SSE）
- Console API route 直接 pipe `text/event-stream` 到客户端（沿用现有 `/api/chat/route.ts` 模式）
- `@flow` / `@daemon` 命令返回 JSON（非流式）

### 4.4 现有 API 调整

| 现有 API | 调整 |
|----------|------|
| `GET /api/workspaces` | 废弃，替换为 `GET /api/directories` |
| `GET /api/workspaces/:id` | 废弃，替换为 `GET /api/directories/:id` |
| `GET /api/workspaces/:id/threads` | 废弃，替换为 `GET /api/chats?directory_id=:id` |
| `POST /api/workspaces/:id/runs` | 废弃，替换为 `POST /api/chats/:id/messages` |
| `POST /api/chat` | 废弃，能力并入 `POST /api/chats/:id/messages` |
| `GET /api/agents` | 保留不变 |
| `GET /api/flows` | 保留不变 |
| `GET /api/fleet-stats` | 保留（daemons 页面使用） |

---

## 5. 前端架构

### 5.1 页面结构

```
apps/console/src/app/
├── (chat)/                    # Chat-First 布局组
│   ├── layout.tsx             # Chat sidebar + 顶部目录选择器
│   ├── page.tsx               # / = Chat Home
│   └── chats/
│       └── [id]/
│           └── page.tsx       # /chats/{id} = 对话详情
├── directories/
│   └── page.tsx               # /directories = 目录管理
├── agents/
│   ├── page.tsx               # /agents
│   └── [id]/page.tsx          # /agents/{id}
├── flows/
│   ├── page.tsx               # /flows
│   └── [id]/page.tsx          # /flows/{id} (workflow editor)
├── daemons/
│   └── page.tsx               # /daemons
└── settings/
    └── page.tsx               # /settings
```

### 5.2 Chat Home (`/`)

**布局**: 顶部目录选择器 + 中央欢迎屏（2×2 建议卡）+ 底部输入框

**目录选择器**:
- 下拉显示所有 `directories`，当前选中的目录作为后续 chat 的默认归属
- 切换目录时，sidebar 的 chat 列表同步过滤

**建议卡**（替代原 dashboard/lab/launcher）:
1. ⚡ 创建 AgentFlow — 跳转 `/flows` 新建
2. 🤖 查看 Agent 状态 — 跳转 `/agents`
3. 🔧 设计任务 — 聚焦输入框
4. 💬 测试 Prompt — 聚焦输入框

**输入框**:
- 左侧：agent selector（下拉选 agent，默认 `auto`）
- 中间：消息输入
- 右侧：发送按钮
- 提示：`⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令`

### 5.3 对话详情 (`/chats/{id}`)

**布局**: 面包屑 + 双栏（左对话 + 右上下文）

**面包屑**: `📁 dagents-main / 重构 agent 注册流程 [running]`

**左栏（对话流）**:
- 消息列表（user/assistant/system/tool 不同样式）
- system 消息特殊样式（如 `⚡ Flow triggered: run #abc123`）
- 底部输入框（同 Chat Home）

**右栏（上下文）**:
- 所属目录
- 绑定 Agent
- 绑定 Flow
- 执行记录（run 列表）
- 配额（来自 directory.settings）

### 5.4 Daemons (`/daemons`)

复用 `design/daemon-execution.html` 三栏布局：
- **左栏**：任务队列（`dispatch_tasks` status=queued）
- **中栏**：执行时间线（active run 的 step progress + logs）
- **右栏**：统计（online daemons / active tasks / queue depth / throughput）

---

## 6. 服务层职责

### 6.1 现有服务（保持不变）

| 服务 | 职责 | 新增内容 |
|------|------|----------|
| `apps/dispatch` | Daemon 协议 + 任务队列 | + directories/chats routes |
| `apps/gateway` | Flowise 代理 + workspace reads | workspace → directory 适配 |
| `apps/scheduler` | Fan-out + run lifecycle | 无变化（runs.chat_id 替代 workspace_id） |

### 6.2 数据访问模式

延续现有模式：
- **TypeORM entities**: 仅用于 schema 定义
- **运行时查询**: 统一使用 `runQuery` 原始 SQL
- **API 信封**: `{ success, data? }` / `{ success: false, error, ...extra? }`
- **新增 entities**: `Directory`, `Chat`, `ChatMessage`（仅 schema 定义）

### 6.3 新增 Entities

```typescript
// packages/db/src/entities/directory.entity.ts
@Entity('directories')
export class Directory {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column({ unique: true }) path: string
  @Column() name: string
  @Column({ type: 'jsonb', default: {} }) settings: Record<string, unknown>
  @CreateDateColumn() created_at: Date
  @UpdateDateColumn() updated_at: Date
}

// packages/db/src/entities/chat.entity.ts
@Entity('chats')
export class Chat {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column({ name: 'directory_id' }) directory_id: string
  @Column() title: string
  @Column({ default: 'idle' }) status: 'idle' | 'running' | 'done' | 'failed'
  @Column({ name: 'agent_id', nullable: true }) agent_id: string | null
  @Column({ name: 'flow_id', nullable: true }) flow_id: string | null
  @Column({ name: 'last_message', nullable: true }) last_message: string | null
  @Column({ name: 'message_count', default: 0 }) message_count: number
  @Column({ name: 'last_run_id', nullable: true }) last_run_id: string | null
  @CreateDateColumn() created_at: Date
  @UpdateDateColumn() updated_at: Date
}

// packages/db/src/entities/chat-message.entity.ts
@Entity('chat_messages')
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column({ name: 'chat_id' }) chat_id: string
  @Column() role: 'user' | 'assistant' | 'system' | 'tool'
  @Column() content: string
  @Column({ name: 'run_id', nullable: true }) run_id: string | null
  @Column({ type: 'jsonb', default: {} }) metadata: Record<string, unknown>
  @CreateDateColumn() created_at: Date
}
```

---

## 7. 迁移计划

### 阶段 1: 数据层迁移

1. 创建 migration: `1720000009000-create-chat-tables.ts`
   - 创建 `directories` / `chats` / `chat_messages` 表
   - 修改 `runs` 表：加 `chat_id` 列
2. 创建 migration: `1720000009001-migrate-workspaces-to-directories.ts`
   - 迁移 `workspaces` → `directories`
   - 为有 `workspace_id` 的 runs 创建对应 chats
   - 更新 `runs.chat_id`
3. 创建 entities: `Directory`, `Chat`, `ChatMessage`

### 阶段 2: 后端 API

4. 新增 `apps/dispatch/src/routes/directories.ts`
5. 新增 `apps/dispatch/src/routes/chats.ts`
6. 新增 `apps/dispatch/src/routes/chat-messages.ts`
7. 在 `apps/dispatch/src/app.ts` 挂载新 routes
8. 新增 console API proxy routes: `api/directories/`, `api/chats/`

### 阶段 3: 前端页面

9. 新增 `(chat)` 布局组 + Chat Home 页面
10. 新增 `/chats/[id]` 对话详情页
11. 新增 `/directories` 目录管理页
12. 新增 `/daemons` 页面（迁移现有 daemon-execution 原型）
13. 调整 sidebar 组件（双维度折叠列表）
14. 废弃 `/dashboard` / `/lab` / `/launcher` / `/workspace` / `/chat` 旧页面

### 阶段 4: 清理

15. 废弃 `workspaces` / `workspace_members` / `workspace_flows` 表（保留一段时间后删除）
16. 废弃旧 console API routes (`api/workspaces/`, `api/chat/`)

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `runs.workspace_id` 是 TEXT 无 FK | 迁移时可能有无效 ID | 迁移脚本做有效性检查，无效 ID 的 runs 标记为 `chat_id = NULL` |
| workspaces 无 `path` 字段 | 迁移到 directories 时 path 缺失 | 用 `workspaces.name` 作为 path，用户后续在 UI 修正 |
| 现有 workspace API 调用中断 | 旧前端代码报错 | 阶段 3-4 之间保留旧 API 作为兼容层 |
| SSE 流式转发复杂度 | chat 消息发送可能不稳定 | 沿用现有 `/api/chat/route.ts` 的 pipe 模式，已验证 |
| 双维度 sidebar 性能 | 目录+对话数多时加载慢 | API 支持分页 + 懒加载子项 |

---

## 9. 工作流引擎内聚设计

### 9.1 新包结构：packages/workflow/

```
packages/workflow/src/
├── index.ts                    # 公共导出
├── engine/
│   ├── executor.ts             # DAG 执行引擎（核心）
│   ├── node-registry.ts        # 节点注册与查找
│   ├── runtime.ts              # 运行时状态管理
│   └── sse-streamer.ts         # SSE 流式输出
├── nodes/                      # 14 个节点实现
│   ├── index.ts
│   ├── start/start.node.ts     # Start 节点（chat/form/webhook/schedule）
│   ├── llm/llm.node.ts         # LLM 节点（模型调用、memory、流式）
│   ├── agent/agent.node.ts     # Agent 节点（代理编排）
│   ├── tool/tool.node.ts       # Tool 节点（工具调用）
│   ├── http/http.node.ts       # HTTP 节点
│   ├── condition/condition.node.ts
│   ├── condition-agent/condition-agent.node.ts
│   ├── iteration/iteration.node.ts
│   ├── loop/loop.node.ts
│   ├── human-input/human-input.node.ts
│   ├── direct-reply/direct-reply.node.ts
│   ├── custom-function/custom-function.node.ts
│   ├── execute-flow/execute-flow.node.ts
│   └── retriever/retriever.node.ts
├── types/                      # 类型定义
│   ├── flow.ts                 # FlowNode / FlowEdge / FlowData
│   ├── node.ts                 # INode / INodeData / NodeOutput
│   └── execution.ts            # ExecutionStatus / IExecutedNode
└── utils/                      # 工具函数
    ├── prompt.ts               # 提示词模板
    ├── variables.ts            # 变量解析 {{var}}
    └── memory.ts               # 对话记忆管理
```

### 9.2 节点接口定义

所有节点实现统一接口：

```typescript
export interface INode {
  label: string
  name: string
  version: number
  type: string
  category: string
  color: string
  baseClasses: string[]
  inputs: INodeParams[]
  credential?: INodeParams
  async run(nodeData: INodeData, input: string | Record<string, any>, options: ICommonObject): Promise<INodeOutput>
}

export interface INodeOutput {
  id: string
  name: string
  input: Record<string, any>
  output: Record<string, any>
  state?: Record<string, any>
  chatHistory?: any[]
}
```

### 9.3 DAG 执行引擎

执行引擎核心逻辑：

1. **拓扑排序**: 根据 edges 计算节点执行顺序
2. **状态传递**: 每个节点的 output 作为下游节点的 input
3. **分支处理**: Condition/ConditionAgent 节点根据条件选择路径
4. **循环处理**: Iteration/Loop 节点重复执行子路径
5. **流式输出**: 通过 SSE 实时推送 token、工具调用、思考过程

### 9.4 数据库表调整

新增 `flows` 表存储工作流定义：

```sql
CREATE TABLE "flows" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           TEXT NOT NULL,
  "flow_data"      JSONB NOT NULL,
  "type"           TEXT NOT NULL DEFAULT 'workflow',
  "status"         TEXT NOT NULL DEFAULT 'draft',
  "agent_id"       UUID REFERENCES "agents"("id"),
  "directory_id"   UUID REFERENCES "directories"("id"),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_flows_directory ON ("directory_id");
CREATE INDEX idx_flows_status ON ("status");
```

### 9.5 API 变化

| 旧 API（Flowise 代理） | 新 API（内聚引擎） | 说明 |
|----------------------|-------------------|------|
| `POST /api/v1/flows/:id/prediction` | `POST /api/v1/workflows/:id/run` | 执行工作流，SSE 流式输出 |
| `GET /api/v1/chatflows/:id` | `GET /api/v1/workflows/:id` | 获取工作流定义 |
| `GET /api/v1/chatflows` | `GET /api/v1/workflows` | 列出工作流 |
| `GET /api/v1/executions` | `GET /api/v1/workflows/:id/executions` | 执行历史 |
| — | `POST /api/v1/workflows` | 创建工作流 |
| — | `PUT /api/v1/workflows/:id` | 更新工作流定义 |
| — | `DELETE /api/v1/workflows/:id` | 删除工作流 |

### 9.6 迁移阶段

| 阶段 | 内容 |
|------|------|
| **阶段 1：新包基础** | 创建 `packages/workflow`，定义类型、节点接口、执行引擎骨架 |
| **阶段 2：核心节点迁移** | 迁移 Start、LLM、Agent、Tool、HTTP 五个核心节点 |
| **阶段 3：控制流节点** | 迁移 Condition、Iteration、Loop、HumanInput、DirectReply |
| **阶段 4：高级节点** | 迁移 ConditionAgent、CustomFunction、ExecuteFlow、Retriever |
| **阶段 5：API 集成** | 在 gateway 中新增 `/api/v1/workflows` 路由，连接执行引擎 |
| **阶段 6：前端适配** | 更新 console 的 flows 页面和 chat 调用 |
| **阶段 7：清理** | 移除 Flowise 代理代码，废弃 `FLOWISE_URL`/`FLOWISE_API_KEY` |

### 9.7 依赖关系

```
@dagents/workflow ← @dagents/contracts ← @dagents/db ← @dagents/shared
```

- `@dagents/workflow` 依赖 `@dagents/contracts`（类型定义）、`@dagents/db`（数据访问）、`@dagents/shared`（工具函数）
- gateway 和 console 通过 API 调用 workflow 引擎，不直接依赖包

---

## 10. 相关文件

### 现有关键文件（参考）

- [design/](file:///Users/rowan/Projects/dagents-main/design) — v0.2/v0.3 原型
- [design-redo-open-webui/](file:///Users/rowan/Projects/dagents-main/design-redo-open-webui) — Chat-First 原型
- [design/daemon-execution.html](file:///Users/rowan/Projects/dagents-main/design/daemon-execution.html) — Daemons 三栏布局原型
- [design/workspace.html](file:///Users/rowan/Projects/dagents-main/design/workspace.html) — Workspace 双栏布局原型（参考）
- [apps/dispatch/src/app.ts](file:///Users/rowan/Projects/dagents-main/apps/dispatch/src/app.ts) — Dispatch 服务入口
- [apps/dispatch/src/routes/daemons.ts](file:///Users/rowan/Projects/dagents-main/apps/dispatch/src/routes/daemons.ts) — Daemons 后端
- [apps/console/src/app/api/chat/route.ts](file:///Users/rowan/Projects/dagents-main/apps/console/src/app/api/chat/route.ts) — 现有 chat SSE 代理
- [apps/console/src/app/api/workspaces/](file:///Users/rowan/Projects/dagents-main/apps/console/src/app/api/workspaces) — 现有 workspace API
- [packages/db/src/data-source.ts](file:///Users/rowan/Projects/dagents-main/packages/db/src/data-source.ts) — 数据库配置
- [packages/db/src/entities/](file:///Users/rowan/Projects/dagents-main/packages/db/src/entities) — 现有 entities

### 待新增文件

- `packages/db/src/migrations/1720000009000-create-chat-tables.ts`
- `packages/db/src/migrations/1720000009001-migrate-workspaces-to-directories.ts`
- `packages/db/src/entities/directory.entity.ts`
- `packages/db/src/entities/chat.entity.ts`
- `packages/db/src/entities/chat-message.entity.ts`
- `apps/dispatch/src/routes/directories.ts`
- `apps/dispatch/src/routes/chats.ts`
- `apps/dispatch/src/routes/chat-messages.ts`
- `apps/console/src/app/api/directories/route.ts`
- `apps/console/src/app/api/directories/[id]/route.ts`
- `apps/console/src/app/api/chats/route.ts`
- `apps/console/src/app/api/chats/[id]/route.ts`
- `apps/console/src/app/api/chats/[id]/messages/route.ts`
- `apps/console/src/app/(chat)/layout.tsx`
- `apps/console/src/app/(chat)/page.tsx`
- `apps/console/src/app/(chat)/chats/[id]/page.tsx`
- `apps/console/src/app/directories/page.tsx`
- `apps/console/src/app/daemons/page.tsx`

### 工作流引擎待新增文件

- `packages/workflow/package.json`
- `packages/workflow/src/index.ts`
- `packages/workflow/src/types/flow.ts`
- `packages/workflow/src/types/node.ts`
- `packages/workflow/src/types/execution.ts`
- `packages/workflow/src/engine/executor.ts`
- `packages/workflow/src/engine/node-registry.ts`
- `packages/workflow/src/engine/runtime.ts`
- `packages/workflow/src/engine/sse-streamer.ts`
- `packages/workflow/src/nodes/index.ts`
- `packages/workflow/src/nodes/start/start.node.ts`
- `packages/workflow/src/nodes/llm/llm.node.ts`
- `packages/workflow/src/nodes/agent/agent.node.ts`
- `packages/workflow/src/nodes/tool/tool.node.ts`
- `packages/workflow/src/nodes/http/http.node.ts`
- `packages/workflow/src/nodes/condition/condition.node.ts`
- `packages/workflow/src/nodes/condition-agent/condition-agent.node.ts`
- `packages/workflow/src/nodes/iteration/iteration.node.ts`
- `packages/workflow/src/nodes/loop/loop.node.ts`
- `packages/workflow/src/nodes/human-input/human-input.node.ts`
- `packages/workflow/src/nodes/direct-reply/direct-reply.node.ts`
- `packages/workflow/src/nodes/custom-function/custom-function.node.ts`
- `packages/workflow/src/nodes/execute-flow/execute-flow.node.ts`
- `packages/workflow/src/nodes/retriever/retriever.node.ts`
- `packages/workflow/src/utils/prompt.ts`
- `packages/workflow/src/utils/variables.ts`
- `packages/workflow/src/utils/memory.ts`
- `packages/db/src/migrations/1720000009002-create-flows-table.ts`
- `packages/db/src/entities/flow.entity.ts`
- `apps/gateway/src/routes/workflows.ts`
- `apps/console/src/app/api/workflows/route.ts`
- `apps/console/src/app/api/workflows/[id]/route.ts`
- `apps/console/src/app/api/workflows/[id]/run/route.ts`
