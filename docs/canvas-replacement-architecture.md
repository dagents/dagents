# 自研画布（Canvas Kit）替换 vendor/agentflow —— 架构设计

> 状态：**已实施**（2026-09-05 当日全量落地：D8 节点精简 + Canvas Kit + vendor/依赖/BFF 拆除；本页保留为决策记录，实施偏差见文末「实施记录」）
> 目标：删除 `vendor/agentflow`（Flowise `@flowiseai/agentflow` 的 fork），用系统自己的画布模块承接 `/workflows/[id]/canvas` 的全部能力；节点体系围绕 CLI Agent 精简为 9 类（D8）。

---

## 1. 现状盘点（为什么值得换）

### 1.1 vendor 是什么

`vendor/agentflow` = FlowiseAI 的 `@flowiseai/agentflow`（改名 `@dagents/agentflow`，workspace 挂载），~14k 行非测试源码。分层为 atoms（表单控件 3.9k）/ features（canvas 2.6k + node-editor 1.7k + node-palette 0.6k + generator 0.4k）/ core（类型+校验 2.5k）/ infrastructure（axios API 层 + reducer 1.5k）。技术栈：reactflow **v11** + MUI v5 + emotion + tiptap（7 个包）+ codemirror + axios + lodash。

### 1.2 实际消费面（探索结论）

整个 console 对它的运行时依赖只有**一处 import**：

- `apps/console/src/components/canvas/flowise-canvas.tsx`（1024 行）里渲染一个 `<Agentflow>`，外加 `@dagents/agentflow/flowise.css`。
- 9 个命令式方法只用 3 个：`getReactFlowInstance`（画边状态）、`setNodeExecutionStatus`（节点徽章）、`clearExecutionState`。
- `renderHeader` 契约只用 2 个字段：`isDirty`、`onSave`（整个工具栏本来就是 console 自己的代码）。
- 可见功能依赖：节点面板（AddNodesDrawer）、节点编辑对话框（EditNodeDialog）、执行徽章、minimap/controls、生成器 FAB。

### 1.3 为这套东西付出的代价

| 代价 | 明细 |
|---|---|
| 依赖树 | MUI + emotion + @mui/icons + tiptap×7 + tippy + lowlight + codemirror×5 + axios + lodash + flowise-react-json-view —— 全部只为喂这个组件；MUI 在 console 其余代码零使用 |
| 对抗式样式 | `canvas.css` 943 行，其中大量规则在打 MUI 类名（`MuiPaper`/`MuiFab-root`/`MuiDialog-paper`…）和 vendor CSS 变量；还有若干覆盖了 vendor 根本不存在的变量（no-op） |
| BFF 伪装层 | `/api/flowise/api/v1/` 下 7 组 Flowise 形状端点，其中 `node-config`、`node-load-method` 是**纯 stub**；`credentials`、`chatflows` 在 vendor 里存在但被绕过（404 也不影响）；`node-icon` 是现造的 SVG 字母块 |
| 双生成器 | vendor 画布内 GenerateFlowDialog 与 console 自有 `generate-flow-dialog.tsx` 并存，走同一个 BFF |
| 形状转换税 | `convertToFlowiseFormat()`（90 行）在加载时做 vendor 形状适配：合成 `outputAnchors`、补 `targetHandle=nodeId`、注入 `version:1` 压制"节点过期"徽章…… 保存时再原样带回这些字段污染存储 |
| 长期 | 上游是 Flowise 产品的一部分，其演化方向（credentials、组件市场、版本同步）与我们的需求正交；每次想改画布行为都要在 fork 里动 14k 行陌生代码 |

### 1.4 有利条件（为什么现在换便宜）

- **数据契约本来就是我们的**：`flows.flow_data` 存 ReactFlow 形状 `FlowData`，引擎按 `data.name` 派发（`packages/workflow/src/engine/executor.ts` runNode），画布形状只是"恰好兼容 ReactFlow"，不绑 Flowise。
- **节点 schema 单源已在我们手里**：`@dagents/workflow` 的 `CANVAS_NODES`（`nodes/node-registry-canvas.ts`，15 节点：label/category/color/icon/description/inputs/outputs/defaultData），BFF 现在只是把它转成 Flowise 形状喂 vendor。
- **拓扑校验单源也在**：`validateFlowTopology` 已经被画布保存路径直接调用。
- **运行态整条链路是 console 自己的代码**：轮询、徽章映射、边状态、结果面板全在 `flowise-canvas.tsx`，只是"挂"在 vendor 的 ref API 上。
- **表单引擎的真实需求极小**：盘点 `CANVAS_NODES.inputs`，参数类型只有 5 种 —— `string`(11) / `json`(9) / `code`(8) / `options`(6) / `number`(5)。vendor 的 17 种参数控件（ConditionBuilder、MessagesInput、StructuredOutputBuilder、credentials、tiptap 富文本……）在我们的注册表里**一个都用不到**——conditions/scenarios 在我们的 schema 里就是 `json`。

