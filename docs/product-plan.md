# 产品方案（2026-08-22 起）

> 从 [product-review.md](product-review.md) 的推敲结论落下来的可执行方案。每个方案含：**现状锚点（代码事实）→ 设计 → 验收标准**。本文是产品层输入；工程落地仍走仓库的 brainstorm → spec → plan 流水线（见 `docs/README.md`），本文档随方案推进更新状态。架构层分析与决策（AD-1~AD-6）见 [product-architecture.md](product-architecture.md)。

**状态标记**：`待启动` / `进行中` / `已交付`。

---

## 0. 目标与度量

**北极星**：每周「`@workflow` 生成 → 用户真实运行成功」的完成数。它同时约束生成质量（前半段）与引擎可靠性（后半段），且只能靠魔法时刻成立来增长。

**护拦指标**（对应各方案验收）：

| 指标 | 现状 | 目标 |
|---|---|---|
| 生成静默降级率（兜底模板冒充成功） | 存在此路径，无埋点 | **0**（降级必须显式） |
| 生成结构校验通过率（一次通过 / 修复后通过） | 无校验，未知 | 一次 ≥ 70%，修复一轮后 ≥ 95% |
| 生成后 24h 内被用户运行的比例 | 未知（无埋点） | ≥ 40% |
| LLM 请求 P95 无限等待 | 可能无限 | 必超时（默认 120s，可配） |
| 点「停止」后后端进程退出时延 | 永不退出（纯前端截断） | ≤ 5s |
| 成本数据落库覆盖 | 仅 dispatch 路径落 runs.cost | chat + workflow run 全覆盖 |

埋点是一切度量的前提，见方案 A5（先行项）。

### M1 埋点基线（2026-08-22 首次复盘）

管线落地当日基线：`generator_attempts` 仅 1 条真实记录（端到端冒烟：canvas / cli / success / 修复 0 轮 / 15.1s），**统计基线待真实使用积累后建立**——建议首次真实使用满一周后用下述常备 SQL 复盘并回填本表：

```sql
-- 生成漏斗与修复轮触发率（护栏指标 2/3）
SELECT outcome, COUNT(*) AS n, ROUND(AVG(repair_rounds)::numeric, 2) AS avg_repair,
       ROUND(AVG(duration_ms)/1000.0, 1) AS avg_sec
FROM generator_attempts GROUP BY outcome;
-- 生成后 24h 内被运行的比例（北极星前半段）
SELECT COUNT(DISTINCT a.id) FILTER (WHERE r.id IS NOT NULL) AS ran,
       COUNT(*) AS generated FROM generator_attempts a
LEFT JOIN runs r ON r.id::text = a.flow_id::text AND r.created_at > a.created_at
WHERE a.outcome = 'success';
```

---

## 方案 A（P0）：@workflow 生成质量闭环 —— `已交付（2026-08-22）`

### 现状锚点

- chat 路径：`apps/gateway/src/routes/chat-execute.ts` `routeWorkflowCommand` —— CLI 生成（`workflow-clients.ts` `createCliLlmClient`，180s 硬超时）失败后 fallback HTTP 一次；**解析/校验失败静默降级三节点兜底模板（Start → LLM → DirectReply），仍回复「✅ 工作流已创建」**。
- 画布路径：`apps/console/src/app/api/flowise/api/v1/agentflowv2-generator/generate/route.ts`（console BFF）+ `apps/console/src/lib/flow-generator.ts`（`extractJson` / `normalizeGeneratedFlow`，有 `CANVAS_NODE_TYPES` 白名单、120s/200s 超时、错误文案明确）。**两套链路 prompt / 引擎选择 / 校验 / 超时全不一致。**
- 画布保存无校验：`flowise-canvas.tsx` `handleSave` 直接 PUT；gateway `workflows.ts` 的 zod 只验 `flowData` 是 record。合法性要到执行时才暴露。

### 设计

**A1 统一生成管线（服务端单源）**

