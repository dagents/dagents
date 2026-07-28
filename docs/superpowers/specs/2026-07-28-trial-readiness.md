# Trial Readiness Spec：从 Demo 到可试用

> **日期**: 2026-07-28
> **状态**: Active（待评审）
> **基于**: 2026-07-28 产品经理/产品总监试用评估 + `2026-07-25-system-architecture-redesign.md` §1.4 实现状态总览
> **决策模式**: 优先级驱动（P0 兑现核心叙事 → P1 已暴露面保护 → P2 打磨）
> **关联 Plan**: `docs/superpowers/plans/2026-07-28-trial-readiness.md`

## 实现状态总览

| 章节 | 内容 | 状态 |
|------|------|------|
| §3.1 | P0-1 Chat Trigger 接调度（@flow/@daemon/@agent） | ⏳ Plan 阶段 |
| §3.2 | P0-2 Chat Home 空状态引导 + 首日留存 | ⏳ Plan 阶段 |
| §3.3 | P0-3 Workflow Engine 完整交付 | 🟡 复用既有 plan `2026-07-27-flowise-migration-v2-workflow.md` |
| §3.4 | P1-4 Daemons e2e 保护（0/6 → 3/6） | ⏳ Plan 阶段 |
| §3.5 | P1-5 Flowise 迁移期兼容承诺 | ⏳ Plan 阶段（文档） |
| §3.6 | P1-6 消息级用量/成本对用户可见 | ⏳ Plan 阶段 |
| §3.7 | P1-7 叙事语言统一（zh-CN） | ⏳ Plan 阶段 |
| §3.8 | P2-8/9/10 体验打磨（建议卡/selector/错误恢复） | ⏸️ 延期至 Trial 反馈后 |

---

## 1. 背景与目标

### 1.1 现状

2026-07-28 产品经理/产品总监试用评估结论：项目处于 **"Demo 可演、Trial 难用"** 阶段。E2E 矩阵 36/79 active（46%），核心承诺 "Chat 触发一切" 未兑现（UC-TRG 1/7），首屏即阻断（无目录无法发消息），消息级用量不可见，Daemons 一级模块 0 e2e 保护。

### 1.2 目标

- **P0**：把"Chat → 触发 → 调度 → 流式回显"主链路做到 Trial 用户能独立走完
- **P1**：把已暴露的页面（Daemons）和已宣传的能力（用量可见、语言一致）补齐并加保护
- **P2**：根据 Trial 反馈决定优先级（本期不详细规划）

### 1.3 非目标

- 不重写 Chat-First 范式（已是既定方向）
- 不替换 Next.js / Hono / TypeORM 技术栈
- 不引入新的数据库（继续用 PostgreSQL + 现有 schema）
- 不在本期实现 P2 打磨项（建议卡编辑、Agent selector 能力预览、错误恢复引导）

### 1.4 验收 Gate

**Gate-Trial-1（P0 完成）**：
1. Trial 用户在空目录状态下，从 Chat Home 内联完成"添加目录 → 发起对话 → 看到 Agent 流式回复"全流程，无需跳页
2. `@flow <name> <message>` 真正触发 scheduler fanout，运行结果回写到 chat
3. `@daemon <command>` 真正触发 dispatch invoke，任务 ID 回写到 chat
4. `@agent <name> <message>` 真正覆盖 agent 并执行
5. UC-TRG-02/03/04 三个 e2e 测试从 fixme 转为 active

**Gate-Trial-2（P1 完成）**：
1. 每条 assistant 消息底部展示 token 用量 / 耗时 / cost
2. UC-DAE-01/02/03 三个 e2e 测试从 fixme 转为 active
3. `docs/superpowers/specs/flowise-migration-compat.md` 公开承诺迁移期数据兼容策略
4. UI 文案全部统一为中文（zh-CN）

---

## 2. 范围

### 2.1 In Scope（本期）