---

## 2. 目标与非目标

**目标**

1. 功能对等替换画布编辑器：编辑（拖拽/连线/多选/删除/复制/键盘）、节点面板、节点检查器、便签、执行状态可视化（徽章/边点亮/结果面板）、保存与拓扑校验、旁观模式。
2. 存量 flow 零迁移：所有现存 `flow_data`（vendor 形状 / 生成器扁平形状 / 内置与团队模板）直接打开、直接跑。
3. 依赖净删除：vendor + MUI/emotion + tiptap 系 + codemirror 系 + axios + reactflow v11，画布落到 `@xyflow/react`（React Flow v12，reactflow 的正统后继）一个运行时依赖上。
4. 删除 Flowise 形状 BFF 与 `convertToFlowiseFormat` 税。
5. 样式归位：画布样式并入 console 既有 token 体系，943 行对抗式 CSS 退役。
6. **节点体系精简（D8）**：围绕 CLI Agent 把节点从 15 类删减到 9 类——直接从引擎删除，不做兼容层。

**非目标（本期不做）**

- 不改保留 9 类节点的执行语义、不改 run/spans 契约、不改 flows 表结构（D8 对引擎是纯减法：删 6 个节点文件 + 清两条专属宿主注入，`LOOP_CONTROLLER_NAMES` 集合从两项缩到一项）。
- 不改保存交互语义（仍是手动保存 + Cmd/Ctrl+S + 脏标记；自动保存另立项）。
- 不做便签富文本、条件构建器等花哨编辑器（注册表形状就是 json，v1 用结构化 textarea；增强另立项）。
- 不做画布内嵌 AI 生成器（收敛到已有 console 原生 `generate-flow-dialog`，vendor FAB 直接退役）。
- 不做多画布同时编辑、协同编辑。

---

## 3. 总体架构

```
apps/console/src/components/flow-canvas/          ← 新模块（本期全部新建于此）
├── index.ts                    # 门面：导出 <FlowEditor> 与 SlimCanvasRef
├── kit/                        # 画布内核（React Flow 封装，不含业务）
│   ├── FlowCanvas.tsx          # <ReactFlow> 装配：nodeTypes/edgeTypes/事件/键盘/selection
│   ├── NodeView.tsx            # 通用节点卡：图标/标题/句柄/徽章/工具条（复制/编辑/删除）
│   ├── StickyNoteView.tsx      # 便签节点（textarea）
│   ├── EdgeView.tsx            # 贝塞尔边 + 分支标签（true/false、proceed/reject）
│   ├── handles.tsx             # 左入右出句柄；出句柄 id = 注册表 outputs 名
│   ├── connection-rules.ts     # 连线合法化：自环/重复边/目标多入边策略
│   └── useCanvasInteractions.ts # dnd 落点、删除键、复制、多选框选
├── registry/                   # 节点规格适配层（关键解耦点）
│   ├── node-spec.ts            # CANVAS_NODES → NodeSpec（渲染元数据 + 参数 schema）
│   ├── option-providers.ts     # options 动态填充：agents 列表、chatmodels（调 gateway）
│   └── icons.tsx               # 本地图标映射（替代 /node-icon BFF）
├── palette/                    # 节点面板：分类 + 搜索 + 拖拽/点击添加
├── inspector/                  # 节点检查器（右侧属性面板）
│   ├── InspectorPanel.tsx
│   ├── widgets/                # string / number / options / code / json 五种控件
│   ├── variable-picker.tsx     # {{变量}} 插入器（上游节点输出 + {{$start.input}} + 状态键）
│   └── form-engine.ts          # schema→控件 派发 + 默认值/必填校验
├── model/                      # 数据规范化（纯函数，golden tests 主战场）
│   ├── normalize-in.ts         # 存储形状 → 画布形状（读）
│   ├── normalize-out.ts        # 画布形状 → 存储形状（写：扁平化 + 清理 legacy）
│   └── flow-document.ts        # 画布文档类型 + dirty 语义
├── run/                        # 执行可视化（承接现 flowise-canvas 的 console 自有逻辑）
│   ├── use-run-watch.ts        # x-run-id + ?async=1 + node-spans 轮询（700/900ms、终态判定、旁观启发式）
│   ├── node-badges.ts          # span 状态 → 节点徽章
│   └── edge-states.ts          # 完成边静态绿、活动边 animated
└── flow-editor.tsx             # 组合根：state（nodes/edges/dirty）+ header 插槽 + ref API
```