把生成收敛为 gateway 内单一服务（暂名 `flow-generator-service`），chat `@workflow` 与画布 GenerateFlowDialog 共用：

- prompt 构造：沿用 `buildWorkflowGeneratorPrompt`（agent 清单 80 上限 + 技能 40 上限注入）；
- 引擎选择：CLI 优先 / HTTP 兜底，策略单点维护；
- 校验与清洗：把 console 端 `normalizeGeneratedFlow` 的白名单规范化**下沉到 gateway**（两端共享同一实现，console 不再各管一段）；
- 画布 BFF 改为透传该服务（保留超时参数差异即可）。

**A2 三道防线（取代静默兜底）**

1. **Schema 校验**（zod）：nodes 为非空数组、节点类型 ∈ 白名单、恰好一个 startAgentflow、edges 的 source/target 必须引用存在节点、platformAgent 的 agentId 引用真实启用 Agent（引用不到 → 自动降级为 personaName 语义并在结果里告知）。
2. **修复循环**：校验失败 → 把结构化错误清单 + 原始输出喂回同一 LLM 一轮（「你生成的 JSON 有以下问题，修复后仅输出 JSON」）→ 复检。最多 1 轮，控制时延与成本。
3. **显式失败**：复检仍不过 → 聊天里渲染**失败卡片**（不是成功文案），附两个 CTA：「重试」（原 prompt 重跑）与「打开空白画布」。**删除静默三节点兜底**——兜底模板可以保留为失败卡片里的第三选项「先用单 Agent 兜底流」，但必须由用户显式选择。

**A3 生成结果卡片升级**

成功后聊天里的产出从纯文本 markdown 链接升级为 flow 预览卡：缩略 DAG 图（复用 flows 页只读 `FlowDag` 组件）+ 节点数 + 「打开画布」「直接运行」两个按钮。ack 消息（「⚡ 正在生成」）补进度感（生成中 → 校验中 → 完成）。

**A4 画布保存拓扑干跑（顺手补齐）**

保存 / 生成 / 模板实例化三个入口统一跑轻量拓扑检查：孤立节点、无终点、环（Loop 节点除外）、startAgentflow 缺失。**不阻断保存**（尊重草稿自由），但画布顶部显示黄色警告条列出问题——把「执行时才爆炸」提前到「编辑时就看见」。

**A5 生成埋点（先行项，其他指标的地基）**

生成事件落库（新表或复用 audit），记录：路径（chat/canvas）、引擎（cli/http/fallback）、是否触发修复循环、校验错误清单、最终结果（成功/显式失败/用户放弃）、flowId、后续是否被运行。这是后续调 prompt 与度量北极星的唯一数据来源，**排在本方案第一位交付**。

### 验收标准

- [ ] 静默兜底路径从代码中删除；任何「✅ 已创建」必须对应通过校验的流。
- [ ] 构造 10 类坏输出（非 JSON / 缺 start / 边悬空 / 未知节点类型 / agentId 不存在…）的集成测试：全部走修复循环或显式失败卡片，零静默。
- [ ] chat 与画布两入口的生成结果在相同输入下结构一致（同一校验器跑通）。
- [ ] 埋点数据可查询：能回答「本周生成多少次、修复轮触发率、运行率」。
- [ ] e2e：mock LLM 返回坏 JSON → 聊天出现失败卡片 + 重试按钮可点。

---

## 方案 B（P0）：执行可中断（超时 + 真停止）—— `已交付（2026-08-22：B1 超时 + B2 取消链阶段 1–3；dispatch 远程取消 Deferred）`

### 现状锚点

- 无 AbortSignal 的 fetch：`workflow-clients.ts` HTTP chat / chatStream；`llm.ts` LLM 代理转发（SSE 同样裸奔）；`llm-providers.ts` 连通性测试。对照已有模式：CLI 路径 180s 硬超时、`http.node.ts` `AbortSignal.timeout(15_000)`、console BFF 120s/200s——**模式已存在，只差铺全**。
- 停止按钮纯前端：`chat-detail.tsx` `handleStop` 置 ref 忽略后续 WS 帧，后端继续执行（源码注释自认）。agent-adapters 无取消路径（诚实清单在册）。