| ID | 项目 | 优先级 | Plan 章节 |
|----|------|--------|-----------|
| TR-1 | Chat Trigger 接调度 | P0 | Plan Phase 1 |
| TR-2 | Chat Home 空状态引导 | P0 | Plan Phase 2 |
| TR-3 | Daemons e2e 激活 | P1 | Plan Phase 3 |
| TR-4 | 消息级用量/成本显示 | P1 | Plan Phase 4 |
| TR-5 | Flowise 迁移期兼容承诺 | P1 | Plan Phase 5 |
| TR-6 | 叙事语言统一 | P1 | Plan Phase 5 |

### 2.2 Out of Scope（延期）

| ID | 项目 | 延期理由 |
|----|------|----------|
| TR-7 | 建议卡"填入后编辑"行为 | 等 Trial 反馈确认是高频痛点 |
| TR-8 | Agent selector 能力预览 | 等 Agent 详情页完善后协同设计 |
| TR-9 | 流式错误恢复引导 | 等 streaming 健康度监控上线后定方案 |
| TR-10 | Workflow Engine 完整交付 | 已有独立 plan `2026-07-27-flowise-migration-v2-workflow.md`，不重复 |

### 2.3 已确认的现状代码事实（避免 plan 重复探查）

- `apps/gateway/src/routes/chat-execute.ts` L165-201 `routeCommand` 已 stub：仅写 system message ack，**没有**调用 scheduler/dispatch
- `apps/console/src/components/chat-home.tsx` L48-51 无目录时硬阻断 `setError('请先添加项目目录')`，**没有**空状态 UI
- `apps/console/src/components/directory-selector.tsx` L65-86 已有 `handleBrowse` 调 `pickDirectory()` + `createDirectory()` 的完整能力，**可复用**
- `apps/gateway/src/inline-executor.ts` L129-133 `INSERT INTO chat_messages` **不写 metadata**，`AgentResult.usage` 被丢弃
- `packages/db/src/entities/chat-message.entity.ts` L30-31 `metadata` 字段已存在（jsonb），**无需 migration**
- `apps/console/tests/e2e/06-daemons.spec.ts` 0 active / 6 fixme，**page 已实现**（daemons-view.tsx）
- `apps/console/src/components/chat-home.tsx` L80-82 欢迎语英文，与 `<html lang="zh-CN">` 不一致

---

## 3. 架构决策（逐项）

### 3.1 TR-1 Chat Trigger 接调度（P0-1）

**决策**: 在 `routeCommand` 内真正调用下游服务，按命令种类分流：
- `@flow` → `POST {SCHEDULER_URL}/api/v1/scheduler/runs/fanout`，传 `flowId` + `input` + `chatId`（用于回写）
- `@daemon` → `POST {DISPATCH_URL}/api/v1/dispatch/invoke`，传 `command` + `chatId`
- `@agent` → 覆盖 `agentIdOverride`，复用 `executeInline()` 路径（已存在）

**回写到 chat 的策略**：
- `@flow` / `@daemon` 异步执行，gateway 立即返回 `{ taskId / runId }` system message，执行结果通过 WS 推送 `chat:message` / `chat:done`（与 inline executor 一致）
- 这要求 scheduler/dispatch 完成后回调 gateway 的内部 endpoint `POST /internal/runs/:runId/complete`（**新增**），由 gateway 写入 chat_messages

**理由**:
- 复用现有 inline executor 的 WS 推送路径，前端无感
- scheduler/dispatch 不直接写 DB（保持服务边界），通过 gateway 回调

**Trade-off**:
- ❌ 引入新的内部回调 endpoint，增加耦合
- ✅ 保持 scheduler/dispatch 的纯净（无 DB 依赖）
- ✅ 前端 UI 无需感知命令类型差异

**非选方案**:
- ❌ scheduler/dispatch 直接写 chat_messages：违反服务边界（dispatch 当前只依赖 contracts，不依赖 db）
- ❌ 前端轮询 scheduler 状态：增加前端复杂度，且与现有 WS 流不一致