依赖方向（严格单向，沿用 vendor ARCHITECTURE 里值得保留的纪律）：

```
flow-editor → kit / palette / inspector / run → registry → @dagents/workflow(CANVAS_NODES, validateFlowTopology, FlowData 类型)
                                   └──────────→ model（纯函数，无 React）
kit 不 import inspector/palette（工具条"编辑"通过回调上抛）
```

**为什么放 console 内而不是新建 workspace 包**：唯一宿主是 console；in-console 免掉 tsup 构建链和「改画布要等 dist 重建」的 dev 摩擦（近期像素级调优全是 console 内直改，这个迭代速度要保住）。`index.ts` 门面 + 禁止外部深 import 的纪律保证日后若出现第二宿主（如 daemon 面板），整体搬进 `packages/canvas-kit` 是机械动作。

**React Flow 版本裁决**：新画布用 `@xyflow/react`（v12）。vendor 锁在 reactflow v11（已更名停更）。console 里另一处 `dag-node.tsx` 只用了 `Handle/Position` 两个导出，同一阶段顺手迁到 v12，切换完成后删掉 reactflow v11 依赖。过渡期两个版本并存约一个迭代（bundle 代价 ~100KB，可接受）。

---

## 4. 关键设计决策

### D1. 数据契约：读宽容、写归一

引擎已同时接受两种持久化形状（`executor.ts` L200–207：flat `data.<field>` 先、nested `data.inputs.<field>` 后者覆盖）。新画布的读写策略：

- **读**（`normalize-in`）：`fieldValue = data.inputs?.[k] ?? data[k]`（与引擎合并序一致）；`data.name` 是派发键，`node.type` 仅作显示提示（`agentflowNode`/`customNode`/未知一律按 `data.name` 解析，解析失败标"未知节点"占位卡）；便签/迭代节点按 `type` 特判。
- **句柄**：**入句柄每节点恒一个**，读取时无视存量 `targetHandle` 的值（vendor 时代的 `targetHandle=nodeId` 约定直接忽略，归一到我们的唯一入句柄）；**出句柄 id = 注册表 `outputs[].name`**（`output`、`true`/`false`、`iteration`/`result`、`loop`/`result`、场景名），读取时缺 `sourceHandle` 补首个锚点。`sourceHandle` 是分支路由的执行语义，**原样透传，永不改写**。
- **`outputAnchors` 不再持久化**：vendor 时代加载时合成、保存时带回的 `outputAnchors`/`version`/`hideInput` 等字段，渲染期从注册表派生（`useMemo`），normalize-out 时剥除。
- **写**（`normalize-out`，保存时才发生）：统一写**扁平规范形** `{ id, type: 'customNode', position, data: { name, label, ...fields } }`（与生成器/内置模板/团队模板同形），编辑值物化进顶层、删除 legacy `data.inputs` 键；保留 `data.label`、`data.inputHint`、`data.inputExample`（模板链路在用的 UI 提示，引擎忽略但 flows 列表运行面板和画布运行面板要读）。存量 flow 在下一次保存时自然完成数据收敛，不做批量迁移脚本。
- **golden tests**：从真实库取样本（vendor 编辑保存的、生成器产的、builtin JSON、团队模板产的）钉住 normalize-in/out 的往返不变性。

### D2. 迭代节点降级为普通控制节点

vendor 的 IterationNode 是"父容器 + 子节点 `parentNode/extent` 吞进去"的视觉魔法，但**引擎根本不看包含关系**——迭代体由 `sourceHandle==='iteration'` 的边闭包定义（`executor.planLoopBody`）。新画布把 `iterationAgentflow` 渲染为普通双锚点控制节点（`iteration` / `result` 出口），与 Loop 一致。收益：删除子节点级联删除、extent 父子约束、落点判定三整套复杂度，且视觉与执行语义诚实对应（边怎么连，迭代体就是谁）。存量"容器式"画布打开后子节点平铺显示，执行不受影响（本来就看边）。

