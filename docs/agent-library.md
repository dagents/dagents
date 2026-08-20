# Agent Library（Agent 资产库）架构设计

> 状态：**Phase 1 + 2 + 3 已实现并验证（2026-08-19）**，见 §8 实现清单。
> 目标：把 [agency-agents](https://github.com/msitarzewski/agency-agents)
> （276 个 Markdown 人格专家、17 个 division、MIT）作为「Agent 资产库」接入 dagents，
> 并在架构层面消解接入评估中识别的四个风险。
> 姊妹篇：`docs/skills-registry.md`（本设计大量复用其模式）。

## 0. 背景与风险清单

agency-agents 是纯 prompt 资产库：每个 agent 一个 `.md`（YAML frontmatter：
`name/description/color/emoji/vibe/tools` + 正文 Identity/Mission/Rules/Deliverables/Workflow）。
平均 13.9KB/个（≈3.5k tokens），最大 80KB。dagents 是执行平台但缺专家人格。

| # | 风险 | 根因 |
|---|------|------|
| R1 | `@workflow` 生成 prompt 爆炸 | `chat-execute.ts` 的 `routeWorkflowCommand` 全量 `SELECT id,name,kind,summary FROM agents` 注入生成器（skills 已有 40 条上限，agents 无上限） |
| R2 | token 成本 | 人格正文平均 14KB，含大量 Deliverables 代码示例 |
| R3 | 上游同步 | agency-agents 活跃更新，一次性导入会腐化 |
| R4 | 英文人格 vs 中文用户 | prompt 全英文，回复语言不受控 |
| R5 | 工具假设差距 | frontmatter 声明 `tools:`，dagents `prompt` 类型是单轮 LLM 且**聊天里不可执行**（`INLINE_SUPPORTED_KINDS` 只含 CLI 类型，见 `inline-executor.ts:39`） |

## 1. 核心决策总览

| 决策 | 内容 | 消解 |
|------|------|------|
| D1 | **库/目录分离**：316 个人格住文件系统注册表，agents 表只装「已激活」的 | R1 |
| D2 | **宿主 kind='claude'**：实例化为 CLI Agent，人格进 systemPrompt，CLI 自带真工具 | R5 |
| D3 | **编译式导入**：三档瘦身 profile（full/slim/minimal）+ 32k 字符硬顶 | R2 |
| D4 | **fork-on-instantiate + provenance**：实例化即 fork，`library_meta` 记录出处哈希，drift 检测三态 | R3 |
| D5 | **语言包络**：instructions 尾部追加固定语言指令，不翻译人格 | R4 |
| D6 | **团队场景 → 工作流模板**：README Scenario 预置 flows 模板（Phase 3） | 增值 |

```
agency-agents repo (git pull 即同步)
  │  挂载目录（默认 ~/.agents/agent-library，可加 DAGENTS_AGENT_LIBRARY_DIRS / UI 管理）
  ▼
AgentLibraryRegistry（fs 扫描 + frontmatter 解析 + TTL 60s 缓存，不落库）
  │                    + divisions.json → division 元数据（label/icon/color）
  ▼  console /agents「库」tab：division 分组浏览、搜索、瘦身预览
  ▼  「启用」= POST /api/v1/agent-library/:name/instantiate
  ▼  persona-compiler：compilePersonaBody(profile) + 语言包络 + sha256 溯源
  ▼
agents 表（kind='claude'，library_meta 记 provenance；只含用户激活的）
  ▼
聊天 AgentSelector / 工作流 platformAgent 节点 / @workflow 生成
（@workflow 的 SELECT 只看到已激活项 → 清单天然可控）
```

## 2. 决策详解

### D1 库/目录分离（registry-not-database）

照抄 `skills-registry.ts` 骨架（roots 排序去重、TTL 缓存、warn-and-skip）：
文件系统即真相源，agents 表只是「激活视图」。**316 个人格永不批量入库**，
于是 `routeWorkflowCommand` 的全量 SELECT 天然保持小规模——R1 的结构性解法，
零 schema 变更、零生成器语义变更。

防御性补强：`buildWorkflowGeneratorPrompt` 的 agentLines 加上限
（80 个 / 条目 summary 已有 80 字符截断），超限截断注明「完整清单见 Agents 页」。
防的是用户手动激活几百个的极端情况。

与 skills 的 frontmatter 差异（所以是平行模块，不是复用）：name 自由大小写、
必填仅 `name/description`、额外键（color/emoji/vibe/tools）进 metadata；
`tools` 仅作展示标注（「该人格假设宿主有 WebFetch 等工具」），不映射任何执行配置。

### D2 宿主 kind='claude'

- `INLINE_SUPPORTED_KINDS` 不含 `prompt` —— prompt 类型在聊天里直接报「无法本机执行」。
- 实例化默认 `kind='claude'`，人格正文经既有链路
  `instructions → composeSystemPrompt → ExecOptions.systemPrompt → CLI`
  （inline chat 与 workflow platformAgent 两条路都已打通）。
- CLI agent 有真实工具调用，正好满足人格的 `tools:` 假设；也符合「CLI 第一性」哲学。
- 实例化时可改 kind（codex 等其余 CLI 类型）。

### D3 编译式导入（persona-compiler.ts，纯函数）

```
compilePersonaBody(rawMd, profile):
  full    → 去 frontmatter 原文
  slim    →（默认）保留 H2 段落：Identity/Mission/Rules/Workflow/Success Metrics，
            剥离 Technical Deliverables 内的 ``` 代码块（保留 fence 首行作为占位标注）
  minimal → 只保留 Identity + Critical Rules
```

- 尺寸护栏复用 `skill-injection.ts` 的模式：单 Agent instructions 上限 32,000 字符，
  超出截断并追加 `[persona truncated]` 标注。
- slim 档实测预期 14KB → 4~6KB（≈1.5k tokens）。
- 纯函数 + 输出确定性 → 好单测，且同一输入可对照三档预览。

### D4 fork-on-instantiate + provenance

- **实例化即 fork**：agents 行是用户资产，上游更新永不自动覆盖（用户改过的人格不被冲掉）。
- 新 migration（`1720000015000-add-agents-library-meta.ts`）：
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "library_meta" JSONB;`（全设计唯一 schema 变更）
- `library_meta = { source_path, source_sha256, instructions_sha256_at_import, division, profile, imported_at }`
- drift 检测（`GET /api/v1/agent-library/drift`）三态对比：
  - 库文件 sha ≠ source_sha256 → **上游已更新**（可 reimport）
  - 行 instructions sha ≠ instructions_sha256_at_import → **本地已修改**（reimport 会覆盖，UI 需确认）
  - 双等 → **一致**
- reimport 按稳定键（library_meta.source_path）定位行，覆盖 instructions / 更新 library_meta，
  **id 不变** → 已引用该 agent 的工作流 agentId 不失效。
- 上游更新本身 = 挂载目录 `git pull`；注册表 TTL 缓存自动看见新文件。

### D5 语言包络

实例化时在 instructions 尾部追加固定段（不进 compiler，instantiate 时拼装）：

```
## Language
Always respond in the user's language. If the user writes Chinese, respond in Chinese.
Keep your persona, voice, and domain expertise unchanged.
```

库页 division 标签走现有自然键 i18n（中文即 key，`en/agents.ts` 加词条）。

### D6 团队场景工作流模板（Phase 3，不阻塞）

agency-agents README 的 6 个团队组合（MVP 构建 / 产品发现 / 营销发布 / 付费媒体接管 /
智慧校园数字孪生 / 企业功能开发）预置为静态 flows 模板：platformAgent 节点按
**人格 name** 引用，模板实例化时批量解析 name → agentId（缺哪个就先 instantiate 哪个）。

## 3. API 设计

```
GET    /api/v1/agent-library                    # 目录（division 分组 + name/description/emoji/size/tools），?division=
GET    /api/v1/agent-library/:name              # 详情：原文 + 三档编译预览 + 已实例化状态/drift 状态
POST   /api/v1/agent-library/roots              # 挂载目录管理（~/.agents/agent-library-dirs.json）
DELETE /api/v1/agent-library/roots
POST   /api/v1/agent-library/:name/instantiate  # { profile?, kind?, model? } → agents 行；同名 409（?force 覆盖）
GET    /api/v1/agent-library/drift              # 三态清单
POST   /api/v1/agent-library/:name/reimport     # 覆盖 instructions（本地已修改时需 body.confirm=true）
```

instantiate 写路径完全镜像 `agent-templates.ts` 的 `instantiate`（它又镜像
`POST /api/v1/agents`），workspace_id/owner_id 默认值取法一致。

## 4. 模块落点

```
apps/gateway/src/
  agent-library-registry.ts       # 新：registry 骨架（照抄 skills-registry 模式）
  managed-agent-library-dirs.ts   # 新：照抄 managed-skill-dirs.ts
  persona-compiler.ts             # 新：compilePersonaBody + sha256（纯函数）
  routes/agent-library.ts         # 新：上述 API
  routes/chat-execute.ts          # 改：buildWorkflowGeneratorPrompt 加防御性 cap（约 5 行）
apps/console/（agents 域）         # Agents 页「库」tab：division 分组 + 启用 + drift 角标
packages/db/src/migrations/1720000015000-add-agents-library-meta.ts
scripts/import-agency-agents.ts   # 可选：Phase 1 直接用 instantiate API 即可，CLI 非必需
```

## 5. 测试策略

- `persona-compiler` 单测：frontmatter 解析 / 三档瘦身断言（用真实样例文件夹具）/ 32k 截断 / sha256 稳定性
- registry 单测：warn-and-skip（缺 frontmatter、空 description）/ rank 去重 / TTL（对齐 skills-registry 测试写法）
- drift 单测：三态构造
- e2e（`apps/console/tests/e2e/spec-16-agent-library.spec.ts`，复用 mock-llm webServer 地基）：
  浏览 → 启用 → 聊天召唤（mock provider 返回固定内容）→ agents 表断言 library_meta

## 6. 分期

| 期 | 内容 | 状态 |
|----|------|------|
| Phase 1 | registry + compiler + 只读 API + 实例化「架构师/PM/Reality Checker」 | ✅ 完成（见 §8） |
| Phase 2 | console 库页 + drift + migration + 单测/e2e（spec-16） | ✅ 完成 |
| Phase 3 | 团队场景 flows 模板 + 双语人格衍生目录 | ✅ 完成（见 §8.1） |

## 7. 明确不做（Non-Goals）

- 不做 agent 全量入库 / 不做人格自动翻译 / 不把 `tools:` 声明映射成任何执行时工具配置
- 不改 `@workflow` 生成器语义（只加防御性上限）
- 不引入 agency-agents 的 convert.sh / install.sh（其面向 CLI 工具的安装格式与 dagents 无关）

## 8. 实现清单（2026-08-19，Phase 1+2）

**Gateway**（单测：`__tests__/persona-compiler.test.ts` 15 用例 + `__tests__/agent-library.test.ts` 11 用例，dev Postgres 直连）

| 文件 | 内容 |
|------|------|
| `apps/gateway/src/persona-compiler.ts` | 纯函数：frontmatter 解析 / slug / 三档编译 / 32k 硬顶 / 语言包络 / sha256 / drift 五态判定 |
| `apps/gateway/src/managed-agent-library-dirs.ts` | `~/.agents/agent-library-dirs.json`（UI 挂载目录，同构 managed-skill-dirs） |
| `apps/gateway/src/agent-library-registry.ts` | fs 注册表：divisions.json 门控 + 嵌套扫描（≤3 层）+ rank 去重 + TTL 60s |
| `apps/gateway/src/routes/agent-library.ts` | 7 端点（list/detail/roots×2/drift/instantiate/reimport），挂载 `/api/v1/agent-library` |
| `apps/gateway/src/routes/chat-execute.ts` | `buildWorkflowGeneratorPrompt` agent 清单 80 条防御上限 |
| `packages/db/src/migrations/1720000015000-add-agents-library-meta.ts` | `agents.library_meta JSONB`（唯一 schema 变更） |

**Console**（typecheck/lint 通过）

- 代理路由 ×6：`src/app/api/agent-library/**`（gatewayProxy 一行式）
- `src/lib/agent-library.ts`：API client（unwrap 模式）
- `src/components/agent-library-gallery.tsx` + `src/styles/agent-library.css`：/agents 页「从人格库启用」modal（部门 chips / 搜索 / drift 角标 / 三档确认步 / 空态挂载表单）
- i18n：`src/i18n/en/agents.ts` 新增词条（自然键中文即 key）

**E2E**：`apps/console/tests/e2e/16-agent-library.spec.ts`（fixture 挂载经 roots API，afterAll FK-safe 清理）

**测试工程师回合（2026-08-20）**：

- 真库数据质量巡检：270 条全量断言（描述 ≥60 字符 / 无空名 / 无重复 id）通过；「折叠 YAML 解析 bug」排除（grep 未锚定误报），但据此加固 persona-compiler（`>`/`|` 指示符 warn-and-skip）+ 4 个边界用例（CRLF / 引号值 / 值内冒号 / 指示符）。
- gateway 缺口补齐 +11 用例（22/22）：registry 隐藏文件与损坏 divisions.json、roots 四条错误路径、生命周期四态（kind/name override / upstream-updated 免确认 reimport / diverged / missing-upstream）、fan-out 模板混合复用（1 预启用 + 2 新启用 + 结构断言；用注入的合成模板避免真库/演示数据干扰）。
- spec-16 修复并扩到 6 用例：**describe 块被提前闭合**——Phase 3 追加的用例意外成为顶层测试，跑在 describe 的 afterAll（卸载 fixture 根）之后，导致徽章/团队用例必然失败；已全部移回 describe 内。新增：启用后卡片 drift 徽章、团队全链 UI 旅程（fixture 成员 → 创建工作流 → 落画布 → DB 断言 → 自清理）。
- **修复既有 P0**：`chat-execute.test.ts` 的 `wipeAllAgents()` 全表清空 agents 后只恢复 agent_daemons 备份 + 一行默认 agent —— agents 表的开发数据（人格库启用的、手工创建的）被永久吞掉（真机损失 7 个演示 Agent，已重新启用恢复）。现按 agent_daemons 同策略备份/恢复 agents 全部列，并加防回归用例（标记 agent 经 wipe+restore 存活，library_meta 一字不差）；验证方式：全量套件跑前跑后 library agents 数量不变（7→7）。

**实测记录**：软链 `~/.agents/agent-library → agency-agents` 后扫描出 **17 部门 / 270 人格**（276 源文件中 6 个无有效 frontmatter 被 warn-and-skip）；已预启用三个演示 Agent —— `engineering/software-architect`、`product/product-manager`、`testing/reality-checker`（均 kind=claude / profile=slim；PM 原文 ~35KB → 9.3KB ≈ 2.3k tokens，Deliverables 剥离、Mission/Identity/Rules 保留、语言包络附加）。

**已知取舍**：270 张卡片全部客户端渲染（无分页，搜索/部门筛选先行；量大后再加虚拟滚动）；`GET /api/v1/agents/:id` 详情不返回 instructions（沿现有契约，人格正文在库里看）。

### 8.1 Phase 3 实现清单

**团队场景工作流模板（D6）**

- `apps/gateway/src/routes/agent-library-teams.ts`：6 个静态模板（创业 MVP 构建 / 企业功能开发 / 营销活动发布 / 付费媒体接管 / 产品发现·并行 / 智慧校园数字孪生，忠实映射 agency-agents README Scenario 1~6）。步骤按 **frontmatter name** 引用（不写死 id，division 重组不失效；真库 270 条已验证无重名）。`GET /team-templates`（含成员解析状态）+ `POST /team-templates/:id/instantiate`（缺失人格 422 显式列出；成员复用 `library_meta` 稳定键 / 缺的自动 slim 启用；组装 FlowData 落 draft flow）。**路由必须在 `/:division/:slug/instantiate` 之前注册**（Hono 同形按序匹配）——app.ts 已按此挂载并注释。
- 共享落库助手 `agent-library-instantiate.ts`（单人格/团队共用 INSERT + 批量复用查询）+ registry 新增 `getAll()`（团队批量解析只付一次扫描）。
- Console：画廊新增「人格 | 团队场景」模式 tab，团队卡片（成员 chips + 库中缺失标注）→ 确认步（成员清单 + 形状说明 + 创建按钮，有成员不可解析时禁用）→ 创建后跳 `/workflows/{id}/canvas`。代理路由 ×2。
- 测试：gateway 3 用例（目录解析 / 实例化+幂等复用+flow 结构断言 / 缺失 422 —— fixture 用与真库相同 division/slug，env 根 rank 300 覆盖默认根保证确定性）；e2e spec-16 第 4 用例（团队 tab UI 渲染，断言环境无关）。

**双语人格衍生目录（D5 延伸）**

- `~/.agents/agent-library-zh/`（**默认不挂载**）：中文版 Product Manager / Software Architect（frontmatter name 与上游一致 —— 团队模板按 name 解析，同一成员中文版同样命中）+ README 说明挂载方式与**同名覆盖语义**（挂载根 rank 400 < 默认根 500，同名 `<division>/<slug>` 时中文版优先；已启用英文版的行会显示 drift「上游已更新」，reimport 即切换中文版）。