### 3.2 TR-2 Chat Home 空状态引导（P0-2）

**决策**: 在 `chat-home.tsx` 检测 `directories.length === 0`，渲染 Empty State 组件，包含：
- 大图标 + 文案"开始前，请先添加一个项目目录"
- 内联 `[浏览本地目录…]` 按钮（复用 `directory-selector.tsx` 的 `pickDirectory()` + `createDirectory()` 逻辑）
- 添加成功后自动选中并隐藏 Empty State，露出欢迎屏 + composer

**理由**:
- 复用现有 `pickDirectory` 能力，不引入新 API
- 用户不离开 Chat Home 即可完成首屏配置

**Trade-off**:
- ❌ Chat Home 与 DirectorySelector 的目录加载逻辑会重复一次（需要重构提取 hook）
- ✅ 首日留存提升 outweighs 重构成本

### 3.3 TR-3 Workflow Engine 完整交付（P0-3）

**决策**: 不在本 spec 内重复规划。复用既有 plan `2026-07-27-flowise-migration-v2-workflow.md`，其 Phase 1-5 已覆盖 14 节点迁移 + 画布 + 执行引擎 + 清理。本 spec 仅依赖其 Phase 1（flows 表 + Workflows API）完成后再激活 UC-WF 测试。

### 3.4 TR-4 Daemons e2e 激活（P1-4）

**决策**: 激活 UC-DAE-01（队列列表）/ 02（时间线）/ 03（统计）三个最基础用例，从 `test.fixme` 转 `test()`。**不**激活 04/05/06（操作类，需要真实 daemon 交互，e2e 复杂度过高）。

**理由**:
- Daemons 页面已实现（daemons-view.tsx），只缺测试保护
- 三个只读用例覆盖 80% 的回归风险

**Trade-off**:
- ❌ 操作类用例（暂停/中止/重跑）无保护
- ✅ 限三个用例，避免 e2e 套件膨胀

### 3.5 TR-5 Flowise 迁移期兼容承诺（P1-5）

**决策**: 产出文档 `docs/superpowers/specs/flowise-migration-compat.md`，公开承诺：
1. 迁移期（Plan B/C 进行中）：旧 Flowise flow 数据保留，新 `flows` 表通过 migration 导入
2. 兼容窗口期：旧 `/api/v1/flows/*` proxy 路由保留至 Plan C 完成
3. 迁移完成判据：`vendor/flowise/` 删除 + e2e UC-WF-01~12 全部 active

**理由**:
- B 端产品必须对数据兼容性做明确承诺
- 文档化后，工程师有明确的清理时间表

### 3.6 TR-6 消息级用量/成本显示（P1-6）

**决策**:
1. `inline-executor.ts` 在 `chat:done` 前提取 `result.usage`（`TokenUsage` 类型已存在于 contracts），写入 `chat_messages.metadata = { usage, cost, durationMs }`
2. cost 计算：在 gateway 维护 model → price 映射（暂硬编码 claude sonnet/opus 价格，后续接 LLM Provider CRUD）
3. `ChatEvent.chat:done` 增加 `usage` 字段，前端 `AssistantContent` 渲染 footer "1.2k tokens · 3.4s · $0.012"
4. 历史消息从 `metadata` 读取，无 metadata 视为旧数据不渲染 footer

**理由**:
- 复用现有 `metadata` jsonb 字段，无 migration
- `TokenUsage` 类型已在 contracts 中定义
- WS 推送 + DB 持久化双通道，前端实时/历史统一

**Trade-off**:
- ❌ 暂硬编码价格，与 LLM Provider CRUD 解耦不彻底
- ✅ 快速交付可见性，价格配置后续接 settings

### 3.7 TR-7 叙事语言统一（P1-7）

