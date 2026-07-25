# 用户用例与功能差距分析

> **日期**: 2026-07-25
> **基于**: `2026-07-25-system-architecture-redesign.md` + `2026-07-25-chat-first-redesign-fix.md`
> **对照**: `apps/console/` + `apps/gateway/` + `packages/db/` 当前实现
> **目的**: 罗列架构文档涉及的所有用户用例，并对照当前实现找出功能差距

---

## 0. 总览

本文档按架构文档第 2 章路由表 + 第 5 章前端架构 + 第 9 章工作流引擎内聚设计，将系统拆分为 10 个模块，共梳理 **67 个用户用例**。

### 状态分布

| 状态 | 数量 | 占比 | 含义 |
|------|------|------|------|
| ✅ 已实现 | 23 | 34% | 功能完整可用 |
| ⚠️ 部分实现 | 22 | 33% | 框架/部分能力存在，但缺关键逻辑或 UI |
| ❌ 未实现 | 22 | 33% | 完全缺失，需新建 |

### 模块完成度热力图

| 模块 | 用例数 | ✅ | ⚠️ | ❌ | 完成度 |
|------|--------|----|----|----|--------|
| 1. Chat Home | 6 | 3 | 3 | 0 | 75% |
| 2. Chat Detail | 7 | 1 | 4 | 2 | 43% |
| 3. Directories | 5 | 4 | 1 | 0 | 90% |
| 4. Agents | 4 | 2 | 2 | 0 | 75% |
| 5. AgentFlows | 7 | 2 | 2 | 3 | 50% |
| 6. Daemons | 6 | 0 | 0 | 6 | 0% |
| 7. Settings | 6 | 6 | 0 | 0 | 100% |
| 8. Sidebar 导航 | 8 | 4 | 3 | 1 | 69% |
| 9. Chat 触发机制 | 6 | 0 | 1 | 5 | 8% |
| 10. 工作流引擎 | 12 | 0 | 0 | 12 | 0% |

> **关键缺口**: 工作流引擎内聚（架构第 9 章）整章未实现；Chat 触发机制（@ 命令 + SSE 流式）几乎未实现；Daemons 三栏页面仅占位。这三块占总未实现数的 23/22 = 100% 的 ❌。

---

## 1. Chat Home (`/`) — Chat-First 首页

参考: 架构 §5.2、计划 Task 3

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-CHAT-01 | 查看欢迎屏 | 用户 | 已登录 | 1. 访问 `/`<br>2. 看到 bot 头像 + 标题 + 欢迎文案<br>3. 看到底部 composer | ✅ 已实现 | `chat-home.tsx` 已渲染 bot 头像 + 标题 "DAgent Console" + 欢迎文案 + composer |
| UC-CHAT-02 | 顶部切换项目目录 | 用户 | 至少有 1 个 directory | 1. 顶部目录选择器下拉<br>2. 切换 directory<br>3. 后续 chat 默认归属此 directory<br>4. sidebar chat 列表同步过滤 | ⚠️ 部分实现 | `chat-home.tsx` 内部有 `selectedDirId` state，但**没有顶部下拉选择器 UI**；`directories[0]` 被默认选中，用户无法切换；架构 §5.2 明确要求"顶部目录选择器" |
| UC-CHAT-03 | 点击建议卡触发动作 | 用户 | 已登录 | 1. 看到 2×2 建议卡<br>2. 点击"创建 AgentFlow"跳 `/flows`<br>3. 点击"查看 Agent 状态"跳 `/agents`<br>4. 点击"设计任务"/"测试 Prompt"聚焦输入框 | ⚠️ 部分实现 | `suggestion-cards.tsx` 渲染了 4 张卡，但**所有卡都只触发 `onPick(text) → handleSend(text)`**（把卡文本当消息发送），没有跳转 `/flows`/`/agents` 的逻辑；架构 §5.2 要求前两张卡是跳转动作 |
| UC-CHAT-04 | 发送消息创建新 chat | 用户 | 至少有 1 个 directory | 1. 在 composer 输入文本<br>2. 按 Enter 或点发送<br>3. 调用 `createChat` + `createMessage`<br>4. 跳转 `/chats/{id}` | ⚠️ 部分实现 | `handleSend` 实现 createChat + createMessage + router.push，但**没有触发 agent 执行**（只写入 user message，无 assistant 回复，无 SSE）；chat.status 保持 idle |
| UC-CHAT-05 | 通过 agent selector 选择默认 agent | 用户 | 至少有 1 个 agent | 1. 点击 composer 左下 "Agent" 按钮<br>2. 弹出 agent 列表<br>3. 选中 agent<br>4. 后续消息发给此 agent | ❌ 未实现 | `chat-composer.tsx` 的 agent selector **只是静态按钮**（无 onClick、无下拉、无 agent 列表 fetch）；架构 §5.2 要求"左侧：agent selector（下拉选 agent，默认 auto）" |
| UC-CHAT-06 | 查看错误提示 | 用户/系统 | directory 为空或网络异常 | 1. 系统检测到无 directory<br>2. 显示"请先添加项目目录"或具体错误 | ✅ 已实现 | `chat-home.tsx` 已有 error state + "请先添加项目目录"分支 |