### 设计（架构决策 AD-1 / AD-6，B2 完整设计见 [取消链 spec](superpowers/specs/2026-08-22-execution-cancellation-design.md)）

**B1 超时（低风险，独立先行）**：

1. 三处 fetch 加 `AbortSignal.timeout(默认 120s，环境变量可配)`；流式请求用「首字节超时 + 空闲超时」而非总时长截断，避免长正常生成被误杀。
2. 便宜的一枪：adapters 早已支持 `timeoutMs` / `inactivityTimeoutMs`，`executeInline` 只是没传——补上即消灭「CLI 挂死」。

**B2 取消链（走 spec 评审）**：

1. **停止 API**：`POST /api/v1/chats/:id/cancel` → gateway 内存执行注册表（AD-1，单进程红线内）→ AbortController / CLI 进程 kill（复用 adapters 既有 `killWithEscalation`，signal 接线覆盖三套 spawn 栈）。
2. **cancelled 成为一等状态**：`AgentResult` / `ExecutionStatus` 的死枚举变为真实产出；引擎 4 个调用点传入 signal；WS 新增 `chat:cancelled` 帧。
3. **前端接线**：停止按钮从「UI 截断」升级为「调 cancel API + 等待 cancelled 帧」，按钮态与后端实际取消状态对齐（取消成功前保持「停止中…」）。
4. **重启清扫（AD-6）**：gateway boot 时把悬空 `chats.status='running'` 收敛为 failed（「被 gateway 重启中断」）。
5. **明确延后**：daemon/dispatch 远程任务取消（协议扩展 + migration，见 spec §7 Deferred）；SSE 断开 ≠ 取消（显式取消才停）。
6. **诚实清单更新**：`workflow-engine.md` § 现状与限制对应条目（LLM 无超时随 B1、adapter 无取消随 B2）摘除。

### 验收标准

- [ ] mock 一个挂死上游（不响应），全部三处 fetch 在超时后返回明确错误，gateway 不积压。
- [ ] 聊天生成中点停止：CLI 进程 5s 内退出（`ps` 验证），WS 收到 `chat:cancelled`，消息标注「已取消」。
- [ ] 正常长生成（>30s 流式）不被空闲超时误杀。
- [ ] gateway 重启后无悬空 running 状态（boot 清扫生效）。

---

## 方案 C（P0）：codex 适配器真机回归 —— `未启动（开发机无 codex CLI，需真机环境）`

### 现状锚点

`packages/agent-adapters/src/codex.ts` 重写为 `codex exec --json` 事件流（2026-08-16 审计），**基于官方文档格式，未在真实 CLI 回归**。codex 是 README 副标题点名的两大 CLI 之一。

### 设计

1. 固定任务集真机回归：安装 codex CLI，跑「单轮问答 / 长输出 / 工具调用 / 报错退出 / usage 解析」五类任务，逐类断言事件流解析、usage 采集、退出码语义。
2. 差异即修：事件格式与文档不符处修 adapter，并把真实事件样本固化为测试夹具（后续无真机也能回归）。
3. qwen / copilot / codebuddy 三个同样未实测的适配器按同一方法跟进，优先级排在 codex 之后（方案 E 的分级里标 community 可后置）。

### 验收标准

- [ ] 五类任务全部通过，夹具入仓，CI 覆盖解析逻辑。
- [ ] README / adapters 表中 codex 的「未实测」标注摘除。

---

## 方案 D（P1）：成本从估算到实测 + 账单页 —— `已交付（2026-08-22：usage_events 三路写入 / runs.cost 补 writer / 多厂商价格表 + DAGENTS_PRICE_OVERRIDES 覆写 / Settings「用量与成本」tab / flat 假估算已删）`

### 现状锚点