**决策**: 全站 UI 文案统一为中文（zh-CN），与 `<html lang="zh-CN">` 一致。具体清单：
1. `chat-home.tsx` L80-82 欢迎语改为中文
2. `suggestion-cards.tsx` 建议卡文案中文化（已是中文，核对一致性）
3. 任何新加 UI 文案默认中文
4. 工程师文档（spec/plan/CLAUDE.md）保持双语，不强制

**理由**: 用户群体是中文，UI 与 lang 属性一致是基本要求。

---

## 4. 数据模型影响

**无需 migration**。所有改动复用现有 schema：
- `chat_messages.metadata` (jsonb) — 存 usage/cost/durationMs
- `chats.status` — 已有 'running'/'idle'/'done'/'failed'，无需扩展
- `chats.agent_id` / `flow_id` — 已有，用于 @agent/@flow 路由

---

## 5. 服务边界影响

### 5.1 新增 gateway 内部 endpoint

- `POST /internal/runs/:runId/complete` — scheduler/dispatch 完成后回调，body 携带 `{ chatId, output, usage, status }`，gateway 写入 chat_messages + WS 广播

**认证**: 仅本机调用（bind 127.0.0.1 + 共享 secret header `x-internal-token`，env 配置）

### 5.2 scheduler / dispatch 调用约定

- scheduler `POST /api/v1/scheduler/runs/fanout` 请求体增加 `chatId` 字段（可选），完成后回调 gateway
- dispatch `POST /api/v1/dispatch/invoke` 请求体增加 `chatId` 字段（可选），完成后回调 gateway
- 两个服务均不直接读/写 chat_messages 表

---

## 6. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| @flow 触发后 scheduler 不回调 gateway | 中 | chat 状态卡 running | 增加 30s 超时 + `recoverStaleRuns` 兜底（已有） |
| 内部 endpoint 被外部访问 | 低 | 数据泄露 | bind 127.0.0.1 + 共享 secret + 与现有 SSO 中间件分离 |
| AgentResult.usage 在某些路径为空 | 高 | 用量 footer 不显示 | 前端 fallback：无 metadata 时不渲染 footer（不报错） |
| Flowise 迁移期 flows 表与旧 chatflows 数据冲突 | 中 | 历史 flow 不可用 | 兼容承诺文档明确"迁移窗口期双写" |
| Daemons e2e 在 CI flaky | 中 | 套件不稳定 | 限定只读用例 + 60s timeout + retry |

**回滚策略**:
- 每个 Phase 独立 commit，单 Phase 失败可 git revert 不影响其他
- @命令 stub 行为保留为 fallback：若下游服务不可达，回退到写 system message ack

---

## 7. 优先级与排期口径

| Phase | 项目 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | TR-1 Chat Trigger 接调度 | P0 | 无 |
| Phase 2 | TR-2 Chat Home 空状态引导 | P0 | 无（与 Phase 1 并行） |
| Phase 3 | TR-4 Daemons e2e 激活 | P1 | 无 |
| Phase 4 | TR-6 消息级用量显示 | P1 | 无 |
| Phase 5 | TR-5 Flowise 兼容文档 + TR-7 语言统一 | P1 | TR-1 完成（语言文案涉及新 system message） |

**P0 必须先于 P1 完成**。Phase 1/2 可并行，Phase 3/4/5 可并行。

---

## 8. 验证策略

- **单元测试**: 每个新函数（parseCommand 已有 / routeCommand 重写 / formatUsageFooter 等）
- **E2E**: 激活 fixme 测试为首要交付物（UC-TRG-02/03/04, UC-DAE-01/02/03）
- **手动验证**: Trial 用户走查主链路（添加目录 → 发消息 → @flow → @daemon → 看到用量）

---

## 9. 引用

- 架构真相源：`docs/superpowers/specs/2026-07-25-system-architecture-redesign.md`
- 既有 Workflow 迁移 plan：`docs/superpowers/plans/2026-07-27-flowise-migration-v2-workflow.md`
- E2E 测试矩阵：`apps/console/tests/e2e/README.md`
- 产品评估原始记录：2026-07-28 session memory（产品经理/产品总监试用）