---

## 2. Chat Detail (`/chats/{id}`) — 对话详情

参考: 架构 §5.3、计划 Task 4

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-CHAT-07 | 通过面包屑查看归属与状态 | 用户 | 已进入某 chat | 1. 顶部显示 `📁 directory / chat title [status]`<br>2. 点击目录跳 `/directories` | ✅ 已实现 | `chat-detail.tsx` 已渲染面包屑（folder icon + directory.name + "/" + chat.title + status badge），directory.name 为 Link 跳 `/directories` |
| UC-CHAT-08 | 查看消息流（多角色样式） | 用户 | chat 有消息 | 1. 渲染 user/assistant/system/tool 消息<br>2. 不同 role 不同样式<br>3. system 消息特殊样式（如 `⚡ Flow triggered: run #abc123`） | ⚠️ 部分实现 | 已有 `chat-msg-user/assistant/system/tool` 4 种 class，但 **system 消息没有特殊图标/卡片样式**（架构 §5.3 要求 `⚡ Flow triggered` 这种特殊视觉），tool 消息也没渲染 metadata 中的工具调用详情 |
| UC-CHAT-09 | 发送消息触发 agent 执行（SSE 流式） | 用户 | chat 已绑定 agent | 1. 输入消息<br>2. POST `/api/chats/:id/messages` 写入 user message<br>3. 后端解析 @ 命令或默认走 gateway prediction<br>4. SSE 流式接收 assistant 回复<br>5. chat.status → running → done | ❌ 未实现 | `handleSend` 仅 `createMessage(role:'user')`，**没有调用 gateway prediction、没有 SSE、没有 assistant 回复**；`/api/chats/:id/messages` 后端只 INSERT 消息，未实现架构 §4.2 的 sendMessage 伪代码（解析 @ 命令、调 scheduler.fanout / dispatch.invoke / gateway prediction）；chat.status 不更新 |
| UC-CHAT-10 | 查看右栏上下文 | 用户 | 已进入 chat | 1. 右栏显示所属目录<br>2. 显示绑定 Agent<br>3. 显示绑定 Flow<br>4. 显示统计（消息数/状态）<br>5. 显示执行记录（run 列表） | ⚠️ 部分实现 | `chat-context-panel.tsx` 渲染了目录/agent/flow/统计/执行记录 5 个 section，但 **"执行记录"只是从 messages 中 filter `runId != null` 的消息**，不是真正的 run 列表；架构 §5.3 要求"执行记录（run 列表）"应来自 `runs` 表关联 |
| UC-CHAT-11 | 编辑 chat 绑定的 agent 或 flow | 用户 | 已进入 chat | 1. 右栏点击 agent/flow<br>2. 弹出选择器<br>3. PATCH `/api/chats/:id` 更新 agent_id/flow_id | ❌ 未实现 | `chat-context-panel.tsx` 只读展示 agentId/flowId，**无编辑入口**；`updateChat` lib 函数存在但只支持 title/status，schema 不含 agentId/flowId；gateway `chats.ts` 的 `updateBodySchema` 也不接受 agentId/flowId |
| UC-CHAT-12 | 查看系统消息特殊样式 | 系统 | 触发了 @flow 或 @daemon | 1. 后端写入 system message（如 `⚡ Flow triggered: run #abc123`）<br>2. 前端用特殊卡片渲染 | ⚠️ 部分实现 | 前端有 `.chat-msg-system` class（居中、warn-soft 背景），但**后端从未生成这种 system 消息**（因为 @ 命令未实现），样式也未含 ⚡ 图标 |
| UC-CHAT-13 | 实时查看 chat 状态变化 | 系统 | chat 执行中 | 1. 发送消息后 status → running<br>2. 执行完成 status → done<br>3. 面包屑 + 右栏同步更新 | ⚠️ 部分实现 | 状态展示 UI 已有，但**没有任何机制让前端感知 status 变化**（无 polling、无 SSE 推送、无 WS）；`chat` state 只在初次 fetch 时设置，发送消息后不重新拉取 |

---

## 3. Directories (`/directories`) — 目录管理