### D3. 表单引擎按真实需求裁剪到 5 种控件

`INodeParams.type` 全集盘点结果即 5 种。控件映射：

| schema type | 控件 | 备注 |
|---|---|---|
| `string` | 单行输入；`acceptVariable` 时带变量插入按钮 | `agentId` 走 options-provider 升级为下拉（见下） |
| `number` | 数字输入 | |
| `options` | 下拉：静态 `options` + **option-providers 动态源** | `model`/`tools` 在注册表里 `options: []`，由 `option-providers.ts` 在 console 侧注入（chatmodels = providers `providerId::model` + agents `agent::<id>` + fallback `gateway-default`；agentId = `/api/v1/agents` 实时列表）——**注入发生在适配层，`@dagents/workflow` 保持纯净**，替代今天的 BFF nodes 路由动态拼装 |
| `code` | 多行 mono textarea（`rows` 生效）| v1 不引 codemirror |
| `json` | textarea + 失焦 JSON.parse 校验 + 错误行内提示 | conditions/scenarios v1 即此；结构化构建器（条件行编辑器）作为后续增强立项 |

校验复用注册表 `required`/`default`，`applyVisibleFieldDefaults` 语义（新建节点用 `defaultData` 预填）在 `form-engine` 内实现。**检查器从 MUI Dialog 改为右侧固定面板**（双击节点或工具条"编辑"打开）：长流程里改参数来回开关对话框的体验本来就差，换面板是一次顺手的 UX 升级，也避开自建 Dialog 组件。

### D4. ref API 与运行态注入

`FlowEditor` 暴露极简命令面（替代 vendor 9 个方法里我们用到的 3 个 + 备用）：

```ts
interface CanvasRef {
  setNodeStatus(nodeId: string, status: SpanStatus, error?: string): void
  clearRunState(): void
  getDocument(): FlowData            // normalize-out 后的规范形，保存用
  isDirty(): boolean
  fitView(): void
}
```

运行态数据流：`use-run-watch`（原 watchLoop 逻辑平移）轮询 node-spans → 映射后调 `setNodeStatus` / 更新边状态。**边状态不再借 `getReactFlowInstance().setEdges()` 绕过 React 状态**（vendor 时代的 hack），而是 run 模块向 kit 提供 `edgeStates: Map<edgeId, 'done'|'active'>` 派生数据，`EdgeView` 按props 渲染——单向数据流，无副作用边路。

### D5. 生成器收敛 + BFF 退役

- 画布内生成能力 = 工具栏"AI 生成"按钮打开**既有** `generate-flow-dialog`（它已消费 bindings 元数据、直达画布）。vendor FAB+对话框删除。
- `/api/flowise/api/v1/*` 七组路由整体删除：nodes/node-icon（本地注册表+图标替代）、node-config/node-load-method（本来就是 stub）、agentflowv2-generator（dialog 改直连 gateway `/api/v1/flow-generator/generate`，console 与 gateway 同源部署，无 CORS 问题；200s 超时语义在 dialog 里保持）、assistants/chatmodels（并入 option-providers 的专用轻端点 `/api/canvas-options`，或由 option-providers 直接聚合两个 gateway 端点）。

### D6. 样式

新建 `flow-canvas.css`（预计 ~400 行）接入 console 既有 CSS 变量体系（与 shell/settings 同源 token），节点卡/边/徽章/面板风格延续现画布调优后的视觉（墨色工具条、状态点语言、tabular 数字）。`canvas.css` 中 console 自有类（`.canvas-run-btn`、`.canvas-results-*` 等 ~500 行）**原样保留**——header 工具栏、运行输入面板、结果面板的 DOM 和类名不动，e2e 选择器（WF-12/UI-02/IA-01）零改动。删除的是打 MUI/vendor 类的那 ~440 行。

### D7. 切换与回滚

沿用本仓 flag 文化：`localStorage dagents.canvas.engine = 'vendor'` 强制旧画布（默认新画布），存续期 ≤1 迭代。画布页按 flag 二选一挂载 `<FlowEditor>` 或旧 `FlowiseCanvasLoader`，两者 props 契约（flowId/flowName/initialFlow/watchRunId/firstRunHint/onSave）完全一致。回滚 = 用户自救通道 + e2e IA-04 同款钉法。

### D8. 节点体系精简：15 → 9，围绕 CLI Agent（直接删除，无兼容层）