- 已通：claude 适配器解析 per-model usage（`modelUsage`）；inline-executor `aggregateUsage` + `computeCost`（仅 `ANTHROPIC_MODEL_PRICES`，未知模型诚实返回 undefined 不造假）；usage/cost 写入 `chat_messages.metadata` 并随 `chat:done` 下发。
- 未通：chat 路径不写 runs 表；workflow run 级 INSERT 不含 token/cost（`workflows.ts` `POST /:id/run`，节点级 `run_node_spans` 已有 tokens/cost 但没聚合计入 run）；console 端 `agents-catalog.ts` 另有一层 flat $0.01/1k 假估算（注释自认 "runs.cost is empty today"）。

### 设计（架构决策 AD-3：追加式 usage_events 为账单真相源，不强行统一 runs——chat 消息量远大于 run，塞进 runs 是语义过载）

1. **新表 `usage_events`**：`source(chat|workflow_run|dispatch_task) + chat_id/run_id/task_id/agent_id/model + usage jsonb + cost + priced bool`；chat / workflow run / dispatch 终态各写一条，账单页只读此表。`priced=false`（单价未知）的行在价格表更新后**可回算重定价**——「不造假」原则的数据模型表达。旧 4 处 usage 数据不回填，账单页标注起点。
2. **runs 补 writer**：workflow run 完成时聚合 node spans 写 `runs.cost`（消灭死列）；`@flow` 聊天路径写 usage_event 即可，不补 runs。
3. **价格表扩展**：`ANTHROPIC_MODEL_PRICES` 代码常量 → 多厂商基线（openai / deepseek / moonshot / qwen 至少覆盖主流模型）+ `llm_providers` 加 JSONB per-model 单价覆写；无价格模型显式显示「单价未知」。
4. **账单页**：`/settings` 下新增「用量与成本」：按时间（日/周/月）、按 Agent、按 Flow 三个维度，含「单价未知」的 token 单列。CLI Agent 的成本来自 usage×价格表，HTTP Provider 成本来自响应 usage。
5. **删假估算**：`agents-catalog.ts` 的 flat 折算层删除，Agent 列表 cost 统一走 gateway 真值；「估」标记只在数据真缺失时出现。

### 验收标准

- [ ] 任意一次 chat 与 workflow run 之后，usage_events 能查到 token + cost（或 `priced=false` 显式标记）。
- [ ] 账单页三维度数字与手工对账一致（对照 provider 控制台抽 3 单）。
- [ ] 全仓搜索不到 flat $0.01/1k 估算逻辑。

---

## 方案 E（P1）：适配器诚实分级 —— `已交付（2026-08-22：tiers.ts 单源 + /cli-runtimes 透出 + daemons「核心」徽标 + README 双语分级）`

### 设计

1. 两级制：**core**（claude / codex / qwen —— 保真维护 + 真机回归 + cancel 路径优先支持）/ **community**（其余 14 个，正常接受 PR，但界面与 README 明示维护等级与实测状态：`真机回归过` / `按官方文档实现` / `社区报告可用`）。
2. 状态写入代码常量（adapter 元数据），console `/daemons` 的 CLI 探测区与 README 适配器表同源渲染，避免两处手抄。
3. README「17 adapters」话术改为「3 core + 14 community」，把广度数字换成可信度。

### 验收标准

- [ ] README / console / adapter 元数据三处状态一致且同源。
- [ ] codex 完成方案 C 后升 core 的实测标注。

---

## 方案 F（P1）：叙事与死路修正 —— `已交付（2026-08-22：虚拟团队改名 / onboarding CLI-或-Provider / Settings 占位 tab 收拢为「规划中」/ README Why-not-X）`

纯文案与信息架构，不改执行层，性价比最高的一批。