参考: 架构 §4.1、§5.1

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-DIR-01 | 列出所有项目目录 | 用户 | 已登录 | 1. 访问 `/directories`<br>2. 调用 `GET /api/directories`<br>3. 显示目录列表（含 chat 数） | ✅ 已实现 | `directories/page.tsx` 渲染 `<DirectoriesView />`；gateway `directoryRoutes.get('/')` 实现 SELECT + chat_count 子查询；console `/api/directories/route.ts` 是 thin proxy |
| UC-DIR-02 | 添加新项目目录 | 用户 | 已登录 | 1. 输入 path（+ 可选 name）<br>2. POST `/api/directories`<br>3. 列表刷新 | ✅ 已实现 | gateway `directoryRoutes.post('/')` 实现 INSERT，console proxy 转发；name 缺省从 path 推导 |
| UC-DIR-03 | 编辑目录名称或 settings | 用户 | 已有 directory | 1. 选中目录<br>2. 修改 name 或 settings<br>3. PATCH `/api/directories/:id` | ⚠️ 部分实现 | gateway `directoryRoutes.patch('/:id')` 支持 name/settings 更新，**但 settings 内的"默认 agent"、"配额"等字段无 UI 管理**（架构 §3.1 提到 settings 包含 quota/default agent 等） |
| UC-DIR-04 | 删除目录（级联） | 用户 | 已有 directory | 1. 点击删除<br>2. 确认<br>3. DELETE `/api/directories/:id`<br>4. 级联删除 chats | ✅ 已实现 | gateway `directoryRoutes.delete('/:id')` 实现；DB FK `directory_id ON DELETE CASCADE` 确保级联 |
| UC-DIR-05 | 查看目录下对话列表 | 用户 | 已有 directory | 1. 选中目录<br>2. 调用 `GET /api/chats?directory_id=:id`<br>3. 显示该目录的 chats | ✅ 已实现 | gateway `chatRoutes.get('/')` 支持 directory_id 筛选；sidebar 中也按目录分组展示 |

---

## 4. Agents (`/agents`, `/agents/{id}`) — Agent 管理

参考: 架构 §2.2（保留）、§5.1

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-AGT-01 | 列出所有 agents | 用户 | 已登录 | 1. 访问 `/agents`<br>2. 调用 `GET /api/agents`<br>3. 显示 agent 列表 | ✅ 已实现 | `agents/page.tsx` 渲染 `<AgentsView />`；`/api/agents/route.ts` 存在；架构 §4.4 标注"保留不变" |
| UC-AGT-02 | 查看单个 agent 详情 | 用户 | 已有 agent | 1. 点击 agent<br>2. 跳 `/agents/{id}`<br>3. 调用 `GET /api/agents/:id` | ✅ 已实现 | `agents/[id]/page.tsx` 存在；`/api/agents/[id]/route.ts` 存在 |
| UC-AGT-03 | 配置 agent | 用户 | 已有 agent | 1. 进入详情<br>2. 编辑配置<br>3. 保存 | ⚠️ 部分实现 | 路由与组件存在，但**架构未细化 agent 配置字段**，需对照 design 原型核对（本次未深入读取 agents-view.tsx） |
| UC-AGT-04 | 在 chat 中通过 selector 选择 agent | 用户 | 已有 agent + 已进入 chat | 1. 点击 composer 的 agent selector<br>2. 弹出 agent 列表<br>3. 选中 agent<br>4. 后续消息发给此 agent | ❌ 未实现 | 同 UC-CHAT-05：composer 的 agent selector 是静态按钮，无下拉；`chat.agent_id` 也无 UI 绑定入口（见 UC-CHAT-11） |

---

## 5. AgentFlows (`/flows`, `/flows/{id}`) — Flow 管理

