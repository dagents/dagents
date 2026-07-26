# 原型设计 vs MVP Spec 功能支持分析

> **日期**：2026-07-08
> **对照对象**：`design/` 下 7 个 HTML 原型（open-design 生成）vs `docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md`
> **结论先行**：**spec 能支持原型约 60% 的功能**，其余 40% 分两类——① MVP 范围内但 spec 未显式覆盖（需补任务）；② 超出 MVP 范围（百万级 fleet、多区域、通知系统等，需明确推迟或降级）。

---

## 1. 原型功能盘点（6 个产品页 + 1 launcher）

| 页面 | 功能点 | 数据来源（原型） |
|---|---|---|
| **资源看板** dashboard | 百万级 fleet 实时密度、状态分布、24h 吞吐、区域资源、成本熔断 | `dashboard.html`（数据源标注：Langfuse + 自研 runs 表 + 网关探测） |
| **Agents** agents | 提示词 agent + 异构 CLI agent 的列表/看板/详情；按类型/状态/角色/区域过滤；能力描述符、当前 run、资源占用、日志流 | `agents-data.js`：12 个样本 agent，字段含 `capabilityDescriptor`/`agent_daemons`/`runs.agent_daemon_calls` |
| **AgentFlows** agentflows | Agentflow V2 DAG 可视化；节点=agent/工具/分支/HITL，边=数据流，状态着色；节点级 run 耗时/预算/token/成本/超时/日志 | `flows-data.js`：3 个 flow（批量复现/假设验证/发布门控），14 类节点，字段含 `version`/`hash`/`runId` |
| **Lab** lab | 多 agent 协作聊天室；自动实验 + 人工介入；产出假设/数据/代码/artifact；带 thinking、tool-use、@提及 | `lab-data.js`：5 个实验会话 + 线程化消息（含 thinking、tool 调用块） |
| **Workspace** workspace | 按项目隔离的人-agent 对话记录；成员、关联 flow、产物、配额；对话线程 + 附件 | `workspace-data.js`：5 个项目 + 每项目对话线程（含 run 引用、附件） |
| **设置** settings | new-api 令牌 CRUD、网关健康探测、默认模型、预算配额与熔断、通知、账户与团队、危险区 | `tokens-data.js`：8 个 token（new-api 模型）；settings 6 个 tab |

**原型与 v0.2 架构的对齐度**：原型数据文件的注释多处明写 "Aligned to v0.2 schema"，说明设计稿就是照着 v0.2 文档做的。这是好消息——实体定义一致。

---

## 2. 功能支持对照（原型功能点 → spec 覆盖）

### 2.1 spec 已覆盖（MVP 范围内，任务已存在）

| 原型功能 | spec 覆盖位置 | 状态 |
|---|---|---|
| 异构 CLI agent 经 daemon 接入 | P1.5 dispatch + P1.6 daemon/adapter | ✅ |
| 提示词 agent（Flowise 原生） | P1.9 vendor/flowise + M1 | ✅ |
| Agent 能力描述符分派 | P1.1 contracts `capabilityDescriptor` | ✅ |
| Agentflow V2 DAG 画布 | P1.9（forked Flowise 画布） | ✅ |
| 14 类节点（含 HITL/Iteration/Condition） | P1.9 + M1 | ✅ |
| HTTP→dispatch 自定义节点 | P1.9.T3 | ✅ |
| 批量 fan-out | P1.7.T4 + M3 | ✅ |
| run 绑定 version + 复现 | P1.8 + M4 | ✅ |
| artifact 归档 | P1.8.T4 | ✅ |
| run 全链路 trace（run_id） | P1.4.T3 + P1.11 | ✅ |
| 资源面板 MVP（用量/成本/daemon 状态） | P1.11.T4 + M6 | ✅（MVP 级，非百万级） |
| API Key 治理（网关层） | P1.4.T5 | ✅ |
| 成本熔断 | P1.7.T6 | ✅ |
| workspace 软隔离 | P1.2.T6（workspaces 表） | ✅ |
| 审计日志 | P1.4.T6 | ✅ |

### 2.2 spec 未显式覆盖但属 MVP 范围（需补任务）

