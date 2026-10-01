# Agent 广场（Agent Plaza）— 架构设计

> **状态**: Implemented（2026-10-01）
> **上游**: PM 评估结论（2026-10-01 会话）——「Agents 广场」MVP = 内置精选内容 + 一等浏览页 + 消费侧入口补齐
> **关联**: `docs/agent-library.md`（人格库 D1-D6 决策，广场是其 Phase 4）· `docs/flow-templates.md`（"内置内容 + 一等画廊"先例）
> **内容源**: [agency-agents](https://github.com/msitarzewski/agency-agents)（"The Agency"，MIT）

## 1. 问题

Agent 人格库的前端面（`agent-library-gallery.tsx` modal）存在三个结构性问题：

1. **入口被藏**：唯一入口是 `/agents` 页一个次级按钮；空态只推「新建 Agent」；聊天 AgentSelector、画布 platformAgent 节点选择器均无库入口。
2. **冷启动断头路**：库为空时，用户必须先知道 agency-agents 这个 GitHub 仓库的存在并手动 clone/软链到 `~/.agents/agent-library`——与产品「CLI 第一性、零配置可跑」的哲学相悖。
3. **下游断链**：9 个团队场景模板按人格 name 强耦合（缺成员 422 断头）；10 个内置流程模板的 personaName 降级（未装库 → 降级 LLM 节点）。人格库丰富度同时决定四条下游链路（团队模板 / 流程模板 / `@workflow` 生成 / 画布节点）的体验。

## 2. 目标 / 非目标

**目标**：

1. 开箱即用：全新安装（`~/.agents/agent-library` 为空）也能在广场浏览并启用精选人格。
2. 广场升一等页面：`/agents?tab=plaza` 深链可达，替代原 modal。
3. 消费侧入口补齐：聊天 AgentSelector 与画布 platformAgent 节点选择器可跳转广场。
4. 团队模板 / 流程模板在新装环境零缺失成员（内置精选全覆盖其引用人格）。

**非目标**（PM 结论明确的 Non-Goals）：

- 在线市场（远端 registry、评分、安装量、账号体系）——单机模式产品撑不住，且偏离编排引擎主业。
- 远程一键安装（git clone 引导即可，不做网关侧拉取）。
- 团队模板数据源重构（常量 → JSON，P2 另行安排）。

## 3. 核心设计决策

### D1 — 内置精选库 = in-repo 静态内容，registry 第 5 类根

新根 `apps/gateway/builtin-library/`（50 个人格 / 13 个分部），与 `quickstart-library` 同构：
`divisions.json` 门控分部 + 分部目录下 `.md` 人格。内容从 agency-agents 按 curation 策略（§4）挑选
原样拷贝（源格式 = 本库格式，零转换）。构建/打包无需处理——registry 运行时读源文件，
与 quickstart 一致（dev 直跑 src、构建产物同目录）。

### D2 — rank 900「内容兜底」语义（遮蔽问题的解）

根发现顺序与优先级（**低 rank 胜**，同名 id 由最低 rank 的根提供内容）：

| rank    | 根                                  | 语义                                             |
| ------- | ----------------------------------- | ------------------------------------------------ |
| 50      | `quickstart-library`（in-repo）     | 快速开始档位人格（独立 division，不与他人撞 id） |
| 300+    | `DAGENTS_AGENT_LIBRARY_DIRS`（env） | 用户显式配置                                     |
| 400+    | UI 挂载目录（managed）              | 用户 UI 挂载（如中文覆盖库）                     |
| 500     | `~/.agents/agent-library`（默认）   | 用户默认库（agency-agents 全量 clone）           |
| **900** | **`builtin-library`（in-repo）**    | **兜底内容：任何人库同 id 即覆盖内置**           |

关键点：内置精选**不是** override 而是 floor。用户 clone 了全量 agency-agents 后 `git pull`
拿到新版，同名人格（id 相同 = division/slug 相同）由用户库（rank 500）胜出——**内置的旧副本
永远不会遮蔽用户的新版本**。这与 quickstart（rank 50，主动遮蔽）语义相反，是有意的：
quickstart 是「产品定义的入口档位」要保证一致，内置精选只是「没内容时的保底」。

条目摘要新增 `source` 字段（`'quickstart' | 'custom' | 'managed' | 'default' | 'builtin'`，
= 提供该条目的根的 source），前端据此渲染「内置」角标，让用户知道哪些是产品预置、
哪些来自自己的库。

### D3 — curation 策略：模板成员全覆盖 + 开发者工作流高价值精选

50 个精选的选择标准（按优先级）：

1. **团队模板成员全覆盖（33 个）**：9 个团队场景模板引用的全部人格 name —— 内置后
   新装环境团队模板零 422、全部成员可解析。
2. **流程模板 personaName 覆盖（+2）**：Code Reviewer、Senior Developer、Software Architect
   —— 内置后 10 个内置流程模板在新装环境自动从「降级 LLM 节点」升级为真 Agent 节点。
3. **dagents 定位高价值（+15）**：dagents 是开发者本机工作流产品，精选工程侧
   （SRE / DevOps Automator / AI Engineer / RAG Pipeline / Prompt Engineer /
   Multi-Agent Systems Architect / 微信小程序 / Technical Writer）、
   specialized 三杰（Codebase Archaeologist / MCP Builder / Agents Orchestrator）、
   Product Manager、Penetration Tester + Application Security Engineer、Research Synthesist。

分部：engineering(14) / product(3) / testing(2) / design(3) / marketing(6) / support(2) /
paid-media(5) / project-management(3) / gis(5) / spatial-computing(1) / specialized(3) /
research(1) / security(2)。营销/付费媒体/GIS 等分部虽偏「虚拟公司」，但它们是团队模板
成员的来源，属于覆盖项而非自由精选。

**同步策略**：agency-agents 上游更新不自动跟进（内容冻结）；升级 = 手动重拷 + 提交，
frontmatter name 若变化需同步检查团队模板引用（测试有守卫，见 §6）。

### D4 — 广场 = `/agents?tab=plaza` 页面级 tab，modal 退役

`/agents` 顶部页级双 tab：「我的 Agents」（原列表）/「Agent 广场」。tab 状态同步到
URL（`?tab=plaza` 可深链、可分享），聊天选择器与画布检查器入口直接指向该链接。
原 `agent-library-gallery.tsx` modal 删除，浏览/确认/启用/团队场景逻辑迁入页面组件
`agent-plaza.tsx`（复用既有 `agent-library.css` 卡片语言 + `atg-*` 模板卡体系）。

广场陈列升级：

- 卡片显示 `vibe`（人格标语，斜体引用行）——取代对用户无意义的字节数（体积降级为次要信息）。
- 「全部」视图按分区分组渲染（quickstart 置顶 → 各分部小节），配合 `content-visibility: auto`
  做廉价虚拟化（300+ 卡无虚拟滚动库依赖）。
- 空态（理论上仅 builtin 目录被删时出现）保留挂载表单；底部常驻「挂载完整 The Agency 库」
  引导（clone 命令一键复制）——广场从「断头路」变成「可扩展入口」。

### D5 — 归档 CHECK 修复（顺手）

console 归档 PATCH 发 `visibility: 'archived'`，但 `agents_visibility_chk` 只允许
`('workspace','public')`——全新库上归档必撞 CHECK。migration 放宽为三值。

## 4. 变更清单

**Gateway**：

- `src/agent-library-registry.ts`：`source` 联合类型 + `builtin` 根（rank 900）+
  条目摘要透出 `source`；`BUILTIN_LIBRARY_DIR` 以模块相对路径定位（同 quickstart）。
- `builtin-library/`（新增目录）：50 `.md` + `divisions.json` + `README.md`（归属与 curation 记录）。

**DB**：`1720000101000-widen-agents-visibility-chk.ts`。

**Console**：

- `agent-plaza.tsx`（新）：广场页面组件（人格/团队场景双模式、搜索、分部筛选、
  分区分组、确认步、drift 角标、内置角标、挂载引导）。
- `agents-view.tsx`：页级双 tab（`?tab=` 同步）+ 空态直达广场；删除 modal 挂载。
- `agent-selector.tsx`（聊天）：尾部「从广场启用 →」链接。
- `flow-canvas/inspector/form-engine.tsx`（画布）：agentId 下拉下方「从广场启用」链接
  （新标签页打开，避免打断画布编辑态）。
- 删除 `agent-library-gallery.tsx`。

**测试**：`__tests__/agent-library.test.ts` 新增内置库守卫组（§6）。

## 5. 用户路径（改造后）

```
新装环境：
/agents → 「Agent 广场」tab（空态 Hero 直达）→ 浏览 50 个内置精选（分区分组）
  → 点卡片确认步（三档瘦身 + 运行时/模型）→ 启用 → 跳转 /agents/<id>
  → 聊天选择器选它 / 画布节点绑它 / 交互式会话

聊天中缺 Agent：AgentSelector → 「从广场启用 →」→ /agents?tab=plaza
画布绑节点缺 Agent：agentId 下拉 → 「从广场启用 ↗」（新标签页）
团队场景：广场「团队场景」tab → 9 个模板全部成员可解析（内置兜底）→ 一键成团
```

## 6. 测试守卫

1. **内置目录完整性**：`builtin-library` 扫描 ≥50 条目、全部命中 13 个合法分部、
   每条目有 name/description（parse 成功即证）。
2. **rank 900 兜底语义**：同 id 条目在用户根（任意 rank < 900）与内置根同时存在时，
   用户根胜出（description 断言）；仅内置存在时内置提供。
3. **团队模板零缺失**：真实根集（含 builtin）下 9 个团队模板全部成员可解析
   ——在新装环境（无用户库）等价成立，因为测试用 fixture 根 + builtin 根。
4. **source 透出**：内置条目 `source === 'builtin'`。
5. **visibility migration**：`archived` 通过 CHECK（migration 后 insert 断言）。

## 7. 风险与取舍

- **repo 体积**：50 文件 ≈ 500KB Markdown，可接受；全量 282 个（≈3MB）被否——
  稀释品质感且大部分与开发者工作流无关，全量交给 clone 引导。
- **内容时效**：冻结快照会落后于上游；兜底语义保证用户库始终优先，内置旧副本无害。
- **英文人格 + 中文产品**：D5 语言包络已解决执行语言；展示名保留英文（人格身份的一部分，
  与现网行为一致）。
- **画布入口新标签页**：启用后回画布需重新选中节点刷新下拉（option TTL 缓存）——
  v1 接受，不做跨标签页通知。