参考: 架构 §2.2、§9.5（API 变化）

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-FLW-01 | 列出所有 flows | 用户 | 已登录 | 1. 访问 `/flows`<br>2. 调用 `GET /api/flows`<br>3. 显示 flow 列表 | ✅ 已实现 | `flows/page.tsx` 渲染 `<FlowsView />`；`/api/flows/route.ts` 存在（仍走 Flowise 代理） |
| UC-FLW-02 | 查看单个 flow 详情/DAG | 用户 | 已有 flow | 1. 点击 flow<br>2. 跳 `/flows/{id}/edit`<br>3. 显示 DAG | ✅ 已实现 | `flows/[id]/edit/page.tsx` 存在 |
| UC-FLW-03 | 编辑 flow（workflow editor） | 用户 | 已有 flow | 1. 进入编辑器<br>2. 修改节点<br>3. 保存 | ⚠️ 部分实现 | 编辑器页面存在，但**仍调 Flowise API**；架构 §9.5 要求改为 `PUT /api/v1/workflows/:id`（内聚引擎） |
| UC-FLW-04 | 创建新 flow | 用户 | 已登录 | 1. 点击新建<br>2. 调用 `POST /api/v1/workflows`<br>3. 跳转编辑器 | ❌ 未实现 | 架构 §9.5 要求新增 `POST /api/v1/workflows`，**当前无此 API**（仍依赖 Flowise 创建） |
| UC-FLW-05 | 删除 flow | 用户 | 已有 flow | 1. 点击删除<br>2. 调用 `DELETE /api/v1/workflows/:id` | ❌ 未实现 | 架构 §9.5 要求新增 `DELETE /api/v1/workflows/:id`，**当前无此 API** |
| UC-FLW-06 | 执行 flow（SSE 流式） | 用户/chat | 已有 flow | 1. 调用 `POST /api/v1/workflows/:id/run`<br>2. SSE 流式接收 token/工具调用/思考过程 | ⚠️ 部分实现 | 当前仍走旧 `POST /api/v1/flows/:id/prediction`（Flowise 代理，`/api/chat/route.ts` 转发）；**架构 §9.5 要求改为 `/api/v1/workflows/:id/run`，未实现** |
| UC-FLW-07 | 查看执行历史 | 用户 | 已有 flow | 1. 调用 `GET /api/v1/workflows/:id/executions`<br>2. 显示历史 run 列表 | ❌ 未实现 | 架构 §9.5 要求新增此 API；当前只有 `/api/flows/[id]/runs/[runId]/node-spans`（旧） |

---

## 6. Daemons (`/daemons`) — 守护进程

参考: 架构 §2.2、§5.4、`design/daemon-execution.html`

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-DAE-01 | 查看任务队列（左栏） | 用户 | 已登录 | 1. 访问 `/daemons`<br>2. 左栏显示 `dispatch_tasks status=queued` 列表<br>3. 每个任务卡显示 id/type/desc/flow/priority/time | ❌ 未实现 | `daemons/page.tsx` 仅占位（"Daemons 模块开发中"），**无任何三栏布局**；原型 `design/daemon-execution.html` 已有完整 .de-queue 样式 |
| UC-DAE-02 | 查看执行时间线（中栏） | 用户 | 有 active run | 1. 中栏显示 active run 的 step progress<br>2. 时间线节点（running/done/queued/failed）<br>3. 显示 logs | ❌ 未实现 | 占位页未实现；原型 .de-timeline / .de-log 完整存在但未移植 |
| UC-DAE-03 | 查看统计（右栏） | 用户 | 已登录 | 1. 右栏显示 online daemons / active tasks / queue depth / throughput<br>2. 成本仪表盘 + 饼图 | ❌ 未实现 | 占位页未实现；`/api/fleet-stats/route.ts` 存在但未被 daemons 页消费 |
| UC-DAE-04 | 过滤任务队列 | 用户 | 有任务 | 1. 点击 queued/running/done/failed 过滤按钮<br>2. 列表刷新 | ❌ 未实现 | 占位页未实现 |
| UC-DAE-05 | 选择任务查看详情 | 用户 | 有任务 | 1. 点击任务卡<br>2. 中栏切换到该任务的时间线 | ❌ 未实现 | 占位页未实现 |
| UC-DAE-06 | 查看 log stream（实时） | 用户 | 有 active run | 1. 中栏底部 log 流<br>2. 支持 level 过滤、搜索、暂停 | ❌ 未实现 | 占位页未实现 |

---

## 7. Settings (`/settings`) — 设置

参考: 架构 §2.2（保留）、`settings/page.tsx` 注释

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-SET-01 | 管理 API Key | 用户 | 已登录 | 1. 进入 Settings → API Key tab<br>2. CRUD 令牌 | ✅ 已实现 | `/api/tokens/*` → gateway → new-api 全链路已实现 |
| UC-SET-02 | 配置默认模型 | 用户 | 已登录 | 1. 切到默认模型 tab<br>2. 修改模型 | ✅ 已实现 | `SettingsView` 已渲染 6 个 tab；架构 §4.4 标注"保留不变"，模型 tab 为只读 shell 但已暴露 |
| UC-SET-03 | 配置预算配额 | 用户 | 已登录 | 1. 切到预算 tab<br>2. 修改配额 | ✅ 已实现 | tab 已暴露（只读 shell，符合架构"保留不变"） |
| UC-SET-04 | 配置通知 | 用户 | 已登录 | 1. 切到通知 tab<br>2. 修改通知设置 | ✅ 已实现 | tab 已暴露 |
| UC-SET-05 | 管理账户团队 | 用户 | 已登录 | 1. 切到账户 tab<br>2. 管理成员 | ✅ 已实现 | tab 已暴露 |
| UC-SET-06 | 危险区操作 | 用户 | 已登录 | 1. 切到危险区 tab<br>2. 执行危险操作 | ✅ 已实现 | tab 已暴露 |