1. **「团队场景模板」→「虚拟团队」**：叙事改为「一个人指挥一个虚拟团队」（solo orchestration），消除多人协作预期。改名范围：/flows 模板画廊 tab、agent-library 文档、README Scenario 措辞。底层 API 路径不动。
2. **Settings 砍占位 tab**：未接线的「账户与团队 / 预算与配额 / 通知 / 审计」移除或折叠为一行「规划中 → roadmap 链接」。开源产品里占位 tab 是负资产。
3. **无 CLI 用户出口**：onboarding 第二步（CLI 探测为 0）给两条路：「装 CLI（推荐，附最小指引）」与「先配 HTTP Provider 继续 →」直达 Settings LLM Provider 表单；配好 provider 后 onboarding 判定通过（探针逻辑同步放宽）。
4. **README 增「Why not X」**：按 product-review §5 竞品坐标写三行直接对比（vs 云端编排 / vs CLI 原生 / vs 单 CLI GUI 壳），主张落在「异构 + 资产化」。
5. **建议卡接真实任务**：检测到所选目录是 git 仓库时，建议卡直接出「帮我理解这个项目架构」等一键发送项（现文案已有雏形，补目录上下文感知）。

### 验收标准

- [ ] 全产品文案搜索不到会引发多人协作预期的措辞（「团队」仅存于「虚拟团队」语境）。
- [ ] 无 CLI + 已配 provider 的新用户可走通 onboarding 并完成一次对话（e2e 覆盖）。

---

## 方案 G（P2）：模板参数化 + 冷启动内容 —— `已交付（2026-08-22：{{var}} 扫描/params 列/实例化表单；内置模板 3→10，新增 7 个零依赖模板全部通过拓扑校验守门测试）`

### 现状锚点

`docs/flow-templates.md` v1 明确 Non-Goals：模板变量 / 表单参数化、版本管理、导入导出。抽取校验仅「nodes 非空 + startAgentflow 存在」（`apps/gateway/src/flow-template-pipeline.ts` `extractTemplateFromFlow`）。内置模板 3 个。

### 设计

1. **参数化**：画布编辑时允许在 LLM / PlatformAgent 节点的 prompt 里写 `{{变量名}}`；「另存为模板」时自动扫描占位符生成参数清单；instantiate 时弹表单填写，缺省值存模板。范围刻意收窄（只做 prompt 文本占位，不做节点结构参数化）。
2. **冷启动内容**：内置模板 3 → 10–15 个，覆盖 code review、批量重构、技术调研、文档生成、发布检查等高频场景；每个模板必须在「零人格库 + 零 provider」环境实测可跑（降级路径真实走通）。社区 PR 规范（`builtin/README.md`）已就绪，缺的是种子内容。
3. 版本管理 / 导入导出继续留在 Non-Goals。

### 验收标准

- [ ] 带参数模板从「另存」到「实例化表单填写」全流程可用，未填参数有缺省值兜底。
- [ ] 10+ 内置模板在干净环境（无 provider、无人格库）全部可跑通。

---

## Non-Goals（本期明确不做）

- **多人协作 / 团队共享**：v1 叙事明确「单机单人、虚拟团队」（张力 3 的结论），共享 flows、共享 provider、权限体系全部不做。
- **向量 RAG、JS 沙箱（isolated-vm）**：诚实清单既有取舍，维持；升级路径文档已在册。
- **移动端、云端托管**：与 local-first 定位冲突。

---

## 里程碑

| 里程碑 | 周期 | 内容 | 出口判据 |
|---|---|---|---|
| M1 | ~2 周 | A5 埋点 → A1/A2/A3 生成闭环；B1 超时先行；B2 取消链走 [spec](superpowers/specs/2026-08-22-execution-cancellation-design.md) 评审后实施 | 静默降级率 0；挂死上游必超时；停止 5s 内杀进程 |
| M2 | ~2–3 周 | 方案 C codex 回归 + D 成本实测/账单（usage_events 真相源，AD-3）+ E 分级 + F 叙事 | 账单页对账一致；README 无「未实测」的 core 承诺 |
| M3 | ~3–4 周 | 方案 G 参数化 + 模板冷启动；基于 A5 数据迭代生成 prompt | 一次通过率 ≥ 70%；内置模板 ≥ 10 全可跑 |

M1 完成后用埋点数据复盘一次北极星基线，再决定 M3 的 prompt 迭代方向优先级。