「CLI 第一性」落到画布上：**platformAgent（真 CLI Agent）是主角，其余节点是最小编排脚手架**。裁决基于三方证据——dev 库 `flows` 表全量节点使用统计、模板中心（builtin + 团队）实际用到的节点、引擎实现质量。

**使用数据（dev 库 `flows` 表，2026-09-05）**：

| 节点 | 存量使用 | 模板使用 | 裁决 | 依据 |
|---|---|---|---|---|
| `platformAgentAgentflow` | **122** | 3 | ✅ 保留（主角） | 唯一真 Agent：绑定 agents 表人格，CLI 执行、工具循环、技能注入全走真链路 |
| `startAgentflow` | 49 | 10 | ✅ 保留 | 流程入口，拓扑约束要求恰一个 |
| `directReplyAgentflow` | 43 | 10 | ✅ 保留 | 终点回复，全部模板在用 |
| `llmAgentflow` | 29 | 24 | ✅ 保留 | 无身份的裸模型调用（汇总/改写/兜底），HTTP provider 或 CLI 皆可 |
| `customFunctionAgentflow` | 3 | 0 | ✅ 保留 | 确定性变换的逃生舱（`new Function` 限制照旧文档化） |
| `httpAgentflow` | 2 | 0 | ✅ 保留 | 确定性 API 步骤，SSRF 加固过的实现，不烧 Agent 轮次 |
| `conditionAgentflow` | 2 | 0 | ✅ 保留 | 规则分支，廉价确定性好调试 |
| `iterationAgentflow` | 1 | 0 | ✅ 保留 | **唯一保留的循环原语**：数组驱动是 Agent 流主流形态，引擎支持完整（逐项状态/上限/聚合） |
| `humanInputAgentflow` | 1 | 0 | ✅ 保留 | HITL 是产品核心特性（悬浮副驾应答条、WAITING_FOR_INPUT 全链路已铺） |
| `loopAgentflow` | 1 | 0 | ❌ 退役 | 与 iteration 重叠的第二循环原语（次数/条件式）；JS 条件求值器只为它服务，收敛到一个循环原语 |
| `executeFlowAgentflow` | 1 | 0 | ❌ 退役 | flow 套 flow 的组合小众，还依赖宿主 `flowExecutor` 注入；团队模板的并行头已用扁平 fan-out 边取代子流程 |
| `retrieverAgentflow` | 1 | 0 | ❌ 退役 | 仅关键词检索（引擎文档自认的限制）+ 依赖宿主 `historyRetriever` 注入；检索交给 CLI Agent 自带技能更符合 CLI-first |
| `agentAgentflow` | **0** | 0 | ❌ 退役 | **空壳 Agent**：`run()` 就是一次裸 `llmClient.chat`，schema 声明的 `tools`/`maxIterations` 从未被消费——它只是换皮 llm 节点还误导用户 |
| `toolAgentflow` | **0** | 0 | ❌ 退役 | 手写 JS 工具喂 HTTP LLM 工具循环（双重小众）；platformAgent 的真工具来自 CLI Agent 自身；引擎 `toolRegistry` 管道与 platformAgent 工具循环代码**原样保留**，只是不再有注册入口 |
| `conditionAgentAgentflow` | **0** | 0 | ❌ 退役 | LLM 选路器；可用「llm 节点输出 + condition 节点」组合表达，需要时以更 CLI-first 的形态（让 Agent 直接选路）回归 |

（模板中心统计同源核对：builtin + 团队模板只出现 4 种节点——llm 24、start 10、directReply 10、platformAgent 3。）

**保留集（9 类）的画布叙事**：入口（start）→ **Agent（platformAgent，主角）** → 模型（llm）→ 控制（condition / iteration / humanInput）→ 实用件（http / customFunction）→ 输出（directReply）。platformAgent 的展示 label 建议改为「Agent (CLI)」（`data.name` 不动，引用不失效）。

**删除策略（v3：不做兼容层）**

产品无真实用户、本地 flow 均为测试数据——6 类节点**直接删除**，不保留 handler、不做 `retired` 标记、不写迁移。波及面已全量盘点（除节点文件自身外全库引用就这几处）：

