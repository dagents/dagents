# 产品推敲（2026-08-22）

> 一次性产品评审快照：定位、核心张力、用户旅程、竞品坐标与优先级总览。本文是当时判断的记录，不随代码演进更新；**可执行的方案拆解在 [product-plan.md](product-plan.md)**（活文档）。

## 0. 一句话判断

工程决策质量（registry-not-database、模板降级、fork-on-instantiate、诚实清单）已经跑在产品决策前面。下一个阶段不是加能力，而是钉死三件事：**谁、为什么是它、第一次就成功**——收缩承诺面（适配器、团队叙事），把所有赌注集中到 `@workflow` 这一个魔法时刻的成功率上。

## 1. 产品是什么（事实锚定）

- 官方定位（README）：*chat-first platform for orchestrating heterogeneous coding agents — on your own machine, against your own LLM providers.*
- 形态：聊天主页 `/` + 聊天详情 `/chats/{id}` 为门面；`@agent` / `@flow` / `@workflow` / `@daemon` 四个聊天命令把聊天升级为编排入口；Flowise 风格画布 `/workflows/[id]/canvas` 承载 14 节点 DAG。
- 资产层：技能库（`~/.agents/skills`，registry-not-database）、人格库（316 人格文件系统挂载、按需启用）、三层模板中心（内置 / 团队场景 / 我的模板）。
- 执行层：inline-executor 默认 spawn 本地 CLI（17 适配器），HTTP LLM Provider 可选加速；daemon 为远程执行的可选件。

## 2. 站得住的差异点（资产，别动）

1. **CLI-first 零配置基线**。PATH 上有 `claude` 就能聊，onboarding 探针（目录 → CLI → Agent）真实校验且明确不要求 LLM Provider。所有云端编排竞品（Dify / LangFlow / Flowise / n8n）的第一步都是「去申请 API key」，Dagents 的第一步是「你已经装好了」。
2. **本地优先 + 文件系统为真相源**。`~/.agents/skills` 对齐 Cursor / Gemini CLI / Copilot CLI 的扫描约定，人格库软链即挂载——寄生在正在形成的事实标准上，聪明的赌注。
3. **模板零依赖可跑**。personaName 重绑 + 缺失人格降级 LLM 节点 + 降级数量显式 toast：新用户 clone 即跑，装了人格库自动升级。这是开源传播的正确设计。
4. **文档文化**。「诚实清单 / Non-Goals + 升级路径」的写法本身是差异化资产，继续。

## 3. 四个核心张力

### 张力 1：魔法时刻押在质量最不可控的环节，且当前有「静默失败」实锤

产品旅程的设计是：聊天门槛极低 → `@workflow` 一句话升级为多 Agent 编排 → 留存在画布与模板。`@workflow` 是全产品唯一的「魔法时刻」，但代码事实比推敲时的预期更糟：

- **生成失败被静默吞掉**。`apps/gateway/src/routes/chat-execute.ts` 的 `routeWorkflowCommand`：CLI 失败 fallback HTTP 一次（无重试循环）；JSON 解析 / 基本校验失败后，**静默降级为固定三节点兜底模板（Start → LLM → DirectReply），照样落库、照样回复「✅ 工作流已创建」**。用户拿到一个不符合需求的流，且以为成功了。
- **校验强度几乎为零**。chat 路径只做「剥围栏 → JSON.parse → 数组非空」；没有节点类型白名单、没有边引用校验、没有 startAgentflow 存在性检查、没有拓扑干跑。
- **两条生成链路互不知晓**。chat `@workflow` 与画布 GenerateFlowDialog（`apps/console/src/lib/flow-generator.ts`，含 `normalizeGeneratedFlow` 白名单规范化、120s/200s 超时）是两套独立实现：prompt、引擎选择、校验强度、超时防护全不一致。画布路径反而更强，但用户主路径（聊天）用的是弱的那套。

**推论**：如果用户第一次 `@workflow` 拿到的是静默兜底流，产品叙事当场断裂——退回「这不就是个聊天壳」。这是 P0 中的 P0，方案见 product-plan.md 方案 A。

### 张力 2：与 CLI 原生能力的竞争关系没有被叙事化

愿意装 17 种 CLI 的人就是 claude code / codex 重度用户，而 claude code 正在原生长出 subagents、skills、hooks。Dagents 对这群人的不可替代价值是三件事：**跨厂商统一**（17 适配器）、**GUI 资产化**（flows / 模板 / 人格库可积累、可视化、可分享）、**编排原语**（并行波、条件路由、人机协同——CLI 原生多 agent 给不了的 DAG 语义）。

目前 README 和界面都在平铺能力，没有回答用户内心的 OS：「claude code 原生就够了，为什么还要你」。建议 Why Dagents 增加「为什么不是 X」直接对比（方案 F）。

### 张力 3：单机现实 vs 团队话术