> Settings 模块架构明确"保留不变"，6 个 tab 全部存在，标记为 ✅。如需深度数据接入，可后续按 `2026-07-08-prototype-coverage-analysis.md` 处理（不在本次架构改造范围内）。

---

## 8. Sidebar 导航 — 双维度折叠列表

参考: 架构 §2.3、计划 Task 2

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-NAV-01 | 折叠/展开 sidebar | 用户 | 已登录 | 1. 点击顶部 toggle<br>2. sidebar 缩到 60px<br>3. 状态持久化到 localStorage | ✅ 已实现 | `chat-layout.tsx` 实现 toggle + localStorage(`od:chat-sidebar`)，CSS `.chat-layout-sidebar.collapsed` 完整 |
| UC-NAV-02 | 切换主功能页面 | 用户 | 已登录 | 1. 点击 Chat/Agents/AgentFlows/Daemons/Settings<br>2. 跳转对应路由<br>3. 当前项高亮 | ✅ 已实现 | `nav.ts` NAV 数组已清理为 5 项；`chat-nav-sidebar.tsx` 渲染 Link + `aria-current` |
| UC-NAV-03 | 折叠/展开目录分组 | 用户 | 至少有 1 个 directory | 1. 点击 directory header<br>2. 子 chat 列表展开/收起<br>3. 第一个目录默认展开 | ✅ 已实现 | `toggleDir` + `expandedDirs` Set 实现；首次加载默认展开 `dirs[0]` |
| UC-NAV-04 | 点击 chat 跳转详情 | 用户 | directory 下有 chat | 1. 点击 chat 标题<br>2. 跳 `/chats/{id}`<br>3. 当前 chat 高亮 | ✅ 已实现 | `chat-nav-chat-item` Link + `aria-selected={activeChatId === chat.id}` |
| UC-NAV-05 | 看到 chat 状态点 | 用户 | directory 下有 chat | 1. 每个 chat 前显示状态点<br>2. 绿=running / 黄=pending / 灰=done / 红=failed | ⚠️ 部分实现 | 状态点已实现（.chat-nav-chat-status.{running,idle,done,failed}），但**架构 §2.3 用 "黄=pending"，实体只有 'idle'/'running'/'done'/'failed'**（无 pending）；架构还要求"+ 消息数 + 状态" 文本，当前**只显示状态点，无消息数和状态文本** |
| UC-NAV-06 | 通过"+ 添加项目目录"跳转 | 用户 | 已登录 | 1. 点击底部 "+ 添加项目目录"<br>2. 跳 `/directories` | ✅ 已实现 | `chat-nav-add-dir` Link 跳 `/directories`，空目录与有目录两种情况都渲染 |
| UC-NAV-07 | 通过"New Chat"跳回 home | 用户 | 已登录 | 1. 点击 "New Chat"<br>2. 跳 `/` | ✅ 已实现 | `handleNewChat` → `router.push('/')` |
| UC-NAV-08 | 搜索 chat | 用户 | 已有 chat | 1. 在 Search 框输入关键词<br>2. chat 列表过滤 | ❌ 未实现 | 架构 §2.3 sidebar 结构图明确列出 "Search"，但 `chat-nav-sidebar.tsx` **只渲染了 New Chat 按钮，无 Search 输入框** |

---

## 9. Chat 触发机制 — @ 命令、agent selector、SSE 流式

参考: 架构 §2.4、§4.2、§4.3

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-TRG-01 | 默认通过 agent selector 发消息（SSE） | 用户 | chat 已绑定 agent | 1. 输入消息<br>2. POST `/api/chats/:id/messages`<br>3. 后端走 gateway `/api/v1/flows/:flowId/prediction`<br>4. SSE 流式接收 assistant token | ❌ 未实现 | 后端 `chatRoutes.post('/:id/messages')` 只 INSERT user message，**未调用 gateway prediction**；前端 `createMessage` 不接收 SSE；旧 `/api/chat/route.ts` SSE proxy 存在但未被新 chat 调用 |
| UC-TRG-02 | `@flow <flow-name> <message>` 触发 flow | 用户 | chat 已绑定 flow | 1. 输入 `@flow my-flow do something`<br>2. 后端解析<br>3. 调 scheduler `/api/v1/scheduler/runs/fanout`<br>4. 返回 run_id（非流式） | ❌ 未实现 | 后端无 `content.startsWith('@flow ')` 解析逻辑；scheduler fanout 未对接；架构 §4.2 伪代码未实现 |
| UC-TRG-03 | `@daemon <command>` 触发 daemon | 用户 | chat 已绑定 agent | 1. 输入 `@daemon status`<br>2. 后端解析<br>3. 调 dispatch `/api/v1/dispatch/invoke`<br>4. 返回 task_id | ❌ 未实现 | 后端无 `@daemon` 解析；dispatch invoke 未从 chat 路径调用 |
| UC-TRG-04 | `@agent <agent-name> <message>` 临时覆盖 agent | 用户 | 已有多个 agent | 1. 输入 `@agent claude help me`<br>2. 后端解析<br>3. 消息发给指定 agent（不修改 chat.agent_id） | ❌ 未实现 | 后端无 `@agent` 解析；`agentIdOverride` 参数未在 API schema 中 |
| UC-TRG-05 | 看到 @ 命令提示 | 用户 | composer 聚焦 | 1. 输入 `@`<br>2. 弹出命令补全（flow/daemon/agent） | ⚠️ 部分实现 | composer 底部有静态提示文案 "⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令"，但**无实际 @ 补全弹窗** |
| UC-TRG-06 | SSE 流式接收 assistant 回复 | 系统 | 消息已发送 | 1. 后端 SSE 推送 token<br>2. 前端流式渲染<br>3. 完成后写入 assistant message | ❌ 未实现 | 前端 `lib/chats.ts` 无 `streamMessage` 函数（计划 Task 3 提到要新增但未做）；后端 messages 路由不支持 SSE 响应；旧 `/api/chat/route.ts` 的 SSE pipe 模式未被复用 |

