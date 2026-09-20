# 设计：终端双锚点 —— 项目目录 / 运行，从一切工作现场可达

> 状态：2026-09-19 设计定稿；**P0/P1/P2/P3/P4 已于当日全部实施落地**（P3 见 §6，其余见各节「已实施」标注），浏览器矩阵 12/12 + 入口实弹验证通过。前置阅读 [`terminal-architecture.md`](terminal-architecture.md)（组件分层 / ADR / 安全模型）。
> 关联 backlog：多标签终端、运行实时终端（本文 P2/P3 收编）。

## 0. 定位宣言

**终端不属于 tab，也不属于 agent —— 它是平台级资源，锚定在两个锚点上：**

1. **项目目录**（第一锚）：工作发生的地方。已有完整实现（目录选择器 / `?dir=` 深链 / `openIn` 切换）。
2. **运行**（第二锚）：执行现场。运行不是终端的宿主，而是**目录锚的解析来源**——失败运行 → 该运行的目录 → 目录锚。运行中的实时 attach 是另一条演进线（P3），不在本设计主路径。

**一扇门原则**：所有现场共用同一扇门——同一个 href 构造器、同一图标、同一语义（switch/create）。门是一个 Link，永远不是一套新的终端实现。

**为什么不锚 agent**（产品论断，2026-09-19 PM 评审）：CLI agent 是人格配置不是常驻机器，生命周期与终端对不上；「看 agent 干活」的锚点是运行（run-terminal.tsx 运行终端视图 + 插话已存在）；按 agent 常驻终端在 8 会话上限经济学下不成立。agent 与终端的正确关系是「终端承载 agent」（P4 交互式 agent 会话），不是「agent 拥有终端」。

## 1. 现状盘点（2026-09-19 实测，行号已核）

**消费端就绪，生产方为零：**

- `/terminal?dir=` 一次性消费 + `history.replaceState` 剥除：`use-shell-session.ts:149-173`；`openIn(target)` 杀旧建新：`use-shell-session.ts:374-399`。
- 全仓 grep 无任何构造 `/terminal?dir=` 的代码——深链只有消费端，零生产方。

**运行 → 目录的数据链是断的（P0 修复对象）：**

- `directoryId` 只在发起时解析 cwd（`workflows.ts` runBodySchema），**不落 runs 行**：`workflows.ts:494` `inputJson: JSON.stringify(data.input ?? null)` 只存输入本体。
- `GET /api/v1/runs` 响应无任何目录字段（`runs.ts:62-77`）；`node-spans` 响应同样没有。
- **读取方已存在假设**：断点续跑 `execution-resume.ts:201-208` `originalDirectoryId()` 读 `runs.input.directoryId`——但上述写入方从不写它，说明该函数今天实际依赖 chat 回退（`chats.directory_id`）。P0 顺手收口。

**唯一可靠的目录锚**：`chats.directory_id`（`runs.chat_id` 关联）——chat 起源的运行**今天就能**锚定，无需等 P0。

**现场清单（入口候选）：**

| 现场 | 组件 | 失败态现状 | 目录数据 |
|---|---|---|---|
| Flow 卡片运行历史 | `flow-runs-panel.tsx`（行内操作区 L138-153 已有「重跑」「画布旁观」） | `failed` 行 + 错误摘要 L156-160 | ❌ 无（GET /runs 不返回） |
| 画布失败摘要 | `canvas-kit-page.tsx` runSummary L860-867 + 失败节点展开 | 「重跑」「从此处继续」已有 | 本会话发起有 `runDirectoryId`；旁观/刷新恢复 ❌ |
| Chat 错误卡 | `chat-detail.tsx` chat-error-card L941-980（重试/检查配置/复制） | 结构化错误卡 | ✅ `chat.directory_id` |
| Agent 详情 | `agent-detail-view.tsx` ins-actions L475-498 | — | ❌ agent 无目录概念（按定位不该有） |
| Daemons | `daemons-view.tsx` | — | ❌ dispatch_tasks 无目录字段 |

## 2. 锚点语义

- **目录锚**：`/terminal?dir=<directoryId>` → `planSession` 的 `intentDirId` 路径——显式意图**覆盖**恢复偏好；异目录走 switch（杀旧建新）；同目录 no-op。全部已实现，本设计零改动。
- **运行锚（post-mortem 形态）**：`run.directoryId → 目录锚`。入口在渲染时解析运行→目录，产出与目录锚完全相同的 href。
- **诚实原则**：解析不到目录就**不渲染入口**。不回落主目录——「为什么开在 ~」比「没有按钮」更伤信任。

