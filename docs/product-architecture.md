# 产品方案架构分析（2026-08-22 起）

> 对 [product-plan.md](product-plan.md) 七个方案（A–G）的架构分析：受力点、单源决策（AD-1~AD-6）、横切关切与里程碑修订。**活文档**：AD 决策随实施推进更新状态；一次性判断的原始记录见 [product-review.md](product-review.md)。B2 取消链的完整设计已独立成 spec：[superpowers/specs/2026-08-22-execution-cancellation-design.md](superpowers/specs/2026-08-22-execution-cancellation-design.md)。

## 0. 总判断

分层架构本身健康，产品方案没有方向性冲突——但 A–G 的受力点全部落在当前架构最薄的三处：

1. **执行生命周期无一等表示**（方案 B 的前提）：全链路无取消通道，`AgentResult.cancelled` / `ExecutionStatus.cancelled` 是无生产者的死枚举，gateway 无进行中执行注册表。
2. **运行/用量数据模型分裂**（方案 D 的前提）：全库只有 workflow run 一处 INSERT runs；chat 的 runId 是不落库的幽灵 UUID；usage 散落 4 处；`runs.cost` 是无 writer 的死列。
3. **业务逻辑越界住进 console BFF**（方案 A 的前提）：整套生成 prompt 工程住在 console 侧且与 gateway 平行重复。

好消息：架构到处留了"缝"——executor 已有 `signal` 形参、adapter 内部已有 SIGTERM→SIGKILL 升级杀进程（`killWithEscalation`）、WS 已有预留帧。**方案 B 是"接线"而不是"重建"**；其余方案均为加法。

## 1. 架构现状速写（明确保留的资产）

- **依赖方向无环**：`contracts ← {agent-adapters, daemon, db} ← gateway`，`workflow ← gateway`；contracts 零依赖纯类型。骨架不动。
- **引擎 DB-free + 依赖注入**：`packages/workflow` 不碰库，装配在 gateway。这使"拓扑校验器放 workflow 包、console 与 gateway 共用"合法（console 已依赖该包，canvas loader 用 `getNodeMeta`）。
- **单进程假设是显式决策**：`routes/human-input.ts` 头注释 "deliberately in-memory (single-process gateway, local mode)"。**红线：不引入 Redis / 消息总线**，新状态（执行注册表）就住内存。
- **registry-not-database** 已被 skills 与 agent-library 双重验证，生成遥测（A5）沿用即可。

## 2. 架构决策清单

| # | 决策 | 服务于 | 状态 |
|---|---|---|---|
| AD-1 | gateway 内存执行注册表 + 全链路取消协议；dispatch 取消延后 | 方案 B | ✅ 已落地（spec 阶段 1–3，2026-08-22） |
| AD-2 | flow 拓扑校验单源 = 扩展 `@dagents/workflow` 的 `flowDataSchema`；生成逻辑收敛回 gateway | 方案 A | ✅ 已落地（validate-topology + flow-generator.ts，2026-08-22） |
| AD-3 | 新增追加式 `usage_events` 表作账单唯一真相源；不强行统一 runs | 方案 D | ✅ 已落地（三路写入 + /usage/summary 账单页，2026-08-22） |
| AD-4 | 生成遥测独立表 `generator_attempts`，不混 audit_log | 方案 A5 | ✅ 已落地（2026-08-22） |
| AD-5 | BFF 边界规则成文：console 只允许纯代理 + Flowise 形状适配 | 横切 | ✅ 已执行（flow-generator.ts 迁回 gateway 为第一案例，2026-08-22） |
| AD-6 | gateway 重启清扫：boot 时把悬空 `chats.status='running'` 收敛为 failed | 方案 B | ✅ 已落地（index.ts boot sweep，2026-08-22） |

### AD-1 执行注册表与取消协议（方案 B）

- gateway 内新增内存 `ExecutionRegistry`：`Map<chatId | runId, ExecutionHandle>`（handle 含 AbortController、执行种类、startedAt）。单进程假设下合法且够用。
- contracts `ExecOptions` 加 `signal?: AbortSignal`；adapters 三套 spawn 栈（`claude.ts` 独立副本、`stream-backend.ts` 共享版、`acp-backend.ts`）统一把 signal 接到既有 `killWithEscalation`，抽共享触发件避免三种取消实现。
- 引擎四个 gateway 调用点传入 signal；abort 产出 `cancelled`（不再伪装 failed）。
- **收缩边界**：daemon/dispatch 取消延后（状态机无 cancelled、daemon 串行 pull 且 SIGTERM 等 in-flight 跑完，需要协议扩展 + migration，收益/成本不成比例）；SSE 断开 ≠ 取消（显式取消才停，写进文档保证行为可预测）。
- 详细设计：[2026-08-22-execution-cancellation-design.md](superpowers/specs/2026-08-22-execution-cancellation-design.md)。

### AD-2 校验单源 + 生成逻辑回家（方案 A）