---

## 10. 工作流引擎（架构第 9 章）— 内聚后的 workflow

参考: 架构 §9.1 - §9.7

> **整体状态**: ❌ 完全未实现。`packages/workflow/` 目录不存在，14 节点未迁移，DAG 引擎未建，新 `flows` 表未建，新 API 未建，Flowise 代理代码未移除。

| UC-ID | 用例名称 | 触发者 | 前置条件 | 主要流程 | 当前状态 | 差距说明 |
|-------|---------|--------|---------|---------|---------|---------|
| UC-WF-01 | 执行工作流（SSE 流式） | 用户/chat | 已有 flow | 1. POST `/api/v1/workflows/:id/run`<br>2. SSE 推送 token/工具调用/思考过程 | ❌ 未实现 | 路由不存在；当前仍用 `/api/v1/flows/:id/prediction`（Flowise） |
| UC-WF-02 | 列出工作流 | 用户 | 已登录 | 1. GET `/api/v1/workflows`<br>2. 返回 flow 列表 | ❌ 未实现 | 路由不存在；当前用 `/api/v1/flows`（旧） |
| UC-WF-03 | 获取工作流定义 | 用户 | 已有 flow | 1. GET `/api/v1/workflows/:id`<br>2. 返回 flow_data | ❌ 未实现 | 路由不存在；当前用 `/api/v1/chatflows/:id`（旧） |
| UC-WF-04 | 创建工作流 | 用户 | 已登录 | 1. POST `/api/v1/workflows`<br>2. 写入 flows 表 | ❌ 未实现 | 路由不存在；`flows` 表未建（§9.4） |
| UC-WF-05 | 更新工作流定义 | 用户 | 已有 flow | 1. PUT `/api/v1/workflows/:id`<br>2. 更新 flow_data | ❌ 未实现 | 路由不存在 |
| UC-WF-06 | 删除工作流 | 用户 | 已有 flow | 1. DELETE `/api/v1/workflows/:id` | ❌ 未实现 | 路由不存在 |
| UC-WF-07 | 查看执行历史 | 用户 | 已有 flow | 1. GET `/api/v1/workflows/:id/executions`<br>2. 返回 run 列表 | ❌ 未实现 | 路由不存在；当前用 `/api/v1/executions`（旧） |
| UC-WF-08 | 支持 14 个节点 | 开发者 | 引擎已建 | 1. Start/Agent/LLM/Tool/HTTP/Condition/ConditionAgent/Iteration/Loop/HumanInput/DirectReply/CustomFunction/ExecuteFlow/Retriever 全部可用 | ❌ 未实现 | `packages/workflow/src/nodes/` 目录不存在；0/14 节点迁移 |
| UC-WF-09 | DAG 拓扑排序执行 | 引擎 | flow 有节点+边 | 1. 根据 edges 计算执行顺序<br>2. 节点 output 作为下游 input | ❌ 未实现 | `packages/workflow/src/engine/executor.ts` 不存在 |
| UC-WF-10 | 分支处理（Condition/ConditionAgent） | 引擎 | flow 有分支节点 | 1. Condition 节点根据条件选路径<br>2. ConditionAgent 类似 | ❌ 未实现 | 节点未迁移 |
| UC-WF-11 | 循环处理（Iteration/Loop） | 引擎 | flow 有循环节点 | 1. Iteration/Loop 重复执行子路径 | ❌ 未实现 | 节点未迁移 |
| UC-WF-12 | 流式输出 token/工具调用/思考过程 | 引擎 | 执行中 | 1. SSE 推送多种事件类型 | ❌ 未实现 | `packages/workflow/src/engine/sse-streamer.ts` 不存在 |

