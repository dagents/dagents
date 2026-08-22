# 执行生命周期与取消（Execution Cancellation）设计

> **日期**: 2026-08-22
> **状态**: Implemented（阶段 1–3 已落地，2026-08-22：contracts signal / 三栈接线 / 引擎 cancelled / 注册表 / cancel 端点 / chat:cancelled 帧 / boot 清扫 / console 停止按钮；Deferred 的 dispatch 取消未做）
> **基于**: `docs/product-plan.md` 方案 B（B2 部分）· `docs/product-architecture.md` AD-1 / AD-6
> **关联**: B1（超时铺全）可独立先行交付，不依赖本 spec；本 spec 只覆盖「显式取消链」

## 1. 背景与现状事实链

全链路无取消通道，逐层现状（2026-08-22 摸底）：

| 层 | 现状 | 锚点 |
|---|---|---|
| 前端 | 停止按钮纯 UI 截断（置 ref 忽略后续 WS 帧），不调任何后端 API；注释自认 "The backend agent may keep running" | `apps/console/src/components/chat-detail.tsx` `handleStop` |
| WS 协议 | 帧仅 `chat:message` / `chat:done` / `chat:error`；客户端→服务端仅 `subscribe`/`unsubscribe`；无取消帧 | `packages/contracts/src/ws.ts`、`apps/gateway/src/ws-hub.ts` |
| gateway 路由 | 无 cancel 端点；无「进行中执行」注册表——运行状态唯一真相是 DB `chats.status`（best-effort UPDATE），无法按 chatId 定位/终止执行 | `apps/gateway/src/inline-executor.ts` |
| 引擎 | `ExecuteOptions.signal` 形参存在但 4 个 gateway 调用点从不传入；检查点仅在 wave 之间；abort 时产出 `failed`，`ExecutionStatus.cancelled` 是死枚举 | `packages/workflow/src/engine/executor.ts` |
| adapters | `ExecOptions` 无 signal；`ChildProcess` 封装在闭包内不可达；kill 已存在（`killWithEscalation`：SIGTERM → 5s → SIGKILL）但只由超时触发；`claude.ts:635` 留有明确 TODO | `packages/contracts/src/agent.ts`、`packages/agent-adapters/src/stream-backend.ts` |
| dispatch/daemon | `dispatch_tasks` 状态机无 cancelled；daemon 串行 pull、SIGTERM 等 in-flight 跑完 | migration `1720000000000`、`packages/daemon/src/main.ts` |
| 重启 | gateway 崩溃/重启 → `chats.status='running'` 永久悬空（无 reaper）；HumanInput 挂起同理（内存 Promise 随进程消失） | `routes/human-input.ts` 头注释 |

三个对成本有利的既有事实：kill 升级机制已实现（只需暴露触发口）；引擎 signal 形参已预留（只需接线）；`AgentResult.cancelled` / `ExecutionStatus.cancelled` 枚举已存在（只需生产者）。

## 2. 目标与非目标

### 目标

1. inline 路径的三种执行（chat agent 执行 / chat `@flow` 执行 / `POST /workflows/:id/run`）在用户显式取消后 **5s 内真正终止**（CLI 进程退出、HTTP fetch abort）。
2. `cancelled` 成为一等执行状态：adapters → 引擎 → runs / chat 消息 → WS 帧 → 前端全链贯通，与 `failed` 语义区分。
3. gateway 重启后悬空的 `chats.status='running'` 有确定性收敛（AD-6）。

### 非目标

- **daemon/dispatch 远程任务取消**：需要状态机加 `cancelled` + 认领协议扩展（daemon 下一次 poll 才能感知，且 daemon 无法中断 in-flight 的 `backend.execute()`）——明确延后（§7 占位）。
- **SSE/WS 断开 ≠ 取消**：客户端掉线不终止执行（跑完写库）；只有显式取消才停。行为可预测、文档化。
- **多实例执行注册表**：单进程红线（见 product-architecture AD-1），不引入 Redis / pub-sub。
- **节点内部强抢占**：v1 取消语义在**节点边界**生效（见 D3），不追求 CustomFunction 死循环的硬抢占（那是 isolated-vm 的既有取舍）。

## 3. 架构决策

### D1 contracts：signal 进入执行契约

- `ExecOptions` 加 `signal?: AbortSignal`（`packages/contracts/src/agent.ts`）。
- 约定：signal abort 后，backend 必须走 kill 升级并在 `AgentResult` 产出 `status: 'cancelled'`（`'aborted'` 保留给超时场景）。

### D2 adapters：signal → 既有 kill 路径接线（三套 spawn 栈都要）

三套实现分别接线，并抽共享触发件（不做全量合并）：

1. `stream-backend.ts` `spawnStreamAgent`：watch `signal` → 调 `killWithEscalation`；`result` resolve 为 `cancelled`。
2. `claude.ts` 独立副本：同样接线（顺带还掉 `claude.ts:635` 的 TODO）。
3. `acp-backend.ts`：signal → 关闭 JSON-RPC 进程（ACP 协议的 shutdown best-effort，超时走 kill）。

抽出共享的 `wireCancellation(signal, kill)` 小工具放 `agent-adapters` 内部，三处共用，避免三种取消语义。v1 覆盖优先级：claude / codex（core 分级），其余 adapter 共享栈自动受益，ACP 栈可后置。

### D3 引擎：signal 接线 + cancelled 产出 + 节点边界语义