| 位置 | 改动 |
|---|---|
| `packages/workflow/src/nodes/` | 删 6 个节点目录（`agent/`、`tool/`、`condition-agent/`、`loop/`、`execute-flow/`、`retriever/`）及其测试；`nodes/index.ts` 注册表同步 |
| `node-registry-canvas.ts` | 删 6 条 `CanvasNodeMeta` |
| `engine/executor.ts:69` | `LOOP_CONTROLLER_NAMES` 缩为 `['iterationAgentflow']`（循环体规划逻辑本体保留，iteration 依赖它） |
| `IExecutionContext`（`types/execution.ts`） | 删 `flowExecutor` / `historyRetriever` 可选字段 |
| `apps/gateway/src/routes/workflows.ts:440,453` + `workflow-clients.ts` | 删两条专属宿主注入布线（`createHistoryRetriever` / `createFlowExecutor`，仅服务被删节点）；platformAgent 工具循环与 `toolRegistry` 传递管道**保留**（它是 platformAgent 自身机制，与 tool 节点无关） |
| `flow-generator.ts` TYPE_ALIASES | 删 6 条别名；`agent → llmAgentflow`（生成兜底零依赖可跑；chat `@workflow` 路径本就注入真实 agent 清单引导生成 platformAgent）；顺手 `loop → iterationAgentflow`（LLM 爱发这个词，映射到保留的循环原语比丢弃好） |
| 测试 | `executor.test.ts` loop 控制器用例改写为 iteration 等价物或删除（循环体规划/终态 span 语义由既有 iteration 用例继续钉）、executeFlow 用例删；`agent-refs.test.ts` fixture `agentAgentflow→platformAgentAgentflow`；gateway `workflow-clients.test.ts` 子流程用例删、`flow-generator.test.ts` 别名断言更新 |
| e2e `flow-builder.ts` | 类型映射表删 6 条 |
| 生成器菜单 | 节点清单 = 保留集 9 类（选择空间收窄，生成质量与修复循环直接受益） |

`validateFlowTopology` 无需改动——`KNOWN_NODE_TYPES` 派生自 `allNodes()`，被删类型自动成为 unknown node type 错误，正好挡住手写 JSON 误用。

**残留测试数据的处理（可选，不阻塞）**：存量 flows 表中含被删节点的 flow 共 3 个（loop/executeFlow/retriever 各 1），打开会渲染「未知节点」占位卡、保存时拓扑校验报错、直接运行会在派发时报错——测试数据可接受。想清干净的话一行 SQL：

```sql
DELETE FROM flows WHERE flow_data::text ~ '"(loopAgentflow|executeFlowAgentflow|retrieverAgentflow|agentAgentflow|toolAgentflow|conditionAgentAgentflow)"';
```

---

## 5. 实施计划（四阶段，每阶段可独立合入）

### P0 地基（~1 天）
- `model/` normalize-in/out + flow-document 类型 + golden tests（含真实存量形状样本）。
- `registry/` NodeSpec 适配 + icons + option-providers（先带测试）。
- D8 落地（纯减法）：删 6 个节点文件 + 注册表条目 + 两条宿主注入 + 别名清理 + 受波及测试改写（明细见 D8 波及面表），引擎与 gateway 测试全绿收口。
- flag 读取与画布页挂载点改造（flag=vendor 时行为与今日完全一致）。

### P1 画布内核 + 检查器（~3-4 天，核心阶段）
- kit：FlowCanvas / NodeView / StickyNoteView / EdgeView / 句柄 / 连线规则 / 键盘与多选 / dnd。
- palette：按 D8 保留集 9 类渲染（分类 + 搜索）；未知节点类型按 D1 渲染占位卡（存量测试数据里的已删节点）。
- inspector（5 控件 + 变量插入器 + form-engine）。
- flow-editor 组合根 + header 插槽（现 renderHeader 的 JSX 平移进 `<FlowEditor header={...}>`）+ 保存链路（validateFlowTopology 干跑 toast 逻辑平移）。
- `dag-node.tsx` 迁 `@xyflow/react`。
- dogfood：flag 切新画布，编辑真实 flow 验证。
- 单测：连接规则、form-engine、normalize 往返；`convertToFlowiseFormat` 测试由 normalize 测试接管。

### P2 运行态对等（~1-2 天）
- run/ 三件套平移（轮询/徽章/边状态），结果面板与运行输入面板 DOM 复用。
- 对照清单验收：发起运行、旁观 ?run=、早期失败提示、活动流时间线、tokens 徽章、终态 toast、HITL 挂起（WAITING_FOR_INPUT）。
- e2e：新增 canvas-kit 冒烟 spec（编辑→保存→运行→旁观全链路）；既有 WF/UI spec 在新画布下全绿。