---

## 11. 关键差距汇总（按优先级）

### P0 — 阻塞 Chat-First 核心体验

| 差距 | 影响 | 涉及 UC |
|------|------|---------|
| Chat 触发机制完全未实现 | 用户发消息无回复，chat 不可用 | UC-TRG-01/02/03/04/06, UC-CHAT-04, UC-CHAT-09 |
| composer agent selector 是空壳 | 无法选 agent | UC-CHAT-05, UC-AGT-04 |
| `lib/chats.ts` 无 streamMessage | 无 SSE 接收能力 | UC-TRG-06 |
| 后端 `POST /chats/:id/messages` 不解析 @ 命令 | @flow/@daemon/@agent 全失效 | UC-TRG-02/03/04 |
| chat.status 不更新 | UI 状态停留在 idle | UC-CHAT-13 |

### P1 — 架构契约缺口

| 差距 | 影响 | 涉及 UC |
|------|------|---------|
| 工作流引擎内聚（§9）整章未实现 | 仍依赖 Flowise，架构核心目标未达 | UC-WF-01 ~ UC-WF-12 |
| Daemons 三栏页面仅占位 | 一级模块无功能 | UC-DAE-01 ~ UC-DAE-06 |
| 顶部目录选择器缺失 | 无法切换默认目录 | UC-CHAT-02 |
| 建议卡未按架构跳转 | 4 张卡行为不符合 §5.2 | UC-CHAT-03 |
| sidebar 无 Search | 架构 §2.3 明确要求 | UC-NAV-08 |
| chat 状态点缺消息数和状态文本 | 架构 §2.3 要求"+ 消息数 + 状态" | UC-NAV-05 |

### P2 — 体验增强

| 差距 | 影响 | 涉及 UC |
|------|------|---------|
| chat 绑定 agent/flow 无编辑入口 | 无法在 detail 页改绑定 | UC-CHAT-11 |
| system 消息无特殊样式 | 视觉不符合 §5.3 | UC-CHAT-12 |
| 执行记录非真正 run 列表 | 上下文面板信息不全 | UC-CHAT-10 |
| directory settings 无 UI 管理 | quota/default agent 无法改 | UC-DIR-03 |
| sidebar N+1 fetch chats | 目录多时性能差 | UC-NAV-03 |
| 旧路由/旧 API 未清理 | `/dashboard` `/lab` `/chat` `/workspace` `/api/chat` `/api/workspaces` `/api/lab` 仍存在 | （未单列 UC） |

---

## 12. 与架构文档章节对照

| 架构章节 | 内容 | 实现状态 |
|---------|------|---------|
| §1 背景与目标 | Chat-First 升 home | ✅ 已落地 |
| §2.1 共存模式 (B) | 9 屏保留 + chat-first 新增 | ✅ 已落地 |
| §2.2 路由表 | 平级路由 + 砍 5 旧路由 | ⚠️ 新路由全有，旧路由文件未删（nav 已清理） |
| §2.3 双维度组织 | sidebar 按目录折叠 | ⚠️ 框架已实现，缺 Search + 消息数 + 状态文本 |
| §2.4 Chat 触发方式 | selector + @ 命令 | ❌ selector 空壳，@ 命令未实现 |
| §2.5 数据迁移策略 | workspaces→directories | ✅ migration 1720000009001 已建 |
| §3.1 新增表 | directories/chats/chat_messages | ✅ 三表 + entities 已建 |
| §3.2 修改表 | runs.chat_id | ✅ migration 1720000009000 已建 |
| §3.3 废弃表 | workspaces 等 | ⚠️ 表保留（架构允许保留一段时间） |
| §4.1 Directories API | 5 个 endpoint | ✅ 全部实现（在 gateway，非 dispatch） |
| §4.2 Chats API | 7 个 endpoint | ⚠️ 7 个 route 都有，但 `POST /:id/messages` 不含 @ 命令与执行逻辑 |
| §4.3 Console API 代理 | thin proxy | ✅ `/api/directories` + `/api/chats` 全套代理已建 |
| §4.4 现有 API 调整 | 废弃 workspaces/chat | ⚠️ 旧 API 仍在（未到清理阶段） |
| §5.1 页面结构 | (chat) 布局组 | ⚠️ 未用 `(chat)` route group，但功能等价 |
| §5.2 Chat Home | 目录选择器 + 建议卡 + composer | ⚠️ 缺顶部目录选择器，建议卡行为不符 |
| §5.3 Chat Detail | 面包屑 + 双栏 | ⚠️ 框架在，缺 SSE + @ 命令 + system 样式 |
| §5.4 Daemons | 三栏 | ❌ 仅占位 |
| §6 服务层职责 | dispatch+gateway+scheduler | ⚠️ directories/chats 路由实现在 **gateway** 而非架构写的 **dispatch** |
| §7 迁移计划 | 4 阶段 | ✅ 阶段 1-3 大部分完成，阶段 4 清理未做 |
| §8 风险与缓解 | 5 项风险 | — |
| §9 工作流引擎内聚 | 14 节点 + DAG + 新 API | ❌ 完全未实现 |