- gateway 4 个调用点（`routes/chats.ts`、`routes/workflows.ts` run、`chat-execute.ts` flow 路径、`workflow-clients.ts` ExecuteFlow）创建 `AbortController` 传入 `ExecuteOptions.signal`。
- abort 时：运行中节点通过 signal 令底层 CLI/HTTP 快速失败；executor 在最近的检查点（wave 边界 / loop 迭代边界 / 当前节点失败返回）退出，**最终 status 产出 `cancelled`**（不再映射成 `failed`）；`run_node_spans` 中被波及节点标 `failed`，run 整体 `cancelled`。
- LLM 节点：llmClient 的 fetch 接 signal（HTTP 路径）；CLI 路径 signal 即进程 kill。
- 文档化：取消生效粒度是「当前节点尽快终止 + 不再调度后续 wave」。

### D4 gateway：ExecutionRegistry（内存）

```ts
// apps/gateway/src/execution-registry.ts（新）
interface ExecutionHandle {
  key: { chatId: string } | { runId: string }
  kind: 'chat-agent' | 'chat-flow' | 'workflow-run'
  abort: AbortController
  startedAt: number
  cancel(reason: string): Promise<void>
}
// Map<chatId, Handle> + Map<runId, Handle>；执行开始注册、finally 注销
```

- 单 chat 同时一个执行（现模型已如此）；`chats.status` 仍为 DB 真相源，registry 只是「能找到并终止」的进程内索引。
- cancel：触发 `abort.abort()` → 等待执行 promise settle（≤5s，超时则报告「取消超时，进程可能残留」并兜底 `killWithEscalation` 的 SIGKILL 段）。

### D5 API：取消端点

| Method | Path | 行为 |
|---|---|---|
| `POST` | `/api/v1/chats/:id/cancel` | 查 registry（chatId）→ cancel → 返回 `{ status: 'cancelled' }`；无进行中执行返回 409 `{ error: 'no active execution' }` |
| `POST` | `/api/v1/workflows/:id/runs/:runId/cancel` | 同上（runId 键）；stretch，可随 D4 一并出 |

鉴权随既有路由（`GATEWAY_API_KEY` 模式自动覆盖）。

### D6 WS：`chat:cancelled` 帧 + 前端接线

- `packages/contracts/src/ws.ts` 加 `chat:cancelled`（payload 含 runId、reason）；`isChatFrame` 同步；gateway 在 cancel settle 后广播。
- console `handleStop` 改为：调 `POST /api/v1/chats/:id/cancel` → 等待 `chat:cancelled` 帧（按钮态「停止中…」）→ 收帧后本地截断收尾；API 409（已结束）则直接按 `chat:done` 已到达处理。保留本地截断作为 WS 丢帧的兜底。

### D7 重启清扫（AD-6）

gateway 启动时：`UPDATE chats SET status='failed' WHERE status='running'`（附一条 system 消息「执行被 gateway 重启中断」）；runs 同扫 `running→failed`（cancelled 语义留给显式取消）。HumanInput 挂起项随进程消失是既有取舍，不改（文档已载）。

## 4. 实施阶段（依赖顺序）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 1 | D1 + D2（contracts 加字段是加法，不破坏现有适配器；fake backend / 慢进程夹具测 kill 与 cancelled 产出） | 无 |
| 2 | D3（引擎接线 + cancelled 产出；单测：wave 间 abort、loop 迭代间 abort、LLM 节点 signal） | 阶段 1 |
| 3 | D4 + D5 + D6 + D7（registry、端点、WS 帧、前端、boot 清扫；e2e：mock LLM 慢响应场景点停止） | 阶段 2 |
| 4 | `workflow-engine.md` § 现状与限制摘除对应条目（LLM 无超时随 B1、adapter 无取消随本 spec） | 全部 |

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 三套 spawn 栈接线遗漏 | 阶段 1 用统一夹具（慢进程脚本）逐栈测试；`wireCancellation` 共享件收敛语义 |
| claude 被 kill 后会话状态丢失 | 取消 = 用户显式丢弃，可接受；文档化（如未来要「停止但保留会话」，走 claude `--resume` 另立 spec） |
| cancel 后消息/状态竞争（done 与 cancelled 帧乱序） | cancel settle 前 `persistComplete` 已写 done 则 WS 帧以先到终态帧为准，前端幂等处理 |
| 引擎 wave 内 `Promise.all` 等待 | signal 使运行节点快速失败，wave 提前结算；不重构调度器 |
| registry 与 `chats.status` 双真相漂移 | 规则成文：DB 是状态真相源，registry 只是控制通道（与横切关切 #1 一致） |

## 6. 验收标准

- [ ] 聊天 CLI 执行中点停止：`ps` 验证进程 5s 内退出；WS 收到 `chat:cancelled`；消息标注「已取消」；`chats.status='idle'`。
- [ ] workflow run 取消：runs.status='cancelled'（非 failed）；node spans 状态正确；后续 wave 未调度。
- [ ] cancel 端点对无执行 chat 返回 409；重复 cancel 幂等。
- [ ] gateway 启动清扫：人为制造 running 悬空行，重启后收敛 failed + system 消息。
- [ ] e2e（mock LLM 慢响应）：停止按钮 → cancelled 帧全链路（spec 15 序列可扩）。
- [ ] 正常长生成（>30s 流式）不受影响（非目标边界的回归保护）。

## 7. Deferred：dispatch/daemon 取消（占位，不在本 spec）

若未来做：`dispatch_tasks` 状态机加 `cancelled`（migration）+ 任务行加 `cancel_requested` 标记 + daemon heartbeat 顺带回传取消感知 + daemon 端 signal 接线（D2 完成后天然可用）。触发条件：remote agent 成为主路径，或用户反馈远程任务无法停止成为高频痛点。
