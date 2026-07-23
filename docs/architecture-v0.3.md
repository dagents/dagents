# 架构设计 v0.3 — 控制台保真收口（addendum）

> **状态**：v0.3 design-fidelity 收口 addendum / 2026-07-14
> **上游**：`docs/architecture-v0.2.md`（v0.2 架构）+ `docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md`（MVP Plan 设计稿，决策表 D1–D19）+ `docs/superpowers/plans/2026-07-13-v0.3-design-fidelity-redesign.md`（v0.3 保真实施计划）
> **范围**：本文件**只承载 v0.3 design-fidelity 收口所需的 §10 控制台 9 屏保真状态**。它不是完整的 v0.3 架构重写——领域模型（§4）、数据流（§6）、可扩展性（§9）等沿用 v0.2 架构 + MVP Plan 设计稿，未在此重复。`docs/v0.3-fidelity-audit.md` 是 9 屏 delta + 3 项后端契约的字段级审计基线，本文是其架构层收口。

## 为什么是这个文件

v0.3 design-fidelity 实施计划（`docs/superpowers/plans/2026-07-13-v0.3-design-fidelity-redesign.md`）多处引用 `docs/architecture-v0.3.md` 的 §3.1 / §4 / §6.8 / §10.2 / §10.3 作为上游 spec。但该文件在仓库中**从未建稿**——v0.3 的工作是在 v0.2 架构 + design/ 原型上做保真收口，没有独立的 v0.3 架构重写。为闭合 M11.1「architecture §10.2 route 表注『已保真实现』」的验收，本文件补齐 §10（控制台 9 屏保真状态），其余章节指向 v0.2 / MVP Plan 设计稿。

---

## §10 控制台 9 屏保真状态（v0.3 收口）

对照基线：`main` HEAD `4196965`（2026-07-14）。design 源：`design/*.html` + `design/js/*`（`DESIGN-MANIFEST.json` screen-file-first 契约）。逐屏 delta + 后端契约字段级对照见 `docs/v0.3-fidelity-audit.md`。

### §10.1 9 屏路由表（已保真实现）

| # | 屏 (design file) | console 路由 | 主组件 | 保真度 | 落地 commit |
|---|---|---|---|---|---|
| 1 | agentflows (`agentflows.html`) | `/flows`, `/flows/[id]/edit` | `flows-view.tsx` + `flow-dag.tsx` + `dag-node.tsx` | list↔detail + DAG + inspector io-box + hash deep-link + edit-iframe；URL hash/DAG 图标见审计 §1.x | M2.1 `@11997412` / M2.2 `@3a0c24f` / M2.3 `@3b38f24` |
| 2 | new-task (`new-task.html`) | `/tasks/new` | `new-task-view.tsx` | picker 模态 + 目录卡 + ⏎⇧⏎ + IME 守卫 + 模板；`doSend` GET 导航（POST 端点已就绪，消费侧待迁移） | M3.1 `@5e1c6f7` / M3.2 `@47927d1` / M3.3 `@4f6e093` |
| 3 | agent-detail (`agent-detail.html`) | `/agents/[id]` | `agent-detail-view.tsx` + `agent-activity-sparkline.tsx` | 两栏 split + 4 tabs（Activity/Instructions/Skills/Logs）+ 30 桶 activity + WS live status（hub 端点待接，断线轮询 fallback） | M4.1 `@ac2927f` / M4.2 `@426d703` |
| 4 | agents (`agents.html`) | `/agents` | `agents-view.tsx` | scope tabs + filter chips（单选）+ 排序 + result-count；多选下拉/批操作/toast/骨架屏 post-MVP | M5.1 `@8fe1164`（修复 `@3a9d39a`） |
| 5 | index (`index.html`) | `/` (launcher), `/chat` | `launcher-view.tsx` + `lib/launcher.ts` | hero CTA + 4 KPI stats + arch-strip 7 层（design 4 步扩展）；module-grid post-MVP | M6.1 `@168b22e` |
| 6 | workspace (`workspace.html`) | `/workspace` | `workspace-view.tsx` | 4 filter chips（真过滤）+ ws-meta 关联 flow 卡 + quota + artifacts；`?new=1` 消费 + 项目入 sidebar post-MVP | M7.1 `@cd520b9`（修复 `@a0d0360`） |
| 7 | lab (`lab.html`) | `/lab` | `lab-view.tsx` | sessions + 线程化 messages + @mention（含内联着色）+ thinking/tool-card + mode switch（持久化）+ 归档；假设/数据/agent 自主回环 post-MVP | M7.x `@64686ff` |
| 8 | dashboard (`dashboard.html`) | `/dashboard` | `dashboard-view.tsx` | density（任务队列马赛克）+ donut（daemon 态）+ throughput（2×2 KPI）+ usage（按模型）+ 3 窗 toggle；1M canvas/面积图/Provider 分摊 post-MVP | M8.1 `@524aa2d` |
| 9 | settings (`settings.html`) | `/settings` | `settings-view.tsx` | 6 tab 4 组形状对齐；API Key live CRUD；tab 2–6 形状对齐 + design 占位数据（数据接线 post-MVP） | M8.2 `@b43bfc8` |

### §10.2 后端契约保真状态