### P3 拆除（~1 天）
- 默认引擎切新画布；vendor flag 保留一个迭代。
- 删 `vendor/agentflow`、console 的 MUI/emotion/tiptap/codemirror/axios-lodash 传递依赖、reactflow v11、`/api/flowise/*` 全部路由、`convertToFlowiseFormat`、canvas.css 的 vendor/MUI 段。
- `pnpm-workspace.yaml` 去掉 `vendor/*`；AGENTS.md 更新架构条目。

### 规模预估

新模块预计 **~3.5k 行**（kit ~1.1k / inspector ~1.2k / palette ~0.3k / model ~0.4k / run ~0.5k 含平移），替换 vendor ~14k 行 + BFF ~0.4k + 对抗 CSS ~0.44k。净删约 11k+ 行与一整棵依赖树。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 检查器功能缺口导致旧 flow 打开后某些字段没法改 | 控件需求由注册表封闭枚举（5 种），P0 golden tests 把存量节点字段全覆盖进往返测试；缺口=注册表新增 type 时编译期可见（form-engine 的 switch 走 exhaustive check） |
| React Flow v12 与 v11 行为差异（dnd 坐标、handle 匹配） | v12 `screenToFlowPosition` 替代 `project()`；handle 匹配靠 normalize-in 的句柄归一兜底；dogfood 期并排对照 |
| 存量数据形状边角（生成器 alias 名、手写 flow、旧 targetHandle 约定） | normalize-in 的宽容策略 + golden 样本取自四类真实来源；未知 `data.name` 渲染占位卡不崩、保存原样保留未知字段（normalize-out 只删已知 legacy 键，其他 data 键透传） |
| 运行态回归（旁观/早失败/活动流细节多） | run/ 是平移不是重写；P2 有显式验收清单 + 既有 e2e（WF-12/13 钉过全链路） |
| 删节点引发测试链失败 | 波及面已全量盘点（D8 表逐处列出）；loop 用例改写为 iteration 等价物、子流程用例删除；改动后 `pnpm test` 全量验证 |
| 双引擎过渡期维护成本 | 过渡期只修新引擎的 bug（旧引擎仅保命，flag 文档写明）；周期上限一个迭代 |

## 7. 开放问题（评审时定）

1. 检查器右侧面板 vs 保留浮动 Dialog——设计倾向面板，若设计侧有异议 P1 可降级为 Dialog（form-engine/控件全部复用）。
2. option-providers 聚合端点形态：console 内并发两个 gateway 请求 vs 网关加一个聚合端点（倾向前者，网关零改动）。
3. undo/redo 与多选复制粘贴：v1 不做（vendor 也没有），状态所有权已收拢在 flow-editor，后续加 history 栈是纯增量——是否排进下一迭代。

---

## 实施记录（2026-09-05 当日落地）

**全部四阶段一次完成**，最终形态与设计的偏差与补充：