---

## 13. 文件级差距清单

### 缺失文件（架构要求但未建）

| 文件 | 架构位置 | 用途 |
|------|---------|------|
| `packages/workflow/package.json` | §9.1, §10 | 工作流引擎包 |
| `packages/workflow/src/index.ts` | §9.1 | 公共导出 |
| `packages/workflow/src/types/flow.ts` | §9.1 | FlowNode/FlowEdge/FlowData |
| `packages/workflow/src/types/node.ts` | §9.1 | INode/INodeData/NodeOutput |
| `packages/workflow/src/types/execution.ts` | §9.1 | ExecutionStatus/IExecutedNode |
| `packages/workflow/src/engine/executor.ts` | §9.3 | DAG 执行引擎 |
| `packages/workflow/src/engine/node-registry.ts` | §9.1 | 节点注册 |
| `packages/workflow/src/engine/runtime.ts` | §9.1 | 运行时状态 |
| `packages/workflow/src/engine/sse-streamer.ts` | §9.3 | SSE 流式输出 |
| `packages/workflow/src/nodes/*.node.ts` (×14) | §9.1 | 14 个节点 |
| `packages/workflow/src/utils/{prompt,variables,memory}.ts` | §9.1 | 工具函数 |
| `packages/db/src/migrations/1720000009002-create-flows-table.ts` | §9.4 | flows 表 |
| `packages/db/src/entities/flow.entity.ts` | §9.4 | Flow entity |
| `apps/gateway/src/routes/workflows.ts` | §9.5 | 新 workflow API |
| `apps/console/src/app/api/workflows/route.ts` | §9.5 | console proxy |
| `apps/console/src/app/api/workflows/[id]/route.ts` | §9.5 | console proxy |
| `apps/console/src/app/api/workflows/[id]/run/route.ts` | §9.5 | SSE proxy |

### 需修改文件

| 文件 | 需要的修改 |
|------|-----------|
| `apps/console/src/components/chat-composer.tsx` | agent selector 接真实 agent 列表 + @ 补全弹窗 |
| `apps/console/src/components/chat-home.tsx` | 加顶部目录选择器；建议卡支持跳转 `/flows`/`/agents` |
| `apps/console/src/components/chat-detail.tsx` | handleSend 调 streamMessage；接入 SSE；发送后刷新 chat.status |
| `apps/console/src/components/chat-context-panel.tsx` | agent/flow 改可编辑；执行记录改用 runs 表 |
| `apps/console/src/components/chat-nav-sidebar.tsx` | 加 Search 输入框；chat item 加消息数+状态文本 |
| `apps/console/src/lib/chats.ts` | 新增 `streamMessage(chatId, content, agentIdOverride?)` 处理 SSE |
| `apps/console/src/app/daemons/page.tsx` | 实现三栏布局（移植 design/daemon-execution.html） |
| `apps/gateway/src/routes/chats.ts` | `POST /:id/messages` 实现 §4.2 sendMessage 伪代码（@ 命令 + 调度） |
| `apps/gateway/src/routes/chats.ts` | `PATCH /:id` schema 加 agentId/flowId |
| `apps/gateway/src/app.ts` | 移除 Flowise 代理挂载（阶段 7） |
| `apps/gateway/src/routes/workspace-flowise.ts` | 阶段 7 删除 |

---

## 14. 结论

Chat-First 范式的**骨架已搭好**（路由、布局、sidebar、composer、CRUD API、DB 迁移），但**肌肉未长齐**：

1. **Chat 不会"回话"** — 最致命的缺口。前端发消息只写入 user message，后端不调 gateway prediction，无 SSE，无 assistant 回复，无 @ 命令。这让整个 Chat-First 退化成"留言板"。
2. **工作流引擎内聚（架构 §9）整章空白** — 这是架构的另一个核心目标，0% 完成。
3. **Daemons 是占位页** — 一级模块无任何功能。
4. **细节偏差** — 顶部目录选择器、建议卡跳转、sidebar Search、chat 状态文本、agent selector 等多个 §5.x 细节未对齐。

建议下一步按 P0 → P1 → P2 顺序补齐，优先让 chat 真正能对话（UC-TRG-01/06 + UC-CHAT-09），再推进工作流引擎内聚（§9 整章），最后做 Daemons 三栏与细节打磨。