## 3. P0：数据链修复（前置，独立可交付）—— 已实施（2026-09-19）

runs 表加 `directory_id uuid null` 列（migration `1720000097000`），读写全线打通：

- **写入四点**：`persistWorkflowRunRow`（画布直跑，COALESCE 保旧值）/ `initAsyncWorkflowRunRow`（异步先行行即带锚）/ `upsertChatWorkflowRunRow`（chat 起源继承 `chats.directory_id`）/ resume 的 `persistRunRow`（续跑/应答回流，`execution-resume` 解析 `directoryId ?? originalDirectoryId` 后传入）。
- **读取两点**：`GET /api/v1/runs` 行响应 `directoryId` + node-spans 响应 `runDirectoryId`（旁观画布的目录锚来源）。
- **resume 收口**：`originalDirectoryId()` 改优先读 `directory_id` 列（envelope 读取保留兜底，不再是无写入方的假设）。
- **测试**：`runs-directory.test.ts` 真实 DB 双场景（带/不带 directoryId 的完整异步运行 → 先行行、终态行、两读点全断言）。

## 4. P1：入口矩阵（本设计核心交付）—— 已实施（2026-09-19）

| 现场 | 触发条件 | 入口形态 | 数据来源 |
|---|---|---|---|
| FlowRunsPanel 失败行 | `status === 'failed'` 且 `directoryId` 存在 | 行内「终端」文字按钮（与「重跑」「画布旁观」同区） | GET /runs（P0 后）✅ 实弹验证 |
| 画布失败摘要 | `runState === 'failed'` 且目录已知 | 「在项目目录打开终端」文字按钮（重跑旁） | 本会话 `runDirectoryId` / 旁观走 node-spans `runDirectoryId` |
| Chat 错误卡 | 错误卡出现且 `chat.directory_id` 存在 | 「在项目目录打开终端」（重试旁，terminal 图标） | `chats.directory_id` ✅ 不依赖 P0 |

**共享构造器**：`apps/console/src/lib/terminal-links.ts` 的 `terminalHrefForDir(dirId)` —— 一扇门原则的落点，所有入口只从这里拿 href。

**i18n**：`在项目目录打开终端` / `终端` 等词条已入 `en/common.ts`。

**明确不做**（与定位宣言一致）：Agent 详情页目录入口（agent 无目录概念，P4 的交互式会话入口是另一个门）；Daemons 任务入口（无目录数据）；悬浮副驾错误条入口（空间受限，详情页已有）。

## 5. P2：多标签终端 —— 已实施（2026-09-19）

入口增多后 switch-kill 已由多标签消解：终端页顶部 tab 条（点击切换 / × 关闭 / + 同目录新开），
`tabs: {id, dirId, label?}[]` + `activeTabId` 持久化（`dagents.terminal.tabs`），决策层重写为
`planTabsBoot`（活动 tab attach / recreate / 首个 fresh，含旧版单会话 key 迁移与 cwd 反解目录锚）
+ `planOpenDir`（同目录复用 tab，异目录新 tab）——行为矩阵单测 14 条。历史踩坑语义全数保留
（boot 中途换 tab 的 disposed 复验防孤儿会话、recreate 先删后建防竞态复活、键入实时取会话 id、
深链一次性消费）。浏览器矩阵 6 项实测（新开/切换回放/刷新恢复/关闭/深链落点 pwd 铁证）。

## 6. P3：运行实时终端（live attach）—— 2026-09-19 已实施

「agent 执行时有自己的终端」的落地形态：终端视图从 700ms 轮询策展快照升级为 SSE 实时帧流。实施事实：