HumanInput 挂起态在内存、无多用户、无共享资产语义、默认无鉴权——彻底的单人产品。但产品语言里有「团队场景模板」「账户与团队」（Settings 未接线 tab）。6 个团队模板的真实用法是「**一个人指挥一个虚拟团队**」（solo orchestration）——这本身是性感叙事，但叫「团队」会让用户预期协作功能随后就来，形成预期错配。

同时，Settings 里五个未接线 tab（预算与配额 / 通知 / 审计 / 账户与团队 / 危险区中的占位部分）在开源产品里是负资产：用户会把它们当成 roadmap 承诺。

### 张力 4：广度是营销数字，深度才是留存

17 适配器中 4 个（codex / codebuddy / copilot / qwen）从未真机回归——而 **codex 是 README 副标题点名的两大 CLI 之一**，这是首屏承诺与交付验证的直接缺口。CLI 协议变动频繁（codex 已改过一次事件流格式），长尾适配器会持续腐烂。应收缩为「claude / codex / qwen 保真维护 + 其余诚实标注社区等级」（方案 E）。

## 4. 用户旅程漏洞（按 onboarding 三步推演）

**有 CLI 的用户**：旅程通顺（目录 → CLI → Agent → 开聊）。缺第二个钩子：检测到 git 仓库后建议卡直接给可一键跑的首个真实任务，而不是等用户想 prompt。

**没 CLI 的用户**：当前是死路。onboarding 卡在第二步「去装 CLI」，但 Settings 明明有完整的 LLM Provider CRUD 可以让产品跑起来。要么明确放弃（文案直说「本产品面向 CLI 用户」），要么接住（第二步给「或配置 HTTP Provider 继续」出口）。现在是最差的中间态：不引导也不拒绝。

**信任崩塌点（从诚实清单升格为体验级问题）**：

- **LLM fetch 无超时**：`workflow-clients.ts` 的 HTTP chat / chatStream、`llm.ts` 代理转发、`llm-providers.ts` 连通性测试均未传 AbortSignal（对照：CLI 路径有 180s 硬超时、HTTP 节点有 15s 超时——模式已存在，没铺全）。一次上游挂起 = 用户永远不再信任这个界面。
- **停止按钮是假的**：`chat-detail.tsx` 的 `handleStop` 是纯前端截断（源码注释原话："The backend agent may keep running, but the UI is released."），CLI 进程与 LLM fetch 继续跑到自然结束。用户点了停止但账单还在走。
- **成本全是估算**：CLI usage 其实已被解析（claude 适配器的 modelUsage、inline-executor 的 computeCost——未知价格诚实返回 undefined），但 chat 路径只写 `chat_messages.metadata` 不落 runs 表、workflow run 级 INSERT 不含 token/cost（节点级 spans 有）；console 端还有一层 flat $0.01/1k 的假估算。数据管道通了 80%，最后一公里没铺完。对编排平台，成本归因是用户选平台而非裸用 CLI 的核心理性理由之一。

## 5. 竞品坐标（建议写进 README）

| 竞品象限 | 代表 | Dagents 的差异 |
|---|---|---|
| 云端 LLM 编排 | Dify / n8n / LangFlow / Flowise | 不需要 API key 起步、本地资产、CLI 执行 |
| CLI 原生多 agent | claude code subagents / codex | 跨 17 厂商 + DAG 编排原语 + GUI |
| CLI 之上 GUI 编排 | Vibe Kanban / Conductor 类 | 不锁单一 CLI、工作流是持久可分享资产而非会话 |

第三列是 2026 年最拥挤的真实竞区，差异主张应落在「**异构**（heterogeneous）+ **资产化**（flows / 模板可版本、可分享）」。README 副标题已有 heterogeneous，缺资产化半句。

## 6. 优先级总览

详细设计、验收标准与里程碑见 [product-plan.md](product-plan.md)。

| 级别 | 事项 | 一句话 |
|---|---|---|
| P0 | @workflow 生成质量闭环 | 统一两套生成链路；校验 + 修复循环 + 显式失败；消灭静默兜底 |
| P0 | 执行可中断 | 超时铺全 + 真停止（杀进程 / 取消 fetch） |
| P0 | codex 真机回归 | 首屏承诺的一半不能停留在「按官方文档实现」 |
| P1 | 成本从估算到实测 + 账单页 | usage 管道铺完最后一公里，删假估算层 |
| P1 | 适配器诚实分级 | core / community 两级，README 与界面一致 |
| P1 | 叙事与死路修正 | 团队→虚拟团队、砍 Settings 假 tab、无 CLI 出口、Why not X |
| P2 | 模板参数化 + 冷启动内容 | 从 non-goal 提上日程；内置模板 3 → 10–15 |
| 不做 | 多人协作、向量 RAG、JS 沙箱、移动端 | 写进 Non-Goals 是加分项 |
