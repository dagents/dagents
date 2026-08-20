# Flow Templates（流程模板中心）架构设计

> 状态：**已实现并验证（2026-08-20）**，见 §10 实现记录。
> 目标：把跑通的工作流抽取为可复用模板，内置
> 模板随开源仓库分发，与既有三层模板资产（agent 模板 / 人格库 / 团队场景）
> 收拢为一个「模板中心」入口。姊妹篇：`docs/agent-library.md`（本设计大量
> 复用其 instantiate 管道与按名解析模式）。

## 0. 背景与产品定位

dagents 已有两层模板资产：agent-templates（静态 Agent 一键创建）与团队场景
（agency-agents README 的生成式 DAG 模板）。缺第三层——**具体流程模板**：
用户在画布跑通一条流程后「另存为模板」，一键复用；官方内置一组随仓库分发，
新用户 clone 后 /flows 页开箱即用，社区可 PR 贡献。

| 模板层 | 来源 | 存储 | 实例化产物 |
|---|---|---|---|
| 内置流程模板（本设计） | 仓库自带，社区 PR | in-repo JSON（import 内联） | draft flow |
| 团队场景（已有） | README Scenario | 生成式（steps→DAG） | draft flow + 成员 Agent |
| 我的模板（本设计） | 画布「另存为模板」 | `flow_templates` 表 | draft flow |

三层共用 /flows 页「从模板创建」画廊（三个 tab），instantiate 分流到各自端点。

## 1. 核心决策

### D1 模板必须「无人格库也能跑」（开源传播关键）

模板中的 platformAgent 节点**不存 agentId**（uuid 只在本机有意义），改存
`personaName` 引用。实例化时：

- 人格名可解析（agent-library 注册表命中）→ 复用已启用行 / 自动 slim 启用
  → 绑真实 agentId（与团队场景同一管道）；
- 解析不到（未挂库 / 上游改名）→ **优雅降级**：节点改写为 `llmAgentflow`，
  systemPrompt = 节点任务指令（+ 「以 {personaName} 专家身份」前缀，若有名）。

模板永远可用：新用户零依赖可跑，装了人格库自动升级为真 Agent 编排。

### D2 抽取即清洗（`extractTemplateFromFlow` 纯函数）

`另存为模板` 不照抄 flow_data：

- platformAgent 节点：`inputs.agentId` → 查 agents 表（library_meta.id 命中者
  取 agents.name 为 personaName；无溯源者 personaName=null 纯降级引用）→
  清空 agentId，记入 `agentRefs[{nodeId, personaName, task}]`；
- 全节点：剥离运行态字段（output/result/executionData/runId 等黑名单键）；
- 其余节点类型（llm/directReply/condition/iteration/http…）**v1 原样透传**——
  除 platformAgent 外零改写，最小惊讶；
- edges 与 position 原样保留；校验：节点非空且含 startAgentflow。

### D3 内置模板 = import 内联，不是运行时 fs 读

gateway 以 `tsup src/index.ts` 单入口构建，dist 不含额外源文件——内置模板
放 `src/flow-templates/builtin/*.json`，由 `index.ts` 静态 import（tsup 内联）。
社区 PR：加一个 JSON + index 一行 import。若未来 JSON import 出现兼容问题，
回退方案为 tsup `assets` + 运行时 fs 读（记录在案，不预先实现）。

### D4 双源单合同

内置与用户模板统一为 `FlowTemplateSpec`，列表接口合并返回（`source` 字段
区分）；用户模板可删（DELETE），内置模板不可删（405）。

## 2. 数据模型

### 2.1 TemplateSpec（运行时合同，两端共用）

```ts
interface FlowTemplateSpec {
  id: string            // builtin: 'builtin/<slug>'；user: uuid
  name: string
  description: string
  icon: string          // emoji
  category: 'dev' | 'research' | 'content' | 'ops' | 'custom'
  source: 'builtin' | 'user'
  /** 画布 FlowData：platformAgent 节点 inputs.agentId 为空，由 agentRefs 重绑。 */
  flowData: { nodes: unknown[]; edges: unknown[] }
  agentRefs: Array<{ nodeId: string; personaName: string | null; task: string }>
}
```

### 2.2 DB（仅用户模板）——migration `1720000017000-create-flow-templates.ts`

（1720000016000 已被 allow-null-daemon-id 占用。）

```sql
CREATE TABLE "flow_templates" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           VARCHAR(255) NOT NULL,
  "description"    TEXT,
  "icon"           VARCHAR(16) NOT NULL DEFAULT '📄',
  "category"       VARCHAR(32) NOT NULL DEFAULT 'custom',
  "flow_data"      JSONB NOT NULL,
  "agent_refs"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "source_flow_id" UUID,                 -- 溯源（抽取自哪条 flow，可空）
  "created_by"     TEXT NOT NULL DEFAULT 'local',
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT flow_templates_category_chk
    CHECK ("category" IN ('dev','research','content','ops','custom'))
);
```