- 现状三份 flow 定义（`workflow/src/types/flow.ts` 类型、`utils/flow-data.ts` zod canonical、db entity 内联）+ console 自有一套 Flowise 形状 schema。**不新建：扩展 `flowDataSchema` 为 `validateFlowTopology()`（startAgentflow 存在、边引用闭合、节点类型白名单），住 `packages/workflow`**；gateway 三入口（保存 / 生成 / 模板实例化）与 console 画布警告条共用。
- 生成服务收敛为 gateway 模块（复用 `workflow-clients.ts` 双引擎底座）；**BFF 端点形状原样保留、退化为纯代理**——vendored canvas 只认 `/api/flowise` 形状且 generate 路由有 `agent::<id>` / `providerId::model` 双引擎语义，搬家时必须保真（建议先补契约测试再搬）。

### AD-3 usage_events 账单真相源（方案 D）

- **不把 chat 执行塞进 runs**（runs 是 workflow 语义：`pipeline_id` + node spans；chat 消息量远大于 run，语义过载 + 滚胀风险）。
- 新表 `usage_events(source, chat_id, run_id, task_id, agent_id, model, usage jsonb, cost, priced bool, created_at)`，chat / workflow run / dispatch 终态各写一条；账单页只读此表。
- **决定性优势**：`priced=false`（单价未知）的行在价格表更新后可回算重定价——「诚实不造假」原则的数据模型表达。
- 配套：runs 补 workflow 路径的 cost writer（消灭死列）；`@flow` 聊天路径写 usage_event 即可，不必补 runs；价格 = 代码常量基线 + `llm_providers` JSONB per-model 覆写，不建独立价格表。

### AD-4 生成遥测独立表（A5）

audit_log 是用户动作审计（现仅 workflows / llm-providers 写入），生成尝试是遥测——语义不同，分表。

### AD-5 BFF 边界规则

console 允许且仅允许两类代码：**纯代理**（gatewayProxy 直通）与 **Flowise 形状适配**（vendor 组件强制的转换层）。业务决策逻辑一律住 gateway/packages。`lib/flow-generator.ts` 整套 prompt 工程是第一个违例，A1 是第一个执行案例。

### AD-6 重启清扫

gateway 崩溃/重启时 `chats.status='running'` 悬空无 reaper（persistComplete 没机会跑）——boot 时扫 running→failed（文案「被 gateway 重启中断」），与 HumanInput 内存态丢失同类，随 B2 收口。

## 3. 逐方案架构要点

| 方案 | 架构含义 | 关键风险 |
|---|---|---|
| A 生成闭环 | AD-2 / AD-4；`chat-execute.ts`（0 zod 上帝文件）随拆分按命令类型裂模块 | A1 搬家对 BFF 双引擎语义的保真（最大单点风险，先补契约测试） |
| B 可中断 | AD-1 / AD-6；**拆 B1（超时，机械活）与 B2（取消链，唯一需要完整 spec 的件）**；B1 含便宜的一枪——adapters 早就支持 `timeoutMs`/`inactivityTimeoutMs`，`executeInline` 只是没传 | 三套 spawn 栈接线遗漏；claude 被 kill 的会话语义（取消即丢弃，可接受，需文档化） |
| C codex 回归 | 最轻：codex 是 `spawnStreamAgent` 上 264 行薄壳，回归主要验 `parseLine`；真机事件样本固化夹具入 `packages/agent-adapters` | 暴露三套 spawn 并存的债——现在不合并，B2 接线时抽共享 kill/signal 件 |
| D 成本 | AD-3；migration 顺序：usage_events → runs 补 writer → 账单页 → 删 console flat 估算层 | 4 处旧 usage 数据不回填（只管增量），账单页标注起点时间 |
| E 适配器分级 | 元数据单源在 agent-adapters/contracts；README「同源」只能生成式（README 无法 import TS）：codegen 或 CI 校验 | 无结构风险 |
| F 叙事 | 几乎无架构面；唯一接线 = onboarding 探针放宽为「CLI **或** provider」 | 无 |
| G 模板参数化 | `flow_templates` 加 `params JSONB` 增量列；`{{var}}` 与引擎既有变量解析（`utils/variables.ts`）共用语法，避免两套占位符语义 | 无 |

## 4. 横切关切

1. **事件系统规则成文**：已有三套（ws-hub / dispatch_task_events / audit_log），A5/D 再各加一表。不建事件总线，但立规矩——**WS 帧只是 UI 推送，DB 表才是真相源**；掉线重连从表恢复，不指望 WS 重放。
2. **与架构真相源 spec 的两处漂移**（不阻塞，应回写 `2026-07-25-system-architecture-redesign.md` 状态表）：① 正文 §4 API 表仍写 dispatch/scheduler 独立服务（2026-08-01 Plan A 已并入 gateway）；② §9.7 说 console 不直接依赖 workflow 包，实际已直接依赖（且这是 AD-2 的前提，spec 应改成事实）。

## 5. 里程碑的架构修订

- **M1 内部重排**：B1（超时）独立先行，1–2 天级；A2 校验器先落 workflow 包（不碰 gateway）；A1 搬家（先补契约测试）；B2 走 spec 评审后实施（contracts 变更 + 注册表 + WS 帧 + 重启清扫四件捆审）。
- **M2 的 D 按 AD-3 执行**（usage_events 而非 runs 统一）。
- 唯一需要完整 superpowers spec 流程的件是 B2，其余走常规 plan。