1. **D8 直接删除**：6 个节点目录 + 注册表条目 + `flowExecutor`/`historyRetriever` 宿主注入（gateway 三处布线）+ `IExecutionContext` 字段 + `componentNodes` 死字段全部移除；executor 的 `LoopPlan` → `IterationPlan`（kind 判别与 break 条件求值随之删除）；别名表 `agent→llmAgentflow`、`loop→iterationAgentflow`、`conditionagent→conditionAgentflow`。测试改写：MA-04 场景路由改用 CustomFunction 决策器（场景句柄路由机制继续被钉住）、MA-05/MA-18 工具循环改用网关内置 `datetime_now` 工具（platformAgent 工具循环机制继续被钉住）；删除 MA-07（loop break）、MA-08（子流程）、MA-12（工具注册隔离）、WF-05/WF-06/OB-04、ED-04。
2. **Canvas Kit**（`apps/console/src/components/flow-canvas/`，约 2.6k 行含测试）：model（normalize 双向 + 11 条 golden 测试）/ registry（NodeSpec + 内联 SVG 图标 + option-providers 客户端聚合 `/api/llm-providers`+`/api/agents`）/ kit（NodeView/StickyNoteView/EdgeView/连线规则 + 环检测修复——实现时发现并修正了邻接表方向建反的真 bug）/ palette（D8 九类分组搜索）/ inspector（5 控件 + 变量追加插入）/ flow-editor 组合根（`FlowEditorHandle` 命令式 API，边状态从 nodeStates 单向派生）。
3. **页面客户端**：`canvas-kit-page.tsx` 逐行移植旧 flowise-canvas 的 console 自有逻辑（工具栏/运行面板/结果面板/旁观/保存管线），`.canvas-*` 类名与 e2e 选择器保持不变；顶栏容器类从 vendor 的 `.agentflow-header*` 改名 `.canvas-header*`。
4. **拆除**：`vendor/agentflow` 目录 + pnpm workspace `vendor/*` + console 依赖（@dagents/agentflow、MUI×2、emotion×2、reactflow v11）全部删除；`/api/flowise/*` 七组 BFF 退役，唯一存活能力迁往新家——生成器走 `/api/flow-generator`（纯透传 canonical，无 vendor 形状转换），模型下拉由 option-providers 直连两个既有 BFF；`canvas.css` 943→~520 行（vendor 变量覆盖与 MUI 对抗段删除，console 自有类全保留）；flag（`dagents.canvas.engine`）随 vendor 一并退役，页面直挂 CanvasKitLoader。
5. **实施中新发现的两个坑（已修并留下防御）**：① Turbopack 不解析 `.js`→`.tsx` 的 TS 式后缀映射（vite 支持）——kit 内部 import 一律无后缀；② React Flow v12 的 NodeRenderer ResizeObserver→`updateNodeInternals` 回路在 IAB webview 实测不触发（节点永久 `visibility:hidden`、边层空）——FlowEditor 加了测量加固（存在未测量节点时主动驱动 store 测量，幂等），详见 flow-editor.tsx 注释。另：自定义边必须 `defaultEdgeOptions={{ type: 'flowEdge' }}`（normalize 不给边写 display 层 type）。
6. **验收**：workflow 174 / gateway 330 / console 323 单测全绿；真实浏览器全链路验证（存量 flow 渲染、vendor 形状读入、检查器编辑→脏标记→保存为扁平规范形（vendor 杂项收敛消失）、发起运行→徽章/边点亮/结果面板正文直出、`?run=` 旁观、面板九类、vendor DOM 零残留）。

---

## Review 修复记录（2026-09-06 全面回归）

全量 review + 测试（三包单测 / 全套 Playwright e2e / 真实浏览器）发现并修复：

**Canvas Kit 侧**
1. 边 id 冲突：condition 的 true/false 句柄各连一条边到同一目标时 id 撞车（React key + 运行态点亮映射错乱）——手连边 id 改含 sourceHandle。
2. 边分支标签恒不显示：EdgeView 把节点 id 当注册名喂 getSpec——改经 RF useStore 从 nodeLookup 反查源节点类型名。
3. 单击选中即弹检查器（拖动节点反复弹面板）：改双击/工具条✎打开，符合 D3 设计。
4. fitView 逻辑写反（`undefined` = RF 默认 false，从不 fit）：改「有持久化视口还原、无则 fitView」，互斥时不传 defaultViewport。
5. 便签拖不动（textarea 阻断冒泡）：加顶部拖拽条；palette 补「画布」分组的便签条目（此前只能显示存量、无法新建）。
6. NumberWidget 清空存 `''` → undefined（类型不漂移）；onSelectionChange memoize（RF 文档要求）。

**引擎侧（存量 bug，画布运行面板文案宣传的语法实际失效）**
7. `{{$start.input}}` 别名落空：resolveAlias 映射 `state.start.content`，但 executor 把 Start 输出只挂在节点 id 键下——Start 输出额外登记 `state.start`，executor 回归测试双向钉住（go→true / stop→false）。

**仓内既有债（全套 e2e 暴露，与画布无关但一并修复）**
8. flows-empty-hero 的 `<button role="listitem">` 覆盖按钮语义（PX-F03 引入的 a11y 回归）——读屏与 e2e 都找不到按钮；去掉覆盖性 role。
9. spec 腐化三处对齐现行 UI：UC-FLW-01 的「我的」tab（产品裁决已删）、spec-16 人格卡（PX-A03 起整卡可点，确认步按钮在 .modal-foot）、创业 MVP 模板成员 5→7（2026-08-31 扩容）。

**测试结果**：workflow 175 / gateway 330 / console 323 单测全绿；全套 Playwright e2e 两轮：修复后 205 用例中 203 过，余 2 例为负载相关的既有 flaky（UC-NAV-06 复跑即过；UC-FLW-02 的画布冷编译跳转超时已由 15s 放宽到 30s）；真实浏览器复验便签新建/编辑/持久化、分支边标签（True/False）、双击检查器、保存后规范形重跑且分支路由正确（go→True / stop→False）。