## 3. 模块落点

```
apps/gateway/src/
  flow-template-pipeline.ts       # 新：extractTemplateFromFlow / instantiateFlowTemplate（纯函数 + 复用 agent-library-instantiate）
  routes/flow-templates.ts        # 新：GET / | POST /from-flow/:flowId | POST /:id/instantiate | DELETE /:id
  flow-templates/builtin/         # 新：*.json + index.ts（import 聚合）+ README.md（模板格式与 PR 指南）
apps/console/src/
  lib/flow-templates.ts           # 新：API client（unwrap 模式）
  components/flow-template-gallery.tsx  # 新：三 tab 画廊（内置/团队场景/我的模板）
  components/save-flow-template-dialog.tsx  # 新：画布「另存为模板」小 modal
  app/api/flow-templates/**       # 新：代理路由 ×4
packages/db/src/migrations/1720000017000-create-flow-templates.ts
```

`app.ts` 挂载 `/api/v1/flow-templates`（无同形路由冲突，`:id` 单段）。

## 4. API 契约

```
GET    /api/v1/flow-templates                     # builtin + user 合并（source 字段区分）
POST   /api/v1/flow-templates/from-flow/:flowId   # 抽取+清洗+入库 {name?,description?,icon?,category?}
POST   /api/v1/flow-templates/:id/instantiate     # id = 'builtin/<slug>' | uuid；
                                                  # persona 重绑（复用/自动启用）或降级 LLM 节点 → draft flow
DELETE /api/v1/flow-templates/:id                 # 仅 user 模板；builtin → 405
```

instantiate 返回 `{ flowId, members: [{persona, agentId?, degraded}] }`——
降级信息显式回传（toast 告知「2 个节点已降级为 LLM」，不静默）。

## 5. Console UI

- **/flows 页**：「新建 Flow」旁加「从模板创建」→ FlowTemplateGallery modal：
  - tab 内置模板（category 分组卡片，图标/名称/描述/节点数/所需人格提示）
  - tab 团队场景（数据源 = 既有 `/api/agent-library/team-templates`，instantiate
    分流到原端点——统一入口不合并实现）
  - tab 我的模板（卡片带删除按钮）
  - 确认步：成员清单（可解析→将绑定 Agent / 不可解析→将降级 LLM）+ 创建按钮
- **画布页顶栏**：「另存为模板」按钮 → SaveFlowTemplateDialog（名称/描述/图标/
  分类）→ POST from-flow → toast + 画廊「我的模板」立即可见
- i18n：自然键中文 + `en/flows.ts` 词条

## 6. 内置首发模板（均不依赖人格库即可跑）

| id | 场景 | 展示的引擎能力 |
|---|---|---|
| `builtin/dev-three-step` | 需求规划 → 实现 → 代码审查 | 线性链 + platformAgent（含 personaRef，可降级） |
| `builtin/research-fanout` | 三路并行调研 + LLM 汇总 | fan-out/汇合拓扑 |
| `builtin/content-pipeline` | 内容生成 → 审校 → 发布回复 | LLM 节点 + DirectReply |

每个内置模板同时是引擎能力的活文档；`builtin/README.md` 定义格式与 PR 规范。

## 7. 测试策略

- `flow-template-pipeline` 纯函数单测：抽取（platformAgent 重写/运行态剥离/
  溯源 name 解析/无 start 拒绝）、实例化（降级改写 llmAgentflow、personaRef
  命中时 agentId 绑定）
- 路由 DB 测试：from-flow 入库、instantiate 落 flow（降级与绑定两分支）、
  builtin 双寻址、DELETE 权限
- e2e spec-17：画廊三 tab 渲染 → 内置模板实例化（降级路径，环境无关）→
  画布；我的模板：抽取→列表→实例化→删除全链
- 真库 curl 演示 + 内置模板在无人格库 CI 环境的降级断言

## 8. Non-Goals（v1 明确不做）

- 模板变量/表单参数化（`{{input}}` 占位符）
- 模板版本管理与升级提示
- 模板导出/导入文件分享（依赖 D1 的 name 引用，后续做很容易）
- 团队场景与流程模板的格式互转

## 9. 分期

| 期 | 内容 | 状态 |
|----|------|------|
| Phase 1 | pipeline 纯函数 + builtin 三模板 + GET/instantiate + 单测 | ✅ 完成 |
| Phase 2 | from-flow 抽取 + DB + DELETE + console 画廊/另存对话框 + e2e spec-17 | ✅ 完成 |

## 10. 实现记录（2026-08-20）

**Gateway**（`__tests__/flow-templates.test.ts` 8 用例，全量 274 绿）