| 原型功能 | 缺口 | 建议补法 |
|---|---|---|
| **Agents 列表/看板/详情页 + 过滤**（类型/状态/角色/区域） | spec 的 `chat-web`（P1.10）只做"对话+会话+agent 切换"，没覆盖 agents 管理页 | **P1.10 扩范围**：agents 管理页作为 `chat-web` 的一个路由（或独立 `apps/console`）。新增 P1.10.T6–T8 |
| **AgentFlows 列表 + DAG 详情页（只读浏览 + run 状态着色）** | spec 假设画布用 Flowise 原生 UI，但原型有自己的 flow 列表页和带状态着色的 DAG 浏览 | **两种走法**：① 流程编辑用 Flowise 画布，浏览/监控页自研（读 runs + flow JSON 渲染状态）；② 完全用 Flowise UI。建议①，新增 P1.9.T5（flow 监控页） |
| **Lab 多 agent 聊天室**（线程化、@提及、thinking 展示、tool 块） | spec 的 `chat-web` 是"轻量对话前端"，没设计多 agent 聊天室语义 | **需决策**：Lab 是 v0.2 没有的新概念。若做，P1.10 要加聊天室路由 + 线程数据模型；若不做，原型该页推迟 |
| **Workspace 项目对话页**（项目-成员-flow-产物-配额一站式） | spec 有 workspaces 表但无对应前端 | 同上，P1.10 扩 |
| **设置页 6 tab**（默认模型/通知/账户团队/危险区） | spec 只覆盖 API Key（P1.4.T5），其余 4 tab 未涉及 | 默认模型→Flowise 配置；通知/账户团队→**超出 MVP**；危险区→软删除。补 P1.4.T7+ |
| **节点级监控**（每节点 run 耗时/预算/token/成本/超时/日志） | spec 的 trace 是 run 级，节点级监控未显式 | 需 Flowise run 的节点级 span + 前端渲染。补 P1.11.T5（节点级 trace 落库 + 展示） |
| **new-api 令牌模型** | settings 数据文件用 new-api token 模型（`sk-newapi-*`、group、quota points），spec 的 `api_keys` 是自研表 | **需决策**：网关是接 new-api（外部）还是自研 key 管理？原型倾向 new-api。见 §3 决策点 |

### 2.3 超出 MVP 范围（明确推迟/降级）

| 原型功能 | 为何超出 | 处理 |
|---|---|---|
| **百万级 fleet 实时密度**（1.04M agents） | v0.2 §1.3 明确"不做百万 agent 分布式调度（留接口）" | 推迟阶段 3。MVP 资源面板只展示当前规模 |
| **多区域**（ap-northeast/us-east-1/eu-west-1...） | v0.2 无多区域设计；MVP 单机/单区域 | MVP 忽略 region 字段或填默认值；阶段 2+ |
| **318 daemons 跨机** | MVP 单 daemon 同机起步（v0.2 §3.3） | 架构支持多 daemon（P1.5.T7 路由），但 MVP 只 1 个 |
| **通知系统**（settings tab） | v0.2 无 | 推迟 |
| **账户与团队**（settings tab） | v0.2 用 workspace 软隔离，MVP 不做强多租户 | MVP 只做最小 RBAC（P1.2.T6） |
| **Webhook 入站令牌** | v0.2 有 webhook 概念但 MVP 未展开 | 可选，M4+ |
| **实验会话的"假设/产物"结构化产出** | Lab 的 H1/H3 假设、产物面板是科研场景深功能 | Lab 若做，MVP 只做对话线程，假设结构化推迟 |

---

## 3. 触发的决策点（需用户拍板）

原型暴露了 3 个 v0.2 spec 没定的事，影响 plan：

### 决策点 A：前端范围——`chat-web` 要不要扩成"控制台"？

原型实际是**控制台**（dashboard + agents + flows + lab + workspace + settings），不是 v0.2 说的"轻量 Chat 前端"。spec 的 P1.10 只做对话，远小于原型。

- **A1. 扩 `chat-web` 为完整控制台**：把 6 个页都纳入 `apps/chat-web`（或改名 `apps/console`）。工时 +5~8 天。MVP 周期拉长。
- **A2. 分阶段**：MVP 只做对话 + agents 管理 + flows 浏览（最小可用控制台），Lab/Workspace/settings 高级 tab 推迟。**推荐**。
- **A3. 严守 v0.2 边界**：只做轻量 Chat，原型其余页全部推迟到 MVP 之后。