- **契约**：`@dagents/contracts/run-live.ts`（shell.ts 姊妹篇）——`hello`（replay 前缀 + 订阅后状态）/`frame`（nodeStart·nodeEnd·delta·runEnd·truncated）两事件族；流在 runEnd 后关闭。
- **网关**：`run-live-registry.ts`（进程内 per-run 帧缓冲，512KB 环形截断 + truncated 标记；attach 原子订阅与 shell-registry 同构）；引擎钩子在 `assembleWorkflowEngine` 单一收口与 span-writer 组合旁路（四个执行入口全收，插话 user_input 回显因 sink.onDelta 即引擎钩子而天然覆盖）；settle 点显式 `live.finish(runStatus)`（workflows / resume-execution / chats 三处；@flow 路径与异常退出由清扫器 2 分钟无帧 + 无执行句柄兜底收敛 `runEnd('unknown')`，有句柄的静默 run 如 HumanInput 挂起不误伤）；已结束条目保留 10 分钟后回收。
- **重开语义**：断点续跑 / HumanInput 应答同 runId 再执行 → 新帧重开条目，replay 里的 runEnd 成为阶段边界（实弹验证于失败 run 的 ended 回放）。
- **console**：BFF SSE 透传 `/api/workflows/runs/:runId/live`；`run-live-protocol.ts` 纯解析；`use-run-live.ts` 编排（connecting → live → closed/unavailable 阶梯）；`run-terminal-format.ts` 增 `createLiveSectionBuilder`（帧 → 与 span 快照同形状的 TerminalSection，RunTerminal 渲染层无感）；画布终端视图 live 可用时切换数据源，其余情况保持既有轮询渲染——**零回归的回退阶梯**。
- **测试**：网关 13 用例（缓冲/回放/截断/重开/清扫/路由全链路 SSE）+ console 20 用例（协议解析边界 + section 构建语义）；实弹双场景（真实引擎失败路径全帧序 + directReply happy path `runEnd completed`）。
- 已知边界：本机 claude CLI 无外联时文本增量仍直播（错误重试以 text delta 到达）；浏览器端 live 画面验证依赖可运行的 LLM 节点（后续接 Mock Provider e2e 补）。

## 7. P4：交互式 agent 会话 —— 已实施（2026-09-19）

「终端承载 agent」：`shell-registry` 的 `createSession` 支持按命令 spawn（`command/args/kind/label`，
会话 id 前缀 `agt_`，最小环境 + PTY 同款安全策略）；`interactive-agent.ts` 把 agent 人格编译成可交
互 argv（判别字段 `agents.kind`）；Agent 详情页「交互式会话」按钮经 `/terminal?agent=<id>` 深链直达
（与 `?dir=` 同款一次性消费），tab 以 agent 名为标签。

v1 支持面（诚实边界）：**claude**（唯一真机 PASS 档）——人格经 `--system-prompt` 全文注入、模型经
`--model`；其余 kind 显式 400 引导切换，不做「裸 CLI 冒充人格会话」的静默降级。测试：解析层诚实
拒绝矩阵 + `/bin/cat` 确定性替身的 PTY 回声全链路（真 claude 托管归 nightly real-cli）。

## 8. 非目标

- 按 agent 配置常驻终端（理由见 §0）。
- daemon 远程任务入口（无目录数据；且远程任务执行在 daemon 侧，本机终端锚定意义存疑）。
- 多实例网关（terminal-architecture.md §6 既定边界不变）。

## 9. 测试计划

| 层 | 内容 |
|---|---|
| 网关单测 | P0：runs 行 directoryId 写入（chat 起源继承 / 画布显式 / 无目录为 null）；GET /runs 与 node-spans 返回字段 |
| console 单测 | `terminalHrefForDir` 构造；入口渲染条件矩阵（failed×有/无 directoryId） |
| e2e（Playwright） | 失败运行行 → 点「终端」→ 落在 `?dir=` 对应目录（`pwd` 铁证 + URL 剥参）；chat 错误卡入口同旅程；会话计数探针复用（1/1/1 无孤儿） |

## 10. 实施记录（原切量估算 → 全部落地）

| 阶段 | 状态 |
|---|---|
| P0 数据链 | **已实施（2026-09-19）** |
| P1 入口 | **已实施（2026-09-19）**，FlowRunsPanel 入口实弹验证 |
| P2 多标签 | **已实施（2026-09-19）**，浏览器矩阵 6 项 |
| P3 运行实时终端 | **已实施（2026-09-19）**，见 §6 |
| P4 agent 会话 | **已实施（2026-09-19）**，claude v1 + 诚实拒绝边界 |

全部五项于 2026-09-19 单日落地；测试账：网关新增数据链 2 + 交互会话 5 用例、console 决策层
重写矩阵 14 用例；验证 = 全仓 vitest（gateway 399 / console 404）+ 浏览器矩阵 12/12（多标签
生命周期 / ?dir= pwd 铁证 / ?agent= 会话标签）+ FlowRunsPanel 失败行入口实弹。