- `flow-template-pipeline.ts`：`extractTemplateFromFlow`（platformAgent → personaName 引用、运行态键剥离、无 start 拒绝）+ `instantiateFlowTemplate`（按名解析复用/自动启用；未命中降级 `llmAgentflow`，具名引用带「以 X 的专家身份」前缀）
- `flow-templates/builtin/`：3 个 JSON（dev-three-step / research-fanout / content-pipeline）+ index.ts（**JSON import 须带 `with { type: 'json' }`**——gateway tsconfig 是 NodeNext，TS 强制要求；tsx/vitest/tsup 均支持）+ README（PR 指南）
- `routes/flow-templates.ts`：GET（双源合并 + 成员可解析状态）/ from-flow（**personaName 仅记 library 溯源的 agent**，手工 agent → null 纯降级）/ instantiate / DELETE（builtin 405）。**`builtin/<slug>` 含斜杠**：`/:id/instantiate` 两段路由匹配不到，已注册专属 `/builtin/:slug/instantiate` 与 `/builtin/:slug`（console 代理同样分流）
- migration `1720000017000`（`1720000016000` 已被占用）

**Console**：`lib/flow-templates.ts` + 6 个代理路由（builtin/uuid 分流）+ `FlowTemplateGallery`（内置/团队场景/我的模板三 tab，确认步展示「将绑定 Agent / 将降级为 LLM」，创建 toast 显式告知降级数量）+ `SaveFlowTemplateDialog` + `CanvasTopBar`（画布页顶部操作条——vendor 画布零侵入）+ flows-view「从模板创建」+ i18n。

**E2E**：`17-flow-templates.spec.ts` 4 用例（目录 / 纯 LLM 模板 UI 全链到画布 / 用户模板 API 环路 / 删除保护）。人格绑定与降级分支由 gateway 单测覆盖（fixture 独有人格名确定性验证），e2e 只锁零依赖路径（本机真库与 CI 无库一致）。

**实测**：真库实例化 `builtin/dev-three-step` —— Software Architect 复用、Senior Developer / Code Reviewer 自动 slim 启用，3/3 绑定零降级；内置删除 405。

**实现偏差**：设计稿 §5 说「画布页顶栏」——落地为画布上方的细操作条（`CanvasTopBar`），避免侵入 vendor flowise 组件，语义等价。

**测试工程师回合（2026-08-20 第二轮，+8 用例）**：

- 巡检发现三个风险并处理：① 内置 JSON 的 `agentRefs[].task` 与节点 `inputs.systemPrompt` 是双拷贝——漂移会让降级/绑定节点行为分叉，新增**内置完整性元测试**钉死（边引用存在节点 / agentRef 节点一致 / task 双拷贝一致 / 无残留 agentId / 有 start），同时守护社区 PR；② `from-flow/:flowId` 非 uuid 会因 SQL `::uuid` 转换 502 —— 路由加 uuid 校验 → 400；③ 混合解析分支（部分人格命中部分降级）无覆盖 —— 新增用例（fixture 命中 + 幽灵名降级同帧验证）。
- 4xx 边界：未知 builtin slug / 垃圾 id instantiate → 404；无 start 的 flow 抽取 → 422。
- e2e spec-17 扩到 6 用例：画布另存 UI 全链（顶栏→对话框默认名→保存 toast→DB 反查→「我的模板」可见→内联删除）+ 画廊团队场景 tab（静态目录渲染，环境无关）。
- 惯性坑记录：`cat >>` 追加测试又一次把用例掉到 describe 闭合之后（afterAll 先跑导致 ctx undefined）——spec-16 与 spec-17 各踩一次，后续追加测试应直接编辑文件而非 shell 追加。

**开发工程师回合（2026-08-20，修复测试工程师报告的 3 项）**：

1. **main 遗留 TS2722 修复**（`workflow-clients.ts:167`，历轮报告均有标记）：根因是 `createLlmClient()` 的返回类型用了接口 `IExecutionContext['llmClient']`——其 `chatStream?` 为可选，而具体实现恒有 chatStream，转发调用被误判 possibly undefined。修法：新增具体返回类型 `HttpLlmClient`（chatStream 必选，可赋值给接口的可选成员）。**gateway typecheck 归零**。
2. **spec-02 冷启动 flake 根治**：dev server 首次编译 `/chats/[id]` 路由 10~20s，轮流击沉该 spec 首个触达用例（UC-CHAT-07 / UC-CHAT-usage 都中过）。beforeAll 加 `request.get` 预热（触发路由编译）+ usage 断言 10s→30s 双保险；**重启 console 制造真冷启动验证：4 过 0 败**。
3. **降级指令单一事实源**：内置 JSON 的 `agentRefs[].task` 与节点 `inputs.systemPrompt` 双拷贝即使漂移也不再造成绑定/降级行为分叉——降级路径改为优先读节点自身 systemPrompt（与绑定路径同源），`ref.task` 仅向后兼容兜底；新增漂移场景防回归用例（task 故意写错 → 降级仍用节点权威指令）。