**推荐 A2**。理由：原型是控制台不是 chat，但 Lab/Workspace 是重功能，全做拖长 MVP；最小控制台（对话+agents+flows）已能验证核心闭环。

### 决策点 B：API Key 管理——接 new-api 还是自研？

原型 settings 用 new-api（`sk-newapi-*`、group、quota points、渠道组），数据文件注释明写 "Fields aligned to new-api token model"。spec 的 P1.4.T5 是自研 `api_keys` 表。

- **B1. 接 new-api**：网关代理 new-api，令牌 CRUD 转发 new-api API。好处：现成的 key 池 + 渠道 + 配额；代价：多一个外部依赖。
- **B2. 自研 key 管理**：spec 原方案，`api_keys` 表 + 网关校验。好处：无外部依赖；代价：要自己实现配额/渠道/轮转。
- **B3. 混合**：MVP 自研最小 key 校验，预留 new-api 接入位。

**需要你定**。原型明显倾向 B1（new-api），但 v0.2 文档没提 new-api。

### 决策点 C：Lab 与 Workspace——是 MVP 还是后续？

这两个页是原型的重头，但 v0.2 没明确。

- **C1. 都做**：Lab（多 agent 聊天室）+ Workspace（项目对话）都进 MVP。工时 +6~10 天。
- **C2. 只做 Workspace**：Workspace 是对话+项目隔离，离 v0.2 近；Lab 的多 agent 协作聊天室语义重，推迟。**推荐**。
- **C3. 都推迟**：MVP 只对话 + 控制台，Lab/Workspace 后续。

**推荐 C2**。Workspace 几乎就是带项目上下文的对话，是 chat-web 自然延伸；Lab 的"多 agent 聊天室 + 假设结构化"是独立重功能。

---

## 4. 对 plan 的影响汇总

若采纳推荐（A2 + C2，B 待定）：

1. **P1.10 扩范围**：`apps/chat-web`（或 `apps/console`）增加 agents 管理页、flows 浏览页、workspace 项目对话页。新增 ~6 个任务，工时 +5~7 天。
2. **P1.9 加 flow 监控页**：新增 P1.9.T5（读 runs + flow JSON 渲染节点状态着色）。
3. **P1.11 加节点级 trace**：新增 P1.11.T5。
4. **P1.4 settings 扩**：补默认模型 tab + 危险区软删除；通知/账户团队推迟。
5. **M5 工时上调**：5/8 天 → 10/16 天。
6. **总工时**：41/77 天 → 约 47/88 天（乐观/悲观）。
7. **决策点 B（new-api）**：待你拍板后改 P1.4.T5。

**不改的部分**：两个 Gate、Part 1 的 contracts/dispatch/daemon/db/repro/scheduler 层、Part 2 的 M0–M4 主干。原型与这些后端层完全兼容（数据文件已对齐 v0.2 schema）。

---

## 5. 决策结果（用户拍板：三个都要）

- **A1**：`chat-web` 扩为完整控制台（6 个页都做）。
- **B1**：接 new-api（本地 `~/Projects/new-api`，Go 写的 LLM 网关，docker 自部署端口 3000）。令牌由 new-api 签发托管，平台本地不存 key 原文，只管 token CRUD（经 new-api API）+ 本地 remark/group 元数据。
- **C1**：Lab 与 Workspace 都进 MVP。

## 6. 对 plan 的完整影响（A1+B1+C1）

### 6.1 新增/修改的 Part 1 任务

**P1.4 网关层**（B1 影响）：
- P1.4.T5 改写：从"自研 `api_keys` 表 + 校验"改为"new-api 代理 + 本地 `token_meta` 表（remark/group/visibility）+ 健康探测"。网关持有 new-api 管理密钥，令牌 CRUD 转发 new-api API。
- 新增 P1.4.T8：new-api 健康探测（轮询 new-api 的 token 状态 → 标记限流/失效/过期）。
- 新增 P1.4.T9：令牌轮换（调用 new-api 标记待轮换 + 生成新 key + 吊销旧 key）。