| 契约 | 端点 | 实现位置 | design 形状对齐 | 消费侧 |
|---|---|---|---|---|
| 1 | `GET /api/v1/agents/:id` | `apps/gateway/src/routes/agents.ts` (`toAgentDto`) | [✓ M9.1 `@530b3db`] 1:1 映射 design `agents-data.js` 字段集（评审修复 `@525dd3e`） | ⚠️ console 仍走 dispatch 代理 `/api/v1/dispatch/agents/:id`（snake_case），迁移到 gateway design 路由是 M5 follow-up |
| 2 | `GET /api/v1/flows/:id` | `apps/gateway/src/flowise-shape.ts` (`mapFlowiseToDesignShape`) | [✓ M9.2 `@cff3295`] 返回 design `flows-data` DAG（14 节点类型映射，StickyNote 过滤；评审修复 `@8e121a0`） | ⚠️ console `/api/flows/:id` 仍用自建 `toFlowDetailView`，迁移到 gateway design 路由是后续任务 |
| 3 | `POST /api/v1/tasks` | `apps/gateway/src/routes/tasks.ts` | [✓ M9.3 `@cbd425b`] design 提交体 + 双路径（flow→Path A / agent\|squad→Path B）+ runId 落库 | ⚠️ console `/tasks/new` 仍 GET 导航 `/workspace?new=1`，切到 POST + `/workspace` 消费 `?new=1` 是后续任务 |

> **注（对照 v0.2 §6 数据流）**：契约 1/2 的「消费侧待迁移」即 v0.2 §6.1/§6.2 数据流里 console → gateway 的读路径形状校齐——gateway 端 design-shape 路由已就绪，console 切换是 M5 范畴的接线工作，不影响 v0.3 保真收口（各屏 UI 已按 design 形状渲染，数据形状差异在客户端 mapping 层吸收）。

### §10.3 §6.8 WS hub 状态（M4.2 补注）

`packages/contracts/src/ws.ts` 定义 `ConsoleWsFrame` 判别联合（`agent-updated` / `run-updated`）+ `apps/console/src/lib/ws-client.ts` 单例 socket（指数退避重连 1s→2s→4s，断线时视图轮询 fallback）。`wsUrl()` 默认 `ws://localhost:8080/ws`（`NEXT_PUBLIC_WS_URL` 可覆盖）。

**⚠️ 注意**：gateway 当前**尚未挂 `/ws` WebSocket 端点**——M4.2（`@426d703`）落地了客户端 + 契约 + 轮询 fallback，但 hub 服务端 emit 端点是后续任务。agent-detail 在 hub 缺席时降级为轮询 `GET /api/agents/:id`，功能不中断。这是 v0.3 收口时**唯一已知「客户端就绪、服务端待接」**的缺口，登记为 post-MVP follow-up（非保真缺口，因 design 无 WS 契约——WS hub 是平台自建的 live-refresh 增强，design 静态 HTML 不涉及）。

### §10.4 post-MVP 遗留（有意推迟，非遗漏）

以下为各屏明确标注 post-MVP 的项，依赖平台尚未提供的 API 或超出 MVP 边界，**不在 v0.3 保真收口范围**（逐条 delta 见 `docs/v0.3-fidelity-audit.md` 各 §x.x）：

- **agents**：多选下拉 filter + 每值计数、批量多选 + 批操作栏、行 ⋯ popover、30 天 sparkline 列、运行次数列、搜索清空 ×、骨架屏、toast、空态增强、注册 Agent 操作
- **index**：module grid + section labels
- **workspace**：项目入 sidebar、`?new=1` 消费、chat-head 今日消息数、page actions（归档/新建）
- **lab**：artifacts 假设/数据组、agent 自主回环、sessions-head + 新建 icon、新实验完整配置
- **dashboard**：1M-agent canvas 热图、24h 面积图、Provider 成本分摊、事件流卡、导出 CSV、刷新动画、30d 窗
- **settings**：tab 2–6 数据接线（默认模型/预算熔断/通知/账户团队/危险区 live）、gateway 卡细节、copy/reveal（安全上无原文）、revoke checkbox、topbar 搜索、toast 动画
- **契约消费侧迁移**：console agents/flows/tasks 从 dispatch/自建形状切到 gateway design-shape 路由（M5 follow-up）
- **WS hub 服务端端点**（§10.3）

---

## §3.1 / §4 / §6 指向

v0.3 plan 引用的上游架构章节，沿用既有文档，不在本 addendum 重复：

- **§3.1 分层视图 / arch-strip 7 层**：见 `docs/architecture-v0.2.md §3.1`（接入 / 网关 / 编排 / 适配 / 调度 / 版本 / 存储 + 观测）。console launcher 的 `ARCH_STEPS`（`apps/console/src/lib/launcher.ts`）即据此 7 层渲染，design `index.html` 原仅 4 步（接入/网关/编排/适配），console 补全为 7 层对齐平台实际分层。
- **§4 核心概念模型（Agent / Pipeline / Run / 版本可复现）**：见 `docs/architecture-v0.2.md §4` + MVP Plan 设计稿 §1.4–§1.9。v0.3 保真未改领域模型。
- **§6 关键数据流（Path A flow fan-out / Path B direct-agent / 资源计量）**：见 `docs/architecture-v0.2.md §6` + MVP Plan 设计稿 §1.5–§1.9。契约 3 的双路径（flow→Path A / agent\|squad→Path B）即 §6.2 流水线执行流 + §6.7 Agent Daemon 执行流的 gateway 入口。WS hub（§6.8）状态见本文 §10.3。

---

_收口 commit：本提交（v0.3-M11.1，基于 main `4196965`，2026-07-14）_
_分支：`issue/MZW-310`_