**P1.10 前端**（A1+C1 影响，从 `chat-web` 改名 `console`）：
- P1.10.T1–T5（原对话+会话+agent 切换+触发 run）保留。
- 新增 P1.10.T6：Agents 管理页（列表/看板/详情 + 过滤 + 能力描述符 + 当前 run + 资源占用 + 日志流）。
- 新增 P1.10.T7：AgentFlows 浏览页（flow 列表 + DAG 只读渲染 + 节点状态着色 + 节点级 run 耗时/预算/token/成本/日志）。
- 新增 P1.10.T8：Workspace 项目对话页（项目列表 + 成员 + 关联 flow + 产物 + 配额 + 对话线程 + 附件）。
- 新增 P1.10.T9：Lab 多 agent 聊天室（实验会话列表 + 线程化消息 + @提及 + thinking 展示 + tool 调用块 + 人工介入）。
- 新增 P1.10.T10：设置页（6 tab：API Key/默认模型/预算配额/通知/账户团队/危险区）。
- 新增 P1.10.T11：资源看板页（fleet 密度 + 状态分布 + 24h 吞吐 + 区域 + 成本，MVP 级数据，非百万级）。

**P1.9 vendor/flowise**：
- 新增 P1.9.T5：flow 监控页后端（读 runs + flow JSON → 渲染节点状态着色所需的数据接口）。

**P1.11 可观测性**：
- 新增 P1.11.T5：节点级 trace（Flowise run 的节点 span 落库 + 前端展示）。
- 新增 P1.11.T6：资源看板数据聚合 API（fleet 状态分布/吞吐/区域/成本，读 runs + Langfuse + new-api）。

### 6.2 新增数据模型

- `token_meta` 表（本地）：`id, newapi_token_id, name, group, remark, visibility, workspace_id, created_at`。key 原文不存。
- `lab_sessions` 表：`id, name, desc, status, workspace_id, created_at`。
- `lab_messages` 表：`id, session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call, created_at`（线程化）。
- `workspace_members` 表：`workspace_id, user_id, role`。
- `workspace_flows` 表：`workspace_id, pipeline_id`（项目关联 flow）。
- `notifications` 表（若做通知 tab）：`id, user_id, type, payload, read, created_at`。

### 6.3 新增外部依赖

- **new-api**：加入 `infra/docker-compose.yml`，端口 3000。Flowise 的 LLM 调用、daemon 的 CLI 调用（经网关）都指向 new-api 作为统一上游。

### 6.4 工时重算

| 里程碑 | 原工时（乐观/悲观） | 新工时 | 增量 |
|---|---|---|---|
| M5（前端） | 5 / 8 | **16 / 26** | +11/+18（6 个页 + 聊天室 + 设置） |
| M6（监控+面板） | 4 / 7 | **6 / 10** | +2/+3（节点级 trace + 资源看板 API） |
| M2（含 new-api 接入） | 11 / 21 | **12 / 23** | +1/+2（new-api 代理 + 探测） |
| M0（含 new-api compose） | 8 / 16 | **8.5 / 17** | +0.5/+1 |
| 其余 M1/M3/M4 | 不变 | 不变 | 0 |
| **总计** | 41 / 77 | **~50 / 97** | +9/+20 |

### 6.5 新增风险

| 风险 | 缓解 |
|---|---|
| new-api 与 Flowise 凭证系统冲突（Flowise 有自己的 credentials） | Flowise credentials 指向 new-api 的 base_url + token，统一上游 |
| Lab 多 agent 聊天室语义复杂（@提及、线程、thinking） | Lab 数据模型先于前端落地；MVP 聊天室先做线程 + @提及，thinking/tool 块复用 daemon 事件流 |
| 前端 6 页工作量压垮 M5 | M5 拆成 M5a（对话+agents+flows+settings 核心）+ M5b（workspace+lab+dashboard），M5a 先交付 |
| 控制台与 Flowise 画布的 UI 割裂 | flows 浏览页自研只读渲染，编辑仍跳 Flowise 画布；两套 UI 但职责清晰 |

### 6.6 不变的部分

- 两个 Gate（Gate-1 dispatch↔daemon、Gate-2 fork 构建+Flow State 定位）不变。
- Part 1 的 contracts / agent-adapters / daemon / dispatch / scheduler / db / repro / shared 后端层不变（contracts 可能加 Lab/Workspace 的 DTO，但核心不变）。
- Part 2 的 M0–M4 主干时序不变，只是 M5/M6 膨胀。

## 7. 下一步

按本节影响更新主 spec（`2026-07-08-mvp-execution-plan-design.md`）：扩 P1.4/P1.10、加 P1.9.T5/P1.11.T5/T6、加新数据模型、调工时、加 new-api 依赖。然后进入 writing-plans。
